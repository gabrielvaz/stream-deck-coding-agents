#!/usr/bin/env node
/**
 * Screenshots the property inspector (ui/setup.html) against a fake Stream Deck connection, with
 * a canned plugin status, so the layout can be checked without the Stream Deck app.
 *
 *   node scripts/render-inspector.mjs [out.png]
 */
import { once } from "node:events";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";
import { loadChromium } from "./playwright.mjs";

const root = resolve(import.meta.dirname, "..");
const out = resolve(process.argv[2] ?? join(root, "docs", "setup.png"));
const status = {
	event: "status",
	version: "1.0.0",
	platform: "win32",
	listening: true,
	port: 47821,
	problem: "",
	sessions: 5,
	lastHookAt: Date.now() - 4000,
	hookCounts: {},
	home: "C:\\Users\\you\\.coding-agents-deck",
	agents: [
		{ key: "claude", agent: "claude", where: "", detected: true, installed: true, upToDate: true, path: "", note: "" },
		{ key: "codex", agent: "codex", where: "", detected: true, installed: false, upToDate: false, path: "", note: "" },
		{ key: "antigravity", agent: "antigravity", where: "", detected: true, installed: true, upToDate: true, path: "", note: "" },
		{ key: "gemini", agent: "gemini", where: "", detected: false, installed: false, upToDate: false, path: "", note: "" },
		{ key: "claude@wsl:Ubuntu", agent: "claude", where: "WSL · Ubuntu", detected: true, installed: true, upToDate: true, path: "", note: "" },
	],
	message: { ok: true, text: "Hooks added to C:\\Users\\you\\.claude\\settings.json" },
	herdr: { found: true, running: true, agents: 3 },
	claudeList: { found: true, running: true },
	remote: {
		tunnel: "ssh -R 47821:127.0.0.1:47821 <your-server>",
		setup: 'curl -fsS "http://127.0.0.1:47821/remote/setup.sh?k=…" | sh',
		remove: 'curl -fsS "http://127.0.0.1:47821/remote/setup.sh?k=…&remove=1" | sh',
	},
};

const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
await once(wss, "listening");
wss.on("connection", (ws) => {
	ws.on("message", (data) => {
		const msg = JSON.parse(String(data));
		if (msg.event === "getGlobalSettings") ws.send(JSON.stringify({ event: "didReceiveGlobalSettings", payload: { settings: {} } }));
		if (msg.event === "getSettings") ws.send(JSON.stringify({ event: "didReceiveSettings", action: "com.gabrielvaz.coding-agents.session", context: "ctx", device: "dev", payload: { settings: {} } }));
		if (msg.event === "sendToPlugin") ws.send(JSON.stringify({ event: "sendToPropertyInspector", action: "com.gabrielvaz.coding-agents.session", context: "ctx", payload: status }));
	});
});

const chromium = await loadChromium();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 380, height: 2200 }, deviceScaleFactor: 2 });
await page.goto(pathToFileURL(join(root, "com.gabrielvaz.coding-agents.sdPlugin", "ui", "setup.html")).href);
const info = { application: { language: "en", platform: "windows", version: "7.1.0" }, colors: {}, devicePixelRatio: 2, devices: [], plugin: { uuid: "com.gabrielvaz.coding-agents", version: "1.0.0.0" } };
const actionInfo = { action: "com.gabrielvaz.coding-agents.session", context: "ctx", device: "dev", payload: { settings: {}, coordinates: { row: 0, column: 0 } } };
await page.evaluate(([port, info, actionInfo]) => window.connectElgatoStreamDeckSocket(port, "pi-uuid", "registerPropertyInspector", JSON.stringify(info), JSON.stringify(actionInfo)), [wss.address().port, info, actionInfo]);
await page.waitForTimeout(1200);
await page.evaluate(() => (document.querySelector("details").open = true));
await page.waitForTimeout(300);
const height = await page.evaluate(() => document.body.scrollHeight);
await page.setViewportSize({ width: 380, height: Math.min(height + 20, 2400) });
await page.screenshot({ path: out, fullPage: true });
console.log("wrote", out);
await browser.close();
wss.close();
