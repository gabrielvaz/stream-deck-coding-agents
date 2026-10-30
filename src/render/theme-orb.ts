/**
 * Orb themes: a glowing light rising from the bottom of the key.
 *
 *   pulse (default)  every working state pulses, each with its own motion and mark:
 *                    thinking = slow pulse + bouncing dots, tool = beat + radar ring,
 *                    writing = quick flutter, approval / question = double beat + "!" / "?",
 *                    compacting = squeeze, error = slow throb + "×", done = still + check,
 *                    idle = faint breath, offline = still grey
 *   glow             the calm look of the reference keypad: the light breathes softly
 */
import { WAITING } from "../core/agents";
import type { Session } from "../core/store";
import { AGENTS } from "../core/agents";
import {
	badge,
	darken,
	detailFor,
	detailText,
	frame,
	header,
	heartbeat,
	holdBar,
	lookFor,
	metricsFor,
	orb,
	phaseOf,
	pulse,
	type RenderContext,
	SANS,
	tint,
	waitingBorder,
	wave,
} from "./kit";

type Motion = { scale: number; brightness: number; squash: number; extra: string };

function pulseMotion(session: Session, color: string, base: number, t: number, phase: number, animate: boolean, cy: number): Motion {
	const still: Motion = { scale: 1, brightness: base, squash: 1, extra: "" };
	switch (session.activity) {
		case "thinking":
		case "starting": {
			if (!animate) return still;
			const p = pulse(t, 0.8, phase);
			// three dots bouncing in turn, like someone thinking out loud
			const dots = [0, 1, 2]
				.map((i) => {
					const lift = Math.max(0, Math.sin((t * 2.4 - i * 0.22) * Math.PI)) * 5;
					return `<circle cx="${60 + i * 12}" cy="${(cy - 22 - lift).toFixed(1)}" r="3.6" fill="#FFFFFF" fill-opacity="${(0.55 + 0.4 * (lift / 5)).toFixed(2)}"/>`;
				})
				.join("");
			return { scale: 0.86 + 0.16 * p, brightness: base * (0.72 + 0.28 * p), squash: 1, extra: dots };
		}
		case "tool": {
			if (!animate) return still;
			const hz = 1.1;
			const p = pulse(t, hz, phase);
			// a radar ring leaves the light on every beat
			const x = (((t * hz + phase) % 1) + 1) % 1;
			const ring = `<circle cx="72" cy="${cy}" r="${(30 + x * 62).toFixed(1)}" fill="none" stroke="${tint(color, 0.25)}" stroke-opacity="${(0.55 * (1 - x)).toFixed(3)}" stroke-width="${(4 - x * 2.5).toFixed(2)}"/>`;
			return { scale: 0.9 + 0.12 * p, brightness: base * (0.78 + 0.22 * p), squash: 1, extra: ring };
		}
		case "writing": {
			if (!animate) return still;
			const p = wave(t, 2.6, phase);
			return { scale: 0.95 + 0.06 * p, brightness: base * (0.85 + 0.15 * p), squash: 1, extra: "" };
		}
		case "approval":
		case "question": {
			const p = animate ? heartbeat(t, 84, phase) : 0.5;
			const mark = session.activity === "approval" ? "!" : "?";
			const glyph = `<text x="72" y="${cy + 10}" text-anchor="middle" font-family="${SANS}" font-size="${(26 + 6 * p).toFixed(1)}" font-weight="900" fill="${darken(color, 0.55)}">${mark}</text>`;
			return { scale: 0.86 + 0.2 * p, brightness: base * (0.75 + 0.25 * p), squash: 1, extra: glyph };
		}
		case "compacting": {
			const p = animate ? wave(t, 0.7, phase) : 0.5;
			return { scale: 1, brightness: base, squash: 0.7 + 0.3 * p, extra: "" };
		}
		case "error": {
			const p = animate ? pulse(t, 0.5, phase) : 0.5;
			const cross = `<path d="M64 ${cy - 6} l16 16 M80 ${cy - 6} l-16 16" stroke="${darken(color, 0.6)}" stroke-width="4.5" stroke-linecap="round"/>`;
			return { scale: 0.92 + 0.08 * p, brightness: base * (0.7 + 0.3 * p), squash: 1, extra: cross };
		}
		case "done": {
			const check = `<path d="M62 ${cy + 1} l7 7 l13 -14" fill="none" stroke="${darken(color, 0.62)}" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>`;
			return { scale: 1, brightness: base, squash: 1, extra: check };
		}
		case "idle": {
			const p = animate ? wave(t, 0.18, phase) : 0.5;
			return { scale: 0.94 + 0.05 * p, brightness: base * (0.82 + 0.18 * p), squash: 1, extra: "" };
		}
		default:
			return still;
	}
}

/** The calm reference look: soft breathing, faster while working, pulsing while waiting. */
function glowMotion(session: Session, base: number, t: number, phase: number, animate: boolean): Motion {
	const params: Record<string, [number, number]> = {
		approval: [0.34, 1.3],
		question: [0.34, 1.3],
		error: [0.1, 0.45],
		tool: [0.24, 0.95],
		writing: [0.2, 1.25],
		thinking: [0.3, 0.6],
		starting: [0.3, 0.6],
		compacting: [0.3, 0.4],
		idle: [0.12, 0.2],
	};
	const [breathe, speed] = params[session.activity] ?? [0, 0];
	if (!animate || speed === 0) return { scale: 1, brightness: base, squash: 1, extra: "" };
	const w = wave(t, speed, phase);
	return { scale: 1 - breathe * 0.3 + w * breathe * 0.45, brightness: base * (0.8 + 0.2 * w), squash: 1, extra: "" };
}

export function orbSession(session: Session, ctx: RenderContext, mode: "pulse" | "glow"): string {
	const info = ctx.palette[session.agent] ?? AGENTS.custom;
	const look = lookFor(session.activity, info);
	const m = metricsFor(ctx);
	const t = ctx.now / 1000;
	const phase = phaseOf(session.uid);
	const detail = detailFor(session, m);
	// the light sinks a little when there is text to read, so the words stay legible
	const cy = detail.lines.length > 2 ? 132 : 124;
	const motion = mode === "pulse" ? pulseMotion(session, look.color, look.brightness, t, phase, ctx.animate, cy) : glowMotion(session, look.brightness, t, phase, ctx.animate);

	const parts: string[] = [];
	parts.push(orb(look.color, motion.brightness, motion.scale, cy, motion.squash));
	// marks inside the light only when no text sits on top of it
	if (motion.extra && detail.lines.length <= 2) parts.push(motion.extra);
	if (WAITING.has(session.activity)) parts.push(waitingBorder(look.color, ctx));
	parts.push(header(session, ctx, look.label, m));
	parts.push(detailText(detail.lines, detail.color, m));
	if (session.subagents > 0) {
		parts.push(`<text x="11" y="132" font-family="${SANS}" font-size="14" font-weight="700" fill="#E6E8EC" fill-opacity="0.85">+${session.subagents}</text>`);
	}
	parts.push(badge(session.agent, info));
	parts.push(holdBar(ctx));
	return frame(parts.join(""));
}
