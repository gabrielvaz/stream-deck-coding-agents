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
- **Gallery (1920×960):** `marketplace/gallery/1-hero.png`, `2-states.png`, `3-approve.png`, `4-themes.png` (+ the demo video, see below)

## Description

The first 250 characters are plain text and show in search results.

```
See every AI coding agent at a glance. Each Stream Deck key shows one Claude Code, Codex, Antigravity CLI or Gemini CLI session: its state, timer, current tool or live text, and an animation. Press to jump to its window, hold to approve a request.

Keys
• Agent Session: one live session per key, sorted so the ones waiting for you come first.
• Agents Overview: how many are working, waiting and done. Press to open the first session that needs you.
• Allow / Deny: answer the oldest Claude Code or Codex permission request.
• Next Page: more sessions than keys? Flip pages.

Four themes: Pulse, Glow, Clawd (a pixel critter that types, waves, sleeps and celebrates) and Minimal.

Setup in one click: press Connect next to each agent in a key's settings. The plugin adds its hooks with a backup and uses Stream Deck's built-in Node.js, so there is nothing else to install. Works with agents in WSL, on servers over SSH, and every agent herdr runs (Cursor, Copilot, OpenCode and more).

Private: sessions stay on your computer. No account, no analytics. An Agent Limits key shows how much of your 5-hour and weekly limits is left.

Requirements: Stream Deck 7.1+ on Windows 10+ or macOS 12+, and Claude Code, Codex CLI, Antigravity CLI, Gemini CLI or herdr.
```

## Additional links

- **Support:** https://github.com/gabrielvaz/stream-deck-coding-agents/issues
- **Privacy policy:** https://github.com/gabrielvaz/stream-deck-coding-agents/blob/main/marketplace/PRIVACY.md
- **Website:** https://gabrielvaz.github.io/stream-deck-coding-agents/ (enable GitHub Pages: Settings → Pages → main, /docs)
- **Source / documentation:** https://github.com/gabrielvaz/stream-deck-coding-agents

## Release notes (1.0.0)

```
First release.
• Live keys for Claude Code, Codex, Antigravity CLI and Gemini CLI sessions: state, timer, tool, streamed text.
• Four themes: Pulse, Glow, Clawd and Minimal; every state has its own motion.
• herdr agents, Claude Code background sessions, WSL and SSH remotes.
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
- [ ] **Trademarks.** The Clawd theme draws an original pixel critter inspired by Claude Code's mascot, and the badges use generic glyphs (no third-party logos). If a reviewer objects to the mascot, rename the theme (e.g. "Critter") in `src/render/tiles.ts` and the setup page; the drawing itself needs no change.
