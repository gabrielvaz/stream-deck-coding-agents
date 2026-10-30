import { mapAntigravity } from "./antigravity.mjs";
import { mapClaude } from "./claude.mjs";
import { mapCodex } from "./codex.mjs";
import { mapGemini } from "./gemini.mjs";

export const MAPPERS = Object.freeze({
  claude: mapClaude,
  codex: mapCodex,
  gemini: mapGemini,
  antigravity: mapAntigravity,
});

export function eventNameOf(payload, queryEvent) {
  if (typeof queryEvent === "string" && queryEvent) return queryEvent;
  if (typeof payload.hook_event_name === "string") return payload.hook_event_name;
  if (typeof payload.hookEventName === "string") return payload.hookEventName;
  return "";
}
