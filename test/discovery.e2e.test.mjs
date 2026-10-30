/**
 * End-to-end: sessions found without our hooks (herdr, `claude agents`) and agents on an SSH-tunnelled
 * machine. Fake `herdr` and `claude` executables in a throw-away home answer like the real CLIs
 * (same JSON) and log what the plugin asks them to do.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { StreamDeckSim } from "../scripts/sim.mjs";

const home = mkdtempSync(join(tmpdir(), "coding-agents-discovery-"));
const env = { HOME: home, USERPROFILE: home, HERDR_BIN_PATH: "", CLAUDE_CONFIG_DIR: "", CODEX_HOME: "", GEMINI_CLI_HOME: "" };
const herdrLog = join(home, "herdr-calls.log");
let sim;
const keys = {};

function fakeCli(path, json, log) {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, `#!/bin/sh\necho "$@" >> '${log}'\ncase "$1 $2" in\n  "agent list"|"agents --json") cat <<'JSON'\n${JSON.stringify(json)}\nJSON\n;;\nesac\nexit 0\n`);
	chmodSync(path, 0o755);
}

const texts = (svg) => [...(svg ?? "").matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1].replace(/&amp;/g, "&").replace(/ /g, " ")).join(" | ");
const sessionKeys = () => [...sim.keys.entries()].filter(([, k]) => k.action.endsWith(".session")).map(([c]) => c);
const keyShowing = (text) => sessionKeys().find((c) => texts(sim.images.get(c)).includes(text));

describe("Sessions without hooks and remote machines", { timeout: 90_000 }, () => {
	before(async () => {
		fakeCli(
			join(home, ".herdr", "bin", "herdr"),
			{
				id: "cli:agent:list",
				result: {
					type: "agent_list",
					agents: [
						{ pane_id: "w1:p2", agent: "cursor", display_agent: "Cursor", agent_status: "blocked", cwd: "/work/shop", name: "checkout flow", focused: false, revision: 1, terminal_id: "t", tab_id: "w1:t1", workspace_id: "w1" },
						{ pane_id: "w1:p3", agent: "opencode", agent_status: "working", cwd: "/work/api", title: "add caching", focused: false, revision: 1, terminal_id: "t", tab_id: "w1:t1", workspace_id: "w1" },
						{ pane_id: "w1:p4", agent: "muse", display_agent: "Muse", agent_status: "idle", cwd: "/work/notes", focused: false, revision: 1, terminal_id: "t", tab_id: "w1:t1", workspace_id: "w1" },
					],
				},
			},
			herdrLog,
		);
		fakeCli(
			join(home, ".local", "bin", "claude"),
			[
				{ pid: 4242, cwd: "/work/site", kind: "interactive", sessionId: "11111111-aaaa", name: "site-7f", status: "busy" },
				{ pid: 4343, cwd: "/work/jobs", kind: "background", sessionId: "22222222-bbbb", name: "nightly-run", status: "idle" },
			],
			join(home, "claude-calls.log"),
		);
		sim = await new StreamDeckSim({ env, globalSettings: { herdr: true, claudeList: "on" } }).start();
		for (let i = 0; i < 6; i += 1) keys[`s${i}`] = sim.addKey("session", 0, i % 5);
		keys.allow = sim.addKey("allow", 1, 0);
		keys.hub = sim.addKey("hub", 1, 1);
		sim.openInspector(keys.hub);
		await sim.waitFor(() => existsSync(join(home, ".coding-agents-deck", "endpoint.json")), 10_000, "endpoint.json");
	});

	after(async () => {
		await sim?.stop();
	});

	it("shows herdr agents of any kind, with their state", async () => {
		await sim.waitFor(() => keyShowing("checkout flow") && keyShowing("add caching") && keyShowing("notes"), 10_000, "herdr sessions");
		assert.match(texts(sim.images.get(keyShowing("checkout flow"))), /Approval/);
		assert.match(texts(sim.images.get(keyShowing("add caching"))), /Thinking/);
	});

	it("answers a herdr prompt from the Allow key with herdr send-keys", async () => {
		await sim.waitFor(() => texts(sim.images.get(keys.allow)).includes("shop"), 5000, `allow key lit for herdr: ${texts(sim.images.get(keys.allow))} | key: ${texts(sim.images.get(keyShowing("checkout")))}`);
		await sim.press(keys.allow);
		await sim.waitFor(() => existsSync(herdrLog) && readFileSync(herdrLog, "utf8").includes("agent send-keys w1:p2 enter"), 5000, "send-keys enter");
	});

	it("focuses the herdr pane when the key is pressed", async () => {
		const key = keyShowing("add caching");
		await sim.press(key);
		await sim.waitFor(() => readFileSync(herdrLog, "utf8").includes("agent focus w1:p3"), 5000, "herdr focus");
	});

	it("lists Claude Code sessions through claude agents --json", async () => {
		await sim.waitFor(() => keyShowing("site-7f") && keyShowing("nightly-run"), 15_000, "claude agents sessions");
		assert.match(texts(sim.images.get(keyShowing("site-7f"))), /Thinking/);
	});

	it("serves a remote setup script that connects agents over an SSH tunnel", async () => {
		sim.toPlugin(keys.hub, { event: "getStatus" });
		const status = await sim.waitFor(() => sim.toInspector.findLast((p) => p.event === "status" && p.remote), 5000, "status with remote commands");
		assert.match(status.remote.tunnel, /^ssh -R \d+:127\.0\.0\.1:\d+ /);
		const url = /"(http:[^"]+)"/.exec(status.remote.setup)[1];
		const script = await (await fetch(url)).text();
		assert.match(script, /^#!\/bin\/sh/);

		// the "remote machine": another home with Claude Code and Codex folders
		const remote = mkdtempSync(join(tmpdir(), "coding-agents-remote-"));
		mkdirSync(join(remote, ".claude"), { recursive: true });
		mkdirSync(join(remote, ".codex"), { recursive: true });
		writeFileSync(join(remote, ".claude", "settings.json"), JSON.stringify({ theme: "dark" }));
		const sh = (code, extraEnv = {}, input = "") =>
			new Promise((resolve) => {
				const child = spawn("/bin/sh", ["-c", code], { env: { ...process.env, HOME: remote, ...extraEnv } });
				let out = "";
				child.stdout.on("data", (d) => (out += d));
				child.stderr.on("data", (d) => (out += d));
				child.on("exit", (status) => resolve({ status, out: out.trim() }));
				child.stdin.end(input);
			});
		const setup = await sh(status.remote.setup);
		assert.equal(setup.status, 0, setup.out);
		assert.match(setup.out, /Connected to your Stream Deck/);
		const claude = JSON.parse(readFileSync(join(remote, ".claude", "settings.json"), "utf8"));
		assert.equal(claude.theme, "dark");
		const hook = claude.hooks.UserPromptSubmit[0].hooks[0];
		assert.match(hook.command, /^curl -s /);

		// a remote Claude Code session reports through the tunnel (here: the same loopback)
		const run = await sh(hook.command, {}, JSON.stringify({ session_id: "remote-1", cwd: "/srv/app", hook_event_name: "UserPromptSubmit", prompt: "Deploy the fix" }));
		assert.equal(run.status, 0, run.out);
		await sim.waitFor(() => sessionKeys().some((c) => /:app – Deploy the fix/.test(texts(sim.images.get(c)))), 8000, "remote session on a key");

		// when the tunnel is closed the hook still exits 0 quickly
		const codex = JSON.parse(readFileSync(join(remote, ".codex", "hooks.json"), "utf8")).hooks.Stop[0].hooks[0].command;
		const offline = await sh(codex.replace(/127\.0\.0\.1:\d+/, "127.0.0.1:9"), {}, "{}");
		assert.equal(offline.status, 0);
		assert.equal(offline.out, "{}");

		const removed = await sh(status.remote.remove);
		assert.equal(removed.status, 0, removed.out);
		assert.deepEqual(JSON.parse(readFileSync(join(remote, ".claude", "settings.json"), "utf8")), { theme: "dark" });
	});
});
