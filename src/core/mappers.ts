/**
 * Hook events of each CLI → tile updates.
 *
 * Claude Code   https://code.claude.com/docs/en/hooks
 * Codex CLI     https://learn.chatgpt.com/docs/hooks
 * Antigravity   https://antigravity.google/docs/hooks  (+ the `title` command for live state)
 * Gemini CLI    https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/reference.md
 */
import type { AgentId } from "./agents";
import type { Decision, Session, SessionPatch } from "./store";
import { commandSummary, questionFrom, toolLabel } from "./tools";
import { clip, firstLine, projectName } from "./util";

type Payload = Record<string, unknown>;

export type Mapped = {
	sessionId: string;
	patch: SessionPatch;
	remove?: boolean;
	/** Hold the hook until a key answers (or the wait expires). */
	awaitDecision?: boolean;
	/** Turns a decision (or null = no decision) into the hook's stdout. */
	reply?: (decision: Decision) => unknown;
	/** Only apply the patch when the current session state allows it. */
	when?: (session: Session | null) => boolean;
	/** Computes the reply from the updated session (Antigravity title). */
	replyFromSession?: (session: Session) => unknown;
};

const str = (value: unknown): string => (typeof value === "string" ? value : "");

function base(sessionId: string, cwd: unknown): Mapped {
	const dir = str(cwd);
	return { sessionId, patch: dir ? { cwd: dir, project: projectName(dir) } : {} };
}

const promptTitle = (prompt: unknown) => clip(firstLine(prompt), 100);

/** Claude Code and Codex share the PermissionRequest reply shape. */
function permissionReply(decision: Decision): unknown {
	if (!decision) return {};
	if (decision.behavior === "allow") {
		return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } };
	}
	return {
		hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "Denied from Stream Deck" } },
	};
}

const notDone = (s: Session | null) => !s || (s.activity !== "done" && s.activity !== "error");
const isBusy = (s: Session | null) => !!s && ["tool", "approval", "question", "writing", "thinking", "starting", "compacting"].includes(s.activity);

// ------------------------------------------------------------------------------------------------ Claude Code

export function mapClaude(event: string, p: Payload): Mapped | null {
	const sessionId = str(p.session_id);
	if (!sessionId) return null;
	const m = base(sessionId, p.cwd);
	const patch = m.patch;
	if (typeof p.session_title === "string" && p.session_title.trim()) patch.title = p.session_title;
	const tool = str(p.tool_name);

	switch (event) {
		case "SessionStart":
			if (str(p.model)) patch.model = str(p.model);
			if (p.source === "compact") patch.restoreAfterCompact = true;
			else {
				patch.activity = "idle";
				m.when = (s) => !s || !isBusy(s);
			}
			return m;
		case "UserPromptSubmit":
			patch.activity = "thinking";
			patch.prompt = promptTitle(p.prompt);
			if (!patch.title) patch.titleIfEmpty = promptTitle(p.prompt);
			patch.text = null;
			patch.subagents = 0;
			return m;
		case "PreToolUse":
			if (tool === "AskUserQuestion") {
				const q = questionFrom(p.tool_input);
				patch.activity = "question";
				patch.question = q;
				patch.detail = q?.text ?? "Question";
				return m;
			}
			if (tool === "ExitPlanMode") {
				patch.activity = "question";
				patch.question = { text: "Plan ready: approve it in the terminal", options: [] };
				return m;
			}
			patch.activity = "tool";
			patch.toolLabel = toolLabel(tool, p.tool_input);
			return m;
		case "PermissionRequest": {
			if (tool === "ExitPlanMode" || tool === "AskUserQuestion") return null; // answered in the terminal
			patch.activity = "approval";
			patch.toolLabel = toolLabel(tool, p.tool_input);
			patch.approval = { tool: tool || "Tool", summary: commandSummary(tool, p.tool_input) };
			// no decision = empty output: Claude Code shows its own prompt
			return { ...m, awaitDecision: true, reply: (d) => (d ? permissionReply(d) : null) };
		}
		case "PostToolUse":
		case "PostToolBatch":
			patch.activity = "thinking";
			m.when = (s) => !s || s.activity !== "done";
			return m;
		case "PostToolUseFailure":
			patch.activity = p.is_interrupt === true ? "idle" : "thinking";
			if (p.is_interrupt !== true) patch.detail = firstLine(p.error);
			return m;
		case "PermissionDenied":
			patch.activity = "thinking";
			return m;
		case "Notification":
			switch (str(p.notification_type)) {
				case "permission_prompt":
					patch.activity = "approval";
					patch.detail = clip(p.message, 160);
					m.when = (s) => !s || s.activity !== "approval";
					return m;
				case "idle_prompt":
					patch.activity = "idle";
					m.when = notDone;
					return m;
				case "elicitation_dialog":
				case "elicitation_url_dialog":
				case "agent_needs_input":
					patch.activity = "question";
					patch.question = { text: clip(p.message, 200) || "Needs your input", options: [] };
					return m;
				default:
					return null;
			}
		case "MessageDisplay": {
			const delta = str(p.delta);
			if (!delta.trim()) return null;
			patch.activity = "writing";
			patch.appendText = delta;
			m.when = (s) => !s || !["done", "approval", "question"].includes(s.activity);
			return m;
		}
		case "SubagentStart":
			patch.subagentDelta = 1;
			return m;
		case "SubagentStop":
			patch.subagentDelta = -1;
			return m;
		case "Stop":
			patch.activity = "done";
			patch.subagents = 0;
			if (str(p.last_assistant_message)) patch.text = str(p.last_assistant_message);
			return m;
		case "StopFailure":
			patch.activity = "error";
			patch.detail = [str(p.error).replace(/_/g, " "), firstLine(p.error_details)].filter(Boolean).join(": ") || "error";
			return m;
		case "PreCompact":
			patch.activity = "compacting";
			return m;
		case "PostCompact":
			patch.restoreAfterCompact = true;
			return m;
		case "SessionEnd":
			return { ...m, remove: true };
		default:
			return null;
	}
}

// ------------------------------------------------------------------------------------------------ Codex

export function mapCodex(event: string, p: Payload): Mapped | null {
	const sessionId = str(p.session_id) || str(p.thread_id);
	if (!sessionId) return null;
	const m = base(sessionId, p.cwd);
	const patch = m.patch;
	if (str(p.model)) patch.model = str(p.model);
	const tool = str(p.tool_name);
	m.reply = () => ({});

	switch (event) {
		case "SessionStart":
			if (p.source === "compact") patch.restoreAfterCompact = true;
			else {
				patch.activity = "idle";
				m.when = (s) => !s || !isBusy(s);
			}
			return m;
		case "UserPromptSubmit":
			patch.activity = "thinking";
			patch.prompt = promptTitle(p.prompt);
			patch.titleIfEmpty = promptTitle(p.prompt);
			patch.text = null;
			patch.subagents = 0;
			return m;
		case "PreToolUse":
			if (tool === "request_user_input") {
				const q = questionFrom(p.tool_input);
				patch.activity = "question";
				patch.question = q;
				return m;
			}
			patch.activity = "tool";
			patch.toolLabel = toolLabel(tool, p.tool_input);
			return m;
		case "PermissionRequest":
			patch.activity = "approval";
			patch.toolLabel = toolLabel(tool, p.tool_input);
			patch.approval = { tool: tool || "Tool", summary: commandSummary(tool, p.tool_input) };
			return { ...m, awaitDecision: true, reply: permissionReply };
		case "PostToolUse":
			patch.activity = "thinking";
			m.when = (s) => !s || s.activity !== "done";
			return m;
		case "SubagentStart":
			patch.subagentDelta = 1;
			return m;
		case "SubagentStop":
			patch.subagentDelta = -1;
			return m;
		case "Stop":
			patch.activity = "done";
			patch.subagents = 0;
			if (str(p.last_assistant_message)) patch.text = str(p.last_assistant_message);
			return m;
		case "Interrupt":
			patch.activity = "idle";
			return m;
		case "PreCompact":
			patch.activity = "compacting";
			return m;
		case "PostCompact":
			patch.restoreAfterCompact = true;
			return m;
		case "SessionEnd":
			return { ...m, remove: true };
		default:
			return m.sessionId ? { ...m, patch: {} } : null;
	}
}

// ------------------------------------------------------------------------------------------------ Antigravity CLI

/**
 * agy hook payloads are camelCase and carry no event name, so the hook passes it as an argument.
 * `Title` is the `title` command: it runs on every state change with the status-line JSON, which
 * is the only place agy reports a pending tool confirmation.
 */
export function mapAntigravity(event: string, p: Payload): Mapped | null {
	if (event === "Title") return mapAntigravityState(p);
	const sessionId = str(p.conversationId);
	if (!sessionId) return null;
	const cwd = Array.isArray(p.workspacePaths) ? p.workspacePaths[0] : p.cwd;
	const m = base(sessionId, cwd);
	const patch = m.patch;
	if (str(p.modelName)) patch.model = str(p.modelName);
	m.reply = () => ({});

	switch (event) {
		case "SessionStart":
			patch.activity = "idle";
			m.when = (s) => !s || !isBusy(s);
			return m;
		case "PreInvocation": {
			const input = str(p.lastUserInput);
			patch.activity = "thinking";
			if (input) {
				patch.prompt = promptTitle(input);
				patch.titleIfEmpty = promptTitle(input);
			}
			if (Number(p.invocationNum) <= 1) patch.text = null;
			m.when = (s) => !s || s.activity !== "approval";
			return m;
		}
		case "PostInvocation":
			return { ...m, patch: { ...patch } };
		case "PreToolUse": {
			const call = (p.toolCall ?? {}) as Payload;
			patch.activity = "tool";
			patch.toolLabel = toolLabel(call.name, call.args);
			return { ...m, reply: () => ({ decision: "allow" }) };
		}
		case "PostToolUse":
			patch.activity = "thinking";
			if (str(p.error).trim()) patch.detail = firstLine(p.error);
			return m;
		case "Stop":
			if (p.terminationReason === "error" || str(p.error).trim()) {
				patch.activity = "error";
				patch.detail = firstLine(p.error) || "error";
			} else if (p.fullyIdle === false) {
				patch.activity = "thinking";
			} else {
				patch.activity = "done";
			}
			return m;
		default:
			return { ...m, patch: {} };
	}
}

function mapAntigravityState(p: Payload): Mapped | null {
	const sessionId = str(p.conversation_id) || str(p.session_id);
	const workspace = (p.workspace ?? {}) as Payload;
	const cwd = str(workspace.project_dir) || str(p.cwd);
	const folder = projectName(cwd);
	const titleText = str(p.conversation_title);
	// the window title shows the topic, which also helps the key find this terminal
	const windowTitle = clip(titleText ? `${titleText} · ${folder || "agy"}` : `${folder || "agy"} · Antigravity`, 90);
	if (!sessionId) return { sessionId: "", patch: {}, reply: () => windowTitle };
	const m = base(sessionId, cwd);
	const patch = m.patch;
	if (titleText) patch.title = titleText;
	const model = (p.model ?? {}) as Payload;
	if (str(model.display_name)) patch.model = str(model.display_name);
	m.reply = () => windowTitle;

	if (p.tool_confirmation_pending === true) {
		patch.activity = "approval";
		m.when = (s) => !s || s.activity !== "approval";
		return m;
	}
	switch (str(p.agent_state)) {
		case "idle":
			patch.activity = "idle";
			m.when = (s) => !s || !["done", "error", "idle"].includes(s.activity);
			return m;
		case "working":
		case "reviewing":
			patch.activity = "thinking";
			m.when = (s) => !s || !["thinking", "tool", "writing"].includes(s.activity);
			return m;
		case "tool_use":
			patch.activity = "tool";
			m.when = (s) => !s || s.activity !== "tool";
			return m;
		case "authenticating":
		case "initializing":
			patch.activity = "starting";
			m.when = (s) => !s || !isBusy(s);
			return m;
		case "error":
			patch.activity = "error";
			return m;
		default:
			return m;
	}
}

// ------------------------------------------------------------------------------------------------ Gemini CLI

export function mapGemini(event: string, p: Payload): Mapped | null {
	const sessionId = str(p.session_id);
	if (!sessionId) return null;
	const m = base(sessionId, p.cwd);
	const patch = m.patch;
	m.reply = () => ({});

	switch (event) {
		case "SessionStart":
			patch.activity = "idle";
			m.when = (s) => !s || !isBusy(s);
			return m;
		case "BeforeAgent":
			patch.activity = "thinking";
			patch.prompt = promptTitle(p.prompt);
			patch.titleIfEmpty = promptTitle(p.prompt);
			patch.text = null;
			return m;
		case "BeforeTool":
			patch.activity = "tool";
			patch.toolLabel = toolLabel(p.tool_name, p.tool_input);
			return m;
		case "AfterTool":
			patch.activity = "thinking";
			return m;
		case "AfterAgent":
			patch.activity = "done";
			if (str(p.prompt_response)) patch.text = str(p.prompt_response);
			return m;
		case "Notification":
			if (p.notification_type === "ToolPermission") {
				patch.activity = "approval";
				patch.detail = clip(p.message, 160);
				return m;
			}
			return { ...m, patch: {} };
		case "PreCompress":
			patch.activity = "compacting";
			return m;
		case "SessionEnd":
			return { ...m, remove: true };
		default:
			return { ...m, patch: {} };
	}
}

export const MAPPERS: Partial<Record<AgentId, (event: string, payload: Payload) => Mapped | null>> = {
	claude: mapClaude,
	codex: mapCodex,
	antigravity: mapAntigravity,
	gemini: mapGemini,
};

/** What a hook should print when nothing better is known (or the plugin is gone). */
export function neutralReply(agent: string, event: string): unknown {
	if (agent === "antigravity" && event === "PreToolUse") return { decision: "allow" };
	if (agent === "antigravity" && event === "Title") return "";
	if (agent === "claude") return null;
	return {};
}

export function eventName(payload: Payload, explicit: string): string {
	if (explicit) return explicit;
	return str(payload.hook_event_name) || str(payload.hookEventName);
}
