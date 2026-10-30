import { clip, firstLine, projectName } from "../util.mjs";
import { toolKind, toolLabel } from "./tools.mjs";

/**
 * Gemini CLI hooks → deck updates.
 * Docs: https://geminicli.com/docs/hooks/reference
 */
export function mapGemini(event, payload) {
  const sessionId = payload.session_id;
  if (!sessionId) return null;
  const base = { sessionId, patch: { cwd: payload.cwd, project: projectName(payload.cwd) } };
  const patch = base.patch;

  switch (event) {
    case "SessionStart":
      patch.activity = "starting";
      patch.titleIfEmpty = projectName(payload.cwd);
      return base;
    case "BeforeAgent": {
      patch.activity = "thinking";
      patch.message = null;
      const line = firstLine(payload.prompt);
      if (line) patch.title = `${projectName(payload.cwd) || "gemini"} – ${clip(line, 80)}`;
      return base;
    }
    case "BeforeModel":
      patch.activity = "thinking";
      return base;
    case "AfterModel":
      return base;
    case "BeforeTool":
      patch.activity = "tool";
      patch.toolLabel = toolLabel(payload.tool_name, payload.tool_input);
      patch.toolKind = toolKind(payload.tool_name);
      return base;
    case "AfterTool":
      patch.activity = "thinking";
      return base;
    case "AfterAgent":
      patch.activity = "done";
      if (typeof payload.prompt_response === "string") {
        patch.message = { id: `final-${Date.now()}`, text: payload.prompt_response };
      }
      return base;
    case "Notification":
      if (payload.notification_type === "ToolPermission") {
        patch.activity = "waitingPermission";
        patch.statusDetail = clip(payload.message ?? "Allow tool?", 120);
        return base;
      }
      if (payload.notification_type === "error") {
        patch.activity = "error";
        patch.statusDetail = clip(payload.message ?? "error", 120);
        return base;
      }
      return null;
    case "PreCompress":
      patch.activity = "compacting";
      return base;
    case "SessionEnd":
      return { sessionId, remove: true };
    default:
      return null;
  }
}
