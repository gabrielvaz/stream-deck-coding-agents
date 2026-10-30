import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { updateConfig } from "./config.mjs";

const HOOK_SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "hooks", "agent-deck-hook.mjs");
const MARK = "agent-deck-hook";

export const SUPPORTED = ["claude", "codex", "gemini", "antigravity"];

function nodeCommand(agent, event) {
  const node = process.env.AGENT_DECK_NODE || "node";
  const quoted = HOOK_SCRIPT.includes(" ") ? `"${HOOK_SCRIPT}"` : HOOK_SCRIPT;
  return event ? `${node} ${quoted} ${agent} ${event}` : `${node} ${quoted} ${agent}`;
}

function readJson(path) {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf8");
  if (!text.trim()) return {};
  return JSON.parse(text);
}

function writeJsonWithBackup(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) copyFileSync(path, `${path}.agent-deck-bak`);
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

function isOurs(entry) {
  const command = entry?.command ?? "";
  const url = entry?.url ?? "";
  return command.includes(MARK) || url.includes("/api/v1/hook/");
}

/** Removes previous Agent Deck entries from a Claude/Codex/Gemini style `hooks` map. */
function stripOurs(hooksMap) {
  const out = {};
  for (const event of Object.keys(hooksMap ?? {})) {
    const groups = Array.isArray(hooksMap[event]) ? hooksMap[event] : [];
    const kept = groups
      .map((group) => ({ ...group, hooks: (group.hooks ?? []).filter((h) => !isOurs(h)) }))
      .filter((group) => group.hooks.length > 0);
    if (kept.length > 0) out[event] = kept;
  }
  return out;
}

// ------------------------------------------------------------------------------------------------
// Claude Code — ~/.claude/settings.json (or <project>/.claude/settings.json)
// ------------------------------------------------------------------------------------------------
const CLAUDE_ASYNC_EVENTS = [
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Notification",
  "SubagentStart",
  "SubagentStop",
  "Stop",
  "StopFailure",
  "PreCompact",
  "PostCompact",
];

export function claudeSettingsPath(project) {
  return project ? join(resolve(project), ".claude", "settings.json") : join(homedir(), ".claude", "settings.json");
}

export function installClaude({ project, port, liveText = true } = {}) {
  const path = claudeSettingsPath(project);
  const settings = readJson(path);
  const hooks = stripOurs(settings.hooks);
  const add = (event, hook) => {
    hooks[event] = hooks[event] ?? [];
    hooks[event].push({ hooks: [hook] });
  };
  add("SessionStart", { type: "command", command: nodeCommand("claude"), timeout: 5, async: true });
  add("SessionEnd", { type: "command", command: nodeCommand("claude"), timeout: 5 });
  add("PermissionRequest", { type: "command", command: nodeCommand("claude"), timeout: 120 });
  for (const event of CLAUDE_ASYNC_EVENTS)
    add(event, { type: "command", command: nodeCommand("claude"), timeout: 10, async: true });
  if (liveText) {
    // MessageDisplay fires per streamed chunk: the http hook avoids spawning a process each time.
    add("MessageDisplay", { type: "http", url: `http://127.0.0.1:${port}/api/v1/hook/claude`, timeout: 2 });
  }
  settings.hooks = hooks;
  writeJsonWithBackup(path, settings);
  return path;
}

export function uninstallClaude({ project } = {}) {
  const path = claudeSettingsPath(project);
  if (!existsSync(path)) return path;
  const settings = readJson(path);
  settings.hooks = stripOurs(settings.hooks);
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  writeJsonWithBackup(path, settings);
  return path;
}

// ------------------------------------------------------------------------------------------------
// Codex — ~/.codex/hooks.json (or <project>/.codex/hooks.json)
// ------------------------------------------------------------------------------------------------
const CODEX_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PreCompact",
  "PostCompact",
  "SubagentStart",
  "SubagentStop",
  "Stop",
  "Interrupt",
  "SessionEnd",
];

export function codexHooksPath(project) {
  return project ? join(resolve(project), ".codex", "hooks.json") : join(homedir(), ".codex", "hooks.json");
}

export function installCodex({ project } = {}) {
  const path = codexHooksPath(project);
  const file = readJson(path);
  const hooks = stripOurs(file.hooks);
  for (const event of CODEX_EVENTS) {
    hooks[event] = hooks[event] ?? [];
    hooks[event].push({
      hooks: [{ type: "command", command: nodeCommand("codex"), timeout: event === "PermissionRequest" ? 120 : 10 }],
    });
  }
  file.hooks = hooks;
  writeJsonWithBackup(path, file);
  return path;
}

export function uninstallCodex({ project } = {}) {
  const path = codexHooksPath(project);
  if (!existsSync(path)) return path;
  const file = readJson(path);
  file.hooks = stripOurs(file.hooks);
  writeJsonWithBackup(path, file);
  return path;
}

// ------------------------------------------------------------------------------------------------
// Gemini CLI — ~/.gemini/settings.json (or <project>/.gemini/settings.json)
// ------------------------------------------------------------------------------------------------
const GEMINI_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "BeforeAgent",
  "AfterAgent",
  "BeforeTool",
  "AfterTool",
  "Notification",
  "PreCompress",
];

export function geminiSettingsPath(project) {
  return project ? join(resolve(project), ".gemini", "settings.json") : join(homedir(), ".gemini", "settings.json");
}

export function installGemini({ project } = {}) {
  const path = geminiSettingsPath(project);
  const settings = readJson(path);
  const hooks = stripOurs(settings.hooks);
  for (const event of GEMINI_EVENTS) {
    hooks[event] = hooks[event] ?? [];
    hooks[event].push({
      matcher: "*",
      hooks: [{ name: `agent-deck-${event}`, type: "command", command: nodeCommand("gemini"), timeout: 8000 }],
    });
  }
  settings.hooks = hooks;
  settings.tools = { ...(settings.tools ?? {}), enableHooks: true };
  writeJsonWithBackup(path, settings);
  return path;
}

export function uninstallGemini({ project } = {}) {
  const path = geminiSettingsPath(project);
  if (!existsSync(path)) return path;
  const settings = readJson(path);
  settings.hooks = stripOurs(settings.hooks);
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  writeJsonWithBackup(path, settings);
  return path;
}

// ------------------------------------------------------------------------------------------------
// Antigravity CLI (agy) — ~/.gemini/config/hooks.json (or <project>/.agents/hooks.json)
// Top level maps a hook name → event config. The stdin JSON has no event name, so we pass it as arg.
// ------------------------------------------------------------------------------------------------
export function antigravityHooksPath(project) {
  return project ? join(resolve(project), ".agents", "hooks.json") : join(homedir(), ".gemini", "config", "hooks.json");
}

export function installAntigravity({ project } = {}) {
  const path = antigravityHooksPath(project);
  const file = readJson(path);
  const entry = {
    SessionStart: [{ type: "command", command: nodeCommand("antigravity", "SessionStart"), timeout: 10 }],
    PreInvocation: [{ type: "command", command: nodeCommand("antigravity", "PreInvocation"), timeout: 10 }],
    PostInvocation: [{ type: "command", command: nodeCommand("antigravity", "PostInvocation"), timeout: 10 }],
    PreToolUse: [
      { matcher: "", hooks: [{ type: "command", command: nodeCommand("antigravity", "PreToolUse"), timeout: 10 }] },
    ],
    PostToolUse: [
      { matcher: "", hooks: [{ type: "command", command: nodeCommand("antigravity", "PostToolUse"), timeout: 10 }] },
    ],
    Stop: [{ type: "command", command: nodeCommand("antigravity", "Stop"), timeout: 10 }],
  };
  file["agent-deck"] = entry;
  writeJsonWithBackup(path, file);
  return path;
}

export function uninstallAntigravity({ project } = {}) {
  const path = antigravityHooksPath(project);
  if (!existsSync(path)) return path;
  const file = readJson(path);
  delete file["agent-deck"];
  writeJsonWithBackup(path, file);
  return path;
}

// ------------------------------------------------------------------------------------------------

const INSTALLERS = {
  claude: { install: installClaude, uninstall: uninstallClaude, path: claudeSettingsPath },
  codex: { install: installCodex, uninstall: uninstallCodex, path: codexHooksPath },
  gemini: { install: installGemini, uninstall: uninstallGemini, path: geminiSettingsPath },
  antigravity: { install: installAntigravity, uninstall: uninstallAntigravity, path: antigravityHooksPath },
};

export function installAgents(agents, options) {
  const results = [];
  for (const agent of agents) {
    const installer = INSTALLERS[agent];
    if (!installer) throw new Error(`unknown agent "${agent}" (expected ${SUPPORTED.join(", ")})`);
    results.push({ agent, path: installer.install(options) });
  }
  if (!options.project) {
    updateConfig((config) => {
      config.installed = [...new Set([...(config.installed ?? []), ...agents])];
    });
  }
  return results;
}

export function uninstallAgents(agents, options) {
  const results = [];
  for (const agent of agents) {
    const installer = INSTALLERS[agent];
    if (!installer) throw new Error(`unknown agent "${agent}"`);
    results.push({ agent, path: installer.uninstall(options) });
  }
  if (!options.project) {
    updateConfig((config) => {
      config.installed = (config.installed ?? []).filter((id) => !agents.includes(id));
    });
  }
  return results;
}

export function hookStatus() {
  return SUPPORTED.map((agent) => {
    const path = INSTALLERS[agent].path();
    let installed = false;
    try {
      const text = existsSync(path) ? readFileSync(path, "utf8") : "";
      installed = text.includes(MARK) || text.includes("/api/v1/hook/");
    } catch {
      installed = false;
    }
    return { agent, path, installed };
  });
}

export { HOOK_SCRIPT };
