/**
 * A tiny stand-in for the Stream Deck app: launches the real plugin (bin/plugin.js) the way
 * Stream Deck does, speaks the SDK WebSocket protocol, places keys on a virtual device and
 * records every image the plugin draws. Used by the tests and `npm run simulate`.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join, resolve } from "node:path";
import { WebSocketServer } from "ws";

export const ROOT = resolve(import.meta.dirname, "..");
export const PLUGIN_DIR = join(ROOT, "com.gabrielvaz.coding-agents.sdPlugin");
export const UUID = "com.gabrielvaz.coding-agents";

export class StreamDeckSim {
	constructor({ env = {}, globalSettings = {}, deviceType = 2, columns = 5, rows = 3, platform = process.platform === "darwin" ? "mac" : "windows" } = {}) {
		this.env = env;
		this.globalSettings = globalSettings;
		this.device = { id: "SIMDEVICE", name: "Simulated Stream Deck", size: { columns, rows }, type: deviceType };
		this.platform = platform;
		this.keys = new Map(); // context → { action, row, column, settings }
		this.images = new Map(); // context → last svg
		this.imageCount = new Map();
		this.events = []; // everything the plugin sent
		this.toInspector = [];
		this.logs = "";
	}

	async start() {
		this.wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
		await once(this.wss, "listening");
		const port = this.wss.address().port;
		const info = {
			application: { font: "", language: "en", platform: this.platform, platformVersion: "14.0", version: "7.1.0.21000" },
			colors: {},
			devicePixelRatio: 2,
			devices: [this.device],
			plugin: { uuid: UUID, version: "1.0.0.0" },
		};
		const connected = new Promise((resolveConn) => {
			this.wss.on("connection", (ws) => {
				this.ws = ws;
				ws.on("message", (data) => this.onMessage(JSON.parse(String(data))));
				resolveConn();
			});
		});
		this.child = spawn(process.execPath, [join(PLUGIN_DIR, "bin", "plugin.js"), "-port", String(port), "-pluginUUID", UUID, "-registerEvent", "registerPlugin", "-info", JSON.stringify(info)], {
			cwd: PLUGIN_DIR,
			env: { ...process.env, ...this.env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		this.child.stdout.on("data", (d) => (this.logs += d));
		this.child.stderr.on("data", (d) => (this.logs += d));
		await connected;
		await this.waitFor(() => this.registered, 10_000, "plugin registration");
		this.send({ event: "deviceDidConnect", device: this.device.id, deviceInfo: { name: this.device.name, size: this.device.size, type: this.device.type } });
		return this;
	}

	onMessage(msg) {
		this.events.push(msg);
		switch (msg.event) {
			case "registerPlugin":
				this.registered = true;
				break;
			case "getGlobalSettings":
				this.send({ event: "didReceiveGlobalSettings", payload: { settings: this.globalSettings } });
				break;
			case "setGlobalSettings":
				this.globalSettings = msg.payload;
				break;
			case "setImage": {
				const image = String(msg.payload?.image ?? "");
				const svg = image.startsWith("data:image/svg+xml,") ? decodeURIComponent(image.slice("data:image/svg+xml,".length)) : image;
				this.images.set(msg.context, svg);
				this.imageCount.set(msg.context, (this.imageCount.get(msg.context) ?? 0) + 1);
				break;
			}
			case "sendToPropertyInspector":
				this.toInspector.push(msg.payload);
				break;
			default:
				break;
		}
	}

	send(msg) {
		this.ws.send(JSON.stringify(msg));
	}

	/** Places an action on the virtual device. */
	addKey(action, row, column, settings = {}) {
		const context = `${action.split(".").pop()}-${row}-${column}`;
		this.keys.set(context, { action: `${UUID}.${action}`, row, column, settings });
		this.send({
			event: "willAppear",
			action: `${UUID}.${action}`,
			context,
			device: this.device.id,
			payload: { controller: "Keypad", coordinates: { row, column }, isInMultiAction: false, settings, state: 0 },
		});
		return context;
	}

	removeKey(context) {
		const key = this.keys.get(context);
		this.keys.delete(context);
		this.send({
			event: "willDisappear",
			action: key.action,
			context,
			device: this.device.id,
			payload: { controller: "Keypad", coordinates: { row: key.row, column: key.column }, isInMultiAction: false, settings: key.settings, state: 0 },
		});
	}

	keyEvent(event, context) {
		const key = this.keys.get(context);
		this.send({
			event,
			action: key.action,
			context,
			device: this.device.id,
			payload: { coordinates: { row: key.row, column: key.column }, isInMultiAction: false, settings: key.settings, state: 0 },
		});
	}

	async press(context, holdMs = 80) {
		this.keyEvent("keyDown", context);
		await new Promise((r) => setTimeout(r, holdMs));
		this.keyEvent("keyUp", context);
	}

	/** Opens the property inspector of a key (the SDK only talks to a visible inspector). */
	openInspector(context) {
		const key = this.keys.get(context);
		this.send({ event: "propertyInspectorDidAppear", action: key.action, context, device: this.device.id });
	}

	/** Property inspector → plugin message. */
	toPlugin(context, payload) {
		const key = this.keys.get(context);
		this.send({ event: "sendToPlugin", action: key.action, context, payload });
	}

	setGlobal(settings) {
		this.globalSettings = settings;
		this.send({ event: "didReceiveGlobalSettings", payload: { settings } });
	}

	async waitFor(fn, timeout = 8000, what = "condition") {
		const start = Date.now();
		for (;;) {
			const value = await fn();
			if (value) return value;
			if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${what}\n--- plugin output ---\n${this.logs.slice(-3000)}`);
			await new Promise((r) => setTimeout(r, 50));
		}
	}

	async stop() {
		this.child?.kill();
		if (this.child && this.child.exitCode === null) await Promise.race([once(this.child, "exit"), new Promise((r) => setTimeout(r, 2000))]);
		this.wss?.close();
	}
}
