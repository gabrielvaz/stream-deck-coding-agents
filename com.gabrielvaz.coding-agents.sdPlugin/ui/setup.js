/* Coding Agents: property inspector logic (agent connection rows and live status). */
(() => {
	const client = window.SDPIComponents.streamDeckClient;
	const NAMES = {
		claude: ["Claude Code", "~/.claude/settings.json"],
		codex: ["Codex", "~/.codex/hooks.json"],
		antigravity: ["Antigravity CLI", "~/.gemini/config/hooks.json"],
		gemini: ["Gemini CLI", "~/.gemini/settings.json"],
	};
	const $ = (id) => document.getElementById(id);
	let busy = false;

	const send = (payload) => client.send("sendToPlugin", payload);

	function ago(ms) {
		const s = Math.round((Date.now() - ms) / 1000);
		if (s < 60) return `${s}s ago`;
		if (s < 3600) return `${Math.round(s / 60)} min ago`;
		return `${Math.round(s / 3600)} h ago`;
	}

	function render(status) {
		if (!status || status.event !== "status") return;
		const dot = $("dot");
		if (status.listening) {
			dot.className = "dot ok";
			const last = status.lastHookAt ? ` · last event ${ago(status.lastHookAt)}` : "";
			$("status").textContent = `Running · ${status.sessions} session${status.sessions === 1 ? "" : "s"}${last}`;
		} else {
			dot.className = "dot bad";
			$("status").textContent = status.problem || "Starting…";
		}
		$("home").textContent = status.home || "–";

		const list = $("agents");
		list.textContent = "";
		for (const agent of status.agents || []) {
			const [base, file] = NAMES[agent.agent] || [agent.agent, agent.path];
			const name = agent.where ? `${base} · ${agent.where}` : base;
			const row = document.createElement("div");
			row.className = "agent";
			const label = document.createElement("div");
			label.className = "name";
			const b = document.createElement("b");
			b.textContent = name;
			const small = document.createElement("small");
			small.title = agent.path || file;
			small.textContent = agent.note || (agent.installed ? file : agent.detected ? "found on this computer" : "not found on this computer");
			label.append(b, small);
			const pill = document.createElement("span");
			pill.className = `pill${agent.installed ? (agent.upToDate ? " on" : " warn") : ""}`;
			pill.textContent = agent.installed ? (agent.upToDate ? "Connected" : "Update") : "Off";
			const button = document.createElement("button");
			button.className = "sdpi-button";
			button.textContent = agent.installed ? (agent.upToDate ? "Disconnect" : "Update") : "Connect";
			button.disabled = busy;
			button.onclick = () => {
				busy = true;
				$("msg").textContent = "";
				send({ event: agent.installed && agent.upToDate ? "disconnect" : "connect", target: agent.key });
			};
			row.append(label, pill, button);
			list.append(row);
		}

		if (status.message) {
			busy = false;
			const msg = $("msg");
			msg.className = `msg ${status.message.ok ? "ok" : "bad"}`;
			msg.textContent = status.message.text;
		}
	}

	client.sendToPropertyInspector.subscribe((ev) => render(ev.payload));

	client.getConnectionInfo().then((info) => {
		const action = info?.actionInfo?.action || "";
		$("session-settings").hidden = !action.endsWith(".session");
		send({ event: "getStatus" });
	});

	// keep the status line fresh while the inspector is open
	setInterval(() => {
		if (!busy) send({ event: "getStatus" });
	}, 4000);
})();
