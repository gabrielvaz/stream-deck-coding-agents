/**
 * The website's make-believe workstation: a few agent sessions that think, run tools, write, ask
 * for permission and finish, each with the terminal transcript the laptop screen shows.
 *
 * Unlike the plugin's demo mode, approvals here really wait for the visitor: hold the key (or press
 * Allow / Deny) and the session continues. Nobody around? After a while the "user" answers in the
 * terminal, like in real life, so the page never gets stuck.
 */
import type { AgentId } from "../core/agents";
import { type Session, SessionStore } from "../core/store";

export type LineKind = "prompt" | "tool" | "out" | "say" | "ok" | "bad" | "dim" | "box";
export type Line = { text: string; kind: LineKind };

type Step =
	| { kind: "think"; secs: number }
	| { kind: "tool"; tool: string; arg: string; out: string[]; secs: number }
	| { kind: "write"; text: string }
	| { kind: "approve"; tool: string; arg: string; out: string[] }
	| { kind: "ask"; question: string; options: string[]; pick: number }
	| { kind: "fail"; error: string; secs: number }
	| { kind: "done"; secs: number };

type Task = { prompt: string; steps: Step[] };

type Actor = {
	agent: AgentId;
	id: string;
	project: string;
	command: string;
	tasks: Task[];
	/** seconds of idle before the next task */
	rest: number;
};

const ACTORS: Actor[] = [
	{
		agent: "claude",
		id: "web-docs",
		project: "docs-site",
		command: "claude",
		rest: 8,
		tasks: [
			{
				prompt: "Fix the broken links and deploy",
				steps: [
					{ kind: "tool", tool: "Edit", arg: "docs/guides/setup.md", out: ["Updated 14 links"], secs: 2 },
					{ kind: "approve", tool: "Bash", arg: "git push origin main", out: ["To github.com:acme/docs.git", "  a3f9c21..7be0d14  main -> main"] },
					{ kind: "write", text: "All 14 links fixed and pushed; the deploy preview is green." },
					{ kind: "done", secs: 0 },
				],
			},
		],
	},
	{
		agent: "claude",
		id: "web-game",
		project: "game app",
		command: "claude",
		rest: 7,
		tasks: [
			{
				prompt: "Add fireflies that come out at night",
				steps: [
					{ kind: "think", secs: 5.1 },
					{ kind: "tool", tool: "Read", arg: "src/world/night.ts", out: ["Read 214 lines"], secs: 3.4 },
					{ kind: "tool", tool: "Edit", arg: "src/world/fireflies.ts", out: ["Added 38 lines"], secs: 5.1 },
					{ kind: "approve", tool: "Bash", arg: "npm run build && npm test", out: ["✓ 128 tests passed", "built in 2.1s"] },
					{ kind: "write", text: "Fireflies now spawn at dusk, drift towards lights and fade out at dawn. I added a toggle in the settings menu." },
					{ kind: "done", secs: 0 },
				],
			},
			{
				prompt: "Make the seeds grow a little faster",
				steps: [
					{ kind: "think", secs: 3.4 },
					{ kind: "tool", tool: "Grep", arg: "growthRate", out: ["3 matches in 2 files"], secs: 3.4 },
					{ kind: "tool", tool: "Edit", arg: "src/plants/seed.ts", out: ["Updated 2 lines"], secs: 3.4 },
					{ kind: "write", text: "Seeds now grow 30% faster; sunflowers still take a full day." },
					{ kind: "done", secs: 0 },
				],
			},
		],
	},
	{
		agent: "codex",
		id: "web-api",
		project: "api-server",
		command: "codex",
		rest: 6,
		tasks: [
			{
				prompt: "Add rate limiting to the public endpoints",
				steps: [
					{ kind: "think", secs: 3.4 },
					{ kind: "tool", tool: "exec_command", arg: "rg -n 'router.get' src", out: ["src/routes/public.ts: 14 routes"], secs: 3.4 },
					{ kind: "tool", tool: "apply_patch", arg: "src/middleware/rateLimit.ts", out: ["A src/middleware/rateLimit.ts"], secs: 5.1 },
					{ kind: "approve", tool: "shell", arg: "cargo test -p api", out: ["test result: ok. 64 passed"] },
					{ kind: "write", text: "Public routes are limited to 60 requests a minute per key, with a Retry-After header." },
					{ kind: "done", secs: 0 },
				],
			},
		],
	},
	{
		agent: "antigravity",
		id: "web-ideas",
		project: "motion graphics",
		command: "agy",
		rest: 9,
		tasks: [
			{
				prompt: "Three looks for the intro animation",
				steps: [
					{ kind: "think", secs: 6.8 },
					{ kind: "tool", tool: "search_web", arg: "kinetic typography 2026", out: ["8 results"], secs: 5.1 },
					{ kind: "tool", tool: "write_to_file", arg: "intro/looks.md", out: ["Created intro/looks.md"], secs: 3.4 },
					{ kind: "write", text: "Three looks: neon grid, paper cutout and soft gradients. Each has a 10-second storyboard." },
					{ kind: "done", secs: 0 },
				],
			},
		],
	},
	{
		agent: "codex",
		id: "web-mobile",
		project: "mobile-app",
		command: "codex",
		rest: 7,
		tasks: [
			{
				prompt: "Rework the navigation",
				steps: [
					{ kind: "tool", tool: "apply_patch", arg: "src/Navigation.tsx", out: ["M src/Navigation.tsx"], secs: 5.1 },
					{ kind: "ask", question: "Use tabs or a drawer?", options: ["Tabs", "Drawer"], pick: 0 },
					{ kind: "write", text: "Tabs it is: four sections, and the profile moves to the header." },
					{ kind: "done", secs: 0 },
				],
			},
		],
	},
	{
		agent: "gemini",
		id: "web-research",
		project: "research",
		command: "gemini",
		rest: 10,
		tasks: [
			{
				prompt: "Compare three charting libraries",
				steps: [
					{ kind: "think", secs: 8.5 },
					{ kind: "tool", tool: "google_web_search", arg: "chart library benchmarks", out: ["6 sources"], secs: 6.8 },
					{ kind: "fail", error: "rate limited (429), retrying", secs: 6.8 },
					{ kind: "think", secs: 5.1 },
					{ kind: "write", text: "Recharts for simple dashboards, ECharts for large data, visx when you need full control." },
					{ kind: "done", secs: 0 },
				],
			},
		],
	},
	{
		agent: "claude",
		id: "web-refactor",
		project: "billing",
		command: "claude",
		rest: 9,
		tasks: [
			{
				prompt: "Split the billing module",
				steps: [
					{ kind: "tool", tool: "Grep", arg: "invoice", out: ["41 matches in 9 files"], secs: 5.1 },
					{ kind: "think", secs: 6.8 },
					{ kind: "tool", tool: "Edit", arg: "billing/tax.ts", out: ["Created billing/tax.ts"], secs: 5.1 },
					{ kind: "tool", tool: "Edit", arg: "billing/invoice.ts", out: ["Updated 120 lines"], secs: 5.1 },
					{ kind: "write", text: "Billing is now three modules: invoices, tax and payments, with the same public API." },
					{ kind: "done", secs: 0 },
				],
			},
		],
	},
	{
		agent: "antigravity",
		id: "web-menu",
		project: "menu-layout",
		command: "agy",
		rest: 12,
		tasks: [
			{
				prompt: "Tidy the menu layout",
				steps: [
					{ kind: "tool", tool: "view_file", arg: "src/Menu.css", out: ["Read 88 lines"], secs: 5.1 },
					{ kind: "write", text: "The menu now uses an 8 px grid and wraps cleanly on small screens." },
					{ kind: "done", secs: 0 },
				],
			},
		],
	},
	{
		agent: "codex",
		id: "web-bugfix",
		project: "checkout",
		command: "codex",
		rest: 8,
		tasks: [
			{
				prompt: "Fix the coupon rounding bug",
				steps: [
					{ kind: "tool", tool: "exec_command", arg: "npm test -- coupon", out: ["1 failing: rounds 9.995 to 9.99"], secs: 5 },
					{ kind: "think", secs: 4 },
					{ kind: "tool", tool: "apply_patch", arg: "src/money.ts", out: ["M src/money.ts"], secs: 4 },
					{ kind: "approve", tool: "shell", arg: "npm test", out: ["✓ 212 passed"] },
					{ kind: "write", text: "Amounts are now rounded half-up in cents, so 9.995 becomes 10.00." },
					{ kind: "done", secs: 0 },
				],
			},
		],
	},
	{
		agent: "claude",
		id: "web-tests",
		project: "design system",
		command: "claude",
		rest: 9,
		tasks: [
			{
				prompt: "Add visual tests for the buttons",
				steps: [
					{ kind: "think", secs: 4 },
					{ kind: "tool", tool: "Write", arg: "tests/button.visual.ts", out: ["Created 64 lines"], secs: 5 },
					{ kind: "tool", tool: "Bash", arg: "npx playwright test button", out: ["12 passed (8.1s)"], secs: 6 },
					{ kind: "write", text: "Twelve snapshots cover every size and state, in light and dark mode." },
					{ kind: "done", secs: 0 },
				],
			},
		],
	},
	{
		agent: "antigravity",
		id: "web-landing",
		project: "landing page",
		command: "agy",
		rest: 7,
		tasks: [
			{
				prompt: "Make the hero section pop",
				steps: [
					{ kind: "tool", tool: "view_file", arg: "src/Hero.tsx", out: ["Read 120 lines"], secs: 4 },
					{ kind: "ask", question: "Gradient headline or a video?", options: ["Gradient", "Video"], pick: 0 },
					{ kind: "tool", tool: "replace_file_content", arg: "src/Hero.tsx", out: ["Updated 18 lines"], secs: 5 },
					{ kind: "write", text: "The headline now has an animated gradient and the CTA lifts on hover." },
					{ kind: "done", secs: 0 },
				],
			},
		],
	},
];

export type Toast = { text: string; tone: "ok" | "bad" | "info"; at: number };

type Run = {
	actor: Actor;
	uid: string;
	task: number;
	step: number;
	stepAt: number;
	restUntil: number;
	lines: Line[];
	/** characters of the current "write" step already shown */
	typed: number;
	/** set while a step waits for the visitor */
	waitingSince: number;
};

const APPROVAL_PATIENCE = 32; // s before the "user" answers in the terminal
const QUESTION_PATIENCE = 14;

export class World {
	readonly store = new SessionStore({ doneToIdleSeconds: 25, hideIdleAfterMinutes: 0, offlineAfterMinutes: 0 });
	readonly runs = new Map<string, Run>();
	focused = "";
	toast: Toast | null = null;
	/** bumps whenever something the laptop shows changed */
	version = 0;

	constructor(now = Date.now()) {
		const warmup = 20_000;
		ACTORS.forEach((actor, i) => {
			const uid = `${actor.agent}:${actor.id}`;
			const run: Run = { actor, uid, task: 0, step: 0, stepAt: now, restUntil: 0, lines: [], typed: 0, waitingSince: 0 };
			this.runs.set(uid, run);
			// staggered starts, then fast-forward: the deck opens with a bit of everything going on
			this.startTask(run, now - 3000 - i * 2200);
		});
		for (let t = now - warmup; t <= now; t += 200) this.tick(t);
		this.focused = [...this.runs.keys()][0];
	}

	private session(run: Run): Session {
		return this.store.get(run.uid) as Session;
	}

	private startTask(run: Run, now: number): void {
		const task = run.actor.tasks[run.task % run.actor.tasks.length];
		run.step = 0;
		run.stepAt = now;
		run.typed = 0;
		run.waitingSince = 0;
		run.lines.push({ text: task.prompt, kind: "prompt" });
		const s = this.store.upsert(run.actor.agent, run.actor.id, { title: task.prompt, project: run.actor.project, cwd: `~/${run.actor.project}`, activity: "thinking", text: null, source: "hook" });
		s.activitySince = now;
		this.enterStep(run, now);
	}

	private enterStep(run: Run, now: number): void {
		const task = run.actor.tasks[run.task % run.actor.tasks.length];
		const step = task.steps[run.step];
		run.stepAt = now;
		run.typed = 0;
		run.waitingSince = 0;
		this.version += 1;
		if (!step) return;
		const s = this.session(run);
		switch (step.kind) {
			case "think":
				this.store.upsert(run.actor.agent, run.actor.id, { activity: "thinking" });
				break;
			case "tool":
				this.store.upsert(run.actor.agent, run.actor.id, { activity: "tool", toolLabel: `${step.tool}  ${step.arg}` });
				run.lines.push({ text: `${step.tool}(${step.arg})`, kind: "tool" });
				break;
			case "approve":
				this.store.upsert(run.actor.agent, run.actor.id, { activity: "approval", toolLabel: `${step.tool}  ${step.arg}`, approval: { tool: step.tool, summary: step.arg } });
				run.lines.push({ text: `${step.tool}(${step.arg})`, kind: "tool" });
				run.waitingSince = now;
				break;
			case "ask":
				this.store.upsert(run.actor.agent, run.actor.id, { activity: "question", question: { text: step.question, options: step.options } });
				run.waitingSince = now;
				break;
			case "write":
				this.store.upsert(run.actor.agent, run.actor.id, { activity: "writing", text: null });
				break;
			case "fail":
				this.store.upsert(run.actor.agent, run.actor.id, { activity: "error", detail: step.error });
				run.lines.push({ text: `API error: ${step.error}`, kind: "bad" });
				break;
			case "done":
				this.store.upsert(run.actor.agent, run.actor.id, { activity: "done", text: s.text });
				run.restUntil = now + run.actor.rest * 1000;
				break;
		}
		s.activitySince = now;
	}

	private next(run: Run, now: number): void {
		run.step += 1;
		this.enterStep(run, now);
	}

	/** Advances every session to `now`. */
	tick(now = Date.now()): void {
		for (const run of this.runs.values()) {
			const task = run.actor.tasks[run.task % run.actor.tasks.length];
			const step = task.steps[run.step];
			const age = (now - run.stepAt) / 1000;
			if (!step) {
				// finished: rest, then the next task
				if (now >= run.restUntil) {
					run.task += 1;
					if (run.lines.length > 60) run.lines.splice(0, run.lines.length - 40);
					run.lines.push({ text: "", kind: "dim" });
					this.startTask(run, now);
				}
				continue;
			}
			switch (step.kind) {
				case "think":
				case "fail":
					if (age >= step.secs) this.next(run, now);
					break;
				case "tool":
					if (age >= step.secs) {
						for (const o of step.out) run.lines.push({ text: o, kind: "out" });
						this.next(run, now);
					}
					break;
				case "write": {
					const chars = Math.min(step.text.length, Math.floor(age * 34));
					if (chars !== run.typed) {
						run.typed = chars;
						this.store.upsert(run.actor.agent, run.actor.id, { text: step.text.slice(0, chars) });
						this.version += 1;
					}
					if (chars >= step.text.length && age > step.text.length / 34 + 0.8) {
						run.lines.push({ text: step.text, kind: "say" });
						this.next(run, now);
					}
					break;
				}
				case "approve":
					if (age >= APPROVAL_PATIENCE) this.resolve(run, true, now, "terminal");
					break;
				case "ask":
					if (age >= QUESTION_PATIENCE) this.answer(run, now, "terminal");
					break;
				case "done":
					break;
			}
		}
	}

	/** The partly typed answer of a session, for the laptop. */
	typing(uid: string): string {
		const run = this.runs.get(uid);
		if (!run) return "";
		const step = run.actor.tasks[run.task % run.actor.tasks.length].steps[run.step];
		return step?.kind === "write" ? step.text.slice(0, run.typed) : "";
	}

	/** What the session is waiting for, if anything. */
	pending(uid: string): { kind: "approve"; tool: string; arg: string } | { kind: "ask"; question: string; options: string[] } | null {
		const run = this.runs.get(uid);
		if (!run) return null;
		const step = run.actor.tasks[run.task % run.actor.tasks.length].steps[run.step];
		if (step?.kind === "approve") return { kind: "approve", tool: step.tool, arg: step.arg };
		if (step?.kind === "ask") return { kind: "ask", question: step.question, options: step.options };
		return null;
	}

	actorOf(uid: string): Actor | null {
		return this.runs.get(uid)?.actor ?? null;
	}

	linesOf(uid: string): Line[] {
		return this.runs.get(uid)?.lines ?? [];
	}

	private resolve(run: Run, allow: boolean, now: number, via: "deck" | "terminal"): void {
		const step = run.actor.tasks[run.task % run.actor.tasks.length].steps[run.step];
		if (step?.kind !== "approve") return;
		if (allow) {
			run.lines.push({ text: via === "deck" ? "Allowed from Stream Deck" : "Allowed in the terminal", kind: "ok" });
			for (const o of step.out) run.lines.push({ text: o, kind: "out" });
			this.store.upsert(run.actor.agent, run.actor.id, { activity: "tool", approval: null });
			this.next(run, now);
		} else {
			run.lines.push({ text: "Denied from Stream Deck", kind: "bad" });
			this.store.upsert(run.actor.agent, run.actor.id, { activity: "thinking", approval: null });
			// skip the step's output and carry on with the task
			this.next(run, now);
		}
		const s = this.session(run);
		s.seen = true;
		if (via === "deck") this.toast = { text: `${allow ? "Allowed" : "Denied"}: ${step.tool} ${step.arg}`, tone: allow ? "ok" : "bad", at: now };
		this.version += 1;
	}

	private answer(run: Run, now: number, via: "deck" | "terminal"): void {
		const step = run.actor.tasks[run.task % run.actor.tasks.length].steps[run.step];
		if (step?.kind !== "ask") return;
		run.lines.push({ text: `${step.question} → ${step.options[step.pick]}${via === "deck" ? "" : ""}`, kind: "ok" });
		this.store.upsert(run.actor.agent, run.actor.id, { question: null });
		this.next(run, now);
	}

	// ---------------------------------------------------------------------------------------------- what the keys do

	/** Press: bring the session's window forward (and, for a question, answer it there). */
	open(uid: string, now = Date.now()): void {
		const run = this.runs.get(uid);
		if (!run) return;
		this.focused = uid;
		this.store.markSeen(uid);
		const s = this.session(run);
		if (s.activity === "done") this.store.setActivity(s, "idle");
		this.toast = { text: `Opened ${run.actor.project}`, tone: "info", at: now };
		this.version += 1;
		// a question gets answered by the "user" a moment after the window comes up
		if (this.pending(uid)?.kind === "ask") setTimeout(() => this.answer(run, Date.now(), "deck"), 1600);
	}

	/** Hold or Allow / Deny: answer a permission request. */
	decide(uid: string, allow: boolean, now = Date.now()): boolean {
		const run = this.runs.get(uid);
		if (!run || this.pending(uid)?.kind !== "approve") return false;
		this.focused = uid;
		this.resolve(run, allow, now, "deck");
		return true;
	}

	/** The oldest session waiting for a permission. */
	firstApproval(): Session | null {
		let best: Session | null = null;
		for (const run of this.runs.values()) {
			if (this.pending(run.uid)?.kind !== "approve") continue;
			const s = this.session(run);
			if (!best || s.activitySince < best.activitySince) best = s;
		}
		return best;
	}

	/** Sessions in deck order, with the "project – topic" titles the plugin shows. */
	ordered(): Session[] {
		return this.store.ordered(false).map((s) => ({ ...s, title: s.project ? `${s.project} – ${s.title}` : s.title }));
	}
}
