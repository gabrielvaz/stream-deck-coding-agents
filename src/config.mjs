import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomToken } from "./util.mjs";

export const DATA_DIR = process.env.AGENT_DECK_HOME || join(homedir(), ".agent-deck");
export const CONFIG_PATH = join(DATA_DIR, "config.json");
export const ADAPTER_API_FILE = join(DATA_DIR, "adapter-api.json");
export const SOCKET_PATH = join(DATA_DIR, "run", "hooks.sock");

export const DEFAULTS = Object.freeze({
  port: 7777,
  host: "0.0.0.0",
  token: "",
  requireToken: true,
  approvalHoldSeconds: 20,
  doneToIdleSeconds: 90,
  idleKeepMinutes: 120,
  offlineKeepSeconds: 600,
  herdr: {
    enabled: true,
    socketPath: null,
    hideAgents: "auto",
    keys: {
      allow: ["enter"],
      deny: ["esc"],
    },
  },
  agents: {},
  installed: [],
});

function deepMerge(base, extra) {
  if (!extra || typeof extra !== "object" || Array.isArray(extra)) return extra === undefined ? base : extra;
  const out = { ...base };
  for (const key of Object.keys(extra)) {
    const value = extra[key];
    if (value && typeof value === "object" && !Array.isArray(value) && base?.[key] && typeof base[key] === "object") {
      out[key] = deepMerge(base[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function loadConfig() {
  let stored = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      stored = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    } catch (error) {
      console.error(`[agent-deck] could not parse ${CONFIG_PATH}: ${error.message}`);
    }
  }
  const config = deepMerge(DEFAULTS, stored);
  if (process.env.AGENT_DECK_PORT) config.port = Number(process.env.AGENT_DECK_PORT);
  if (process.env.AGENT_DECK_HOST) config.host = process.env.AGENT_DECK_HOST;
  if (process.env.AGENT_DECK_TOKEN) config.token = process.env.AGENT_DECK_TOKEN;
  let changed = false;
  if (!config.token) {
    config.token = randomToken();
    changed = true;
  }
  if (changed || !existsSync(CONFIG_PATH)) saveConfig(config);
  return config;
}

export function saveConfig(config) {
  mkdirSync(DATA_DIR, { recursive: true });
  const persisted = { ...config };
  writeFileSync(CONFIG_PATH, `${JSON.stringify(persisted, null, 2)}\n`, { mode: 0o600 });
}

export function updateConfig(mutator) {
  const config = loadConfig();
  mutator(config);
  saveConfig(config);
  return config;
}

/** Fast path used by the hook script: no defaults merging, no writes. */
export function readPortQuick() {
  if (process.env.AGENT_DECK_PORT) return Number(process.env.AGENT_DECK_PORT);
  try {
    const stored = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    if (Number.isInteger(stored.port)) return stored.port;
  } catch {
    // no config yet: use the default port
  }
  return DEFAULTS.port;
}
