import { EventEmitter } from "node:events";
import { ACTIVITIES, type Activity, type AgentId, WAITING, WORKING } from "./agents";
import { clip, plainText, truncate } from "./util";

const RECENT_FINISH_MS = 15_000;
const TEXT_KEEP = 2048;

export type Approval = { tool: string; summary: string; at: number };
export type Question = { text: string; options: string[]; at: number };

export type Session = {
	uid: string;
	agent: AgentId;
	sessionId: string;
	title: string;
	prompt: string;
	project: string;
	cwd: string;
	model: string;
	activity: Activity;
	activitySince: number;
	prevActivity: Activity | null;
	createdAt: number;
	lastUpdate: number;
	toolLabel: string;
	detail: string;
	text: string;
	approval: Approval | null;
	question: Question | null;
	subagents: number;
	seen: boolean;
	pid: number | null;
	/** Agent process chain (pid, parent, grand-parent…) captured by the hook; used to find the window. */
	pids: number[];
	/** Set for sessions pushed through the generic API: they go offline when not refreshed. */
	ttlSeconds: number | null;
};

/** What a mapper wants to change. `undefined` keeps the current value. */
export type SessionPatch = Partial<{
	activity: Activity;
	title: string;
	titleIfEmpty: string;
	prompt: string;
	project: string;
	cwd: string;
	model: string;
	toolLabel: string;
	detail: string;
	text: string | null;
	appendText: string;
	approval: Omit<Approval, "at"> | null;
	question: Omit<Question, "at"> | null;
	subagents: number;
	subagentDelta: number;
	pid: number;
	pids: number[];
	ttlSeconds: number | null;
	restoreAfterCompact: boolean;
}>;

export type Decision = { behavior: "allow" | "deny" } | null;

type Pending = { resolve: (decision: Decision) => void; timer: NodeJS.Timeout; since: number };

export type StoreOptions = {
	doneToIdleSeconds: number;
	hideIdleAfterMinutes: number;
	offlineAfterMinutes: number;
};

const TIER = { waiting: 0, working: 1, recent: 2, done: 3, idle: 4, offline: 5 } as const;

export function tierOf(session: Session, at: number): number {
	if (WAITING.has(session.activity)) return TIER.waiting;
	if (WORKING.has(session.activity) || session.activity === "error") return TIER.working;
	if (session.activity === "done") return at - session.activitySince < RECENT_FINISH_MS ? TIER.recent : TIER.done;
	if (session.activity === "offline") return TIER.offline;
	return TIER.idle;
}

export type Summary = {
	working: number;
	waiting: number;
	done: number;
	errors: number;
	idle: number;
	total: number;
	perAgent: Partial<Record<AgentId, number>>;
	firstWaiting: Session | null;
};

/**
 * Live session state. Emits `change` (debounced) whenever something visible changed.
 *
 * Ordering follows the reference keypad: waiting for you → working → finished in the last 15 s →
 * done → idle → offline. The order is only recomputed every few seconds (or when something starts
 * waiting) so keys do not shuffle under your finger.
 */
export class SessionStore extends EventEmitter {
	readonly sessions = new Map<string, Session>();
	private readonly pending = new Map<string, Pending>();
	private order: string[] = [];
	private orderAt = 0;
	private freezeUntil = 0;
	private emitTimer: NodeJS.Timeout | null = null;
	private readonly sweepTimer: NodeJS.Timeout;

	constructor(public options: StoreOptions) {
		super();
		this.sweepTimer = setInterval(() => this.sweep(), 1000);
		this.sweepTimer.unref?.();
	}

	close(): void {
		clearInterval(this.sweepTimer);
		for (const uid of [...this.pending.keys()]) this.resolvePending(uid, null);
	}

	static uidFor(agent: string, sessionId: string): string {
		return `${agent}:${sessionId}`.replace(/[^\w.:@/-]+/g, "_").slice(0, 200);
	}

	get(uid: string): Session | null {
		return this.sessions.get(uid) ?? null;
	}

	upsert(agent: AgentId, sessionId: string, patch: SessionPatch): Session {
		const uid = SessionStore.uidFor(agent, sessionId);
		const at = Date.now();
		let session = this.sessions.get(uid);
		if (!session) {
			session = {
				uid,
				agent,
				sessionId,
				title: "",
				prompt: "",
				project: "",
				cwd: "",
				model: "",
				activity: "starting",
				activitySince: at,
				prevActivity: null,
				createdAt: at,
				lastUpdate: at,
				toolLabel: "",
				detail: "",
				text: "",
				approval: null,
				question: null,
				subagents: 0,
				seen: true,
				pid: null,
				pids: [],
				ttlSeconds: null,
			};
			this.sessions.set(uid, session);
			this.order.push(uid);
		}
		session.lastUpdate = at;
		const s = session;

		if (patch.restoreAfterCompact) {
			const back = s.prevActivity && s.prevActivity !== "compacting" ? s.prevActivity : "thinking";
			s.prevActivity = null;
			this.setActivity(s, back, at);
		}
		if (patch.activity) this.setActivity(s, patch.activity, at);
		if (patch.title !== undefined && patch.title.trim()) s.title = clip(patch.title, 120);
		if (patch.titleIfEmpty !== undefined && !s.title && patch.titleIfEmpty.trim()) s.title = clip(patch.titleIfEmpty, 120);
		if (patch.prompt !== undefined) s.prompt = clip(patch.prompt, 160);
		if (patch.project !== undefined && patch.project) s.project = clip(patch.project, 80);
		if (patch.cwd !== undefined && patch.cwd) s.cwd = patch.cwd.slice(0, 1024);
		if (patch.model !== undefined && patch.model) s.model = clip(patch.model, 64);
		if (patch.toolLabel !== undefined) s.toolLabel = truncate(patch.toolLabel, 90);
		if (patch.detail !== undefined) s.detail = clip(patch.detail, 200);
		if (patch.text === null) s.text = "";
		else if (patch.text !== undefined) s.text = plainText(patch.text).slice(-TEXT_KEEP);
		if (patch.appendText) s.text = (s.text + patch.appendText).slice(-TEXT_KEEP);
		if (patch.approval !== undefined) s.approval = patch.approval ? { ...patch.approval, at } : null;
		if (patch.question !== undefined) s.question = patch.question ? { ...patch.question, at } : null;
		if (patch.subagents !== undefined) s.subagents = Math.max(0, patch.subagents);
		if (patch.subagentDelta) s.subagents = Math.max(0, s.subagents + patch.subagentDelta);
		if (patch.pid) s.pid = patch.pid;
		if (patch.pids && patch.pids.length > 0) s.pids = patch.pids.slice(0, 16);
		if (patch.ttlSeconds !== undefined) s.ttlSeconds = patch.ttlSeconds;
		if (!s.title) s.title = s.project || s.sessionId.slice(0, 12);
		this.scheduleEmit();
		return s;
	}

	setActivity(session: Session, activity: Activity, at = Date.now()): void {
		if (!ACTIVITIES.includes(activity) || session.activity === activity) return;
		if (activity === "compacting") session.prevActivity = session.activity;
		const wasWaiting = WAITING.has(session.activity);
		session.activity = activity;
		session.activitySince = at;
		if (activity === "done" || WAITING.has(activity) || activity === "error") session.seen = false;
		if (WAITING.has(activity)) this.orderAt = 0; // bring it forward on the next tick
		if (wasWaiting && !WAITING.has(activity)) {
			session.approval = null;
			session.question = null;
			this.resolvePending(session.uid, null);
		}
		if (activity === "thinking" || activity === "starting" || activity === "done") session.toolLabel = "";
		if (activity !== "error" && activity !== "approval" && activity !== "question") session.detail = "";
		if (activity === "thinking" || activity === "starting") session.text = activity === "starting" ? "" : session.text;
	}

	remove(uid: string): void {
		if (!this.sessions.has(uid)) return;
		this.resolvePending(uid, null);
		this.sessions.delete(uid);
		this.order = this.order.filter((id) => id !== uid);
		this.scheduleEmit();
	}

	markSeen(uid: string): void {
		const s = this.sessions.get(uid);
		if (s && !s.seen) {
			s.seen = true;
			this.scheduleEmit();
		}
	}

	/** Keep the current order for a moment (called on key presses). */
	freezeOrder(ms = 2500): void {
		this.freezeUntil = Date.now() + ms;
	}

	// ------------------------------------------------------------------------------------------ decisions

	/** A hook parks a permission request here until a key answers it or the wait expires. */
	waitForDecision(uid: string, waitMs: number): Promise<Decision> {
		if (waitMs <= 0) return Promise.resolve(null);
		this.resolvePending(uid, null);
		return new Promise((resolve) => {
			const timer = setTimeout(() => this.resolvePending(uid, null), waitMs);
			this.pending.set(uid, { resolve, timer, since: Date.now() });
			this.scheduleEmit();
		});
	}

	hasPending(uid: string): boolean {
		return this.pending.has(uid);
	}

	resolvePending(uid: string, decision: Decision): boolean {
		const pending = this.pending.get(uid);
		if (!pending) return false;
		clearTimeout(pending.timer);
		this.pending.delete(uid);
		pending.resolve(decision);
		this.scheduleEmit();
		return true;
	}

	/** Answer the approval of a session. Returns false when nothing is waiting for an answer. */
	decide(uid: string, behavior: "allow" | "deny"): boolean {
		const session = this.sessions.get(uid);
		if (!this.resolvePending(uid, { behavior })) return false;
		if (session) {
			session.seen = true;
			session.approval = null;
			this.setActivity(session, behavior === "allow" ? "tool" : "thinking");
			if (behavior === "deny") session.detail = "denied from Stream Deck";
			this.scheduleEmit();
		}
		return true;
	}

	/** Oldest session whose approval can be answered from the deck. */
	firstAnswerable(): Session | null {
		let best: Session | null = null;
		for (const uid of this.pending.keys()) {
			const s = this.sessions.get(uid);
			if (s && s.activity === "approval" && (!best || s.activitySince < best.activitySince)) best = s;
		}
		return best;
	}

	// ------------------------------------------------------------------------------------------ views

	/** Sessions in deck order (stable between re-sorts). */
	ordered(showOffline: boolean): Session[] {
		const at = Date.now();
		if (at >= this.freezeUntil && at - this.orderAt > 8000) this.resort(at);
		const list: Session[] = [];
		for (const uid of this.order) {
			const s = this.sessions.get(uid);
			if (s && (showOffline || s.activity !== "offline")) list.push(s);
		}
		return list;
	}

	private resort(at: number): void {
		this.orderAt = at;
		const list = [...this.sessions.values()];
		list.sort((a, b) => {
			const ta = tierOf(a, at);
			const tb = tierOf(b, at);
			if (ta !== tb) return ta - tb;
			if (ta === TIER.waiting) return a.activitySince - b.activitySince;
			if (ta === TIER.working) return a.createdAt - b.createdAt;
			return b.activitySince - a.activitySince;
		});
		this.order = list.map((s) => s.uid);
	}

	summary(): Summary {
		const perAgent: Partial<Record<AgentId, number>> = {};
		const out: Summary = { working: 0, waiting: 0, done: 0, errors: 0, idle: 0, total: 0, perAgent, firstWaiting: null };
		for (const s of this.sessions.values()) {
			if (s.activity === "offline") continue;
			out.total += 1;
			perAgent[s.agent] = (perAgent[s.agent] ?? 0) + 1;
			if (WORKING.has(s.activity)) out.working += 1;
			else if (WAITING.has(s.activity)) {
				out.waiting += 1;
				if (!out.firstWaiting || s.activitySince < out.firstWaiting.activitySince) out.firstWaiting = s;
			} else if (s.activity === "done") out.done += 1;
			else if (s.activity === "error") out.errors += 1;
			else if (s.activity === "idle") out.idle += 1;
		}
		return out;
	}

	// ------------------------------------------------------------------------------------------ housekeeping

	private sweep(): void {
		const at = Date.now();
		const { doneToIdleSeconds, hideIdleAfterMinutes, offlineAfterMinutes } = this.options;
		let changed = false;
		for (const s of [...this.sessions.values()]) {
			if (s.ttlSeconds && s.activity !== "offline" && at - s.lastUpdate > s.ttlSeconds * 1000) {
				this.setActivity(s, "offline", at);
				changed = true;
			}
			// a working session that went silent for a long time most likely died with its terminal
			if (WORKING.has(s.activity) && offlineAfterMinutes > 0 && at - s.lastUpdate > offlineAfterMinutes * 60_000) {
				this.setActivity(s, "offline", at);
				changed = true;
			}
			if (s.activity === "done" && doneToIdleSeconds > 0 && at - s.activitySince > doneToIdleSeconds * 1000 && s.seen) {
				this.setActivity(s, "idle", at);
				s.activitySince = s.lastUpdate;
				changed = true;
			}
			const quietFor = at - s.lastUpdate;
			if ((s.activity === "idle" || s.activity === "offline") && hideIdleAfterMinutes > 0 && quietFor > hideIdleAfterMinutes * 60_000) {
				this.remove(s.uid);
				changed = true;
			}
		}
		if (changed) this.scheduleEmit();
	}

	scheduleEmit(): void {
		if (this.emitTimer) return;
		this.emitTimer = setTimeout(() => {
			this.emitTimer = null;
			this.emit("change");
		}, 30);
	}
}
