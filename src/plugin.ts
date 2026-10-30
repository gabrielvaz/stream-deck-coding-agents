import streamDeck from "@elgato/streamdeck";
import { AllowAction, bindDeck, DenyAction, HubAction, PageAction, SessionAction } from "./actions";
import { Deck } from "./deck";
import type { GlobalSettings } from "./settings";

streamDeck.logger.setLevel("info");
const log = streamDeck.logger.createScope("deck");

const deck = new Deck({
	info: (msg) => log.info(msg),
	warn: (msg) => log.warn(msg),
	error: (msg) => log.error(msg),
});
bindDeck(deck);

streamDeck.actions.registerAction(new SessionAction());
streamDeck.actions.registerAction(new HubAction());
streamDeck.actions.registerAction(new AllowAction());
streamDeck.actions.registerAction(new DenyAction());
streamDeck.actions.registerAction(new PageAction());

streamDeck.settings.onDidReceiveGlobalSettings((ev) => deck.applySettings(ev.settings as GlobalSettings));
streamDeck.system.onSystemDidWakeUp(() => deck.requestFrame());

await streamDeck.connect();
const global = (await streamDeck.settings.getGlobalSettings()) as GlobalSettings;
await deck.start(global ?? {});

const shutdown = () => {
	void deck.stop().finally(() => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// the hook server keeps Node alive: leave with Stream Deck even if it goes away without a goodbye
const parent = process.ppid;
setInterval(() => {
	try {
		process.kill(parent, 0);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") shutdown();
	}
}, 5000).unref();
