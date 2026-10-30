/**
 * Local HTTP endpoint the hooks talk to. Listens on 127.0.0.1 only and requires the token stored in
 * ~/.coding-agents-deck/endpoint.json (readable only by the user), so web pages and other users
 * cannot inject sessions.
 *
 *   GET  /health                         liveness (no token)
 *   POST /hook/:agent?event=&ppid=&cpid= hook events → tile updates; PermissionRequest waits for a key
 *   GET  /api/v1/state                   sessions as JSON
 *   POST /api/v1/sessions                push a session from any script: {id, title, activity, detail…}
 */
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { type Activity, ACTIVITIES, type AgentId, isAgentId } from "./agents";
import type { WindowFocuser } from "./focus";
import { eventName, type Mapped, MAPPERS, neutralReply } from "./mappers";
import { type SessionPatch, SessionStore } from "./store";
import { clip } from "./util";

export type ServerOptions = {
	token: string;
	/** Seconds a permission request waits for a key (per agent). */
	approvalWaitSeconds: (agent: AgentId) => number;
	/** True while at least one of our keys is on a Stream Deck: only then is holding worth it. */
	deckVisible: () => boolean;
	log: (msg: string) => void;
	onHook?: (agent: AgentId, event: string) => void;
};

const CHAIN_EVENTS = new Set(["SessionStart", "UserPromptSubmit", "PreInvocation", "BeforeAgent", "Title"]);
/** Events that mean a pending permission request was settled elsewhere (or never will be). */
const SETTLING_EVENTS = new Set(["PostToolUse", "PostToolUseFailure", "PermissionDenied", "Stop", "StopFailure", "UserPromptSubmit", "Interrupt", "SessionEnd", "AfterTool", "AfterAgent"]);
const MAX_BODY = 512 * 1024;

export class HookServer {
	private server: Server | null = null;
	port = 0;
	lastHookAt = 0;
	readonly hookCounts: Partial<Record<AgentId, number>> = {};

	constructor(
		private readonly store: SessionStore,
		private readonly focuser: WindowFocuser,
		private readonly options: ServerOptions,
	) {}

	/** Tries `port`, then the next few, and resolves with the port actually bound. */
	async listen(port: number): Promise<number> {
		for (let candidate = port; candidate < port + 20; candidate += 1) {
			try {
				await this.tryListen(candidate);
				this.port = candidate;
				return candidate;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
			}
		}
		throw new Error(`ports ${port}-${port + 19} are all in use`);
	}

	private tryListen(port: number): Promise<void> {
		return new Promise((resolve, reject) => {
			const server = createServer((req, res) => {
				this.handle(req, res).catch((error) => {
					this.options.log(`request failed: ${(error as Error).message}`);
					if (!res.headersSent) send(res, 500, { error: "internal" });
				});
			});
			server.keepAliveTimeout = 2000;
			server.requestTimeout = 0; // permission requests are held on purpose
			server.once("error", reject);
			server.listen(port, "127.0.0.1", () => {
				server.off("error", reject);
				this.server = server;
				resolve();
			});
		});
	}

	close(): Promise<void> {
		return new Promise((resolve) => {
			if (!this.server) return resolve();
			this.server.close(() => resolve());
			this.server.closeAllConnections?.();
			this.server = null;
		});
	}

	private authorized(req: IncomingMessage, url: URL): boolean {
		const header = req.headers.authorization ?? "";
		const given = header.startsWith("Bearer ") ? header.slice(7) : (url.searchParams.get("k") ?? "");
		const a = Buffer.from(given);
		const b = Buffer.from(this.options.token);
		return a.length === b.length && timingSafeEqual(a, b);
	}

	private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		// browsers always send Origin on cross-site requests: hooks never do
		if (req.headers.origin) return send(res, 403, { error: "forbidden" });
		if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true, name: "coding-agents-deck" });
		if (!this.authorized(req, url)) return send(res, 401, { error: "unauthorized" });

		const hook = /^\/hook\/([a-z-]+)$/.exec(url.pathname);
		if (req.method === "POST" && hook) {
			const body = await readJson(req);
			return this.onHook(hook[1], url, body, res);
		}
		if (req.method === "GET" && url.pathname === "/api/v1/state") {
			return send(res, 200, { sessions: [...this.store.sessions.values()], summary: this.store.summary() });
		}
		if (req.method === "POST" && url.pathname === "/api/v1/sessions") {
			const body = await readJson(req);
			return this.onCustom(body, res);
		}
		send(res, 404, { error: "not_found" });
	}

	private async onHook(agentRaw: string, url: URL, payload: Record<string, unknown>, res: ServerResponse): Promise<void> {
		const agent = (isAgentId(agentRaw) ? agentRaw : "custom") as AgentId;
		const event = eventName(payload, url.searchParams.get("event") ?? "");
		this.lastHookAt = Date.now();
		this.hookCounts[agent] = (this.hookCounts[agent] ?? 0) + 1;
		this.options.onHook?.(agent, event);
		const mapper = MAPPERS[agent];
		const mapped: Mapped | null = mapper ? mapper(event, payload) : null;
		if (!mapped) return reply(res, neutralReply(agent, event));
		if (!mapped.sessionId) return reply(res, mapped.reply ? mapped.reply(null) : neutralReply(agent, event));

		const uid = SessionStore.uidFor(agent, mapped.sessionId);
		if (mapped.remove) {
			this.store.remove(uid);
			return reply(res, mapped.reply ? mapped.reply(null) : neutralReply(agent, event));
		}

		const existing = this.store.get(uid);
		let patch: SessionPatch = mapped.patch;
		// async hooks can arrive late: a PreToolUse delivered after its own PermissionRequest must not
		// cancel the request that is waiting for a key
		const parked = !!existing && this.store.hasPending(uid) && !mapped.awaitDecision && !SETTLING_EVENTS.has(event);
		if (parked || (mapped.when && !mapped.when(existing))) {
			const { cwd, project, model, title, titleIfEmpty } = patch;
			patch = { cwd, project, model, title, titleIfEmpty };
		}

		// who to bring to the front later: Claude Code tells us its PID; for the others, record the
		// process chain now, while this hook (and the shell that runs it) is still alive
		const cpid = Number(url.searchParams.get("cpid") ?? 0);
		const ppid = Number(url.searchParams.get("ppid") ?? 0);
		if (cpid > 1) patch.pid = cpid;
		else if (ppid > 1 && (!existing || existing.pids.length === 0 || CHAIN_EVENTS.has(event))) {
			const chain = await this.focuser.chain(ppid).catch(() => []);
			if (chain.length > 0) patch.pids = chain.map((p) => p.pid);
		}

		const session = this.store.upsert(agent, mapped.sessionId, patch);
		if (mapped.awaitDecision) {
			const wait = this.options.deckVisible() ? this.options.approvalWaitSeconds(agent) : 0;
			const decision = await this.store.waitForDecision(uid, wait * 1000);
			if (decision) this.options.log(`${agent} ${session.title}: ${decision.behavior} from Stream Deck`);
			return reply(res, mapped.reply ? mapped.reply(decision) : {});
		}
		if (mapped.replyFromSession) return reply(res, mapped.replyFromSession(session));
		return reply(res, mapped.reply ? mapped.reply(null) : neutralReply(agent, event));
	}

	private onCustom(body: Record<string, unknown>, res: ServerResponse): void {
		const id = clip(body.id, 80);
		if (!id) return send(res, 400, { error: "id is required" });
		const agent = (isAgentId(body.agent) ? body.agent : "custom") as AgentId;
		if (body.remove === true) {
			this.store.remove(SessionStore.uidFor(agent, id));
			return send(res, 200, { ok: true });
		}
		const activity = ACTIVITIES.includes(body.activity as Activity) ? (body.activity as Activity) : undefined;
		const patch: SessionPatch = {
			activity,
			title: typeof body.title === "string" ? body.title : undefined,
			detail: typeof body.detail === "string" ? body.detail : undefined,
			toolLabel: typeof body.toolLabel === "string" ? body.toolLabel : undefined,
			text: typeof body.text === "string" ? body.text : undefined,
			project: typeof body.project === "string" ? body.project : undefined,
			ttlSeconds: Math.min(3600, Math.max(15, Number(body.ttlSeconds) || 300)),
		};
		if (activity === "approval") patch.approval = { tool: clip(body.tool ?? "Action", 30), summary: clip(body.detail ?? "", 120) };
		this.store.upsert(agent, id, patch);
		send(res, 200, { ok: true });
	}
}

function send(res: ServerResponse, status: number, body: unknown): void {
	const text = JSON.stringify(body);
	res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(text), "Cache-Control": "no-store" });
	res.end(text);
}

/** Hook answers: objects as JSON, strings verbatim (Antigravity title), null as an empty body. */
function reply(res: ServerResponse, body: unknown): void {
	const text = body === null || body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
	res.writeHead(200, { "Content-Type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json", "Content-Length": Buffer.byteLength(text) });
	res.end(text);
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_BODY) {
				req.destroy();
				reject(new Error("payload too large"));
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			const text = Buffer.concat(chunks).toString("utf8").trim();
			if (!text) return resolve({});
			try {
				const parsed = JSON.parse(text) as unknown;
				resolve(parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {});
			} catch {
				resolve({});
			}
		});
		req.on("error", reject);
	});
}
