import { basename } from "node:path";
import { clip, truncate } from "../util.mjs";

const KIND_BY_TOOL = {
  shell: [
    "bash",
    "shell",
    "run_command",
    "run_shell_command",
    "exec_command",
    "execute_command",
    "powershell",
    "terminal",
  ],
  edit: [
    "edit",
    "write",
    "multiedit",
    "notebookedit",
    "write_file",
    "replace",
    "apply_patch",
    "write_to_file",
    "replace_file_content",
    "multi_replace_file_content",
    "edit_file",
    "create_file",
  ],
  read: [
    "read",
    "grep",
    "glob",
    "read_file",
    "read_many_files",
    "list_dir",
    "list_directory",
    "view_file",
    "view_code_item",
    "grep_search",
    "find_by_name",
    "codebase_search",
    "search_file_content",
    "ls",
  ],
  web: [
    "webfetch",
    "websearch",
    "web_fetch",
    "web_search",
    "google_web_search",
    "search_web",
    "read_url_content",
    "browser",
  ],
  delegate: ["agent", "task", "spawn_agent", "subagent", "delegate"],
  plan: ["todowrite", "enterplanmode", "exitplanmode", "update_plan", "plan"],
  integration: ["mcp"],
};

export function toolKind(toolName) {
  if (typeof toolName !== "string") return "other";
  const key = toolName.toLowerCase();
  if (key.startsWith("mcp__") || key.startsWith("mcp_")) return "integration";
  for (const kind of Object.keys(KIND_BY_TOOL)) {
    if (KIND_BY_TOOL[kind].includes(key)) return kind;
  }
  return "other";
}

function summarizeInput(toolName, input) {
  if (!input || typeof input !== "object") return "";
  const pick = (...keys) => {
    for (const key of keys) {
      const value = input[key];
      if (typeof value === "string" && value.trim()) return value;
      if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value.join(" ");
    }
    return "";
  };
  const kind = toolKind(toolName);
  if (kind === "shell") return pick("command", "CommandLine", "cmd", "commandLine");
  if (kind === "edit" || kind === "read") {
    const path = pick("file_path", "path", "AbsolutePath", "TargetFile", "filePath", "file", "DirectoryPath");
    if (path) return basename(path.replace(/[\\/]+$/, ""));
    return pick("pattern", "Query", "query", "SearchPath");
  }
  if (kind === "web") {
    const url = pick("url", "Url");
    if (url) {
      try {
        return new URL(url).hostname;
      } catch {
        return url;
      }
    }
    return pick("query", "Query");
  }
  if (kind === "delegate") return pick("description", "prompt", "task");
  const firstString = Object.values(input).find((v) => typeof v === "string" && v.trim());
  return typeof firstString === "string" ? firstString : "";
}

/** "Bash  npm test" — tool name, two spaces, short summary. Max 80 chars like Orbtile. */
export function toolLabel(toolName, input) {
  const name = clip(typeof toolName === "string" && toolName ? toolName : "Tool", 40);
  const summary = clip(summarizeInput(name, input), 80 - name.length - 2);
  return truncate(summary ? `${name}  ${summary}` : name, 80);
}

export function commandSummary(toolName, input) {
  return clip(summarizeInput(toolName, input), 120);
}

/** Claude Code AskUserQuestion tool_input → deck question structure. */
export function questionFromInput(input) {
  const raw = Array.isArray(input?.questions) ? input.questions : [];
  const questions = raw.slice(0, 4).map((q) => ({
    text: clip(q?.question ?? q?.text ?? "", 200),
    header: clip(q?.header ?? "", 24),
    multiSelect: Boolean(q?.multiSelect),
    options: (Array.isArray(q?.options) ? q.options : []).slice(0, 4).map((o) => ({
      label: clip(o?.label ?? String(o ?? ""), 60),
      description: clip(o?.description ?? "", 120),
    })),
  }));
  if (questions.length === 0) return null;
  return { id: `q-${Date.now()}`, questions };
}
