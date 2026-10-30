import streamDeck, {
	action,
	type DidReceiveSettingsEvent,
	type KeyAction,
	type KeyDownEvent,
	type KeyUpEvent,
	type PropertyInspectorDidAppearEvent,
	type SendToPluginEvent,
	SingletonAction,
	type WillAppearEvent,
	type WillDisappearEvent,
} from "@elgato/streamdeck";
import type { JsonObject, JsonValue } from "@elgato/utils";
import { HOOK_AGENTS, type HookAgentId } from "./core/agents";
import type { Deck, KeyHandle, KeyKind } from "./deck";
import type { SessionKeySettings } from "./settings";

let deck: Deck;

export function bindDeck(instance: Deck): void {
	deck = instance;
}

function handleOf(a: KeyAction<JsonObject>): KeyHandle {
	return {
		id: a.id,
		deviceId: a.device.id,
		deviceType: Number(a.device.type),
		row: a.coordinates?.row ?? 0,
		column: a.coordinates?.column ?? 0,
		setImage: (image) => a.setImage(image),
		showOk: () => a.showOk(),
		showAlert: () => a.showAlert(),
	};
}

const isHookAgent = (value: unknown): value is HookAgentId => typeof value === "string" && (HOOK_AGENTS as readonly string[]).includes(value);

/** Messages from the property inspector (setup page), shared by every action. */
async function onInspectorMessage(payload: JsonValue): Promise<void> {
	const msg = (payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {}) as Record<string, JsonValue>;
	const reply = (extra: Record<string, unknown>) => streamDeck.ui.sendToPropertyInspector({ ...deck.statusPayload(), ...extra } as JsonObject);
	switch (msg.event) {
		case "getStatus":
			await reply({});
			return;
		case "connect":
		case "disconnect": {
			const agents = msg.agent === "all" ? deck.statuses.filter((s) => s.detected && !s.installed).map((s) => s.agent) : isHookAgent(msg.agent) ? [msg.agent] : [];
			if (agents.length === 0) {
				await reply({ message: { ok: false, text: msg.agent === "all" ? "Nothing new to connect: no other agent was found on this computer." : "Unknown agent." } });
				return;
			}
			const results = agents.map((agent) => ({ agent, ...(msg.event === "connect" ? deck.connect(agent) : deck.disconnect(agent)) }));
			const failed = results.filter((r) => !r.ok);
			await reply({ message: { ok: failed.length === 0, text: results.map((r) => r.message).join("\n") } });
			return;
		}
		case "nextPage":
			deck.nextPage();
			return;
		default:
			return;
	}
}

abstract class DeckAction extends SingletonAction<JsonObject> {
	abstract readonly kind: KeyKind;

	override onWillAppear(ev: WillAppearEvent<JsonObject>): void {
		if (!ev.action.isKey()) return;
		deck.addKey(this.kind, handleOf(ev.action), ev.payload.settings as SessionKeySettings);
	}

	override onWillDisappear(ev: WillDisappearEvent<JsonObject>): void {
		deck.removeKey(ev.action.id);
	}

	override onKeyDown(ev: KeyDownEvent<JsonObject>): void {
		deck.keyDown(ev.action.id);
	}

	override onKeyUp(ev: KeyUpEvent<JsonObject>): void {
		deck.keyUp(ev.action.id);
	}

	override onDidReceiveSettings(ev: DidReceiveSettingsEvent<JsonObject>): void {
		deck.updateKey(ev.action.id, ev.payload.settings as SessionKeySettings);
	}

	override async onPropertyInspectorDidAppear(_ev: PropertyInspectorDidAppearEvent<JsonObject>): Promise<void> {
		await streamDeck.ui.sendToPropertyInspector(deck.statusPayload() as JsonObject);
	}

	override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, JsonObject>): Promise<void> {
		await onInspectorMessage(ev.payload);
	}
}

@action({ UUID: "com.gabrielvaz.coding-agents.session" })
export class SessionAction extends DeckAction {
	readonly kind = "session";
}

@action({ UUID: "com.gabrielvaz.coding-agents.hub" })
export class HubAction extends DeckAction {
	readonly kind = "hub";
}

@action({ UUID: "com.gabrielvaz.coding-agents.allow" })
export class AllowAction extends DeckAction {
	readonly kind = "allow";
}

@action({ UUID: "com.gabrielvaz.coding-agents.deny" })
export class DenyAction extends DeckAction {
	readonly kind = "deny";
}

@action({ UUID: "com.gabrielvaz.coding-agents.page" })
export class PageAction extends DeckAction {
	readonly kind = "page";
}
