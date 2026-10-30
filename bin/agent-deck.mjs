#!/usr/bin/env node
import { existsSync } from "node:fs";
import { request } from "node:http";
import { ADAPTER_API_FILE, CONFIG_PATH, loadConfig, updateConfig } from "../src/config.mjs";
import { startDemo } from "../src/demo.mjs";
import { HerdrClient, herdrSocketPath } from "../src/herdr.mjs";
import { HOOK_SCRIPT, hookStatus, installAgents, SUPPORTED, uninstallAgents } from "../src/install.mjs";
import { createDeckServer } from "../src/server.mjs";
import { installPlugin, PLUGIN_SRC, pluginsDir, uninstallPlugin } from "../src/streamdeck.mjs";
import { DeckStore } from "../src/store.mjs";
import { lanAddresses, randomToken } from "../src/util.mjs";

const HELP = `agent-deck — Steam Deck / browser status board for coding agents

Usage:
  agent-deck serve [--port N] [--host A] [--no-token] [--no-herdr] [--demo]
  agent-deck demo                      same as serve --demo (fake sessions, no hooks needed)
  agent-deck install <agents…|all> [--project DIR] [--no-live-text]
  agent-deck uninstall <agents…|all> [--project DIR]
  agent-deck status                    sessions currently on the deck (needs a running server)
  agent-deck token [--rotate]          print (or rotate) the deck token
  agent-deck doctor                    check hooks, herdr socket and server
  agent-deck url                       print the URLs to open on the Steam Deck
  agent-deck streamdeck install [--link]   copy (or symlink) the Elgato Stream Deck plugin into the Stream Deck app
  agent-deck streamdeck uninstall

Agents: ${SUPPORTED.join(", ")} (herdr sessions are picked up automatically from its socket)
Config: ${CONFIG_PATH}
`;

function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (
        next !== undefined &&
        !next.startsWith("--") &&
        !["no-token", "no-herdr", "demo", "rotate", "no-live-text", "open", "link"].includes(key)
      ) {
        args.flags[key] = next;
        i += 1;
      } else {
        args.flags[key] = true;
      }
    } else {
      args._.push(arg);
    }
  }
  return args;
}

function deckUrls(config) {
  const suffix = config.requireToken ? `/#k=${config.token}` : "/";
  const hosts =
    config.host === "127.0.0.1" || config.host === "localhost" ? ["127.0.0.1"] : ["127.0.0.1", ...lanAddresses()];
  return hosts.map((host) => `http://${host}:${config.port}${suffix}`);
}

async function serve(args) {
  const config = loadConfig();
  if (args.flags.port || args.flags.host || args.flags["no-token"]) {
    // persist so the hook script, `status` and the installers find the same server
    updateConfig((c) => {
      if (args.flags.port) c.port = Number(args.flags.port);
      if (args.flags.host) c.host = String(args.flags.host);
      if (args.flags["no-token"]) c.requireToken = false;
    });
    Object.assign(config, loadConfig());
  }
  const store = new DeckStore(config);
  let herdr = null;
  if (config.herdr?.enabled !== false && !args.flags["no-herdr"]) {
    herdr = new HerdrClient(store, config);
    herdr.start();
  }
  const deck = createDeckServer(config, store, { herdr });
  await deck.listen();
  let stopDemo = null;
  if (args.flags.demo) stopDemo = startDemo(store);

  console.log(`agent-deck ${args.flags.demo ? "(demo) " : ""}listening on ${config.host}:${config.port}`);
  console.log("Open on the Steam Deck (or any browser):");
  for (const url of deckUrls(config)) console.log(`  ${url}`);
  console.log(`Hook endpoint: http://127.0.0.1:${config.port}/api/v1/hook/<agent>`);
  console.log(`Adapter API (Orbtile-compatible): ${ADAPTER_API_FILE}`);
  if (herdr)
    console.log(
      `herdr socket: ${herdrSocketPath(config)}${existsSync(herdrSocketPath(config)) ? "" : " (not found yet, will retry)"}`,
    );
  const installed = hookStatus()
    .filter((s) => s.installed)
    .map((s) => s.agent);
  console.log(`Hooks installed: ${installed.length ? installed.join(", ") : "none — run `agent-deck install all`"}`);

  const shutdown = () => {
    stopDemo?.();
    herdr?.stop();
    store.close();
    deck.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function agentsFrom(list) {
  if (list.length === 0) throw new Error(`which agents? ${SUPPORTED.join(", ")} or all`);
  if (list.includes("all")) return [...SUPPORTED];
  return list;
}

function fetchState(config) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: config.port,
        path: "/api/v1/state",
        headers: { "X-Agent-Deck-Token": config.token },
        timeout: 2000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.end();
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] ?? "help";
  switch (command) {
    case "serve":
      await serve(args);
      return;
    case "demo":
      args.flags.demo = true;
      await serve(args);
      return;
    case "install": {
      const config = loadConfig();
      const results = installAgents(agentsFrom(args._.slice(1)), {
        project: args.flags.project ? String(args.flags.project) : undefined,
        port: config.port,
        liveText: !args.flags["no-live-text"],
      });
      for (const r of results) console.log(`✔ ${r.agent}: hooks written to ${r.path}`);
      console.log(`Hook script: ${HOOK_SCRIPT}`);
      if (results.some((r) => r.agent === "codex"))
        console.log("Codex: open codex and run /hooks to review and trust the new hooks.");
      if (results.some((r) => r.agent === "gemini"))
        console.log("Gemini CLI: if hooks stay silent, run /hooks enable-all inside gemini.");
      return;
    }
    case "uninstall": {
      const results = uninstallAgents(agentsFrom(args._.slice(1)), {
        project: args.flags.project ? String(args.flags.project) : undefined,
      });
      for (const r of results) console.log(`✔ ${r.agent}: Agent Deck hooks removed from ${r.path}`);
      return;
    }
    case "token": {
      const config = args.flags.rotate
        ? updateConfig((c) => {
            c.token = randomToken();
          })
        : loadConfig();
      console.log(config.token);
      return;
    }
    case "streamdeck": {
      const sub = args._[1] ?? "install";
      if (sub === "uninstall") {
        const removed = uninstallPlugin();
        console.log(removed ? `✔ removed ${removed}` : "Stream Deck plugins folder not found");
        return;
      }
      if (sub !== "install") throw new Error("usage: agent-deck streamdeck install [--link] | uninstall");
      const { target, linked } = installPlugin({ link: Boolean(args.flags.link) });
      console.log(`✔ ${linked ? "linked" : "copied"} ${PLUGIN_SRC}\n  → ${target}`);
      console.log("Now quit and reopen the Stream Deck app, then drag 'Coding Agents → Agent Session' onto your keys.");
      console.log(`Plugins folder: ${pluginsDir()}`);
      return;
    }
    case "url": {
      const config = loadConfig();
      for (const url of deckUrls(config)) console.log(url);
      return;
    }
    case "status": {
      const config = loadConfig();
      let state;
      try {
        state = await fetchState(config);
      } catch (error) {
        console.error(`server not reachable on 127.0.0.1:${config.port} (${error.message}); run \`agent-deck serve\``);
        process.exit(1);
      }
      const { sessions, summary } = state.body;
      console.log(
        `${summary.working} working · ${summary.waiting} waiting · ${summary.done} done · ${summary.errors} errors`,
      );
      for (const s of sessions) {
        const age = Math.round((state.body.now - s.activitySince) / 1000);
        console.log(`  [${s.agent.padEnd(11)}] ${s.activity.padEnd(18)} ${String(age).padStart(5)}s  ${s.title}`);
      }
      return;
    }
    case "doctor": {
      const config = loadConfig();
      console.log(`config: ${CONFIG_PATH}`);
      console.log(`port: ${config.port}  host: ${config.host}  token required: ${config.requireToken}`);
      for (const s of hookStatus()) console.log(`${s.installed ? "✔" : "✘"} ${s.agent.padEnd(12)} ${s.path}`);
      const sock = herdrSocketPath(config);
      console.log(`${existsSync(sock) ? "✔" : "✘"} herdr socket  ${sock}`);
      try {
        const state = await fetchState(config);
        console.log(`✔ server        ${state.body.sessions.length} sessions, ${state.body.viewers} viewer(s)`);
      } catch {
        console.log("✘ server        not running (agent-deck serve)");
      }
      return;
    }
    default:
      console.log(HELP);
  }
}

main().catch((error) => {
  console.error(`agent-deck: ${error.message}`);
  process.exit(1);
});
