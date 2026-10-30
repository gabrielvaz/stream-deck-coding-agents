#!/usr/bin/env node
/**
 * Windows smoke test, run from WSL: starts the plugin with Windows Node.js (through interop) in a
 * throw-away profile folder whose path has a space, connects Codex, Claude Code and Antigravity,
 * and runs their hooks the way each CLI does on Windows (PowerShell, exec form, cmd /c).
 *
 *   npm run build && node scripts/windows-smoke.mjs
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { PLUGIN_DIR, StreamDeckSim } from "./sim.mjs";
const stamp = Date.now().toString(36);

const toWin = (p) => execFileSync("wslpath", ["-w", p], { encoding: "utf8" }).trim();
const user = execFileSync("cmd.exe", ["/c", "echo %USERNAME%"], { encoding: "utf8" }).trim();
const homeWsl = `/mnt/c/Users/${user}/AppData/Local/Temp/deck smoke ${stamp}`; // a space on purpose
mkdirSync(join(homeWsl, ".codex"), { recursive: true });
mkdirSync(join(homeWsl, ".claude"), { recursive: true });
mkdirSync(join(homeWsl, ".gemini", "antigravity-cli"), { recursive: true });
const sim = new StreamDeckSim({
	node: "/mnt/c/Program Files/nodejs/node.exe",
	pluginMain: toWin(join(PLUGIN_DIR, "bin", "plugin.js")),
	env: { USERPROFILE: homeWsl, WSLENV: "USERPROFILE/p" },
	globalSettings: { approvalWait: 30 },
	platform: "windows",
});
await sim.start();
const keys = Array.from({ length: 3 }, (_, i) => sim.addKey("session", 0, i));
const hub = sim.addKey("hub", 0, 3);
const deny = sim.addKey("deny", 0, 4);
sim.openInspector(hub);
const deck = join(homeWsl, ".coding-agents-deck");
await sim.waitFor(() => existsSync(join(deck, "endpoint.json")), 20000, "endpoint.json on Windows");
console.log("endpoint:", readFileSync(join(deck, "endpoint.json"), "utf8").replace(/\s+/g, " "));
console.log("launcher:\n" + readFileSync(join(deck, "hook.cmd"), "utf8"));
const connect = async (agent) => { const n = sim.toInspector.length; sim.toPlugin(hub, { event: "connect", agent }); const r = await sim.waitFor(() => sim.toInspector.slice(n).find((p) => p.message), 20000, agent); console.log("connect", agent, r.message); };
await connect("codex"); await connect("claude"); await connect("antigravity");
const texts = (svg) => [...(svg ?? "").matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1].replace(/&amp;/g, "&").replace(/\u00a0/g, " ")).join(" | ");
const run = (exe, args, payload) => new Promise((res) => { const c = spawn(exe, args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, USERPROFILE: homeWsl, WSLENV: "USERPROFILE/p" } }); let o = "", e = ""; c.stdout.on("data", (d) => (o += d)); c.stderr.on("data", (d) => (e += d)); c.on("exit", (code) => res({ code, out: o.trim(), err: e.trim() })); c.stdin.end(JSON.stringify(payload)); });
// Codex runs hooks with: powershell -NoProfile -Command "<command>"
const codex = JSON.parse(readFileSync(join(homeWsl, ".codex", "hooks.json"), "utf8")).hooks;
console.log("codex command:", codex.PreToolUse[0].hooks[0].command);
const ps = (cmd, payload) => run("powershell.exe", ["-NoProfile", "-Command", cmd], payload);
let t = Date.now();
let r = await ps(codex.UserPromptSubmit[0].hooks[0].command, { session_id: "win-codex", cwd: "C:\\work\\api server", hook_event_name: "UserPromptSubmit", prompt: "Add rate limiting" });
console.log("codex UserPromptSubmit:", r, Date.now() - t, "ms");
r = await ps(codex.PreToolUse[0].hooks[0].command, { session_id: "win-codex", cwd: "C:\\work\\api server", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "cargo test" } });
console.log("codex PreToolUse:", r);
await sim.waitFor(() => keys.some((k) => texts(sim.images.get(k)).includes("cargo")), 8000, "codex tile");
console.log("tile:", texts(sim.images.get(keys.find((k) => texts(sim.images.get(k)).includes("cargo")))));
const pending = ps(codex.PermissionRequest[0].hooks[0].command, { session_id: "win-codex", cwd: "C:\\work\\api server", hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "rm -rf target" } });
await sim.waitFor(() => texts(sim.images.get(deny)).includes("rm -rf"), 10000, "deny key lit");
await sim.press(deny);
console.log("codex PermissionRequest → deny:", await pending);
// Claude: exec form, no shell
const claude = JSON.parse(readFileSync(join(homeWsl, ".claude", "settings.json"), "utf8")).hooks;
const h = claude.PreToolUse[0].hooks[0];
console.log("claude exec:", h.command, JSON.stringify(h.args));
r = await run("/mnt/c/Program Files/nodejs/node.exe", h.args, { session_id: "win-claude", cwd: "C:\\work\\docs site", hook_event_name: "UserPromptSubmit", prompt: "Fix links" });
console.log("claude hook:", r);
// Antigravity: cmd /c
const agy = JSON.parse(readFileSync(join(homeWsl, ".gemini", "config", "hooks.json"), "utf8"))["coding-agents-deck"];
console.log("agy command:", agy.PreToolUse[0].hooks[0].command);
r = await run("cmd.exe", ["/d", "/c", agy.PreToolUse[0].hooks[0].command], { conversationId: "win-agy", workspacePaths: ["C:\\work\\motion"], toolCall: { name: "run_command", args: { CommandLine: "npm run render" } } });
console.log("agy PreToolUse:", r);
await new Promise((r) => setTimeout(r, 800));
await sim.stop();
rmSync(homeWsl, { recursive: true, force: true });
// the test profile is gone, so drop its %ProgramData% launcher too (the plugin rewrites it on start)
if (agy.PreToolUse[0].hooks[0].command.startsWith("C:\\ProgramData")) rmSync(`/mnt/c/ProgramData/coding-agents-deck/${user}`, { recursive: true, force: true });
console.log("done; ProgramData shim (only when the profile path has spaces):", agy.PreToolUse[0].hooks[0].command.split(" ")[0]);
