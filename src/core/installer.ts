/**
 * Connects the agents to the plugin by adding hook entries to their config files.
 *
 * Everything we add is marked with the folder name `.coding-agents-deck`, so it can be found,
 * updated and removed without touching anything else. Every write keeps a backup next to the
 * file (`<file>.coding-agents-deck.bak`).
 *
 * The hook runs `hook.mjs` with the Node.js runtime Stream Deck ships with (process.execPath), so
 * users do not need Node.js installed. Shell-based CLIs (Codex, Antigravity, Gemini) call a small
 * launcher (`hook` / `hook.cmd`) whose path never changes: Codex asks the user to trust each hook
 * command once, and a stable command keeps that trust across Stream Deck and plugin updates.
 *
 * On Windows, agents running inside WSL are supported too: their config files are reached through
 * \\wsl.localhost, and a launcher inside the distro calls Stream Deck's node.exe through interop.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { HOOK_AGENTS, type HookAgentId } from "./agents";

export const MARK = ".coding-agents-deck";
const IS_WIN = process.platform === "win32";

export type Runtime = {
	/** ~/.coding-agents-deck */
	home: string;
	/** Node.js binary used to run the hook (Stream Deck's own runtime). */
	node: string;
	/** hook.mjs inside `home`. */
	script: string;
	/** Launcher for shell-based CLIs. */
	launcher: string;
};

/** A WSL distribution seen from Windows. */
export type WslDistro = {
	name: string;
	/** $HOME inside the distro, e.g. /home/joao */
	home: string;
	/** The same folder from Windows, e.g. \\wsl.localhost\Ubuntu\home\joao */
	unc: string;
	/** Stream Deck's node.exe as seen from inside the distro, e.g. /mnt/c/Program Files/…/node.exe */
	node: string;
};

/** Where an agent lives: on this computer, or inside a WSL distro. */
export type Target = { key: string; agent: HookAgentId; wsl?: WslDistro };

export type AgentStatus = {
	key: string;
	agent: HookAgentId;
	where: string;
	detected: boolean;
	installed: boolean;
	upToDate: boolean;
	path: string;
	note: string;
};

export function deckHome(): string {
	return process.env.CODING_AGENTS_DECK_HOME || join(homedir(), MARK);
}

export function runtimeFor(node = process.execPath, home = deckHome()): Runtime {
	return { home, node, script: join(home, "hook.mjs"), launcher: join(home, IS_WIN ? "hook.cmd" : "hook") };
}

export function nativeTargets(): Target[] {
	return HOOK_AGENTS.map((agent) => ({ key: agent, agent }));
}

export function wslTargets(distros: WslDistro[]): Target[] {
	return distros.flatMap((wsl) => HOOK_AGENTS.map((agent) => ({ key: `${agent}@wsl:${wsl.name}`, agent, wsl })));
}

// ------------------------------------------------------------------------------------------------ runtime files

/**
 * Copies the hook client next to the user's configs and (re)writes the launcher and the endpoint
 * file. Called at every plugin start, so a new Stream Deck Node.js path is picked up at once.
 */
export function prepareRuntime(rt: Runtime, hookSource: string, endpoint: { port: number; token: string }): void {
	mkdirSync(rt.home, { recursive: true });
	writeIfChanged(rt.script, readFileSync(hookSource, "utf8"));
	if (IS_WIN) {
		writeIfChanged(rt.launcher, windowsLauncher(rt));
		// keep the %ProgramData% copy (see cmdSafeLauncher) pointing at the current runtime
		if (existsSync(programDataShim())) writeIfChanged(programDataShim(), windowsLauncher(rt));
	} else {
		writeIfChanged(rt.launcher, posixLauncher(rt.node, rt.script));
		chmodSync(rt.launcher, 0o755);
	}
	writeIfChanged(join(rt.home, "endpoint.json"), `${JSON.stringify({ host: "127.0.0.1", port: endpoint.port, token: endpoint.token }, null, 2)}\n`, 0o600);
}

function posixLauncher(node: string, script: string, comment = "runs the hook with Stream Deck's Node.js runtime."): string {
	return [
		"#!/bin/sh",
		`# Coding Agents for Stream Deck: ${comment}`,
		`NODE=${shQuote(node)}`,
		'if [ ! -x "$NODE" ]; then',
		'  case "$1 $2" in',
		"    \"antigravity PreToolUse\") echo '{\"decision\":\"allow\"}' ;;",
		'    "antigravity Title"|claude*) ;;',
		"    *) echo '{}' ;;",
		"  esac",
		"  exit 0",
		"fi",
		`exec "$NODE" ${shQuote(script)} "$@"`,
		"",
	].join("\n");
}

function windowsLauncher(rt: Runtime): string {
	return [
		"@echo off",
		"rem Coding Agents for Stream Deck: runs the hook with Stream Deck's Node.js runtime.",
		`if not exist "${rt.node}" (`,
		'  if /I "%~1 %~2"=="antigravity PreToolUse" echo {"decision":"allow"}',
		'  if /I not "%~1"=="claude" if /I not "%~2"=="Title" echo {}',
		"  exit /b 0",
		")",
		`"${rt.node}" "${rt.script}" %*`,
		"exit /b 0",
		"",
	].join("\r\n");
}

/**
 * Antigravity runs hook commands through `cmd /c`, which cannot take a quoted program path from a
 * Go-escaped command line. When the user folder has spaces, use its 8.3 short name or, if 8.3
 * names are disabled, a copy of the launcher under %ProgramData% (no spaces, writable only by
 * its creator).
 */
export function cmdSafeLauncher(rt: Runtime): string {
	if (!IS_WIN || !/\s/.test(rt.launcher)) return rt.launcher;
	const short = shortWindowsPath(rt.launcher);
	if (short) return short;
	const shim = programDataShim();
	if (/\s/.test(shim)) return `"${rt.launcher}"`;
	writeIfChanged(shim, windowsLauncher(rt));
	return shim;
}

function programDataShim(): string {
	const base = process.env.ProgramData || "C:\\ProgramData";
	const user = (process.env.USERNAME || "user").replace(/[^\w.-]+/g, "_");
	return join(base, "coding-agents-deck", user, "hook.cmd");
}

/** The 8.3 short name of `path`, when the volume still creates them. */
function shortWindowsPath(path: string): string {
	try {
		const short = execFileSync("cmd.exe", ["/d", "/c", `for %A in ("${path}") do @echo %~sA`], { encoding: "utf8", windowsHide: true }).trim();
		if (short && !/\s/.test(short) && short.includes("~")) return short;
	} catch {
		// 8.3 names unavailable
	}
	return "";
}

function writeIfChanged(path: string, content: string, mode?: number): void {
	if (existsSync(path) && readFileSync(path, "utf8") === content) return;
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}`;
	writeFileSync(tmp, content, mode ? { mode } : undefined);
	renameSync(tmp, path);
	if (mode && !path.startsWith("\\\\")) chmodSync(path, mode);
}

// ------------------------------------------------------------------------------------------------ WSL

/** Running WSL distributions with their home folder (Windows only; never boots a stopped distro). */
export function listWslDistros(node: string): WslDistro[] {
	if (!IS_WIN) return [];
	let names: string[] = [];
	try {
		const raw = execFileSync("wsl.exe", ["--list", "--running", "--quiet"], { windowsHide: true, timeout: 5000 });
		names = Buffer.from(raw)
			.toString(raw.includes(0) ? "utf16le" : "utf8")
			.split(/\r?\n/)
			.map((s) => s.replace(/\0/g, "").trim())
			.filter((s) => s && !/^docker-desktop/i.test(s));
	} catch {
		return [];
	}
	const out: WslDistro[] = [];
	for (const name of names) {
		try {
			const home = process.env.CODING_AGENTS_DECK_WSL_HOME || wslExec(name, ["sh", "-c", 'printf %s "$HOME"']);
			const nodeInside = wslExec(name, ["wslpath", "-u", node]);
			if (!home.startsWith("/") || !nodeInside.startsWith("/")) continue;
			out.push({ name, home, unc: `\\\\wsl.localhost\\${name}${home.replace(/\//g, "\\")}`, node: nodeInside });
		} catch {
			// distro without sh/wslpath: skip it
		}
	}
	return out;
}

function wslExec(distro: string, args: string[]): string {
	return execFileSync("wsl.exe", ["-d", distro, "-e", ...args], { encoding: "utf8", windowsHide: true, timeout: 8000 }).trim();
}

/** Writes the launcher inside the distro: it forwards to Stream Deck's node.exe through interop. */
export function prepareWsl(rt: Runtime, wsl: WslDistro): void {
	writeIfChanged(`${wsl.unc}\\${MARK}\\hook`, posixLauncher(wsl.node, rt.script, "forwards the hook to Stream Deck on Windows."));
}

const wslLauncher = (wsl: WslDistro) => `${wsl.home}/${MARK}/hook`;

// ------------------------------------------------------------------------------------------------ quoting

/** POSIX single quotes. */
export function shQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** PowerShell call operator with single quotes. */
export function psCall(path: string): string {
	return `& '${path.replace(/'/g, "''")}'`;
}

/** Launcher command for CLIs that run hooks through PowerShell on Windows and sh/zsh elsewhere. */
function shellCommand(rt: Runtime, t: Target, ...args: string[]): string {
	if (t.wsl) return `sh ${shQuote(wslLauncher(t.wsl))} ${args.join(" ")}`;
	return IS_WIN ? `${psCall(rt.launcher)} ${args.join(" ")}` : `${shQuote(rt.launcher)} ${args.join(" ")}`;
}

/** Launcher command for CLIs that use `cmd /c` on Windows (Antigravity). */
function cmdCommand(rt: Runtime, t: Target, ...args: string[]): string {
	if (t.wsl) return `sh ${shQuote(wslLauncher(t.wsl))} ${args.join(" ")}`;
	return IS_WIN ? `${cmdSafeLauncher(rt)} ${args.join(" ")}` : `${shQuote(rt.launcher)} ${args.join(" ")}`;
}

// ------------------------------------------------------------------------------------------------ JSON files

type Json = Record<string, unknown>;

/** Reads JSON, tolerating comments and trailing commas (Gemini/Antigravity settings allow them). */
export function readJson(path: string): Json {
	if (!existsSync(path)) return {};
	const text = readFileSync(path, "utf8");
	if (!text.trim()) return {};
	try {
		return JSON.parse(text) as Json;
	} catch {
		const stripped = text
			.replace(/("(?:\\.|[^"\\])*")|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (_m, str: string | undefined) => str ?? "")
			.replace(/,(\s*[}\]])/g, "$1");
		try {
			return JSON.parse(stripped) as Json;
		} catch {
			throw new Error(`${path} is not valid JSON; fix it or remove it, then try again`);
		}
	}
}

function writeJson(path: string, data: Json): void {
	mkdirSync(dirname(path), { recursive: true });
	if (existsSync(path)) copyFileSync(path, `${path}.coding-agents-deck.bak`);
	const tmp = `${path}.tmp-${process.pid}`;
	writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
	renameSync(tmp, path);
}

const isOurs = (entry: unknown): boolean => JSON.stringify(entry ?? "").includes(MARK);

type HookGroup = { matcher?: string; hooks?: unknown[] } & Json;

/** Drops our handlers from a Claude/Codex/Gemini style `hooks` map, keeping everything else. */
function stripOurs(map: unknown): Record<string, HookGroup[]> {
	const out: Record<string, HookGroup[]> = {};
	if (!map || typeof map !== "object") return out;
	for (const [event, groups] of Object.entries(map as Json)) {
		if (!Array.isArray(groups)) continue;
		const kept = (groups as HookGroup[])
			.map((group) => (Array.isArray(group?.hooks) ? { ...group, hooks: group.hooks.filter((h) => !isOurs(h)) } : group))
			.filter((group) => !Array.isArray(group?.hooks) || group.hooks.length > 0)
			.filter((group) => !isOurs(group));
		if (kept.length > 0) out[event] = kept;
	}
	return out;
}

function addGroup(map: Record<string, HookGroup[]>, event: string, hook: Json, matcher?: string): void {
	map[event] = map[event] ?? [];
	map[event].push(matcher === undefined ? { hooks: [hook] } : { matcher, hooks: [hook] });
}

// ------------------------------------------------------------------------------------------------ paths

const homeOf = (t: Target) => t.wsl?.unc ?? homedir();
const sub = (t: Target, ...parts: string[]) => (t.wsl ? [t.wsl.unc, ...parts].join("\\") : join(homedir(), ...parts));

export function claudeSettingsPath(t: Target = { key: "claude", agent: "claude" }): string {
	if (!t.wsl && process.env.CLAUDE_CONFIG_DIR) return join(process.env.CLAUDE_CONFIG_DIR, "settings.json");
	return sub(t, ".claude", "settings.json");
}

export function codexHooksPath(t: Target = { key: "codex", agent: "codex" }): string {
	if (!t.wsl && process.env.CODEX_HOME) return join(process.env.CODEX_HOME, "hooks.json");
	return sub(t, ".codex", "hooks.json");
}

export const antigravityHooksPath = (t: Target = { key: "antigravity", agent: "antigravity" }) => sub(t, ".gemini", "config", "hooks.json");
export const antigravitySettingsPath = (t: Target = { key: "antigravity", agent: "antigravity" }) => sub(t, ".gemini", "antigravity-cli", "settings.json");

export function geminiSettingsPath(t: Target = { key: "gemini", agent: "gemini" }): string {
	if (!t.wsl && process.env.GEMINI_CLI_HOME) return join(process.env.GEMINI_CLI_HOME, ".gemini", "settings.json");
	return sub(t, ".gemini", "settings.json");
}

const CONFIG_PATH: Record<HookAgentId, (t: Target) => string> = {
	claude: claudeSettingsPath,
	codex: codexHooksPath,
	antigravity: antigravityHooksPath,
	gemini: geminiSettingsPath,
};

/** Folders whose presence tells us the CLI has been used there. */
function detected(t: Target): boolean {
	const home = homeOf(t);
	const at = (...parts: string[]) => existsSync(t.wsl ? [home, ...parts].join("\\") : join(home, ...parts));
	switch (t.agent) {
		case "claude":
			return existsSync(dirname(claudeSettingsPath(t))) || at(".claude.json");
		case "codex":
			return existsSync(dirname(codexHooksPath(t)));
		case "antigravity":
			return existsSync(dirname(antigravitySettingsPath(t))) || at(".gemini", "antigravity");
		case "gemini":
			return existsSync(geminiSettingsPath(t)) || at(".gemini", "tmp");
	}
}

// ------------------------------------------------------------------------------------------------ Claude Code

const CLAUDE_EVENTS = [
	"SessionStart",
	"UserPromptSubmit",
	"PreToolUse",
	"PostToolUse",
	"PostToolUseFailure",
	"Notification",
	"MessageDisplay",
	"SubagentStart",
	"SubagentStop",
	"Stop",
	"StopFailure",
	"PreCompact",
	"PostCompact",
	"SessionEnd",
];

/** Exec form (no shell), so paths with spaces need no quoting on any OS. */
function claudeHook(rt: Runtime, t: Target, sync: boolean, timeout: number): Json {
	const exec = t.wsl ? { command: "/bin/sh", args: [wslLauncher(t.wsl), "claude"] } : { command: rt.node, args: [rt.script, "claude"] };
	return sync ? { type: "command", ...exec, timeout } : { type: "command", ...exec, async: true, timeout };
}

function installClaude(rt: Runtime, t: Target, opts: InstallOptions): string {
	const path = claudeSettingsPath(t);
	const settings = readJson(path);
	const hooks = stripOurs(settings.hooks);
	for (const event of CLAUDE_EVENTS) {
		if (event === "MessageDisplay" && !opts.liveText) continue;
		addGroup(hooks, event, claudeHook(rt, t, false, 10));
	}
	addGroup(hooks, "PermissionRequest", claudeHook(rt, t, true, opts.approvalTimeout));
	settings.hooks = hooks;
	writeJson(path, settings);
	return path;
}

// ------------------------------------------------------------------------------------------------ Codex

const CODEX_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PreCompact", "PostCompact", "SubagentStart", "SubagentStop", "Stop", "Interrupt", "SessionEnd"];

function installCodex(rt: Runtime, t: Target, opts: InstallOptions): string {
	const path = codexHooksPath(t);
	const file = readJson(path);
	const hooks = stripOurs(file.hooks);
	const command = shellCommand(rt, t, "codex");
	for (const event of CODEX_EVENTS) {
		const short = event === "SessionEnd" || event === "Interrupt";
		addGroup(hooks, event, { type: "command", command, async: true, timeout: short ? 3 : 10 });
	}
	addGroup(hooks, "PermissionRequest", { type: "command", command, timeout: opts.approvalTimeout });
	file.hooks = hooks;
	writeJson(path, file);
	return path;
}

// ------------------------------------------------------------------------------------------------ Antigravity CLI

const AGY_NAME = "coding-agents-deck";

function installAntigravity(rt: Runtime, t: Target): string {
	const path = antigravityHooksPath(t);
	const file = readJson(path);
	const flat = (event: string) => [{ type: "command", command: cmdCommand(rt, t, "antigravity", event), timeout: 10 }];
	const tool = (event: string) => [{ matcher: "*", hooks: [{ type: "command", command: cmdCommand(rt, t, "antigravity", event), timeout: 10 }] }];
	file[AGY_NAME] = {
		SessionStart: flat("SessionStart"),
		PreInvocation: flat("PreInvocation"),
		PostInvocation: flat("PostInvocation"),
		PreToolUse: tool("PreToolUse"),
		PostToolUse: tool("PostToolUse"),
		Stop: flat("Stop"),
	};
	writeJson(path, file);

	// the terminal-title command is the only place agy reports a pending tool confirmation
	const settingsPath = antigravitySettingsPath(t);
	const settings = readJson(settingsPath);
	const title = settings.title as Json | undefined;
	if (!title || isOurs(title)) {
		settings.title = { type: "command", command: cmdCommand(rt, t, "antigravity", "Title") };
		writeJson(settingsPath, settings);
	}
	return path;
}

function uninstallAntigravity(t: Target): string {
	const path = antigravityHooksPath(t);
	if (existsSync(path)) {
		const file = readJson(path);
		if (AGY_NAME in file) {
			delete file[AGY_NAME];
			writeJson(path, file);
		}
	}
	const settingsPath = antigravitySettingsPath(t);
	if (existsSync(settingsPath)) {
		const settings = readJson(settingsPath);
		if (isOurs(settings.title)) {
			delete settings.title;
			writeJson(settingsPath, settings);
		}
	}
	return path;
}

// ------------------------------------------------------------------------------------------------ Gemini CLI

const GEMINI_EVENTS = ["SessionStart", "SessionEnd", "BeforeAgent", "AfterAgent", "BeforeTool", "AfterTool", "Notification", "PreCompress"];

function installGemini(rt: Runtime, t: Target): string {
	const path = geminiSettingsPath(t);
	const settings = readJson(path);
	const hooks = stripOurs(settings.hooks);
	const command = shellCommand(rt, t, "gemini");
	for (const event of GEMINI_EVENTS) {
		const matcher = event === "BeforeTool" || event === "AfterTool" ? ".*" : undefined;
		addGroup(hooks, event, { name: "coding-agents-deck", type: "command", command, timeout: 5000 }, matcher);
	}
	settings.hooks = hooks;
	writeJson(path, settings);
	return path;
}

// ------------------------------------------------------------------------------------------------ public API

export type InstallOptions = { liveText: boolean; approvalTimeout: number };

export function install(t: Target, rt: Runtime, opts: InstallOptions): string {
	if (t.wsl) prepareWsl(rt, t.wsl);
	switch (t.agent) {
		case "claude":
			return installClaude(rt, t, opts);
		case "codex":
			return installCodex(rt, t, opts);
		case "antigravity":
			return installAntigravity(rt, t);
		case "gemini":
			return installGemini(rt, t);
	}
}

export function uninstall(t: Target): string {
	if (t.agent === "antigravity") return uninstallAntigravity(t);
	const path = CONFIG_PATH[t.agent](t);
	if (!existsSync(path)) return path;
	const data = readJson(path);
	if (!isOurs(data.hooks)) return path;
	const hooks = stripOurs(data.hooks);
	if (Object.keys(hooks).length > 0) data.hooks = hooks;
	else delete data.hooks;
	writeJson(path, data);
	return path;
}

export function status(t: Target, rt: Runtime, opts: InstallOptions): AgentStatus {
	const path = CONFIG_PATH[t.agent](t);
	const result: AgentStatus = { key: t.key, agent: t.agent, where: t.wsl ? `WSL · ${t.wsl.name}` : "", detected: false, installed: false, upToDate: false, path, note: "" };
	try {
		result.detected = detected(t);
		const text = existsSync(path) ? readFileSync(path, "utf8") : "";
		result.installed = text.includes(MARK);
	} catch (error) {
		result.note = (error as Error).message;
		return result;
	}
	if (!result.installed) return result;
	if (t.agent === "claude") {
		// natively Claude Code runs Stream Deck's node directly: the entry must name the current runtime
		const entries = JSON.stringify(safeRead(path).hooks ?? {});
		const live = entries.includes("MessageDisplay");
		result.upToDate = (t.wsl ? true : entries.includes(JSON.stringify(rt.node))) && live === opts.liveText;
	} else {
		result.upToDate = true;
	}
	return result;
}

function safeRead(path: string): Json {
	try {
		return readJson(path);
	} catch {
		return {};
	}
}
