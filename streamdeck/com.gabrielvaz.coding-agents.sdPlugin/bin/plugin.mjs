#!/usr/bin/env node
/**
 * Coding Agents — Elgato Stream Deck plugin (SDK 2, Node.js runtime).
 *
 * Zero dependencies: a minimal RFC 6455 WebSocket client talks to the Stream Deck app, an SSE client
 * follows the Agent Deck server, and every key is rendered as an SVG tile that mirrors the browser
 * board (title, state + timer, detail, orb, agent badge).
 *
 * Keys:
 *   Agent Session  press = open that session's window · hold ≥ 0.6 s = allow a pending approval
 *   Agents Hub     press = open the first session waiting for you · hold = next page
 *   Allow / Deny   first pending approval
 *   Next Page      cycles the session keys through pages of 8
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------------- args
const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const SD_PORT = Number(arg("-port"));
const PLUGIN_UUID = arg("-pluginUUID");
const REGISTER_EVENT = arg("-registerEvent");
const ACTION = {
  session: "com.gabrielvaz.coding-agents.session",
  hub: "com.gabrielvaz.coding-agents.hub",
  allow: "com.gabrielvaz.coding-agents.allow",
  deny: "com.gabrielvaz.coding-agents.deny",
  page: "com.gabrielvaz.coding-agents.page",
};
const HOLD_MS = 600;
const PAGE_SIZE = 8;
const WAITING = new Set(["waitingPermission", "waitingQuestion"]);
const WORKING = new Set(["starting", "thinking", "tool", "streaming", "compacting"]);
const LABELS = {
  starting: "Starting",
  idle: "Idle",
  thinking: "Thinking",
  tool: "Tool",
  streaming: "Writing",
  waitingPermission: "Approval",
  waitingQuestion: "Question",
  done: "Done",
  error: "Error",
  compacting: "Compacting",
  offline: "Offline",
};

const log = (...parts) => console.log(new Date().toISOString(), ...parts);

// ---------------------------------------------------------------------------------- minimal WebSocket client
class MiniWebSocket {
  constructor(port, onMessage, onClose) {
    this.onMessage = onMessage;
    this.onClose = onClose;
    this.buffer = Buffer.alloc(0);
    this.open = false;
    this.socket = createConnection({ host: "127.0.0.1", port }, () => {
      const key = randomBytes(16).toString("base64");
      this.accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
      this.socket.write(
        `GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
    this.socket.on("data", (chunk) => this.onData(chunk));
    this.socket.on("close", () => onClose());
    this.socket.on("error", (error) => log("ws error", error.message));
    this.pendingSend = [];
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (!this.open) {
      const end = this.buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      const head = this.buffer.slice(0, end).toString();
      this.buffer = this.buffer.slice(end + 4);
      if (!/ 101 /.test(head) || !head.includes(this.accept)) {
        log("ws handshake failed", head.split("\r\n")[0]);
        this.socket.destroy();
        return;
      }
      this.open = true;
      for (const text of this.pendingSend.splice(0)) this.send(text);
    }
    for (;;) {
      if (this.buffer.length < 2) return;
      const fin = (this.buffer[0] & 0x80) !== 0;
      const opcode = this.buffer[0] & 0x0f;
      const masked = (this.buffer[1] & 0x80) !== 0;
      let len = this.buffer[1] & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.buffer.length < 4) return;
        len = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.buffer.length < 10) return;
        len = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }
      const maskKey = masked ? this.buffer.slice(offset, offset + 4) : null;
      if (masked) offset += 4;
      if (this.buffer.length < offset + len) return;
      let payload = this.buffer.slice(offset, offset + len);
      this.buffer = this.buffer.slice(offset + len);
      if (masked) payload = Buffer.from(payload.map((b, i) => b ^ maskKey[i % 4]));
      if (opcode === 0x1) {
        if (!fin) this.fragments = (this.fragments ?? "") + payload.toString("utf8");
        else this.onMessage((this.fragments ?? "") + payload.toString("utf8"));
        if (fin) this.fragments = "";
      } else if (opcode === 0x0) {
        this.fragments = (this.fragments ?? "") + payload.toString("utf8");
        if (fin) {
          this.onMessage(this.fragments);
          this.fragments = "";
        }
      } else if (opcode === 0x9) {
        this.frame(0xa, payload);
      } else if (opcode === 0x8) {
        this.socket.end();
      }
    }
  }

  frame(opcode, payload) {
    const mask = randomBytes(4);
    const len = payload.length;
    let header;
    if (len < 126) header = Buffer.from([0x80 | opcode, 0x80 | len]);
    else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    const masked = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]));
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  send(text) {
    if (!this.open) {
      this.pendingSend.push(text);
      return;
    }
    this.frame(0x1, Buffer.from(text, "utf8"));
  }
}

// ---------------------------------------------------------------------------------- Agent Deck server client
const deck = {
  url: "",
  token: "",
  connected: false,
  sessions: [],
  summary: { working: 0, waiting: 0, done: 0, errors: 0, leading: null, perAgent: {} },
  palette: {},
  serverOffset: 0,
  request: null,
  reconnectTimer: null,
};

function readLocalConfig() {
  const home = process.env.AGENT_DECK_HOME || join(homedir(), ".agent-deck");
  const file = join(home, "config.json");
  if (!existsSync(file)) return null;
  try {
    const cfg = JSON.parse(readFileSync(file, "utf8"));
    return { url: `http://127.0.0.1:${cfg.port || 7777}`, token: cfg.requireToken === false ? "" : cfg.token || "" };
  } catch {
    return null;
  }
}

function resolveServer(globalSettings) {
  const local = readLocalConfig();
  deck.url = (globalSettings.url || local?.url || "http://127.0.0.1:7777").replace(/\/+$/, "");
  deck.token = globalSettings.token || local?.token || "";
}

function requester(url) {
  return url.startsWith("https:") ? httpsRequest : httpRequest;
}

function connectDeck() {
  if (deck.request) {
    deck.request.destroy();
    deck.request = null;
  }
  const url = new URL(`${deck.url}/api/v1/events`);
  if (deck.token) url.searchParams.set("k", deck.token);
  const req = requester(deck.url)(url, { method: "GET", headers: { Accept: "text/event-stream" } }, (res) => {
    if (res.statusCode !== 200) {
      log("deck SSE status", res.statusCode);
      setStatus(false, res.statusCode === 401 ? "Unauthorized: set the token" : `server answered ${res.statusCode}`);
      res.resume();
      scheduleReconnect();
      return;
    }
    deck.connected = true;
    setStatus(true, `connected to ${deck.url}`);
    let buffer = "";
    res.setEncoding("utf8");
    res.on("data", (chunk) => {
      buffer += chunk;
      let index = buffer.indexOf("\n\n");
      while (index >= 0) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const data = block
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n");
        if (block.includes("event: snapshot") && data) {
          try {
            applySnapshot(JSON.parse(data));
          } catch (error) {
            log("bad snapshot", error.message);
          }
        }
        index = buffer.indexOf("\n\n");
      }
    });
    res.on("end", () => {
      deck.connected = false;
      setStatus(false, "disconnected");
      scheduleReconnect();
    });
  });
  req.on("error", (error) => {
    deck.connected = false;
    setStatus(false, `cannot reach ${deck.url} (${error.code || error.message})`);
    scheduleReconnect();
  });
  req.end();
  deck.request = req;
}

function scheduleReconnect() {
  clearTimeout(deck.reconnectTimer);
  deck.reconnectTimer = setTimeout(connectDeck, 3000);
  renderAll();
}

function applySnapshot(snapshot) {
  deck.serverOffset = snapshot.now - Date.now();
  deck.sessions = snapshot.sessions.filter((s) => s.activity !== "offline" || showOffline);
  deck.summary = snapshot.summary;
  deck.palette = snapshot.palette || {};
  const maxPage = Math.max(0, Math.ceil(deck.sessions.length / PAGE_SIZE) - 1);
  if (page > maxPage) page = maxPage;
  renderAll();
}

function deckAction(uid, action, extra = {}) {
  return new Promise((resolve) => {
    const url = new URL(`${deck.url}/api/v1/sessions/${encodeURIComponent(uid)}/actions`);
    if (deck.token) url.searchParams.set("k", deck.token);
    const body = JSON.stringify({ action, ...extra });
    const req = requester(deck.url)(url, { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }, timeout: 15000 }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          resolve({ ok: false, reason: `status ${res.statusCode}` });
        }
      });
    });
    req.on("error", (error) => resolve({ ok: false, reason: error.message }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, reason: "timeout" });
    });
    req.end(body);
  });
}

// ---------------------------------------------------------------------------------- Stream Deck state
const keys = new Map(); // context → { action, settings, coordinates, device, pressedAt, holdTimer }
let page = 0;
let showOffline = false;
let globalSettings = {};
let lastStatus = { ok: false, text: "starting" };
let sd;

function sdSend(payload) {
  sd?.send(JSON.stringify(payload));
}

function setStatus(ok, text) {
  lastStatus = { ok, text };
  for (const [context, key] of keys) {
    if (key.inspectorOpen) sdSend({ event: "sendToPropertyInspector", context, payload: { ok, status: text } });
  }
}

/** Session keys get a slot: explicit from settings, or by position (row-major, per device). */
function slotFor(context) {
  const key = keys.get(context);
  if (!key) return 0;
  const explicit = Number(key.settings?.slot);
  if (Number.isInteger(explicit) && explicit > 0) return explicit - 1;
  const siblings = [...keys.entries()]
    .filter(([, k]) => k.action === ACTION.session && !(Number(k.settings?.slot) > 0) && k.device === key.device)
    .sort((a, b) => a[1].coordinates.row - b[1].coordinates.row || a[1].coordinates.column - b[1].coordinates.column);
  return siblings.findIndex(([ctx]) => ctx === context);
}

function sessionFor(context) {
  const slot = slotFor(context);
  if (slot < 0) return null;
  return deck.sessions[page * PAGE_SIZE + slot] ?? null;
}

// ---------------------------------------------------------------------------------- rendering (SVG tiles)
const esc = (text) => String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const now = () => Date.now() + deck.serverOffset;

function agentInfo(id) {
  return deck.palette[id] || deck.palette.custom || { name: id, short: id, mono: "?", color: "#9aa0a8", alarm: "#ff8a3d" };
}

function colorsFor(session) {
  const info = agentInfo(session.agent);
  if (session.activity === "error") return { orb: "#ff3b3b", label: "#ff3b3b" };
  if (WAITING.has(session.activity)) return { orb: info.alarm, label: info.alarm };
  if (session.activity === "offline") return { orb: "#6a6f78", label: "#6a6f78" };
  if (session.activity === "idle") return { orb: info.color, label: "#9aa0a8" };
  if (session.activity === "done") return { orb: info.color, label: "#eef0f3" };
  return { orb: info.color, label: info.color };
}

function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 3600) return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
function fmtAgo(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
function timerText(session) {
  const ms = now() - session.activitySince;
  return WORKING.has(session.activity) || WAITING.has(session.activity) || session.activity === "error" ? fmtElapsed(ms) : fmtAgo(ms);
}

function detailLines(session) {
  let text = "";
  switch (session.activity) {
    case "waitingPermission":
      text = session.approval ? `Allow ${session.approval.toolName}? ${session.approval.commandSummary || ""}` : session.statusDetail || "Waiting";
      break;
    case "waitingQuestion":
      text = session.question?.questions?.[0]?.text || session.statusDetail || "Question";
      break;
    case "tool":
      text = session.toolLabel || "";
      break;
    case "streaming":
      text = (session.message?.text || "").slice(-90);
      break;
    case "done":
      text = session.lastLine || "";
      break;
    case "error":
      text = session.statusDetail || "error";
      break;
    case "starting":
      text = session.model || "";
      break;
    default:
      text = session.statusDetail || "";
  }
  return wrap(text.replace(/\s+/g, " ").trim(), 19, 2);
}

function wrap(text, width, maxLines) {
  const words = text.split(" ");
  const lines = [];
  let line = "";
  for (const word of words) {
    if (!word) continue;
    if ((line + (line ? " " : "") + word).length > width) {
      if (line) lines.push(line);
      line = word.length > width ? `${word.slice(0, width - 1)}…` : word;
      if (lines.length === maxLines) break;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (lines.length < maxLines && line) lines.push(line);
  if (lines.length === maxLines && words.join(" ").length > lines.join(" ").length) lines[maxLines - 1] = `${lines[maxLines - 1].slice(0, width - 1)}…`;
  return lines.slice(0, maxLines);
}

const clipText = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

let gradientSeq = 0;
function orbSvg(color, opacity, glowBoost = 1) {
  // radial gradients (no filters): every Stream Deck rasterizer renders them smoothly
  gradientSeq += 1;
  const id = `g${gradientSeq}`;
  const o = Math.min(1, opacity * glowBoost);
  return `<defs>
    <radialGradient id="${id}" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="${color}" stop-opacity="${(0.95 * o).toFixed(3)}"/>
      <stop offset="0.35" stop-color="${color}" stop-opacity="${(0.55 * o).toFixed(3)}"/>
      <stop offset="0.7" stop-color="${color}" stop-opacity="${(0.14 * o).toFixed(3)}"/>
      <stop offset="1" stop-color="${color}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="${id}c" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#ffffff" stop-opacity="${(0.95 * opacity).toFixed(3)}"/>
      <stop offset="0.45" stop-color="${color}" stop-opacity="${(0.6 * opacity).toFixed(3)}"/>
      <stop offset="1" stop-color="${color}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <circle cx="72" cy="150" r="86" fill="url(#${id})"/>
  <circle cx="72" cy="146" r="34" fill="url(#${id}c)"/>`;
}

function sessionSvg(session) {
  const info = agentInfo(session.agent);
  const colors = colorsFor(session);
  const dim = session.activity === "offline" ? 0.3 : session.activity === "idle" ? 0.55 : 1;
  const pulse = WAITING.has(session.activity) ? 0.75 + 0.25 * Math.sin(Date.now() / 160) : 1;
  const unseen = !session.seen && (session.activity === "done" || WAITING.has(session.activity));
  const title = clipText(session.title || session.project || session.sessionId, 15);
  const detail = detailLines(session);
  const textColor = session.activity === "offline" ? "#5f646c" : "#eef0f3";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
  <defs><clipPath id="c"><rect x="4" y="4" width="136" height="136" rx="18"/></clipPath></defs>
  <rect width="144" height="144" rx="22" fill="#1b1e24"/>
  <rect x="4" y="4" width="136" height="136" rx="18" fill="#050607"/>
  <g clip-path="url(#c)">${orbSvg(colors.orb, dim, pulse)}</g>
  ${WAITING.has(session.activity) ? `<rect x="5.5" y="5.5" width="133" height="133" rx="17" fill="none" stroke="${colors.orb}" stroke-opacity="0.6" stroke-width="3"/>` : ""}
  ${unseen ? `<circle cx="16" cy="22" r="4" fill="#ffffff"/>` : ""}
  <text x="${unseen ? 24 : 12}" y="27" font-family="-apple-system, Segoe UI, Helvetica, Arial, sans-serif" font-size="14" font-weight="700" fill="${textColor}">${esc(title)}</text>
  <text x="12" y="47" font-family="-apple-system, Segoe UI, Helvetica, Arial, sans-serif" font-size="14" font-weight="700" fill="${colors.label}">${esc(LABELS[session.activity] || session.activity)}</text>
  <text x="132" y="47" text-anchor="end" font-family="Menlo, Consolas, monospace" font-size="13" fill="#c9ccd1">${esc(timerText(session))}</text>
  ${detail.map((line, i) => `<text x="12" y="${65 + i * 15}" font-family="Menlo, Consolas, monospace" font-size="11" fill="#d8dadf">${esc(line)}</text>`).join("")}
  <rect x="108" y="112" width="26" height="22" rx="6" fill="#ffffff" fill-opacity="0.16"/>
  <text x="121" y="128" text-anchor="middle" font-family="-apple-system, Segoe UI, Helvetica, Arial, sans-serif" font-size="12" font-weight="700" fill="#ffffff">${esc(info.mono || info.short)}</text>
  ${session.subagentCount > 0 ? `<text x="12" y="129" font-family="Helvetica, Arial, sans-serif" font-size="11" fill="#cfd3d9">+${session.subagentCount}</text>` : ""}
</svg>`;
}

function emptySvg(label = "") {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
  <rect width="144" height="144" rx="22" fill="#1b1e24"/><rect x="4" y="4" width="136" height="136" rx="18" fill="#050607"/>
  <circle cx="72" cy="72" r="6" fill="#2b2e34"/>
  ${label ? `<text x="72" y="118" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="11" fill="#5f646c">${esc(label)}</text>` : ""}
</svg>`;
}

function hubSvg() {
  const s = deck.summary;
  const pageCount = Math.max(1, Math.ceil(deck.sessions.length / PAGE_SIZE));
  const urgent = deck.sessions.find((x) => WAITING.has(x.activity));
  const glow = urgent ? colorsFor(urgent).orb : s.errors > 0 ? "#ff3b3b" : s.working > 0 ? "#35e3a2" : "#5a5f68";
  const entries = Object.entries(s.perAgent || {}).sort((a, b) => b[1] - a[1]);
  const shown = entries.slice(0, entries.length > 4 ? 3 : 4);
  const rest = entries.length > 4 ? entries.slice(3).reduce((acc, [, n]) => acc + n, 0) : 0;
  const pips = deck.sessions.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
  const line2 = s.waiting > 0 ? clipText(`${s.waiting} waiting · ${s.leading || ""}`, 18) : "none waiting";
  const done = [s.done > 0 ? `${s.done} done` : "", s.errors > 0 ? `${s.errors} error${s.errors > 1 ? "s" : ""}` : ""].filter(Boolean).join(" · ");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
  <defs><clipPath id="c"><rect x="4" y="4" width="136" height="136" rx="18"/></clipPath></defs>
  <rect width="144" height="144" rx="22" fill="#1b1e24"/>
  <rect x="4" y="4" width="136" height="136" rx="18" fill="#050607"/>
  <g clip-path="url(#c)">${orbSvg(glow, 0.5, urgent ? 0.75 + 0.25 * Math.sin(Date.now() / 160) : 1)}</g>
  <text x="12" y="46" font-family="-apple-system, Segoe UI, Helvetica, Arial, sans-serif" font-size="40" font-weight="800" fill="${deck.connected ? "#ffffff" : "#5f646c"}">${deck.connected ? s.working : "–"}</text>
  <text x="${String(s.working).length > 1 ? 62 : 42}" y="30" font-family="-apple-system, Segoe UI, Helvetica, Arial, sans-serif" font-size="13" font-weight="700" fill="#ffffff">working</text>
  <text x="${String(s.working).length > 1 ? 62 : 42}" y="45" font-family="-apple-system, Segoe UI, Helvetica, Arial, sans-serif" font-size="10" fill="${s.waiting > 0 ? "#ff8a5c" : "#aeb3bb"}">${esc(deck.connected ? line2 : lastStatus.text.slice(0, 20))}</text>
  <text x="12" y="68" font-family="-apple-system, Segoe UI, Helvetica, Arial, sans-serif" font-size="11" fill="#e3e5e9">${esc(done)}</text>
  ${shown.map(([agent, count], i) => `<text x="${12 + i * 30}" y="86" font-family="Helvetica, Arial, sans-serif" font-size="12" font-weight="700" fill="${agentInfo(agent).color}">•${count > 99 ? "99+" : count}</text>`).join("")}
  ${rest > 0 ? `<text x="${12 + shown.length * 30}" y="86" font-family="Helvetica, Arial, sans-serif" font-size="12" font-weight="700" fill="#b9c3d1">•+${rest}</text>` : ""}
  ${Array.from({ length: PAGE_SIZE }, (_, i) => `<circle cx="${18 + i * 15.4}" cy="126" r="4.5" fill="${pips[i] ? colorsFor(pips[i]).orb : "#2a2d33"}"/>`).join("")}
  ${pageCount > 1 ? `<text x="132" y="104" text-anchor="end" font-family="Helvetica, Arial, sans-serif" font-size="10" fill="#8b9099">${page + 1}/${pageCount}</text>` : ""}
</svg>`;
}

function buttonSvg(kind) {
  const target = deck.sessions.find((x) => x.activity === "waitingPermission");
  const active = Boolean(target);
  const color = kind === "allow" ? "#1f8f5a" : kind === "deny" ? "#a3342f" : "#2a2e35";
  const label = kind === "allow" ? "Allow" : kind === "deny" ? "Deny" : "Page";
  const sub = kind === "page" ? `${page + 1}/${Math.max(1, Math.ceil(deck.sessions.length / PAGE_SIZE))}` : active ? clipText(target.title, 16) : "nothing pending";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
  <rect width="144" height="144" rx="22" fill="#1b1e24"/>
  <rect x="4" y="4" width="136" height="136" rx="18" fill="${active || kind === "page" ? color : "#0b0c0e"}"/>
  <text x="72" y="70" text-anchor="middle" font-family="-apple-system, Segoe UI, Helvetica, Arial, sans-serif" font-size="26" font-weight="800" fill="${active || kind === "page" ? "#ffffff" : "#3a3e46"}">${label}</text>
  <text x="72" y="96" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="11" fill="${active || kind === "page" ? "#e6e8ec" : "#3a3e46"}">${esc(sub)}</text>
</svg>`;
}

function setImage(context, svg) {
  sdSend({ event: "setImage", context, payload: { image: `data:image/svg+xml;charset=utf8,${encodeURIComponent(svg)}`, target: 0 } });
}

function renderKey(context) {
  const key = keys.get(context);
  if (!key) return;
  if (key.action === ACTION.session) {
    const session = deck.connected ? sessionFor(context) : null;
    setImage(context, session ? sessionSvg(session) : emptySvg(deck.connected ? "" : "offline"));
  } else if (key.action === ACTION.hub) {
    setImage(context, hubSvg());
  } else if (key.action === ACTION.allow) {
    setImage(context, buttonSvg("allow"));
  } else if (key.action === ACTION.deny) {
    setImage(context, buttonSvg("deny"));
  } else if (key.action === ACTION.page) {
    setImage(context, buttonSvg("page"));
  }
}

function renderAll() {
  for (const context of keys.keys()) renderKey(context);
}

// ---------------------------------------------------------------------------------- key handling
async function act(context, uid, action, extra) {
  const result = await deckAction(uid, action, extra);
  sdSend({ event: result.ok ? "showOk" : "showAlert", context });
  if (!result.ok) log(`${action} failed: ${result.reason}`);
  return result;
}

function onKeyDown(context) {
  const key = keys.get(context);
  if (!key) return;
  key.pressedAt = Date.now();
  key.held = false;
  clearTimeout(key.holdTimer);
  key.holdTimer = setTimeout(() => {
    key.held = true;
    if (key.action === ACTION.session) {
      const session = sessionFor(context);
      if (session?.activity === "waitingPermission") void act(context, session.uid, "allow");
      else if (session?.activity === "waitingQuestion" && session.question) void act(context, session.uid, "answer", { picks: [[0]] });
      else if (session) void act(context, session.uid, "read");
    } else if (key.action === ACTION.hub) {
      nextPage();
    }
  }, HOLD_MS);
}

function onKeyUp(context) {
  const key = keys.get(context);
  if (!key) return;
  clearTimeout(key.holdTimer);
  if (key.held) return;
  if (key.action === ACTION.session) {
    const session = sessionFor(context);
    if (session) void act(context, session.uid, "focus");
    else sdSend({ event: "showAlert", context });
  } else if (key.action === ACTION.hub) {
    const waiting = deck.sessions.find((x) => WAITING.has(x.activity));
    if (waiting) void act(context, waiting.uid, "focus");
    else if (!deck.connected) connectDeck();
    else sdSend({ event: "showOk", context });
  } else if (key.action === ACTION.allow || key.action === ACTION.deny) {
    const target = deck.sessions.find((x) => x.activity === "waitingPermission");
    if (target) void act(context, target.uid, key.action === ACTION.allow ? "allow" : "deny");
    else sdSend({ event: "showAlert", context });
  } else if (key.action === ACTION.page) {
    nextPage();
  }
}

function nextPage() {
  const pageCount = Math.max(1, Math.ceil(deck.sessions.length / PAGE_SIZE));
  page = (page + 1) % pageCount;
  renderAll();
}

// ---------------------------------------------------------------------------------- Stream Deck events
function onStreamDeckMessage(text) {
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return;
  }
  const { event, context, action, payload = {}, device } = msg;
  switch (event) {
    case "willAppear":
      keys.set(context, { action, settings: payload.settings || {}, coordinates: payload.coordinates || { row: 0, column: 0 }, device, inspectorOpen: false });
      renderAll();
      break;
    case "willDisappear":
      keys.delete(context);
      renderAll();
      break;
    case "didReceiveSettings": {
      const key = keys.get(context);
      if (key) key.settings = payload.settings || {};
      renderAll();
      break;
    }
    case "didReceiveGlobalSettings":
      globalSettings = payload.settings || {};
      showOffline = Boolean(globalSettings.showOffline);
      resolveServer(globalSettings);
      connectDeck();
      break;
    case "propertyInspectorDidAppear": {
      const key = keys.get(context);
      if (key) key.inspectorOpen = true;
      sdSend({ event: "sendToPropertyInspector", context, payload: { ok: lastStatus.ok, status: lastStatus.text } });
      break;
    }
    case "propertyInspectorDidDisappear": {
      const key = keys.get(context);
      if (key) key.inspectorOpen = false;
      break;
    }
    case "keyDown":
      onKeyDown(context);
      break;
    case "keyUp":
      onKeyUp(context);
      break;
    case "systemDidWakeUp":
      connectDeck();
      break;
    default:
      break;
  }
}

function start() {
  if (!SD_PORT || !PLUGIN_UUID || !REGISTER_EVENT) {
    console.error("This plugin is started by the Stream Deck app (-port -pluginUUID -registerEvent -info).");
    process.exit(1);
  }
  sd = new MiniWebSocket(
    SD_PORT,
    onStreamDeckMessage,
    () => {
      log("Stream Deck closed the socket; exiting");
      process.exit(0);
    },
  );
  sd.send(JSON.stringify({ event: REGISTER_EVENT, uuid: PLUGIN_UUID }));
  sd.send(JSON.stringify({ event: "getGlobalSettings", context: PLUGIN_UUID }));
  resolveServer({});
  connectDeck();
  setInterval(() => {
    if (deck.sessions.length > 0 || !deck.connected) renderAll();
  }, 1000);
}

start();
