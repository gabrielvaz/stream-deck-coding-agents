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
 */
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { HookAgentId } from "./agents";

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

export type AgentStatus = {
	agent: HookAgentId;
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
	return {
		home,
		node,
		script: join(home, "hook.mjs"),
		launcher: join(home, IS_WIN ? "hook.cmd" : "hook"),
	};
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
		writeIfChanged(
			rt.launcher,
			[
				"#!/bin/sh",
				"# Coding Agents for Stream Deck: runs the hook with Stream Deck's Node.js runtime.",
				`NODE=${shQuote(rt.node)}`,
				'if [ ! -x "$NODE" ]; then',
				'  case "$1 $2" in',
				"    \"antigravity PreToolUse\") echo '{\"decision\":\"allow\"}' ;;",
				'    "antigravity Title"|claude*) ;;',
				"    *) echo '{}' ;;",
				"  esac",
				"  exit 0",
				"fi",
				`exec "$NODE" ${shQuote(rt.script)} "$@"`,
				"",
			].join("\n"),
		);
		chmodSync(rt.launcher, 0o755);
	}
	writeIfChanged(join(rt.home, "endpoint.json"), `${JSON.stringify({ host: "127.0.0.1", port: endpoint.port, token: endpoint.token }, null, 2)}\n`, 0o600);
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

function writeIfChanged(path: string, content: string, mode?: number): void {
	if (existsSync(path) && readFileSync(path, "utf8") === content) return;
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}`;
	writeFileSync(tmp, content, mode ? { mode } : undefined);
	renameSync(tmp, path);
	if (mode) chmodSync(path, mode);
}

// ------------------------------------------------------------------------------------------------ quoting

/** POSIX single quotes. */
export function shQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** PowerShell call operator with single quotes. */
export function psCall(path: string): string {
	return `& '${path.replace(/'/g, "''")}'`;
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

/** Launcher command for CLIs that run hooks through PowerShell on Windows and sh/zsh elsewhere. */
function shellCommand(rt: Runtime, ...args: string[]): string {
	return IS_WIN ? `${psCall(rt.launcher)} ${args.join(" ")}` : `${shQuote(rt.launcher)} ${args.join(" ")}`;
}

/** Launcher command for CLIs that use `cmd /c` on Windows (Antigravity). */
function cmdCommand(rt: Runtime, ...args: string[]): string {
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

export const claudeSettingsPath = () => join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "settings.json");

function claudeHook(rt: Runtime, sync = false, timeout = 10): Json {
	// exec form: no shell, so paths with spaces need no quoting on any OS
	return sync
		? { type: "command", command: rt.node, args: [rt.script, "claude"], timeout }
		: { type: "command", command: rt.node, args: [rt.script, "claude"], async: true, timeout };
}

function installClaude(rt: Runtime, opts: InstallOptions): string {
	const path = claudeSettingsPath();
	const settings = readJson(path);
	const hooks = stripOurs(settings.hooks);
	for (const event of CLAUDE_EVENTS) {
		if (event === "MessageDisplay" && !opts.liveText) continue;
		addGroup(hooks, event, claudeHook(rt));
	}
	addGroup(hooks, "PermissionRequest", claudeHook(rt, true, opts.approvalTimeout));
	settings.hooks = hooks;
	writeJson(path, settings);
	return path;
}

// ------------------------------------------------------------------------------------------------ Codex

const CODEX_EVENTS = [
	"SessionStart",
	"UserPromptSubmit",
	"PreToolUse",
	"PostToolUse",
	"PreCompact",
	"PostCompact",
	"SubagentStart",
	"SubagentStop",
	"Stop",
	"Interrupt",
	"SessionEnd",
];

export const codexHooksPath = () => join(process.env.CODEX_HOME || join(homedir(), ".codex"), "hooks.json");

function installCodex(rt: Runtime, opts: InstallOptions): string {
	const path = codexHooksPath();
	const file = readJson(path);
	const hooks = stripOurs(file.hooks);
	const command = shellCommand(rt, "codex");
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

export const antigravityHooksPath = () => join(homedir(), ".gemini", "config", "hooks.json");
export const antigravitySettingsPath = () => join(homedir(), ".gemini", "antigravity-cli", "settings.json");
const AGY_NAME = "coding-agents-deck";

function installAntigravity(rt: Runtime): string {
	const path = antigravityHooksPath();
	const file = readJson(path);
	const flat = (event: string) => [{ type: "command", command: cmdCommand(rt, "antigravity", event), timeout: 10 }];
	const tool = (event: string) => [{ matcher: "*", hooks: [{ type: "command", command: cmdCommand(rt, "antigravity", event), timeout: 10 }] }];
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
	const settingsPath = antigravitySettingsPath();
	const settings = readJson(settingsPath);
	const title = settings.title as Json | undefined;
	if (!title || isOurs(title)) {
		settings.title = { type: "command", command: cmdCommand(rt, "antigravity", "Title") };
		writeJson(settingsPath, settings);
	}
	return path;
}

function uninstallAntigravity(): string {
	const path = antigravityHooksPath();
	if (existsSync(path)) {
		const file = readJson(path);
		if (AGY_NAME in file) {
			delete file[AGY_NAME];
			writeJson(path, file);
		}
	}
	const settingsPath = antigravitySettingsPath();
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

export const geminiSettingsPath = () => join(process.env.GEMINI_CLI_HOME || homedir(), ".gemini", "settings.json");

function installGemini(rt: Runtime): string {
	const path = geminiSettingsPath();
	const settings = readJson(path);
	const hooks = stripOurs(settings.hooks);
	const command = shellCommand(rt, "gemini");
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

const PATHS: Record<HookAgentId, () => string> = {
	claude: claudeSettingsPath,
	codex: codexHooksPath,
	antigravity: antigravityHooksPath,
	gemini: geminiSettingsPath,
};

/** Folders whose presence tells us the CLI has been used on this computer. */
function detected(agent: HookAgentId): boolean {
	switch (agent) {
		case "claude":
			return existsSync(dirname(claudeSettingsPath())) || existsSync(join(homedir(), ".claude.json"));
		case "codex":
			return existsSync(dirname(codexHooksPath()));
		case "antigravity":
			return existsSync(dirname(antigravitySettingsPath())) || existsSync(join(homedir(), ".gemini", "antigravity"));
		case "gemini":
			return existsSync(geminiSettingsPath()) || existsSync(join(homedir(), ".gemini", "tmp"));
	}
}

export function install(agent: HookAgentId, rt: Runtime, opts: InstallOptions): string {
	switch (agent) {
		case "claude":
			return installClaude(rt, opts);
		case "codex":
			return installCodex(rt, opts);
		case "antigravity":
			return installAntigravity(rt);
		case "gemini":
			return installGemini(rt);
	}
}

export function uninstall(agent: HookAgentId): string {
	if (agent === "antigravity") return uninstallAntigravity();
	const path = PATHS[agent]();
	if (!existsSync(path)) return path;
	const data = readJson(path);
	if (!isOurs(data.hooks)) return path;
	const hooks = stripOurs(data.hooks);
	if (Object.keys(hooks).length > 0) data.hooks = hooks;
	else delete data.hooks;
	writeJson(path, data);
	return path;
}

export function status(agent: HookAgentId, rt: Runtime, opts: InstallOptions): AgentStatus {
	const path = PATHS[agent]();
	const result: AgentStatus = { agent, detected: detected(agent), installed: false, upToDate: false, path, note: "" };
	let text = "";
	try {
		text = existsSync(path) ? readFileSync(path, "utf8") : "";
	} catch (error) {
		result.note = (error as Error).message;
		return result;
	}
	result.installed = text.includes(MARK);
	if (!result.installed) return result;
	if (agent === "claude") {
		// Claude Code runs Stream Deck's node directly: the entry must name the current runtime
		const settings = safeRead(path);
		const want = JSON.stringify(rt.node);
		const entries = JSON.stringify(settings.hooks ?? {});
		const live = entries.includes("MessageDisplay");
		result.upToDate = entries.includes(want) && live === opts.liveText;
	} else {
		result.upToDate = text.includes(agent === "antigravity" ? "antigravity" : agent);
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
