#!/usr/bin/env node
/**
 * Coding Agents for Stream Deck: hook client.
 *
 *   node hook.mjs <agent> [event]
 *
 * Claude Code, Codex, Antigravity CLI and Gemini CLI run this on their hook events. It reads the
 * event JSON from stdin, forwards it to the Stream Deck plugin on 127.0.0.1 and prints the
 * plugin's answer (a permission decision, the terminal title, or `{}`).
 *
 * It never gets in the agent's way: if the plugin is not running it prints the neutral answer
 * for that agent and exits 0 within a fraction of a second. No dependencies.
 */
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

const agent = process.argv[2] || "claude";
const eventArg = process.argv[3] || "";
const HOME = process.env.CODING_AGENTS_DECK_HOME || join(homedir(), ".coding-agents-deck");

/** Neutral answers keep each CLI happy when the plugin is away. */
function neutral(event) {
	if (agent === "antigravity") {
		if (event === "PreToolUse") return '{"decision":"allow"}';
		if (event === "Title") return "";
		return "{}";
	}
	if (agent === "claude") return "";
	return "{}";
}

function endpoint() {
	let config = {};
	try {
		config = JSON.parse(readFileSync(join(HOME, "endpoint.json"), "utf8"));
	} catch {
		// plugin never ran on this account: use the defaults
	}
	const url = process.env.CODING_AGENTS_DECK_URL || "";
	if (url) {
		const parsed = new URL(url);
		return { host: parsed.hostname, port: Number(parsed.port) || 80, token: process.env.CODING_AGENTS_DECK_TOKEN || config.token || "" };
	}
	return { host: config.host || "127.0.0.1", port: Number(config.port) || 47821, token: process.env.CODING_AGENTS_DECK_TOKEN || config.token || "" };
}

function readStdin() {
	return new Promise((resolve) => {
		if (process.stdin.isTTY) return resolve("");
		const chunks = [];
		const timer = setTimeout(() => resolve(Buffer.concat(chunks).toString("utf8")), 3000);
		process.stdin.on("data", (c) => chunks.push(c));
		process.stdin.on("end", () => {
			clearTimeout(timer);
			resolve(Buffer.concat(chunks).toString("utf8"));
		});
		process.stdin.on("error", () => {
			clearTimeout(timer);
			resolve("");
		});
	});
}

function post(host, port, path, body, token, timeoutMs) {
	return new Promise((resolve) => {
		const req = request(
			{
				host,
				port,
				method: "POST",
				path,
				headers: {
					"Content-Type": "application/json",
					"Content-Length": Buffer.byteLength(body),
					...(token ? { Authorization: `Bearer ${token}` } : {}),
				},
				timeout: timeoutMs,
			},
			(res) => {
				const chunks = [];
				res.on("data", (c) => chunks.push(c));
				res.on("end", () => resolve({ ok: res.statusCode === 200, text: Buffer.concat(chunks).toString("utf8") }));
				res.on("error", () => resolve({ ok: false, text: "" }));
			},
		);
		req.on("timeout", () => {
			req.destroy();
			resolve({ ok: false, text: "", timeout: true });
		});
		// an unreachable host must not stall the agent: give the connection itself 1.5 s
		req.on("socket", (socket) => {
			if (!socket.connecting) return;
			const timer = setTimeout(() => req.destroy(new Error("connect timeout")), 1500);
			socket.once("connect", () => clearTimeout(timer));
		});
		req.on("error", () => resolve({ ok: false, text: "" }));
		req.end(body);
	});
}

let finished = false;
function finish(text) {
	if (finished) return;
	finished = true;
	if (text) process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
	process.exit(0);
}

async function main() {
	const input = await readStdin();
	let payload = {};
	try {
		payload = input.trim() ? JSON.parse(input) : {};
	} catch {
		payload = {};
	}
	const event = eventArg || payload.hook_event_name || payload.hookEventName || "";
	const waits = event === "PermissionRequest";
	const { host, port, token } = endpoint();

	const query = new URLSearchParams({ event, ppid: String(process.ppid || 0) });
	if (process.env.CLAUDE_PID) query.set("cpid", process.env.CLAUDE_PID);
	for (const [key, name] of [
		["term", "TERM_PROGRAM"],
		["wt", "WT_SESSION"],
		["iterm", "ITERM_SESSION_ID"],
		["tsid", "TERM_SESSION_ID"],
		["bundle", "__CFBundleIdentifier"],
	]) {
		if (process.env[name]) query.set(key, process.env[name].slice(0, 120));
	}
	if (process.env.WSL_DISTRO_NAME) query.set("wsl", process.env.WSL_DISTRO_NAME);
	const path = `/hook/${encodeURIComponent(agent)}?${query}`;
	const body = JSON.stringify(payload);
	const timeoutMs = waits ? 30 * 60_000 : 4000;

	const res = await post(host, port, path, body, token, timeoutMs);
	finish(res.ok ? res.text.trim() || neutral(event) : neutral(event));
}

// hard stop: never keep an agent waiting because of a stuck socket
setTimeout(() => finish(neutral(eventArg)), 31 * 60_000).unref();
main().catch(() => finish(neutral(eventArg)));

