/**
 * Agent registry: names, colours and the badge drawn in the corner of each tile.
 *
 * `work` is the orb colour while the agent works, idles or is done; `alert` is used while it waits
 * for you (approval / question). Users can override both per agent in the plugin settings.
 */
export type AgentId =
	| "claude"
	| "codex"
	| "antigravity"
	| "gemini"
	| "cursor"
	| "copilot"
	| "opencode"
	| "droid"
	| "amp"
	| "grok"
	| "kiro"
	| "qwen"
	| "cline"
	| "pi"
	| "devin"
	| "kimi"
	| "custom";

export type AgentInfo = {
	id: AgentId;
	name: string;
	work: string;
	alert: string;
};

export const AGENTS: Record<AgentId, AgentInfo> = {
	claude: { id: "claude", name: "Claude Code", work: "#FFB238", alert: "#FF5F2E" },
	codex: { id: "codex", name: "Codex", work: "#3F8CFF", alert: "#B36BFF" },
	antigravity: { id: "antigravity", name: "Antigravity", work: "#1FD8A4", alert: "#FF4F9A" },
	gemini: { id: "gemini", name: "Gemini CLI", work: "#8C7CFF", alert: "#FF5CA8" },
	// shown through herdr (https://herdr.dev), which detects many more agents
	cursor: { id: "cursor", name: "Cursor", work: "#C9D1DE", alert: "#FF8A3D" },
	copilot: { id: "copilot", name: "Copilot", work: "#A371F7", alert: "#FF7B72" },
	opencode: { id: "opencode", name: "OpenCode", work: "#FAB387", alert: "#FF5C8A" },
	droid: { id: "droid", name: "Droid", work: "#FF8A4C", alert: "#FF4F9A" },
	amp: { id: "amp", name: "Amp", work: "#FF6B8B", alert: "#FFB238" },
	grok: { id: "grok", name: "Grok", work: "#E9E9EC", alert: "#FF7A1A" },
	kiro: { id: "kiro", name: "Kiro", work: "#9B6CFF", alert: "#FF5CA8" },
	qwen: { id: "qwen", name: "Qwen Code", work: "#7C6CFF", alert: "#FF5CA8" },
	cline: { id: "cline", name: "Cline", work: "#4FC3F7", alert: "#FF8A3D" },
	pi: { id: "pi", name: "Pi", work: "#9AE6B4", alert: "#FF8A3D" },
	devin: { id: "devin", name: "Devin", work: "#7DD3FC", alert: "#FF8A3D" },
	kimi: { id: "kimi", name: "Kimi", work: "#60A5FA", alert: "#FF8A3D" },
	custom: { id: "custom", name: "Agent", work: "#B9C3D1", alert: "#FF8A3D" },
};

/** herdr agent kinds → our ids (anything else shows as a generic agent with herdr's name). */
export const HERDR_KINDS: Record<string, AgentId> = {
	claude: "claude",
	codex: "codex",
	gemini: "gemini",
	agy: "antigravity",
	cursor: "cursor",
	copilot: "copilot",
	opencode: "opencode",
	droid: "droid",
	amp: "amp",
	grok: "grok",
	kiro: "kiro",
	qwen: "qwen",
	cline: "cline",
	pi: "pi",
	devin: "devin",
	kimi: "kimi",
};

/** Agents the plugin can connect to (hooks). */
export const HOOK_AGENTS = ["claude", "codex", "antigravity", "gemini"] as const;
export type HookAgentId = (typeof HOOK_AGENTS)[number];

export function isAgentId(value: unknown): value is AgentId {
	return typeof value === "string" && value in AGENTS;
}

export const ACTIVITIES = [
	"starting",
	"thinking",
	"tool",
	"writing",
	"compacting",
	"approval",
	"question",
	"done",
	"error",
	"idle",
	"offline",
] as const;
export type Activity = (typeof ACTIVITIES)[number];

export const WORKING = new Set<Activity>(["starting", "thinking", "tool", "writing", "compacting"]);
export const WAITING = new Set<Activity>(["approval", "question"]);

export const LABELS: Record<Activity, string> = {
	starting: "Starting",
	thinking: "Thinking",
	tool: "Tool",
	writing: "Writing",
	compacting: "Compacting",
	approval: "Approval",
	question: "Question",
	done: "Done",
	error: "Error",
	idle: "Idle",
	offline: "Offline",
};
