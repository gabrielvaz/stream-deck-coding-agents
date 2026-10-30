/* Agent Deck — browser client (vanilla JS, no build step). */
(() => {
  const SLOTS = 8;
  const HOLD_MS = 600;
  const RESORT_MS = 8000;
  const FREEZE_MS = 1500;
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
  const WORKING = new Set(["starting", "thinking", "tool", "streaming", "compacting"]);
  const WAITING = new Set(["waitingPermission", "waitingQuestion"]);
  const ERR_COLOR = "#ff3b3b";
  const IDLE_COLOR = "#9aa0a8";
  const OFF_COLOR = "#6a6f78";

  const $ = (id) => document.getElementById(id);
  const grid = $("grid");

  const prefs = {
    sound: localStorage.getItem("deck.sound") === "1",
    offline: localStorage.getItem("deck.offline") !== "0",
    zen: localStorage.getItem("deck.zen") === "1",
    token: localStorage.getItem("deck.token") || "",
  };
  const hashToken = new URLSearchParams(location.hash.replace(/^#/, "")).get("k");
  if (hashToken) {
    prefs.token = hashToken;
    localStorage.setItem("deck.token", hashToken);
    history.replaceState(null, "", location.pathname);
  }

  const state = {
    sessions: new Map(),
    palette: {},
    summary: { working: 0, waiting: 0, done: 0, errors: 0, leading: null, perAgent: {} },
    serverOffset: 0,
    order: [],
    lastResort: 0,
    frozenUntil: 0,
    needsResort: true,
    page: 0,
    selected: 8,
    focusUid: null,
    focusButtons: [],
    focusIndex: 0,
    questionPicks: [],
    questionFocus: 0,
    settingsOpen: false,
    connected: false,
    pending: new Set(),
    holdSeconds: 20,
  };

  // ------------------------------------------------------------------ helpers
  const now = () => Date.now() + state.serverOffset;

  function agentInfo(id) {
    return (
      state.palette[id] ||
      state.palette.custom || { name: id, short: id, mono: "?", color: IDLE_COLOR, alarm: "#ff8a3d" }
    );
  }

  function colorsFor(session) {
    const info = agentInfo(session.agent);
    if (session.activity === "error") return { orb: ERR_COLOR, label: ERR_COLOR };
    if (WAITING.has(session.activity)) return { orb: info.alarm, label: info.alarm };
    if (session.activity === "offline") return { orb: OFF_COLOR, label: OFF_COLOR };
    if (session.activity === "idle") return { orb: info.color, label: IDLE_COLOR };
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
    if (WORKING.has(session.activity) || WAITING.has(session.activity) || session.activity === "error")
      return fmtElapsed(ms);
    return fmtAgo(ms);
  }

  function detailText(session) {
    switch (session.activity) {
      case "waitingPermission":
        if (session.approval)
          return `Allow ${session.approval.toolName}?\n${session.approval.commandSummary || ""}`.trim();
        return session.statusDetail || "Waiting for approval";
      case "waitingQuestion":
        return session.question?.questions?.[0]?.text || session.statusDetail || "Question";
      case "tool":
        return session.toolLabel || "";
      case "streaming":
        return (session.message?.text || "").slice(-160);
      case "done":
        return session.lastLine || "";
      case "error":
        return session.statusDetail || "error";
      case "starting":
        return session.model || "";
      case "idle":
        return session.statusDetail || "";
      case "thinking":
      case "compacting":
        return session.statusDetail || "";
      default:
        return "";
    }
  }

  function visibleSessions() {
    return state.order.map((uid) => state.sessions.get(uid)).filter(Boolean);
  }

  function pageCount() {
    return Math.max(1, Math.ceil(visibleSessions().length / SLOTS));
  }

  function toast(text, ms = 2200) {
    const el = $("toast");
    el.textContent = text;
    el.classList.remove("hidden");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => el.classList.add("hidden"), ms);
  }

  // ------------------------------------------------------------------ ordering
  function reconcileOrder(force) {
    const desired = [...state.sessions.values()]
      .filter((s) => prefs.offline || s.activity !== "offline")
      .map((s) => s.uid);
    const desiredSet = new Set(desired);
    const kept = state.order.filter((uid) => desiredSet.has(uid));
    const fresh = desired.filter((uid) => !state.order.includes(uid));
    const t = Date.now();
    const canResort = t >= state.frozenUntil && (force || state.needsResort || t - state.lastResort > RESORT_MS);
    if (canResort) {
      state.order = desired;
      state.lastResort = t;
      state.needsResort = false;
    } else {
      state.order = [...kept, ...fresh];
    }
  }

  // ------------------------------------------------------------------ rendering
  const slotNodes = [];
  function buildGrid() {
    grid.innerHTML = "";
    for (let i = 0; i < 9; i += 1) {
      const key = document.createElement("div");
      key.className = i === SLOTS ? "key hub" : "key empty";
      key.dataset.slot = String(i);
      key.innerHTML = i === SLOTS ? hubMarkup() : `<div class="screen"><span class="dot"></span></div>`;
      key.addEventListener("click", () => onKeyTap(i));
      grid.appendChild(key);
      slotNodes.push(key);
    }
  }

  function hubMarkup() {
    return `<div class="screen hub-screen">
      <div class="hub-top"><span class="hub-num" id="hub-num">0</span><div class="hub-lines"><div class="hub-l1" id="hub-l1">working</div><div class="hub-l2" id="hub-l2">none waiting</div></div></div>
      <div class="hub-done" id="hub-done"></div>
      <div class="hub-agents" id="hub-agents"></div>
      <div class="pips" id="pips">${"<i></i>".repeat(SLOTS)}</div>
      <div class="underglow" id="underglow"></div>
    </div>`;
  }

  function sessionMarkup() {
    return `<div class="screen">
      <div class="title"></div>
      <div class="line2"><span class="state"></span><span class="timer"></span></div>
      <div class="detail"></div>
      <div class="orb"></div><div class="core"></div>
      <span class="sub hidden"></span><span class="remote hidden">🌐</span>
      <span class="badge"></span>
    </div>`;
  }

  function render() {
    const list = visibleSessions();
    const pages = pageCount();
    if (state.page >= pages) state.page = pages - 1;
    const start = state.page * SLOTS;
    for (let i = 0; i < SLOTS; i += 1) {
      const session = list[start + i];
      const key = slotNodes[i];
      if (!session) {
        if (!key.classList.contains("empty")) {
          key.className = "key empty";
          key.innerHTML = `<div class="screen"><span class="dot"></span></div>`;
        }
        key.dataset.uid = "";
        continue;
      }
      if (key.classList.contains("empty")) {
        key.className = "key";
        key.innerHTML = sessionMarkup();
      }
      key.dataset.uid = session.uid;
      const screen = key.firstElementChild;
      const colors = colorsFor(session);
      screen.style.setProperty("--oc", colors.orb);
      screen.style.setProperty("--sc", colors.label);
      screen.dataset.state = session.activity;
      screen.dataset.kind = session.toolKind || "";
      screen.classList.toggle(
        "unseen",
        !session.seen && (session.activity === "done" || WAITING.has(session.activity)),
      );
      const info = agentInfo(session.agent);
      setText(screen.querySelector(".title"), session.title || session.project || session.sessionId);
      setText(screen.querySelector(".state"), LABELS[session.activity] || session.activity);
      setText(screen.querySelector(".timer"), timerText(session));
      setText(screen.querySelector(".detail"), detailText(session));
      const badge = screen.querySelector(".badge");
      setText(badge, info.mono || info.short);
      badge.title = info.name;
      const sub = screen.querySelector(".sub");
      sub.classList.toggle("hidden", !(session.subagentCount > 0));
      setText(sub, session.subagentCount > 0 ? `+${session.subagentCount}` : "");
      screen.querySelector(".remote").classList.toggle("hidden", !session.remote);
    }
    for (let i = 0; i < 9; i += 1) slotNodes[i].classList.toggle("selected", i === state.selected);
    renderHub(list);
    renderTop();
    $("page-ind").textContent = `${state.page + 1} / ${pages}`;
    $("prev").disabled = state.page === 0;
    $("next").disabled = state.page >= pages - 1;
    if (state.focusUid) renderFocus();
  }

  function renderHub(list) {
    const s = state.summary;
    setText($("hub-num"), String(s.working));
    setText($("hub-l1"), s.working === 1 ? "working" : "working");
    const l2 = $("hub-l2");
    if (s.waiting > 0) {
      setText(l2, `${s.waiting} waiting · ${s.leading || ""}`);
      l2.classList.add("alarm");
    } else {
      setText(l2, "none waiting");
      l2.classList.remove("alarm");
    }
    const parts = [];
    if (s.done > 0) parts.push(`${s.done} done`);
    if (s.errors > 0) parts.push(`${s.errors} error${s.errors > 1 ? "s" : ""}`);
    setText($("hub-done"), parts.join(" · "));
    const agentsEl = $("hub-agents");
    agentsEl.innerHTML = "";
    const entries = Object.entries(s.perAgent || {}).sort((a, b) => b[1] - a[1]);
    const shown = entries.slice(0, entries.length > 4 ? 3 : 4);
    for (const [agent, count] of shown) {
      const span = document.createElement("span");
      span.style.color = agentInfo(agent).color;
      span.textContent = count > 99 ? "99+" : String(count);
      span.title = agentInfo(agent).name;
      agentsEl.appendChild(span);
    }
    if (entries.length > 4) {
      const rest = entries.slice(3).reduce((acc, [, n]) => acc + n, 0);
      const span = document.createElement("span");
      span.style.color = "#b9c3d1";
      span.textContent = `+${rest}`;
      agentsEl.appendChild(span);
    }
    const pips = $("pips").children;
    const start = state.page * SLOTS;
    let urgent = null;
    for (let i = 0; i < SLOTS; i += 1) {
      const session = list[start + i];
      const pip = pips[i];
      if (!session) {
        pip.className = "";
        pip.style.color = "";
        continue;
      }
      pip.className = "on";
      pip.style.color = colorsFor(session).orb;
    }
    for (const session of list) {
      if (WAITING.has(session.activity)) {
        urgent = colorsFor(session).orb;
        break;
      }
      if (session.activity === "error" && !urgent) urgent = ERR_COLOR;
    }
    const glow = $("underglow");
    glow.style.setProperty("--oc", urgent || (s.working > 0 ? "#35e3a2" : "#5a5f68"));
    glow.classList.toggle("alarm", Boolean(urgent));
  }

  function renderTop() {
    const s = state.summary;
    const pill = $("pill");
    pill.classList.toggle("waiting", s.waiting > 0);
    pill.classList.toggle("off", !state.connected);
    if (!state.connected) setText($("pill-text"), "disconnected");
    else if (s.waiting > 0) setText($("pill-text"), `${s.waiting} waiting for you`);
    else setText($("pill-text"), `${s.working} agent${s.working === 1 ? "" : "s"} working`);
    const legend = $("legend");
    legend.innerHTML = "";
    for (const [agent, count] of Object.entries(s.perAgent || {})) {
      const info = agentInfo(agent);
      const span = document.createElement("span");
      span.style.color = info.color;
      span.innerHTML = `<i></i>${info.short} ${count}`;
      legend.appendChild(span);
    }
  }

  function setText(el, text) {
    if (el && el.textContent !== text) el.textContent = text;
  }

  // ------------------------------------------------------------------ focus panel
  function openFocus(uid) {
    const session = state.sessions.get(uid);
    if (!session) return;
    state.focusUid = uid;
    state.focusIndex = 0;
    state.questionPicks = [];
    state.questionFocus = 0;
    $("focus").classList.remove("hidden");
    renderFocus();
    if (session.activity === "done" && !session.seen) void sendAction(uid, "read");
  }

  function closeFocus() {
    state.focusUid = null;
    $("focus").classList.add("hidden");
  }

  function renderFocus() {
    const session = state.sessions.get(state.focusUid);
    if (!session) {
      closeFocus();
      return;
    }
    const info = agentInfo(session.agent);
    const colors = colorsFor(session);
    const panel = $("focus").querySelector(".panel");
    panel.style.setProperty("--oc", colors.orb);
    setText($("f-badge"), info.mono || info.short);
    setText($("f-agent"), info.name + (session.remote ? ` · ${session.host}` : ""));
    setText($("f-model"), [session.model, session.project].filter(Boolean).join(" · "));
    setText($("f-state"), LABELS[session.activity] || session.activity);
    setText($("f-timer"), timerText(session));
    setText($("f-title"), session.title);
    setText($("f-detail"), session.activity === "waitingQuestion" ? "" : detailText(session));
    const live = $("f-live");
    const liveText = session.message?.text || "";
    if (live.textContent !== liveText) {
      live.textContent = liveText;
      live.scrollTop = live.scrollHeight;
    }
    renderQuestion(session);
    renderActions(session);
  }

  function renderQuestion(session) {
    const box = $("f-question");
    const q = session.activity === "waitingQuestion" ? session.question?.questions?.[0] : null;
    if (!q) {
      box.classList.add("hidden");
      box.innerHTML = "";
      return;
    }
    box.classList.remove("hidden");
    box.innerHTML = "";
    const text = document.createElement("div");
    text.className = "q-text";
    text.textContent = (q.header ? `${q.header}: ` : "") + q.text;
    box.appendChild(text);
    q.options.forEach((option, index) => {
      const row = document.createElement("div");
      row.className = "q-option";
      if (state.questionFocus === index && state.focusIndex === -1) row.classList.add("focused");
      if (state.questionPicks.includes(index)) row.classList.add("picked");
      row.innerHTML = `<span class="q-idx">${index + 1}</span><span>${escapeHtml(option.label)}${option.description ? `<br><small>${escapeHtml(option.description)}</small>` : ""}</span>`;
      row.addEventListener("click", () => {
        togglePick(session, index);
        renderFocus();
      });
      box.appendChild(row);
    });
  }

  function togglePick(session, index) {
    const q = session.question?.questions?.[0];
    if (!q) return;
    if (q.multiSelect) {
      state.questionPicks = state.questionPicks.includes(index)
        ? state.questionPicks.filter((i) => i !== index)
        : [...state.questionPicks, index];
    } else {
      state.questionPicks = [index];
    }
  }

  function renderActions(session) {
    const box = $("f-actions");
    box.innerHTML = "";
    const buttons = [];
    const note = $("f-note");
    const channel = session.canAnswer;
    if (session.activity === "waitingPermission") {
      buttons.push({
        id: "allow",
        label: "Allow (hold)",
        cls: "allow",
        hold: true,
        action: () => sendAction(session.uid, "allow"),
      });
      buttons.push({ id: "deny", label: "Deny", cls: "deny", action: () => sendAction(session.uid, "deny") });
      if (channel === "hook")
        buttons.push({
          id: "dismiss",
          label: "Answer in terminal",
          cls: "ghost",
          action: () => sendAction(session.uid, "dismiss"),
        });
      note.textContent =
        channel === "hook"
          ? `The agent is holding the prompt for the deck (up to ${state.holdSeconds}s). Allow or deny here, or answer in the terminal.`
          : channel === "herdr"
            ? "Answer goes through herdr send-keys (Enter / Esc) to the agent pane."
            : channel === "adapter"
              ? "Decision is queued for the adapter."
              : "No remote channel for this session: answer in the terminal (the deck only mirrors the prompt).";
    } else if (session.activity === "waitingQuestion") {
      buttons.push({
        id: "send",
        label: "Send answer",
        cls: "allow",
        hold: true,
        action: () => sendAction(session.uid, "answer", { picks: [state.questionPicks] }),
      });
      note.textContent =
        channel === "herdr" || channel === "adapter"
          ? "Pick the options and hold Send. Multi-select questions accept several picks."
          : "Questions can only be answered from the deck for herdr-managed or adapter sessions. Answer this one in the terminal.";
    } else {
      note.textContent = "";
    }
    buttons.push({ id: "focus", label: "Open window", cls: "ghost", action: () => sendAction(session.uid, "focus") });
    buttons.push({ id: "read", label: "Mark read", cls: "ghost", action: () => sendAction(session.uid, "read") });
    if (session.activity === "offline" || session.activity === "idle" || session.activity === "done") {
      buttons.push({
        id: "remove",
        label: "Remove tile",
        cls: "ghost",
        action: () => sendAction(session.uid, "remove").then(closeFocus),
      });
    }
    buttons.push({ id: "back", label: "Back", cls: "ghost", action: closeFocus });
    state.focusButtons = buttons;
    if (state.focusIndex >= buttons.length) state.focusIndex = 0;
    buttons.forEach((button, index) => {
      const el = document.createElement("button");
      el.className = `act ${button.cls}`;
      el.innerHTML = `<span class="fill"></span><span>${button.label}</span>`;
      if (index === state.focusIndex) el.classList.add("focused");
      if (button.hold) attachHold(el, button.action);
      else el.addEventListener("click", button.action);
      button.el = el;
      box.appendChild(el);
    });
  }

  function attachHold(el, onComplete) {
    let timer = null;
    const start = () => {
      if (timer) return;
      el.classList.add("holding");
      timer = setTimeout(() => {
        timer = null;
        el.classList.remove("holding");
        onComplete();
      }, HOLD_MS);
    };
    const cancel = () => {
      if (!timer) return;
      clearTimeout(timer);
      timer = null;
      el.classList.remove("holding");
    };
    el.addEventListener("pointerdown", start);
    el.addEventListener("pointerup", cancel);
    el.addEventListener("pointerleave", cancel);
    el.addEventListener("pointercancel", cancel);
    el.holdStart = start;
    el.holdCancel = cancel;
  }

  function escapeHtml(text) {
    return String(text).replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
    );
  }

  // ------------------------------------------------------------------ actions / network
  function apiUrl(path) {
    const url = new URL(path, location.origin);
    if (prefs.token) url.searchParams.set("k", prefs.token);
    return url.toString();
  }

  async function sendAction(uid, action, extra = {}) {
    try {
      const res = await fetch(apiUrl(`/api/v1/sessions/${encodeURIComponent(uid)}/actions`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...extra }),
      });
      const body = await res.json();
      if (body.ok) {
        if (action !== "read") toast(`${action} → ${body.via}`);
        if (action === "allow" || action === "deny" || action === "dismiss" || action === "answer") closeFocus();
      } else {
        toast(`${action}: ${body.reason || res.status}`, 3200);
      }
      return body;
    } catch (error) {
      toast(`${action} failed: ${error.message}`);
      return { ok: false };
    }
  }

  let source = null;
  let reconnectTimer = null;
  function connect() {
    if (source) source.close();
    source = new EventSource(apiUrl("/api/v1/events"));
    source.addEventListener("snapshot", (event) => {
      applySnapshot(JSON.parse(event.data));
      if (!state.connected) {
        state.connected = true;
        $("conn").className = "conn ok";
        render();
      }
    });
    source.onerror = () => {
      state.connected = false;
      $("conn").className = "conn bad";
      renderTop();
      source.close();
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, 2500);
      void checkAuth();
    };
  }

  async function checkAuth() {
    try {
      const res = await fetch(apiUrl("/api/v1/state"));
      if (res.status === 401) {
        toast("Unauthorized: paste the deck token in Settings (agent-deck token)", 6000);
        openSettings();
      }
    } catch {
      // server down; keep retrying
    }
  }

  function applySnapshot(snapshot) {
    state.serverOffset = snapshot.now - Date.now();
    state.palette = snapshot.palette || {};
    state.summary = snapshot.summary;
    state.holdSeconds = snapshot.settings?.approvalHoldSeconds ?? state.holdSeconds;
    const next = new Map();
    let force = false;
    for (const session of snapshot.sessions) {
      const prev = state.sessions.get(session.uid);
      if (!prev) force = force || WAITING.has(session.activity);
      else if (!WAITING.has(prev.activity) && WAITING.has(session.activity)) {
        force = true;
        if (prefs.sound) beep(session.activity === "waitingPermission" ? 880 : 660);
      }
      next.set(session.uid, session);
    }
    state.sessions = next;
    state.pending = new Set(snapshot.pending || []);
    reconcileOrder(force);
    render();
  }

  // ------------------------------------------------------------------ input
  function onKeyTap(slot) {
    state.selected = slot;
    state.frozenUntil = Date.now() + FREEZE_MS;
    if (slot === SLOTS) {
      const waiting = visibleSessions().find((s) => WAITING.has(s.activity));
      if (waiting) {
        openFocus(waiting.uid);
      } else {
        toast("Nothing is waiting for you");
      }
      render();
      return;
    }
    const uid = slotNodes[slot].dataset.uid;
    if (uid) openFocus(uid);
    render();
  }

  function move(dx, dy) {
    state.frozenUntil = Date.now() + FREEZE_MS;
    if (state.focusUid) {
      moveInFocus(dx, dy);
      return;
    }
    let col = state.selected % 3;
    let row = Math.floor(state.selected / 3);
    col = (col + dx + 3) % 3;
    row = (row + dy + 3) % 3;
    state.selected = row * 3 + col;
    render();
  }

  function moveInFocus(dx, dy) {
    const session = state.sessions.get(state.focusUid);
    const q = session?.activity === "waitingQuestion" ? session.question?.questions?.[0] : null;
    if (q && dy !== 0) {
      if (state.focusIndex === -1) {
        const nextQ = state.questionFocus + dy;
        if (nextQ >= q.options.length) state.focusIndex = 0;
        else if (nextQ < 0) state.focusIndex = 0;
        else state.questionFocus = nextQ;
      } else if (dy < 0) {
        state.focusIndex = -1;
        state.questionFocus = q.options.length - 1;
      }
    } else if (state.focusIndex === -1 && dx !== 0 && q) {
      state.questionFocus = (state.questionFocus + dx + q.options.length) % q.options.length;
    } else if (dx !== 0) {
      const n = state.focusButtons.length;
      state.focusIndex = (state.focusIndex + dx + n) % n;
    }
    renderFocus();
  }

  function pressA() {
    state.frozenUntil = Date.now() + FREEZE_MS;
    if (state.settingsOpen) return;
    if (state.focusUid) {
      if (state.focusIndex === -1) {
        const session = state.sessions.get(state.focusUid);
        togglePick(session, state.questionFocus);
        renderFocus();
        return;
      }
      const button = state.focusButtons[state.focusIndex];
      if (!button) return;
      if (button.hold) button.el.holdStart();
      else button.action();
      return;
    }
    onKeyTap(state.selected);
  }

  function releaseA() {
    if (state.focusUid) {
      const button = state.focusButtons[state.focusIndex];
      if (button?.hold) button.el.holdCancel();
    }
  }

  function pressB() {
    if (state.settingsOpen) {
      closeSettings();
      return;
    }
    if (state.focusUid) {
      const session = state.sessions.get(state.focusUid);
      if (session && session.activity === "waitingPermission" && session.canAnswer && state.focusIndex !== -1) {
        // B on an approval = deny, like key 7 on the keypad
        void sendAction(session.uid, "deny");
        return;
      }
      closeFocus();
    }
  }

  function pressX() {
    const uid = state.focusUid || slotNodes[state.selected]?.dataset.uid;
    if (uid) void sendAction(uid, "read");
  }

  function pressY() {
    const uid = state.focusUid || slotNodes[state.selected]?.dataset.uid;
    if (uid) void sendAction(uid, "focus");
  }

  function changePage(delta) {
    const pages = pageCount();
    state.page = Math.min(pages - 1, Math.max(0, state.page + delta));
    state.frozenUntil = Date.now() + FREEZE_MS;
    render();
  }

  document.addEventListener("keydown", (event) => {
    if (event.target instanceof HTMLInputElement) return;
    const key = event.key.toLowerCase();
    if (event.repeat && !["enter", " "].includes(key)) return;
    switch (key) {
      case "arrowleft":
      case "a":
        move(-1, 0);
        break;
      case "arrowright":
      case "d":
        move(1, 0);
        break;
      case "arrowup":
      case "w":
        move(0, -1);
        break;
      case "arrowdown":
      case "s":
        move(0, 1);
        break;
      case "enter":
      case " ":
        if (!event.repeat) pressA();
        break;
      case "escape":
      case "backspace":
        pressB();
        break;
      case "x":
        pressX();
        break;
      case "y":
      case "f":
        pressY();
        break;
      case "q":
      case "pageup":
      case "[":
        changePage(-1);
        break;
      case "e":
      case "pagedown":
      case "]":
        changePage(1);
        break;
      case "tab":
        if (!state.focusUid) move(event.shiftKey ? -1 : 1, 0);
        break;
      default:
        return;
    }
    event.preventDefault();
  });
  document.addEventListener("keyup", (event) => {
    if (event.key === "Enter" || event.key === " ") releaseA();
  });

  // Gamepad (Steam Input "Gamepad" template; buttons use the standard mapping)
  const pad = { pressed: {}, lastMove: 0 };
  function pollGamepad() {
    const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
    const gp = Array.from(gamepads).find((g) => g?.connected);
    if (gp) {
      const b = (i) => Boolean(gp.buttons[i]?.pressed);
      const edge = (name, down, onDown, onUp) => {
        if (down && !pad.pressed[name]) onDown();
        if (!down && pad.pressed[name] && onUp) onUp();
        pad.pressed[name] = down;
      };
      edge("a", b(0), pressA, releaseA);
      edge("b", b(1), pressB);
      edge("x", b(2), pressX);
      edge("y", b(3), pressY);
      edge("lb", b(4), () => changePage(-1));
      edge("rb", b(5), () => changePage(1));
      edge("start", b(9), () => (state.settingsOpen ? closeSettings() : openSettings()));
      const ax = gp.axes[0] ?? 0;
      const ay = gp.axes[1] ?? 0;
      const dx = b(15) ? 1 : b(14) ? -1 : ax > 0.6 ? 1 : ax < -0.6 ? -1 : 0;
      const dy = b(13) ? 1 : b(12) ? -1 : ay > 0.6 ? 1 : ay < -0.6 ? -1 : 0;
      const t = performance.now();
      if ((dx || dy) && t - pad.lastMove > 220) {
        move(dx, dy);
        pad.lastMove = t;
      }
      if (!dx && !dy) pad.lastMove = 0;
    }
    requestAnimationFrame(pollGamepad);
  }
  requestAnimationFrame(pollGamepad);

  $("prev").addEventListener("click", () => changePage(-1));
  $("next").addEventListener("click", () => changePage(1));
  $("focus").addEventListener("click", (event) => {
    if (event.target === $("focus")) closeFocus();
  });

  // ------------------------------------------------------------------ settings
  function openSettings() {
    state.settingsOpen = true;
    $("s-sound").checked = prefs.sound;
    $("s-offline").checked = prefs.offline;
    $("s-zen").checked = prefs.zen;
    $("s-token").value = prefs.token;
    $("s-server").textContent = location.origin;
    $("settings").classList.remove("hidden");
  }
  function closeSettings() {
    state.settingsOpen = false;
    $("settings").classList.add("hidden");
  }
  $("settings-btn").addEventListener("click", openSettings);
  $("s-close").addEventListener("click", closeSettings);
  $("s-save").addEventListener("click", () => {
    prefs.sound = $("s-sound").checked;
    prefs.offline = $("s-offline").checked;
    prefs.zen = $("s-zen").checked;
    prefs.token = $("s-token").value.trim();
    localStorage.setItem("deck.sound", prefs.sound ? "1" : "0");
    localStorage.setItem("deck.offline", prefs.offline ? "1" : "0");
    localStorage.setItem("deck.zen", prefs.zen ? "1" : "0");
    localStorage.setItem("deck.token", prefs.token);
    document.body.classList.toggle("zen", prefs.zen);
    closeSettings();
    reconcileOrder(true);
    connect();
  });

  // ------------------------------------------------------------------ sound
  let audio = null;
  function beep(freq) {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.value = 0.0001;
      osc.connect(gain).connect(audio.destination);
      const t = audio.currentTime;
      gain.gain.exponentialRampToValueAtTime(0.2, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
      osc.start(t);
      osc.stop(t + 0.4);
    } catch {
      // audio blocked until first interaction
    }
  }

  // ------------------------------------------------------------------ boot
  document.body.classList.toggle("zen", prefs.zen);
  buildGrid();
  render();
  connect();
  setInterval(() => {
    const t = new Date();
    $("clock").textContent = `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
    if (!state.connected) return;
    reconcileOrder(false);
    render();
  }, 1000);
})();
