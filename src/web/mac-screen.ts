/// <reference lib="dom" />
/**
 * The laptop screen of the website: a macOS-like desktop drawn on a canvas, with the terminal of
 * the session the visitor last opened from the Stream Deck. Used as a texture on the 3D laptop.
 */
import { AGENTS, LABELS, WAITING, WORKING } from "../core/agents";
import { lookFor } from "../render/kit";
import type { Line, World } from "./world";

export const SCREEN_W = 1280;
export const SCREEN_H = 800;

const MONO = "'SF Mono', Menlo, Consolas, 'DejaVu Sans Mono', monospace";
const UI = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Helvetica, Arial, sans-serif";
const SPIN = ["✻", "✶", "✷", "✸", "✹", "✺"];
const AGENT_TITLE: Record<string, string> = { claude: "Claude Code", codex: "Codex", antigravity: "Antigravity", gemini: "Gemini CLI" };

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
	ctx.beginPath();
	ctx.moveTo(x + r, y);
	ctx.arcTo(x + w, y, x + w, y + h, r);
	ctx.arcTo(x + w, y + h, x, y + h, r);
	ctx.arcTo(x, y + h, x, y, r);
	ctx.arcTo(x, y, x + w, y, r);
	ctx.closePath();
}

function wrap(ctx: CanvasRenderingContext2D, text: string, width: number): string[] {
	const words = text.split(/\s+/).filter(Boolean);
	const out: string[] = [];
	let line = "";
	for (const word of words) {
		const next = line ? `${line} ${word}` : word;
		if (ctx.measureText(next).width > width && line) {
			out.push(line);
			line = word;
		} else line = next;
	}
	if (line) out.push(line);
	return out.length ? out : [""];
}

export class MacScreen {
	readonly canvas: HTMLCanvasElement;
	private ctx: CanvasRenderingContext2D;
	private focusedAt = 0;
	private lastFocused = "";

	constructor(private readonly world: World) {
		this.canvas = document.createElement("canvas");
		this.canvas.width = SCREEN_W;
		this.canvas.height = SCREEN_H;
		this.ctx = this.canvas.getContext("2d") as CanvasRenderingContext2D;
	}

	draw(now: number): void {
		const ctx = this.ctx;
		const w = this.world;
		if (w.focused !== this.lastFocused) {
			this.lastFocused = w.focused;
			this.focusedAt = now;
		}
		this.wallpaper(now);
		this.menuBar(now);
		this.dock();

		// the terminal window pops forward when a key opens it
		const k = Math.min(1, (now - this.focusedAt) / 260);
		const ease = 1 - Math.pow(1 - k, 3);
		const scale = 0.965 + 0.035 * ease;
		ctx.save();
		ctx.globalAlpha = 0.55 + 0.45 * ease;
		ctx.translate(SCREEN_W / 2, SCREEN_H / 2 + 6);
		ctx.scale(scale, scale);
		ctx.translate(-SCREEN_W / 2, -SCREEN_H / 2 - 6);
		this.terminal(now);
		ctx.restore();
		this.toast(now);
	}

	private wallpaper(now: number): void {
		const ctx = this.ctx;
		const g = ctx.createLinearGradient(0, 0, SCREEN_W, SCREEN_H);
		g.addColorStop(0, "#141a33");
		g.addColorStop(0.55, "#2a1636");
		g.addColorStop(1, "#3b1a22");
		ctx.fillStyle = g;
		ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);
		const t = now / 1000;
		const blob = (x: number, y: number, r: number, color: string) => {
			const rg = ctx.createRadialGradient(x, y, 0, x, y, r);
			rg.addColorStop(0, color);
			rg.addColorStop(1, "rgba(0,0,0,0)");
			ctx.fillStyle = rg;
			ctx.fillRect(x - r, y - r, r * 2, r * 2);
		};
		blob(260 + Math.sin(t * 0.2) * 40, 640, 520, "rgba(255,150,60,0.30)");
		blob(1050, 180 + Math.cos(t * 0.17) * 30, 560, "rgba(70,120,255,0.32)");
		blob(800, 760, 420, "rgba(31,216,164,0.16)");
	}

	private menuBar(now: number): void {
		const ctx = this.ctx;
		ctx.fillStyle = "rgba(10,10,14,0.45)";
		ctx.fillRect(0, 0, SCREEN_W, 30);
		ctx.font = `600 15px ${UI}`;
		ctx.fillStyle = "#f2f3f5";
		ctx.textBaseline = "middle";
		ctx.fillText("Terminal", 22, 15);
		ctx.font = `400 15px ${UI}`;
		ctx.fillStyle = "rgba(242,243,245,0.85)";
		let x = 108;
		for (const item of ["Shell", "Edit", "View", "Window", "Help"]) {
			ctx.fillText(item, x, 15);
			x += ctx.measureText(item).width + 22;
		}
		// a tiny Stream Deck glyph and the clock on the right
		const d = new Date(now);
		const clock = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
		ctx.textAlign = "right";
		ctx.fillText(clock, SCREEN_W - 20, 15);
		ctx.textAlign = "left";
		const gx = SCREEN_W - 20 - ctx.measureText(clock).width - 34;
		ctx.fillStyle = "rgba(242,243,245,0.9)";
		for (let r = 0; r < 2; r += 1) for (let c = 0; c < 3; c += 1) ctx.fillRect(gx + c * 6, 9 + r * 6, 4.5, 4.5);
		ctx.textBaseline = "alphabetic";
	}

	private dock(): void {
		const ctx = this.ctx;
		const icons = ["#3a3f4b", "#1f6feb", "#0f1115", "#ffb238", "#1fd8a4", "#8c7cff"];
		const size = 46;
		const gap = 12;
		const total = icons.length * size + (icons.length - 1) * gap + 24;
		const x0 = (SCREEN_W - total) / 2;
		ctx.fillStyle = "rgba(255,255,255,0.14)";
		roundRect(ctx, x0, SCREEN_H - 70, total, 62, 18);
		ctx.fill();
		icons.forEach((c, i) => {
			ctx.fillStyle = c;
			roundRect(ctx, x0 + 12 + i * (size + gap), SCREEN_H - 62, size, size, 11);
			ctx.fill();
		});
		// the terminal icon: a prompt glyph
		const tx = x0 + 12 + 2 * (size + gap);
		ctx.strokeStyle = "#e9edf5";
		ctx.lineWidth = 3;
		ctx.beginPath();
		ctx.moveTo(tx + 12, SCREEN_H - 49);
		ctx.lineTo(tx + 21, SCREEN_H - 41);
		ctx.lineTo(tx + 12, SCREEN_H - 33);
		ctx.stroke();
	}

	private terminal(now: number): void {
		const ctx = this.ctx;
		const w = this.world;
		const uid = w.focused;
		const actor = w.actorOf(uid);
		const session = w.store.get(uid);
		const X = 44;
		const Y = 44;
		const W = SCREEN_W - 88;
		const H = SCREEN_H - 124;

		ctx.save();
		ctx.shadowColor = "rgba(0,0,0,0.55)";
		ctx.shadowBlur = 40;
		ctx.shadowOffsetY = 16;
		ctx.fillStyle = "#0b0d11";
		roundRect(ctx, X, Y, W, H, 14);
		ctx.fill();
		ctx.restore();
		ctx.save();
		roundRect(ctx, X, Y, W, H, 14);
		ctx.clip();

		// title bar with traffic lights
		ctx.fillStyle = "#1c1f26";
		ctx.fillRect(X, Y, W, 38);
		["#ff5f57", "#febc2e", "#28c840"].forEach((c, i) => {
			ctx.fillStyle = c;
			ctx.beginPath();
			ctx.arc(X + 22 + i * 22, Y + 19, 7, 0, Math.PI * 2);
			ctx.fill();
		});
		ctx.font = `600 15px ${UI}`;
		ctx.fillStyle = "#c9ccd2";
		ctx.textAlign = "center";
		ctx.fillText(actor ? `${actor.command} — ~/${actor.project}` : "Terminal", X + W / 2, Y + 24);
		ctx.textAlign = "left";

		// one tab per session, with its state colour
		const sessions = [...w.runs.keys()];
		const tabW = W / sessions.length;
		sessions.forEach((id, i) => {
			const s = w.store.get(id);
			const a = w.actorOf(id);
			if (!s || !a) return;
			const active = id === uid;
			ctx.fillStyle = active ? "#0b0d11" : "#15181e";
			ctx.fillRect(X + i * tabW, Y + 38, tabW, 34);
			ctx.fillStyle = "#23262e";
			ctx.fillRect(X + (i + 1) * tabW - 1, Y + 42, 1, 26);
			const look = lookFor(s.activity, AGENTS[s.agent]);
			const blink = WAITING.has(s.activity) ? 0.45 + 0.55 * ((Math.sin(now / 160) + 1) / 2) : 1;
			ctx.globalAlpha = blink;
			ctx.fillStyle = look.color;
			ctx.beginPath();
			ctx.arc(X + i * tabW + 16, Y + 55, 5, 0, Math.PI * 2);
			ctx.fill();
			ctx.globalAlpha = 1;
			ctx.font = `${active ? 600 : 400} 13px ${UI}`;
			ctx.fillStyle = active ? "#f2f3f5" : "#8d929b";
			let label = a.project;
			while (ctx.measureText(label).width > tabW - 34 && label.length > 3) label = label.slice(0, -1);
			ctx.fillText(label === a.project ? label : `${label}…`, X + i * tabW + 28, Y + 60);
		});

		if (!actor || !session) {
			ctx.restore();
			return;
		}
		const info = AGENTS[actor.agent];
		const left = X + 30;
		const width = W - 60;
		let y = Y + 108;

		// banner
		ctx.font = `700 23px ${MONO}`;
		ctx.fillStyle = info.work;
		ctx.fillText(`${actor.agent === "claude" ? "✻ " : "› "}${AGENT_TITLE[actor.agent] ?? actor.command}`, left, y);
		ctx.font = `400 16px ${MONO}`;
		ctx.fillStyle = "#6b717c";
		ctx.fillText(`  ~/${actor.project}`, left + ctx.measureText(`${AGENT_TITLE[actor.agent] ?? actor.command}   `).width * 1.25, y);
		y += 22;

		// transcript: the latest lines that fit above the prompt area
		const pending = w.pending(uid);
		const typing = w.typing(uid);
		const lineH = 31;
		ctx.font = `400 21px ${MONO}`;
		const rendered: { text: string; kind: Line["kind"] | "typing" }[] = [];
		for (const line of w.linesOf(uid)) {
			const prefix = line.kind === "prompt" ? "> " : line.kind === "tool" || line.kind === "say" ? "● " : line.kind === "out" ? "  └  " : line.kind === "ok" ? "  ✓ " : line.kind === "bad" ? "  ✗ " : "";
			for (const [i, part] of wrap(ctx, line.text, width - 60).entries()) rendered.push({ text: (i === 0 ? prefix : "   ") + part, kind: line.kind });
		}
		if (typing) for (const [i, part] of wrap(ctx, typing, width - 60).entries()) rendered.push({ text: (i === 0 ? "● " : "  ") + part, kind: "typing" });
		const boxH = pending ? (pending.kind === "approve" ? 196 : 168) : 0;
		const room = Math.floor((Y + H - 70 - boxH - y) / lineH);
		const visible = rendered.slice(Math.max(0, rendered.length - room));
		y += 14;
		for (const row of visible) {
			y += lineH;
			switch (row.kind) {
				case "prompt":
					ctx.fillStyle = "#1a1d24";
					ctx.fillRect(left - 8, y - 20, width, lineH);
					ctx.fillStyle = "#f2f3f5";
					break;
				case "tool":
					ctx.fillStyle = "#f2f3f5";
					break;
				case "out":
				case "dim":
					ctx.fillStyle = "#7f858f";
					break;
				case "ok":
					ctx.fillStyle = "#2fd27a";
					break;
				case "bad":
					ctx.fillStyle = "#ff6b62";
					break;
				default:
					ctx.fillStyle = "#e3e5e9";
			}
			if (row.kind === "tool" || row.kind === "say" || row.kind === "typing") {
				const bullet = row.text.startsWith("●");
				if (bullet) {
					ctx.fillStyle = row.kind === "tool" ? info.work : "#e3e5e9";
					ctx.fillText("●", left, y);
					ctx.fillStyle = "#e3e5e9";
					ctx.fillText(row.text.slice(1), left + ctx.measureText("●").width, y);
				} else ctx.fillText(row.text, left, y);
			} else ctx.fillText(row.text, left, y);
		}
		if (typing && Math.floor(now / 450) % 2 === 0) {
			const last = visible[visible.length - 1];
			if (last) {
				ctx.fillStyle = "#e3e5e9";
				ctx.fillRect(left + ctx.measureText(last.text).width + 4, y - 17, 10, 20);
			}
		}

		// the permission prompt or question box, like the real CLIs
		if (pending) {
			const bx = left - 8;
			const by = Y + H - 62 - boxH;
			const alert = info.alert;
			ctx.strokeStyle = alert;
			ctx.lineWidth = 2;
			roundRect(ctx, bx, by, width, boxH - 14, 10);
			ctx.stroke();
			ctx.font = `700 18px ${MONO}`;
			ctx.fillStyle = alert;
			let yy = by + 32;
			if (pending.kind === "approve") {
				ctx.fillText(`${pending.tool} command`, bx + 18, yy);
				yy += 30;
				ctx.font = `400 21px ${MONO}`;
				ctx.fillStyle = "#f2f3f5";
				ctx.fillText(`  ${pending.arg}`, bx + 18, yy);
				yy += 34;
				ctx.fillText("Do you want to proceed?", bx + 18, yy);
				yy += 30;
				ctx.fillStyle = alert;
				ctx.fillText("❯ 1. Yes", bx + 18, yy);
				ctx.fillStyle = "#c9ccd2";
				ctx.fillText("2. No", bx + 200, yy);
			} else {
				ctx.fillText("Question", bx + 18, yy);
				yy += 32;
				ctx.font = `400 18px ${MONO}`;
				ctx.fillStyle = "#f2f3f5";
				ctx.fillText(pending.question, bx + 18, yy);
				yy += 34;
				ctx.fillStyle = alert;
				ctx.fillText(`❯ 1. ${pending.options[0] ?? "Yes"}`, bx + 18, yy);
				ctx.fillStyle = "#c9ccd2";
				ctx.fillText(`2. ${pending.options[1] ?? "No"}`, bx + 240, yy);
			}
			// the hint to the visitor
			ctx.font = `600 15px ${UI}`;
			ctx.fillStyle = "#ffffff";
			const pulse = 0.55 + 0.45 * ((Math.sin(now / 220) + 1) / 2);
			ctx.globalAlpha = pulse;
			ctx.textAlign = "right";
			ctx.fillText(pending.kind === "approve" ? "Hold its key on the Stream Deck to allow  ⟶" : "Press its key to answer here  ⟶", bx + width - 18, by + 32);
			ctx.textAlign = "left";
			ctx.globalAlpha = 1;
		}

		// status line at the bottom: spinner and state, like the CLIs
		const status = Y + H - 26;
		ctx.font = `400 16px ${MONO}`;
		const look = lookFor(session.activity, info);
		if (WORKING.has(session.activity)) {
			ctx.fillStyle = info.work;
			ctx.fillText(`${SPIN[Math.floor(now / 120) % SPIN.length]} ${LABELS[session.activity]}… (${Math.max(0, Math.floor((now - session.activitySince) / 1000))}s · esc to interrupt)`, left, status);
		} else {
			ctx.fillStyle = look.label === "#F2F3F5" ? "#7f858f" : look.label;
			ctx.fillText(session.activity === "done" || session.activity === "idle" ? "> " : `${LABELS[session.activity]}`, left, status);
		}
		ctx.restore();
	}

	private toast(now: number): void {
		const t = this.world.toast;
		if (!t) return;
		const age = (now - t.at) / 1000;
		if (age > 3.2) return;
		const ctx = this.ctx;
		const slide = age < 0.25 ? age / 0.25 : age > 2.8 ? Math.max(0, 1 - (age - 2.8) / 0.4) : 1;
		const W = 360;
		const x = SCREEN_W - 18 - W + (1 - slide) * 60;
		const y = 40;
		ctx.save();
		ctx.globalAlpha = slide;
		ctx.shadowColor = "rgba(0,0,0,0.45)";
		ctx.shadowBlur = 24;
		ctx.fillStyle = "rgba(40,42,50,0.92)";
		roundRect(ctx, x, y, W, 70, 16);
		ctx.fill();
		ctx.shadowBlur = 0;
		ctx.fillStyle = t.tone === "ok" ? "#2fd27a" : t.tone === "bad" ? "#ff4b3e" : "#3f8cff";
		roundRect(ctx, x + 14, y + 13, 44, 44, 10);
		ctx.fill();
		ctx.fillStyle = "#0b0c0f";
		for (let r = 0; r < 3; r += 1) for (let c = 0; c < 3; c += 1) ctx.fillRect(x + 22 + c * 10, y + 21 + r * 10, 7, 7);
		ctx.fillStyle = "#f2f3f5";
		ctx.font = `700 15px ${UI}`;
		ctx.fillText("Stream Deck", x + 70, y + 30);
		ctx.font = `400 14px ${UI}`;
		ctx.fillStyle = "#c9ccd2";
		let text = t.text;
		while (ctx.measureText(text).width > W - 86 && text.length > 4) text = text.slice(0, -1);
		ctx.fillText(text === t.text ? text : `${text}…`, x + 70, y + 52);
		ctx.restore();
	}
}
