/**
 * Demo mode: fake sessions that walk through every state so the deck can be previewed
 * (and screenshotted) without any agent running.
 */
const SCRIPTS = [
  {
    agent: "codex",
    id: "demo-codex-1",
    title: "game app – Create a game app with four seed types",
    model: "gpt-5.5-codex",
    loop: [
      ["thinking", 4],
      ["tool", 5, { toolLabel: "shell  npm test", toolKind: "shell" }],
      [
        "streaming",
        8,
        {
          text: "The game has four seed types and a skill tree. Next I will wire the sprites and the firefly particles at night.",
        },
      ],
      ["done", 20],
      ["idle", 25],
    ],
  },
  {
    agent: "codex",
    id: "demo-codex-2",
    title: "Install Orbtile 0.3 – ZIP and preview",
    model: "gpt-5.5-codex",
    loop: [
      ["thinking", 6],
      ["tool", 4, { toolLabel: "apply_patch  installer.ts", toolKind: "edit" }],
      [
        "streaming",
        6,
        { text: "ZIP and preview.\nThe final checks pass; the installer caches the download next to the app bundle." },
      ],
      ["done", 12],
    ],
  },
  {
    agent: "claude",
    id: "demo-claude-1",
    title: "docs-site – Something cool with the docs site",
    model: "claude-fable-5-1",
    loop: [
      ["thinking", 5],
      ["tool", 6, { toolLabel: "Bash  npm test", toolKind: "shell" }],
      [
        "waitingPermission",
        25,
        {
          approval: { id: "approval-demo", toolName: "Bash", commandSummary: "rm -rf node_modules" },
          statusDetail: "Allow Bash?",
        },
      ],
      ["tool", 3, { toolLabel: "Edit  layout.tsx", toolKind: "edit" }],
      ["streaming", 7, { text: "Updated the menu layout and fixed the breakpoint. Running the test suite once more." }],
      ["done", 15],
    ],
  },
  {
    agent: "claude",
    id: "demo-claude-2",
    title: "heinous – Fun app with fireflies at night",
    model: "claude-opus-5-5",
    loop: [
      ["thinking", 9],
      [
        "waitingQuestion",
        30,
        {
          question: {
            id: "question-demo",
            questions: [
              {
                text: "Which docs should I update?",
                header: "Docs",
                multiSelect: true,
                options: [
                  { label: "README" },
                  { label: "Protocol", description: "API details" },
                  { label: "Changelog" },
                ],
              },
            ],
          },
          statusDetail: "Which docs should I update?",
        },
      ],
      ["tool", 4, { toolLabel: "Write  README.md", toolKind: "edit" }],
      ["done", 10],
    ],
  },
  {
    agent: "antigravity",
    id: "demo-ag-1",
    title: "Long-Term Fun Activity Ideas – Lo-fi",
    model: "gemini-3.6-pro",
    loop: [
      ["thinking", 12],
      ["tool", 5, { toolLabel: "run_command  bun run build", toolKind: "shell" }],
      ["done", 9, { text: "al-fm-preview rendered; turn on the lights to see the night scene." }],
    ],
  },
  {
    agent: "antigravity",
    id: "demo-ag-2",
    title: "Motion Graphics Ideas – Creative",
    model: "gemini-3.6-flash",
    loop: [
      ["thinking", 7],
      ["error", 14, { statusDetail: "rate_limit: 429 Too Many Requests" }],
      ["thinking", 5],
      ["done", 8],
    ],
  },
  {
    agent: "gemini",
    id: "demo-gemini-1",
    title: "mobile-app – Question about the onboarding flow",
    model: "gemini-3.6-pro",
    loop: [
      ["thinking", 6],
      ["tool", 4, { toolLabel: "read_file  Onboarding.tsx", toolKind: "read" }],
      ["compacting", 4],
      ["thinking", 3],
      ["done", 10],
      ["idle", 20],
    ],
  },
  {
    agent: "grok",
    id: "demo-grok-1",
    title: "menu-layout – Idle session in herdr",
    model: "grok-5",
    loop: [
      ["idle", 40],
      ["thinking", 6],
      ["done", 6],
    ],
  },
  {
    agent: "claude",
    id: "demo-claude-3",
    title: "cool app project – Cool app with ChatGPT tabs",
    model: "claude-sonnet-5-5",
    loop: [
      ["tool", 9, { toolLabel: "Read  cua_repl.js", toolKind: "read" }],
      ["thinking", 5],
      ["done", 18, { text: "Users/devin/Documents/ChatGPT/tabs.json written." }],
      ["offline", 30],
    ],
  },
];

export function startDemo(store, speed = 1) {
  const timers = [];
  for (const script of SCRIPTS) {
    let step = 0;
    const run = () => {
      const [activity, seconds, extra = {}] = script.loop[step % script.loop.length];
      const patch = {
        title: script.title,
        model: script.model,
        activity,
        project: script.title.split(" – ")[0],
        toolLabel: extra.toolLabel ?? null,
        toolKind: extra.toolKind ?? "",
        statusDetail: extra.statusDetail ?? null,
        approval: extra.approval ?? null,
        question: extra.question ?? null,
      };
      if (activity === "streaming") patch.message = { id: `demo-${step}`, text: "" };
      else if (extra.text) patch.message = { id: `demo-${step}`, text: extra.text };
      store.upsert(script.agent, script.id, patch, { agent: script.agent, source: "demo" });
      if (activity === "streaming" && extra.text) {
        const words = extra.text.split(" ");
        let i = 0;
        const typer = setInterval(() => {
          if (i >= words.length) {
            clearInterval(typer);
            return;
          }
          store.upsert(
            script.agent,
            script.id,
            { appendText: { id: `demo-${step}`, delta: `${words[i]} ` } },
            { agent: script.agent, source: "demo" },
          );
          i += 1;
        }, 180 / speed);
        timers.push(typer);
      }
      step += 1;
      const timer = setTimeout(run, (seconds * 1000) / speed);
      timers.push(timer);
    };
    const timer = setTimeout(run, Math.random() * 1500);
    timers.push(timer);
  }
  return () => {
    for (const timer of timers) {
      clearTimeout(timer);
      clearInterval(timer);
    }
  };
}
