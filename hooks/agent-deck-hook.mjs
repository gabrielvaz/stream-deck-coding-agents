#!/usr/bin/env node
/**
 * Universal hook for Agent Deck.
 *
 *   node agent-deck-hook.mjs <agent> [eventName]
 *
 * Reads the hook JSON from stdin, forwards it to the local Agent Deck server and prints
 * whatever the server answers (a permission decision, or `{}`). It never fails the agent:
 * when the server is down it prints nothing (or the agent's neutral reply) and exits 0.
 *
 * Zero dependencies and no imports from the package, so it starts fast on every tool call.
 */
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

const agent = process.argv[2] || "claude";
const eventArg = process.argv[3] || "";
const NEUTRAL = {
  antigravity: { PreToolUse: { decision: "allow" }, Stop: { decision: "stop" } },
};

function port() {
  if (process.env.AGENT_DECK_PORT) return Number(process.env.AGENT_DECK_PORT);
  try {
    const home = process.env.AGENT_DECK_HOME || join(homedir(), ".agent-deck");
    const stored = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    if (Number.isInteger(stored.port)) return stored.port;
  } catch {
    // no config yet
  }
  return 7777;
}

function neutralReply() {
  const reply = NEUTRAL[agent]?.[eventArg];
  return reply ? JSON.stringify(reply) : "";
}

let input = "";
try {
  input = readFileSync(0, "utf8");
} catch {
  input = "";
}
let payload = {};
try {
  payload = input.trim() ? JSON.parse(input) : {};
} catch {
  payload = {};
}
const event = eventArg || payload.hook_event_name || payload.hookEventName || "";
const isDecision = event === "PermissionRequest";
const responseTimeout = isDecision ? 90_000 : 4_000;

const query = new URLSearchParams();
if (event) query.set("event", event);
if (process.ppid) query.set("pid", String(process.ppid)); // the agent process that spawned this hook
if (process.env.AGENT_DECK_HOST_ALIAS) query.set("host", process.env.AGENT_DECK_HOST_ALIAS);
const body = JSON.stringify(payload);

const req = request(
  {
    host: process.env.AGENT_DECK_SERVER || "127.0.0.1",
    port: port(),
    method: "POST",
    path: `/api/v1/hook/${encodeURIComponent(agent)}?${query.toString()}`,
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
      ...(process.env.AGENT_DECK_TOKEN ? { "X-Agent-Deck-Token": process.env.AGENT_DECK_TOKEN } : {}),
    },
    // socket inactivity timeout: a held PermissionRequest legitimately waits for the deck
    timeout: responseTimeout,
  },
  (res) => {
    res.setTimeout(responseTimeout, () => {
      finish(neutralReply());
      res.destroy();
    });
    const chunks = [];
    res.on("data", (chunk) => chunks.push(chunk));
    res.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      finish(text && text !== "{}" ? text : neutralReply());
    });
    res.on("error", () => finish(neutralReply()));
  },
);
req.on("timeout", () => {
  req.destroy();
  finish(neutralReply());
});
req.on("error", () => finish(neutralReply()));
req.end(body);

let done = false;
function finish(text) {
  if (done) return;
  done = true;
  if (text) process.stdout.write(`${text}\n`);
  process.exit(0);
}
