#!/usr/bin/env node
/**
 * WSL check, run from inside WSL on a Windows PC: the plugin runs on Windows (Windows Node.js, as
 * Stream Deck would), Claude Code runs here in WSL. Connects "Claude Code · WSL" in throw-away
 * folders, runs `claude -p` with those hooks and allows its permission request from a key.
 *
 *   npm run build && node scripts/wsl-claude.mjs
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLUGIN_DIR, StreamDeckSim } from "./sim.mjs";

const distro = process.env.WSL_DISTRO_NAME;
if (!distro) throw new Error("run this inside WSL");
const user = execFileSync("cmd.exe", ["/c", "echo %USERNAME%"], { encoding: "utf8" }).trim();
const winHome = `/mnt/c/Users/${user}/AppData/Local/Temp/deck wsl ${Date.now().toString(36)}`;
mkdirSync(winHome, { recursive: true });
const wslHome = mkdtempSync(join(tmpdir(), "deck-wsl-home-"));
mkdirSync(join(wslHome, ".claude"), { recursive: true });
const toWin = (p) => execFileSync("wslpath", ["-w", p], { encoding: "utf8" }).trim();

const sim = new StreamDeckSim({
	node: "/mnt/c/Program Files/nodejs/node.exe",
	pluginMain: toWin(join(PLUGIN_DIR, "bin", "plugin.js")),
	env: { USERPROFILE: winHome, CODING_AGENTS_DECK_WSL_HOME: wslHome, WSLENV: "USERPROFILE/p:CODING_AGENTS_DECK_WSL_HOME" },
	globalSettings: { approvalWait: 60 },
	platform: "windows",
});
await sim.start();
const key = sim.addKey("session", 0, 0);
const hub = sim.addKey("hub", 0, 1);
sim.openInspector(hub);
await sim.waitFor(() => existsSync(join(winHome, ".coding-agents-deck", "endpoint.json")), 20_000, "endpoint.json");
sim.toPlugin(hub, { event: "getStatus" });
const status = await sim.waitFor(() => sim.toInspector.findLast((p) => p.event === "status" && p.agents.some((a) => a.where)), 30_000, "WSL rows");
console.log("rows:", status.agents.map((a) => `${a.key}${a.detected ? "" : " (not found)"}`).join(", "));
const target = `claude@wsl:${distro}`;
const n = sim.toInspector.length;
sim.toPlugin(hub, { event: "connect", target });
console.log("connect:", (await sim.waitFor(() => sim.toInspector.slice(n).find((p) => p.message), 20_000, "connect")).message);
const settings = JSON.parse(readFileSync(join(wslHome, ".claude", "settings.json"), "utf8"));
console.log("hook:", JSON.stringify(settings.hooks.PermissionRequest[0].hooks[0]));
console.log("launcher:\n" + readFileSync(join(wslHome, ".coding-agents-deck", "hook"), "utf8"));
writeFileSync(join(wslHome, "hooks.json"), JSON.stringify({ hooks: settings.hooks }));

const texts = (svg) => [...(svg ?? "").matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1].replace(/&amp;/g, "&").replace(/ /g, " "));
let last = "";
const watcher = setInterval(() => {
	const sig = texts(sim.images.get(key))
		.slice(2)
		.filter((x) => !/^\d+:\d\d$|^\d+[smhd]$/.test(x))
		.join(" | ");
	if (sig !== last) console.log("key:", (last = sig));
}, 100);
const work = mkdtempSync(join(tmpdir(), "deck-wsl-work-"));
const claude = spawn("claude", ["-p", "Use the Bash tool to run exactly: touch wsl-approved.txt && echo hi . Then reply in one short sentence.", "--settings", join(wslHome, "hooks.json"), "--model", "haiku"], {
	cwd: work,
	env: { ...process.env, CODING_AGENTS_DECK_HOME: join(winHome, ".coding-agents-deck"), WSLENV: `${process.env.WSLENV ? `${process.env.WSLENV}:` : ""}CODING_AGENTS_DECK_HOME/p` },
	stdio: ["ignore", "inherit", "inherit"],
});
await sim.waitFor(() => texts(sim.images.get(key)).includes("Approval"), 120_000, "the approval on the key");
console.log("holding the key…");
await sim.press(key, 900);
await new Promise((r) => claude.on("exit", r));
clearInterval(watcher);
console.log(existsSync(join(work, "wsl-approved.txt")) ? "\n✔ WSL: allowed from the deck, the command ran" : "\n✘ the command did not run");
await sim.stop();
await new Promise((r) => setTimeout(r, 1500));
rmSync(winHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 });
