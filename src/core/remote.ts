/**
 * Agents on another machine (a server you reach over SSH, a dev container…).
 *
 * The SSH reverse tunnel `ssh -R <port>:127.0.0.1:<port> host` makes the plugin's local endpoint
 * reachable as 127.0.0.1:<port> on the remote machine. There, hooks only need `curl`: no Node.js,
 * no copy of the plugin. The setup script below is served by the plugin itself through the tunnel:
 *
 *   curl -fsS "http://127.0.0.1:<port>/remote/setup.sh?k=<token>" | sh
 *
 * It needs python3 on the remote to merge the agents' JSON settings (backups are kept), and it
 * only touches agents whose folders exist there (~/.claude, ~/.codex, ~/.gemini).
 */
const MARK = ".coding-agents-deck";

const CLAUDE_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "Notification", "SubagentStart", "SubagentStop", "Stop", "StopFailure", "PreCompact", "PostCompact", "SessionEnd"];
const CODEX_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PreCompact", "PostCompact", "SubagentStart", "SubagentStop", "Stop", "Interrupt", "SessionEnd"];
const GEMINI_EVENTS = ["SessionStart", "SessionEnd", "BeforeAgent", "AfterAgent", "BeforeTool", "AfterTool", "Notification", "PreCompress"];
const AGY_EVENTS = ["SessionStart", "PreInvocation", "PostInvocation", "PreToolUse", "PostToolUse", "Stop"];

export function remoteCommands(port: number, token: string): { tunnel: string; setup: string; remove: string } {
	const url = `http://127.0.0.1:${port}/remote/setup.sh?k=${token}`;
	return {
		tunnel: `ssh -R ${port}:127.0.0.1:${port} <your-server>`,
		setup: `curl -fsS "${url}" | sh`,
		remove: `curl -fsS "${url}&remove=1" | sh`,
	};
}

export function remoteSetupScript(port: number, token: string, remove: boolean): string {
	const py = String.raw`
import json, os, shutil, socket, sys

PORT, TOKEN, REMOVE = sys.argv[1], sys.argv[2], sys.argv[3] == "1"
MARK = "${MARK}"
HOST = socket.gethostname().split(".")[0]
HOME = os.path.expanduser("~")

def curl(agent, seconds, event=""):
    q = "?host=" + HOST + ("&event=" + event if event else "")
    neutral = "echo '{\"decision\":\"allow\"}'" if agent == "antigravity" and event == "PreToolUse" else ("true" if agent == "claude" else "echo '{}'")
    return ("curl -s -m %d -X POST -H 'Authorization: Bearer %s' -H 'Content-Type: application/json' "
            "--data-binary @- 'http://127.0.0.1:%s/hook/%s%s' || %s # %s") % (seconds, TOKEN, PORT, agent, q, neutral, MARK)

def load(path):
    if not os.path.exists(path):
        return {}
    with open(path) as f:
        text = f.read().strip()
    return json.loads(text) if text else {}

def save(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if os.path.exists(path):
        shutil.copyfile(path, path + ".coding-agents-deck.bak")
    with open(path, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")

def strip(hooks):
    out = {}
    for event, groups in (hooks or {}).items():
        kept = []
        for g in groups if isinstance(groups, list) else []:
            if isinstance(g, dict) and isinstance(g.get("hooks"), list):
                g = dict(g, hooks=[h for h in g["hooks"] if MARK not in json.dumps(h)])
                if not g["hooks"]:
                    continue
            elif MARK in json.dumps(g):
                continue
            kept.append(g)
        if kept:
            out[event] = kept
    return out

done = []
def hooks_file(path, key_events, build, top="hooks"):
    data = load(path)
    hooks = strip(data.get(top))
    if not REMOVE:
        for event in key_events:
            hooks.setdefault(event, []).append(build(event))
    if hooks:
        data[top] = hooks
    else:
        data.pop(top, None)
    save(path, data)
    done.append(path)

if os.path.isdir(os.path.join(HOME, ".claude")):
    def claude(event):
        h = {"type": "command", "command": curl("claude", 300 if event == "PermissionRequest" else 5), "timeout": 300 if event == "PermissionRequest" else 10}
        if event != "PermissionRequest":
            h["async"] = True
        return {"hooks": [h]}
    hooks_file(os.path.join(HOME, ".claude", "settings.json"), ${JSON.stringify(CLAUDE_EVENTS)} + ["PermissionRequest"], claude)

if os.path.isdir(os.path.join(HOME, ".codex")):
    def codex(event):
        sync = event == "PermissionRequest"
        h = {"type": "command", "command": curl("codex", 300 if sync else 5), "timeout": 300 if sync else 10}
        if not sync:
            h["async"] = True
        return {"hooks": [h]}
    hooks_file(os.path.join(HOME, ".codex", "hooks.json"), ${JSON.stringify(CODEX_EVENTS)} + ["PermissionRequest"], codex)

if os.path.exists(os.path.join(HOME, ".gemini", "settings.json")):
    def gemini(event):
        g = {"hooks": [{"name": "coding-agents-deck", "type": "command", "command": curl("gemini", 5), "timeout": 8000}]}
        if event in ("BeforeTool", "AfterTool"):
            g["matcher"] = ".*"
        return g
    hooks_file(os.path.join(HOME, ".gemini", "settings.json"), ${JSON.stringify(GEMINI_EVENTS)}, gemini)

agy = os.path.join(HOME, ".gemini", "config", "hooks.json")
if os.path.isdir(os.path.join(HOME, ".gemini", "antigravity-cli")) or os.path.exists(agy):
    data = load(agy)
    data.pop("coding-agents-deck", None)
    if not REMOVE:
        entry = {}
        for event in ${JSON.stringify(AGY_EVENTS)}:
            h = {"type": "command", "command": curl("antigravity", 5, event), "timeout": 10}
            entry[event] = [{"matcher": "*", "hooks": [h]}] if event in ("PreToolUse", "PostToolUse") else [h]
        data["coding-agents-deck"] = entry
    save(agy, data)
    done.append(agy)

print(("Removed the Stream Deck hooks from:" if REMOVE else "Connected to your Stream Deck:") + "".join("\n  " + p for p in done) if done else "No Claude Code, Codex, Gemini or Antigravity settings found in " + HOME)
`;
	return [
		"#!/bin/sh",
		"# Coding Agents for Stream Deck: connects the agents on this machine to your Stream Deck",
		"# through an SSH reverse tunnel (ssh -R). Generated by the plugin; safe to read before running.",
		"set -e",
		"command -v curl >/dev/null 2>&1 || { echo 'curl is required'; exit 1; }",
		"PY=$(command -v python3 || command -v python || true)",
		'[ -n "$PY" ] || { echo "python3 is required to edit the agents\' settings"; exit 1; }',
		`"$PY" - ${port} ${token} ${remove ? 1 : 0} <<'PYEOF'`,
		py.trim(),
		"PYEOF",
		remove ? "" : `echo "Keep the tunnel open while you work: ssh -R ${port}:127.0.0.1:${port} <this server>"`,
		"",
	].join("\n");
}
