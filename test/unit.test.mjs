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

describe("usage limits", () => {
	const now = Date.parse("2026-10-30T12:00:00Z");
	it("Claude: 5-hour window and the most used weekly window", () => {
		const limits = lib.mapClaudeUsage(
			{
				five_hour: { utilization: 12.5, resets_at: "2026-10-30T15:00:00Z" },
				seven_day: { utilization: 20, resets_at: "2026-11-02T09:00:00Z" },
				seven_day_opus: { utilization: 55, resets_at: "2026-11-02T09:00:00Z" },
				seven_day_oauth_apps: null,
			},
			now,
		);
		assert.equal(limits.status, "ok");
		assert.deepEqual(
			limits.windows.map((w) => [w.label, w.usedPercent]),
			[
				["5h", 12.5],
				["Week", 55],
			],
		);
		assert.equal(lib.mapClaudeUsage({}, now).status, "none");
	});
	it("Codex: last rate_limits of a session log; windows that rolled over read 0 %", () => {
		const event = (ts, primary, secondary) =>
			JSON.stringify({ timestamp: ts, type: "event_msg", payload: { type: "token_count", rate_limits: { primary, secondary } } });
		const log = [
			event("2026-10-30T10:00:00Z", { used_percent: 5, window_minutes: 300, resets_at: 1793383200 }, { used_percent: 9, window_minutes: 10080, resets_at: 1793800000 }),
			'{"type":"other"}',
			event("2026-10-30T11:00:00Z", { used_percent: 30, window_minutes: 300, resets_at: Date.parse("2026-10-30T11:30:00Z") / 1000 }, { used_percent: 40, window_minutes: 10080, resets_at: 1793800000 }),
		].join("\n");
		const limits = lib.codexFromSessionLog(log, now);
		assert.equal(limits.updatedAt, Date.parse("2026-10-30T11:00:00Z"));
		const [five, week] = limits.windows;
		assert.equal(five.label, "5h");
		assert.equal(five.usedPercent, 0, "the 5-hour window reset at 11:30");
		assert.equal(five.resetsAt, Date.parse("2026-10-30T16:30:00Z"));
		assert.deepEqual([week.label, week.usedPercent], ["Week", 40]);
		assert.equal(lib.codexFromSessionLog('{"type":"x"}', now), null);
	});
	it("Antigravity: one row per model family, most used first, no Gemini 2.x", () => {
		const limits = lib.mapAntigravityModels(
			[
				{ label: "Claude Opus 5.5 (High)", model: "a", remainingFraction: 0.4, resetTime: "2026-10-30T17:00:00Z" },
				{ label: "Claude Opus 5.5 (Low)", model: "b", remainingFraction: 0.9, resetTime: "2026-10-30T17:00:00Z" },
				{ label: "Gemini 3 Pro (High)", model: "gemini-3-pro", remainingFraction: 1 },
				{ label: "Gemini 2.5 Flash", model: "gemini-2.5-flash", remainingFraction: 0.1 },
			],
			now,
		);
		assert.deepEqual(
			limits.windows.map((w) => [w.label, Math.round(w.usedPercent)]),
			[
				["Opus 5.5", 60],
				["Gemini 3 Pro", 0],
			],
		);
		assert.equal(lib.mapAntigravityModels([], now).status, "none");
	});
	it("draws what is left and when it resets", () => {
		const ctx = { now, palette: lib.AGENTS, animate: false };
		const svg = lib.limitsTile({ provider: "claude", status: "ok", updatedAt: now, note: "", windows: [{ label: "5h", usedPercent: 92, resetsAt: now + 3 * 3_600_000 + 12 * 60_000, windowMinutes: 300 }] }, ctx);
		assert.match(svg, /8%/);
		assert.match(svg, /resets 3h 12m/);
		assert.match(svg, new RegExp(lib.ERROR), "almost used up → red bar");
		assert.match(lib.limitsTile({ provider: "codex", status: "none", updatedAt: 0, note: "Run Codex once", windows: [] }, ctx), /Run Codex once/);
		assert.equal(lib.fmtReset(4 * 86_400_000 + 2 * 3_600_000), "4d 2h");
	});
	it("the watcher polls only providers with a key and keeps good numbers through errors", async () => {
		let calls = 0;
		let fail = false;
		const good = { provider: "claude", status: "ok", windows: [], updatedAt: 1, note: "" };
		const watcher = new lib.LimitsWatcher(() => {}, () => {}, {
			claude: async () => {
				calls++;
				if (fail) throw new Error("offline");
				return good;
			},
			codex: async () => assert.fail("codex has no key"),
			antigravity: async () => assert.fail("antigravity has no key"),
		});
		assert.equal(watcher.get("claude").status, "loading");
		watcher.watch(["claude"]);
		await lib.sleep(10);
		assert.equal(calls, 1);
		fail = true;
		assert.equal((await watcher.refresh("claude")).status, "ok");
		watcher.stop();
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
