# Agent Deck

> Transforme o **Steam Deck** (ou qualquer tela com navegador) no painel de status dos seus agentes de código, no estilo dos "tiles" do Logitech MX Keypad + Orbtile: um quadrado por sessão, um orbe colorido por agente, estado (`Thinking`, `Tool`, `Writing`, `Approval`, `Question`, `Done`, `Idle`, `Error`, `Offline`…), cronômetro e um tile-hub com o resumo de tudo.

![Agent Deck no modo demo](docs/screenshot.png)

Funciona com **Claude Code**, **OpenAI Codex CLI**, **Gemini CLI**, **Google Antigravity CLI (`agy`)**, qualquer agente rodando dentro do **herdr**, e qualquer programa que fale o [Adapter Protocol do Orbtile](https://github.com/Orbtile/orbtile-adapters) (Aider, scripts de deploy, jobs noturnos…).

Zero dependências: só Node 18+ no computador onde os agentes rodam, e um navegador no Steam Deck.

---

## Como funciona

```
 ┌──────────────┐  hooks (JSON por evento)   ┌──────────────────┐   SSE / HTTP   ┌─────────────────┐
 │ Claude Code  │ ─────────────────────────▶ │                  │ ─────────────▶ │  Steam Deck      │
 │ Codex CLI    │ ─────────────────────────▶ │  agent-deck      │                │  (Chromium kiosk │
 │ Gemini CLI   │ ─────────────────────────▶ │  serve           │ ◀───────────── │   em Gaming Mode)│
 │ Antigravity  │ ─────────────────────────▶ │  :7777           │  allow / deny  └─────────────────┘
 └──────────────┘                            │                  │  focus / read
 ┌──────────────┐  socket ~/.config/herdr    │                  │
 │ herdr        │ ◀────────────────────────▶ │                  │
 └──────────────┘                            │                  │
 ┌──────────────┐  /a/v1 (Orbtile Adapter)   │                  │
 │ adapters     │ ─────────────────────────▶ └──────────────────┘
 └──────────────┘
```

1. **`agent-deck serve`** roda no computador de desenvolvimento. Recebe os eventos dos hooks, mantém o estado de cada sessão e serve a interface.
2. **`agent-deck install all`** escreve os hooks nos arquivos de configuração de cada CLI (com backup). Cada evento (`SessionStart`, `PreToolUse`, `PermissionRequest`, `Stop`…) vira uma transição de estado no painel.
3. O **Steam Deck** abre a URL do servidor em um Chromium em modo kiosk, adicionado como "jogo não-Steam" para aparecer no Gaming Mode. Touch, D-pad, analógico e botões A/B/X/Y funcionam.
4. Quando um agente pede permissão, o tile vira **Approval**, pulsa na cor de alarme do agente e você pode **aprovar segurando A** ou **negar com B** direto do Deck.

## Estados (iguais aos do keypad)

| Estado no tile | `activity` | O que dispara |
| --- | --- | --- |
| **Starting** | `starting` | sessão abriu (`SessionStart`) |
| **Thinking** | `thinking` | prompt enviado, modelo pensando, entre ferramentas |
| **Tool** | `tool` | ferramenta rodando; mostra `Bash  npm test`, `Read  index.ts`… |
| **Writing** | `streaming` | texto do assistente chegando (Claude `MessageDisplay`), com efeito de digitação |
| **Approval** | `waitingPermission` | agente pediu permissão (`PermissionRequest`, `ToolPermission`, `permission_prompt`) |
| **Question** | `waitingQuestion` | `AskUserQuestion` / `request_user_input` / `agent_needs_input` |
| **Compacting** | `compacting` | compactação de contexto; volta ao estado anterior depois |
| **Done** | `done` | turno terminou (`Stop`, `AfterAgent`); mostra a última linha da resposta |
| **Error** | `error` | `StopFailure`, erro de API, `terminationReason: error` |
| **Idle** | `idle` | aberta esperando prompt (`idle_prompt`, `Interrupt`, ou 90 s depois de `Done`) |
| **Offline** | `offline` | adapter parou de dar heartbeat ou TTL expirou |

Cores: cada agente tem uma cor de trabalho e uma cor de alarme (Claude âmbar / terracota, Codex azul / magenta, Antigravity verde / rosa, Gemini violeta / rosa, Grok branco / laranja). Erro é vermelho em todos. Tudo configurável em `~/.agent-deck/config.json`.

Ordem dos tiles: **esperando você → trabalhando → terminou há menos de 15 s → done → idle → offline**. A ordem é recalculada a cada 8 s e congela por 1,5 s depois de qualquer toque, para o tile não fugir do dedo. O 9º tile é sempre o **hub**: quantos trabalhando, quantos esperando (e qual), quantos done, contagem por agente e 8 "pips" com a cor de cada tile da página.

## Instalação rápida (computador de desenvolvimento)

```bash
cd apps/agent-deck
node bin/agent-deck.mjs serve          # ou: bun run start
```

Em outro terminal:

```bash
node bin/agent-deck.mjs install all    # claude codex gemini antigravity
node bin/agent-deck.mjs doctor         # confere hooks, socket do herdr e servidor
```

`serve` imprime as URLs para abrir no Deck, já com o token:

```
agent-deck listening on 0.0.0.0:7777
Open on the Steam Deck (or any browser):
  http://127.0.0.1:7777/#k=5A_NtDR0MZrG...
  http://192.168.1.20:7777/#k=5A_NtDR0MZrG...
```

Quer ver o painel antes de configurar qualquer agente? `node bin/agent-deck.mjs demo` sobe sessões falsas passando por todos os estados.

Para deixar o servidor sempre ligado: `steamdeck/agent-deck.service` (systemd user, Linux) ou `steamdeck/agent-deck-server.bat` (Windows, coloque em `shell:startup`).

### Windows / WSL

O servidor roda tanto no Windows nativo quanto no WSL. Os hooks precisam estar no mesmo lado em que o agente roda: se o Claude Code roda no WSL, execute `install` no WSL. Se o servidor estiver no Windows e o agente no WSL (ou vice-versa), aponte o hook para o outro lado com `AGENT_DECK_SERVER=<ip>` e `AGENT_DECK_TOKEN=<token>` no ambiente do agente (o endpoint de hooks aceita loopback sem token; de outro IP exige o token).

## Instalação no Steam Deck

1. No Deck, troque para **Desktop Mode** e abra o Konsole.
2. Copie `steamdeck/` para o Deck (ou use `curl` apontando para o raw do repositório) e rode:

   ```bash
   bash install-on-deck.sh "http://192.168.1.20:7777/#k=SEU_TOKEN"
   ```

   O script instala o Chromium (flatpak) se preciso, cria `~/.local/share/agent-deck/agent-deck.sh` (kiosk 1280×800) e uma entrada de desktop.
3. Ainda no Desktop Mode: **Steam → Games → Add a Non-Steam Game to My Library** → Browse → selecione `~/.local/share/agent-deck/agent-deck.sh` ("All files"). Renomeie para *Agent Deck* e, se quiser, coloque a arte `steamdeck/icon.svg`.
4. **Properties → Controller**: escolha o template **Gamepad** (o painel lê o controle pela Gamepad API) ou **Keyboard (WASD) and Mouse** (o painel também entende WASD/setas/Enter/Esc). Os dois funcionam.
5. Volte ao **Gaming Mode** e abra *Agent Deck* na aba Non-Steam. Deixe o Deck no suporte ao lado do monitor.

Dica: no Gaming Mode, segure o botão **Steam** → *Performance* → limite de FPS 30 e brilho mais baixo para o Deck ficar horas ligado sem esquentar.

### Controles

| Deck | Teclado | Ação |
| --- | --- | --- |
| D-pad / analógico | setas, WASD, Tab | mover seleção entre os 9 tiles |
| **A** | Enter / Espaço | abrir o tile em modo foco; no hub, pula para a primeira sessão esperando |
| **segurar A** (0,6 s) | segurar Enter | **Allow** em uma aprovação / **Send** em uma pergunta |
| **B** | Esc / Backspace | voltar; em uma aprovação, **Deny** |
| **X** | X | marcar como lido |
| **Y** | Y / F | trazer a janela do agente para frente (herdr / adapters) |
| **LB / RB** | Q / E, PageUp / PageDown | página anterior / próxima (8 sessões por página) |
| Start | ⚙ | configurações (som, sessões offline, modo "zen", token) |
| toque | clique | selecionar e abrir |

## Aprovar do Deck: como funciona por agente

| Agente | Mostrar estado | Allow / Deny do Deck | Como |
| --- | --- | --- | --- |
| Claude Code | ✔ | ✔ | o hook `PermissionRequest` fica aberto até `approvalHoldSeconds` (20 s) **somente enquanto um Deck está conectado**; se você responder no Deck, o hook devolve a decisão; se não, o prompt normal do terminal aparece. "Answer in terminal" libera na hora. |
| Codex CLI | ✔ | ✔ | mesmo mecanismo, via `~/.codex/hooks.json`. Codex exige que você revise e confie nos hooks (`/hooks` dentro do codex). |
| Gemini CLI | ✔ | — | `Notification: ToolPermission` é só observabilidade; responda no terminal (ou rode dentro do herdr). |
| Antigravity CLI | ✔ | — | hooks em `~/.gemini/config/hooks.json`; o hook `PreToolUse` responde `{"decision":"allow"}` (delega para a política padrão do agy). Responda no terminal ou rode dentro do herdr. |
| herdr (qualquer agente) | ✔ | ✔ | status vem do socket do herdr; Allow/Deny mandam teclas (`enter` / `esc`, configurável em `herdr.keys`) para o painel via `herdr agent send-keys`. Perguntas numéricas: digita o número + Enter. |
| Adapters (Orbtile) | ✔ | ✔ | decisões entram na fila `POST /a/v1/adapters/{id}/events` (protocolo v1.1). |

A decisão do Deck nunca é executada por conta própria: ela só é entregue ao hook que está aguardando ou enviada como tecla ao terminal. O diálogo do próprio agente continua sendo a autoridade.

## Configuração

`~/.agent-deck/config.json` (criado no primeiro `serve`):

```json
{
  "port": 7777,
  "host": "0.0.0.0",
  "token": "…",
  "requireToken": true,
  "approvalHoldSeconds": 20,
  "doneToIdleSeconds": 90,
  "idleKeepMinutes": 120,
  "offlineKeepSeconds": 600,
  "herdr": { "enabled": true, "socketPath": null, "hideAgents": "auto", "keys": { "allow": ["enter"], "deny": ["esc"] } },
  "agents": {
    "claude": { "name": "Claude", "color": "#F3B257", "alarm": "#E2714B" },
    "codex": { "color": "#5B8DFF" }
  },
  "installed": ["claude", "codex"]
}
```

- `herdr.hideAgents: "auto"` esconde no herdr os agentes que já têm hook instalado (evita tile duplicado). Use `"none"` para mostrar tudo ou uma lista `["claude"]`.
- `requireToken: false` (ou `serve --no-token`) dispensa o token em redes confiáveis.
- Variáveis de ambiente: `AGENT_DECK_HOME`, `AGENT_DECK_PORT`, `AGENT_DECK_HOST`, `AGENT_DECK_TOKEN`, `AGENT_DECK_SERVER` (host para o hook), `AGENT_DECK_HOST_ALIAS` (nome da máquina quando a sessão é remota, aparece com 🌐).

Hooks por projeto em vez de globais: `agent-deck install claude --project ./meu-repo` (escreve em `.claude/settings.json`, `.codex/hooks.json`, `.gemini/settings.json` ou `.agents/hooks.json`). `agent-deck uninstall …` remove só as entradas do Agent Deck e deixa um `.agent-deck-bak`.

## O que o instalador escreve

| Agente | Arquivo | Eventos |
| --- | --- | --- |
| Claude Code | `~/.claude/settings.json` → `hooks` | `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `Notification`, `MessageDisplay` (hook `http`, sem spawn por chunk), `SubagentStart/Stop`, `Stop`, `StopFailure`, `PreCompact`, `PostCompact`, `SessionEnd`. Os eventos só de observação usam `async: true`. |
| Codex CLI | `~/.codex/hooks.json` | `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `SubagentStart/Stop`, `Stop`, `Interrupt`, `SessionEnd` |
| Gemini CLI | `~/.gemini/settings.json` → `hooks` (+ `tools.enableHooks`) | `SessionStart`, `SessionEnd`, `BeforeAgent`, `AfterAgent`, `BeforeTool`, `AfterTool`, `Notification`, `PreCompress` |
| Antigravity CLI | `~/.gemini/config/hooks.json` → `"agent-deck"` | `SessionStart`, `PreInvocation`, `PostInvocation`, `PreToolUse`, `PostToolUse`, `Stop` (o nome do evento vai como argumento, porque o agy não o inclui no JSON) |

Todos chamam `hooks/agent-deck-hook.mjs <agente> [evento]`, que lê o JSON do stdin, faz um `POST http://127.0.0.1:7777/api/v1/hook/<agente>` e devolve a resposta. Se o servidor estiver desligado o hook responde a saída neutra e sai com 0; o agente nunca trava por causa do painel.

## API

Tudo abaixo exige o token (`?k=`, `Authorization: Bearer` ou `X-Agent-Deck-Token`), exceto `/api/v1/hook/*` vindo de loopback.

| Método | Rota | Para quê |
| --- | --- | --- |
| `GET` | `/api/v1/state` | snapshot (sessões ordenadas, resumo, paleta) |
| `GET` | `/api/v1/events` | Server-Sent Events com o mesmo snapshot a cada mudança |
| `POST` | `/api/v1/hook/:agent?event=` | entrada dos hooks |
| `POST` | `/api/v1/sessions/:uid/actions` | `{"action":"allow"|"deny"|"dismiss"|"answer"|"focus"|"read"|"remove"}` |
| `POST` | `/api/v1/sessions` | API simples: `{"agent":"custom","id":"job-1","title":"Deploy","activity":"tool","toolLabel":"Deploy  web"}` |
| `*` | `/a/v1/…` | Adapter Protocol v1.1 compatível com Orbtile (`PUT /adapters/{id}`, `POST /adapters/{id}/sessions/{sid}`, `heartbeat`, `events`, `GET /info` com prova HMAC) |

O arquivo de descoberta `~/.agent-deck/adapter-api.json` tem `url`, `socketPath` (Linux/macOS), `basePath` e `token`. Os adapters de referência do Orbtile (`ref.py`, `ref.mjs`, `ref-shell.sh`) rodam sem alteração com `ORBTILE_API_FILE=~/.agent-deck/adapter-api.json`.

Exemplo em shell de um job qualquer aparecendo no Deck:

```bash
T=$(node bin/agent-deck.mjs token)
curl -s -X POST localhost:7777/api/v1/sessions -H "X-Agent-Deck-Token: $T" -H 'Content-Type: application/json' \
  -d '{"agent":"custom","id":"deploy-prod","title":"Deploy to prod","activity":"tool","toolLabel":"Deploy  web"}'
# … no fim:
curl -s -X POST localhost:7777/api/v1/sessions -H "X-Agent-Deck-Token: $T" -H 'Content-Type: application/json' \
  -d '{"agent":"custom","id":"deploy-prod","activity":"done"}'
```

## Comandos

```
agent-deck serve [--port N] [--host A] [--no-token] [--no-herdr] [--demo]
agent-deck demo
agent-deck install <claude|codex|gemini|antigravity|all> [--project DIR] [--no-live-text]
agent-deck uninstall <…>
agent-deck status
agent-deck token [--rotate]
agent-deck url
agent-deck doctor
```

## Desenvolvimento

```bash
bun run test          # node --test (store, mappers, fluxo de aprovação)
bun run demo          # servidor com sessões falsas
bun run screenshot    # docs/screenshot.png e docs/focus.png via Playwright (PLAYWRIGHT_DIR opcional)
```

Estrutura:

```
bin/agent-deck.mjs        CLI
src/server.mjs            HTTP + SSE + hooks + Adapter API
src/store.mjs             estado das sessões, tiers, ações, decisões pendentes
src/mappers/*.mjs         evento de cada CLI → estado do tile
src/herdr.mjs             cliente do socket do herdr + ações via CLI
src/install.mjs           instaladores (backup + merge idempotente)
hooks/agent-deck-hook.mjs script universal chamado pelos agentes
web/                      interface (HTML/CSS/JS puro, sem build)
steamdeck/                instalador kiosk, ícone, service/bat do servidor
```

## Diferenças em relação ao Orbtile / MX Keypad

- Tela do Deck (1280×800) em vez de 9 LCDs de 1,5": os tiles têm a mesma hierarquia (título, estado + tempo, detalhe, orbe, selo do agente) e o hub na 9ª posição, mas há espaço para um modo foco com o texto completo e botões.
- Hold-to-allow de 0,6 s e "Deny" num botão só, como no keypad (tecla 9 / tecla 7).
- Sem dependência de app desktop nem de conta: Node + navegador.
- O Orbtile lê o banco do Codex e a UI do Antigravity sem hooks; aqui tudo passa por hooks ou pelo herdr. Sessões abertas antes do `serve` só aparecem no próximo evento.

## Créditos e referências

- [Orbtile](https://orbtile.com) e o [Adapter Protocol](https://github.com/Orbtile/orbtile-adapters) (MIT), que inspiraram os estados, a ordenação e a API compatível.
- [Logitech MX Keypad](https://www.logitech.com/en-us/shop/p/mx-keypad) / MX Creative Keypad.
- Hooks: [Claude Code](https://code.claude.com/docs/en/hooks), [Codex CLI](https://developers.openai.com/codex/hooks), [Gemini CLI](https://geminicli.com/docs/hooks/), [Antigravity CLI](https://antigravity.google/docs/hooks), [herdr](https://herdr.dev/tui/docs/socket-api/).
- Projetos relacionados para Claude Code que valem uma olhada: [eyes-on-claude-code](https://github.com/joe-re/eyes-on-claude-code), [claude-code-monitor](https://github.com/bruceyxli/claude-code-monitor), [keyvo](https://github.com/qubernetic/keyvo) (MX Creative Keypad no Linux).
