import { basename } from "node:path";

/** Collapses whitespace and clips to `max` characters with an ellipsis. */
export function clip(text: unknown, max: number): string {
	if (typeof text !== "string") return "";
	const flat = text.replace(/\s+/g, " ").trim();
	if (flat.length <= max) return flat;
	return `${flat.slice(0, Math.max(0, max - 1))}…`;
}

/** Like {@link clip} but keeps inner runs of spaces (tool labels use a double space). */
export function truncate(text: unknown, max: number): string {
	if (typeof text !== "string") return "";
	const flat = text.replace(/[\r\n\t]+/g, " ").trim();
	if (flat.length <= max) return flat;
	return `${flat.slice(0, Math.max(0, max - 1))}…`;
}

export function firstLine(text: unknown): string {
	if (typeof text !== "string") return "";
	const line = text.split(/\r?\n/).find((l) => l.trim().length > 0);
	return line ? line.trim() : "";
}

export function lastLine(text: unknown): string {
	if (typeof text !== "string") return "";
	const lines = text
		.replace(/```[a-z]*\n?/gi, "")
		.split(/\r?\n/)
		.map((l) => l.replace(/^[#>*\-\s]+/, "").trim())
		.filter((l) => l.length > 0);
	return lines.length > 0 ? lines[lines.length - 1] : "";
}

export function projectName(cwd: unknown): string {
	if (typeof cwd !== "string" || cwd.length === 0) return "";
	const trimmed = cwd.replace(/[\\/]+$/, "");
	const parts = trimmed.split(/[\\/]/);
	return parts[parts.length - 1] || basename(trimmed) || trimmed;
}

/** Removes markdown noise so streamed text reads well on a 4-line tile. */
export function plainText(text: unknown): string {
	if (typeof text !== "string") return "";
	return text
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`([^`]*)`/g, "$1")
		.replace(/\*\*([^*]*)\*\*/g, "$1")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/^[#>\-*\s]+/gm, "")
		.replace(/\s+/g, " ")
		.trim();
}

export function isLoopback(address: string | undefined): boolean {
	if (!address) return false;
	return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
