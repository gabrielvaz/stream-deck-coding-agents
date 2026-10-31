import { AGENTS, type AgentId, type AgentInfo, HOOK_AGENTS } from "./core/agents";
import { isTheme, safeColor, type ThemeId } from "./render/tiles";

export const VERSION = "1.2.0";
export const DEFAULT_PORT = 47821;

/** Plugin-wide settings, edited in the property inspector (sdpi `global` fields, flat keys). */
export type GlobalSettings = {
	port?: number | string;
	approvalWait?: number | string;
	holdToApprove?: boolean;
	animation?: "smooth" | "low" | "off";
	theme?: ThemeId;
	titleMode?: "both" | "topic" | "project";
	textSize?: "auto" | "normal" | "large";
	liveText?: boolean;
	doneToIdle?: number | string;
	hideIdleAfter?: number | string;
	showOffline?: boolean;
	demo?: boolean;
	herdr?: boolean;
	claudeList?: "auto" | "on" | "off";
	remoteToken?: string;
	[key: string]: unknown;
};

/** Per-key settings of the session action (slot, agent) and of the limits action (provider). */
export type SessionKeySettings = {
	slot?: string;
	agent?: string;
	provider?: string;
};

export type Resolved = {
	port: number;
	approvalWait: number;
	holdToApprove: boolean;
	fps: number;
	theme: ThemeId;
	titleMode: "both" | "topic" | "project";
	textSize: "auto" | "normal" | "large";
	liveText: boolean;
	doneToIdle: number;
	hideIdleAfter: number;
	showOffline: boolean;
	demo: boolean;
	herdr: boolean;
	claudeList: "auto" | "on" | "off";
	palette: Record<AgentId, AgentInfo>;
	openCommand: Partial<Record<AgentId, string>>;
};

const num = (value: unknown, fallback: number, min: number, max: number): number => {
	const n = Number(value);
	return Number.isFinite(n) && String(value).trim() !== "" ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};

export function resolveSettings(g: GlobalSettings): Resolved {
	const palette = {} as Record<AgentId, AgentInfo>;
	const openCommand: Partial<Record<AgentId, string>> = {};
	for (const id of Object.keys(AGENTS) as AgentId[]) {
		const base = AGENTS[id];
		palette[id] = { ...base, work: safeColor(g[`${id}Color`], base.work), alert: safeColor(g[`${id}Alert`], base.alert) };
	}
	for (const id of HOOK_AGENTS) {
		const cmd = g[`${id}Open`];
		if (typeof cmd === "string" && cmd.trim()) openCommand[id] = cmd.trim();
	}
	// keys always move while an agent works: "low" (and the old "off") only lowers the frame rate
	const fps = g.animation === "low" || g.animation === "off" ? 4 : 10;
	return {
		port: num(g.port, DEFAULT_PORT, 1024, 65000),
		approvalWait: num(g.approvalWait, 25, 0, 120),
		holdToApprove: g.holdToApprove !== false,
		fps,
		theme: isTheme(g.theme) ? g.theme : "pulse",
		titleMode: g.titleMode === "topic" || g.titleMode === "project" ? g.titleMode : "both",
		textSize: g.textSize === "normal" || g.textSize === "large" ? g.textSize : "auto",
		liveText: g.liveText !== false,
		doneToIdle: num(g.doneToIdle, 120, 0, 86400),
		hideIdleAfter: num(g.hideIdleAfter, 120, 0, 10080),
		showOffline: g.showOffline === true,
		demo: g.demo === true,
		herdr: g.herdr !== false,
		claudeList: g.claudeList === "on" || g.claudeList === "off" ? g.claudeList : "auto",
		palette,
		openCommand,
	};
}
