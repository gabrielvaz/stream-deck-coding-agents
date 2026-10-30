#!/usr/bin/env node
/**
 * Live check with the real Claude Code CLI (needs `claude` logged in; costs one tiny Haiku call).
 *
 * Starts the plugin under the simulator, connects Claude Code in a throw-away home folder, runs
 * `claude -p` with those hooks (passed with --settings, so your own settings are not touched),
 * waits for the permission request to show on a key and holds the key to allow it.
 *
 *   npm run build && node scripts/try-claude.mjs
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StreamDeckSim } from "./sim.mjs";

const home = mkdtempSync(join(tmpdir(), "deck-claude-"));
mkdirSync(join(home, ".claude"), { recursive: true });
const sim = await new StreamDeckSim({ env: { HOME: home, USERPROFILE: home }, globalSettings: { approvalWait: 60 } }).start();
const key = sim.addKey("session", 0, 0);
const hub = sim.addKey("hub", 0, 1);
sim.openInspector(hub);
await sim.waitFor(() => existsSync(join(home, ".coding-agents-deck", "endpoint.json")));
sim.toPlugin(hub, { event: "connect", agent: "claude" });
const settingsFile = join(home, ".claude", "settings.json");
await sim.waitFor(() => existsSync(settingsFile) && readFileSync(settingsFile, "utf8").includes("coding-agents-deck"));
writeFileSync(join(home, "hooks.json"), JSON.stringify({ hooks: JSON.parse(readFileSync(settingsFile, "utf8")).hooks }));

const texts = (svg) => [...(svg ?? "").matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1].replace(/&amp;/g, "&").replace(/ /g, " "));
let last = "";
const watcher = setInterval(() => {
	const sig = texts(sim.images.get(key))
		.slice(2)
		.filter((x) => !/^\d+:\d\d$|^\d+[smhd]$/.test(x))
		.join(" | ");
	if (sig !== last) console.log("key:", (last = sig));
}, 100);

const work = mkdtempSync(join(tmpdir(), "deck-work-"));
const claude = spawn(
	"claude",
	["-p", "Use the Bash tool to run exactly: touch deck-approved.txt && echo hello-from-deck . Then reply in one short sentence.", "--settings", join(home, "hooks.json"), "--model", "haiku"],
	{ cwd: work, env: { ...process.env, CODING_AGENTS_DECK_HOME: join(home, ".coding-agents-deck") }, stdio: ["ignore", "pipe", "inherit"] },
);
claude.stdout.pipe(process.stdout);
await sim.waitFor(() => texts(sim.images.get(key)).includes("Approval"), 90_000, "the approval on the key");
console.log("holding the key…");
await sim.press(key, 900);
await new Promise((r) => claude.on("exit", r));
clearInterval(watcher);
console.log(existsSync(join(work, "deck-approved.txt")) ? "\n✔ allowed from the deck: the command ran" : "\n✘ the command did not run");
await sim.stop();
