/**
 * "Open this session": bring the terminal or editor that hosts an agent to the front.
 *
 *   1. a custom command, when the user configured one for the agent;
 *   2. the agent's process chain (recorded by the hook) → the first ancestor that owns a window:
 *      Windows Terminal (and the matching tab), VS Code, Cursor, conhost… on Windows;
 *      the exact Terminal.app / iTerm2 tab (by tty), then the hosting app on macOS;
 *   3. a window whose title mentions the session.
 */
import { execFile } from "node:child_process";
import type { Session } from "./store";
import { PowerShellHelper } from "./powershell";
import { clip, projectName } from "./util";

export type ProcInfo = { pid: number; ppid: number; name: string };
export type FocusResult = { ok: boolean; via: string };

const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";

function run(cmd: string, args: string[], timeout = 6000): Promise<{ ok: boolean; out: string; err: string }> {
	return new Promise((resolve) => {
		execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 4 << 20 }, (error, stdout, stderr) => {
			resolve({ ok: !error, out: String(stdout ?? ""), err: String(stderr ?? error?.message ?? "") });
		});
	});
}

export class WindowFocuser {
	private ps: PowerShellHelper | null = null;

	constructor(private readonly log: (msg: string) => void = () => {}) {}

	dispose(): void {
		this.ps?.dispose();
	}

	/** Windows: start the PowerShell helper early so the first key press is instant. */
	warm(): void {
		if (IS_WIN) void this.powershell().request({ op: "ping" }, 20_000);
	}

	private powershell(): PowerShellHelper {
		this.ps ??= new PowerShellHelper(this.log);
		return this.ps;
	}

	/** Ancestors of `pid` (itself first). Must run while the hook process is still alive. */
	async chain(pid: number): Promise<ProcInfo[]> {
		if (!pid || pid < 2) return [];
		if (IS_WIN) {
			const res = await this.powershell().request({ op: "chain", pid }, 5000);
			const list = Array.isArray(res.chain) ? res.chain : res.chain ? [res.chain] : [];
			return (list as Record<string, unknown>[]).map((p) => ({ pid: Number(p.pid), ppid: Number(p.ppid), name: String(p.name ?? "") }));
		}
		const res = await run("ps", ["-A", "-o", "pid=,ppid=,comm="], 3000);
		if (!res.ok) return [];
		const table = new Map<number, ProcInfo>();
		for (const line of res.out.split("\n")) {
			const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
			if (m) table.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), name: m[3].trim() });
		}
		const out: ProcInfo[] = [];
		let current = table.get(pid);
		while (current && out.length < 24 && !out.some((p) => p.pid === current?.pid)) {
			out.push(current);
			current = current.ppid > 1 ? table.get(current.ppid) : undefined;
		}
		return out;
	}

	async focus(session: Session, customCommand?: string): Promise<FocusResult> {
		if (customCommand?.trim()) return this.custom(customCommand, session);
		const titles = titleCandidates(session);
		const pids = [session.pid ?? 0, ...session.pids].filter((p) => p > 1);
		if (IS_WIN) {
			const res = await this.powershell().request({ op: "focus", pids, titles }, 6000);
			return { ok: res.ok === true, via: String(res.via ?? "") };
		}
		if (IS_MAC) return this.focusMac(pids, titles);
		return { ok: false, via: "unsupported platform" };
	}

	private async custom(template: string, session: Session): Promise<FocusResult> {
		const values: Record<string, string> = {
			cwd: session.cwd,
			project: session.project || projectName(session.cwd),
			title: session.title,
			pid: String(session.pid ?? session.pids[0] ?? ""),
			sessionId: session.sessionId,
			agent: session.agent,
		};
		const command = template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? "");
		const res = IS_WIN ? await run("cmd.exe", ["/d", "/s", "/c", command]) : await run("/bin/sh", ["-c", command]);
		return { ok: res.ok, via: res.ok ? "custom command" : `custom command failed: ${clip(res.err, 120)}` };
	}

	private async focusMac(pids: number[], titles: string[]): Promise<FocusResult> {
		// exact tab in Terminal.app / iTerm2, matched by the agent's tty
		for (const pid of pids) {
			const tty = (await run("ps", ["-o", "tty=", "-p", String(pid)], 2000)).out.trim();
			if (!tty || tty === "??") continue;
			const dev = `/dev/${tty.replace(/^\/dev\//, "")}`;
			const terminal = await osascript(`
				if application "Terminal" is running then
					tell application "Terminal"
						repeat with w in windows
							repeat with t in tabs of w
								if tty of t is "${dev}" then
									set selected tab of w to t
									set index of w to 1
									activate
									return "ok"
								end if
							end repeat
						end repeat
					end tell
				end if
				return ""`);
			if (terminal === "ok") return { ok: true, via: "Terminal tab" };
			const iterm = await osascript(`
				if application "iTerm2" is running then
					tell application "iTerm2"
						repeat with w in windows
							repeat with t in tabs of w
								repeat with s in sessions of t
									if tty of s is "${dev}" then
										select w
										select t
										select s
										activate
										return "ok"
									end if
								end repeat
							end repeat
						end repeat
					end tell
				end if
				return ""`);
			if (iterm === "ok") return { ok: true, via: "iTerm2 tab" };
			break;
		}
		// the app that hosts the agent (VS Code, Cursor, Warp, Ghostty, WezTerm…), raising the
		// window whose title names the project when the app has several
		for (const root of pids) {
			for (const proc of await this.chain(root)) {
				const raised = await osascript(`
					tell application "System Events"
						set ps to (every process whose unix id is ${proc.pid} and background only is false)
						if (count of ps) is 0 then return ""
						set p to item 1 of ps
						set frontmost of p to true
						${titles
							.slice(0, 3)
							.map(
								(t) => `try
							repeat with w in windows of p
								if name of w contains "${appleQuote(t)}" then
									perform action "AXRaise" of w
									return "ok:" & (name of p)
								end if
							end repeat
						end try`,
							)
							.join("\n")}
						return "ok:" & (name of p)
					end tell`);
				if (raised.startsWith("ok:")) return { ok: true, via: raised.slice(3) };
			}
			break;
		}
		for (const t of titles) {
			const found = await osascript(`
				tell application "System Events"
					repeat with p in (every process whose background only is false)
						try
							repeat with w in windows of p
								if name of w contains "${appleQuote(t)}" then
									set frontmost of p to true
									perform action "AXRaise" of w
									return "ok"
								end if
							end repeat
						end try
					end repeat
				end tell
				return ""`);
			if (found === "ok") return { ok: true, via: `title ${t}` };
		}
		return { ok: false, via: "no window found" };
	}
}

const appleQuote = (text: string) => text.replace(/[\\"]/g, "");

async function osascript(script: string): Promise<string> {
	const res = await run("osascript", ["-e", script], 6000);
	return res.ok ? res.out.trim() : "";
}

/** Strings likely to appear in the terminal tab / window title of this session. */
export function titleCandidates(session: Session): string[] {
	const out: string[] = [];
	if (session.title) out.push(clip(session.title, 40).replace(/…$/, ""));
	if (session.prompt) out.push(clip(session.prompt, 30).replace(/…$/, ""));
	if (session.project) out.push(session.project);
	const names: Record<string, string> = { claude: "Claude", codex: "Codex", antigravity: "Antigravity", gemini: "Gemini" };
	if (names[session.agent]) out.push(names[session.agent]);
	return [...new Set(out.filter((t) => t && t.trim().length >= 3))];
}
