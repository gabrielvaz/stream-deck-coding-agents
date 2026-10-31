/**
 * Limits key: how much of each usage window is left, with a bar and the time until it resets.
 *
 *   ┌───────────────────────┐
 *   │ Claude Code        ▣  │   agent name, badge
 *   │ 5h          99% left  │
 *   │ ████████████████████  │   bar = what is left
 *   │ resets 3h 12m         │
 *   │ Week        81% left  │
 *   │ ███████████████░░░░░  │
 *   │ resets 4d 2h          │
 *   └───────────────────────┘
 */
import { AGENTS } from "../core/agents";
import type { Limits, LimitWindow } from "../core/limits";
import { badge, boldWidth, DIM, ERROR, esc, fitSans, fitSize, fmtAge, frame, MONO, type RenderContext, SANS, sansWidth, TEXT } from "./kit";

const LOW = "#FF8A3D";
const BAR_X = 11;
const BAR_W = 123;

/** "3h 12m", "4d 2h", "45m". */
export function fmtReset(ms: number): string {
	const m = Math.max(0, Math.round(ms / 60_000));
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ${m % 60}m`;
	return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function row(w: LimitWindow, top: number, color: string, now: number): string {
	const left = Math.round(100 - w.usedPercent);
	const fill = left <= 10 ? ERROR : left <= 25 ? LOW : color;
	const pct = `${left}%`;
	// the label gets whatever the percentage leaves free (the width estimates run ~20 % wide)
	const room = BAR_W - 0.8 * (boldWidth(pct, 17) + sansWidth(" left", 11)) - 9;
	// "5h" / "Week" always fit; only model names (Antigravity) shrink and clip
	const fixed = w.windowMinutes > 0;
	const size = fixed ? 15 : fitSize(w.label, 15, room);
	const parts = [
		`<text x="${BAR_X}" y="${top + 14}" font-family="${SANS}" font-size="${size}" font-weight="700" fill="${TEXT}">${esc(fixed ? w.label : fitSans(w.label, size, room))}</text>`,
		`<text x="${BAR_X + BAR_W}" y="${top + 14}" text-anchor="end" font-family="${SANS}" font-size="17" font-weight="800" fill="${left <= 25 ? fill : TEXT}">${pct}<tspan font-size="11" font-weight="600" fill="${DIM}"> left</tspan></text>`,
		`<rect x="${BAR_X}" y="${top + 21}" width="${BAR_W}" height="7" rx="3.5" fill="#24272D"/>`,
	];
	if (left > 0) parts.push(`<rect x="${BAR_X}" y="${top + 21}" width="${Math.max(7, (BAR_W * left) / 100).toFixed(1)}" height="7" rx="3.5" fill="${fill}"/>`);
	if (w.resetsAt > now) parts.push(`<text x="${BAR_X}" y="${top + 42}" font-family="${MONO}" font-size="12.5" fill="${DIM}">resets ${fmtReset(w.resetsAt - now)}</text>`);
	return parts.join("");
}

/** Shorter than the agent names: the key also carries a badge. */
const NAMES: Record<Limits["provider"], string> = { claude: "Claude", codex: "Codex", antigravity: "Antigravity" };

const MESSAGES: Record<Limits["status"], string> = {
	ok: "",
	loading: "Loading…",
	"no-auth": "Not signed in",
	expired: "Sign in again",
	none: "No usage yet",
	error: "Can't reach it",
};

export function limitsTile(limits: Limits, ctx: RenderContext): string {
	const info = ctx.palette[limits.provider] ?? AGENTS[limits.provider];
	const parts: string[] = [badge(limits.provider, info, 116, 8, 20)];
	// Codex numbers come from its last session: say how old they are once it gets stale;
	// Antigravity can have more model families than rows: say how many are not shown
	const stale = limits.status === "ok" && limits.updatedAt > 0 && ctx.now - limits.updatedAt > 30 * 60_000 ? `${fmtAge(ctx.now - limits.updatedAt)} ago` : "";
	const aside = stale || (limits.windows.length > 2 ? `+${limits.windows.length - 2}` : "");
	if (aside) parts.push(`<text x="110" y="24" text-anchor="end" font-family="${SANS}" font-size="11" font-weight="600" fill="${DIM}">${aside}</text>`);
	const name = NAMES[limits.provider];
	const room = aside ? 104 - 0.8 * sansWidth(aside, 11) : 104;
	const size = fitSize(name, 16, room);
	parts.push(`<text x="11" y="24" font-family="${SANS}" font-size="${size}" font-weight="800" fill="${TEXT}">${esc(fitSans(name, size, room))}</text>`);

	if (limits.status !== "ok" || limits.windows.length === 0) {
		const title = limits.status === "ok" ? MESSAGES.none : MESSAGES[limits.status];
		parts.push(`<text x="72" y="76" text-anchor="middle" font-family="${SANS}" font-size="15" font-weight="700" fill="${TEXT}">${esc(title)}</text>`);
		if (limits.note && limits.note !== title)
			parts.push(`<text x="72" y="98" text-anchor="middle" font-family="${SANS}" font-size="13" font-weight="600" fill="${info.alert}">${esc(fitSans(limits.note, 13, 128))}</text>`);
		return frame(parts.join(""));
	}

	limits.windows.slice(0, 2).forEach((w, i) => parts.push(row(w, 40 + i * 51, info.work, ctx.now)));
	return frame(parts.join(""));
}
