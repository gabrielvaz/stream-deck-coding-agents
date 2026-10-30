/**
 * Key tiles drawn as SVG (144×144 view box; Stream Deck scales it to every device).
 *
 * Layout, after the reference keypad:
 *   ┌───────────────────────┐
 *   │ title (marquee)       │   bold sans
 *   │ State          0:12   │   state word coloured when it needs attention, timer right
 *   │ Bash  npm test        │   monospace detail: tool, streamed text, last line, question…
 *   │        ( orb )     ▣  │   soft breathing light rising from the bottom, agent badge
 *   └───────────────────────┘
 *
 * Only features every Stream Deck SVG rasterizer handles are used: radial gradients, plain text,
 * paths. No filters, masks or clip paths; anything outside the view box is clipped by the key.
 */
import { type Activity, type AgentId, type AgentInfo, AGENTS, LABELS, WAITING, WORKING } from "../core/agents";
import type { Session, Summary } from "../core/store";


export const SIZE = 144;
const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Helvetica, Arial, sans-serif";
const MONO = "Menlo, 'SF Mono', Consolas, 'Cascadia Mono', 'DejaVu Sans Mono', monospace";
const BG = "#050506";
const TEXT = "#F2F3F5";
const DIM = "#8D929B";
const ERROR = "#FF3B30";

export type Palette = Record<AgentId, AgentInfo>;

export type RenderContext = {
	now: number;
	palette: Palette;
	/** 0 = still frames only. Otherwise frames are drawn for this time (ms). */
	animate: boolean;
	/** 0..1 while an approval key is being held (fills a bar along the bottom edge). */
	holdProgress?: number;
	/** Bigger text, fewer detail lines: for 72 px keys. */
	large?: boolean;
};

const esc = (text: string) =>
	text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

// ---------------------------------------------------------------------------------------------- colour helpers

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

export function safeColor(value: unknown, fallback: string): string {
	return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value.trim()) ? value.trim() : fallback;
}

// ---------------------------------------------------------------------------------------------- state → look

type Look = { orb: string; label: string; brightness: number; breathe: number; speed: number };

/**
 * Colour and motion per state. Working states move, waiting states pulse, idle breathes slowly,
 * done and offline stay still (as on the reference keypad).
 */
export function lookFor(activity: Activity, info: AgentInfo): Look {
	switch (activity) {
		case "approval":
		case "question":
			return { orb: info.alert, label: info.alert, brightness: 1, breathe: 0.34, speed: 1.3 };
		case "error":
			return { orb: ERROR, label: ERROR, brightness: 0.95, breathe: 0.1, speed: 0.45 };
		case "tool":
			return { orb: info.work, label: tint(info.work, 0.15), brightness: 1, breathe: 0.24, speed: 0.95 };
		case "writing":
			return { orb: info.work, label: TEXT, brightness: 1, breathe: 0.2, speed: 1.25 };
		case "thinking":
		case "starting":
			return { orb: info.work, label: TEXT, brightness: 0.95, breathe: 0.3, speed: 0.6 };
		case "compacting":
			return { orb: tint(info.work, 0.35), label: TEXT, brightness: 0.8, breathe: 0.3, speed: 0.4 };
		case "done":
			return { orb: tint(info.work, 0.7), label: TEXT, brightness: 0.92, breathe: 0, speed: 0 };
		case "idle":
			return { orb: info.work, label: TEXT, brightness: 0.72, breathe: 0.12, speed: 0.2 };
		case "offline":
		default:
			return { orb: "#9A9EA6", label: DIM, brightness: 0.3, breathe: 0, speed: 0 };
	}
}

/** Phase-shifted per session so a full deck does not breathe in lockstep. */
function phaseOf(uid: string): number {
	let h = 0;
	for (let i = 0; i < uid.length; i += 1) h = (h * 31 + uid.charCodeAt(i)) | 0;
	return (Math.abs(h) % 1000) / 1000;
}

// ---------------------------------------------------------------------------------------------- pieces

let gradientSeq = 0;

/** The glowing light rising from the bottom: a wide halo, a coloured body and a white-hot core. */
function orb(color: string, brightness: number, scale: number, cy = 124): string {
	gradientSeq = (gradientSeq + 1) % 1_000_000;
	const id = `o${gradientSeq}`;
	const b = Math.max(0, Math.min(1, brightness));
	const op = (v: number) => (v * b).toFixed(3);
	const light = tint(color, 0.45);
	const halo = 78 * scale;
	const body = 46 * scale;
	const core = 25 * scale;
	return `<defs><radialGradient id="${id}h" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="${color}" stop-opacity="${op(0.55)}"/><stop offset="0.45" stop-color="${color}" stop-opacity="${op(0.24)}"/><stop offset="0.75" stop-color="${color}" stop-opacity="${op(0.07)}"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></radialGradient><radialGradient id="${id}b" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="${light}" stop-opacity="${op(0.95)}"/><stop offset="0.5" stop-color="${color}" stop-opacity="${op(0.75)}"/><stop offset="0.82" stop-color="${color}" stop-opacity="${op(0.22)}"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></radialGradient><radialGradient id="${id}c" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#FFFFFF" stop-opacity="${op(0.95)}"/><stop offset="0.55" stop-color="#FFFFFF" stop-opacity="${op(0.55)}"/><stop offset="1" stop-color="${light}" stop-opacity="0"/></radialGradient></defs><circle cx="72" cy="${cy}" r="${halo.toFixed(1)}" fill="url(#${id}h)"/><circle cx="72" cy="${cy}" r="${body.toFixed(1)}" fill="url(#${id}b)"/><circle cx="72" cy="${(cy + 2).toFixed(1)}" r="${core.toFixed(1)}" fill="url(#${id}c)"/>`;
}

/** Small corner badge identifying the agent (generic glyphs, no third-party logos). */
export function badge(agent: AgentId, info: AgentInfo, x = 113, y = 113, size = 23): string {
	const cx = x + size / 2;
	const cy = y + size / 2;
	const r = 6;
	switch (agent) {
		case "claude": {
			// warm square with a white eight-ray spark
			const rays = Array.from({ length: 8 }, (_, i) => {
				const a = (Math.PI / 4) * i + Math.PI / 8;
				const len = i % 2 === 0 ? 7.5 : 6;
				return `<line x1="${cx}" y1="${cy}" x2="${(cx + Math.cos(a) * len).toFixed(2)}" y2="${(cy + Math.sin(a) * len).toFixed(2)}"/>`;
			}).join("");
			return `<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${r}" fill="#D9643A"/><g stroke="#FFFFFF" stroke-width="2.2" stroke-linecap="round">${rays}</g>`;
		}
		case "codex":
			// light square with a terminal prompt
			return `<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${r}" fill="#E9EDF5" fill-opacity="0.92"/><path d="M${x + 5.5} ${y + 7} l5 4.5 -5 4.5" fill="none" stroke="#111318" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/><line x1="${x + 12}" y1="${y + 17}" x2="${x + 18}" y2="${y + 17}" stroke="#111318" stroke-width="2.3" stroke-linecap="round"/>`;
		case "antigravity":
			return `<text x="${cx}" y="${y + size - 5}" text-anchor="middle" font-family="${SANS}" font-size="15" font-weight="700" fill="#C9CDD4" fill-opacity="0.85">Ag</text>`;
		case "gemini":
			return `<path d="M${cx} ${y + 1} C${cx + 1.5} ${cy - 3} ${cx + 3} ${cy - 1.5} ${x + size - 1} ${cy} C${cx + 3} ${cy + 1.5} ${cx + 1.5} ${cy + 3} ${cx} ${y + size - 1} C${cx - 1.5} ${cy + 3} ${cx - 3} ${cy + 1.5} ${x + 1} ${cy} C${cx - 3} ${cy - 1.5} ${cx - 1.5} ${cy - 3} ${cx} ${y + 1} Z" fill="${tint(info.work, 0.2)}"/>`;
		default:
			return `<circle cx="${cx}" cy="${cy}" r="${size / 2 - 3}" fill="none" stroke="${info.work}" stroke-width="2.5"/>`;
	}
}

// ---------------------------------------------------------------------------------------------- text helpers

/** Rough width of proportional bold text, good enough to decide when to scroll. */
function sansWidth(text: string, size: number): number {
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

/** Title line: static when it fits, otherwise a continuous ticker (like the keypad). */
function titleText(text: string, y: number, size: number, color: string, now: number, animate: boolean, left = 11): string {
	const avail = SIZE - left - 8;
	const width = sansWidth(text, size);
	const common = `font-family="${SANS}" font-size="${size}" font-weight="700" fill="${color}"`;
	if (width <= avail || !animate) {
		const shown = width <= avail ? text : fitSans(text, size, avail);
		return `<text x="${left}" y="${y}" ${common}>${esc(shown)}</text>`;
	}
	const gap = 36;
	const cycle = width + gap;
	const speed = 26; // px per second
	const pause = 1600; // ms resting at the start of each lap
	const lapMs = (cycle / speed) * 1000 + pause;
	const t = now % lapMs;
	const offset = t < pause ? 0 : ((t - pause) / 1000) * speed;
	const x = left - offset;
	return `<text x="${x.toFixed(1)}" y="${y}" ${common}>${esc(text)}</text><text x="${(x + cycle).toFixed(1)}" y="${y}" ${common}>${esc(text)}</text>`;
}

function fitSans(text: string, size: number, avail: number): string {
	let out = text;
	while (out.length > 1 && sansWidth(`${out}…`, size) > avail) out = out.slice(0, -1);
	return out === text ? text : `${out.trimEnd()}…`;
}

/** Word-wraps for a monospace font. Long words are split. */
export function wrapMono(text: string, width: number, maxLines: number, keepTail = false): string[] {
	// "Bash  npm test": the double space after the tool name survives as a no-break space
	const words = text.replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, "\u00a0 ").trim().split(" ").filter(Boolean);
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

function timerFor(session: Session, now: number): string {
	const ms = now - session.activitySince;
	return WORKING.has(session.activity) || WAITING.has(session.activity) ? fmtClock(ms) : fmtAge(ms);
}

// ---------------------------------------------------------------------------------------------- detail lines

/** Font metrics per text size. "large" suits 72 px keys (Stream Deck MK.2, Mini). */
type Metrics = { title: number; label: number; timer: number; detail: number; chars: number; lineH: number; lines: number; y0: number };
const METRICS: Record<"normal" | "large", Metrics> = {
	normal: { title: 19, label: 18, timer: 15, detail: 14, chars: 15, lineH: 16, lines: 4, y0: 70 },
	large: { title: 22, label: 21, timer: 17, detail: 17, chars: 12, lineH: 19, lines: 2, y0: 75 },
};

function detailFor(session: Session, m: Metrics): { lines: string[]; color: string } {
	const color = "#D9DCE1";
	const n = (k: number) => Math.min(k, m.lines);
	switch (session.activity) {
		case "tool":
			return { lines: wrapMono(session.toolLabel, m.chars, n(2)), color };
		case "writing":
			return { lines: wrapMono(session.text, m.chars, n(4), true), color: TEXT };
		case "approval": {
			const text = session.approval ? `${session.approval.tool}  ${session.approval.summary}`.trim() : session.detail || session.toolLabel;
			return { lines: wrapMono(text, m.chars, n(2)), color };
		}
		case "question":
			return { lines: wrapMono(session.question?.text || session.detail || "needs your input", m.chars, n(3)), color };
		case "done":
			return { lines: wrapMono(lastWords(session.text), m.chars, 1), color: "#C3C7CE" };
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

function lastWords(text: string): string {
	const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => s.trim());
	return (sentences[sentences.length - 1] ?? "").trim();
}

/** Largest font size (down to 70 %) at which `text` fits in `avail` px. */
function fitSize(text: string, size: number, avail: number): number {
	let s = size;
	while (s > size * 0.7 && sansWidth(text, s) > avail) s -= 0.5;
	return s;
}

// ---------------------------------------------------------------------------------------------- tiles

const frame = (body: string) =>
	`<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}"><rect width="${SIZE}" height="${SIZE}" fill="${BG}"/>${body}</svg>`;

export function sessionTile(session: Session, ctx: RenderContext): string {
	const info = ctx.palette[session.agent] ?? AGENTS.custom;
	const look = lookFor(session.activity, info);
	const m = METRICS[ctx.large ? "large" : "normal"];
	const t = ctx.now / 1000;
	const phase = phaseOf(session.uid);
	let scale = 1;
	let brightness = look.brightness;
	if (ctx.animate && look.speed > 0) {
		const wave = (Math.sin((t * look.speed + phase) * Math.PI * 2) + 1) / 2; // 0..1
		scale = 1 - look.breathe * 0.3 + wave * look.breathe * 0.45;
		brightness = look.brightness * (0.8 + 0.2 * wave);
	}
	const waiting = WAITING.has(session.activity);
	const unseen = !session.seen && (session.activity === "done" || waiting || session.activity === "error");
	const titleColor = session.activity === "offline" ? "#6B7078" : TEXT;
	const titleLeft = unseen ? 22 : 11;
	const detail = detailFor(session, m);
	const still = session.activity === "offline";

	const parts: string[] = [];
	// the orb sinks a little when there is text to read, so the words stay legible
	parts.push(orb(look.orb, brightness, scale, detail.lines.length > 2 ? 132 : 124));
	if (waiting) {
		const pulse = ctx.animate ? 0.45 + 0.4 * ((Math.sin(t * Math.PI * 2 * 1.2) + 1) / 2) : 0.75;
		parts.push(`<rect x="2.5" y="2.5" width="139" height="139" rx="20" fill="none" stroke="${look.orb}" stroke-opacity="${pulse.toFixed(2)}" stroke-width="5"/>`);
	}
	if (unseen) parts.push(`<circle cx="14" cy="${m.title === 19 ? 20 : 19}" r="4.5" fill="${waiting ? look.orb : "#FFFFFF"}"/>`);
	parts.push(titleText(session.title, m.title === 19 ? 26 : 27, m.title, titleColor, ctx.now, ctx.animate && !still, titleLeft));

	const timer = timerFor(session, ctx.now);
	const timerW = timer.length * m.timer * 0.6;
	const label = LABELS[session.activity];
	const labelY = m.title === 19 ? 49 : 52;
	const labelSize = fitSize(label, m.label, SIZE - 11 - timerW - 14);
	parts.push(`<text x="11" y="${labelY}" font-family="${SANS}" font-size="${labelSize}" font-weight="700" fill="${look.label}">${esc(label)}</text>`);
	parts.push(`<text x="134" y="${labelY}" text-anchor="end" font-family="${MONO}" font-size="${m.timer}" font-weight="600" fill="#C9CCD2">${esc(timer)}</text>`);
	detail.lines.forEach((line, i) => {
		parts.push(`<text x="11" y="${m.y0 + i * m.lineH}" font-family="${MONO}" font-size="${m.detail}" fill="${detail.color}" xml:space="preserve">${esc(line)}</text>`);
	});
	if (session.subagents > 0) {
		parts.push(`<text x="11" y="132" font-family="${SANS}" font-size="14" font-weight="700" fill="#E6E8EC" fill-opacity="0.85">+${session.subagents}</text>`);
	}
	parts.push(badge(session.agent, info));
	if (ctx.holdProgress && ctx.holdProgress > 0) {
		const w = Math.max(6, 144 * ctx.holdProgress);
		parts.push(`<rect x="0" y="136" width="144" height="8" fill="#FFFFFF" fill-opacity="0.12"/><rect x="0" y="136" width="${w.toFixed(1)}" height="8" fill="#2FD27A"/>`);
	}
	return frame(parts.join(""));
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
	const parts: string[] = [];
	const t = ctx.now / 1000;
	const waiting = summary.firstWaiting;
	const waitInfo = waiting ? ctx.palette[waiting.agent] ?? AGENTS.custom : null;
	if (!view.listening || view.problem) {
		parts.push(orb("#FF3B30", 0.35, 0.9));
		parts.push(`<text x="11" y="34" font-family="${SANS}" font-size="21" font-weight="800" fill="${TEXT}">Setup</text>`);
		wrapMono(view.problem || "starting…", 15, 4).forEach((line, i) =>
			parts.push(`<text x="11" y="${58 + i * 16}" font-family="${MONO}" font-size="13" fill="#D9DCE1">${esc(line)}</text>`),
		);
		return frame(parts.join(""));
	}
	if (view.connectedAgents === 0 && summary.total === 0) {
		parts.push(orb("#8D929B", 0.4, 0.9));
		parts.push(`<text x="11" y="34" font-family="${SANS}" font-size="21" font-weight="800" fill="${TEXT}">Connect</text>`);
		["your agents in", "the key settings"].forEach((line, i) =>
			parts.push(`<text x="11" y="${58 + i * 17}" font-family="${SANS}" font-size="15" fill="#C9CCD2">${line}</text>`),
		);
		return frame(parts.join(""));
	}

	const glow = waitInfo ? waitInfo.alert : summary.errors > 0 ? ERROR : summary.working > 0 ? "#7FB2FF" : "#7B8089";
	const wave = ctx.animate ? (Math.sin(t * Math.PI * 2 * (waiting ? 1.4 : 0.35)) + 1) / 2 : 0.5;
	parts.push(orb(glow, waiting ? 0.5 + 0.25 * wave : 0.32 + 0.08 * wave, 0.9, 140));

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
		parts.push(`<circle cx="${x + 4}" cy="${88}" r="4" fill="${c}"/><text x="${x + 11}" y="93" font-family="${SANS}" font-size="14" font-weight="700" fill="#E6E8EC">${label}</text>`);
		x += 15 + sansWidth(label, 14) + 9;
	}

	// one pip per session on this page
	const pips = view.pips.slice(0, 10);
	const n = Math.max(pips.length, 1);
	const step = Math.min(14, 120 / n);
	const startX = 72 - ((pips.length - 1) * step) / 2;
	pips.forEach((s, i) => {
		const info = ctx.palette[s.agent] ?? AGENTS.custom;
		const look = lookFor(s.activity, info);
		const r = WAITING.has(s.activity) ? 5 : 4.2;
		parts.push(`<circle cx="${(startX + i * step).toFixed(1)}" cy="118" r="${r}" fill="${look.orb}" fill-opacity="${Math.max(0.35, look.brightness).toFixed(2)}"/>`);
	});
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
		const wave = ctx.animate ? (Math.sin(t * Math.PI * 2 * 1.2) + 1) / 2 : 0.6;
		parts.push(orb(color, 0.7 + 0.25 * wave, 1, 132));
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


