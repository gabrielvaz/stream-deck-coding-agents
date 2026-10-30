/**
 * Unit tests for the pure parts: mappers, tool labels, tile text, installer JSON handling, versions.
 * Runs against .build/lib.mjs (npm run build:lib).
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

const root = join(import.meta.dirname, "..");
const lib = await import(join(root, ".build", "lib.mjs"));

describe("tool labels", () => {
	it("formats like the keypad: name, two spaces, summary", () => {
		assert.equal(lib.toolLabel("Bash", { command: "npm test" }), "Bash  npm test");
		assert.equal(lib.toolLabel("Edit", { file_path: "/a/b/index.ts" }), "Edit  index.ts");
		assert.equal(lib.toolLabel("WebFetch", { url: "https://docs.elgato.com/x" }), "WebFetch  docs.elgato.com");
		assert.equal(lib.toolLabel("apply_patch", { command: "*** Begin Patch\n*** Update File: src/app.ts\n" }), "apply_patch  app.ts");
		assert.equal(lib.toolLabel("mcp__github__create_issue", { title: "Bug" }), "github create_issue  Bug");
	});
});

describe("mappers", () => {
	it("Claude: prompt, tool, permission with a decision reply", () => {
		const prompt = lib.mapClaude("UserPromptSubmit", { session_id: "s", cwd: "/w/game app", prompt: "Make it fun\nmore" });
		assert.equal(prompt.patch.activity, "thinking");
		assert.equal(prompt.patch.prompt, "Make it fun");
		assert.equal(prompt.patch.project, "game app");
		const perm = lib.mapClaude("PermissionRequest", { session_id: "s", tool_name: "Bash", tool_input: { command: "rm -rf x" } });
		assert.equal(perm.awaitDecision, true);
		assert.equal(perm.reply(null), null, "no decision → empty output");
		assert.equal(perm.reply({ behavior: "allow" }).hookSpecificOutput.decision.behavior, "allow");
		assert.equal(lib.mapClaude("PermissionRequest", { session_id: "s", tool_name: "ExitPlanMode" }), null);
		assert.equal(lib.mapClaude("StopFailure", { session_id: "s", error: "rate_limit" }).patch.detail, "rate limit");
		assert.equal(lib.mapClaude("Notification", { session_id: "s", notification_type: "auth_success" }), null);
	});
	it("Codex always answers with JSON", () => {
		assert.deepEqual(lib.mapCodex("Stop", { session_id: "c" }).reply(null), {});
		assert.equal(lib.neutralReply("codex", "Stop").constructor, Object);
	});
	it("Antigravity: title command reports pending confirmations and sets the window title", () => {
		const m = lib.mapAntigravity("Title", { conversation_id: "a", conversation_title: "Fix CI", tool_confirmation_pending: true, workspace: { project_dir: "/w/api" } });
		assert.equal(m.patch.activity, "approval");
		assert.equal(m.reply(null), "Fix CI · api");
		assert.equal(lib.mapAntigravity("Title", { agent_state: "idle" }).reply(null), "agy · Antigravity");
		assert.deepEqual(lib.mapAntigravity("PreToolUse", { conversationId: "a", toolCall: { name: "run_command", args: { CommandLine: "ls" } } }).reply(null), { decision: "allow" });
	});
});

describe("session store", () => {
	it("orders waiting sessions first and answers pending decisions", async () => {
		const store = new lib.SessionStore({ doneToIdleSeconds: 0, hideIdleAfterMinutes: 0, offlineAfterMinutes: 0 });
		store.upsert("claude", "a", { activity: "thinking" });
		store.upsert("codex", "b", { activity: "done" });
		store.upsert("claude", "c", { activity: "approval", approval: { tool: "Bash", summary: "ls" } });
		assert.deepEqual(
			store.ordered(false).map((s) => s.sessionId),
			["c", "a", "b"],
		);
		const waiting = store.waitForDecision("claude:c", 5000);
		assert.equal(store.firstAnswerable().sessionId, "c");
		assert.equal(store.decide("claude:c", "deny"), true);
		assert.deepEqual(await waiting, { behavior: "deny" });
		assert.equal(store.get("claude:c").activity, "thinking");
		store.close();
	});
});

describe("demo mode", () => {
	it("fills the deck with sessions in many states and clears them again", () => {
		const store = new lib.SessionStore({ doneToIdleSeconds: 0, hideIdleAfterMinutes: 0, offlineAfterMinutes: 0 });
		const applied = new Map();
		const seen = new Set();
		for (let t = 0; t < 100; t += 2) {
			lib.runDemo(store, t, applied);
			for (const s of store.sessions.values()) seen.add(s.activity);
		}
		assert.equal(store.sessions.size, lib.DEMO_SCRIPTS.length);
		for (const state of ["thinking", "tool", "writing", "approval", "question", "done", "error", "idle"]) assert.ok(seen.has(state), state);
		lib.clearDemo(store);
		assert.equal(store.sessions.size, 0);
		store.close();
	});
});

describe("tiles", () => {
	const ctx = { now: Date.now(), palette: lib.AGENTS, animate: true };
	it("draws plain SVG without filters, masks or clip paths", () => {
		const store = new lib.SessionStore({ doneToIdleSeconds: 0, hideIdleAfterMinutes: 0, offlineAfterMinutes: 0 });
		for (const activity of lib.ACTIVITIES) {
			const s = store.upsert("claude", `t-${activity}`, { title: "A <title> & more", activity, toolLabel: "Bash  npm test", text: "Hello world." });
			const svg = lib.sessionTile(s, ctx);
			assert.match(svg, /^<svg /);
			assert.doesNotMatch(svg, /<filter|<mask|clip-path|rgba\(/);
			assert.match(svg, /A &lt;title&gt; &amp;/);
		}
		store.close();
	});
	it("wraps monospace text and keeps the tool double space", () => {
		assert.deepEqual(lib.wrapMono("Bash  npm test", 15, 2), ["Bash\u00a0 npm test"]);
		assert.deepEqual(lib.wrapMono("one two three four five", 9, 2), ["one two", "three…"]);
		assert.deepEqual(lib.wrapMono("one two three four five", 9, 2, true), ["three", "four five"]);
	});
	it("formats timers", () => {
		assert.equal(lib.fmtClock(83_000), "1:23");
		assert.equal(lib.fmtClock(3_723_000), "1:02:03");
		assert.equal(lib.fmtAge(125_000), "2m");
	});
});

describe("installer JSON", () => {
	it("reads settings with comments and trailing commas", () => {
		const dir = mkdtempSync(join(tmpdir(), "deck-unit-"));
		const file = join(dir, "settings.json");
		writeFileSync(file, '{\n // note\n "a": "http://x//y", /* block */ "b": [1,2,],\n}\n');
		assert.deepEqual(lib.readJson(file), { a: "http://x//y", b: [1, 2] });
		writeFileSync(file, "{ nope");
		assert.throws(() => lib.readJson(file), /not valid JSON/);
	});
	it("quotes paths for sh and PowerShell", () => {
		assert.equal(lib.shQuote("/Users/o'neil/x"), "'/Users/o'\\''neil/x'");
		assert.equal(lib.psCall("C:\\Users\\O'Neil\\hook.cmd"), "& 'C:\\Users\\O''Neil\\hook.cmd'");
	});
});

describe("versions", () => {
	it("manifest, package.json and the plugin agree", () => {
		const manifest = JSON.parse(readFileSync(join(root, "com.gabrielvaz.coding-agents.sdPlugin", "manifest.json"), "utf8"));
		const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
		assert.equal(manifest.Version, `${pkg.version}.0`);
		assert.equal(lib.VERSION, pkg.version);
	});
});
