/**
 * The plugin's brain: owns the session store, the hook server, the window focuser and every key on
 * every Stream Deck, and draws the keys at the configured frame rate.
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type AgentId, HOOK_AGENTS, type HookAgentId } from "./core/agents";
import { clearDemo, runDemo } from "./core/demo";
import { WindowFocuser } from "./core/focus";
import { type AgentStatus, install, type InstallOptions, prepareRuntime, type Runtime, runtimeFor, status, uninstall } from "./core/installer";
import { HookServer } from "./core/server";
import { type Session, SessionStore } from "./core/store";
import { decisionTile, emptyTile, hubTile, pageTile, type RenderContext, sessionTile, toDataUrl } from "./render/tiles";
import { type GlobalSettings, type Resolved, resolveSettings, type SessionKeySettings, VERSION } from "./settings";

export type KeyKind = "session" | "hub" | "allow" | "deny" | "page";

/** The slice of a Stream Deck key the deck needs (keeps this file independent of the SDK). */
export type KeyHandle = {
	id: string;
	deviceId: string;
	/** Elgato DeviceType: 0 Stream Deck / MK.2 (72 px keys), 1 Mini (80 px), 2 XL, 7 +, 9 Neo… */
	deviceType: number;
	row: number;
	column: number;
	setImage(image: string): Promise<void> | void;
	showOk(): Promise<void> | void;
	showAlert(): Promise<void> | void;
};

type Key = {
	kind: KeyKind;
	handle: KeyHandle;
	settings: SessionKeySettings;
	last: string;
	lastAt: number;
	down: { at: number; uid: string | null; held: boolean; timer: NodeJS.Timeout } | null;
};

export type Logger = { info(msg: string): void; warn(msg: string): void; error(msg: string): void };

const HOLD_MS = 600;
const MIN_FRAME_GAP = 100; // never more than 10 images per second per key (Elgato guideline)

export class Deck {
	readonly store: SessionStore;
	readonly focuser: WindowFocuser;
	readonly server: HookServer;
	readonly keys = new Map<string, Key>();
	settings: Resolved;
	raw: GlobalSettings = {};
	statuses: AgentStatus[] = [];
	page = 0;
	listening = false;
	problem = "";
	private rt: Runtime;
	private token = randomBytes(24).toString("base64url");
	private timer: NodeJS.Timeout | null = null;
	private kick: NodeJS.Timeout | null = null;
	private demoStart = 0;
	private demoApplied = new Map<string, number>();
	private inspectorPush: ((payload: Record<string, unknown>) => void) | null = null;

	constructor(private readonly log: Logger) {
		this.settings = resolveSettings({});
		this.store = new SessionStore({ doneToIdleSeconds: 120, hideIdleAfterMinutes: 120, offlineAfterMinutes: 30 });
		this.focuser = new WindowFocuser((m) => log.warn(m));
		this.server = new HookServer(this.store, this.focuser, {
			token: this.token,
			// Claude Code shows its own prompt while the hook waits (first answer wins), so the deck can
			// keep the request open until just before the hook's 300 s timeout. Codex waits for hooks
			// before prompting, so it gets the configurable, shorter wait.
			approvalWaitSeconds: (agent) => (this.settings.approvalWait === 0 ? 0 : agent === "claude" ? 290 : this.settings.approvalWait),
			deckVisible: () => [...this.keys.values()].some((k) => k.kind === "session" || k.kind === "allow" || k.kind === "hub"),
			log: (m) => log.info(m),
		});
		this.rt = runtimeFor();
		this.store.on("change", () => this.requestFrame());
	}

	// ---------------------------------------------------------------------------------------------- lifecycle

	async start(global: GlobalSettings): Promise<void> {
		this.applySettings(global);
		try {
			const port = await this.server.listen(this.settings.port);
			this.listening = true;
			this.problem = "";
			prepareRuntime(this.rt, hookSource(), { port, token: this.token });
			this.log.info(`listening on 127.0.0.1:${port}, node ${this.rt.node}`);
		} catch (error) {
			this.problem = (error as Error).message;
			this.log.error(`cannot start the hook server: ${this.problem}`);
		}
		this.refreshStatus();
		this.selfHeal();
		this.restartLoop();
		this.focuser.warm();
	}

	async stop(): Promise<void> {
		if (this.timer) clearInterval(this.timer);
		this.store.close();
		this.focuser.dispose();
		await this.server.close();
	}

	applySettings(global: GlobalSettings): void {
		const before = this.settings;
		this.raw = { ...global };
		this.settings = resolveSettings(this.raw);
		this.store.options.doneToIdleSeconds = this.settings.doneToIdle;
		this.store.options.hideIdleAfterMinutes = this.settings.hideIdleAfter;
		if (this.settings.demo && !this.demoStart) this.demoStart = Date.now();
		if (!this.settings.demo && this.demoStart) {
			this.demoStart = 0;
			this.demoApplied.clear();
			clearDemo(this.store);
		}
		if (before.liveText !== this.settings.liveText) this.selfHeal();
		if (before.fps !== this.settings.fps) this.restartLoop();
		for (const key of this.keys.values()) key.last = "";
		this.requestFrame();
	}

	private installOptions(): InstallOptions {
		return { liveText: this.settings.liveText, approvalTimeout: 300 };
	}

	refreshStatus(): AgentStatus[] {
		this.statuses = HOOK_AGENTS.map((agent) => {
			try {
				return status(agent, this.rt, this.installOptions());
			} catch (error) {
				return { agent, detected: false, installed: false, upToDate: false, path: "", note: (error as Error).message };
			}
		});
		return this.statuses;
	}

	/** Keeps installed hooks pointing at the current Stream Deck Node.js runtime. */
	private selfHeal(): void {
		if (!this.listening) return;
		for (const s of this.refreshStatus()) {
			if (s.installed && !s.upToDate && s.agent === "claude") {
				try {
					install(s.agent, this.rt, this.installOptions());
					this.log.info(`updated ${s.agent} hooks (${s.path})`);
				} catch (error) {
					this.log.warn(`could not update ${s.agent} hooks: ${(error as Error).message}`);
				}
			}
		}
		this.refreshStatus();
	}

	connect(agent: HookAgentId): { ok: boolean; message: string } {
		if (!this.listening) return { ok: false, message: this.problem || "the plugin is still starting" };
		try {
			const path = install(agent, this.rt, this.installOptions());
			this.refreshStatus();
			this.requestFrame();
			this.log.info(`connected ${agent}: ${path}`);
			return { ok: true, message: `Hooks added to ${path}` };
		} catch (error) {
			return { ok: false, message: (error as Error).message };
		}
	}

	disconnect(agent: HookAgentId): { ok: boolean; message: string } {
		try {
			const path = uninstall(agent);
			this.refreshStatus();
			this.requestFrame();
			this.log.info(`disconnected ${agent}: ${path}`);
			return { ok: true, message: `Hooks removed from ${path}` };
		} catch (error) {
			return { ok: false, message: (error as Error).message };
		}
	}

	/** Snapshot for the property inspector. */
	statusPayload(): Record<string, unknown> {
		return {
			event: "status",
			version: VERSION,
			platform: process.platform,
			listening: this.listening,
			port: this.server.port,
			problem: this.problem,
			sessions: this.store.summary().total,
			lastHookAt: this.server.lastHookAt,
			hookCounts: this.server.hookCounts,
			agents: this.refreshStatus(),
			home: this.rt.home,
		};
	}

	setInspectorPush(push: ((payload: Record<string, unknown>) => void) | null): void {
		this.inspectorPush = push;
	}

	// ---------------------------------------------------------------------------------------------- keys

	addKey(kind: KeyKind, handle: KeyHandle, settings: SessionKeySettings = {}): void {
		this.keys.set(handle.id, { kind, handle, settings, last: "", lastAt: 0, down: null });
		this.requestFrame();
	}

	updateKey(id: string, settings: SessionKeySettings): void {
		const key = this.keys.get(id);
		if (!key) return;
		key.settings = settings;
		key.last = "";
		this.requestFrame();
	}

	removeKey(id: string): void {
		const key = this.keys.get(id);
		if (key?.down) clearTimeout(key.down.timer);
		this.keys.delete(id);
		this.requestFrame();
	}

	keyDown(id: string): void {
		const key = this.keys.get(id);
		if (!key) return;
		this.store.freezeOrder();
		const target = key.kind === "session" ? this.layout().get(id) : null;
		if (key.down) clearTimeout(key.down.timer);
		key.down = {
			at: Date.now(),
			uid: target?.uid ?? null,
			held: false,
			timer: setTimeout(() => {
				if (!key.down) return;
				key.down.held = true;
				void this.hold(key, key.down.uid);
			}, HOLD_MS),
		};
		this.requestFrame();
	}

	keyUp(id: string): void {
		const key = this.keys.get(id);
		if (!key?.down) return;
		clearTimeout(key.down.timer);
		const { held, uid } = key.down;
		key.down = null;
		this.requestFrame();
		if (!held) void this.press(key, uid);
	}

	private async press(key: Key, uid: string | null): Promise<void> {
		switch (key.kind) {
			case "session": {
				const session = uid ? this.store.get(uid) : null;
				if (!session) return void key.handle.showAlert();
				await this.open(key, session);
				return;
			}
			case "hub": {
				const summary = this.store.summary();
				const target = summary.firstWaiting ?? this.store.ordered(false).find((s) => !s.seen && (s.activity === "done" || s.activity === "error"));
				if (target) await this.open(key, target);
				else void key.handle.showOk();
				return;
			}
			case "allow":
			case "deny": {
				const target = this.store.firstAnswerable();
				if (target && this.store.decide(target.uid, key.kind)) void key.handle.showOk();
				else void key.handle.showAlert();
				return;
			}
			case "page":
				this.nextPage();
				return;
		}
	}

	private async hold(key: Key, uid: string | null): Promise<void> {
		switch (key.kind) {
			case "session": {
				const session = uid ? this.store.get(uid) : null;
				if (!session) return void key.handle.showAlert();
				if (session.activity === "approval" && this.settings.holdToApprove && this.store.hasPending(session.uid)) {
					this.store.decide(session.uid, "allow");
					void key.handle.showOk();
					return;
				}
				if (session.activity === "done" || session.activity === "error" || session.activity === "idle") {
					// hold = "I've seen it": clears the unread dot and lets it settle
					this.store.markSeen(session.uid);
					if (session.activity !== "idle") this.store.setActivity(session, "idle");
					this.store.scheduleEmit();
					void key.handle.showOk();
					return;
				}
				await this.open(key, session);
				return;
			}
			case "hub":
			case "page":
				if (key.kind === "page") this.page = 0;
				else this.nextPage();
				this.requestFrame();
				return;
			default:
				return this.press(key, uid);
		}
	}

	/** Bring the session's window forward; a held permission request is released to the terminal. */
	private async open(key: Key, session: Session): Promise<void> {
		this.store.markSeen(session.uid);
		if (session.activity === "approval") this.store.resolvePending(session.uid, null);
		const res = await this.focuser.focus(session, this.settings.openCommand[session.agent]);
		this.log.info(`open ${session.agent} "${session.title}": ${res.ok ? "ok" : "failed"} (${res.via})`);
		if (!res.ok) void key.handle.showAlert();
	}

	private large(key: Key): boolean {
		if (this.settings.textSize === "auto") return smallKeys(key.handle.deviceType);
		return this.settings.textSize === "large";
	}

	nextPage(): void {
		const { pages } = this.pageInfo(this.layoutGroups());
		this.page = pages > 0 ? (this.page + 1) % pages : 0;
		for (const key of this.keys.values()) key.last = "";
		this.requestFrame();
	}

	// ---------------------------------------------------------------------------------------------- layout

	private sessions(): Session[] {
		return this.store.ordered(this.settings.showOffline);
	}

	private layoutGroups(): Map<string, Key[]> {
		const groups = new Map<string, Key[]>();
		for (const key of this.keys.values()) {
			if (key.kind !== "session" || slotOf(key)) continue;
			const filter = agentFilter(key);
			const group = `${key.handle.deviceId}|${filter}`;
			groups.set(group, [...(groups.get(group) ?? []), key]);
		}
		for (const list of groups.values()) list.sort((a, b) => a.handle.row - b.handle.row || a.handle.column - b.handle.column);
		return groups;
	}

	private pageInfo(groups: Map<string, Key[]>): { size: number; pages: number } {
		const all = this.sessions();
		let pages = 1;
		let size = 0;
		for (const [group, keys] of groups) {
			const filter = group.split("|")[1];
			const count = filter === "any" ? all.length : all.filter((s) => s.agent === filter).length;
			pages = Math.max(pages, Math.ceil(count / keys.length));
			if (filter === "any") size = Math.max(size, keys.length);
		}
		return { size: size || 8, pages };
	}

	/** Which session each session key shows right now. */
	layout(): Map<string, Session | null> {
		const out = new Map<string, Session | null>();
		const all = this.sessions();
		const groups = this.layoutGroups();
		const { pages } = this.pageInfo(groups);
		if (this.page >= pages) this.page = 0;
		for (const [group, keys] of groups) {
			const filter = group.split("|")[1];
			const list = filter === "any" ? all : all.filter((s) => s.agent === filter);
			keys.forEach((key, i) => out.set(key.handle.id, list[this.page * keys.length + i] ?? null));
		}
		for (const key of this.keys.values()) {
			const slot = key.kind === "session" ? slotOf(key) : 0;
			if (!slot) continue;
			const filter = agentFilter(key);
			const list = filter === "any" ? all : all.filter((s) => s.agent === filter);
			out.set(key.handle.id, list[slot - 1] ?? null);
		}
		return out;
	}

	// ---------------------------------------------------------------------------------------------- drawing

	private restartLoop(): void {
		if (this.timer) clearInterval(this.timer);
		const interval = this.settings.fps > 0 ? Math.round(1000 / this.settings.fps) : 1000;
		this.timer = setInterval(() => this.frame(), interval);
		this.timer.unref?.();
	}

	requestFrame(): void {
		if (this.kick) return;
		this.kick = setTimeout(() => {
			this.kick = null;
			this.frame();
		}, 16);
	}

	private viewOf(session: Session): Session {
		const topic = session.title && session.title !== session.project ? session.title : session.prompt;
		let title = session.title || session.project;
		if (this.settings.titleMode === "project") title = session.project || topic || session.sessionId;
		else if (this.settings.titleMode === "topic") title = topic || session.project || session.sessionId;
		else title = session.project && topic && !topic.startsWith(session.project) ? `${session.project} – ${topic}` : topic || session.project || session.sessionId;
		return { ...session, title };
	}

	frame(): void {
		const now = Date.now();
		if (this.demoStart) runDemo(this.store, (now - this.demoStart) / 1000, this.demoApplied);
		if (this.keys.size === 0) return;
		const ctx: RenderContext = { now, palette: this.settings.palette, animate: this.settings.fps > 0 };
		const layout = this.layout();
		const groups = this.layoutGroups();
		const { size, pages } = this.pageInfo(groups);
		const all = this.sessions();
		const answerable = this.store.firstAnswerable();
		const connected = this.statuses.filter((s) => s.installed).length + (this.demoStart ? 1 : 0);

		for (const key of this.keys.values()) {
			let svg: string;
			try {
				svg = this.draw(key, { ctx, layout, size, pages, all, answerable, connected, groups, now });
			} catch (error) {
				// one bad tile must never freeze the whole deck
				this.log.error(`drawing ${key.kind} failed: ${(error as Error).stack ?? error}`);
				continue;
			}
			if (svg === key.last || now - key.lastAt < MIN_FRAME_GAP) continue;
			key.last = svg;
			key.lastAt = now;
			void Promise.resolve(key.handle.setImage(toDataUrl(svg))).catch(() => {});
		}
	}

	private draw(
		key: Key,
		f: { ctx: RenderContext; layout: Map<string, Session | null>; size: number; pages: number; all: Session[]; answerable: Session | null; connected: number; groups: Map<string, Key[]>; now: number },
	): string {
		const { ctx, layout, size, pages, all, answerable, connected, groups, now } = f;
		let svg: string;
		{
			switch (key.kind) {
				case "session": {
					const session = layout.get(key.handle.id) ?? null;
					if (!session) {
						svg = emptyTile(!this.listening ? "offline" : connected === 0 && all.length === 0 && isFirstSessionKey(key, groups) ? "no agents" : "");
						break;
					}
					const holding = key.down && !key.down.held && session.activity === "approval" && this.store.hasPending(session.uid);
					svg = sessionTile(this.viewOf(session), { ...ctx, large: this.large(key), holdProgress: holding ? Math.min(1, (now - (key.down?.at ?? now)) / HOLD_MS) : 0 });
					break;
				}
				case "hub":
					svg = hubTile(
						{
							summary: this.store.summary(),
							pips: all.slice(this.page * size, this.page * size + size).map((s) => this.viewOf(s)),
							page: this.page,
							pages,
							listening: this.listening,
							problem: this.problem,
							connectedAgents: connected,
						},
						ctx,
					);
					break;
				case "allow":
				case "deny":
					svg = decisionTile(key.kind, answerable ? this.viewOf(answerable) : null, ctx);
					break;
				case "page":
					svg = pageTile(this.page, pages, all.length);
					break;
			}
		}
		return svg;
	}
}

/** Small keys (72–80 px) get the large text layout unless the user chose otherwise. */
function smallKeys(deviceType: number): boolean {
	return deviceType === 0 || deviceType === 1;
}

function slotOf(key: Key): number {
	const n = Number(key.settings.slot);
	return Number.isInteger(n) && n > 0 ? n : 0;
}

function agentFilter(key: Key): string {
	const a = key.settings.agent;
	return a && a !== "any" ? a : "any";
}

function isFirstSessionKey(key: Key, groups: Map<string, Key[]>): boolean {
	for (const list of groups.values()) if (list[0] === key) return true;
	return false;
}

/** hook.mjs ships next to plugin.js inside the .sdPlugin folder. */
function hookSource(): string {
	const here = dirname(fileURLToPath(import.meta.url));
	const candidates = [join(here, "hook.mjs"), join(process.cwd(), "bin", "hook.mjs")];
	return candidates.find((p) => existsSync(p)) ?? candidates[0];
}

export type { AgentId };
