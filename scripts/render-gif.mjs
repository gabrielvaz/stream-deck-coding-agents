#!/usr/bin/env node
/**
 * Animated GIFs of a Stream Deck running the demo sessions, one per theme (docs/deck-<theme>.gif).
 *
 *   npm run build:lib && node scripts/render-gif.mjs [pulse,clawd]
 */
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import gifenc from "gifenc";
import { PNG } from "pngjs";
import { loadChromium } from "./playwright.mjs";

const { GIFEncoder, quantize, applyPalette } = gifenc;
const root = resolve(import.meta.dirname, "..");
const lib = await import(pathToFileURL(join(root, ".build", "lib.mjs")).href);
const themes = (process.argv[2] ?? "pulse,clawd").split(",");
const FRAMES = 48;
const STEP = 125; // ms → 8 fps
const KEY = 92;

const chromium = await loadChromium();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 5 * KEY + 4 * 10 + 40, height: 3 * KEY + 2 * 10 + 40 } });

for (const theme of themes) {
	const store = new lib.SessionStore({ doneToIdleSeconds: 0, hideIdleAfterMinutes: 0, offlineAfterMinutes: 0 });
	const applied = new Map();
	const t0 = Date.now();
	const gif = GIFEncoder();
	for (let f = 0; f < FRAMES; f += 1) {
		const now = t0 + f * STEP;
		lib.runDemo(store, 18 + (f * STEP) / 1000, applied);
		const sessions = store.ordered(false).map((s) => ({ ...s, title: s.project && !s.title.startsWith(s.project) ? `${s.project} – ${s.title}` : s.title }));
		const ctx = { now, palette: lib.AGENTS, animate: true, theme };
		const approval = sessions.find((s) => s.activity === "approval") ?? null;
		const svgs = [
			...sessions.slice(0, 11).map((s) => lib.sessionTile(s, ctx)),
			lib.hubTile({ summary: store.summary(), pips: sessions.slice(0, 11), page: 0, pages: 1, listening: true, problem: "", connectedAgents: 4 }, ctx),
			lib.decisionTile("allow", approval, ctx),
			lib.decisionTile("deny", approval, ctx),
			lib.pageTile(0, 1, sessions.length),
		];
		const html = `<body style="margin:0;background:#16171a"><div style="display:grid;grid-template-columns:repeat(5,${KEY}px);gap:10px;padding:20px">${svgs
			.map((svg) => `<img src="data:image/svg+xml,${encodeURIComponent(svg)}" width="${KEY}" height="${KEY}" style="border-radius:16px;display:block">`)
			.join("")}</div></body>`;
		await page.setContent(html);
		const png = PNG.sync.read(await page.screenshot());
		const palette = quantize(png.data, 256);
		gif.writeFrame(applyPalette(png.data, palette), png.width, png.height, { palette, delay: STEP });
	}
	gif.finish();
	const out = join(root, "docs", `deck-${theme}.gif`);
	writeFileSync(out, gif.bytes());
	console.log("wrote", out, `${Math.round(gif.bytes().length / 1024)} KB`);
	store.close();
}
await browser.close();
