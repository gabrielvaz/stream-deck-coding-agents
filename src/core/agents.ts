/**
 * Agent registry: names, colours and the badge drawn in the corner of each tile.
 *
 * `work` is the orb colour while the agent works, idles or is done; `alert` is used while it waits
 * for you (approval / question). Users can override both per agent in the plugin settings.
 */
export type AgentId = "claude" | "codex" | "antigravity" | "gemini" | "custom";

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
	custom: { id: "custom", name: "Agent", work: "#B9C3D1", alert: "#FF8A3D" },
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
