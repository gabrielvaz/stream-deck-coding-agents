/**
 * Usage limits per agent account: the 5-hour and weekly windows of Claude Code and Codex, and the
 * per-model quotas of Antigravity. Read the same way the agents themselves do, nothing is stored:
 *
 *   Claude Code   the OAuth token Claude Code keeps (macOS Keychain or ~/.claude/.credentials.json)
 *                 → GET api.anthropic.com/api/oauth/usage
 *   Codex         the last `rate_limits` snapshot Codex wrote locally (session logs, logs_2.sqlite)
 *   Antigravity   the running app's language server on 127.0.0.1 (GetUserStatus), or the Cloud Code
 *                 API with the `agy login` token from the system keyring while it is still valid
 */
import { execFile } from "node:child_process";
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

export const LIMIT_PROVIDERS = ["claude", "codex", "antigravity"] as const;
export type LimitProvider = (typeof LIMIT_PROVIDERS)[number];

export const isLimitProvider = (value: unknown): value is LimitProvider => typeof value === "string" && (LIMIT_PROVIDERS as readonly string[]).includes(value);

export type LimitWindow = {
	/** "5h", "Week", or a model name for Antigravity. */
	label: string;
	usedPercent: number;
	/** Epoch ms; 0 when unknown. */
	resetsAt: number;
	windowMinutes: number;
};

export type LimitStatus = "ok" | "loading" | "no-auth" | "expired" | "none" | "error";

export type Limits = {
	provider: LimitProvider;
	status: LimitStatus;
	windows: LimitWindow[];
	/** When the numbers were measured (Codex: when its last session reported them). */
	updatedAt: number;
	/** What to do when there is nothing to show ("Open Claude Code"). */
	note: string;
};

const FIVE_HOURS = 300;
const WEEK = 10080;

const empty = (provider: LimitProvider, status: LimitStatus, note: string): Limits => ({ provider, status, windows: [], updatedAt: 0, note });

const clampPct = (n: number) => Math.min(100, Math.max(0, n));

const num = (value: unknown): number | undefined => {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
	return undefined;
};

/** "5h" for windows up to six hours, "Day", "Week", then "Month". */
export function windowName(minutes: number): string {
	if (minutes > 0 && minutes <= 360) return "5h";
	if (minutes > 0 && minutes <= 1440) return "Day";
	if (minutes <= WEEK) return "Week";
	return "Month";
}

/** Shortest window first (5h before Week). */
const byWindow = (a: LimitWindow, b: LimitWindow) => (a.windowMinutes || Infinity) - (b.windowMinutes || Infinity);

// ---------------------------------------------------------------------------------------------- http

type Reply = { status: number; body: string };

function call(url: string, init: { method?: string; headers?: Record<string, string>; body?: string; insecure?: boolean; timeout?: number } = {}): Promise<Reply> {
	return new Promise((resolve, reject) => {
		const u = new URL(url);
		const send = u.protocol === "https:" ? httpsRequest : httpRequest;
		const headers = { ...init.headers };
		if (init.body !== undefined) headers["Content-Length"] = String(Buffer.byteLength(init.body));
		const req = send(
			{ hostname: u.hostname, port: u.port, path: `${u.pathname}${u.search}`, method: init.method ?? "GET", headers, timeout: init.timeout ?? 8000, ...(init.insecure ? { rejectUnauthorized: false } : {}) },
			(res) => {
				let data = "";
				res.setEncoding("utf8");
				res.on("data", (chunk) => (data += chunk));
				res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
			},
		);
		req.on("error", reject);
		req.on("timeout", () => req.destroy(new Error("timeout")));
		if (init.body !== undefined) req.write(init.body);
		req.end();
	});
}

function run(cmd: string, args: string[], timeout = 6000): Promise<string | null> {
	return new Promise((resolve) => {
		execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (error, stdout) => resolve(error || !stdout ? null : stdout.toString()));
	});
}

// ---------------------------------------------------------------------------------------------- Claude Code

/** Maps the body of /api/oauth/usage: `five_hour` and the most used `seven_day*` window. */
export function mapClaudeUsage(json: unknown, now = Date.now()): Limits {
	const out: Limits = { provider: "claude", status: "ok", windows: [], updatedAt: now, note: "" };
	const toWindow = (raw: unknown, minutes: number): LimitWindow | undefined => {
		const r = raw as { utilization?: unknown; resets_at?: unknown } | null;
		const used = num(r?.utilization);
		if (used === undefined) return undefined;
		const resets = typeof r?.resets_at === "string" ? Date.parse(r.resets_at) : 0;
		return { label: windowName(minutes), usedPercent: clampPct(used), resetsAt: Number.isNaN(resets) ? 0 : resets, windowMinutes: minutes };
	};
	const body = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
	const five = toWindow(body.five_hour, FIVE_HOURS);
	if (five) out.windows.push(five);
	let week: LimitWindow | undefined;
	for (const [key, raw] of Object.entries(body)) {
		if (!key.startsWith("seven_day")) continue;
		const w = toWindow(raw, WEEK);
		if (w && (!week || w.usedPercent > week.usedPercent)) week = w;
	}
	if (week) out.windows.push(week);
	if (out.windows.length === 0) return { ...out, status: "none", note: "No usage yet" };
	return out;
}

function parseClaudeCreds(raw: string | null): { accessToken: string; expiresAt: number } | null {
	if (!raw) return null;
	try {
		const json = JSON.parse(raw);
		const oauth = json.claudeAiOauth ?? json;
		if (typeof oauth.accessToken !== "string" || !oauth.accessToken) return null;
		return { accessToken: oauth.accessToken, expiresAt: typeof oauth.expiresAt === "number" ? oauth.expiresAt : 0 };
	} catch {
		return null;
	}
}

async function claudeCredentials(): Promise<{ accessToken: string; expiresAt: number } | null> {
	if (process.platform === "darwin") {
		const fromKeychain = parseClaudeCreds(await run("security", ["find-generic-password", "-s", "Claude Code-credentials", "-a", userInfo().username, "-w"]));
		if (fromKeychain) return fromKeychain;
	}
	try {
		return parseClaudeCreds(readFileSync(join(homedir(), ".claude", ".credentials.json"), "utf8"));
	} catch {
		return null;
	}
}

export async function readClaudeLimits(): Promise<Limits> {
	const creds = await claudeCredentials();
	if (!creds) return empty("claude", "no-auth", "Open Claude Code");
	if (creds.expiresAt && creds.expiresAt <= Date.now()) return empty("claude", "expired", "Open Claude Code");
	const res = await call("https://api.anthropic.com/api/oauth/usage", {
		headers: { Authorization: `Bearer ${creds.accessToken}`, "anthropic-beta": "oauth-2025-04-20", "anthropic-version": "2023-06-01", Accept: "application/json" },
	});
	if (res.status === 401 || res.status === 403) return empty("claude", "expired", "Open Claude Code");
	if (res.status !== 200) throw new Error(`usage endpoint answered ${res.status}`);
	return mapClaudeUsage(JSON.parse(res.body));
}

// ---------------------------------------------------------------------------------------------- Codex

/** One `rate_limits` object (primary / secondary) → windows. Windows that already reset read 0 %. */
export function mapCodexRateLimits(rateLimits: unknown, measuredAt: number, now = Date.now()): LimitWindow[] {
	const rl = (rateLimits && typeof rateLimits === "object" ? rateLimits : {}) as Record<string, unknown>;
	const out: LimitWindow[] = [];
	for (const raw of [rl.primary, rl.secondary]) {
		if (!raw || typeof raw !== "object") continue;
		const o = raw as Record<string, unknown>;
		const used = num(o.used_percent ?? o.usedPercent);
		if (used === undefined) continue;
		const minutes = num(o.window_minutes ?? o.windowMinutes) ?? 0;
		const at = num(o.resets_at ?? o.resetsAt);
		const inSeconds = num(o.resets_in_seconds ?? o.resetsInSeconds);
		let resetsAt = at !== undefined ? (at > 1e12 ? at : at * 1000) : inSeconds !== undefined ? measuredAt + inSeconds * 1000 : 0;
		let usedPercent = clampPct(used);
		if (resetsAt > 0 && resetsAt <= now && minutes > 0) {
			// the window rolled over since Codex last ran: it starts again from zero
			const span = minutes * 60_000;
			resetsAt += (Math.floor((now - resetsAt) / span) + 1) * span;
			usedPercent = 0;
		}
		out.push({ label: windowName(minutes), usedPercent, resetsAt, windowMinutes: minutes });
	}
	return out.sort(byWindow);
}

function codexHome(): string {
	return process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
}

function newestFiles(dir: string, ext: string, limit: number): string[] {
	const found: { file: string; mtime: number }[] = [];
	const walk = (current: string, depth: number) => {
		if (depth > 5) return;
		let entries;
		try {
			entries = readdirSync(current, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = join(current, entry.name);
			if (entry.isDirectory()) walk(full, depth + 1);
			else if (entry.name.endsWith(ext)) {
				try {
					found.push({ file: full, mtime: statSync(full).mtimeMs });
				} catch {}
			}
		}
	};
	walk(dir, 0);
	return found
		.sort((a, b) => b.mtime - a.mtime)
		.slice(0, limit)
		.map((f) => f.file);
}

/** The last `rate_limits` in a Codex session log (one JSON event per line). */
export function codexFromSessionLog(text: string, now = Date.now()): Limits | null {
	let best: Limits | null = null;
	for (const line of text.split("\n")) {
		if (!line.includes('"rate_limits"')) continue;
		let event: Record<string, unknown>;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		const payload = (event.payload ?? event) as Record<string, unknown>;
		const rl = payload.rate_limits ?? (payload.info as Record<string, unknown> | undefined)?.rate_limits;
		if (!rl) continue;
		const at = typeof event.timestamp === "string" ? Date.parse(event.timestamp) : 0;
		const measured = Number.isNaN(at) ? 0 : at;
		const windows = mapCodexRateLimits(rl, measured || now, now);
		if (windows.length > 0) best = { provider: "codex", status: "ok", windows, updatedAt: measured, note: "" };
	}
	return best;
}

/** Codex also logs `codex.rate_limits` events into logs_2.sqlite; scan its tail as text. */
function codexFromSqlite(file: string, now: number): Limits | null {
	let buf: Buffer;
	let mtime = 0;
	try {
		const st = statSync(file);
		if (!st.isFile() || st.size === 0) return null;
		mtime = st.mtimeMs;
		const size = Math.min(st.size, 4 * 1024 * 1024);
		buf = Buffer.alloc(size);
		const fd = openSync(file, "r");
		try {
			readSync(fd, buf, 0, size, st.size - size);
		} finally {
			closeSync(fd);
		}
	} catch {
		return null;
	}
	const text = buf.toString("latin1");
	const marker = '"type":"codex.rate_limits"';
	let best: Limits | null = null;
	for (let i = text.indexOf(marker); i >= 0; i = text.indexOf(marker, i + marker.length)) {
		let start = i - 1;
		while (start >= 0 && /\s/.test(text[start])) start--;
		if (text[start] !== "{") continue;
		const json = balancedJson(buf.subarray(start, start + 8192).toString("utf8"));
		if (!json) continue;
		try {
			const event = JSON.parse(json);
			const rl = event.rate_limits ?? event.rateLimits;
			if (!rl) continue;
			const measured = measuredFromResets(rl) || mtime;
			const windows = mapCodexRateLimits(rl, measured, now);
			if (windows.length > 0 && measured >= (best?.updatedAt ?? 0)) best = { provider: "codex", status: "ok", windows, updatedAt: measured, note: "" };
		} catch {}
	}
	return best;
}

/** resets_at − resets_in_seconds = the moment the snapshot was taken. */
function measuredFromResets(rl: Record<string, unknown>): number {
	let best = 0;
	for (const raw of [rl.primary, rl.secondary]) {
		const o = (raw ?? {}) as Record<string, unknown>;
		const at = num(o.resets_at ?? o.resetsAt);
		const inSeconds = num(o.resets_in_seconds ?? o.resetsInSeconds);
		if (at === undefined || inSeconds === undefined) continue;
		best = Math.max(best, (at > 1e12 ? at : at * 1000) - inSeconds * 1000);
	}
	return best;
}

function balancedJson(text: string): string | null {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (escaped) escaped = false;
		else if (inString) {
			if (c === "\\") escaped = true;
			else if (c === '"') inString = false;
		} else if (c === '"') inString = true;
		else if (c === "{") depth++;
		else if (c === "}" && --depth === 0) return text.slice(0, i + 1);
	}
	return null;
}

export async function readCodexLimits(home = codexHome(), now = Date.now()): Promise<Limits> {
	const candidates: (Limits | null)[] = [];
	for (const file of newestFiles(join(home, "sessions"), ".jsonl", 8)) {
		try {
			candidates.push(codexFromSessionLog(readFileSync(file, "utf8"), now));
		} catch {}
	}
	for (const file of ["sqlite/logs_2.sqlite-wal", "sqlite/logs_2.sqlite", "logs_2.sqlite-wal", "logs_2.sqlite"]) candidates.push(codexFromSqlite(join(home, file), now));
	const best = candidates.filter((c): c is Limits => !!c).sort((a, b) => b.updatedAt - a.updatedAt)[0];
	return best ?? empty("codex", "none", "Run Codex once");
}

// ---------------------------------------------------------------------------------------------- Antigravity

type ModelQuota = { label: string; model: string; remainingFraction: unknown; resetTime: unknown };

/** "Claude Opus 5.5 (High)" → "Opus 5.5": the tiers of one model share its quota on the key. */
export function modelFamily(label: string): string {
	return label.replace(/\s*\([^)]*\)\s*$/, "").replace(/^Claude\s+/i, "").trim() || label;
}

/** Model quotas → one window per model family (its most used tier), most used first. Gemini 2.x is left out. */
export function mapAntigravityModels(models: ModelQuota[], now = Date.now()): Limits {
	const families = new Map<string, LimitWindow>();
	for (const m of models) {
		const label = (m.label || m.model || "").trim();
		if (!label) continue;
		if (/^gemini-[12](\.|-|$)/i.test(m.model) || /gemini 2\.\d/i.test(label)) continue;
		const fraction = num(m.remainingFraction);
		if (fraction === undefined) continue;
		const resets = typeof m.resetTime === "string" ? Date.parse(m.resetTime) : 0;
		const w: LimitWindow = { label: modelFamily(label), usedPercent: clampPct(100 - fraction * 100), resetsAt: Number.isNaN(resets) ? 0 : resets, windowMinutes: 0 };
		const before = families.get(w.label);
		if (!before || w.usedPercent > before.usedPercent) families.set(w.label, w);
	}
	const windows = [...families.values()].sort((a, b) => b.usedPercent - a.usedPercent || a.label.localeCompare(b.label));
	if (windows.length === 0) return { provider: "antigravity", status: "none", windows, updatedAt: now, note: "No model quota" };
	return { provider: "antigravity", status: "ok", windows, updatedAt: now, note: "" };
}

const LS = "/exa.language_server_pb.LanguageServerService";
let agyEndpoint: { base: string; csrf?: string } | null = null;

function connectCall(base: string, path: string, body: unknown, csrf: string | undefined, timeout: number): Promise<Reply> {
	const headers: Record<string, string> = { Accept: "application/json", "Content-Type": "application/json", "Connect-Protocol-Version": "1" };
	if (csrf) headers["X-Codeium-Csrf-Token"] = csrf;
	return call(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body), insecure: true, timeout });
}

function argOf(cmd: string, name: string): string | undefined {
	const m = cmd.match(new RegExp(`${name}[=\\s]+("[^"]*"|'[^']*'|[^\\s"']+)`, "i"));
	return m ? m[1].replace(/^["']|["']$/g, "") : undefined;
}

async function agyProcesses(): Promise<{ pid: number; csrf?: string; port?: number }[]> {
	let lines: string[] = [];
	if (process.platform === "win32") {
		const script = `Get-CimInstance Win32_Process -Filter "CommandLine LIKE '%antigravity%'" | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }`;
		lines = ((await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], 8000)) ?? "").split(/\r?\n/);
	} else {
		lines = ((await run("ps", ["-axww", "-o", "pid=,command="])) ?? "").split("\n");
	}
	const out: { pid: number; csrf?: string; port?: number }[] = [];
	for (const line of lines) {
		const lower = line.toLowerCase();
		if (!lower.includes("antigravity") || !(lower.includes("language_server") || lower.includes("--csrf_token") || lower.includes("--extension_server_port"))) continue;
		const m = line.trim().match(/^(\d+)\s+(.*)$/);
		if (!m) continue;
		const port = Number(argOf(m[2], "--extension_server_port"));
		out.push({ pid: Number(m[1]), csrf: argOf(m[2], "--csrf_token"), port: Number.isFinite(port) && port > 0 ? port : undefined });
	}
	return out.sort((a, b) => Number(!!b.csrf) - Number(!!a.csrf));
}

async function listeningPorts(pid: number): Promise<number[]> {
	const ports = new Set<number>();
	if (process.platform === "win32") {
		for (const line of ((await run("netstat", ["-ano"])) ?? "").split(/\r?\n/)) {
			const parts = line.trim().split(/\s+/);
			if (!line.includes("LISTENING") || Number(parts[parts.length - 1]) !== pid) continue;
			const m = parts[1]?.match(/:(\d+)$/);
			if (m) ports.add(Number(m[1]));
		}
	} else {
		for (const line of ((await run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", String(pid)])) ?? "").split("\n")) {
			const m = line.match(/:(\d+)\s+\(LISTEN\)/);
			if (m) ports.add(Number(m[1]));
		}
	}
	return [...ports];
}

async function probe(port: number, csrf?: string): Promise<{ base: string; csrf?: string } | null> {
	for (const scheme of ["https", "http"]) {
		const base = `${scheme}://127.0.0.1:${port}`;
		const res = await connectCall(base, `${LS}/GetUnleashData`, { wrapper_data: {} }, csrf, 800).catch(() => null);
		if (res && (res.status === 200 || res.status === 401) && !(scheme === "http" && res.body.toLowerCase().includes("https server"))) return { base, csrf };
	}
	return null;
}

async function agyUserStatus(endpoint: { base: string; csrf?: string }): Promise<Limits> {
	const res = await connectCall(endpoint.base, `${LS}/GetUserStatus`, { metadata: { ideName: "antigravity", extensionName: "antigravity", locale: "en" } }, endpoint.csrf, 6000);
	if (res.status < 200 || res.status >= 300) throw new Error(`GetUserStatus ${res.status}`);
	const json = JSON.parse(res.body);
	const configs = (json?.userStatus ?? json)?.cascadeModelConfigData?.clientModelConfigs;
	const models: ModelQuota[] = (Array.isArray(configs) ? configs : []).map((c: Record<string, any>) => ({
		label: c?.label ?? "",
		model: c?.modelOrAlias?.model ?? c?.modelOrAlias?.alias ?? "",
		remainingFraction: c?.quotaInfo?.remainingFraction,
		resetTime: c?.quotaInfo?.resetTime,
	}));
	return mapAntigravityModels(models);
}

async function agyLocal(): Promise<Limits | null> {
	if (agyEndpoint) {
		try {
			return await agyUserStatus(agyEndpoint);
		} catch {
			agyEndpoint = null;
		}
	}
	for (const proc of (await agyProcesses()).slice(0, 8)) {
		const ports = await listeningPorts(proc.pid);
		if (proc.port && !ports.includes(proc.port)) ports.push(proc.port);
		const found = (await Promise.all(ports.map((p) => probe(p, proc.csrf)))).find((e) => e) ?? null;
		if (!found) continue;
		try {
			const limits = await agyUserStatus(found);
			agyEndpoint = found;
			return limits;
		} catch {}
	}
	return null;
}

let agyToken: { accessToken: string; expiresAt: number } | null = null;

async function agyKeyring(): Promise<string | null> {
	if (process.platform === "darwin") return run("security", ["find-generic-password", "-s", "gemini", "-a", "antigravity", "-w"]);
	if (process.platform === "linux") return run("secret-tool", ["lookup", "service", "gemini", "username", "antigravity"]);
	return null; // Windows: the local language server is the source
}

async function agyAccessToken(): Promise<string | null> {
	if (agyToken && Date.now() < agyToken.expiresAt - 60_000) return agyToken.accessToken;
	let raw = (await agyKeyring())?.trim();
	if (!raw) return null;
	if (raw.startsWith("go-keyring-base64:")) raw = Buffer.from(raw.slice("go-keyring-base64:".length), "base64").toString("utf8");
	let token: Record<string, unknown>;
	try {
		token = JSON.parse(raw).token ?? {};
	} catch {
		return null;
	}
	const expiry = typeof token.expiry === "string" ? Date.parse(token.expiry) : 0;
	if (typeof token.access_token === "string" && expiry && Date.now() < expiry - 60_000) {
		agyToken = { accessToken: token.access_token, expiresAt: expiry };
		return token.access_token;
	}
	// an expired token is left for agy itself to renew: the plugin never handles refresh tokens
	return null;
}

async function agyCloud(): Promise<Limits | null> {
	const token = await agyAccessToken();
	if (!token) return null;
	const post = (path: string, body: unknown) =>
		call(`https://cloudcode-pa.googleapis.com${path}`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": "antigravity" },
			body: JSON.stringify(body),
		});
	const load = await post("/v1internal:loadCodeAssist", { metadata: { ideType: "ANTIGRAVITY", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" } });
	if (load.status === 401 || load.status === 403) return empty("antigravity", "expired", "Run agy login");
	let project = "";
	try {
		const p = JSON.parse(load.body).cloudaicompanionProject;
		project = typeof p === "string" ? p : (p?.id ?? "");
	} catch {}
	const res = await post("/v1internal:fetchAvailableModels", project ? { project } : {});
	if (res.status !== 200) return null;
	const models = JSON.parse(res.body)?.models ?? {};
	return mapAntigravityModels(
		Object.entries(models as Record<string, Record<string, any>>)
			// only the models the app offers carry a "(…)" tier suffix in their label
			.filter(([, m]) => /\([^)]+\)\s*$/.test(m?.label ?? m?.displayName ?? ""))
			.map(([id, m]) => ({ label: m?.label ?? m?.displayName ?? id, model: m?.model ?? id, remainingFraction: m?.quotaInfo?.remainingFraction, resetTime: m?.quotaInfo?.resetTime })),
	);
}

export async function readAntigravityLimits(): Promise<Limits> {
	const local = await agyLocal().catch(() => null);
	if (local?.status === "ok") return local;
	const cloud = await agyCloud().catch(() => null);
	if (cloud && (cloud.status === "ok" || !local)) return cloud;
	return local ?? empty("antigravity", "no-auth", "Open Antigravity");
}

// ---------------------------------------------------------------------------------------------- watcher

const READERS: Record<LimitProvider, () => Promise<Limits>> = { claude: readClaudeLimits, codex: () => readCodexLimits(), antigravity: readAntigravityLimits };
/** How often each source is asked while a limits key is on the deck. */
const EVERY: Record<LimitProvider, number> = { claude: 60_000, codex: 15_000, antigravity: 30_000 };

/** Keeps the limits of the providers that have a key, refreshing each on its own schedule. */
export class LimitsWatcher {
	private readonly data = new Map<LimitProvider, Limits>();
	private readonly busy = new Set<LimitProvider>();
	private readonly lastTry = new Map<LimitProvider, number>();
	private wanted = new Set<LimitProvider>();
	private timer: NodeJS.Timeout | null = null;

	constructor(
		private readonly onChange: () => void,
		private readonly warn: (msg: string) => void = () => {},
		private readonly readers: Record<LimitProvider, () => Promise<Limits>> = READERS,
	) {}

	get(provider: LimitProvider): Limits {
		return this.data.get(provider) ?? empty(provider, "loading", "");
	}

	/** The providers that currently have a key; starts or stops polling. */
	watch(providers: Iterable<LimitProvider>): void {
		const next = new Set(providers);
		for (const p of next) if (!this.wanted.has(p)) void this.refresh(p);
		this.wanted = next;
		if (next.size > 0 && !this.timer) {
			this.timer = setInterval(() => this.tick(), 5000);
			this.timer.unref?.();
		} else if (next.size === 0 && this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	stop(): void {
		this.watch([]);
	}

	private tick(): void {
		const now = Date.now();
		for (const p of this.wanted) {
			// failures retry sooner, but never faster than every 15 s
			const every = this.data.get(p)?.status === "error" ? Math.min(EVERY[p], 15_000) : EVERY[p];
			if (now - (this.lastTry.get(p) ?? 0) >= every) void this.refresh(p);
		}
	}

	async refresh(provider: LimitProvider): Promise<Limits> {
		if (this.busy.has(provider)) return this.get(provider);
		this.busy.add(provider);
		this.lastTry.set(provider, Date.now());
		try {
			this.data.set(provider, await this.readers[provider]());
		} catch (error) {
			this.warn(`${provider} limits: ${(error as Error).message}`);
			const before = this.data.get(provider);
			// keep the last good numbers through a network hiccup
			if (!before || before.status !== "ok") this.data.set(provider, empty(provider, "error", "Can't reach it"));
		} finally {
			this.busy.delete(provider);
		}
		this.onChange();
		return this.get(provider);
	}
}
