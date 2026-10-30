/**
 * Minimal theme: flat and high-contrast, made for small keys and quick reading.
 * A bar along the bottom carries the motion: it sweeps while the agent works, blinks while it
 * waits for you, fills when done, and dims when idle.
 */
import { AGENTS, WAITING, WORKING } from "../core/agents";
import type { Session } from "../core/store";
import { badge, detailFor, detailText, frame, header, holdBar, lookFor, metricsFor, phaseOf, type RenderContext, wave } from "./kit";

function bar(session: Session, color: string, t: number, animate: boolean, phase: number): string {
	const y = 126;
	const h = 10;
	const track = `<rect x="8" y="${y}" width="128" height="${h}" rx="5" fill="#FFFFFF" fill-opacity="0.08"/>`;
	if (WORKING.has(session.activity)) {
		// a segment sweeping back and forth; quicker while writing
		const speed = session.activity === "writing" ? 0.9 : session.activity === "tool" ? 0.65 : 0.45;
		const k = animate ? (Math.sin((t * speed + phase) * Math.PI * 2) + 1) / 2 : 0.5;
		const w = 44;
		return `${track}<rect x="${(8 + k * (128 - w)).toFixed(1)}" y="${y}" width="${w}" height="${h}" rx="5" fill="${color}"/>`;
	}
	if (WAITING.has(session.activity)) {
		const o = animate ? 0.35 + 0.65 * wave(t, 1.4) : 1;
		return `${track}<rect x="8" y="${y}" width="128" height="${h}" rx="5" fill="${color}" fill-opacity="${o.toFixed(2)}"/>`;
	}
	if (session.activity === "done" || session.activity === "error") return `${track}<rect x="8" y="${y}" width="128" height="${h}" rx="5" fill="${color}"/>`;
	if (session.activity === "idle") {
		const o = animate ? 0.25 + 0.2 * wave(t, 0.2, phase) : 0.35;
		return `${track}<rect x="8" y="${y}" width="128" height="${h}" rx="5" fill="${color}" fill-opacity="${o.toFixed(2)}"/>`;
	}
	return track;
}

export function minimalSession(session: Session, ctx: RenderContext): string {
	const info = ctx.palette[session.agent] ?? AGENTS.custom;
	const look = lookFor(session.activity, info);
	const m = metricsFor(ctx);
	const t = ctx.now / 1000;
	const detail = detailFor(session, m, ctx.large ? 2 : 3);
	const parts: string[] = [];
	// a thin rail on the left in the state colour
	parts.push(`<rect x="0" y="0" width="5" height="144" fill="${look.color}" fill-opacity="${(0.4 + 0.6 * look.brightness).toFixed(2)}"/>`);
	parts.push(header(session, ctx, look.label === "#F2F3F5" ? look.color : look.label, m));
	parts.push(detailText(detail.lines, detail.color, m));
	parts.push(bar(session, look.color, t, ctx.animate, phaseOf(session.uid)));
	parts.push(badge(session.agent, info, 117, 100, 20));
	parts.push(holdBar(ctx));
	return frame(parts.join(""), "#0A0B0D");
}
