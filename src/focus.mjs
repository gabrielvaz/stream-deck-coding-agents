/**
 * "Open the window of this session": bring the terminal / IDE that hosts an agent to the front.
 *
 * Resolution order (first that works wins):
 *   1. config.openCommand / config.agents.<id>.openCommand  — template with {cwd} {title} {pid} {sessionId} {agent}
 *   2. the agent process id recorded by the hook (parent of the hook process) → platform window focus
 *   3. window title match (Windows / WSL) with the session title, project or agent name
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { clip, projectName } from "./util.mjs";

const IS_WSL = process.platform === "linux" && existsSync("/proc/version") && /microsoft/i.test(readFileSync("/proc/version", "utf8"));

function run(cmd, args, options = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 8000, windowsHide: true, maxBuffer: 1 << 20, ...options }, (error, stdout, stderr) => {
      if (error) resolve({ ok: false, reason: error.code === "ENOENT" ? `${cmd}_missing` : clip(String(stderr || error.message), 160), stdout: String(stdout ?? "") });
      else resolve({ ok: true, stdout: String(stdout ?? "") });
    });
  });
}

function fillTemplate(template, session) {
  const values = {
    cwd: session.cwd ?? "",
    title: session.title ?? "",
    pid: session.pid ?? "",
    sessionId: session.sessionId ?? "",
    agent: session.agent ?? "",
    project: session.project ?? projectName(session.cwd),
  };
  return template.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ""));
}

function runShell(command) {
  if (process.platform === "win32") return run("cmd.exe", ["/d", "/s", "/c", command]);
  return run("/bin/sh", ["-c", command]);
}

// ------------------------------------------------------------------------------------ Windows
const PS_FOCUS = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System; using System.Runtime.InteropServices;
public class Deck {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
}
"@
function Focus-Handle([IntPtr]$h) {
  if ($h -eq [IntPtr]::Zero) { return $false }
  if ([Deck]::IsIconic($h)) { [Deck]::ShowWindow($h, 9) | Out-Null }
  $fg = [Deck]::GetForegroundWindow(); $fgPid = 0
  $fgThread = [Deck]::GetWindowThreadProcessId($fg, [ref]$fgPid)
  $me = [Deck]::GetCurrentThreadId()
  [Deck]::AttachThreadInput($me, $fgThread, $true) | Out-Null
  $ok = [Deck]::SetForegroundWindow($h)
  [Deck]::AttachThreadInput($me, $fgThread, $false) | Out-Null
  return $ok
}
$target = [int]$env:DECK_PID
$titles = ($env:DECK_TITLES -split '\|') | Where-Object { $_ -and $_.Length -ge 3 }
# 1. walk the parent chain of the agent process until a windowed process shows up
$seen = @{}
while ($target -gt 0 -and -not $seen.ContainsKey($target)) {
  $seen[$target] = $true
  $p = Get-Process -Id $target
  if ($p -and $p.MainWindowHandle -ne 0) { if (Focus-Handle $p.MainWindowHandle) { Write-Output "pid:$target:$($p.ProcessName)"; exit 0 } }
  $parent = (Get-CimInstance Win32_Process -Filter "ProcessId = $target").ParentProcessId
  if (-not $parent) { break }
  $target = [int]$parent
}
# 2. windows whose title mentions the session
foreach ($t in $titles) {
  $w = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like "*$t*" } | Select-Object -First 1
  if ($w) { if (Focus-Handle $w.MainWindowHandle) { Write-Output "title:$t:$($w.ProcessName)"; exit 0 } }
}
exit 3
`;

async function focusWindows(session, titles) {
  const exe = process.platform === "win32" ? "powershell.exe" : "powershell.exe";
  const env = { ...process.env, DECK_PID: String(IS_WSL ? 0 : session.pid ?? 0), DECK_TITLES: titles.join("|") };
  const result = await run(exe, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", PS_FOCUS], { env });
  if (result.ok) return { ok: true, via: `windows:${result.stdout.trim()}` };
  return { ok: false, reason: result.reason === "powershell.exe_missing" ? "powershell_missing" : "no_window_found" };
}

// ------------------------------------------------------------------------------------ macOS
async function parentChain(pid) {
  const chain = [];
  let current = Number(pid);
  const seen = new Set();
  while (current > 1 && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    const res = await run("ps", ["-o", "ppid=", "-p", String(current)]);
    if (!res.ok) break;
    current = Number(res.stdout.trim());
  }
  return chain;
}

async function focusMac(session, titles) {
  if (session.pid) {
    const tty = (await run("ps", ["-o", "tty=", "-p", String(session.pid)])).stdout.trim();
    if (tty && tty !== "??") {
      const dev = `/dev/${tty}`;
      // exact tab in Terminal.app
      const terminal = await run("osascript", [
        "-e",
        `tell application "Terminal"
          repeat with w in windows
            repeat with t in tabs of w
              if tty of t is "${dev}" then
                set selected tab of w to t
                set index of w to 1
                activate
                return "terminal"
              end if
            end repeat
          end repeat
        end tell
        return ""`,
      ]);
      if (terminal.ok && terminal.stdout.trim() === "terminal") return { ok: true, via: "macos:Terminal tab" };
      const iterm = await run("osascript", [
        "-e",
        `tell application "iTerm2"
          repeat with w in windows
            repeat with t in tabs of w
              repeat with s in sessions of t
                if tty of s is "${dev}" then
                  select t
                  select s
                  set index of w to 1
                  activate
                  return "iterm"
                end if
              end repeat
            end repeat
          end repeat
        end tell
        return ""`,
      ]);
      if (iterm.ok && iterm.stdout.trim() === "iterm") return { ok: true, via: "macos:iTerm2 tab" };
    }
    for (const pid of await parentChain(session.pid)) {
      const res = await run("osascript", ["-e", `tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true`]);
      if (res.ok) return { ok: true, via: `macos:pid ${pid}` };
    }
  }
  for (const t of titles) {
    const res = await run("osascript", [
      "-e",
      `tell application "System Events"
        repeat with p in (processes whose background only is false)
          repeat with w in windows of p
            if name of w contains "${t.replace(/"/g, "")}" then
              set frontmost of p to true
              perform action "AXRaise" of w
              return "ok"
            end if
          end repeat
        end repeat
      end tell
      return ""`,
    ]);
    if (res.ok && res.stdout.trim() === "ok") return { ok: true, via: `macos:title ${t}` };
  }
  return { ok: false, reason: "no_window_found" };
}

// ------------------------------------------------------------------------------------ Linux (X11)
async function focusLinux(session, titles) {
  if (session.pid) {
    for (const pid of await parentChain(session.pid)) {
      const search = await run("xdotool", ["search", "--onlyvisible", "--pid", String(pid)]);
      if (!search.ok && search.reason === "xdotool_missing") return { ok: false, reason: "xdotool_missing" };
      const id = search.stdout.trim().split("\n").filter(Boolean).pop();
      if (id) {
        const act = await run("xdotool", ["windowactivate", "--sync", id]);
        if (act.ok) return { ok: true, via: `linux:pid ${pid}` };
      }
    }
  }
  for (const t of titles) {
    const search = await run("xdotool", ["search", "--onlyvisible", "--name", t]);
    if (!search.ok && search.reason === "xdotool_missing") return { ok: false, reason: "xdotool_missing" };
    const id = search.stdout.trim().split("\n").filter(Boolean).pop();
    if (id) {
      const act = await run("xdotool", ["windowactivate", "--sync", id]);
      if (act.ok) return { ok: true, via: `linux:title ${t}` };
    }
  }
  return { ok: false, reason: "no_window_found" };
}

function titleCandidates(session) {
  const out = [];
  const title = session.title ?? "";
  const afterDash = title.split(" – ").slice(1).join(" – ").trim();
  if (afterDash) out.push(clip(afterDash, 40).replace(/…$/, ""));
  if (session.project) out.push(session.project);
  if (session.cwd) out.push(projectName(session.cwd));
  const agentNames = { claude: "claude", codex: "codex", gemini: "gemini", antigravity: "agy" };
  if (agentNames[session.agent]) out.push(agentNames[session.agent]);
  return [...new Set(out.filter((t) => t && t.length >= 3))];
}

export async function openSessionWindow(session, config) {
  const template = config?.agents?.[session.agent]?.openCommand ?? config?.openCommand;
  if (template) {
    const res = await runShell(fillTemplate(template, session));
    return res.ok ? { ok: true, via: "openCommand" } : { ok: false, reason: `openCommand: ${res.reason}` };
  }
  if (session.openURL) {
    const opener = process.platform === "win32" ? ["cmd.exe", ["/d", "/s", "/c", `start "" "${session.openURL}"`]] : process.platform === "darwin" ? ["open", [session.openURL]] : ["xdg-open", [session.openURL]];
    const res = await run(opener[0], opener[1]);
    if (res.ok) return { ok: true, via: "openURL" };
  }
  const titles = titleCandidates(session);
  if (process.platform === "win32" || IS_WSL) return focusWindows(session, titles);
  if (process.platform === "darwin") return focusMac(session, titles);
  return focusLinux(session, titles);
}

export { IS_WSL, titleCandidates };
