import { EventEmitter } from "node:events";
import { ACTIVITIES, paletteFor, resolveAgentId, WAITING, WORKING } from "./agents.mjs";
import { clip, hslToHex, lastLine, now, truncate } from "./util.mjs";

const RECENT_FINISH_MS = 15_000;
const APPROVAL_TTL_MS = 120_000;
const QUESTION_TTL_MS = 600_000;
const MESSAGE_KEEP_BYTES = 4096;

const TIER = { waiting: 0, working: 1, recent: 2, done: 3, idle: 4, offline: 5 };

function tierOf(session, at) {
  if (WAITING.has(session.activity)) return TIER.waiting;
  if (WORKING.has(session.activity)) return TIER.working;
  if (session.activity === "error") return TIER.working;
  if (session.activity === "done") return at - session.activitySince < RECENT_FINISH_MS ? TIER.recent : TIER.done;
  if (session.activity === "offline") return TIER.offline;
  return TIER.idle;
}

export class DeckStore extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.sessions = new Map();
    this.pending = new Map();
    this.adapters = new Map();
    this.viewerCount = 0;
    this.emitTimer = null;
    this.sweepTimer = setInterval(() => this.sweep(), 1000);
    if (typeof this.sweepTimer.unref === "function") this.sweepTimer.unref();
  }

  close() {
    clearInterval(this.sweepTimer);
    for (const pending of this.pending.values()) pending.resolve(null);
    this.pending.clear();
  }

  static uidFor(adapterId, host, sessionId) {
    return `${adapterId}:${host || "local"}:${sessionId}`.replace(/[^\w.:@/-]+/g, "_");
  }

  get(uid) {
    return this.sessions.get(uid) ?? null;
  }

  find(adapterId, sessionId, host = "local") {
    return this.get(DeckStore.uidFor(adapterId, host, sessionId));
  }

  /**
   * Merge an update into a session (Orbtile semantics: absent keeps, null clears).
   * Returns the session, or null when the patch would create a session without title/activity.
   */
  upsert(adapterId, sessionId, patch, options = {}) {
    const host = patch.host ?? options.host ?? "local";
    const uid = DeckStore.uidFor(adapterId, host, sessionId);
    const at = now();
    let session = this.sessions.get(uid);
    const isNew = !session;
    if (isNew) {
      session = {
        uid,
        adapterId,
        sessionId,
        host,
        agent: options.agent ?? resolveAgentId(adapterId),
        source: options.source ?? "hook",
        title: "",
        project: "",
        cwd: "",
        model: "",
        activity: "starting",
        activitySince: at,
        prevActivity: null,
        createdAt: at,
        lastUpdate: at,
        toolLabel: "",
        toolKind: "",
        statusDetail: "",
        message: null,
        approval: null,
        question: null,
        subagentCount: 0,
        seen: true,
        pid: null,
        openURL: "",
        paneId: options.paneId ?? null,
        target: options.target ?? null,
        ttlSeconds: options.ttlSeconds ?? null,
      };
      this.sessions.set(uid, session);
    }
    if (options.agent) session.agent = options.agent;
    if (options.paneId !== undefined) session.paneId = options.paneId;
    if (options.target !== undefined) session.target = options.target;
    session.lastUpdate = at;

    for (const key of Object.keys(patch)) {
      const value = patch[key];
      switch (key) {
        case "activity":
          this.setActivity(session, value, at);
          break;
        case "message":
          this.setMessage(session, value);
          break;
        case "appendText":
          this.appendText(session, value);
          break;
        case "title":
          if (value === null) session.title = "";
          else if (typeof value === "string" && value.trim()) session.title = clip(value, 120);
          break;
        case "titleIfEmpty":
          if (!session.title && typeof value === "string" && value.trim()) session.title = clip(value, 120);
          break;
        case "toolLabel":
          session.toolLabel = value === null ? "" : truncate(String(value ?? ""), 80);
          break;
        case "statusDetail":
          session.statusDetail = value === null ? "" : clip(String(value ?? ""), 120);
          break;
        case "model":
          session.model = value === null ? "" : clip(String(value ?? ""), 64);
          break;
        case "cwd":
          session.cwd = value === null ? "" : String(value).slice(0, 1024);
          break;
        case "project":
          session.project = value === null ? "" : clip(String(value ?? ""), 128);
          break;
        case "subagentCount":
          session.subagentCount = Math.max(0, Number(value) || 0);
          break;
        case "subagentDelta":
          session.subagentCount = Math.max(0, session.subagentCount + (Number(value) || 0));
          break;
        case "approval":
          session.approval = value ? { ...value, publishedAt: at } : null;
          break;
        case "question":
          session.question = value ? { ...value, publishedAt: at } : null;
          break;
        case "ttlSeconds":
          session.ttlSeconds = value === null ? null : Math.min(3600, Math.max(10, Number(value) || 120));
          break;
        case "host":
          break;
        default:
          if (["toolKind", "pid", "openURL", "seen", "background", "liveText"].includes(key)) {
            session[key] = value;
          }
      }
    }
    if (!session.title) session.title = session.project || session.sessionId;
    this.scheduleEmit();
    return session;
  }

  setActivity(session, activity, at = now()) {
    if (!ACTIVITIES.includes(activity)) return;
    if (session.activity === activity) {
      return;
    }
    if (activity === "compacting" && session.activity !== "compacting") session.prevActivity = session.activity;
    const leftWaiting = WAITING.has(session.activity) && !WAITING.has(activity);
    session.activity = activity;
    session.activitySince = at;
    if (activity === "done") session.seen = false;
    if (activity === "waitingPermission" || activity === "waitingQuestion") session.seen = false;
    if (leftWaiting) {
      if (activity !== "waitingPermission") session.approval = null;
      if (activity !== "waitingQuestion") session.question = null;
      this.resolvePending(session.uid, null, "superseded");
    }
    if (activity === "thinking" || activity === "starting") {
      session.toolLabel = "";
    }
    if (activity !== "error" && activity !== "waitingPermission" && activity !== "idle") {
      session.statusDetail = activity === "done" ? session.statusDetail : "";
    }
  }

  restoreAfterCompact(session) {
    const next = session.prevActivity && session.prevActivity !== "compacting" ? session.prevActivity : "thinking";
    session.prevActivity = null;
    this.setActivity(session, next);
  }

  setMessage(session, value) {
    if (value === null) {
      session.message = null;
      return;
    }
    if (!value || typeof value !== "object") return;
    const id = clip(String(value.id ?? `m-${now()}`), 128);
    const text = typeof value.text === "string" ? value.text : "";
    session.message = { id, text: text.slice(-MESSAGE_KEEP_BYTES) };
  }

  appendText(session, value) {
    if (!value || typeof value !== "object") return;
    const id = clip(String(value.id ?? "live"), 128);
    const delta = typeof value.delta === "string" ? value.delta : "";
    if (!session.message || session.message.id !== id) session.message = { id, text: "" };
    session.message.text = (session.message.text + delta).slice(-MESSAGE_KEEP_BYTES);
  }

  remove(uid) {
    const session = this.sessions.get(uid);
    if (!session) return false;
    this.resolvePending(uid, null, "removed");
    this.sessions.delete(uid);
    this.scheduleEmit();
    return true;
  }

  removeAdapterSessions(adapterId) {
    for (const session of [...this.sessions.values()]) {
      if (session.adapterId === adapterId) this.remove(session.uid);
    }
  }

  /** Hook endpoints park a PermissionRequest here until the deck answers or the hold expires. */
  waitForDecision(uid, kind, holdMs) {
    if (holdMs <= 0 || this.viewerCount === 0) return Promise.resolve(null);
    this.resolvePending(uid, null, "replaced");
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(uid);
        resolve(null);
        this.scheduleEmit();
      }, holdMs);
      this.pending.set(uid, {
        kind,
        createdAt: now(),
        resolve: (decision) => {
          clearTimeout(timer);
          this.pending.delete(uid);
          resolve(decision);
          this.scheduleEmit();
        },
      });
      this.scheduleEmit();
    });
  }

  resolvePending(uid, decision) {
    const pending = this.pending.get(uid);
    if (!pending) return false;
    pending.resolve(decision);
    return true;
  }

  canAnswer(session) {
    if (this.pending.has(session.uid)) return "hook";
    if (session.source === "herdr" && session.target) return "herdr";
    const adapter = this.adapters.get(session.adapterId);
    if (adapter?.capabilities?.includes("approvals") || adapter?.capabilities?.includes("questions")) return "adapter";
    return null;
  }

  /** Orbtile-style adapter registry (used by the /a/v1 API). */
  registerAdapter(id, registration) {
    const existing = this.adapters.get(id);
    const record = {
      id,
      name: clip(registration.name ?? id, 40),
      shortName: clip(registration.shortName ?? registration.name ?? id, 12),
      palette: registration.palette ?? null,
      glyph: registration.glyph ?? null,
      capabilities: Array.isArray(registration.capabilities) ? registration.capabilities : [],
      tapBehavior: registration.tapBehavior ?? "alsoOpen",
      urlSchemes: Array.isArray(registration.urlSchemes) ? registration.urlSchemes : [],
      lastSeen: now(),
      events: existing?.events ?? [],
      sequence: existing?.sequence ?? 0,
      waiters: existing?.waiters ?? [],
      adapterToken: existing?.adapterToken ?? null,
    };
    this.adapters.set(id, record);
    this.scheduleEmit();
    return { created: !existing, record };
  }

  touchAdapter(id) {
    const adapter = this.adapters.get(id);
    if (!adapter) return false;
    adapter.lastSeen = now();
    return true;
  }

  dropAdapter(id) {
    const adapter = this.adapters.get(id);
    if (!adapter) return;
    for (const waiter of adapter.waiters) waiter();
    this.adapters.delete(id);
    this.removeAdapterSessions(id);
  }

  queueAdapterEvent(adapterId, event) {
    const adapter = this.adapters.get(adapterId);
    if (!adapter) return false;
    adapter.sequence += 1;
    adapter.events.push({ sequence: adapter.sequence, ...event });
    if (adapter.events.length > 256) adapter.events.splice(0, adapter.events.length - 256);
    const waiters = adapter.waiters.splice(0);
    for (const wake of waiters) wake();
    return true;
  }

  /**
   * Deck actions: allow | deny | dismiss | read | answer | focus | remove.
   * Returns { ok, via, reason }.
   */
  async handleAction(uid, action, payload = {}, herdr = null) {
    const session = this.sessions.get(uid);
    if (!session) return { ok: false, reason: "not_found" };
    switch (action) {
      case "read":
        session.seen = true;
        this.scheduleEmit();
        return { ok: true, via: "deck" };
      case "remove":
        this.remove(uid);
        return { ok: true, via: "deck" };
      case "dismiss":
        if (this.resolvePending(uid, { behavior: "dismiss" })) return { ok: true, via: "hook" };
        return { ok: true, via: "deck" };
      case "allow":
      case "deny": {
        if (this.resolvePending(uid, { behavior: action })) {
          session.seen = true;
          return { ok: true, via: "hook" };
        }
        if (session.source === "herdr" && herdr) {
          const keys = this.config.herdr?.keys?.[action] ?? (action === "allow" ? ["enter"] : ["esc"]);
          const result = await herdr.sendKeys(session.target, keys);
          return result.ok ? { ok: true, via: "herdr" } : { ok: false, reason: result.reason };
        }
        if (session.approval && this.adapters.has(session.adapterId)) {
          this.queueAdapterEvent(session.adapterId, {
            type: "approval",
            sessionId: session.sessionId,
            host: session.host,
            requestId: session.approval.id,
            decision: action,
            expiresAt: Math.floor((now() + APPROVAL_TTL_MS) / 1000),
          });
          return { ok: true, via: "adapter" };
        }
        return { ok: false, reason: "no_channel" };
      }
      case "answer": {
        const picks = Array.isArray(payload.picks) ? payload.picks : [];
        if (session.source === "herdr" && herdr) {
          const keys = [];
          for (const index of picks.flat()) keys.push(String(Number(index) + 1));
          keys.push("enter");
          const result = await herdr.sendKeys(session.target, keys);
          return result.ok ? { ok: true, via: "herdr" } : { ok: false, reason: result.reason };
        }
        if (session.question && this.adapters.has(session.adapterId)) {
          this.queueAdapterEvent(session.adapterId, {
            type: "question",
            sessionId: session.sessionId,
            host: session.host,
            requestId: session.question.id,
            picks,
            expiresAt: Math.floor((now() + QUESTION_TTL_MS) / 1000),
          });
          return { ok: true, via: "adapter" };
        }
        return { ok: false, reason: "no_channel" };
      }
      case "focus": {
        session.seen = true;
        if (session.source === "herdr" && herdr) {
          const result = await herdr.focus(session.target);
          return result.ok ? { ok: true, via: "herdr" } : { ok: false, reason: result.reason };
        }
        if (this.adapters.has(session.adapterId)) {
          this.queueAdapterEvent(session.adapterId, { type: "tap", sessionId: session.sessionId, host: session.host });
          return { ok: true, via: "adapter" };
        }
        this.scheduleEmit();
        return { ok: false, reason: "no_channel" };
      }
      default:
        return { ok: false, reason: "unknown_action" };
    }
  }

  sweep() {
    const at = now();
    let changed = false;
    const doneToIdleMs = (this.config.doneToIdleSeconds ?? 90) * 1000;
    const idleKeepMs = (this.config.idleKeepMinutes ?? 120) * 60_000;
    const offlineKeepMs = (this.config.offlineKeepSeconds ?? 600) * 1000;

    for (const [id, adapter] of this.adapters) {
      const silent = at - adapter.lastSeen;
      if (silent > 60_000) {
        this.dropAdapter(id);
        changed = true;
      } else if (silent > 15_000) {
        for (const session of this.sessions.values()) {
          if (session.adapterId === id && session.activity !== "offline") {
            session.prevActivity = session.activity;
            this.setActivity(session, "offline", at);
            changed = true;
          }
        }
      }
    }

    for (const session of [...this.sessions.values()]) {
      if (session.ttlSeconds && session.activity !== "offline" && at - session.lastUpdate > session.ttlSeconds * 1000) {
        this.setActivity(session, "offline", at);
        changed = true;
      }
      if (session.activity === "offline" && at - session.activitySince > offlineKeepMs) {
        this.remove(session.uid);
        changed = true;
        continue;
      }
      if (session.activity === "done" && doneToIdleMs > 0 && at - session.activitySince > doneToIdleMs) {
        this.setActivity(session, "idle", at);
        changed = true;
      }
      if (session.activity === "idle" && idleKeepMs > 0 && at - session.lastUpdate > idleKeepMs) {
        this.remove(session.uid);
        changed = true;
        continue;
      }
      if (session.approval && at - session.approval.publishedAt > APPROVAL_TTL_MS) {
        session.approval = null;
        changed = true;
      }
      if (session.question && at - session.question.publishedAt > QUESTION_TTL_MS) {
        session.question = null;
        changed = true;
      }
    }
    if (changed) this.scheduleEmit();
    // timers on the deck tick client-side, but tiers change with time (recent finish → done), so emit anyway every 5 s
    if (at % 5000 < 1000) this.scheduleEmit();
  }

  scheduleEmit() {
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      this.emit("change", this.snapshot());
    }, 40);
  }

  publicSession(session, at) {
    return {
      uid: session.uid,
      agent: session.agent,
      adapterId: session.adapterId,
      sessionId: session.sessionId,
      host: session.host,
      remote: session.host !== "local",
      source: session.source,
      title: session.title,
      project: session.project,
      model: session.model,
      activity: session.activity,
      activitySince: session.activitySince,
      lastUpdate: session.lastUpdate,
      toolLabel: session.toolLabel,
      toolKind: session.toolKind,
      statusDetail: session.statusDetail,
      message: session.message ? { id: session.message.id, text: session.message.text.slice(-1200) } : null,
      lastLine: session.message ? lastLine(session.message.text) : "",
      approval: session.approval,
      question: session.question,
      subagentCount: session.subagentCount,
      seen: session.seen,
      canAnswer: this.canAnswer(session),
      tier: tierOf(session, at),
    };
  }

  sorted(at = now()) {
    const list = [...this.sessions.values()].map((s) => this.publicSession(s, at));
    list.sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      if (a.tier === TIER.waiting) return a.activitySince - b.activitySince;
      return b.activitySince - a.activitySince;
    });
    return list;
  }

  summary(list) {
    const perAgent = {};
    let working = 0;
    let waiting = 0;
    let done = 0;
    let errors = 0;
    let leading = null;
    for (const session of list) {
      if (session.activity === "offline") continue;
      perAgent[session.agent] = (perAgent[session.agent] ?? 0) + 1;
      if (WORKING.has(session.activity)) working += 1;
      if (WAITING.has(session.activity)) {
        waiting += 1;
        if (!leading) leading = session.title;
      }
      if (session.activity === "done") done += 1;
      if (session.activity === "error") errors += 1;
    }
    return { working, waiting, done, errors, leading, perAgent, total: list.length };
  }

  snapshot() {
    const at = now();
    const sessions = this.sorted(at);
    const palette = paletteFor(this.config);
    for (const adapter of this.adapters.values()) {
      const baseHue = Number(adapter.palette?.baseHue);
      const attentionHue = Number(adapter.palette?.attentionHue);
      palette[adapter.id] = {
        id: adapter.id,
        name: adapter.name,
        short: adapter.shortName,
        mono: adapter.glyph?.monogram ?? adapter.shortName.slice(0, 2),
        color: Number.isFinite(baseHue) ? hslToHex(baseHue) : palette.custom.color,
        alarm: Number.isFinite(attentionHue) ? hslToHex(attentionHue) : palette.custom.alarm,
      };
    }
    return {
      now: at,
      sessions,
      summary: this.summary(sessions),
      palette,
      viewers: this.viewerCount,
      pending: [...this.pending.keys()],
      settings: {
        approvalHoldSeconds: this.config.approvalHoldSeconds,
      },
    };
  }
}
