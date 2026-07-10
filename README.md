# HellForge

A studio-grade terminal, forged in hell. HellForge wraps real PTYs (PowerShell, cmd, WSL, Git Bash) and AI agents (Claude Code, Grok Build, Ollama) in a frameless Electron shell with a cinematic Diablo-flavored skin — cracked-obsidian lava walls, a demonic crest, a rune sidebar, and a live pressure gauge — built for one relentless neurodivergent operator running a multi-project studio.

Part of **WPAI** (Wizard Productions AI Studio). Human-directed, AI-assisted, fully disclosed.

## Features

- **Real terminals** — pwsh / PowerShell / cmd / WSL / Git Bash on a genuine ConPTY, plus one-click **Summon Claude / Grok / Ollama**.
- **Command palette** (`Ctrl+P`) — fuzzy-search every project, cast command "spells", pin favorites, or run actions. Opens a forge already `cd`'d into any project.
- **Pinned forges** — star projects in the palette or deck; pins live in the sidebar for one-click launch.
- **Split panes** — 1 / 2 / 4 live terminals (`Alt+1/2/4`, `Ctrl+D` to split), drag splitters, **broadcast input** to every visible pane.
- **Role-colored tabs** — Claude / Grok / Ollama / shell accent colors; **drag tabs** to reorder panes.
- **Living forge** — HELLFIRE PRESSURE gauge reads real CPU load; metal _clang_ + tab flash when a long command finishes unwatched ("sacrifice complete"). Optional forge-rumble ambient.
- **Command Deck** (`Ctrl+\``) — vitals, active forges, summon tiles, **Git Pulse** across repos.
- **The Council** (`Alt+C`) — multi-agent bus (Director → Orchestrator → Executor + Local), PTY dispatch, `hf-say` replies, optional API agents (Grok/Claude keys in main process only). Bus **search** + **markdown export**.
- **Forge Journal** (`Ctrl+Shift+J`) — save active or all pane scrollbacks to `Workspace\.hellforge\journals\`.
- **Tray + window prefs** — system tray (show/hide/always-on-top/quit), settings for **always on top** and **minimize to tray**.
- **Settings** — shell, font, glass opacity, sound, Ollama launcher, API key file / models. In-terminal search (`Ctrl+F`), font zoom (`Ctrl+±/0`), session restore, window-position memory.

## Run

```bash
npm install
npm start
```

Requires Node + a Chromium-capable Electron platform. The lava wall, iron frame, and demon crest are generated from the `renderer/*.html` source files rendered to PNG (via headless Chromium); the committed PNGs are the shipped assets.

## Layout

- `main.js` — Electron main: window, PTY, tray, system load, git status, council bus, journal/export writes, API agents (keys never leave main).
- `preload.js` — context-isolated IPC bridge.
- `renderer/` — UI glue (`app.js`), pure logic (`core.js`, `council.js`, `api.js`), chrome, and generated art.
- `test/` — `node:test` suites over pure modules.

Journals and bus exports land under `C:\WPAI\Workspace\.hellforge\` (`journals\`, `exports\`, `bus.jsonl`).

## Keyboard

| Shortcut                 | Action                          |
| ------------------------ | ------------------------------- |
| `Ctrl+P`                 | Command palette                 |
| `Ctrl+\``                | Command Deck                    |
| `Alt+C`                  | The Council                     |
| `Ctrl+Shift+J`           | Save journal (active forge)     |
| `F1`                     | Keybindings help                |
| `Ctrl+T` / `Ctrl+W`      | New / close forge               |
| `Ctrl+D` · `Alt+1/2/4`   | Split · set layout              |
| `Ctrl+F`                 | Search in terminal              |
| `Ctrl+±` / `Ctrl+0`      | Font zoom / reset               |
| Double-click tab         | Rename forge                    |
| Drag tab                 | Reorder panes                   |

## Development

Pure, DOM-free logic lives in `renderer/core.js`, `council.js`, and `api.js` so it is unit-testable in Node; `app.js` is the DOM/PTY glue.

```bash
npm test          # all test/*.test.js suites
npm run lint      # eslint (zero warnings expected)
npm run format    # prettier --write
```

Note: `renderer/app.js` is loaded as a classic `<script>`, so every top-level `const`/`let` shares one lexical scope — anything used by later top-level code must be declared above its first use (`$` is defined first) or it hits the temporal dead zone and the script silently aborts. The background art generators (`renderer/*.html`) render to PNG via headless Chromium; their `<script>` must sit outside the `<svg>` (SVG-embedded scripts don't execute there).

---

_AI is in the name; the wizard is in the work._
