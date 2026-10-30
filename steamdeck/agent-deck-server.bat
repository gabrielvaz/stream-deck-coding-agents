@echo off
rem Optional: start the Agent Deck SERVER on Windows (double-click or add to shell:startup).
rem Edit the path below to your checkout.
cd /d "%~dp0\.."
node bin\agent-deck.mjs serve
pause
