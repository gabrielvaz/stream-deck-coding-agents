import { clip, firstLine, projectName } from "../util.mjs";
import { commandSummary, questionFromInput, toolKind, toolLabel } from "./tools.mjs";

/**
 * Claude Code hooks → deck updates.
 * Docs: https://code.claude.com/docs/en/hooks
 */
export function mapClaude(event, payload) {
  const sessionId = payload.session_id;
  if (!sessionId) return null;
  const base = { sessionId, patch: { cwd: payload.cwd, project: projectName(payload.cwd) } };
  const patch = base.patch;

  switch (event) {
    case "SessionStart":
      patch.activity = "starting";
      if (payload.model) patch.model = payload.model;
      if (payload.session_title) patch.title = payload.session_title;
      else patch.titleIfEmpty = projectName(payload.cwd);
      return base;
    case "UserPromptSubmit":
      patch.activity = "thinking";
      patch.message = null;
      if (typeof payload.prompt === "string" && payload.prompt.trim()) patch.title = titleFromPrompt(payload);
      return base;
    case "PreToolUse": {
      if (payload.tool_name === "AskUserQuestion") {
        patch.activity = "waitingQuestion";
        patch.question = questionFromInput(payload.tool_input);
        patch.statusDetail = patch.question?.questions?.[0]?.text ?? "Question";
        return base;
      }
      patch.activity = "tool";
      patch.toolLabel = toolLabel(payload.tool_name, payload.tool_input);
      patch.toolKind = toolKind(payload.tool_name);
      return base;
    }
    case "PermissionRequest":
      patch.activity = "waitingPermission";
      patch.toolLabel = toolLabel(payload.tool_name, payload.tool_input);
      patch.toolKind = toolKind(payload.tool_name);
      patch.statusDetail = `Allow ${payload.tool_name ?? "tool"}?`;
      patch.approval = {
        id: `approval-${Date.now()}`,
        toolName: payload.tool_name ?? "tool",
        commandSummary: commandSummary(payload.tool_name, payload.tool_input),
      };
      return { ...base, hold: "approval", reply: claudePermissionReply };
    case "PostToolUse":
      patch.activity = "thinking";
      return base;
    case "PostToolUseFailure":
      patch.activity = "thinking";
      patch.statusDetail = firstLine(payload.error);
      return base;
    case "Notification":
      return mapNotification(base, payload);
    case "MessageDisplay":
      patch.activity = "streaming";
      patch.appendText = { id: payload.message_id ?? payload.turn_id ?? "live", delta: payload.delta ?? "" };
      return base;
    case "SubagentStart":
      patch.subagentDelta = 1;
      return base;
    case "SubagentStop":
      patch.subagentDelta = -1;
      return base;
    case "Stop":
      patch.activity = "done";
      patch.subagentCount = 0;
      if (typeof payload.last_assistant_message === "string") {
        patch.message = { id: `final-${Date.now()}`, text: payload.last_assistant_message };
      }
      return base;
    case "StopFailure":
      patch.activity = "error";
      patch.statusDetail = [payload.error, payload.error_details].filter(Boolean).join(": ") || "error";
      return base;
    case "PreCompact":
      patch.activity = "compacting";
      return base;
    case "PostCompact":
      return { ...base, restore: true };
    case "SessionEnd":
      return { sessionId, remove: true };
    default:
      return null;
  }
}

function titleFromPrompt(payload) {
  const line = firstLine(payload.prompt);
  const project = projectName(payload.cwd);
  const text = clip(line, 80);
  return project ? `${project} – ${text}` : text;
}

function mapNotification(base, payload) {
  const type = payload.notification_type;
  const patch = base.patch;
  switch (type) {
    case "permission_prompt":
      patch.activity = "waitingPermission";
      patch.statusDetail = clip(payload.message ?? "Permission needed", 120);
      return base;
    case "idle_prompt":
      patch.activity = "idle";
      return base;
    case "agent_needs_input":
    case "elicitation_dialog":
    case "elicitation_url_dialog":
      patch.activity = "waitingQuestion";
      patch.statusDetail = clip(payload.message ?? "Needs input", 120);
      return base;
    default:
      return null;
  }
}

function claudePermissionReply(decision) {
  if (!decision || decision.behavior === "dismiss") return {};
  if (decision.behavior === "allow") {
    return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } };
  }
  return {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "deny", message: "Denied from Agent Deck" },
    },
  };
}
