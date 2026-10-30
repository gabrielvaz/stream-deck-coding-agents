#!/usr/bin/env node
/**
 * E2E smoke test for Agent Deck. Starts the real server on a free port, drives it through the
 * real hook script, the SSE stream, the actions API and the Orbtile-compatible adapter API, and
 * writes a JSON report to .build/agent-deck-e2e.json. Exit code 1 on any failure.
 *
 *   node apps/agent-deck/scripts/agent-deck-e2e.mjs
 */
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPORT = join(APP, ".build", "agent-deck-e2e.json");
const HOME = mkdtempSync(join(tmpdir(), "agent-deck-e2e-"));
const PORT = 7700 + Math.floor(Math.random() * 200);
process.env.AGENT_DECK_HOME = HOME;
process.env.AGENT_DECK_PORT = String(PORT);
const env = { ...process.env };

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "✔" : "✘"} ${name}${detail ? ` — ${detail}` : ""}`);
}

function runHook(agent, payload, event) {
  return new Promise((resolveRun) => {
    const args = [join(APP, "hooks", "agent-deck-hook.mjs"), agent];
    if (event) args.push(event);
    const child = spawn(process.execPath, args, { env });
    let out = "";
    child.stdout.on("data", (c) => {
      out += c;
    });
    child.on("close", (code) => resolveRun({ code, out: out.trim() }));
    child.stdin.end(JSON.stringify(payload));
  });
}

async function api(path, options = {}, token) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { "X-Agent-Deck-Token": token } : {}),
      ...(options.headers ?? {}),
    },
  });
  const text = await res.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body, headers: res.headers };
}

const session = (state, id) => state.sessions.find((s) => s.sessionId === id);

const server = spawn(
  process.execPath,
  [join(APP, "bin", "agent-deck.mjs"), "serve", "--host", "127.0.0.1", "--no-herdr"],
  {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let serverLog = "";
server.stdout.on("data", (c) => {
  serverLog += c;
});
server.stderr.on("data", (c) => {
  serverLog += c;
});

try {
  // wait for the server
  let up = false;
  for (let i = 0; i < 50 && !up; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/healthz`);
      up = res.ok;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  check("server starts", up, `port ${PORT}`);
  const token = (await import(join(APP, "src", "config.mjs"))).loadConfig().token;
  check("token generated", typeof token === "string" && token.length > 20);

  // static + auth
  check("serves the deck UI", (await api("/")).status === 200);
  check("state needs the token", (await api("/api/v1/state")).status === 401);

  // Claude Code lifecycle through the real hook script
  let r = await runHook("claude", {
    session_id: "s1",
    cwd: "/home/me/docs-site",
    hook_event_name: "SessionStart",
    model: "claude-fable-5-1",
  });
  check("claude SessionStart hook exits 0 with no output", r.code === 0 && r.out === "", r.out);
  await runHook("claude", {
    session_id: "s1",
    cwd: "/home/me/docs-site",
    hook_event_name: "UserPromptSubmit",
    prompt: "Fix the menu layout\nmore",
  });
  await runHook("claude", {
    session_id: "s1",
    cwd: "/home/me/docs-site",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "npm test" },
  });
  let state = (await api("/api/v1/state", {}, token)).body;
  let s1 = session(state, "s1");
  check(
    "claude session is in Tool with label",
    s1?.activity === "tool" && s1.toolLabel === "Bash  npm test",
    JSON.stringify([s1?.activity, s1?.toolLabel]),
  );
  check("title comes from the prompt", s1?.title === "docs-site – Fix the menu layout", s1?.title);
  check("model from SessionStart", s1?.model === "claude-fable-5-1");

  // MessageDisplay through the http-style endpoint (no script)
  await api("/api/v1/hook/claude", {
    method: "POST",
    body: JSON.stringify({ session_id: "s1", hook_event_name: "MessageDisplay", message_id: "m1", delta: "Here is " }),
  });
  await api("/api/v1/hook/claude", {
    method: "POST",
    body: JSON.stringify({ session_id: "s1", hook_event_name: "MessageDisplay", message_id: "m1", delta: "the plan" }),
  });
  state = (await api("/api/v1/state", {}, token)).body;
  s1 = session(state, "s1");
  check(
    "streaming appends deltas",
    s1?.activity === "streaming" && s1.message?.text === "Here is the plan",
    s1?.message?.text,
  );

  // PermissionRequest without a viewer returns immediately with no decision
  let t0 = Date.now();
  r = await runHook("claude", {
    session_id: "s1",
    cwd: "/x",
    hook_event_name: "PermissionRequest",
    tool_name: "Bash",
    tool_input: { command: "rm -rf node_modules" },
  });
  check(
    "PermissionRequest with no viewer is not held",
    Date.now() - t0 < 2000 && r.out === "",
    `${Date.now() - t0} ms, out=${r.out}`,
  );
  state = (await api("/api/v1/state", {}, token)).body;
  check("session shows Approval", session(state, "s1")?.activity === "waitingPermission");

  // Connect a viewer (SSE), then hold + allow from the deck
  const controller = new AbortController();
  const sse = await fetch(`http://127.0.0.1:${PORT}/api/v1/events?k=${token}`, { signal: controller.signal });
  const reader = sse.body.getReader();
  const first = await reader.read();
  check(
    "SSE sends a snapshot",
    sse.status === 200 && new TextDecoder().decode(first.value).includes("event: snapshot"),
  );
  await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  t0 = Date.now();
  const held = runHook("claude", {
    session_id: "s1",
    cwd: "/x",
    hook_event_name: "PermissionRequest",
    tool_name: "Bash",
    tool_input: { command: "rm -rf node_modules" },
  });
  await new Promise((resolveWait) => setTimeout(resolveWait, 600));
  state = (await api("/api/v1/state", {}, token)).body;
  check(
    "held approval is answerable from the deck",
    session(state, "s1")?.canAnswer === "hook" && state.pending.length === 1,
    JSON.stringify(state.pending),
  );
  const action = await api(
    `/api/v1/sessions/${encodeURIComponent(session(state, "s1").uid)}/actions`,
    { method: "POST", body: JSON.stringify({ action: "allow" }) },
    token,
  );
  check("allow action accepted", action.status === 200 && action.body.via === "hook", JSON.stringify(action.body));
  r = await held;
  check(
    "hook returns the allow decision to Claude",
    r.out ===
      JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } }),
    r.out,
  );
  state = (await api("/api/v1/state", {}, token)).body;
  check("session moves to Tool after allow", session(state, "s1")?.activity === "tool");
  controller.abort();

  // Stop → done, SessionEnd → removed
  await runHook("claude", {
    session_id: "s1",
    cwd: "/x",
    hook_event_name: "Stop",
    last_assistant_message: "All done.\nSummary line",
  });
  state = (await api("/api/v1/state", {}, token)).body;
  check(
    "Stop sets Done with the last line",
    session(state, "s1")?.activity === "done" && session(state, "s1").lastLine === "Summary line",
  );
  await runHook("claude", { session_id: "s1", cwd: "/x", hook_event_name: "SessionEnd", reason: "other" });
  state = (await api("/api/v1/state", {}, token)).body;
  check("SessionEnd removes the tile", !session(state, "s1"));

  // Codex, Gemini, Antigravity
  await runHook("codex", { session_id: "t1", cwd: "/w/app", hook_event_name: "SessionStart", model: "gpt-5.5-codex" });
  await runHook("codex", { session_id: "t1", cwd: "/w/app", hook_event_name: "Interrupt" });
  await runHook("gemini", {
    session_id: "g1",
    cwd: "/w/site",
    hook_event_name: "Notification",
    notification_type: "ToolPermission",
    message: "Allow run_shell_command?",
  });
  r = await runHook(
    "antigravity",
    {
      conversationId: "c1",
      workspacePaths: ["/w/agy"],
      modelName: "gemini-3.6",
      toolCall: { name: "run_command", args: { CommandLine: "bun run build" } },
    },
    "PreToolUse",
  );
  check("antigravity PreToolUse answers {decision:allow}", r.out === '{"decision":"allow"}', r.out);
  r = await runHook(
    "antigravity",
    { conversationId: "c1", workspacePaths: ["/w/agy"], terminationReason: "model_stop", fullyIdle: true },
    "Stop",
  );
  check("antigravity Stop answers {decision:stop}", r.out === '{"decision":"stop"}', r.out);
  state = (await api("/api/v1/state", {}, token)).body;
  check("codex Interrupt → Idle", session(state, "t1")?.activity === "idle" && session(state, "t1").agent === "codex");
  check("gemini ToolPermission → Approval", session(state, "g1")?.activity === "waitingPermission");
  check(
    "antigravity session → Done with model",
    session(state, "c1")?.activity === "done" && session(state, "c1").model === "gemini-3.6",
  );
  check(
    "ordering: waiting first, then done, then idle",
    state.sessions.map((s) => s.sessionId).join(",") === "g1,c1,t1",
    state.sessions.map((s) => `${s.sessionId}:${s.activity}`).join(","),
  );
  check(
    "summary counts",
    state.summary.waiting === 1 && state.summary.done === 1 && state.summary.perAgent.codex === 1,
    JSON.stringify(state.summary),
  );

  // Orbtile-compatible adapter API
  const auth = { Authorization: `Bearer ${token}` };
  const nonce = "00112233445566778899aabbccddeeff";
  const info = await api("/a/v1/info", { headers: { ...auth, "X-Orbtile-Nonce": nonce } });
  check(
    "adapter /info proves the token with HMAC",
    info.body.proof === createHmac("sha256", token).update(nonce).digest("hex"),
  );
  const reg = await api("/a/v1/adapters/dev.example.python", {
    method: "PUT",
    headers: auth,
    body: JSON.stringify({ name: "PyAgent", palette: { baseHue: 200, attentionHue: 18 }, glyph: { monogram: "Py" } }),
  });
  check("adapter registers (201)", reg.status === 201 && reg.body.enabled === true, JSON.stringify(reg.body));
  const upd = await api("/a/v1/adapters/dev.example.python/sessions/demo-1", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ title: "PyAgent demo", activity: "tool", toolLabel: "Read  README.md" }),
  });
  check("adapter session update", upd.status === 200 && upd.body.session?.visible === true);
  const bad = await api("/a/v1/adapters/dev.example.python/sessions/demo-1", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ activity: "busy" }),
  });
  check("unknown activity → 422 invalid_field", bad.status === 422 && bad.body.error?.code === "invalid_field");
  check(
    "origin header refused",
    (await api("/a/v1/info", { headers: { ...auth, Origin: "http://evil" } })).status === 403,
  );
  state = (await api("/api/v1/state", {}, token)).body;
  check(
    "adapter gets a palette entry",
    state.palette["dev.example.python"]?.mono === "Py" && session(state, "demo-1")?.agent === "dev.example.python",
  );
  const hb = await api("/a/v1/adapters/dev.example.python/heartbeat", { method: "POST", headers: auth, body: "{}" });
  check("heartbeat → 204", hb.status === 204);
  const del = await api("/a/v1/adapters/dev.example.python", { method: "DELETE", headers: auth });
  state = (await api("/api/v1/state", {}, token)).body;
  check("adapter delete removes its sessions", del.status === 204 && !session(state, "demo-1"));
} catch (error) {
  check("unexpected error", false, error.stack ?? String(error));
} finally {
  server.kill("SIGTERM");
}

const failed = results.filter((r) => !r.ok);
mkdirSync(dirname(REPORT), { recursive: true });
writeFileSync(
  REPORT,
  `${JSON.stringify({ at: new Date().toISOString(), port: PORT, pass: results.length - failed.length, fail: failed.length, results, serverLog }, null, 2)}\n`,
);
console.log(`\n${results.length - failed.length}/${results.length} passed · report: ${REPORT}`);
process.exit(failed.length ? 1 : 0);
