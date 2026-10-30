/**
 * Clawd theme: a pixel-art crab-critter acts out what the session is doing.
 *
 *   starting    pops up from the ground          thinking    bobs, looks around, thought bubbles
 *   tool        types on a laptop (or searches   writing     scribbles on paper with a pencil
 *               with a magnifier for reads)
 *   approval    waves at you with a "!" bubble   question    tilts its head with a "?" bubble
 *   compacting  gets squeezed flat and back      error       X eyes, shakes, smoke
 *   done        jumps with confetti, then grins  idle        sleeps, "z z z"
 *   offline     a translucent ghost floats by
 *
 * Claude Code sessions are terracotta; other agents get the same critter in their own colour.
 */
import { AGENTS, WAITING } from "../core/agents";
import type { Session } from "../core/store";
import { toolKind } from "../core/tools";
import {
	badge,
	darken,
	detailFor,
	detailText,
	ERROR,
	frame,
	header,
	holdBar,
	lookFor,
	metricsFor,
	phaseOf,
	type RenderContext,
	SANS,
	tint,
	waitingBorder,
} from "./kit";

export const CLAWD_COLOR = "#D97757";
const EYE = "#17181C";

export type Eyes = "open" | "blink" | "closed" | "happy" | "x" | "left" | "right" | "up";
export type Arms = "down" | "up" | "wave-a" | "wave-b" | "type-a" | "type-b" | "hold" | "scratch";
export type Legs = "stand" | "walk-a" | "walk-b" | "tuck" | "ghost";

export type Pose = {
	/** left edge and ground line of the 11×8 sprite */
	x: number;
	ground: number;
	/** pixel size */
	p: number;
	color: string;
	opacity?: number;
	eyes?: Eyes;
	arms?: Arms;
	legs?: Legs;
	/** 0..0.4: wider and flatter */
	squash?: number;
};

const n = (v: number) => (Math.round(v * 10) / 10).toString();

/**
 * The critter, 11 × 8 pixels: a 9 × 6 body, an arm on each side, four legs, two tall eyes.
 * Returns plain rects (crisp edges), so it scales cleanly to any key size.
 */
export function clawd(pose: Pose): string {
	const squash = pose.squash ?? 0;
	const px = pose.p * (1 + squash * 0.6);
	const py = pose.p * (1 - squash);
	const top = pose.ground - 8 * py;
	const left = pose.x - (11 * px - 11 * pose.p) / 2;
	const fill = pose.color;
	const op = pose.opacity ?? 1;
	const cell = (c: number, r: number, w: number, h: number, color = fill, o = op) =>
		`<rect x="${n(left + c * px)}" y="${n(top + r * py)}" width="${n(w * px + 0.3)}" height="${n(h * py + 0.3)}" fill="${color}"${o < 1 ? ` fill-opacity="${o}"` : ""}/>`;
	const out: string[] = [];

	// body with a lighter top edge and a darker bottom edge
	out.push(cell(1, 0, 9, 6));
	out.push(cell(1, 0, 9, 0.6, tint(fill, 0.22)));
	out.push(cell(1, 5.4, 9, 0.6, darken(fill, 0.18)));

	// arms
	switch (pose.arms ?? "down") {
		case "up":
			out.push(cell(0, -1.5, 1, 2.5), cell(10, -1.5, 1, 2.5));
			break;
		case "wave-a":
			out.push(cell(0, 3, 1, 2), cell(10, -1.5, 1, 2.5));
			break;
		case "wave-b":
			out.push(cell(0, 3, 1, 2), cell(10, 0, 1, 1.4), cell(11, -1, 1, 1.4));
			break;
		case "type-a":
			out.push(cell(0, 3, 1, 2), cell(10, 3.4, 1.6, 1));
			break;
		case "type-b":
			out.push(cell(0, 3, 1, 2), cell(10, 4.2, 1.6, 1));
			break;
		case "hold":
			out.push(cell(0, 3, 1, 2), cell(10, 3, 1.8, 1));
			break;
		case "scratch":
			out.push(cell(0, 3, 1, 2), cell(10, 0.5, 1, 2), cell(9.3, -0.6, 1.2, 1));
			break;
		default:
			out.push(cell(0, 3, 1, 2), cell(10, 3, 1, 2));
	}

	// legs
	const leg = (c: number, h: number) => cell(c, 6, 1, h);
	switch (pose.legs ?? "stand") {
		case "walk-a":
			out.push(leg(2, 2), leg(4, 1.2), leg(6, 2), leg(8, 1.2));
			break;
		case "walk-b":
			out.push(leg(2, 1.2), leg(4, 2), leg(6, 1.2), leg(8, 2));
			break;
		case "tuck":
			out.push(leg(2, 0.8), leg(4, 0.8), leg(6, 0.8), leg(8, 0.8));
			break;
		case "ghost":
			out.push(cell(1, 6, 1, 0.8), cell(3, 6, 1, 0.8), cell(5, 6, 1, 0.8), cell(7, 6, 1, 0.8), cell(9, 6, 1, 0.8));
			break;
		default:
			out.push(leg(2, 2), leg(4, 2), leg(6, 2), leg(8, 2));
	}

	// eyes
	const eye = (c: number, r: number, w: number, h: number) => cell(c, r, w, h, EYE, Math.min(1, op + 0.2));
	const line = (x1: number, y1: number, x2: number, y2: number) =>
		`<line x1="${n(left + x1 * px)}" y1="${n(top + y1 * py)}" x2="${n(left + x2 * px)}" y2="${n(top + y2 * py)}" stroke="${EYE}" stroke-width="${n(pose.p * 0.42)}" stroke-linecap="round"/>`;
	switch (pose.eyes ?? "open") {
		case "blink":
			out.push(eye(3, 2.2, 1, 0.45), eye(7, 2.2, 1, 0.45));
			break;
		case "closed":
			out.push(eye(2.8, 2.3, 1.4, 0.35), eye(6.8, 2.3, 1.4, 0.35));
			break;
		case "happy":
			out.push(line(2.9, 2.6, 3.5, 1.7), line(3.5, 1.7, 4.1, 2.6), line(6.9, 2.6, 7.5, 1.7), line(7.5, 1.7, 8.1, 2.6));
			break;
		case "x":
			out.push(line(2.8, 1.2, 4.2, 2.6), line(4.2, 1.2, 2.8, 2.6), line(6.8, 1.2, 8.2, 2.6), line(8.2, 1.2, 6.8, 2.6));
			break;
		case "left":
			out.push(eye(2.6, 1, 1, 2), eye(6.6, 1, 1, 2));
			break;
		case "right":
			out.push(eye(3.4, 1, 1, 2), eye(7.4, 1, 1, 2));
			break;
		case "up":
			out.push(eye(3, 0.6, 1, 1.8), eye(7, 0.6, 1, 1.8));
			break;
		default:
			out.push(eye(3, 1, 1, 2), eye(7, 1, 1, 2));
	}
	return `<g shape-rendering="crispEdges">${out.join("")}</g>`;
}

// ---------------------------------------------------------------------------------------------- props

function bubble(x: number, y: number, glyph: string, color: string, scale = 1): string {
	const w = 22 * scale;
	const h = 20 * scale;
	return `<rect x="${n(x - w / 2)}" y="${n(y - h / 2)}" width="${n(w)}" height="${n(h)}" rx="${n(6 * scale)}" fill="#FFFFFF"/><path d="M${n(x - 6 * scale)} ${n(y + h / 2 - 1)} l${n(-5 * scale)} ${n(7 * scale)} l${n(10 * scale)} ${n(-7 * scale)} z" fill="#FFFFFF"/><text x="${n(x)}" y="${n(y + 7 * scale)}" text-anchor="middle" font-family="${SANS}" font-size="${n(19 * scale)}" font-weight="900" fill="${color}">${glyph}</text>`;
}

function thoughtDots(x: number, y: number, t: number): string {
	const shown = Math.floor(t * 2) % 4; // 0..3 bubbles, then start over
	return [
		[x, y, 2.2],
		[x + 7, y - 7, 3.2],
		[x + 16, y - 16, 5],
	]
		.slice(0, shown)
		.map(([cx, cy, r]) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#FFFFFF" fill-opacity="0.85"/>`)
		.join("");
}

function laptop(x: number, ground: number, color: string, t: number): string {
	const lines = [0, 1, 2]
		.map((i) => {
			const w = 6 + ((Math.floor(t * 4) + i * 3) % 4) * 3;
			return `<rect x="${x + 4}" y="${ground - 25 + i * 5}" width="${w}" height="2" fill="${tint(color, 0.3)}" fill-opacity="0.9"/>`;
		})
		.join("");
	return `<g shape-rendering="crispEdges"><rect x="${x}" y="${ground - 29}" width="26" height="20" fill="#3A3F48"/><rect x="${x + 2}" y="${ground - 27}" width="22" height="16" fill="#0E1116"/>${lines}<rect x="${x - 6}" y="${ground - 6}" width="34" height="5" fill="#8A909A"/><rect x="${x - 6}" y="${ground - 6}" width="34" height="1.5" fill="#B4BAC4"/></g>`;
}

function magnifier(x: number, y: number): string {
	return `<circle cx="${x}" cy="${y}" r="8" fill="#BFE6FF" fill-opacity="0.35" stroke="#E9EDF5" stroke-width="3"/><line x1="${x + 6}" y1="${y + 6}" x2="${x + 13}" y2="${y + 13}" stroke="#C99A5B" stroke-width="4" stroke-linecap="round"/>`;
}

function paper(x: number, ground: number, t: number): string {
	const written = Math.floor((t * 3) % 12);
	const rows = [0, 1, 2, 3]
		.map((i) => {
			const w = Math.max(0, Math.min(16, (written - i * 3) * 5.5));
			return w > 0 ? `<rect x="${x + 4}" y="${ground - 24 + i * 5}" width="${w.toFixed(1)}" height="2" fill="#4A5160"/>` : "";
		})
		.join("");
	const tip = Math.min(16, Math.max(0, ((written % 3) + 1) * 5.5));
	const row = Math.min(3, Math.floor(written / 3));
	const pencil = `<g transform="translate(${(x + 4 + tip).toFixed(1)} ${ground - 25 + row * 5}) rotate(-35)"><rect x="0" y="-16" width="4" height="14" fill="#FFC94A"/><rect x="0" y="-18" width="4" height="3" fill="#FF8FA3"/><path d="M0 -2 l2 4 l2 -4 z" fill="#3A2A1A"/></g>`;
	return `<g shape-rendering="crispEdges"><rect x="${x}" y="${ground - 28}" width="24" height="26" fill="#F4F1E8"/>${rows}</g>${pencil}`;
}

function zzz(x: number, y: number, t: number): string {
	return [0, 1, 2]
		.map((i) => {
			const k = (t * 0.45 + i / 3) % 1;
			return `<text x="${(x + k * 14).toFixed(1)}" y="${(y - k * 24).toFixed(1)}" font-family="${SANS}" font-size="${(9 + k * 7).toFixed(1)}" font-weight="800" fill="#E6E8EC" fill-opacity="${(1 - k).toFixed(2)}">z</text>`;
		})
		.join("");
}

function confetti(t: number, seed: number): string {
	const colors = ["#FFB238", "#3F8CFF", "#1FD8A4", "#FF4F9A", "#B36BFF", "#FFFFFF"];
	return Array.from({ length: 16 }, (_, i) => {
		const x = 8 + ((i * 37 + seed * 13) % 128);
		const y = 56 + ((t * 38 + i * 23) % 84);
		const s = 3 + (i % 3);
		return `<rect x="${x}" y="${y.toFixed(1)}" width="${s}" height="${s}" fill="${colors[i % colors.length]}" transform="rotate(${((t * 180 + i * 40) % 360).toFixed(0)} ${x + s / 2} ${(y + s / 2).toFixed(1)})"/>`;
	}).join("");
}

function smoke(x: number, y: number, t: number): string {
	return [0, 1, 2]
		.map((i) => {
			const k = (t * 0.6 + i / 3) % 1;
			return `<circle cx="${(x + Math.sin((k + i) * 6) * 4).toFixed(1)}" cy="${(y - k * 26).toFixed(1)}" r="${(3 + k * 6).toFixed(1)}" fill="#9AA0A8" fill-opacity="${(0.6 * (1 - k)).toFixed(2)}"/>`;
		})
		.join("");
}

function twinkle(x: number, y: number, t: number, phase: number): string {
	const k = (Math.sin((t * 1.4 + phase) * Math.PI * 2) + 1) / 2;
	const r = 2 + k * 3;
	return `<path d="M${x} ${y - r * 1.6} L${x + r * 0.4} ${y - r * 0.4} L${x + r * 1.6} ${y} L${x + r * 0.4} ${y + r * 0.4} L${x} ${y + r * 1.6} L${x - r * 0.4} ${y + r * 0.4} L${x - r * 1.6} ${y} L${x - r * 0.4} ${y - r * 0.4} Z" fill="#FFF3C4" fill-opacity="${(0.4 + 0.6 * k).toFixed(2)}"/>`;
}

// ---------------------------------------------------------------------------------------------- scene

/** Colour of the critter for an agent: Clawd's own terracotta for Claude Code. */
export function critterColor(agent: string, work: string): string {
	return agent === "claude" ? CLAWD_COLOR : work;
}

/** The critter acting out a state, standing on `ground`, centred around `cx`. Used by tiles and the hub. */
export function clawdScene(session: Pick<Session, "activity" | "activitySince" | "uid" | "toolLabel">, color: string, alert: string, t: number, cx: number, ground: number, p: number, animate: boolean): string {
	const phase = phaseOf(session.uid);
	const tt = animate ? t : 0;
	const since = (t * 1000 - session.activitySince) / 1000;
	const x = cx - 5.5 * p;
	const step = (hz: number) => Math.floor(tt * hz + phase * 10) % 2 === 0;
	const blink = animate && (tt + phase * 7) % 3.4 < 0.14;
	const parts: string[] = [];
	switch (session.activity) {
		case "starting": {
			const rise = animate ? Math.max(0, 1 - since / 1.2) : 0;
			parts.push(clawd({ x, ground: ground + rise * 8 * p, p, color, eyes: blink ? "blink" : "up" }));
			break;
		}
		case "thinking": {
			const bob = animate ? Math.round(Math.sin(tt * Math.PI * 2 * 0.9 + phase * 6) * 1.5) : 0;
			const look: Eyes = blink ? "blink" : (["left", "up", "right", "up"] as Eyes[])[Math.floor(tt * 0.9 + phase * 4) % 4];
			parts.push(clawd({ x, ground: ground + bob, p, color, eyes: look, legs: "stand" }));
			parts.push(thoughtDots(cx + 5.5 * p + 2, ground - 8 * p - 2, tt));
			break;
		}
		case "tool": {
			const kind = toolKind(session.toolLabel.split(/\s/)[0]);
			if (kind === "read" || kind === "web") {
				const sway = animate ? Math.sin(tt * Math.PI * 2 * 0.8) * 6 : 0;
				parts.push(clawd({ x: x - 6, ground, p, color, eyes: sway > 0 ? "right" : "left", arms: "hold", legs: step(2) ? "walk-a" : "walk-b" }));
				parts.push(magnifier(cx + 5.5 * p + 4 + sway * 0.4, ground - 5 * p + sway * 0.3));
			} else {
				parts.push(clawd({ x: x - 10, ground, p, color, eyes: blink ? "blink" : "right", arms: step(6) ? "type-a" : "type-b" }));
				parts.push(laptop(cx + 5.5 * p - 4, ground, color, tt));
			}
			break;
		}
		case "writing":
			parts.push(clawd({ x: x - 10, ground, p, color, eyes: blink ? "blink" : "right", arms: step(4) ? "hold" : "type-b" }));
			parts.push(paper(cx + 5.5 * p - 2, ground, tt));
			break;
		case "approval": {
			const hop = animate ? Math.round(Math.abs(Math.sin(tt * Math.PI * 2 * 1.2)) * -3) : 0;
			parts.push(clawd({ x: x - 6, ground: ground + hop, p, color, eyes: "open", arms: step(3) ? "wave-a" : "wave-b" }));
			parts.push(bubble(cx + 5.5 * p + 6, ground - 8 * p - 8 + hop, "!", darken(alert, 0.1), animate ? 1 + 0.08 * Math.sin(tt * 12) : 1));
			break;
		}
		case "question": {
			const tilt = animate ? Math.sin(tt * Math.PI * 2 * 0.6) * 6 : 0;
			parts.push(
				`<g transform="rotate(${tilt.toFixed(1)} ${cx - 6} ${ground})">${clawd({ x: x - 6, ground, p, color, eyes: tilt > 0 ? "right" : "up", arms: "scratch" })}</g>`,
			);
			parts.push(bubble(cx + 5.5 * p + 6, ground - 8 * p - 8, "?", darken(alert, 0.1)));
			break;
		}
		case "compacting": {
			const sq = animate ? 0.15 + 0.2 * ((Math.sin(tt * Math.PI * 2 * 0.8) + 1) / 2) : 0.25;
			parts.push(clawd({ x, ground, p, color: tint(color, 0.2), eyes: "closed", squash: sq }));
			break;
		}
		case "error": {
			const shake = animate && (tt + phase) % 2 < 0.6 ? Math.round(Math.sin(tt * 50)) * 1.5 : 0;
			parts.push(clawd({ x: x + shake, ground, p, color, eyes: "x", arms: "down" }));
			parts.push(smoke(cx + 2 * p, ground - 8 * p - 4, tt));
			break;
		}
		case "done": {
			const party = animate && since < 8;
			const jump = party ? Math.round(Math.abs(Math.sin(tt * Math.PI * 2 * 1.4)) * -7) : 0;
			if (party) parts.push(confetti(tt, Math.floor(phase * 10)));
			parts.push(clawd({ x, ground: ground + jump, p, color, eyes: "happy", arms: party && step(3) ? "up" : party ? "wave-a" : "down" }));
			if (!party) parts.push(twinkle(cx + 6.5 * p, ground - 8 * p - 2, tt, phase), twinkle(cx - 6.8 * p, ground - 6 * p, tt, phase + 0.5));
			break;
		}
		case "idle": {
			const breathe = animate ? 0.03 + 0.03 * Math.sin(tt * Math.PI * 2 * 0.35) : 0.04;
			parts.push(clawd({ x, ground, p, color, eyes: "closed", legs: "tuck", squash: breathe }));
			parts.push(zzz(cx + 4 * p, ground - 7 * p, tt));
			break;
		}
		default: {
			// offline: a translucent ghost drifting
			const float = animate ? Math.sin(tt * Math.PI * 2 * 0.4 + phase * 6) * 3 : 0;
			parts.push(clawd({ x, ground: ground - 4 + float, p, color: "#AEB4BE", opacity: 0.35, eyes: "closed", legs: "ghost" }));
		}
	}
	return parts.join("");
}

export function clawdSession(session: Session, ctx: RenderContext): string {
	const info = ctx.palette[session.agent] ?? AGENTS.custom;
	const look = lookFor(session.activity, info);
	const m = metricsFor(ctx);
	const t = ctx.now / 1000;
	const color = session.activity === "error" ? tint(ERROR, 0.15) : critterColor(session.agent, info.work);
	const detail = detailFor(session, m, 1);
	const parts: string[] = [];
	// a faint pool of light under the critter, in the state colour
	parts.push(`<ellipse cx="62" cy="135" rx="48" ry="7" fill="${look.color}" fill-opacity="${(0.18 * look.brightness).toFixed(2)}"/>`);
	parts.push(clawdScene(session, color, info.alert, t, 62, 134, ctx.large ? 5.4 : 6, ctx.animate));
	if (WAITING.has(session.activity)) parts.push(waitingBorder(look.color, ctx));
	parts.push(header(session, ctx, look.label, m));
	if (!ctx.large) parts.push(detailText(detail.lines, detail.color, m, 68));
	parts.push(badge(session.agent, info, 123, 123, 17));
	parts.push(holdBar(ctx));
	return frame(parts.join(""));
}
