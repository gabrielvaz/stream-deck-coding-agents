/**
 * Agent registry: colours, monograms and the names shown on the deck.
 * Working colour = `color`; waiting (approval / question) = `alarm`.
 * Users can override `name`, `color`, `alarm` per agent in ~/.agent-deck/config.json under `agents`.
 */
export const AGENTS = Object.freeze({
  claude: { id: "claude", name: "Claude Code", short: "Claude", mono: "✱", color: "#F3B257", alarm: "#E2714B" },
  codex: { id: "codex", name: "Codex", short: "Codex", mono: "⌬", color: "#5B8DFF", alarm: "#C25BFF" },
  gemini: { id: "gemini", name: "Gemini CLI", short: "Gemini", mono: "✦", color: "#A68CFF", alarm: "#FF5CA8" },
  antigravity: { id: "antigravity", name: "Antigravity", short: "Ag", mono: "Ag", color: "#35E3A2", alarm: "#FF4F8B" },
  grok: { id: "grok", name: "Grok", short: "Grok", mono: "◉", color: "#E9E9EC", alarm: "#FF7A1A" },
  herdr: { id: "herdr", name: "herdr", short: "herdr", mono: "H", color: "#58D7C3", alarm: "#FF8A3D" },
  custom: { id: "custom", name: "Adapter", short: "Adp", mono: "◆", color: "#B9C3D1", alarm: "#FF8A3D" },
});

/** herdr pane labels and ACP ids mapped onto deck agent ids. */
const ALIASES = {
  claude: "claude",
  "claude-code": "claude",
  codex: "codex",
  "codex-cli": "codex",
  gemini: "gemini",
  "gemini-cli": "gemini",
  antigravity: "antigravity",
  "antigravity-cli": "antigravity",
  agy: "antigravity",
  grok: "grok",
  "grok-cli": "grok",
};

export function resolveAgentId(label) {
  if (typeof label !== "string") return "custom";
  const key = label.trim().toLowerCase();
  if (AGENTS[key]) return key;
  if (ALIASES[key]) return ALIASES[key];
  for (const alias of Object.keys(ALIASES)) {
    if (key.includes(alias)) return ALIASES[alias];
  }
  return "custom";
}

export function paletteFor(config) {
  const out = {};
  for (const id of Object.keys(AGENTS)) {
    const overrides = config?.agents?.[id] ?? {};
    out[id] = { ...AGENTS[id], ...overrides, id };
  }
  return out;
}

export const ACTIVITIES = Object.freeze([
  "starting",
  "idle",
  "thinking",
  "tool",
  "streaming",
  "waitingPermission",
  "waitingQuestion",
  "done",
  "error",
  "compacting",
  "offline",
]);

export const WORKING = new Set(["starting", "thinking", "tool", "streaming", "compacting"]);
export const WAITING = new Set(["waitingPermission", "waitingQuestion"]);
