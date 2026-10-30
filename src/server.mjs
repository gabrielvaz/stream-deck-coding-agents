import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ACTIVITIES } from "./agents.mjs";
import { ADAPTER_API_FILE, SOCKET_PATH } from "./config.mjs";
import { eventNameOf, MAPPERS } from "./mappers/index.mjs";
import { isLoopback, randomToken, readJsonBody, sendJson } from "./util.mjs";

const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "web");
const VERSION = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
).version;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};

const ADAPTER_LIMITS = { bodyBytes: 65536, adapters: 8, sessionsPerAdapter: 32, requestsPerSecond: 20 };

export function createDeckServer(config, store, options = {}) {
  const herdr = options.herdr ?? null;
  const log = options.log ?? console;
  const sseClients = new Set();

  store.on("change", (snapshot) => {
    const data = `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`;
    for (const res of sseClients) res.write(data);
  });

  function tokenOk(req, url) {
    if (!config.requireToken) return true;
    const header = req.headers.authorization;
    const candidates = [url.searchParams.get("k"), req.headers["x-agent-deck-token"]];
    if (typeof header === "string" && header.toLowerCase().startsWith("bearer "))
      candidates.push(header.slice(7).trim());
    return candidates.some((candidate) => typeof candidate === "string" && safeEqual(candidate, config.token));
  }

  function hookAllowed(req, url) {
    return isLoopback(req.socket.remoteAddress) || tokenOk(req, url);
  }

  async function handle(req, res) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    try {
      if (path.startsWith("/a/v1/")) {
        await handleAdapterApi(req, res, url);
        return;
      }
      if (req.method === "GET" && (path === "/" || path === "/index.html")) return serveStatic(res, "index.html");
      if (req.method === "GET" && path === "/healthz")
        return sendJson(res, 200, { ok: true, version: VERSION, sessions: store.sessions.size });
      if (req.method === "GET" && !path.startsWith("/api/")) return serveStatic(res, path.slice(1));

      if (path.startsWith("/api/v1/hook/")) {
        if (req.method !== "POST") return sendJson(res, 405, { error: "method_not_allowed" });
        if (!hookAllowed(req, url)) return sendJson(res, 401, { error: "unauthorized" });
        return await handleHook(req, res, url, path.slice("/api/v1/hook/".length));
      }

      if (!tokenOk(req, url))
        return sendJson(res, 401, { error: "unauthorized", hint: "append ?k=<token> (see `agent-deck token`)" });

      if (req.method === "GET" && path === "/api/v1/state") return sendJson(res, 200, store.snapshot());
      if (req.method === "GET" && path === "/api/v1/events") return handleSse(req, res);
      const actionMatch = path.match(/^\/api\/v1\/sessions\/([^/]+)\/actions$/);
      if (actionMatch && req.method === "POST") {
        const body = await readJsonBody(req);
        const uid = decodeURIComponent(actionMatch[1]);
        const result = await store.handleAction(uid, body.action, body, herdr);
        return sendJson(res, result.ok ? 200 : 409, result);
      }
      const sessionMatch = path.match(/^\/api\/v1\/sessions\/([^/]+)$/);
      if (sessionMatch && req.method === "DELETE") {
        return sendJson(res, store.remove(decodeURIComponent(sessionMatch[1])) ? 200 : 404, { ok: true });
      }
      if (req.method === "POST" && path === "/api/v1/sessions") {
        // Plain custom API: {"agent":"custom","id":"job-1","title":"…","activity":"tool"}
        const body = await readJsonBody(req);
        if (!body.id) return sendJson(res, 422, { error: "invalid_field", field: "id" });
        const adapterId = typeof body.agent === "string" && body.agent ? body.agent : "custom";
        if (body.activity && !ACTIVITIES.includes(body.activity))
          return sendJson(res, 422, { error: "invalid_field", field: "activity" });
        const session = store.upsert(adapterId, String(body.id), sessionPatch(body), {
          source: "api",
          host: body.host,
        });
        return sendJson(res, 200, { session: { uid: session.uid } });
      }
      return sendJson(res, 404, { error: "not_found" });
    } catch (error) {
      if (error.message === "bad_json") return sendJson(res, 400, { error: "bad_request", message: "invalid JSON" });
      if (error.message === "payload_too_large") return sendJson(res, 413, { error: "payload_too_large" });
      log.error?.(`[agent-deck] ${req.method} ${path}: ${error.stack ?? error.message}`);
      if (!res.headersSent) sendJson(res, 500, { error: "internal" });
    }
  }

  function serveStatic(res, name) {
    const safe = name.replace(/\.\./g, "").replace(/^\/+/, "") || "index.html";
    const file = join(WEB_DIR, safe);
    if (!file.startsWith(WEB_DIR) || !existsSync(file)) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    const body = readFileSync(file);
    res.writeHead(200, {
      "Content-Type": MIME[extname(file)] ?? "application/octet-stream",
      "Content-Length": body.length,
      "Cache-Control": "no-cache",
    });
    res.end(body);
  }

  function handleSse(req, res) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(`event: snapshot\ndata: ${JSON.stringify(store.snapshot())}\n\n`);
    sseClients.add(res);
    store.viewerCount = sseClients.size;
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);
    req.on("close", () => {
      clearInterval(heartbeat);
      sseClients.delete(res);
      store.viewerCount = sseClients.size;
      store.scheduleEmit();
    });
    store.scheduleEmit();
  }

  async function handleHook(req, res, url, agentSegment) {
    const agent = agentSegment.split("/")[0];
    const mapper = MAPPERS[agent];
    if (!mapper) return sendJson(res, 404, { error: "unknown_agent", agents: Object.keys(MAPPERS) });
    const payload = await readJsonBody(req, 1024 * 1024);
    const event = eventNameOf(payload, url.searchParams.get("event"));
    const mapped = mapper(event, payload);
    if (!mapped) return sendJson(res, 200, {});
    const host = url.searchParams.get("host") ?? "local";
    if (mapped.remove) {
      const session = store.find(agent, mapped.sessionId, host);
      if (session) store.remove(session.uid);
      return sendJson(res, 200, mapped.reply ? mapped.reply(null) : {});
    }
    const session = store.upsert(agent, mapped.sessionId, mapped.patch, { agent, host, source: "hook" });
    if (mapped.restore) store.restoreAfterCompact(session);
    if (mapped.hold === "approval") {
      const holdMs = Math.max(0, Number(config.approvalHoldSeconds) || 0) * 1000;
      const decision = await store.waitForDecision(session.uid, "approval", holdMs);
      if (decision?.behavior === "allow")
        store.upsert(agent, mapped.sessionId, { activity: "tool", approval: null }, { host });
      else if (decision?.behavior === "deny")
        store.upsert(
          agent,
          mapped.sessionId,
          { activity: "thinking", approval: null, statusDetail: "denied from deck" },
          { host },
        );
      return sendJson(res, 200, mapped.reply(decision));
    }
    return sendJson(res, 200, mapped.reply ? mapped.reply(null) : {});
  }

  // ---------------------------------------------------------------------------------------------
  // Orbtile Adapter Protocol v1.1 compatible surface (https://github.com/Orbtile/orbtile-adapters)
  // ---------------------------------------------------------------------------------------------
  async function handleAdapterApi(req, res, url) {
    const error = (status, code, message, field) =>
      sendJson(res, status, { error: { code, message, ...(field ? { field } : {}) } });
    if (req.headers.origin) return error(403, "forbidden_origin", "browser origins are not allowed");
    const auth = req.headers.authorization ?? "";
    if (!auth.toLowerCase().startsWith("bearer ") || !safeEqual(auth.slice(7).trim(), config.token)) {
      return error(401, "unauthorized", "bad token");
    }
    const path = url.pathname.slice("/a/v1".length);

    if (req.method === "GET" && path === "/info") {
      const info = {
        api: 1,
        apiMinor: 1,
        version: VERSION,
        product: "agent-deck",
        activities: ACTIVITIES,
        limits: ADAPTER_LIMITS,
      };
      const nonce = req.headers["x-orbtile-nonce"];
      if (typeof nonce === "string" && /^[0-9a-f]{16,64}$/i.test(nonce)) {
        info.proof = createHmac("sha256", config.token).update(nonce).digest("hex");
      }
      return sendJson(res, 200, info);
    }

    const adapterMatch = path.match(/^\/adapters\/([a-z0-9.-]+)(\/.*)?$/);
    if (!adapterMatch) return error(404, "not_found", "no such route");
    const adapterId = adapterMatch[1];
    const rest = adapterMatch[2] ?? "";
    if (adapterId.startsWith("com.orbtile.")) return error(409, "reserved_id", "com.orbtile.* is reserved");

    let body = {};
    if (req.method !== "GET" && req.method !== "DELETE") {
      try {
        body = await readJsonBody(req, ADAPTER_LIMITS.bodyBytes);
      } catch (cause) {
        if (cause.message === "payload_too_large") return error(413, "payload_too_large", "body over 64 KB");
        return error(400, "bad_request", "invalid JSON");
      }
    }

    if (rest === "" && req.method === "PUT") {
      if (!body.palette || typeof body.palette !== "object")
        return error(422, "invalid_field", "palette is required", "palette");
      if (!store.adapters.has(adapterId) && store.adapters.size >= ADAPTER_LIMITS.adapters)
        return error(422, "limit_exceeded", "too many adapters");
      const { created, record } = store.registerAdapter(adapterId, body);
      if (!record.adapterToken) record.adapterToken = randomToken(16);
      return sendJson(res, created ? 201 : 200, {
        adapter: { id: adapterId, palette: record.palette, resolvedBaseHue: Number(record.palette?.baseHue) || 0 },
        enabled: true,
        adapterToken: record.adapterToken,
      });
    }
    if (rest === "" && req.method === "DELETE") {
      store.dropAdapter(adapterId);
      res.writeHead(204);
      return res.end();
    }
    if (!store.adapters.has(adapterId)) return error(404, "adapter_not_registered", "register the adapter first");
    store.touchAdapter(adapterId);

    if (rest === "/heartbeat" && req.method === "POST") {
      res.writeHead(204);
      return res.end();
    }
    if (rest === "/sessions" && req.method === "PUT") {
      const list = Array.isArray(body.sessions) ? body.sessions : [];
      if (list.length > ADAPTER_LIMITS.sessionsPerAdapter) return error(422, "limit_exceeded", "too many sessions");
      const keep = new Set();
      for (const item of list) {
        const sid = String(item.id ?? item.sessionId ?? "");
        if (!sid) continue;
        if (item.activity && !ACTIVITIES.includes(item.activity))
          return error(422, "invalid_field", `activity: unknown value '${item.activity}'`, "activity");
        const session = store.upsert(adapterId, sid, sessionPatch(item), {
          source: "adapter",
          host: item.host,
          agent: adapterId,
        });
        keep.add(session.uid);
      }
      for (const session of [...store.sessions.values()]) {
        if (session.adapterId === adapterId && !keep.has(session.uid)) store.remove(session.uid);
      }
      return sendJson(res, 200, { count: keep.size });
    }
    const sessionMatch = rest.match(/^\/sessions\/([^/]+)$/);
    if (sessionMatch) {
      const sid = decodeURIComponent(sessionMatch[1]);
      const host = url.searchParams.get("host") ?? body.host ?? "local";
      if (req.method === "DELETE") {
        const session = store.find(adapterId, sid, host);
        if (session) store.remove(session.uid);
        res.writeHead(204);
        return res.end();
      }
      if (req.method === "POST") {
        const existing = store.find(adapterId, sid, host);
        if (!existing && (!body.title || !body.activity))
          return error(422, "invalid_field", "a new session needs title and activity", "title");
        if (body.activity && !ACTIVITIES.includes(body.activity))
          return error(422, "invalid_field", `activity: unknown value '${body.activity}'`, "activity");
        const perAdapter = [...store.sessions.values()].filter((s) => s.adapterId === adapterId).length;
        if (!existing && perAdapter >= ADAPTER_LIMITS.sessionsPerAdapter)
          return error(422, "limit_exceeded", "too many sessions");
        const session = store.upsert(adapterId, sid, sessionPatch(body), { source: "adapter", host, agent: adapterId });
        return sendJson(res, 200, { session: { uid: session.uid, visible: true } });
      }
    }
    if (rest === "/events" && req.method === "POST") {
      const adapter = store.adapters.get(adapterId);
      const after = Number(body.after) || 0;
      const ack = Number(body.ack) || 0;
      const waitSeconds = Math.min(25, Math.max(0, Number(body.waitSeconds) || 0));
      adapter.events = adapter.events.filter((event) => event.sequence > ack);
      let events = adapter.events.filter((event) => event.sequence > after);
      if (events.length === 0 && waitSeconds > 0) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, waitSeconds * 1000);
          adapter.waiters.push(() => {
            clearTimeout(timer);
            resolve();
          });
        });
        events = adapter.events.filter((event) => event.sequence > after);
      }
      return sendJson(res, 200, { events, lastSequence: adapter.sequence, acknowledged: ack });
    }
    return error(404, "not_found", "no such route");
  }

  const server = createHttpServer((req, res) => {
    handle(req, res).catch((error) => {
      log.error?.(`[agent-deck] unhandled: ${error.stack ?? error.message}`);
      if (!res.headersSent) sendJson(res, 500, { error: "internal" });
    });
  });
  server.keepAliveTimeout = 65_000;

  let socketServer = null;
  if (process.platform !== "win32" && options.unixSocket !== false) {
    socketServer = createHttpServer((req, res) => {
      handle(req, res).catch(() => {
        if (!res.headersSent) sendJson(res, 500, { error: "internal" });
      });
    });
  }

  function listen() {
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, config.host, () => {
        server.off("error", reject);
        const discovery = {
          api: 1,
          url: `http://127.0.0.1:${config.port}`,
          basePath: "/a/v1",
          token: config.token,
          pid: process.pid,
        };
        if (socketServer) {
          try {
            mkdirSync(dirname(SOCKET_PATH), { recursive: true });
            if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH);
            socketServer.listen(SOCKET_PATH);
            discovery.socketPath = SOCKET_PATH;
          } catch (error) {
            log.warn?.(`[agent-deck] unix socket unavailable: ${error.message}`);
          }
        }
        try {
          mkdirSync(dirname(ADAPTER_API_FILE), { recursive: true });
          writeFileSync(ADAPTER_API_FILE, `${JSON.stringify(discovery, null, 2)}\n`, { mode: 0o600 });
        } catch (error) {
          log.warn?.(`[agent-deck] could not write ${ADAPTER_API_FILE}: ${error.message}`);
        }
        resolve(server.address());
      });
    });
  }

  function close() {
    for (const res of sseClients) res.end();
    sseClients.clear();
    server.close();
    socketServer?.close();
    if (existsSync(ADAPTER_API_FILE)) {
      try {
        unlinkSync(ADAPTER_API_FILE);
      } catch {
        // ignore
      }
    }
  }

  return { server, listen, close, viewers: () => sseClients.size };
}

/** Whitelists the Orbtile session-update fields for the store. */
function sessionPatch(body) {
  const patch = {};
  const copy = [
    "title",
    "activity",
    "toolLabel",
    "toolKind",
    "cwd",
    "model",
    "message",
    "statusDetail",
    "subagentCount",
    "host",
    "openURL",
    "pid",
    "background",
    "liveText",
    "ttlSeconds",
    "approval",
    "question",
    "project",
  ];
  for (const key of copy) {
    if (key in body) patch[key] = body[key];
  }
  if (typeof body.project === "string" && !("title" in body)) patch.titleIfEmpty = body.project;
  return patch;
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
