import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { clip, firstLine, projectName } from "../util.mjs";
import { toolKind, toolLabel } from "./tools.mjs";

/**
 * Google Antigravity CLI (agy) hooks → deck updates.
 * Docs: https://antigravity.google/docs/hooks — the stdin JSON carries no event name,
 * so the hook script passes it as the `event` query parameter.
 */
export function mapAntigravity(event, payload) {
  const sessionId = payload.conversationId;
  if (!sessionId) return null;
  const cwd = Array.isArray(payload.workspacePaths) ? payload.workspacePaths[0] : payload.cwd;
  const base = { sessionId, patch: { cwd, project: projectName(cwd) } };
  const patch = base.patch;
  if (payload.modelName) patch.model = payload.modelName;

  switch (event) {
    case "SessionStart":
      patch.activity = "starting";
      patch.titleIfEmpty = projectName(cwd);
      return { ...base, reply: () => ({}) };
    case "PreInvocation": {
      patch.activity = "thinking";
      const title = titleFromTranscript(payload.transcriptPath, cwd);
      if (title) patch.titleIfEmpty = title;
      return { ...base, reply: () => ({}) };
    }
    case "PostInvocation":
      patch.activity = "thinking";
      return { ...base, reply: () => ({}) };
    case "PreToolUse":
      patch.activity = "tool";
      patch.toolLabel = toolLabel(payload.toolCall?.name, payload.toolCall?.args);
      patch.toolKind = toolKind(payload.toolCall?.name);
      return { ...base, reply: () => ({ decision: "allow" }) };
    case "PostToolUse":
      patch.activity = "thinking";
      if (typeof payload.error === "string" && payload.error.trim()) patch.statusDetail = firstLine(payload.error);
      return { ...base, reply: () => ({}) };
    case "Stop":
      if (payload.terminationReason === "error" || (typeof payload.error === "string" && payload.error.trim())) {
        patch.activity = "error";
        patch.statusDetail = firstLine(payload.error) || payload.terminationReason || "error";
      } else if (payload.fullyIdle === false) {
        patch.activity = "thinking";
      } else {
        patch.activity = "done";
      }
      return { ...base, reply: () => ({ decision: "stop" }) };
    default:
      return null;
  }
}

/** Best effort: the first user message in the conversation transcript becomes the tile title. */
function titleFromTranscript(transcriptPath, cwd) {
  if (typeof transcriptPath !== "string" || !transcriptPath) return "";
  const resolved = transcriptPath.startsWith("~") ? transcriptPath.replace(/^~/, homedir()) : transcriptPath;
  if (!existsSync(resolved)) return "";
  try {
    const head = readFileSync(resolved, { encoding: "utf8", flag: "r" }).slice(0, 65536);
    for (const line of head.split("\n")) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const role = entry.role ?? entry.type ?? entry.message?.role;
      if (role !== "user") continue;
      const content = entry.content ?? entry.text ?? entry.message?.content;
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content.map((c) => c?.text ?? "").join(" ")
            : "";
      const first = firstLine(text);
      if (first) return `${projectName(cwd) || "agy"} – ${clip(first, 80)}`;
    }
  } catch {
    // transcript unreadable: keep the project name
  }
  return "";
}
