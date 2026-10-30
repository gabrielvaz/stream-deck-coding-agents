/**
 * Demo sessions: lets you (and Marketplace reviewers) see every tile state without any agent
 * installed. Each scripted session loops through realistic steps.
 */
import type { Activity, AgentId } from "./agents";
import type { SessionPatch, SessionStore } from "./store";

type Step = { at: number; patch: SessionPatch };
type Script = { agent: AgentId; id: string; project: string; prompt: string; loop: number; steps: Step[] };

const WRITE_TEXT =
	"The game app now has four seed types and fireflies at night. Plant, water and harvest are wired up, and the preview build is ready to try.";

const act = (activity: Activity, extra: SessionPatch = {}): SessionPatch => ({ activity, ...extra });

export const DEMO_SCRIPTS: Script[] = [
	{
		agent: "codex",
		id: "demo-game",
		project: "game app",
		prompt: "Create something fun with seeds and fireflies",
		loop: 70,
		steps: [
			{ at: 0, patch: act("thinking") },
			{ at: 9, patch: act("tool", { toolLabel: "exec_command  npm run build" }) },
			{ at: 17, patch: act("writing", { text: WRITE_TEXT }) },
			{ at: 30, patch: act("done", { text: WRITE_TEXT }) },
			{ at: 52, patch: act("idle") },
		],
	},
	{
		agent: "codex",
		id: "demo-install",
		project: "release kit",
		prompt: "Install the 0.3.3 build and check the ZIP",
		loop: 64,
		steps: [
			{ at: 0, patch: act("writing", { text: "Installed 0.3.3. I verified the ZIP and preview." }) },
			{ at: 12, patch: act("tool", { toolLabel: "exec_command  unzip -l build.zip" }) },
			{ at: 20, patch: act("approval", { toolLabel: "shell  rm -rf dist", approval: { tool: "shell", summary: "rm -rf dist" } }) },
			{ at: 34, patch: act("thinking") },
			{ at: 44, patch: act("done", { text: "The final checks pass." }) },
		],
	},
	{
		agent: "claude",
		id: "demo-cool",
		project: "school tool",
		prompt: "Something cool for the science fair",
		loop: 58,
		steps: [
			{ at: 0, patch: act("thinking") },
			{ at: 8, patch: act("tool", { toolLabel: "Bash  npm test" }) },
			{ at: 16, patch: act("tool", { toolLabel: "Edit  index.ts" }) },
			{ at: 24, patch: act("question", { question: { text: "Use a chart or a table?", options: ["Chart", "Table"] } }) },
			{ at: 38, patch: act("writing", { text: "Going with a chart: bars per planet, sorted by distance." }) },
			{ at: 46, patch: act("done", { text: "Added the chart and tests." }) },
		],
	},
	{
		agent: "antigravity",
		id: "demo-ideas",
		project: "activity ideas",
		prompt: "Long-term fun activity ideas",
		loop: 80,
		steps: [
			{ at: 0, patch: act("thinking") },
			{ at: 22, patch: act("tool", { toolLabel: "search_web  board games" }) },
			{ at: 30, patch: act("thinking") },
			{ at: 60, patch: act("done", { text: "Ten ideas, sorted by cost." }) },
		],
	},
	{
		agent: "antigravity",
		id: "demo-graphics",
		project: "motion graphics",
		prompt: "Graphic ideas for the intro",
		loop: 75,
		steps: [
			{ at: 0, patch: act("thinking") },
			{ at: 14, patch: act("tool", { toolLabel: "write_to_file  intro.json" }) },
			{ at: 26, patch: act("writing", { text: "Three looks: neon grid, paper cutout and soft gradients." }) },
			{ at: 40, patch: act("done", { text: "to turn on the preview, run npm start." }) },
		],
	},
	{
		agent: "claude",
		id: "demo-fun",
		project: "heinous",
		prompt: "Fun app with a leaderboard",
		loop: 90,
		steps: [
			{ at: 0, patch: act("thinking") },
			{ at: 30, patch: act("tool", { toolLabel: "Read  leaderboard.tsx" }) },
			{ at: 40, patch: act("error", { detail: "API overloaded, retrying" }) },
			{ at: 48, patch: act("thinking") },
			{ at: 70, patch: act("done", { text: "Leaderboard is live." }) },
		],
	},
	{
		agent: "claude",
		id: "demo-docs",
		project: "docs-site",
		prompt: "Fix the broken links",
		loop: 66,
		steps: [
			{ at: 0, patch: act("tool", { toolLabel: "Bash  npm run lint" }) },
			{ at: 10, patch: act("approval", { toolLabel: "Bash  git push", approval: { tool: "Bash", summary: "git push origin main" } }) },
			{ at: 26, patch: act("done", { text: "All 14 links fixed." }) },
			{ at: 48, patch: act("idle") },
		],
	},
	{
		agent: "codex",
		id: "demo-menu",
		project: "menu-layout",
		prompt: "Tidy the menu layout",
		loop: 100,
		steps: [{ at: 0, patch: act("idle") }],
	},
];

/** Applies the demo timeline for time `t` (seconds since the demo started). */
export function runDemo(store: SessionStore, t: number, applied: Map<string, number>): void {
	for (const script of DEMO_SCRIPTS) {
		const local = t % script.loop;
		let index = 0;
		for (let i = 0; i < script.steps.length; i += 1) if (script.steps[i].at <= local) index = i;
		const key = `${script.id}:${Math.floor(t / script.loop)}:${index}`;
		if (applied.get(script.id) === hash(key)) continue;
		applied.set(script.id, hash(key));
		const patch: SessionPatch = {
			title: `${script.project} – ${script.prompt}`,
			project: script.project,
			cwd: `/demo/${script.project}`,
			...script.steps[index].patch,
		};
		const session = store.upsert(script.agent, script.id, patch);
		// back-date the step so timers look alive right away
		session.activitySince = Date.now() - (local - script.steps[index].at) * 1000 - (index === 0 ? 20_000 : 0);
	}
}

export function clearDemo(store: SessionStore): void {
	for (const script of DEMO_SCRIPTS) store.remove(`${script.agent}:${script.id}`);
}

function hash(text: string): number {
	let h = 0;
	for (let i = 0; i < text.length; i += 1) h = (h * 31 + text.charCodeAt(i)) | 0;
	return h;
}
