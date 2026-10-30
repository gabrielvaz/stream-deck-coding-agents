/**
 * Building blocks shared by every theme: colours, text layout, the orb, agent badges, timers.
 *
 * Tiles are SVG in a 144×144 view box; Stream Deck scales them to each device. Only features every
 * Stream Deck SVG rasterizer handles are used: radial gradients, plain text, rects, circles, paths.
 * No filters, masks or clip paths; anything outside the view box is clipped by the key.
 */
import { type Activity, type AgentId, type AgentInfo, WAITING, WORKING } from "../core/agents";
import type { Session } from "../core/store";
import { plainText } from "../core/util";

export const SIZE = 144;
export const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Helvetica, Arial, sans-serif";
export const MONO = "Menlo, 'SF Mono', Consolas, 'Cascadia Mono', 'DejaVu Sans Mono', monospace";
export const BG = "#050506";
export const TEXT = "#F2F3F5";
export const DIM = "#8D929B";
export const ERROR = "#FF3B30";

export type Palette = Record<AgentId, AgentInfo>;
export type ThemeId = "pulse" | "glow" | "clawd" | "minimal";

export type RenderContext = {
	now: number;
	palette: Palette;
	/** Draw moving frames (keys always move while an agent works; "low" just means fewer frames). */
	animate: boolean;
	theme?: ThemeId;
	/** 0..1 while an approval key is being held (fills a bar along the bottom edge). */
	holdProgress?: number;
	/** Bigger text, fewer detail lines: for 72 px keys. */
	large?: boolean;
	/** Scroll long titles (default). Off for still pictures. */
	marquee?: boolean;
};

export const esc = (text: string) =>
	text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

export const frame = (body: string, bg = BG) =>
	`<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}"><rect width="${SIZE}" height="${SIZE}" fill="${bg}"/>${body}</svg>`;

// ---------------------------------------------------------------------------------------------- colour

function hexToRgb(hex: string): [number, number, number] {
	const h = hex.replace("#", "");
	const full = h.length === 3 ? h.replace(/./g, (c) => c + c) : h.padEnd(6, "0").slice(0, 6);
	const n = parseInt(full, 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex([r, g, b]: [number, number, number]): string {
	return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("")}`;
}

/** Mix `hex` with white (amount 0..1). */
export function tint(hex: string, amount: number): string {
	const [r, g, b] = hexToRgb(hex);
	return rgbToHex([r + (255 - r) * amount, g + (255 - g) * amount, b + (255 - b) * amount]);
}

/** Mix `hex` towards grey/black (amount 0..1). */
export function shade(hex: string, amount: number): string {
	const [r, g, b] = hexToRgb(hex);
	const grey = (r + g + b) / 3;
	return rgbToHex([r + (grey * 0.6 - r) * amount, g + (grey * 0.6 - g) * amount, b + (grey * 0.6 - b) * amount]);
}

/** Darken towards black (amount 0..1). */
export function darken(hex: string, amount: number): string {
	const [r, g, b] = hexToRgb(hex);
	return rgbToHex([r * (1 - amount), g * (1 - amount), b * (1 - amount)]);
}

export function safeColor(value: unknown, fallback: string): string {
	return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value.trim()) ? value.trim() : fallback;
}

// ---------------------------------------------------------------------------------------------- state colours

export type Look = { color: string; label: string; brightness: number };

/** Colour of the light / mascot and of the state word, per state. */
export function lookFor(activity: Activity, info: AgentInfo): Look {
	switch (activity) {
		case "approval":
		case "question":
			return { color: info.alert, label: info.alert, brightness: 1 };
		case "error":
			return { color: ERROR, label: ERROR, brightness: 0.95 };
		case "tool":
			return { color: info.work, label: tint(info.work, 0.15), brightness: 1 };
		case "writing":
			return { color: info.work, label: TEXT, brightness: 1 };
		case "thinking":
		case "starting":
			return { color: info.work, label: TEXT, brightness: 0.95 };
		case "compacting":
			return { color: tint(info.work, 0.35), label: TEXT, brightness: 0.8 };
		case "done":
			return { color: tint(info.work, 0.7), label: TEXT, brightness: 0.92 };
		case "idle":
			return { color: info.work, label: TEXT, brightness: 0.72 };
		case "offline":
		default:
			return { color: "#9A9EA6", label: DIM, brightness: 0.3 };
	}
}

/** Phase-shifted per session so a full deck does not move in lockstep. */
export function phaseOf(uid: string): number {
	let h = 0;
	for (let i = 0; i < uid.length; i += 1) h = (h * 31 + uid.charCodeAt(i)) | 0;
	return (Math.abs(h) % 1000) / 1000;
}

/** 0..1 sine wave. */
export const wave = (t: number, hz: number, phase = 0) => (Math.sin((t * hz + phase) * Math.PI * 2) + 1) / 2;

/** A heartbeat: two quick beats then a rest (0..1). */
export function heartbeat(t: number, bpm: number, phase = 0): number {
	const period = 60 / bpm;
	const x = (((t + phase * period) % period) + period) % period / period;
	const beat = (center: number, width: number) => Math.max(0, 1 - Math.abs(x - center) / width);
	return Math.min(1, beat(0.12, 0.12) + 0.7 * beat(0.34, 0.1));
}

/** A single smooth pulse per period (0..1, sharp rise, slow fall). */
export function pulse(t: number, hz: number, phase = 0): number {
	const x = (((t * hz + phase) % 1) + 1) % 1;
	return x < 0.18 ? x / 0.18 : Math.pow(1 - (x - 0.18) / 0.82, 2);
}

// ---------------------------------------------------------------------------------------------- the orb

let gradientSeq = 0;
export const nextId = (prefix: string) => `${prefix}${(gradientSeq = (gradientSeq + 1) % 1_000_000)}`;

/** The glowing light rising from the bottom: a wide halo, a coloured body and a white-hot core. */
export function orb(color: string, brightness: number, scale: number, cy = 124, squash = 1): string {
	const id = nextId("o");
	const b = Math.max(0, Math.min(1, brightness));
	const op = (v: number) => (v * b).toFixed(3);
	const light = tint(color, 0.45);
	const halo = 78 * scale;
	const body = 46 * scale;
	const core = 25 * scale;
	const shape = (r: number, fill: string, dy = 0) =>
		squash === 1
			? `<circle cx="72" cy="${(cy + dy).toFixed(1)}" r="${r.toFixed(1)}" fill="${fill}"/>`
			: `<ellipse cx="72" cy="${(cy + dy).toFixed(1)}" rx="${(r * (2 - squash)).toFixed(1)}" ry="${(r * squash).toFixed(1)}" fill="${fill}"/>`;
	return `<defs><radialGradient id="${id}h" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="${color}" stop-opacity="${op(0.55)}"/><stop offset="0.45" stop-color="${color}" stop-opacity="${op(0.24)}"/><stop offset="0.75" stop-color="${color}" stop-opacity="${op(0.07)}"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></radialGradient><radialGradient id="${id}b" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="${light}" stop-opacity="${op(0.95)}"/><stop offset="0.5" stop-color="${color}" stop-opacity="${op(0.75)}"/><stop offset="0.82" stop-color="${color}" stop-opacity="${op(0.22)}"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></radialGradient><radialGradient id="${id}c" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#FFFFFF" stop-opacity="${op(0.95)}"/><stop offset="0.55" stop-color="#FFFFFF" stop-opacity="${op(0.55)}"/><stop offset="1" stop-color="${light}" stop-opacity="0"/></radialGradient></defs>${shape(halo, `url(#${id}h)`)}${shape(body, `url(#${id}b)`)}${shape(core, `url(#${id}c)`, 2)}`;
}

// ---------------------------------------------------------------------------------------------- badges

/** Small corner badge identifying the agent (generic glyphs, no third-party logos). */
export function badge(agent: AgentId, info: AgentInfo, x = 113, y = 113, size = 23): string {
	const cx = x + size / 2;
	const cy = y + size / 2;
	const k = size / 23;
	const r = 6 * k;
	switch (agent) {
		case "claude": {
			// warm square with a white eight-ray spark
			const rays = Array.from({ length: 8 }, (_, i) => {
				const a = (Math.PI / 4) * i + Math.PI / 8;
				const len = (i % 2 === 0 ? 7.5 : 6) * k;
				return `<line x1="${cx}" y1="${cy}" x2="${(cx + Math.cos(a) * len).toFixed(2)}" y2="${(cy + Math.sin(a) * len).toFixed(2)}"/>`;
			}).join("");
			return `<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${r}" fill="#D9643A"/><g stroke="#FFFFFF" stroke-width="${(2.2 * k).toFixed(2)}" stroke-linecap="round">${rays}</g>`;
		}
		case "codex":
			// light square with a terminal prompt
			return `<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${r}" fill="#E9EDF5" fill-opacity="0.92"/><path d="M${x + 5.5 * k} ${y + 7 * k} l${5 * k} ${4.5 * k} ${-5 * k} ${4.5 * k}" fill="none" stroke="#111318" stroke-width="${(2.3 * k).toFixed(2)}" stroke-linecap="round" stroke-linejoin="round"/><line x1="${x + 12 * k}" y1="${y + 17 * k}" x2="${x + 18 * k}" y2="${y + 17 * k}" stroke="#111318" stroke-width="${(2.3 * k).toFixed(2)}" stroke-linecap="round"/>`;
		case "antigravity":
			return `<text x="${cx}" y="${y + size - 5 * k}" text-anchor="middle" font-family="${SANS}" font-size="${(15 * k).toFixed(1)}" font-weight="700" fill="#C9CDD4" fill-opacity="0.85">Ag</text>`;
		case "gemini":
			return `<path d="M${cx} ${y + 1} C${cx + 1.5 * k} ${cy - 3 * k} ${cx + 3 * k} ${cy - 1.5 * k} ${x + size - 1} ${cy} C${cx + 3 * k} ${cy + 1.5 * k} ${cx + 1.5 * k} ${cy + 3 * k} ${cx} ${y + size - 1} C${cx - 1.5 * k} ${cy + 3 * k} ${cx - 3 * k} ${cy + 1.5 * k} ${x + 1} ${cy} C${cx - 3 * k} ${cy - 1.5 * k} ${cx - 1.5 * k} ${cy - 3 * k} ${cx} ${y + 1} Z" fill="${tint(info.work, 0.2)}"/>`;
		default: {
			const letters = info.name.replace(/[^A-Za-z0-9]/g, "").slice(0, 2) || "?";
			return `<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${r}" fill="${info.work}" fill-opacity="0.9"/><text x="${cx}" y="${y + size - 7 * k}" text-anchor="middle" font-family="${SANS}" font-size="${(11 * k).toFixed(1)}" font-weight="800" fill="#0B0C0E">${esc(letters)}</text>`;
		}
	}
}

// ---------------------------------------------------------------------------------------------- text

/** Rough width of proportional bold text, good enough to decide when to scroll. */
export function sansWidth(text: string, size: number): number {
	// deliberately generous: SF, Segoe UI and the Linux fallbacks differ by ~15 %
	let w = 0;
	for (const ch of text) {
		if (/[il.,:;'|!]/.test(ch)) w += 0.32;
		else if (/[mwMW@]/.test(ch)) w += 0.95;
		else if (/[A-Z0-9]/.test(ch)) w += 0.72;
		else if (ch === " ") w += 0.32;
		else if (ch.charCodeAt(0) > 0x2e80) w += 1.05;
		else w += 0.61;
	}
	return w * size;
}

/** Worst-case width of bold text (wide fallback fonts), so the state word never runs into the timer. */
export function boldWidth(text: string, size: number): number {
	let w = 0;
	for (const ch of text) w += /[il.,:;'|!]/.test(ch) ? 0.36 : /[mwMW]/.test(ch) ? 1.05 : /[A-Z0-9]/.test(ch) ? 0.8 : 0.68;
	return w * size;
}

/** Largest font size (down to 65 %) at which `text` fits in `avail` px. */
export function fitSize(text: string, size: number, avail: number): number {
	let s = size;
	while (s > size * 0.65 && boldWidth(text, s) > avail) s -= 0.5;
	return s;
}

export function fitSans(text: string, size: number, avail: number): string {
	let out = text;
	while (out.length > 1 && sansWidth(`${out}…`, size) > avail) out = out.slice(0, -1);
	return out === text ? text : `${out.trimEnd()}…`;
}

/** Title line: static when it fits, otherwise a continuous ticker (like the keypad). */
export function titleText(text: string, y: number, size: number, color: string, now: number, scroll: boolean, left = 11): string {
	const avail = SIZE - left - 8;
	const width = sansWidth(text, size);
	const common = `font-family="${SANS}" font-size="${size}" font-weight="700" fill="${color}"`;
	if (width <= avail || !scroll) {
		const shown = width <= avail ? text : fitSans(text, size, avail);
		return `<text x="${left}" y="${y}" ${common}>${esc(shown)}</text>`;
	}
	const gap = 36;
	const cycle = width + gap;
	const speed = 26; // px per second
	const rest = 1600; // ms resting at the start of each lap
	const lapMs = (cycle / speed) * 1000 + rest;
	const t = now % lapMs;
	const offset = t < rest ? 0 : ((t - rest) / 1000) * speed;
	const x = left - offset;
	return `<text x="${x.toFixed(1)}" y="${y}" ${common}>${esc(text)}</text><text x="${(x + cycle).toFixed(1)}" y="${y}" ${common}>${esc(text)}</text>`;
}

/** Word-wraps for a monospace font. Long words are split. */
export function wrapMono(text: string, width: number, maxLines: number, keepTail = false): string[] {
	// "Bash  npm test": the double space after the tool name survives as a no-break space
	const words = text.replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, "  ").trim().split(" ").filter(Boolean);
	const lines: string[] = [];
	let line = "";
	for (let word of words) {
		while (word.length > width) {
			if (line) {
				lines.push(line);
				line = "";
			}
			lines.push(word.slice(0, width));
			word = word.slice(width);
		}
		if (!line) line = word;
		else if (line.length + 1 + word.length <= width) line += ` ${word}`;
		else {
			lines.push(line);
			line = word;
		}
	}
	if (line) lines.push(line);
	if (lines.length <= maxLines) return lines;
	if (keepTail) return lines.slice(lines.length - maxLines);
	const head = lines.slice(0, maxLines);
	head[maxLines - 1] = `${head[maxLines - 1].slice(0, width - 1)}…`;
	return head;
}

// ---------------------------------------------------------------------------------------------- time

export function fmtClock(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 3600) return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
	return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export function fmtAge(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) return `${s}s`;
	if (s < 3600) return `${Math.floor(s / 60)}m`;
	if (s < 86400) return `${Math.floor(s / 3600)}h`;
	return `${Math.floor(s / 86400)}d`;
}

export function timerFor(session: Session, now: number): string {
	const ms = now - session.activitySince;
	return WORKING.has(session.activity) || WAITING.has(session.activity) ? fmtClock(ms) : fmtAge(ms);
}

// ---------------------------------------------------------------------------------------------- tile header + detail

/** Font metrics per text size. "large" suits 72 px keys (Stream Deck MK.2, Mini). */
export type Metrics = { title: number; label: number; timer: number; detail: number; chars: number; lineH: number; lines: number; y0: number; titleY: number; labelY: number };
export const METRICS: Record<"normal" | "large", Metrics> = {
	normal: { title: 19, label: 18, timer: 15, detail: 14, chars: 15, lineH: 16, lines: 4, y0: 70, titleY: 26, labelY: 49 },
	large: { title: 22, label: 21, timer: 17, detail: 17, chars: 12, lineH: 19, lines: 2, y0: 75, titleY: 27, labelY: 52 },
};

export const metricsFor = (ctx: RenderContext) => METRICS[ctx.large ? "large" : "normal"];

export function lastWords(text: string): string {
	const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => s.trim());
	return (sentences[sentences.length - 1] ?? "").trim();
}

/** The monospace lines under the state: tool, streamed words, question, last line, error. */
export function detailFor(session: Session, m: Metrics, maxLines = m.lines): { lines: string[]; color: string } {
	const color = "#D9DCE1";
	const n = (k: number) => Math.min(k, maxLines);
	switch (session.activity) {
		case "tool":
			return { lines: wrapMono(session.toolLabel, m.chars, n(2)), color };
		case "writing":
			return { lines: wrapMono(plainText(session.text), m.chars, n(4), true), color: TEXT };
		case "approval": {
			const text = session.approval ? `${session.approval.tool}  ${session.approval.summary}`.trim() : session.detail || session.toolLabel;
			return { lines: wrapMono(text, m.chars, n(2)), color };
		}
		case "question":
			return { lines: wrapMono(session.question?.text || session.detail || "needs your input", m.chars, n(3)), color };
		case "done":
			return { lines: wrapMono(lastWords(plainText(session.text)), m.chars, 1), color: "#C3C7CE" };
		case "error":
			return { lines: wrapMono(session.detail || "error", m.chars, n(2)), color: "#FFB3AE" };
		case "starting":
			return { lines: wrapMono(session.model, m.chars, 1), color: DIM };
		case "compacting":
			return { lines: ["context…"], color: DIM };
		default:
			return { lines: [], color };
	}
}

export const LABEL_TEXT: Record<Activity, string> = {
	starting: "Starting",
	thinking: "Thinking",
	tool: "Tool",
	writing: "Writing",
	compacting: "Compacting",
	approval: "Approval",
	question: "Question",
	done: "Done",
	error: "Error",
	idle: "Idle",
	offline: "Offline",
};

/** Title (scrolling), unread dot, state word and timer: the top of every session tile. */
export function header(session: Session, ctx: RenderContext, labelColor: string, m = metricsFor(ctx)): string {
	const parts: string[] = [];
	const waiting = WAITING.has(session.activity);
	const unseen = !session.seen && (session.activity === "done" || waiting || session.activity === "error");
	const titleColor = session.activity === "offline" ? "#6B7078" : TEXT;
	if (unseen) parts.push(`<circle cx="14" cy="${m.titleY - 6}" r="4.5" fill="${waiting ? labelColor : "#FFFFFF"}"/>`);
	parts.push(titleText(session.title, m.titleY, m.title, titleColor, ctx.now, ctx.animate && ctx.marquee !== false && session.activity !== "offline", unseen ? 22 : 11));
	const timer = timerFor(session, ctx.now);
	const timerW = timer.length * m.timer * 0.6;
	const label = LABEL_TEXT[session.activity];
	const labelSize = fitSize(label, m.label, SIZE - 11 - timerW - 10);
	parts.push(`<text x="11" y="${m.labelY}" font-family="${SANS}" font-size="${labelSize}" font-weight="700" fill="${labelColor}">${esc(label)}</text>`);
	parts.push(`<text x="134" y="${m.labelY}" text-anchor="end" font-family="${MONO}" font-size="${m.timer}" font-weight="600" fill="#C9CCD2">${esc(timer)}</text>`);
	return parts.join("");
}

export function detailText(lines: string[], color: string, m: Metrics, y0 = m.y0): string {
	return lines
		.map((line, i) => `<text x="11" y="${y0 + i * m.lineH}" font-family="${MONO}" font-size="${m.detail}" fill="${color}" xml:space="preserve">${esc(line)}</text>`)
		.join("");
}

/** Green bar filling along the bottom while an approval key is held. */
export function holdBar(ctx: RenderContext): string {
	if (!ctx.holdProgress || ctx.holdProgress <= 0) return "";
	const w = Math.max(6, SIZE * ctx.holdProgress);
	return `<rect x="0" y="136" width="${SIZE}" height="8" fill="#FFFFFF" fill-opacity="0.12"/><rect x="0" y="136" width="${w.toFixed(1)}" height="8" fill="#2FD27A"/>`;
}

/** Pulsing frame around keys that wait for you. */
export function waitingBorder(color: string, ctx: RenderContext, strength = 1): string {
	const t = ctx.now / 1000;
	const o = ctx.animate ? 0.4 + 0.45 * wave(t, 1.2) : 0.75;
	return `<rect x="2.5" y="2.5" width="139" height="139" rx="20" fill="none" stroke="${color}" stroke-opacity="${(o * strength).toFixed(2)}" stroke-width="5"/>`;
}
