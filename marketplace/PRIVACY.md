# Coding Agents for Stream Deck: Privacy Policy

_Last updated: 2026-10-30_

**Coding Agents does not collect, send or sell any data.** It has no analytics, no telemetry, no account and no network connection to any server.

What the plugin does on your computer:

- **Local endpoint.** It listens on `127.0.0.1` (your own computer only) so your coding agents can report their state. Requests must carry a random token stored in `~/.coding-agents-deck/endpoint.json`, a file only your user account can read. The token changes every time Stream Deck starts.
- **Session data stays in memory.** Session titles, states, tool names and the last words an agent wrote are kept in memory to draw the keys and are discarded when sessions end or Stream Deck quits. Nothing is written to disk except the plugin's own log file inside its plugin folder (which Stream Deck deletes when you uninstall the plugin).
- **Agent settings files.** Only when you press *Connect* in the key settings, the plugin adds hook entries to that agent's settings file (`~/.claude/settings.json`, `~/.codex/hooks.json`, `~/.gemini/config/hooks.json` and `~/.gemini/antigravity-cli/settings.json`, `~/.gemini/settings.json`, or the same files inside a WSL distribution). A backup of the previous file is kept next to it (`*.coding-agents-deck.bak`). *Disconnect* removes only the entries the plugin added.
- **Bringing windows to the front.** When you press a key, the plugin asks the operating system for the window that hosts that session (PowerShell on Windows, AppleScript on macOS) and activates it. macOS may ask you to allow Stream Deck to control Terminal, iTerm2 or System Events.

Permission decisions you make on the Stream Deck (Allow / Deny) are passed only to the agent that asked for them, on your computer.

Questions or requests: https://github.com/gabrielvaz/stream-deck-coding-agents/issues
