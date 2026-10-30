import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const PLUGIN_ID = "com.gabrielvaz.coding-agents";
export const PLUGIN_SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "streamdeck", `${PLUGIN_ID}.sdPlugin`);

const IS_WSL = process.platform === "linux" && existsSync("/proc/version") && /microsoft/i.test(readFileSync("/proc/version", "utf8"));

/** Where the Stream Deck app loads plugins from. */
export function pluginsDir() {
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "com.elgato.StreamDeck", "Plugins");
  if (process.platform === "win32") return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "Elgato", "StreamDeck", "Plugins");
  if (IS_WSL) {
    try {
      const appdata = execFileSync("cmd.exe", ["/d", "/c", "echo %APPDATA%"], { encoding: "utf8", windowsHide: true }).trim();
      const wsl = execFileSync("wslpath", ["-u", appdata], { encoding: "utf8" }).trim();
      return join(wsl, "Elgato", "StreamDeck", "Plugins");
    } catch {
      return null;
    }
  }
  return null;
}

export function installPlugin({ link = false } = {}) {
  const dir = pluginsDir();
  if (!dir) throw new Error("Stream Deck plugins folder not found: install the Elgato Stream Deck app on Windows or macOS.");
  if (!existsSync(dirname(dir))) throw new Error(`Stream Deck app not found (${dirname(dir)} does not exist).`);
  mkdirSync(dir, { recursive: true });
  const target = join(dir, `${PLUGIN_ID}.sdPlugin`);
  if (existsSync(target) || isDanglingLink(target)) rmSync(target, { recursive: true, force: true });
  if (link && !IS_WSL) symlinkSync(PLUGIN_SRC, target, process.platform === "win32" ? "junction" : "dir");
  else cpSync(PLUGIN_SRC, target, { recursive: true });
  return { target, linked: link && !IS_WSL };
}

export function uninstallPlugin() {
  const dir = pluginsDir();
  if (!dir) return null;
  const target = join(dir, `${PLUGIN_ID}.sdPlugin`);
  if (existsSync(target) || isDanglingLink(target)) rmSync(target, { recursive: true, force: true });
  return target;
}

function isDanglingLink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}
