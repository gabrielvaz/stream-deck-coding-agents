#!/usr/bin/env node
/**
 * Renders the key tiles with the demo sessions into PNGs: a device mock-up for the README and the
 * Marketplace gallery (1920×960), plus a sheet with every state.
 *
 *   npm run build:lib && node scripts/render-gallery.mjs [outDir]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadChromium } from "./playwright.mjs";

const root = resolve(import.meta.dirname, "..");
const lib = await import(pathToFileURL(join(root, ".build", "lib.mjs")).href);
const out = resolve(process.argv[2] ?? join(root, "docs"));
mkdirSync(out, { recursive: true });

const palette = lib.AGENTS;
const store = new lib.SessionStore({ doneToIdleSeconds: 0, hideIdleAfterMinutes: 0, offlineAfterMinutes: 0 });

/** Puts every demo session in a chosen state, like the frames of the reference video. */
function scene(states) {
	for (const [id, agent, title, patch, ageSeconds] of states) {
		const s = store.upsert(agent, id, { title, ...patch });
		s.activitySince = Date.now() - ageSeconds * 1000;
		s.seen = patch.seen ?? true;
	}
}

const WRITE = "The game app now has four seed types and fireflies at night. Plant, water and";
scene([
	["s1", "codex", "game app – Create something fun", { activity: "writing", text: WRITE }, 95],
	["s2", "codex", "Install the 0.3.3 build", { activity: "thinking" }, 7],
	["s3", "claude", "school tool – Something cool", { activity: "tool", toolLabel: "Bash  npm test" }, 12],
	["s4", "antigravity", "Long-Term Fun Activity Ideas", { activity: "thinking" }, 59],
	["s5", "antigravity", "Motion Graphics Ideas", { activity: "thinking" }, 64],
	["s6", "claude", "heinous – Fun app", { activity: "approval", toolLabel: "Bash  git push", approval: { tool: "Bash", summary: "git push origin main" } }, 133],
	["s7", "codex", "Create something with the CLI", { activity: "done", text: "Saved to ~/devin/Downloads/preview.html" }, 6],
	["s8", "claude", "Cool app project", { activity: "done", text: "All tests pass." }, 18],
	["s9", "claude", "mobile-app", { activity: "question", question: { text: "Use tabs or a drawer?", options: ["Tabs", "Drawer"] } }, 70],
	["s10", "antigravity", "menu-layout", { activity: "idle" }, 5],
	["s11", "codex", "api-server", { activity: "error", detail: "rate limited (429)" }, 40],
]);
store.markSeen("codex:s7");

const now = Date.now();
const order = store.ordered(false);
const ctx = (t = now) => ({ now: t, palette, animate: true });
const tile = (s, t, large = false) => lib.sessionTile(s, { ...ctx(t), large });
const hub = (t = now) =>
	lib.hubTile({ summary: store.summary(), pips: order.slice(0, 11), page: 0, pages: 1, listening: true, problem: "", connectedAgents: 3 }, ctx(t));
const url = (svg) => `data:image/svg+xml,${encodeURIComponent(svg)}`;

// Stream Deck MK.2 (5×3): 11 session keys, hub, allow, deny, page
const keys = [...order.slice(0, 11).map((s, i) => tile(s, now + i * 37)), hub(), lib.decisionTile("allow", store.firstAnswerable() ?? order.find((s) => s.activity === "approval"), ctx()), lib.decisionTile("deny", null, ctx()), lib.pageTile(0, 2, 13)];

const keyHtml = (svg, size) => `<div class="key" style="width:${size}px;height:${size}px"><img src="${url(svg)}" width="${size}" height="${size}"></div>`;

function deviceHtml(cols, list, size, gap) {
	return `<div class="device" style="grid-template-columns:repeat(${cols}, ${size}px);gap:${gap}px">${list.map((k) => keyHtml(k, size)).join("")}</div>`;
}

const css = `
	*{box-sizing:border-box} body{margin:0;background:#0d0e10;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#eef0f3}
	.device{display:inline-grid;padding:34px;border-radius:44px;background:linear-gradient(160deg,#2a2c31,#16171a);box-shadow:0 30px 80px rgba(0,0,0,.6), inset 0 1px 0 rgba(255,255,255,.08)}
	.key{border-radius:18%;overflow:hidden;background:#000;box-shadow:0 0 0 2px #0a0a0b, 0 4px 10px rgba(0,0,0,.5)}
	.key img{display:block}
`;

const chromium = await loadChromium();
const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });

async function shot(html, file, viewport) {
	await page.setViewportSize(viewport);
	await page.setContent(`<!doctype html><html><head><style>${css}</style></head><body>${html}</body></html>`);
	await page.waitForTimeout(120);
	await page.screenshot({ path: join(out, file) });
	console.log("wrote", join(out, file));
}

// README / Marketplace hero: 1920×960
await shot(
	`<div style="width:1920px;height:960px;display:flex;align-items:center;justify-content:center;gap:90px;background:radial-gradient(ellipse at 30% 40%,#1d2230,#0b0c0f 70%)">
		${deviceHtml(5, keys, 150, 22)}
		<div style="width:520px">
			<div style="font-size:64px;font-weight:800;line-height:1.05">Coding Agents</div>
			<div style="font-size:30px;color:#b8bec9;margin-top:22px;line-height:1.35">Claude Code, Codex and Antigravity sessions live on your Stream Deck.</div>
			<div style="font-size:24px;color:#8d939d;margin-top:28px;line-height:1.5">Press to open the window.<br>Hold to approve.</div>
		</div>
	</div>`,
	"gallery-1-hero.png",
	{ width: 1920, height: 960 },
);

// every state, with labels
const states = [
	["Thinking", "claude", { activity: "thinking" }],
	["Tool", "claude", { activity: "tool", toolLabel: "Bash  npm test" }],
	["Writing", "codex", { activity: "writing", text: "Three looks: neon grid, paper cutout and soft gradients." }],
	["Approval", "claude", { activity: "approval", approval: { tool: "Bash", summary: "git push origin main" } }],
	["Question", "codex", { activity: "question", question: { text: "Use tabs or a drawer?", options: [] } }],
	["Done", "antigravity", { activity: "done", text: "Ten ideas, sorted by cost." }],
	["Idle", "claude", { activity: "idle" }],
	["Error", "codex", { activity: "error", detail: "rate limited (429)" }],
	["Compacting", "antigravity", { activity: "compacting" }],
	["Offline", "codex", { activity: "offline" }],
];
const legend = states
	.map(([label, agent, patch], i) => {
		const s = store.upsert(agent, `legend-${i}`, { title: `${label} example`, ...patch });
		s.activitySince = now - (20 + i * 9) * 1000;
		s.seen = true;
		return `<div style="text-align:center"><div style="font-size:26px;margin-bottom:14px;color:#c9ced6">${label}</div>${keyHtml(tile(s, now + i * 211), 230)}</div>`;
	})
	.join("");
await shot(
	`<div style="width:1920px;height:960px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:36px;background:#0b0c0f">
		<div style="font-size:44px;font-weight:800">Every state at a glance</div>
		<div style="display:grid;grid-template-columns:repeat(5,230px);gap:44px 60px">${legend}</div>
	</div>`,
	"gallery-2-states.png",
	{ width: 1920, height: 960 },
);

// hub + approve flow
const approval = order.find((s) => s.activity === "approval");
await shot(
	`<div style="width:1920px;height:960px;display:flex;align-items:center;justify-content:center;gap:120px;background:radial-gradient(ellipse at 70% 50%,#2a1a14,#0b0c0f 70%)">
		<div style="display:flex;gap:40px;align-items:flex-end">
			<div style="text-align:center"><div style="font-size:26px;margin-bottom:16px;color:#c9ced6">Overview</div>${keyHtml(hub(), 300)}</div>
			<div style="text-align:center"><div style="font-size:26px;margin-bottom:16px;color:#c9ced6">Waiting for you</div>${keyHtml(tile(approval, now), 300)}</div>
			<div style="text-align:center"><div style="font-size:26px;margin-bottom:16px;color:#c9ced6">Allow key</div>${keyHtml(lib.decisionTile("allow", approval, ctx()), 300)}</div>
		</div>
		<div style="width:470px;font-size:30px;line-height:1.45;color:#c4c9d2"><b style="color:#fff;font-size:44px">Approve from the deck</b><br><br>Hold a session key for half a second to allow a Claude Code or Codex permission request, or use the Allow and Deny keys.</div>
	</div>`,
	"gallery-3-approve.png",
	{ width: 1920, height: 960 },
);

// compact preview at the real MK.2 size (72 px keys)
const keysLarge = [...order.slice(0, 11).map((s, i) => tile(s, now + i * 37, true)), ...keys.slice(11)];
await shot(`<div style="padding:30px">${deviceHtml(5, keysLarge, 72, 12)}</div>`, "deck-72px.png", { width: 600, height: 340 });
await shot(`<div style="padding:30px">${deviceHtml(5, keysLarge, 144, 18)}</div>`, "deck-large.png", { width: 940, height: 600 });
await shot(`<div style="padding:30px">${deviceHtml(5, keys, 144, 18)}</div>`, "deck.png", { width: 940, height: 600 });

// raw SVGs of a few keys, handy for checking in other renderers
mkdirSync(join(out, "svg"), { recursive: true });
order.slice(0, 6).forEach((s, i) => writeFileSync(join(out, "svg", `key-${i + 1}-${s.activity}.svg`), tile(s, now)));
writeFileSync(join(out, "svg", "hub.svg"), hub());

await browser.close();
store.close();
