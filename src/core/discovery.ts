/**
 * Sessions found without our hooks:
 *
 *   herdr          the terminal workspace for agents (https://herdr.dev) knows the state of ~24 agent
 *                  kinds (Claude Code, Codex, Gemini, Antigravity, Cursor, Copilot, OpenCode, Droid,
 *                  Amp, Grok, Kiro, Qwen, Cline, Pi…). We read `herdr agent list`, focus panes with
 *                  `herdr agent focus` and answer prompts with `herdr agent send-keys enter|esc`.
 *   claude agents  `claude agents --json` lists every running Claude Code session on this computer,
 *                  interactive and background (`claude --bg`): status only, but no setup at all.
 *
 * Sessions our hooks already report win: duplicates are matched by session id or herdr pane.
 */
import { execFile } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Activity, AGENTS, type AgentId, HERDR_KINDS } from "./agents";
import type { Session, SessionStore } from "./store";
import { clip, projectName } from "./util";

const IS_WIN = process.platform === "win32";

type Run = { ok: boolean; out: string; err: string };

function run(bin: string, args: string[], timeout = 6000): Promise<Run> {
	return new Promise((resolve) => {
		execFile(bin, args, { timeout, windowsHide: true, maxBuffer: 8 << 20 }, (error, stdout, stderr) => {
			resolve({ ok: !error, out: String(stdout ?? ""), err: String(stderr ?? error?.message ?? "") });
		});
	});
}

/** First existing path among `candidates`, then the PATH lookup. GUI apps often lack the shell PATH. */
async function locate(name: string, candidates: string[]): Promise<string | null> {
	for (const c of candidates) if (c && existsSync(c)) return c;
	const res = await run(IS_WIN ? "where" : "/bin/sh", IS_WIN ? [name] : ["-lc", `command -v ${name}`], 4000);
	const found = res.out.split(/\r?\n/).map((s) => s.trim()).find((s) => s && (!IS_WIN || /\.exe$/i.test(s)));
	return found ?? null;
}

function newestRelease(dir: string, exe: string): string {
	try {
		const releases = readdirSync(dir)
			.map((d) => join(dir, d, exe))
			.filter((p) => existsSync(p))
			.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
		return releases[0] ?? "";
	} catch {
		return "";
	}
}

// ------------------------------------------------------------------------------------------------ herdr

type HerdrAgent = {
	pane_id: string;
	agent?: string | null;
	display_agent?: string | null;
	agent_status: "idle" | "working" | "blocked" | "done" | "unknown";
	cwd?: string | null;
	foreground_cwd?: string | null;
	name?: string | null;
	title?: string | null;
	terminal_title_stripped?: string | null;
	agent_session?: { kind: "id" | "path"; value: string } | null;
};

const HERDR_STATE: Record<HerdrAgent["agent_status"], Activity> = {
	working: "thinking",
	blocked: "approval",
	done: "done",
	idle: "idle",
	unknown: "idle",
};

export class HerdrBridge {
	bin: string | null = null;
	available = false;
	agents = 0;
	private timer: NodeJS.Timeout | null = null;
	private known = new Set<string>();
	private busy = false;

	constructor(
		private readonly store: SessionStore,
		private readonly enabled: () => boolean,
		private readonly log: (msg: string) => void = () => {},
	) {}

	/** herdr exports HERDR_BIN_PATH to the hooks of agents it runs: the most reliable location. */
	useBinary(path: string): void {
		if (path && path !== this.bin && existsSync(path)) this.bin = path;
	}

	start(): void {
		this.schedule(1000);
	}

	stop(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
	}

	private schedule(ms: number): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => void this.poll(), ms);
		this.timer.unref?.();
	}

	private async resolveBin(): Promise<string | null> {
		if (this.bin) return this.bin;
		const home = homedir();
		const exe = IS_WIN ? "herdr.exe" : "herdr";
		this.bin = await locate("herdr", [
			process.env.HERDR_BIN_PATH ?? "",
			newestRelease(join(home, ".herdr", "packages", "standalone", "releases"), exe),
			join(home, ".herdr", "bin", exe),
			join(home, ".local", "bin", exe),
			IS_WIN ? "" : "/opt/homebrew/bin/herdr",
			IS_WIN ? "" : "/usr/local/bin/herdr",
		]);
		return this.bin;
	}

	async poll(): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		try {
			if (!this.enabled() || !(await this.resolveBin())) {
				this.clear();
				this.schedule(30_000);
				return;
			}
			const res = await run(this.bin as string, ["agent", "list"], 5000);
			let agents: HerdrAgent[] = [];
			try {
				agents = (JSON.parse(res.out) as { result?: { agents?: HerdrAgent[] } }).result?.agents ?? [];
			} catch {
				// herdr not running: no server to answer
				this.available = false;
				this.clear();
				this.schedule(15_000);
				return;
			}
			this.available = true;
			this.agents = agents.length;
			this.apply(agents);
			this.schedule(agents.length > 0 ? 1500 : 5000);
		} finally {
			this.busy = false;
		}
	}

	private apply(list: HerdrAgent[]): void {
		const hookSessions = [...this.store.sessions.values()].filter((s) => s.source === "hook");
		const seen = new Set<string>();
		for (const a of list) {
			if (!a.pane_id || !a.agent_status) continue;
			const sessionRef = a.agent_session?.kind === "id" ? a.agent_session.value : "";
			// the same session already reports through our hooks: keep that one, remember its pane
			const twin = hookSessions.find((s) => s.herdrPane === a.pane_id || (sessionRef && s.sessionId === sessionRef));
			if (twin) {
				if (!twin.herdrPane) twin.herdrPane = a.pane_id;
				continue;
			}
			const kind = (a.agent ?? "").toLowerCase();
			const agent: AgentId = HERDR_KINDS[kind] ?? "custom";
			const id = `herdr-${a.pane_id}`;
			seen.add(id);
			this.known.add(id);
			const cwd = a.foreground_cwd || a.cwd || "";
			const uid = `${agent}:${id}`;
			const prev = this.store.get(uid);
			let activity: Activity | undefined = HERDR_STATE[a.agent_status] ?? "idle";
			// herdr may go working → idle: show the finish like the hooks do
			if (activity === "idle" && prev && (prev.activity === "thinking" || prev.activity === "approval")) activity = "done";
			// a finish we already showed (and maybe settled to idle) stays as it is
			if ((activity === "done" || activity === "idle") && (prev?.activity === "done" || (prev?.activity === "idle" && a.agent_status === "done"))) activity = undefined;
			this.store.upsert(agent, id, {
				activity,
				title: clip(a.name || a.title || a.terminal_title_stripped || "", 100),
				cwd,
				project: projectName(cwd),
				source: "herdr",
				herdrPane: a.pane_id,
				agentName: agent === "custom" ? a.display_agent || kind || "agent" : AGENTS[agent].name,
				detail: a.agent_status === "blocked" ? "waiting in herdr" : undefined,
			});
		}
		for (const id of [...this.known]) {
			if (seen.has(id)) continue;
			this.known.delete(id);
			for (const s of [...this.store.sessions.values()]) if (s.sessionId === id) this.store.remove(s.uid);
		}
	}

	private clear(): void {
		this.agents = 0;
		for (const id of [...this.known]) for (const s of [...this.store.sessions.values()]) if (s.sessionId === id) this.store.remove(s.uid);
		this.known.clear();
	}

	async focus(pane: string): Promise<boolean> {
		if (!(await this.resolveBin())) return false;
		const res = await run(this.bin as string, ["agent", "focus", pane], 5000);
		if (!res.ok) this.log(`herdr focus ${pane}: ${clip(res.err, 160)}`);
		return res.ok;
	}

	/** Answers a prompt in the pane: Enter accepts the highlighted choice, Esc cancels. */
	async answer(pane: string, allow: boolean): Promise<boolean> {
		if (!(await this.resolveBin())) return false;
		const res = await run(this.bin as string, ["agent", "send-keys", pane, allow ? "enter" : "esc"], 5000);
		if (!res.ok) this.log(`herdr send-keys ${pane}: ${clip(res.err, 160)}`);
		return res.ok;
	}
}

// ------------------------------------------------------------------------------------------------ claude agents

type ClaudeAgent = { pid?: number; cwd?: string; kind?: string; sessionId?: string; name?: string; status?: string };

function claudeState(status: string): Activity {
	const s = status.toLowerCase();
	if (/wait|input|permission|block|approv/.test(s)) return "approval";
	if (/busy|work|run|think/.test(s)) return "thinking";
	if (/error|fail/.test(s)) return "error";
	return "idle";
}

export class ClaudeLister {
	bin: string | null = null;
	available = false;
	private timer: NodeJS.Timeout | null = null;
	private known = new Set<string>();

	constructor(
		private readonly store: SessionStore,
		private readonly enabled: () => boolean,
	) {}

	start(): void {
		this.schedule(3000);
	}

	stop(): void {
		if (this.timer) clearTimeout(this.timer);
	}

	private schedule(ms: number): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => void this.poll(), ms);
		this.timer.unref?.();
	}

	async poll(): Promise<void> {
		if (!this.enabled()) {
			this.clear();
			this.schedule(15_000);
			return;
		}
		const home = homedir();
		this.bin ??= await locate("claude", [
			join(home, ".local", "bin", IS_WIN ? "claude.exe" : "claude"),
			join(home, ".claude", "local", IS_WIN ? "claude.exe" : "claude"),
			IS_WIN ? "" : "/opt/homebrew/bin/claude",
			IS_WIN ? "" : "/usr/local/bin/claude",
		]);
		if (!this.bin) {
			this.schedule(60_000);
			return;
		}
		const res = await run(this.bin, ["agents", "--json"], 15_000);
		let list: ClaudeAgent[] = [];
		try {
			list = JSON.parse(res.out) as ClaudeAgent[];
		} catch {
			this.available = false;
			this.schedule(60_000);
			return;
		}
		this.available = true;
		this.apply(Array.isArray(list) ? list : []);
		this.schedule(8000);
	}

	private apply(list: ClaudeAgent[]): void {
		const seen = new Set<string>();
		for (const a of list) {
			if (!a.sessionId) continue;
			const uid = `claude:${a.sessionId}`;
			const existing = this.store.get(uid);
			if (existing && existing.source !== "claude-list") {
				// reported by hooks already: only fill in what hooks cannot know
				if (!existing.pid && a.pid) existing.pid = a.pid;
				continue;
			}
			seen.add(a.sessionId);
			this.known.add(a.sessionId);
			let activity: Activity | undefined = claudeState(a.status ?? "");
			if (activity === "idle" && existing?.activity === "thinking") activity = "done";
			else if (activity === "idle" && existing?.activity === "done") activity = undefined; // let it settle
			const patch = {
				activity,
				title: clip(a.name ?? "", 100),
				cwd: a.cwd ?? "",
				project: projectName(a.cwd ?? ""),
				pid: a.pid ?? 0,
				source: "claude-list" as const,
				agentName: a.kind === "background" ? "Claude Code (background)" : "",
			};
			const s: Session = this.store.upsert("claude", a.sessionId, patch);
			if (a.kind === "background") s.detail = s.detail || "background session";
		}
		for (const id of [...this.known]) {
			if (seen.has(id)) continue;
			this.known.delete(id);
			const s = this.store.get(`claude:${id}`);
			if (s?.source === "claude-list") this.store.remove(s.uid);
		}
	}

	private clear(): void {
		for (const id of this.known) {
			const s = this.store.get(`claude:${id}`);
			if (s?.source === "claude-list") this.store.remove(s.uid);
		}
		this.known.clear();
	}

	/** `claude attach <id>` in a new terminal: background sessions have no window of their own. */
	attachArgs(session: Session): string[] {
		return ["attach", session.title || session.sessionId];
	}
}
