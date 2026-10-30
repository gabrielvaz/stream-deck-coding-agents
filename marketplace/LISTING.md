# Elgato Marketplace listing

Everything Maker Console asks for, ready to paste. The Marketplace requires English.

## Product

- **Name** (≤ 30 chars, unique, no "plugin"): `Coding Agents`
- **Category:** Developer Tools (or Productivity)
- **Tags:** `claude code`, `codex`, `antigravity`, `gemini cli`, `ai`, `coding`, `developer`, `agents`, `terminal`, `productivity`
- **Price:** free
- **Plugin file:** `dist/com.gabrielvaz.coding-agents.streamDeckPlugin` (`npm run pack`, or the GitHub release asset)
- **App icon (288×288):** `marketplace/app-icon-288.png`
- **Thumbnail (1920×960):** `marketplace/gallery/1-hero.png`
- **Gallery (1920×960):** `marketplace/gallery/1-hero.png`, `2-states.png`, `3-approve.png` (+ the demo video, see below)

## Description

The first 250 characters are plain text and show in search results.

```
See every AI coding agent at a glance. Each Stream Deck key shows one Claude Code, Codex, Antigravity CLI or Gemini CLI session: its state, timer, current tool or live text, and a glowing orb. Press to jump to its window, hold to approve a request.

Keys
• Agent Session: one live session per key. Sessions waiting for you come first, then working ones, then finished ones.
• Agents Overview: how many agents are working, waiting and done, with one coloured pip per session. Press to open the first session that needs you.
• Allow / Deny: answer the oldest Claude Code or Codex permission request.
• Next Page: more sessions than keys? Flip pages.

Setup in one click
Open any key's settings and press Connect next to each agent. The plugin adds its hooks to that agent's settings file (with a backup) and removes only its own entries when you disconnect. It uses Stream Deck's built-in Node.js runtime, so there is nothing else to install. Agents inside WSL are supported on Windows.

Private
Everything stays on your computer: a local, token-protected endpoint on 127.0.0.1, no account, no analytics.

Requirements
Stream Deck 7.1 or later on Windows 10+ or macOS 12+, and at least one of: Claude Code 2.1.214+, OpenAI Codex CLI, Google Antigravity CLI, Gemini CLI. Codex asks you to trust new hooks once (/hooks). Allow / Deny works with Claude Code and Codex.
```

## Additional links

- **Support:** https://github.com/gabrielvaz/stream-deck-coding-agents/issues
- **Privacy policy:** https://github.com/gabrielvaz/stream-deck-coding-agents/blob/main/marketplace/PRIVACY.md
- **Source / documentation:** https://github.com/gabrielvaz/stream-deck-coding-agents

## Release notes (1.0.0)

```
First release.
• Live keys for Claude Code, Codex, Antigravity CLI and Gemini CLI sessions: state, timer, tool, streamed text, breathing orb.
• Press to open the session window (Windows Terminal tab, VS Code, Terminal.app, iTerm2…), hold to allow a permission request.
• Overview, Allow, Deny and Next Page keys.
• One-click connect per agent, including agents inside WSL on Windows.
• Demo mode to try every state without an agent.
```

## Before submitting

- [ ] **AI disclosure.** Elgato asks makers to declare AI use, and products made *entirely* with AI can be rejected. This plugin was written with an AI coding assistant: describe your own part (concept, design direction, review, testing on your hardware) honestly in the submission form.
- [ ] **Demo video** (1920×1080 MP4, < 250 MB). Elgato requires one for plugins that need other software or paid services. Record a real Stream Deck: an agent working, a key turning to *Approval*, holding it, the window coming forward. Turning on *Advanced → Demo* in the key settings gives a ready-made scene for the first seconds.
- [ ] **Test on hardware** on both Windows and macOS (key rendering, window focus, macOS Automation prompts).
- [ ] **Version.** Bump `package.json`, `src/settings.ts` (`VERSION`) and `manifest.json` (`x.y.z.0`) together; `npm test` checks they match.
- [ ] `npm run validate` and `npm run pack`, then upload `dist/com.gabrielvaz.coding-agents.streamDeckPlugin` in Maker Console (Create product → Stream Deck plugin).
- [ ] The UUID `com.gabrielvaz.coding-agents` can never change after the first publication.
