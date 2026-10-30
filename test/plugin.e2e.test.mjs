/**
 * End-to-end: the real plugin bundle under a simulated Stream Deck, real hook installs in a
 * temporary home folder, and the real hook client run the way each CLI runs it.
 *
 *   npm test
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { StreamDeckSim } from "../scripts/sim.mjs";

const home = mkdtempSync(join(tmpdir(), "coding-agents-e2e-"));
const env = { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: "", CODEX_HOME: "", GEMINI_CLI_HOME: "", CODING_AGENTS_DECK_HOME: "" };
let sim;
const keys = {};

/** Runs a hook command exactly as configured, feeding `payload` on stdin. */
function runHook(entry, payload, extraEnv = {}) {
	return new Promise((resolve, reject) => {
		const child = entry.args
			? spawn(entry.command, entry.args, { env: { ...process.env, ...env, ...extraEnv } })
			: spawn("/bin/sh", ["-c", entry.command], { env: { ...process.env, ...env, ...extraEnv } });
		let out = "";
		let err = "";
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (err += d));
		child.on("error", reject);
		child.on("exit", (code) => resolve({ code, out: out.trim(), err }));
		child.stdin.end(JSON.stringify(payload));
	});
}

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const svgOf = (context) => sim.images.get(context) ?? "";
const anyKeyShows = (text) => [...sim.keys.keys()].some((c) => svgOf(c).includes(text));
const decodeEntities = (svg) => svg.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\u00a0/g, " ");
const sessionKeys = () => [...sim.keys.entries()].filter(([, k]) => k.action.endsWith(".session")).map(([c]) => c);
const keyShowing = (text) => sessionKeys().find((c) => decodeEntities(svgOf(c)).includes(text));

async function connect(agent) {
	const before = sim.toInspector.length;
	sim.toPlugin(keys.hub, { event: "connect", agent });
	const reply = await sim.waitFor(() => sim.toInspector.slice(before).find((p) => p.message), 8000, `connect ${agent}`);
	assert.equal(reply.message.ok, true, reply.message.text);
	return reply;
}

describe("Coding Agents plugin", { timeout: 120_000 }, () => {
	before(async () => {
		// a user's existing Claude settings with their own hook, which must survive install + uninstall
		mkdirSync(join(home, ".claude"), { recursive: true });
		writeFileSync(
			join(home, ".claude", "settings.json"),
			JSON.stringify({ model: "opus", hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] } }, null, 2),
		);
		mkdirSync(join(home, ".codex"), { recursive: true });
		mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
		writeFileSync(join(home, ".gemini", "settings.json"), '{\n  // user comment\n  "theme": "dark",\n}\n');

		sim = await new StreamDeckSim({ env, globalSettings: { approvalWait: 20 } }).start();
		for (let i = 0; i < 8; i += 1) keys[`s${i}`] = sim.addKey("session", Math.floor(i / 5), i % 5);
		keys.hub = sim.addKey("hub", 1, 3);
		keys.allow = sim.addKey("allow", 1, 4);
		keys.deny = sim.addKey("deny", 2, 0);
		keys.page = sim.addKey("page", 2, 1);
		sim.openInspector(keys.hub);
		await sim.waitFor(() => existsSync(join(home, ".coding-agents-deck", "endpoint.json")), 10_000, "endpoint.json");
	});

	after(async () => {
		await sim?.stop();
	});

	it("draws every key and asks to connect agents first", async () => {
		await sim.waitFor(() => [...sim.keys.keys()].every((c) => svgOf(c).startsWith("<svg")), 5000, "first images");
		assert.match(svgOf(keys.hub), /Connect/);
		assert.match(svgOf(keys.allow), /nothing pending/);
	});

	it("reports status to the property inspector", async () => {
		sim.toPlugin(keys.hub, { event: "getStatus" });
		const status = await sim.waitFor(() => sim.toInspector.findLast((p) => p.event === "status"), 5000, "status");
		assert.equal(status.listening, true);
		assert.equal(status.agents.length, 4);
		assert.equal(status.agents.find((a) => a.agent === "claude").detected, true);
		const endpoint = readJson(join(home, ".coding-agents-deck", "endpoint.json"));
		assert.equal(endpoint.port, status.port);
		assert.ok(endpoint.token.length >= 24);
	});

	it("rejects requests without the token or from a browser", async () => {
		const { port, token } = readJson(join(home, ".coding-agents-deck", "endpoint.json"));
		const noToken = await fetch(`http://127.0.0.1:${port}/hook/claude?event=Stop`, { method: "POST", body: "{}" });
		assert.equal(noToken.status, 401);
		const browser = await fetch(`http://127.0.0.1:${port}/api/v1/state`, { headers: { Authorization: `Bearer ${token}`, Origin: "https://evil.example" } });
		assert.equal(browser.status, 403);
		const health = await fetch(`http://127.0.0.1:${port}/health`);
		assert.equal(health.status, 200);
	});

	it("connects Claude Code without touching the user's own hooks", async () => {
		await connect("claude");
		const settings = readJson(join(home, ".claude", "settings.json"));
		assert.equal(settings.model, "opus");
		assert.ok(settings.hooks.Stop.some((g) => g.hooks.some((h) => h.command === "say done")), "user hook kept");
		const ours = settings.hooks.PermissionRequest[0].hooks[0];
		assert.equal(ours.command, process.execPath);
		assert.deepEqual(ours.args.slice(1), ["claude"]);
		assert.ok(ours.args[0].endsWith(join(".coding-agents-deck", "hook.mjs")));
		assert.equal(ours.async, undefined, "permission hook must be synchronous");
		assert.equal(settings.hooks.PreToolUse[0].hooks[0].async, true);
		assert.ok(existsSync(join(home, ".claude", "settings.json.coding-agents-deck.bak")), "backup written");
	});

	it("follows a Claude Code session through its states", async () => {
		const hook = readJson(join(home, ".claude", "settings.json")).hooks.PreToolUse[0].hooks[0];
		const base = { session_id: "claude-1", cwd: join(home, "projects", "game app"), transcript_path: "/tmp/t.jsonl" };
		const claudeEnv = { CLAUDE_PID: String(process.pid) };
		await runHook(hook, { ...base, hook_event_name: "SessionStart", source: "startup", model: "claude-opus" }, claudeEnv);
		await runHook(hook, { ...base, hook_event_name: "UserPromptSubmit", prompt: "Create something fun with seeds" }, claudeEnv);
		await sim.waitFor(() => keyShowing("game app – Create something fun"), 5000, "title");
		await runHook(hook, { ...base, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "npm test" } }, claudeEnv);
		await sim.waitFor(() => keyShowing("Bash  npm test"), 5000, "tool label");
		await runHook(hook, { ...base, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: {}, tool_response: {} }, claudeEnv);
		await runHook(hook, { ...base, hook_event_name: "MessageDisplay", turn_id: "t", message_id: "m", index: 0, final: false, delta: "Planting four seed types\n" }, claudeEnv);
		await sim.waitFor(() => keyShowing("Writing"), 5000, "writing");
		assert.ok(keyShowing("Planting four"));
		const res = await runHook(hook, { ...base, hook_event_name: "Stop", last_assistant_message: "All four seeds are planted." }, claudeEnv);
		assert.equal(res.code, 0);
		const key = await sim.waitFor(() => keyShowing("Done"), 5000, "done");
		assert.match(decodeEntities(svgOf(key)), /All four seeds/);
	});

	it("lets a held key allow a Claude Code permission request", async () => {
		const hook = readJson(join(home, ".claude", "settings.json")).hooks.PermissionRequest[0].hooks[0];
		const base = { session_id: "claude-1", cwd: join(home, "projects", "game app") };
		const pending = runHook(hook, { ...base, hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "git push origin main" } });
		const key = await sim.waitFor(() => keyShowing("Approval"), 5000, "approval tile");
		assert.match(decodeEntities(svgOf(key)), /git push/);
		await sim.waitFor(() => svgOf(keys.allow).includes("Allow") && !svgOf(keys.allow).includes("nothing pending"), 5000, "allow key lit");
		await sim.press(key, 900); // hold ≥ 0.6 s
		const res = await pending;
		assert.equal(res.code, 0);
		assert.deepEqual(JSON.parse(res.out), { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
		await sim.waitFor(() => !anyKeyShows("Approval"), 5000, "approval cleared");
	});

	it("hands the request back to the terminal when the key is just pressed", async () => {
		const hook = readJson(join(home, ".claude", "settings.json")).hooks.PermissionRequest[0].hooks[0];
		const pending = runHook(hook, { session_id: "claude-1", cwd: "/x/game app", hook_event_name: "PermissionRequest", tool_name: "Write", tool_input: { file_path: "/x/a.ts" } });
		const key = await sim.waitFor(() => keyShowing("Approval"), 5000, "approval tile");
		await sim.press(key, 60); // short press = open the window
		const res = await pending;
		assert.equal(res.out, "", "no decision: Claude Code shows its own prompt");
	});

	it("connects Codex through the stable launcher and answers with the Deny key", async () => {
		await connect("codex");
		const hooks = readJson(join(home, ".codex", "hooks.json")).hooks;
		const permission = hooks.PermissionRequest[0].hooks[0];
		assert.match(permission.command, /\.coding-agents-deck\/hook' codex$/);
		const launcher = join(home, ".coding-agents-deck", process.platform === "win32" ? "hook.cmd" : "hook");
		assert.ok(existsSync(launcher));
		const base = { session_id: "codex-1", cwd: "/work/api-server", model: "gpt-5.5" };
		await runHook(hooks.UserPromptSubmit[0].hooks[0], { ...base, hook_event_name: "UserPromptSubmit", prompt: "Add rate limiting" });
		await runHook(hooks.PreToolUse[0].hooks[0], { ...base, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "cargo test" } });
		await sim.waitFor(() => keyShowing("Bash  cargo"), 5000, "codex tool");
		const pending = runHook(permission, { ...base, hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "rm -rf target" } });
		await sim.waitFor(() => decodeEntities(svgOf(keys.deny)).includes("rm -rf"), 5000, "deny key shows the command");
		await sim.press(keys.deny);
		const res = await pending;
		assert.equal(JSON.parse(res.out).hookSpecificOutput.decision.behavior, "deny");
		const stop = await runHook(hooks.Stop[0].hooks[0], { ...base, hook_event_name: "Stop", last_assistant_message: "Rate limiting added." });
		assert.equal(stop.out, "{}", "Codex Stop needs JSON on stdout");
	});

	it("connects Antigravity CLI: hooks, the title command and pending confirmations", async () => {
		await connect("antigravity");
		const file = readJson(join(home, ".gemini", "config", "hooks.json"));
		const entry = file["coding-agents-deck"];
		const settings = readJson(join(home, ".gemini", "antigravity-cli", "settings.json"));
		assert.match(settings.title.command, /antigravity Title$/);
		const base = { conversationId: "agy-1", workspacePaths: ["/work/motion graphics"], modelName: "Gemini 4" };
		await runHook(entry.PreInvocation[0], { ...base, invocationNum: 1, lastUserInput: "Graphic ideas for the intro" });
		const tool = await runHook(entry.PreToolUse[0].hooks[0], { ...base, toolCall: { name: "run_command", args: { CommandLine: "npm run render" } } });
		assert.deepEqual(JSON.parse(tool.out), { decision: "allow" });
		await sim.waitFor(() => keyShowing("run_command"), 5000, "agy tool");
		const title = await runHook({ command: settings.title.command }, { conversation_id: "agy-1", conversation_title: "Intro graphics", agent_state: "working", tool_confirmation_pending: true, workspace: { project_dir: "/work/motion graphics" } });
		assert.equal(title.out, "Intro graphics · motion graphics");
		await sim.waitFor(() => keyShowing("Intro graphics") && decodeEntities(svgOf(keyShowing("Intro graphics"))).includes("Approval"), 5000, "agy approval");
		const stop = await runHook(entry.Stop[0], { ...base, executionNum: 1, terminationReason: "model_stop", fullyIdle: true });
		assert.equal(stop.code, 0, stop.err);
		await sim.waitFor(() => decodeEntities(svgOf(keyShowing("Intro graphics"))).includes("Done"), 5000, `agy done (${stop.out}) ${decodeEntities(svgOf(keyShowing("Intro graphics"))).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")}`);
	});

	it("connects Gemini CLI even when settings.json has comments", async () => {
		await connect("gemini");
		const settings = readJson(join(home, ".gemini", "settings.json"));
		assert.equal(settings.theme, "dark");
		const hook = settings.hooks.BeforeAgent[0].hooks[0];
		assert.equal(hook.timeout, 5000);
		const base = { session_id: "gem-1", cwd: "/work/docs-site" };
		await runHook(hook, { ...base, hook_event_name: "BeforeAgent", prompt: "Fix the broken links" });
		await runHook(settings.hooks.BeforeTool[0].hooks[0], { ...base, hook_event_name: "BeforeTool", tool_name: "run_shell_command", tool_input: { command: "npm run lint" } });
		await sim.waitFor(() => keyShowing("run_shell_comma"), 5000, "gemini tool");
	});

	it("summarises everything on the overview key", async () => {
		await sim.waitFor(() => /working|waiting/.test(svgOf(keys.hub)), 5000, "hub summary");
		sim.toPlugin(keys.hub, { event: "getStatus" });
		const status = await sim.waitFor(() => sim.toInspector.findLast((p) => p.event === "status" && p.sessions >= 4), 5000, "4 sessions");
		assert.ok(status.agents.every((a) => a.installed && a.upToDate), JSON.stringify(status.agents));
	});

	it("disconnects cleanly and keeps the user's hooks", async () => {
		sim.toPlugin(keys.hub, { event: "disconnect", agent: "claude" });
		await sim.waitFor(() => !readFileSync(join(home, ".claude", "settings.json"), "utf8").includes(".coding-agents-deck"), 5000, "claude hooks removed");
		const settings = readJson(join(home, ".claude", "settings.json"));
		assert.deepEqual(settings.hooks, { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] });
		sim.toPlugin(keys.hub, { event: "disconnect", agent: "antigravity" });
		await sim.waitFor(() => !("coding-agents-deck" in readJson(join(home, ".gemini", "config", "hooks.json"))), 5000, "agy removed");
		assert.equal(readJson(join(home, ".gemini", "antigravity-cli", "settings.json")).title, undefined);
	});

	it("never blocks an agent when Stream Deck is not running", async () => {
		const codexHook = readJson(join(home, ".codex", "hooks.json")).hooks.PreToolUse[0].hooks[0];
		await sim.stop();
		sim = null;
		const started = Date.now();
		const res = await runHook(codexHook, { session_id: "codex-2", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } });
		assert.equal(res.code, 0);
		assert.equal(res.out, "{}");
		assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
	});
});
