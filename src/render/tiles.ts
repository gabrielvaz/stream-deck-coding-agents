/**
 * Key tiles. Session keys are drawn by the selected theme; the overview, Allow / Deny and page keys
 * share one layout with theme touches.
 *
 * Session layout, after the reference keypad:
 *   ┌───────────────────────┐
 *   │ title (marquee)       │   bold sans
 *   │ State          0:12   │   state word coloured when it needs attention, timer right
 *   │ Bash  npm test        │   monospace detail: tool, streamed text, last line, question…
 *   │   (light / critter) ▣ │   the theme's animation, agent badge
 *   └───────────────────────┘
 */
import { type AgentId, AGENTS, WAITING } from "../core/agents";
import type { Session, Summary } from "../core/store";
import {
	badge,
	DIM,
	ERROR,
	esc,
	fitSans,
	frame,
	lookFor,
	MONO,
	orb,
	type RenderContext,
	SANS,
	sansWidth,
	shade,
	SIZE,
	TEXT,
	type ThemeId,
	tint,
	wave,
	wrapMono,
} from "./kit";
import { clawdScene, clawdSession, critterColor } from "./theme-clawd";
import { minimalSession } from "./theme-minimal";
import { orbSession } from "./theme-orb";

export * from "./kit";
export { clawd, clawdScene, CLAWD_COLOR } from "./theme-clawd";

export const THEMES: { id: ThemeId; name: string; description: string }[] = [
	{ id: "pulse", name: "Pulse", description: "A glowing light that pulses while the agent works, with its own motion for every state." },
	{ id: "glow", name: "Glow", description: "The calm look of the reference keypad: the light breathes softly." },
	{ id: "clawd", name: "Clawd", description: "A pixel critter acts out each state: typing, writing, waving, sleeping, celebrating." },
	{ id: "minimal", name: "Minimal", description: "Flat and high-contrast for small keys: a sweeping bar shows the work." },
];

export const isTheme = (value: unknown): value is ThemeId => THEMES.some((t) => t.id === value);

export function sessionTile(session: Session, ctx: RenderContext): string {
	switch (ctx.theme ?? "pulse") {
		case "clawd":
			return clawdSession(session, ctx);
		case "minimal":
			return minimalSession(session, ctx);
		case "glow":
			return orbSession(session, ctx, "glow");
		default:
			return orbSession(session, ctx, "pulse");
	}
}

/** Empty slot: a faint dot, or a hint while nothing is connected yet. */
export function emptyTile(hint = ""): string {
	const body = hint
		? `<text x="72" y="66" text-anchor="middle" font-family="${SANS}" font-size="15" font-weight="600" fill="#5C616A">${esc(hint)}</text><circle cx="72" cy="96" r="5" fill="#26292F"/>`
		: `<circle cx="72" cy="72" r="5" fill="#1F2227"/>`;
	return frame(body);
}

export type HubView = {
	summary: Summary;
	pips: Session[];
	page: number;
	pages: number;
	listening: boolean;
	problem: string;
	connectedAgents: number;
};

/** Overview key: "6 working · none waiting · 2 done · •3 •3 •2 · pips". */
export function hubTile(view: HubView, ctx: RenderContext): string {
	const { summary } = view;
	const theme = ctx.theme ?? "pulse";
	const parts: string[] = [];
	const t = ctx.now / 1000;
	const waiting = summary.firstWaiting;
	const waitInfo = waiting ? (ctx.palette[waiting.agent] ?? AGENTS.custom) : null;
	if (!view.listening || view.problem) {
		parts.push(orb(ERROR, 0.35, 0.9));
		parts.push(`<text x="11" y="34" font-family="${SANS}" font-size="21" font-weight="800" fill="${TEXT}">Setup</text>`);
		wrapMono(view.problem || "starting…", 15, 4).forEach((line, i) =>
			parts.push(`<text x="11" y="${58 + i * 16}" font-family="${MONO}" font-size="13" fill="#D9DCE1">${esc(line)}</text>`),
		);
		return frame(parts.join(""));
	}
	if (view.connectedAgents === 0 && summary.total === 0) {
		if (theme === "clawd") parts.push(clawdScene({ activity: "idle", activitySince: ctx.now, uid: "hub", toolLabel: "" }, critterColor("claude", ""), "#FF5F2E", t, 96, 134, 3.6, ctx.animate));
		else parts.push(orb("#8D929B", 0.4, 0.9));
		parts.push(`<text x="11" y="34" font-family="${SANS}" font-size="21" font-weight="800" fill="${TEXT}">Connect</text>`);
		["your agents in", "the key settings"].forEach((line, i) =>
			parts.push(`<text x="11" y="${58 + i * 17}" font-family="${SANS}" font-size="15" fill="#C9CCD2">${line}</text>`),
		);
		return frame(parts.join(""));
	}

	const glow = waitInfo ? waitInfo.alert : summary.errors > 0 ? ERROR : summary.working > 0 ? "#7FB2FF" : "#7B8089";
	const w = ctx.animate ? wave(t, waiting ? 1.4 : 0.35) : 0.5;
	if (theme === "pulse" || theme === "glow") parts.push(orb(glow, waiting ? 0.5 + 0.25 * w : 0.32 + 0.08 * w, 0.9, 140));
	if (theme === "minimal") parts.push(`<rect x="0" y="0" width="5" height="144" fill="${glow}"/>`);

	const big = waiting ? summary.waiting : summary.working;
	const bigColor = waitInfo ? tint(waitInfo.alert, 0.1) : TEXT;
	const bigText = String(big);
	const bigW = sansWidth(bigText, 46) + 6;
	parts.push(`<text x="9" y="50" font-family="${SANS}" font-size="46" font-weight="800" fill="${bigColor}">${bigText}</text>`);
	const lx = Math.min(70, 9 + bigW);
	const avail = SIZE - lx - 6;
	if (waiting) {
		parts.push(`<text x="${lx}" y="30" font-family="${SANS}" font-size="16" font-weight="700" fill="${bigColor}">waiting</text>`);
		parts.push(`<text x="${lx}" y="47" font-family="${SANS}" font-size="13" fill="#D9DCE1">${esc(fitSans(`${summary.working} working`, 13, avail))}</text>`);
		parts.push(`<text x="11" y="71" font-family="${SANS}" font-size="14" font-weight="600" fill="${TEXT}">${esc(fitSans(waiting.title, 14, 124))}</text>`);
	} else {
		parts.push(`<text x="${lx}" y="30" font-family="${SANS}" font-size="16" font-weight="700" fill="${TEXT}">working</text>`);
		parts.push(`<text x="${lx}" y="47" font-family="${SANS}" font-size="13" fill="${DIM}">${esc(fitSans("none waiting", 13, avail))}</text>`);
		const doneBits = [summary.done > 0 ? `${summary.done} done` : "", summary.errors > 0 ? `${summary.errors} error${summary.errors > 1 ? "s" : ""}` : ""]
			.filter(Boolean)
			.join(" · ");
		if (doneBits) parts.push(`<text x="11" y="71" font-family="${SANS}" font-size="14" font-weight="600" fill="${TEXT}">${esc(doneBits)}</text>`);
	}

	// per-agent counts with coloured dots
	const entries = (Object.entries(summary.perAgent) as [AgentId, number][]).sort((a, b) => b[1] - a[1]).slice(0, 4);
	let x = 11;
	for (const [agent, count] of entries) {
		const c = (ctx.palette[agent] ?? AGENTS.custom).work;
		const label = String(count > 99 ? "99+" : count);
		parts.push(`<circle cx="${x + 4}" cy="88" r="4" fill="${c}"/><text x="${x + 11}" y="93" font-family="${SANS}" font-size="14" font-weight="700" fill="#E6E8EC">${label}</text>`);
		x += 15 + sansWidth(label, 14) + 9;
	}

	if (theme === "clawd") {
		// one critter tells the overall mood: waving when someone waits, typing when work goes on
		const mood = waiting ? "approval" : summary.errors > 0 ? "error" : summary.working > 0 ? "tool" : summary.done > 0 ? "done" : "idle";
		const color = critterColor(waiting?.agent ?? "claude", (waitInfo ?? AGENTS.claude).work);
		parts.push(clawdScene({ activity: mood, activitySince: ctx.now - 60_000, uid: "hub", toolLabel: "Bash" }, color, glow, t, 58, 138, 3.4, ctx.animate));
	} else {
		// one pip per session on this page
		const pips = view.pips.slice(0, 10);
		const n = Math.max(pips.length, 1);
		const step = Math.min(14, 120 / n);
		const startX = 72 - ((pips.length - 1) * step) / 2;
		pips.forEach((s, i) => {
			const info = ctx.palette[s.agent] ?? AGENTS.custom;
			const look = lookFor(s.activity, info);
			const r = WAITING.has(s.activity) ? 5 : 4.2;
			const shape =
				theme === "minimal"
					? `<rect x="${(startX + i * step - r).toFixed(1)}" y="${118 - r}" width="${r * 2}" height="${r * 2}" rx="1.5" fill="${look.color}" fill-opacity="${Math.max(0.35, look.brightness).toFixed(2)}"/>`
					: `<circle cx="${(startX + i * step).toFixed(1)}" cy="118" r="${r}" fill="${look.color}" fill-opacity="${Math.max(0.35, look.brightness).toFixed(2)}"/>`;
			parts.push(shape);
		});
	}
	if (view.pages > 1) {
		parts.push(`<text x="134" y="138" text-anchor="end" font-family="${SANS}" font-size="12" font-weight="600" fill="${DIM}">${view.page + 1}/${view.pages}</text>`);
	}
	return frame(parts.join(""));
}

/** Approve / Deny keys: lit only while an approval can be answered. */
export function decisionTile(kind: "allow" | "deny", target: Session | null, ctx: RenderContext): string {
	const color = kind === "allow" ? "#2FD27A" : "#FF4B3E";
	const label = kind === "allow" ? "Allow" : "Deny";
	const parts: string[] = [];
	if (target) {
		const t = ctx.now / 1000;
		const w = ctx.animate ? wave(t, 1.2) : 0.6;
		if (ctx.theme === "minimal") parts.push(`<rect x="0" y="0" width="5" height="144" fill="${color}"/><rect x="8" y="126" width="128" height="10" rx="5" fill="${color}" fill-opacity="${(0.4 + 0.6 * w).toFixed(2)}"/>`);
		else parts.push(orb(color, 0.7 + 0.25 * w, 1, 132));
		parts.push(`<text x="11" y="32" font-family="${SANS}" font-size="24" font-weight="800" fill="${TEXT}">${label}</text>`);
		parts.push(`<text x="11" y="54" font-family="${SANS}" font-size="14" font-weight="600" fill="#E6E8EC">${esc(fitSans(target.title, 14, 122))}</text>`);
		const summary = target.approval ? `${target.approval.tool}  ${target.approval.summary}` : target.toolLabel;
		wrapMono(summary, 15, 2).forEach((line, i) =>
			parts.push(`<text x="11" y="${74 + i * 16}" font-family="${MONO}" font-size="13" fill="#D9DCE1" xml:space="preserve">${esc(line)}</text>`),
		);
		parts.push(badge(target.agent, ctx.palette[target.agent] ?? AGENTS.custom));
	} else {
		parts.push(`<text x="11" y="32" font-family="${SANS}" font-size="24" font-weight="800" fill="#3A3E46">${label}</text>`);
		parts.push(`<text x="11" y="54" font-family="${SANS}" font-size="13" fill="#3A3E46">nothing pending</text>`);
		parts.push(`<circle cx="72" cy="112" r="10" fill="none" stroke="${shade(color, 0.6)}" stroke-opacity="0.35" stroke-width="3"/>`);
	}
	return frame(parts.join(""));
}

export function pageTile(page: number, pages: number, total: number): string {
	const dots = Array.from({ length: Math.min(pages, 6) }, (_, i) => {
		const x = 72 - ((Math.min(pages, 6) - 1) * 14) / 2 + i * 14;
		return `<circle cx="${x}" cy="104" r="${i === page ? 5 : 3.5}" fill="${i === page ? TEXT : "#4A4E56"}"/>`;
	}).join("");
	return frame(
		`<text x="72" y="58" text-anchor="middle" font-family="${SANS}" font-size="30" font-weight="800" fill="${TEXT}">${page + 1}/${Math.max(1, pages)}</text><text x="72" y="80" text-anchor="middle" font-family="${SANS}" font-size="13" fill="${DIM}">${total} session${total === 1 ? "" : "s"}</text>${dots}`,
	);
}

export function toDataUrl(svg: string): string {
	return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
