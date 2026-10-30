import { clip, firstLine, projectName } from "../util.mjs";
import { commandSummary, questionFromInput, toolKind, toolLabel } from "./tools.mjs";

/**
 * OpenAI Codex CLI hooks → deck updates.
 * Docs: https://developers.openai.com/codex/hooks (hooks.json next to ~/.codex/config.toml)
 */
export function mapCodex(event, payload) {
  const sessionId = payload.session_id ?? payload.thread_id;
  if (!sessionId) return null;
  const base = { sessionId, patch: { cwd: payload.cwd, project: projectName(payload.cwd) } };
  const patch = base.patch;

  switch (event) {
    case "SessionStart":
      patch.activity = "starting";
      if (payload.model) patch.model = payload.model;
      patch.titleIfEmpty = projectName(payload.cwd);
      return base;
    case "UserPromptSubmit": {
      patch.activity = "thinking";
      patch.message = null;
      const line = firstLine(payload.prompt);
      if (line) patch.title = `${projectName(payload.cwd) || "codex"} – ${clip(line, 80)}`;
      return base;
    }
    case "PreToolUse":
      if (payload.tool_name === "request_user_input") {
        patch.activity = "waitingQuestion";
        patch.question = questionFromInput(payload.tool_input);
        patch.statusDetail = patch.question?.questions?.[0]?.text ?? "Question";
        return base;
      }
      patch.activity = "tool";
      patch.toolLabel = toolLabel(payload.tool_name, payload.tool_input);
      patch.toolKind = toolKind(payload.tool_name);
      return base;
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
      return { ...base, hold: "approval", reply: codexPermissionReply };
    case "PostToolUse":
      patch.activity = "thinking";
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
    case "Interrupt":
      patch.activity = "idle";
      patch.statusDetail = "interrupted";
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

function codexPermissionReply(decision) {
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
