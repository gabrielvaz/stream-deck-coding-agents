/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * The landing page's virtual Stream Deck: the plugin's own renderer and demo sessions, running in
 * the browser. Bundled to docs/assets/deck.js by rollup.web.config.mjs.
 */
import { ACTIVITIES, type Activity, AGENTS } from "../core/agents";
import { runDemo } from "../core/demo";
import { SessionStore } from "../core/store";
import { decisionTile, hubTile, pageTile, sessionTile, type ThemeId, THEMES, toDataUrl } from "../render/tiles";

const store = new SessionStore({ doneToIdleSeconds: 0, hideIdleAfterMinutes: 0, offlineAfterMinutes: 0 });
const legend = new SessionStore({ doneToIdleSeconds: 0, hideIdleAfterMinutes: 0, offlineAfterMinutes: 0 });
const applied = new Map<string, number>();
const start = Date.now() - 14_000;
let theme: ThemeId = "pulse";

function viewTitle(title: string, project: string): string {
	return project && title && !title.startsWith(project) ? `${project} – ${title}` : title || project;
}

/** Fills `.deck[data-keys]` with 15 keys: 11 sessions, overview, allow, deny, page. */
function frame(): void {
	const now = Date.now();
	runDemo(store, (now - start) / 1000, applied);
	const sessions = store.ordered(false).map((s) => ({ ...s, title: viewTitle(s.title, s.project) }));
	const ctx = { now, palette: AGENTS, animate: true, theme };
	const approval = sessions.find((s) => s.activity === "approval") ?? null;
	// the flat deck is only the fallback when the 3D stage is running
	const flatHidden = document.body.classList.contains("has-3d");
	for (const deck of document.querySelectorAll<HTMLElement>(".deck[data-keys]")) {
		if (flatHidden && deck.classList.contains("flat")) continue;
		const imgs = deck.querySelectorAll<HTMLImageElement>("img");
		const count = imgs.length;
		const svgs: string[] = [];
		for (let i = 0; i < count - 4; i += 1) {
			const s = sessions[i];
			svgs.push(s ? sessionTile(s, { ...ctx, large: deck.dataset.large === "1" }) : '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144"><rect width="144" height="144" fill="#050506"/><circle cx="72" cy="72" r="5" fill="#1F2227"/></svg>');
		}
		svgs.push(hubTile({ summary: store.summary(), pips: sessions.slice(0, count - 4), page: 0, pages: 1, listening: true, problem: "", connectedAgents: 4 }, ctx));
		svgs.push(decisionTile("allow", approval, ctx), decisionTile("deny", approval, ctx), pageTile(0, 1, sessions.length));
		svgs.forEach((svg, i) => {
			const url = toDataUrl(svg);
			if (imgs[i] && imgs[i].dataset.src !== url) {
				imgs[i].src = url;
				imgs[i].dataset.src = url;
			}
		});
	}
	// the state legend: one key per state in the current theme
	for (const cell of document.querySelectorAll<HTMLImageElement>("img[data-state]")) {
		const activity = cell.dataset.state as Activity;
		const agent = (cell.dataset.agent as keyof typeof AGENTS) ?? "claude";
		const s = legend.upsert(agent, `legend-${activity}`, {
			title: cell.dataset.title ?? activity,
			activity,
			toolLabel: "Bash  npm test",
			text: "Three looks: neon grid, paper cutout and soft gradients.",
			detail: activity === "error" ? "rate limited (429)" : undefined,
			approval: activity === "approval" ? { tool: "Bash", summary: "git push origin main" } : undefined,
			question: activity === "question" ? { text: "Tabs or a drawer?", options: [] } : undefined,
		});
		if (now - s.activitySince > 30_000 || s.activity !== activity) s.activitySince = now - 4000;
		s.seen = true;
		cell.src = toDataUrl(sessionTile(s, { ...ctx, marquee: false }));
	}
}

function setTheme(next: ThemeId): void {
	theme = next;
	for (const b of document.querySelectorAll<HTMLButtonElement>("[data-theme]")) b.setAttribute("aria-pressed", String(b.dataset.theme === next));
	const info = THEMES.find((t) => t.id === next);
	const note = document.getElementById("theme-note");
	if (note && info) note.textContent = info.description;
	window.dispatchEvent(new CustomEvent("deck-theme", { detail: next }));
}

for (const b of document.querySelectorAll<HTMLButtonElement>("[data-theme]")) b.addEventListener("click", () => setTheme(b.dataset.theme as ThemeId));
setTheme("pulse");
frame();
setInterval(frame, 100);

export { ACTIVITIES };
