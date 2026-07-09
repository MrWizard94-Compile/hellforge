# HellForge

A studio-grade terminal, forged in hell. HellForge wraps real PTYs (PowerShell, cmd, WSL, Git Bash) and Claude Code in a frameless Electron shell with a cinematic Diablo-flavored skin — cracked-obsidian lava walls, a demonic crest, a rune sidebar, and a live pressure gauge — built for one relentless neurodivergent operator running a 30-project studio.

Part of **WPAI** (Wizard Productions AI Studio). Human-directed, AI-assisted, fully disclosed.

## Features

- **Real terminals** — pwsh / PowerShell / cmd / WSL / Git Bash on a genuine ConPTY, plus a one-click **Summon Claude** that drops Claude Code into a pane.
- **Command palette** (`Ctrl+P`) — fuzzy-search every project, cast command "spells", or run actions. Opens a forge already `cd`'d into any project.
- **Split panes** — 1 / 2 / 4 live terminals in a grid (`Alt+1/2/4`, `Ctrl+D` to split), with **broadcast input**: type once, run in every visible pane.
- **Living forge** — the HELLFIRE PRESSURE gauge reads real CPU load; a synthesized metal _clang_ and tab flash fire when a long command finishes in a pane you're not watching ("sacrifice complete"). Optional forge-rumble ambient.
- **Settings** — shell picker, font size, glass opacity, sound toggles (persisted). In-terminal search (`Ctrl+F`), font zoom (`Ctrl+±/0`), window-position memory.

## Run

```bash
npm install
npm start
```

Requires Node + a Chromium-capable Electron platform. The lava wall, iron frame, and demon crest are generated from the `renderer/*.html` source files rendered to PNG (via headless Chromium); the committed PNGs are the shipped assets.

## Layout

- `main.js` — Electron main: window, PTY management, system-load sampling, window-state persistence.
- `preload.js` — context-isolated IPC bridge.
- `renderer/` — the UI: `index.html`, `app.js`, `style.css`, embedded `fonts.css` (Cinzel), generated art (`hellscape.png`, `frame.png`, `crest.png`), and the `*.html` art generators.

## Keyboard

| Shortcut               | Action             |
| ---------------------- | ------------------ |
| `Ctrl+P`               | Command palette    |
| `Ctrl+T` / `Ctrl+W`    | New / close forge  |
| `Ctrl+D` · `Alt+1/2/4` | Split · set layout |
| `Ctrl+F`               | Search in terminal |
| `Ctrl+±` / `Ctrl+0`    | Font zoom / reset  |

## Development

Pure, DOM-free logic lives in `renderer/core.js` (fuzzy search, pane visibility, layout math, shell-arg building) so it's unit-testable in Node; `app.js` is the DOM/PTY glue that calls into it.

```bash
npm test          # node:test suite over core.js
npm run lint      # eslint (zero warnings expected)
npm run format    # prettier --write
```

Note: `renderer/app.js` is loaded as a classic `<script>`, so every top-level `const`/`let` shares one lexical scope — anything used by later top-level code must be declared above its first use (`$` is defined first) or it hits the temporal dead zone and the script silently aborts. The background art generators (`renderer/*.html`) render to PNG via headless Chromium; their `<script>` must sit outside the `<svg>` (SVG-embedded scripts don't execute there).

---

_AI is in the name; the wizard is in the work._
