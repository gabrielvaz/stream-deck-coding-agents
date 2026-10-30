/**
 * Windows only: one long-lived PowerShell process that answers "process chain" and "focus window"
 * requests in tens of milliseconds (a fresh powershell.exe plus Add-Type costs ~1 s per call).
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";

const WIN32 = String.raw`
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class DeckWin {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("kernel32.dll")] public static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll")] public static extern bool FreeConsole();
  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
  // The window that shows a console process: conhost's own window, or for ConPTY sessions
  // (Windows Terminal, VS Code…) the terminal window that owns the pseudo-console window.
  public static IntPtr ConsoleOwner(uint pid) {
    FreeConsole();
    if (!AttachConsole(pid)) return IntPtr.Zero;
    IntPtr h = GetConsoleWindow();
    FreeConsole();
    if (h == IntPtr.Zero) return IntPtr.Zero;
    IntPtr owner = GetAncestor(h, 3);
    if (owner != IntPtr.Zero && IsWindowVisible(owner)) return owner;
    return IsWindowVisible(h) ? h : IntPtr.Zero;
  }
  public static string Title(IntPtr h) { var sb = new StringBuilder(512); GetWindowText(h, sb, 512); return sb.ToString(); }
  public static uint OwnerPid(IntPtr h) { uint pid; GetWindowThreadProcessId(h, out pid); return pid; }
  public static bool Focus(IntPtr h) {
    if (h == IntPtr.Zero) return false;
    if (IsIconic(h)) ShowWindow(h, 9);
    uint fgPid;
    uint fgThread = GetWindowThreadProcessId(GetForegroundWindow(), out fgPid);
    uint me = GetCurrentThreadId();
    keybd_event(0x12, 0, 0, UIntPtr.Zero);
    keybd_event(0x12, 0, 2, UIntPtr.Zero);
    AttachThreadInput(me, fgThread, true);
    BringWindowToTop(h);
    bool ok = SetForegroundWindow(h);
    AttachThreadInput(me, fgThread, false);
    return ok;
  }
  public static IntPtr FindByTitle(string needle) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate (IntPtr h, IntPtr p) {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512);
      GetWindowText(h, sb, 512);
      if (sb.ToString().IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
`;

const SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(WIN32).toString("base64")}')))
try { Add-Type -AssemblyName UIAutomationClient; Add-Type -AssemblyName UIAutomationTypes; $script:uia = $true } catch { $script:uia = $false }
function Get-DeckChain([int]$id) {
  $out = @(); $seen = @{}
  while ($id -gt 4 -and -not $seen.ContainsKey($id) -and $out.Count -lt 24) {
    $seen[$id] = $true
    $p = Get-CimInstance Win32_Process -Filter "ProcessId = $id"
    if (-not $p) { break }
    $out += [pscustomobject]@{ pid = $id; ppid = [int]$p.ParentProcessId; name = [string]$p.Name }
    $id = [int]$p.ParentProcessId
  }
  return ,$out
}
function Select-DeckTab([IntPtr]$h, $titles) {
  if (-not $script:uia -or -not $titles) { return $false }
  $root = [Windows.Automation.AutomationElement]::FromHandle($h)
  if (-not $root) { return $false }
  $cond = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::TabItem)
  $tabs = $root.FindAll([Windows.Automation.TreeScope]::Descendants, $cond)
  foreach ($t in $titles) {
    foreach ($tab in $tabs) {
      if ($tab.Current.Name -and $tab.Current.Name.IndexOf($t, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
        $sel = $null
        if ($tab.TryGetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern, [ref]$sel)) { $sel.Select(); return $true }
      }
    }
  }
  return $false
}
$script:skip = @('explorer.exe', 'svchost.exe', 'services.exe', 'wininit.exe', 'winlogon.exe', 'sihost.exe', 'userinit.exe')
# The window that hosts the session: the first process up the chain that owns a window, or whose
# console belongs to a visible terminal window. Never the desktop shell.
function Find-DeckWindow($req) {
  $chain = @()
  foreach ($id in @($req.pids)) { if ([int]$id -gt 0) { $chain = Get-DeckChain ([int]$id); if ($chain.Count -gt 0) { break } } }
  foreach ($p in $chain) {
    if ($script:skip -contains $p.name.ToLower()) { continue }
    $proc = Get-Process -Id $p.pid
    if ($proc -and $proc.MainWindowHandle -ne 0) { return @{ h = $proc.MainWindowHandle; how = "window:$($proc.ProcessName)" } }
    $h = [DeckWin]::ConsoleOwner([uint32]$p.pid)
    if ($h -ne [IntPtr]::Zero) {
      $owner = Get-Process -Id ([DeckWin]::OwnerPid($h))
      if ($owner -and $script:skip -notcontains ($owner.ProcessName.ToLower() + '.exe')) { return @{ h = $h; how = "console:$($owner.ProcessName)" } }
    }
  }
  return $null
}
function Invoke-DeckProbe($req) {
  $w = Find-DeckWindow $req
  if (-not $w) { return @{ ok = $false; via = 'none' } }
  return @{ ok = $true; via = $w.how; title = [DeckWin]::Title($w.h) }
}
function Invoke-DeckFocus($req) {
  $titles = @($req.titles | Where-Object { $_ -and $_.Length -ge 3 })
  $w = Find-DeckWindow $req
  if ($w) {
    $ok = [DeckWin]::Focus($w.h)
    $tab = $false
    if ($w.how -like '*WindowsTerminal') { $tab = Select-DeckTab $w.h $titles }
    return @{ ok = $ok; via = $w.how; tab = $tab }
  }
  foreach ($t in $titles) {
    $h = [DeckWin]::FindByTitle($t)
    if ($h -ne [IntPtr]::Zero) { return @{ ok = [DeckWin]::Focus($h); via = "title:$t" } }
  }
  return @{ ok = $false; via = 'none' }
}
function Invoke-Deck([string]$b64) {
  try {
    $req = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64)) | ConvertFrom-Json
    $res = $null
    if ($req.op -eq 'chain') { $res = @{ ok = $true; chain = (Get-DeckChain ([int]$req.pid)) } }
    elseif ($req.op -eq 'focus') { $res = Invoke-DeckFocus $req }
    elseif ($req.op -eq 'probe') { $res = Invoke-DeckProbe $req }
    elseif ($req.op -eq 'ping') { $res = @{ ok = $true } }
    else { $res = @{ ok = $false; via = 'unknown op' } }
    [Console]::Out.WriteLine(($res | ConvertTo-Json -Compress -Depth 5))
  } catch {
    [Console]::Out.WriteLine((@{ ok = $false; via = "$_" } | ConvertTo-Json -Compress))
  }
  [Console]::Out.WriteLine('__DECK_END__')
}
`;

type Pending = { line: string; resolve: (value: Record<string, unknown>) => void; timer: NodeJS.Timeout };

export class PowerShellHelper {
	private child: ChildProcessWithoutNullStreams | null = null;
	private queue: Pending[] = [];
	private current: Pending | null = null;
	private buffer = "";
	private ready = false;
	private disposed = false;
	private lastSpawn = 0;

	constructor(private readonly log: (msg: string) => void = () => {}) {}

	private start(): void {
		if (this.child || this.disposed) return;
		this.lastSpawn = Date.now();
		const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"], {
			windowsHide: true,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.child = child;
		this.ready = false;
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => this.onData(chunk));
		child.stderr.on("data", () => {});
		child.on("exit", () => {
			this.child = null;
			this.ready = false;
			const failed = [this.current, ...this.queue.splice(0)].filter(Boolean) as Pending[];
			this.current = null;
			for (const p of failed) {
				clearTimeout(p.timer);
				p.resolve({ ok: false, via: "powershell exited" });
			}
			// attaching to another process's console (to find its terminal window) ends the host
			// after it answers: start a fresh one now so the next request does not pay the start-up
			if (!this.disposed) setTimeout(() => this.start(), Math.max(0, 2000 - (Date.now() - this.lastSpawn)));
			if (this.queue.length > 0) setTimeout(() => this.next(), 50);
		});
		child.on("error", (error) => this.log(`powershell: ${error.message}`));
		// define the functions once; each line is a complete statement for `-Command -`
		const bootstrap = Buffer.from(SCRIPT, "utf8").toString("base64");
		child.stdin.write(`. ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${bootstrap}'))))\n`);
		this.ready = true;
	}

	private onData(chunk: string): void {
		this.buffer += chunk;
		let index = this.buffer.indexOf("__DECK_END__");
		while (index >= 0) {
			const block = this.buffer.slice(0, index);
			this.buffer = this.buffer.slice(index + "__DECK_END__".length).replace(/^\r?\n/, "");
			const line = block.trim().split(/\r?\n/).filter(Boolean).pop() ?? "";
			const done = this.current;
			this.current = null;
			if (done) {
				clearTimeout(done.timer);
				try {
					done.resolve(JSON.parse(line) as Record<string, unknown>);
				} catch {
					done.resolve({ ok: false, via: `bad reply: ${line.slice(0, 120)}` });
				}
			}
			this.next();
			index = this.buffer.indexOf("__DECK_END__");
		}
	}

	private next(): void {
		if (this.current || this.queue.length === 0) return;
		this.start();
		if (!this.child || !this.ready) return;
		this.current = this.queue.shift() ?? null;
		if (this.current) this.child.stdin.write(this.current.line);
	}

	request(payload: Record<string, unknown>, timeoutMs = 6000): Promise<Record<string, unknown>> {
		return new Promise((resolve) => {
			const b64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
			const pending: Pending = {
				line: `Invoke-Deck '${b64}'\n`,
				resolve,
				timer: setTimeout(() => {
					if (this.current === pending) {
						// a stuck call: restart the helper so the next press works
						this.current = null;
						this.child?.kill();
					}
					this.queue = this.queue.filter((p) => p !== pending);
					resolve({ ok: false, via: "timeout" });
				}, timeoutMs),
			};
			this.queue.push(pending);
			this.next();
		});
	}

	dispose(): void {
		this.disposed = true;
		this.child?.kill();
		this.child = null;
	}
}
