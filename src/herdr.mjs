import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveAgentId } from "./agents.mjs";
import { clip } from "./util.mjs";

/**
 * herdr (https://herdr.dev) integration: reads agent status from the local socket
 * (newline-delimited JSON, `session.snapshot` + `events.subscribe`) and drives
 * approvals / focus through the documented `herdr agent ...` CLI.
 */
export function herdrSocketPath(config) {
  if (config?.herdr?.socketPath) return config.herdr.socketPath;
  if (process.env.HERDR_SOCKET_PATH) return process.env.HERDR_SOCKET_PATH;
  const base = join(homedir(), ".config", "herdr");
  if (process.env.HERDR_SESSION) return join(base, "sessions", process.env.HERDR_SESSION, "herdr.sock");
  return join(base, "herdr.sock");
}

const STATUS_MAP = {
  working: "thinking",
  blocked: "waitingPermission",
  idle: "idle",
  done: "done",
  unknown: "idle",
};

export class HerdrClient {
  constructor(store, config, log = console) {
    this.store = store;
    this.config = config;
    this.log = log;
    this.socketPath = herdrSocketPath(config);
    this.socket = null;
    this.buffer = "";
    this.requestId = 0;
    this.stopped = false;
    this.reconnectTimer = null;
    this.pollTimer = null;
    this.connected = false;
    this.known = new Set();
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.pollTimer);
    this.socket?.destroy();
  }

  connect() {
    if (this.stopped) return;
    if (!existsSync(this.socketPath)) {
      this.scheduleReconnect(5000);
      return;
    }
    const socket = createConnection(this.socketPath);
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      this.connected = true;
      this.log.info?.(`[herdr] connected to ${this.socketPath}`);
      this.send("session.snapshot", {});
      this.send("events.subscribe", {
        subscriptions: [
          { type: "pane.agent_status_changed" },
          { type: "pane.agent_detected" },
          { type: "pane.closed" },
          { type: "pane.exited" },
        ],
      });
      clearInterval(this.pollTimer);
      this.pollTimer = setInterval(() => this.send("session.snapshot", {}), 15_000);
    });
    socket.on("data", (chunk) => this.onData(chunk));
    socket.on("error", (error) => {
      if (this.connected) this.log.warn?.(`[herdr] socket error: ${error.message}`);
    });
    socket.on("close", () => {
      if (this.connected) this.log.info?.("[herdr] disconnected");
      this.connected = false;
      clearInterval(this.pollTimer);
      this.store.removeAdapterSessions("herdr");
      this.known.clear();
      this.scheduleReconnect(3000);
    });
  }

  scheduleReconnect(ms) {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), ms);
    if (typeof this.reconnectTimer.unref === "function") this.reconnectTimer.unref();
  }

  send(method, params) {
    if (!this.socket || this.socket.destroyed) return;
    this.requestId += 1;
    this.socket.write(`${JSON.stringify({ id: `deck_${this.requestId}`, method, params })}\n`);
  }

  onData(chunk) {
    this.buffer += chunk;
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) this.onLine(line);
      index = this.buffer.indexOf("\n");
    }
  }

  onLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.error) {
      this.log.warn?.(`[herdr] ${message.error.code ?? "error"}: ${message.error.message ?? ""}`);
      return;
    }
    const result = message.result ?? message.event ?? message;
    const type = result?.type ?? message.type ?? "";
    if (type === "session.snapshot" || type === "snapshot" || result?.panes || result?.agents) {
      this.applySnapshot(result);
      return;
    }
    if (typeof type === "string" && type.startsWith("pane.")) {
      this.applyEvent(type, result);
      return;
    }
    if (type === "events_lost") this.send("session.snapshot", {});
  }

  /** Walk any snapshot shape for pane-like records: objects with a pane id and an agent status. */
  applySnapshot(result) {
    const panes = new Map();
    const agents = new Map();
    const visit = (node, depth) => {
      if (!node || typeof node !== "object" || depth > 6) return;
      if (Array.isArray(node)) {
        for (const item of node) visit(item, depth + 1);
        return;
      }
      const paneId = node.pane_id ?? node.paneId;
      if (typeof paneId === "string") {
        if ("agent_status" in node || "agentStatus" in node)
          panes.set(paneId, { ...(panes.get(paneId) ?? {}), ...node });
        if (node.agent || node.agent_kind || node.kind || node.agent_name)
          agents.set(paneId, { ...(agents.get(paneId) ?? {}), ...node });
      }
      for (const value of Object.values(node)) visit(value, depth + 1);
    };
    visit(result, 0);

    const seen = new Set();
    for (const [paneId, pane] of panes) {
      const status = pane.agent_status ?? pane.agentStatus;
      if (!status || status === "none") continue;
      const info = agents.get(paneId) ?? {};
      const agentNode = pane.agent ?? info.agent ?? {};
      const label =
        (typeof agentNode === "string" ? agentNode : (agentNode.kind ?? agentNode.id ?? agentNode.name)) ??
        pane.agent_kind ??
        info.agent_kind ??
        info.kind ??
        pane.agent_name ??
        info.agent_name ??
        "";
      const agentId = resolveAgentId(label);
      if (this.isHidden(agentId)) continue;
      const name = pane.title ?? pane.name ?? info.name ?? (typeof agentNode === "object" ? agentNode.name : "") ?? "";
      seen.add(paneId);
      this.known.add(paneId);
      this.store.upsert(
        "herdr",
        paneId,
        {
          title: clip(name || `${label || "agent"} ${paneId}`, 120),
          activity: STATUS_MAP[status] ?? "idle",
          statusDetail: status === "blocked" ? "Waiting in terminal" : status === "unknown" ? "unknown" : null,
          cwd: pane.cwd ?? info.cwd ?? null,
          model: pane.model ?? info.model ?? null,
        },
        { agent: agentId, source: "herdr", paneId, target: paneId },
      );
    }
    for (const paneId of [...this.known]) {
      if (!seen.has(paneId)) {
        this.known.delete(paneId);
        const session = this.store.find("herdr", paneId);
        if (session) this.store.remove(session.uid);
      }
    }
  }

  applyEvent(type, event) {
    const paneId = event.pane_id ?? event.paneId ?? event.pane?.pane_id;
    if (typeof paneId !== "string") {
      this.send("session.snapshot", {});
      return;
    }
    if (type === "pane.closed" || type === "pane.exited") {
      this.known.delete(paneId);
      const session = this.store.find("herdr", paneId);
      if (session) this.store.remove(session.uid);
      return;
    }
    const status = event.agent_status ?? event.agentStatus ?? event.pane?.agent_status;
    if (!status) {
      this.send("session.snapshot", {});
      return;
    }
    const existing = this.store.find("herdr", paneId);
    if (!existing) {
      this.send("session.snapshot", {});
      return;
    }
    this.store.upsert(
      "herdr",
      paneId,
      {
        activity: STATUS_MAP[status] ?? "idle",
        statusDetail: status === "blocked" ? "Waiting in terminal" : null,
      },
      { source: "herdr", paneId, target: paneId },
    );
  }

  isHidden(agentId) {
    const mode = this.config.herdr?.hideAgents ?? "auto";
    if (Array.isArray(mode)) return mode.includes(agentId);
    if (mode === "none") return false;
    return (this.config.installed ?? []).includes(agentId);
  }

  cli(args) {
    return new Promise((resolve) => {
      execFile("herdr", args, { timeout: 8000, windowsHide: true }, (error, stdout, stderr) => {
        if (error) {
          const reason = error.code === "ENOENT" ? "herdr_cli_missing" : clip(stderr || error.message, 120);
          resolve({ ok: false, reason });
          return;
        }
        resolve({ ok: true, stdout });
      });
    });
  }

  sendKeys(target, keys) {
    if (!target) return Promise.resolve({ ok: false, reason: "no_target" });
    return this.cli(["agent", "send-keys", target, ...keys]);
  }

  focus(target) {
    if (!target) return Promise.resolve({ ok: false, reason: "no_target" });
    return this.cli(["agent", "focus", target]);
  }
}
