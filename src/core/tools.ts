import { clip, truncate } from "./util";

/** Tool-name families across Claude Code, Codex, Antigravity and Gemini CLI. */
const KIND_BY_TOOL: Record<string, string[]> = {
	shell: ["bash", "shell", "run_command", "run_shell_command", "exec_command", "execute_command", "powershell", "terminal", "local_shell"],
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
	web: ["webfetch", "websearch", "web_fetch", "web_search", "google_web_search", "search_web", "read_url_content", "browser"],
	delegate: ["agent", "task", "spawn_agent", "subagent", "delegate"],
};

export function toolKind(toolName: unknown): string {
	if (typeof toolName !== "string") return "other";
	const key = toolName.toLowerCase();
	if (key.startsWith("mcp__") || key.startsWith("mcp_")) return "integration";
	for (const kind of Object.keys(KIND_BY_TOOL)) if (KIND_BY_TOOL[kind].includes(key)) return kind;
	return "other";
}

function baseName(path: string): string {
	const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
	return parts[parts.length - 1] || path;
}

function summarizeInput(toolName: string, input: unknown): string {
	if (typeof input === "string") return input;
	if (!input || typeof input !== "object") return "";
	const record = input as Record<string, unknown>;
	const pick = (...keys: string[]): string => {
		for (const key of keys) {
			const value = record[key];
			if (typeof value === "string" && value.trim()) return value;
			if (Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "string")) return value.join(" ");
		}
		return "";
	};
	const kind = toolKind(toolName);
	if (toolName === "apply_patch") {
		const patch = pick("command", "input", "patch");
		const file = /\*\*\* (?:Update|Add|Delete) File: (.+)/.exec(patch)?.[1];
		if (file) return baseName(file.trim());
	}
	if (kind === "shell") return pick("command", "CommandLine", "cmd", "commandLine");
	if (kind === "edit" || kind === "read") {
		const path = pick("file_path", "path", "AbsolutePath", "TargetFile", "filePath", "file", "DirectoryPath", "notebook_path");
		if (path) return baseName(path);
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
	const first = Object.values(record).find((v) => typeof v === "string" && v.trim());
	return typeof first === "string" ? first : "";
}

/** Display name: "mcp__github__create_issue" → "github create_issue". */
function displayName(toolName: string): string {
	const mcp = /^mcp__?([^_]+(?:_[^_]+)*?)__(.+)$/.exec(toolName);
	if (mcp) return `${mcp[1]} ${mcp[2]}`;
	return toolName;
}

/** "Bash  npm test": tool name, two spaces, a short summary of its input. */
export function toolLabel(toolName: unknown, input: unknown): string {
	const raw = typeof toolName === "string" && toolName ? toolName : "Tool";
	const name = clip(displayName(raw), 32);
	const summary = clip(summarizeInput(raw, input), 88 - name.length);
	return truncate(summary ? `${name}  ${summary}` : name, 90);
}

export function commandSummary(toolName: unknown, input: unknown): string {
	return clip(summarizeInput(typeof toolName === "string" ? toolName : "", input), 160);
}

/** Claude Code AskUserQuestion / Codex request_user_input → question shown on the key. */
export function questionFrom(input: unknown): { text: string; options: string[] } | null {
	const record = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
	const list = Array.isArray(record.questions) ? record.questions : [record];
	const first = list[0] as Record<string, unknown> | undefined;
	if (!first) return null;
	const text = clip(first.question ?? first.text ?? first.prompt ?? "", 200);
	const options = (Array.isArray(first.options) ? first.options : [])
		.map((o) => clip(typeof o === "string" ? o : ((o as Record<string, unknown>)?.label ?? ""), 40))
		.filter(Boolean)
		.slice(0, 4);
	if (!text) return null;
	return { text, options };
}
