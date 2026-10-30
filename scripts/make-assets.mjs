#!/usr/bin/env node
/**
 * Generates every image the manifest and the Marketplace listing need, from SVG sources:
 *   plugin icon 256/512, category icon 28/56, action icons 20/40, default key images 72/144,
 *   Marketplace app icon 288.
 *
 *   npm run build:lib && node scripts/make-assets.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadChromium } from "./playwright.mjs";

const root = resolve(import.meta.dirname, "..");
const plugin = join(root, "com.gabrielvaz.coding-agents.sdPlugin");
const lib = await import(pathToFileURL(join(root, ".build", "lib.mjs")).href);

const W = "#FFFFFF";
const svg = (size, body, view = size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${view} ${view}">${body}</svg>`;

// ------------------------------------------------------------------------------------------- plugin icon
function pluginIcon() {
	const tiles = [
		["#FFB238", 1],
		["#3F8CFF", 0.9],
		["#1FD8A4", 0.85],
		["#3F8CFF", 0.7],
		["#FF5F2E", 1],
		["#FFB238", 0.75],
		["#1FD8A4", 0.6],
		["#E8ECF2", 0.55],
		null,
	];
	let body = `<defs>`;
	tiles.forEach((t, i) => {
		if (!t) return;
		body += `<radialGradient id="g${i}" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#fff" stop-opacity="${0.95 * t[1]}"/><stop offset="0.35" stop-color="${t[0]}" stop-opacity="${0.9 * t[1]}"/><stop offset="1" stop-color="${t[0]}" stop-opacity="0"/></radialGradient>`;
	});
	body += `<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#26282D"/><stop offset="1" stop-color="#121316"/></linearGradient></defs>`;
	body += `<rect width="256" height="256" rx="56" fill="url(#bg)"/>`;
	tiles.forEach((t, i) => {
		const x = 30 + (i % 3) * 68;
		const y = 30 + Math.floor(i / 3) * 68;
		body += `<rect x="${x}" y="${y}" width="60" height="60" rx="13" fill="#050506"/>`;
		if (t) body += `<circle cx="${x + 30}" cy="${y + 56}" r="34" fill="url(#g${i})"/>`;
		else body += `<text x="${x + 13}" y="${y + 38}" font-family="Helvetica, Arial, sans-serif" font-size="30" font-weight="800" fill="#fff">7</text><g>${[0, 1, 2, 3].map((k) => `<circle cx="${x + 14 + k * 11}" cy="${y + 49}" r="3.2" fill="${["#FFB238", "#3F8CFF", "#1FD8A4", "#FF5F2E"][k]}"/>`).join("")}</g>`;
		body += `<rect x="${x}" y="${y}" width="60" height="60" rx="13" fill="none" stroke="#000" stroke-opacity="0.6" stroke-width="2"/>`;
	});
	return svg(256, body);
}

// ------------------------------------------------------------------------------------------- monochrome icons
const category = svg(
	28,
	`<rect x="3" y="3" width="9.5" height="9.5" rx="2.5" fill="none" stroke="${W}" stroke-width="2"/><rect x="15.5" y="3" width="9.5" height="9.5" rx="2.5" fill="none" stroke="${W}" stroke-width="2"/><rect x="3" y="15.5" width="9.5" height="9.5" rx="2.5" fill="none" stroke="${W}" stroke-width="2"/><rect x="15.5" y="15.5" width="9.5" height="9.5" rx="2.5" fill="${W}"/>`,
);

const actionIcons = {
	session: `<rect x="2" y="2" width="16" height="16" rx="4" fill="none" stroke="${W}" stroke-width="1.6"/><path d="M5 18 a5 5 0 0 1 10 0" fill="${W}"/><line x1="5" y1="6" x2="12" y2="6" stroke="${W}" stroke-width="1.6" stroke-linecap="round"/>`,
	hub: `<text x="1.5" y="13" font-family="Helvetica, Arial, sans-serif" font-size="12" font-weight="800" fill="${W}">6</text><line x1="10" y1="6" x2="18" y2="6" stroke="${W}" stroke-width="1.6" stroke-linecap="round"/><line x1="10" y1="11" x2="16" y2="11" stroke="${W}" stroke-width="1.6" stroke-linecap="round"/><g fill="${W}"><circle cx="3.5" cy="17" r="1.6"/><circle cx="8" cy="17" r="1.6"/><circle cx="12.5" cy="17" r="1.6"/><circle cx="17" cy="17" r="1.6"/></g>`,
	allow: `<path d="M4 10.5 l4 4 8-9" fill="none" stroke="${W}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>`,
	deny: `<path d="M5 5 l10 10 M15 5 l-10 10" fill="none" stroke="${W}" stroke-width="2.2" stroke-linecap="round"/>`,
	page: `<rect x="2" y="4" width="11" height="12" rx="2.5" fill="none" stroke="${W}" stroke-width="1.6"/><path d="M14 7 l3.5 3 -3.5 3" fill="none" stroke="${W}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`,
};

// ------------------------------------------------------------------------------------------- default key images
const palette = lib.AGENTS;
const store = new lib.SessionStore({ doneToIdleSeconds: 0, hideIdleAfterMinutes: 0, offlineAfterMinutes: 0 });
const sample = store.upsert("claude", "key-sample", { title: "Agent session", activity: "thinking" });
sample.activitySince = Date.now() - 12_000;
const ctx = { now: Date.now(), palette, animate: false };
const keyImages = {
	"session-key": lib.sessionTile(sample, ctx),
	"hub-key": lib.hubTile({ summary: { working: 0, waiting: 0, done: 0, errors: 0, idle: 0, total: 0, perAgent: {}, firstWaiting: null }, pips: [], page: 0, pages: 1, listening: true, problem: "", connectedAgents: 1 }, ctx),
	"allow-key": lib.decisionTile("allow", null, ctx),
	"deny-key": lib.decisionTile("deny", null, ctx),
	"page-key": lib.pageTile(0, 1, 0),
};
store.close();

// ------------------------------------------------------------------------------------------- render
const chromium = await loadChromium();
const browser = await chromium.launch();
const page = await browser.newPage();

async function png(source, size, file) {
	mkdirSync(dirname(file), { recursive: true });
	await page.setViewportSize({ width: size, height: size });
	await page.setContent(
		`<!doctype html><html><body style="margin:0;background:transparent"><img src="data:image/svg+xml,${encodeURIComponent(source)}" width="${size}" height="${size}" style="display:block"></body></html>`,
	);
	await page.waitForTimeout(60);
	await page.screenshot({ path: file, omitBackground: true });
	console.log("wrote", file.replace(root + "/", ""), `${size}px`);
}

const icon = pluginIcon();
await png(icon, 256, join(plugin, "imgs/plugin/marketplace.png"));
await png(icon, 512, join(plugin, "imgs/plugin/marketplace@2x.png"));
await png(icon, 288, join(root, "marketplace/app-icon-288.png"));
writeFileSync(join(root, "marketplace/app-icon.svg"), icon);
await png(category, 28, join(plugin, "imgs/plugin/category-icon.png"));
await png(category, 56, join(plugin, "imgs/plugin/category-icon@2x.png"));
for (const [name, body] of Object.entries(actionIcons)) {
	const source = svg(20, body);
	await png(source, 20, join(plugin, `imgs/actions/${name}.png`));
	await png(source, 40, join(plugin, `imgs/actions/${name}@2x.png`));
}
for (const [name, source] of Object.entries(keyImages)) {
	await png(source, 72, join(plugin, `imgs/actions/${name}.png`));
	await png(source, 144, join(plugin, `imgs/actions/${name}@2x.png`));
}
await browser.close();
