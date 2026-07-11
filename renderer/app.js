/* HellForge renderer — DOM + PTY glue over the pure logic in core.js (HFCore).
 *
 * Loaded as a classic <script> (not a module), so ALL top-level `const`/`let`
 * live in one shared lexical scope. Anything used by later top-level code must
 * be DECLARED ABOVE its first use or it hits the temporal dead zone and the
 * whole script silently aborts — hence `$` is defined first, right here. */
const $ = (id) => document.getElementById(id);
const tabsEl = document.getElementById("tabs");
const panesEl = document.getElementById("panes");
const statusRight = document.getElementById("status-right");

const forges = new Map(); // id -> {term, fit, holder, tab, title, search}
const order = []; // forge ids in creation order (pane sequence)
let activeId = null; // focused pane
let forgeCount = 0;
let layout = 1; // 1 | 2 | 4 visible panes
let broadcast = false; // send input to all visible panes

// ---- persisted settings ----
const settings = HFCore.mergeSettings(
  {
    shell: "pwsh.exe",
    fontSize: 14.5,
    /* lower glass = more of the HellForge.png plate shows through the panes */
    glass: 42,
    sound: true,
    alwaysOnTop: false,
    minimizeToTray: false,
    ollamaModel: "qwen2.5-coder:14b",
    ollamaCmd:
      "docker start ollama-engine | Out-Null; docker exec -it ollama-engine ollama run {model}",
    apiKeyFile: "C:\\WPAI\\MyGrokKeys.md",
    xaiModel: "grok-4.5",
    anthropicModel: "claude-sonnet-5",
  },
  localStorage.getItem("hf-settings")
);
function saveSettings() {
  localStorage.setItem("hf-settings", JSON.stringify(settings));
}
function applyGlass() {
  const a = settings.glass / 100;
  document.documentElement.style.setProperty("--glass-top", (0.15 + a * 0.7).toFixed(2));
  document.documentElement.style.setProperty("--glass-bot", (a * 0.12).toFixed(2));
}

// ---- pure helpers (HFCore / HFCouncil with tiny local fallbacks) ----
function coreFn(name, fallback) {
  return typeof HFCore !== "undefined" && typeof HFCore[name] === "function" ? HFCore[name] : fallback;
}
function councilFn(name, fallback) {
  return typeof HFCouncil !== "undefined" && typeof HFCouncil[name] === "function"
    ? HFCouncil[name]
    : fallback;
}

function pinList() {
  try {
    return coreFn("normalizePins", (r) => (Array.isArray(r) ? r.filter(Boolean) : []))(
      localStorage.getItem("hf-pins")
    );
  } catch {
    return [];
  }
}
function savePins(pins) {
  const list = coreFn("normalizePins", (r) => (Array.isArray(r) ? r : []))(pins);
  localStorage.setItem("hf-pins", JSON.stringify(list));
  return list;
}
/** Refresh pin-dependent UI without touching late `let` bindings (TDZ-safe). */
function refreshPinViews() {
  renderSidebarPins();
  const pal = $("palette");
  if (pal && !pal.classList.contains("hidden")) renderPalette();
  const deck = $("deck");
  if (deck && !deck.classList.contains("hidden")) renderDeckTiles();
}
function toggleProjectPin(path) {
  if (!path) return pinList();
  const next = coreFn("togglePin", (p, path) => {
    const i = p.indexOf(String(path));
    if (i >= 0) {
      const c = p.slice();
      c.splice(i, 1);
      return c;
    }
    return p.concat([String(path)]);
  })(pinList(), path);
  savePins(next);
  refreshPinViews();
  return next;
}

function applyWindowPrefs() {
  if (!window.hellforge) return;
  if (typeof window.hellforge.winSetAlwaysOnTop === "function") {
    window.hellforge.winSetAlwaysOnTop(!!settings.alwaysOnTop);
  }
  if (typeof window.hellforge.winSetMinimizeToTray === "function") {
    window.hellforge.winSetMinimizeToTray(!!settings.minimizeToTray);
  }
}

/** Capture the full xterm buffer as plain lines (trailing blanks trimmed). */
function captureTermLines(term) {
  if (!term || !term.buffer || !term.buffer.active) return [];
  const buf = term.buffer.active;
  const lines = [];
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i);
    lines.push(line ? line.translateToString(true) : "");
  }
  while (lines.length && !String(lines[lines.length - 1]).trim()) lines.pop();
  return lines;
}

function buildJournalPayload(f) {
  const now = Date.now();
  const body = captureTermLines(f.term).join("\n");
  const md = coreFn("journalMarkdown", (o) => {
    const s = (v) => (v == null ? "" : String(v));
    return (
      "---\ntitle: " +
      s(o.title) +
      "\nkind: " +
      s(o.kind) +
      "\ncwd: " +
      s(o.cwd) +
      "\nsavedAt: " +
      s(o.savedAt) +
      "\n---\n\n" +
      s(o.body)
    );
  })({
    title: f.title,
    kind: f.kind || "shell",
    cwd: f.cwd || "",
    savedAt: new Date(now).toISOString(),
    body,
  });
  const filename = coreFn("journalFilename", (label, ms) => {
    const d = new Date(Number(ms) || Date.now());
    const p = (n) => (n < 10 ? "0" : "") + n;
    const stamp =
      "" +
      d.getFullYear() +
      p(d.getMonth() + 1) +
      p(d.getDate()) +
      "-" +
      p(d.getHours()) +
      p(d.getMinutes()) +
      p(d.getSeconds());
    let safe = "";
    const raw = String(label == null ? "forge" : label);
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      const c = raw.charCodeAt(i);
      if (c < 32) continue;
      if ('<>:"/\\|?*'.indexOf(ch) !== -1) continue;
      safe += ch;
    }
    safe = safe.trim() || "forge";
    return "journal-" + stamp + "-" + safe + ".md";
  })(f.title, now);
  return { filename, content: md };
}

async function saveJournalForge(f) {
  if (!f || !f.term) return { ok: false, error: "no forge" };
  const { filename, content } = buildJournalPayload(f);
  if (!(window.hellforge && window.hellforge.journal && window.hellforge.journal.save)) {
    return { ok: false, error: "journal bridge offline" };
  }
  try {
    return (await window.hellforge.journal.save({ filename, content })) || {
      ok: false,
      error: "no response",
    };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

async function saveJournalActive() {
  const f = forges.get(activeId);
  if (!f) {
    flashStatus("Journal · no active forge");
    return;
  }
  const res = await saveJournalForge(f);
  if (res && res.ok) flashStatus("Journal saved · " + (res.path || f.title));
  else flashStatus("Journal failed · " + ((res && res.error) || "unknown"));
}

async function saveJournalsAll() {
  if (!order.length) {
    flashStatus("Journal · no forges open");
    return;
  }
  let ok = 0,
    fail = 0,
    lastPath = "";
  for (const id of order) {
    const f = forges.get(id);
    if (!f) continue;
    const res = await saveJournalForge(f);
    if (res && res.ok) {
      ok++;
      lastPath = res.path || lastPath;
    } else fail++;
  }
  if (fail && !ok) flashStatus("Journals failed · " + fail + " error" + (fail === 1 ? "" : "s"));
  else if (fail)
    flashStatus("Journals · " + ok + " saved, " + fail + " failed" + (lastPath ? " · " + lastPath : ""));
  else flashStatus("Journals saved · " + ok + " forge" + (ok === 1 ? "" : "s") + (lastPath ? " · " + lastPath : ""));
}

function renderSidebarPins() {
  const el = $("sidebar-pins");
  if (!el) return;
  const pins = pinList();
  const projects = window.HF_PROJECTS || [];
  el.innerHTML = "";
  for (const path of pins) {
    const p = projects.find((x) => x.path === path);
    const name = p ? p.name : String(path).split(/[/\\]/).filter(Boolean).pop() || path;
    const row = document.createElement("div");
    row.className = "pin-rune";
    row.dataset.path = path;
    row.title = path;
    const star = document.createElement("span");
    star.className = "pin-rune-star";
    star.textContent = "★";
    const label = document.createElement("span");
    label.className = "pin-rune-name";
    label.textContent = name;
    const x = document.createElement("span");
    x.className = "pin-rune-x";
    x.title = "Unpin";
    x.textContent = "×";
    row.append(star, label, x);
    row.addEventListener("click", (e) => {
      if (e.target.classList.contains("pin-rune-x")) {
        e.stopPropagation();
        toggleProjectPin(path);
        return;
      }
      summon("shell", { cwd: path, label: name });
    });
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      toggleProjectPin(path);
    });
    el.appendChild(row);
  }
}

/** Re-append tab nodes in `order` sequence after a drag reorder. */
function reappendTabsInOrder() {
  for (const id of order) {
    const f = forges.get(id);
    if (f && f.tab) tabsEl.appendChild(f.tab);
  }
}

function bindTabDrag(tab, id) {
  tab.draggable = true;
  tab.addEventListener("dragstart", (e) => {
    if (tab.querySelector(".tab-rename") || tab.dataset.renaming === "1") {
      e.preventDefault();
      return;
    }
    e.dataTransfer.setData("text/plain", String(id));
    e.dataTransfer.effectAllowed = "move";
    tab.classList.add("dragging");
    tab._dragId = id;
  });
  tab.addEventListener("dragend", () => {
    tab.classList.remove("dragging");
    for (const t of tabsEl.querySelectorAll(".tab.drag-over")) t.classList.remove("drag-over");
  });
  tab.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    tab.classList.add("drag-over");
  });
  tab.addEventListener("dragleave", () => {
    tab.classList.remove("drag-over");
  });
  tab.addEventListener("drop", (e) => {
    e.preventDefault();
    tab.classList.remove("drag-over");
    const fromId = Number(e.dataTransfer.getData("text/plain"));
    const toId = id;
    if (!Number.isFinite(fromId) || fromId === toId) return;
    const fromIndex = order.indexOf(fromId);
    const toIndex = order.indexOf(toId);
    if (fromIndex < 0 || toIndex < 0) return;
    const next = coreFn("reorderTabs", (arr, fi, ti) => {
      const o = arr.slice();
      const [item] = o.splice(fi, 1);
      o.splice(ti, 0, item);
      return o;
    })(order, fromIndex, toIndex);
    order.length = 0;
    for (const x of next) order.push(x);
    reappendTabsInOrder();
    renderLayout();
  });
}

const THEME = {
  background: "rgba(0,0,0,0)",
  foreground: "#ffb070",
  cursor: "#ff6a1a",
  cursorAccent: "#0a0604",
  selectionBackground: "rgba(255,90,20,0.28)",
  black: "#1a1512",
  red: "#ff5030",
  green: "#a3c76d",
  yellow: "#ffb347",
  blue: "#7f9fd1",
  magenta: "#d1799b",
  cyan: "#6fb3a1",
  white: "#d8cdbb",
  brightBlack: "#5c5044",
  brightRed: "#ff7a5c",
  brightGreen: "#c2e08d",
  brightYellow: "#ffd08a",
  brightBlue: "#a3bde8",
  brightMagenta: "#e8a3bd",
  brightCyan: "#9ad1c2",
  brightWhite: "#f5eee0",
};

// Agent forges: interactive AI CLIs launched inside a pwsh forge, right after
// the themed prompt. Each supplies a tab icon, a title prefix, and the launch
// command. Grok is xAI's "Grok Build" TUI (bare `grok`). Ollama runs through
// the user's configurable launcher (Docker container by default) with {model}
// substituted, so it works whether Ollama is native, in Docker, or remote.
const AGENTS = {
  claude: { prefix: "Claude", icon: "\u{1F702}", launch: () => "claude" },
  grok: { prefix: "Grok", icon: "⚡", launch: () => "grok" },
  ollama: {
    prefix: "Ollama",
    icon: "\u{1F999}",
    model: (o) => o.model || settings.ollamaModel || "llama3.2",
    launch: (o) =>
      (settings.ollamaCmd || "ollama run {model}").replace(
        /\{model\}/g,
        o.model || settings.ollamaModel || "llama3.2"
      ),
  },
};

async function summon(kind, o = {}) {
  forgeCount++;
  const agent = AGENTS[kind] || null;
  const title = o.label || (agent ? `${agent.prefix} ${forgeCount}` : `Forge ${forgeCount}`);

  const holder = document.createElement("div");
  holder.className = "term-holder";
  panesEl.appendChild(holder);

  const term = new Terminal({
    fontFamily: "'Cascadia Code', Consolas, monospace",
    fontSize: settings.fontSize,
    lineHeight: 1.15,
    cursorBlink: true,
    scrollback: 8000,
    theme: THEME,
    allowTransparency: true,
    allowProposedApi: true,
  });
  const fit = new FitAddon.FitAddon();
  const search = new SearchAddon.SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  term.loadAddon(new WebLinksAddon.WebLinksAddon());
  term.open(holder);
  fit.fit();

  // Role-aware prompt. `hf-say <msg>` lets an agent post to the shared Council
  // bus straight from its terminal (ConvertTo-Json escapes the body safely).
  const role = HFCouncil.roleFor(kind);
  const promptCmd =
    'function prompt { "`e[38;2;255;122;38m[HELLFORGE]`e[0m ' +
    '`e[38;2;170;130;90m$(Get-Location)`e[0m `e[38;2;232;69;28m>`e[0m " }; ' +
    '$global:HF_ROLE = "' +
    role +
    '"; function hf-say { param([Parameter(Mandatory=$true)][string]$Message, [string]$To = "all") ' +
    '$d = "C:\\WPAI\\Workspace\\.hellforge"; New-Item -ItemType Directory -Force -Path $d | Out-Null; ' +
    "$o = [ordered]@{ ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); from = $global:HF_ROLE; to = $To; text = $Message }; " +
    'Add-Content -Path "$d\\bus.jsonl" -Value ($o | ConvertTo-Json -Compress) }; ' +
    "Write-Host '  the forge is lit. speak, and it shapes.  (hf-say <msg> posts to the Council)' -ForegroundColor DarkYellow";
  const shell = agent ? "pwsh.exe" : o.shell || settings.shell || "pwsh.exe";
  const launch = agent ? agent.launch(o) : null;
  const { args, deferredRun } = HFCore.buildShellArgs(shell, { launch, run: o.run, promptCmd });
  const opts = {
    cols: term.cols,
    rows: term.rows,
    cwd: o.cwd || "C:\\WPAI",
    shell,
    args,
  };
  const id = await window.hellforge.createPty(opts);
  // shells that can't take an inline run-command (WSL/Git Bash) get it typed
  // into the PTY once the shell has had a moment to come up.
  if (deferredRun) setTimeout(() => window.hellforge.write(id, deferredRun + "\r"), 700);

  const tab = document.createElement("div");
  const roleClass = coreFn("roleTabClass", (k) => {
    const kk = String(k == null ? "" : k).toLowerCase();
    if (kk === "claude") return "role-orchestrator";
    if (kk === "grok") return "role-executor";
    if (kk === "ollama") return "role-local";
    return "role-shell";
  })(kind);
  tab.className = "tab " + roleClass;
  tab.innerHTML = `<span class="flame">${agent ? agent.icon : "⚒"}</span><span class="t">${title}</span><span class="x" title="Extinguish">×</span>`;
  tab.addEventListener("click", (e) => {
    if (e.target.classList.contains("x")) extinguish(id);
    else activate(id);
  });
  tab.addEventListener("auxclick", (e) => {
    if (e.button === 1) extinguish(id);
  });
  tab.addEventListener("dblclick", (e) => {
    if (!e.target.classList.contains("x")) renameTab(id);
  });
  bindTabDrag(tab, id);
  tabsEl.appendChild(tab);

  holder.addEventListener("mousedown", () => focusPane(id));
  term.onData((data) => {
    for (const pid of HFCore.broadcastTargets(broadcast, id, visibleIds())) {
      window.hellforge.write(pid, data);
    }
  });
  term.onResize(({ cols, rows }) => window.hellforge.resize(id, cols, rows));

  forges.set(id, {
    term,
    fit,
    holder,
    tab,
    title,
    search,
    kind,
    model: agent && agent.model ? agent.model(o) : undefined,
    cwd: o.cwd || "C:\\WPAI",
  });
  order.push(id);
  activeId = id;
  renderLayout();
  f_focus(id);
  return id;
}

// which pane ids are currently shown, given layout + focus (see core.js)
function visibleIds() {
  return HFCore.visibleIds(order, activeId, layout);
}

// lay out and show the visible panes; hide the rest
function renderLayout() {
  const vis = visibleIds();
  panesEl.className = HFCore.layoutClass(vis.length);
  applySplits();
  for (const [fid, f] of forges) {
    const on = vis.includes(fid);
    f.holder.classList.toggle("shown", on);
    f.holder.classList.toggle("focused", on && fid === activeId);
    f.tab.classList.toggle("active", fid === activeId);
    f.tab.classList.toggle("visible", on);
  }
  requestAnimationFrame(() => {
    for (const fid of vis) {
      const f = forges.get(fid);
      if (f) f.fit.fit();
    }
  });
  updateStatus();
  if (councilOpen) renderCouncilTargets();
}

function f_focus(id) {
  const f = forges.get(id);
  if (f) {
    f.fit.fit();
    f.term.focus();
  }
}

// focus a pane (used by tab click and pane click)
function focusPane(id) {
  if (!forges.has(id)) return;
  activeId = id;
  const f = forges.get(id);
  if (f) f.tab.classList.remove("done");
  renderLayout();
  f_focus(id);
}
const activate = focusPane; // back-compat alias

// double-click a tab to rename its forge (disables drag while editing)
function renameTab(id) {
  const f = forges.get(id);
  if (!f) return;
  const span = f.tab.querySelector(".t");
  if (!span) return;
  f.tab.draggable = false;
  f.tab.dataset.renaming = "1";
  const input = document.createElement("input");
  input.className = "tab-rename";
  input.value = f.title;
  span.replaceWith(input);
  input.focus();
  input.select();
  const commit = () => {
    const v = input.value.trim() || f.title;
    f.title = v;
    const s = document.createElement("span");
    s.className = "t";
    s.textContent = v;
    input.replaceWith(s);
    f.tab.draggable = true;
    delete f.tab.dataset.renaming;
    if (activeId === id) updateStatus();
  };
  input.addEventListener("keydown", (ev) => {
    ev.stopPropagation();
    if (ev.key === "Enter") input.blur();
    else if (ev.key === "Escape") {
      input.value = f.title;
      input.blur();
    }
  });
  input.addEventListener("blur", commit, { once: true });
}

function setLayout(n) {
  layout = n;
  for (const b of document.querySelectorAll(".lay")) b.classList.remove("active");
  const btn = document.getElementById("lay-" + n);
  if (btn) btn.classList.add("active");
  renderLayout();
  if (activeId != null) f_focus(activeId);
}

// ---- draggable pane splitters ----
let colFrac = 0.5,
  rowFrac = 0.5;
const clampFrac = (v) => Math.max(0.15, Math.min(0.85, v));
function applySplits() {
  const cls = panesEl.className;
  if (cls.indexOf("l4") !== -1) {
    panesEl.style.gridTemplateColumns = `${colFrac}fr ${1 - colFrac}fr`;
    panesEl.style.gridTemplateRows = `${rowFrac}fr ${1 - rowFrac}fr`;
  } else if (cls.indexOf("l2") !== -1) {
    panesEl.style.gridTemplateColumns = `${colFrac}fr ${1 - colFrac}fr`;
    panesEl.style.gridTemplateRows = "1fr";
  } else {
    panesEl.style.gridTemplateColumns = "";
    panesEl.style.gridTemplateRows = "";
  }
  $("split-v").style.left = colFrac * 100 + "%";
  $("split-h").style.top = rowFrac * 100 + "%";
}
function fitVisible() {
  for (const fid of visibleIds()) {
    const f = forges.get(fid);
    if (f) f.fit.fit();
  }
}
function makeDraggable(handle, axis) {
  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    handle.classList.add("dragging");
    const rect = panesEl.getBoundingClientRect();
    let raf = null;
    const move = (ev) => {
      if (axis === "x") colFrac = clampFrac((ev.clientX - rect.left) / rect.width);
      else rowFrac = clampFrac((ev.clientY - rect.top) / rect.height);
      applySplits();
      if (!raf)
        raf = requestAnimationFrame(() => {
          raf = null;
          fitVisible();
        });
    };
    const up = () => {
      handle.classList.remove("dragging");
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      fitVisible();
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });
}
makeDraggable($("split-v"), "x");
makeDraggable($("split-h"), "y");

// ============ Command Deck (dashboard) ============
let deckOpen = false;
let lastStats = {};
const deckEl = $("deck");

function renderDeckVitals() {
  const s = lastStats;
  const bar = (label, pct, detail) => {
    pct = pct || 0;
    return `<div class="vital">
      <div class="vital-top"><span>${label}</span><span class="vital-pct">${pct}%</span></div>
      <div class="vital-bar"><div class="vital-fill${pct > 85 ? " hot" : ""}" style="width:${pct}%"></div></div>
      <div class="vital-detail">${detail || ""}</div>
    </div>`;
  };
  const el = $("deck-vitals");
  if (!el) return;
  el.innerHTML =
    bar("CPU Load", s.cpu, s.cores ? `${s.cores} cores` : "") +
    bar("Memory", s.mem, s.memUsedGB != null ? `${s.memUsedGB} / ${s.memTotalGB} GB` : "") +
    bar("Disk (C:)", s.diskPct, s.diskFreeGB != null ? `${s.diskFreeGB} GB free` : "") +
    `<div class="deck-stats">
       <span class="deck-stat">FORGE LIT <b>${HFCore.fmtUptime(s.uptime)}</b></span>
       <span class="deck-stat">FIRES <b>${forges.size}</b></span>
     </div>
     <div class="deck-stats" id="deck-wpai">WPAI · loading…</div>`;
  // Phase-1 WPAI control-plane strip (approvals / kill / budget / overnight)
  if (window.hellforge && window.hellforge.wpai && window.hellforge.wpai.snapshot) {
    window.hellforge.wpai.snapshot().then((snap) => {
      const slot = $("deck-wpai");
      if (!slot) return;
      if (!snap || !snap.ok) {
        slot.innerHTML =
          '<span class="deck-stat">WPAI <b>offline</b></span>' +
          (snap && snap.error
            ? `<span class="deck-stat">${String(snap.error).slice(0, 80)}</span>`
            : "");
        return;
      }
      const k = snap.kill || {};
      const b = snap.budgets || {};
      const o = snap.overnight || {};
      const m = snap.music || {};
      const killOn = !!(k.global || k.loops || k.research || k.publishes);
      slot.innerHTML =
        `<span class="deck-stat">APPROVALS <b>${snap.pending || 0}</b></span>` +
        `<span class="deck-stat">KILL <b>${killOn ? "ON" : "off"}</b></span>` +
        `<span class="deck-stat">$DAY <b>${b.api_usd_spent_est_day || 0}/${b.api_usd_cap_day || 5}</b></span>` +
        `<span class="deck-stat">NIGHT <b>${o.armed ? "ARMED" : "idle"}</b></span>` +
        `<span class="deck-stat">MUSIC <b>${m.checklist_pass ? "READY" : "…"}</b></span>`;
    });
  }
}

function renderDeckForges() {
  const el = $("deck-forges");
  if (!el) return;
  if (!order.length) {
    el.innerHTML = `<div class="roster-empty">No fires lit. Summon one &rarr;</div>`;
    return;
  }
  el.innerHTML = order
    .map((id) => {
      const f = forges.get(id);
      if (!f) return "";
      const ic = (AGENTS[f.kind] && AGENTS[f.kind].icon) || "⚒";
      return `<div class="roster-item" data-id="${id}">
        <span class="roster-flame">${ic}</span>
        <span class="roster-name">${f.title}</span>
        <span class="roster-live"></span>
      </div>`;
    })
    .join("");
  el.querySelectorAll(".roster-item").forEach((it) => {
    it.addEventListener("click", () => {
      focusPane(+it.dataset.id);
      closeDeck();
    });
  });
}

function renderDeckTiles() {
  const el = $("deck-tiles");
  if (!el) return;
  const pins = pinList();
  const pinSet = new Set(pins);
  // Pins first, then remaining projects (cap 10 total project tiles)
  const all = window.HF_PROJECTS || [];
  const pinned = [];
  const rest = [];
  for (const p of all) {
    if (p && p.path && pinSet.has(p.path)) pinned.push(p);
    else if (p) rest.push(p);
  }
  const projects = pinned.concat(rest).slice(0, 10);
  const tiles = [
    `<div class="tile summon" data-act="forge"><div class="tile-name">⚒ New Forge</div><div class="tile-div">powershell</div></div>`,
    `<div class="tile summon" data-act="claude"><div class="tile-name">\u{1F702} Summon Claude</div><div class="tile-div">claude code</div></div>`,
    `<div class="tile summon" data-act="grok"><div class="tile-name">⚡ Summon Grok</div><div class="tile-div">grok build</div></div>`,
    `<div class="tile summon" data-act="ollama"><div class="tile-name">\u{1F999} Summon Ollama</div><div class="tile-div">${settings.ollamaModel}</div></div>`,
  ].concat(
    projects.map((p, i) => {
      const on = pinSet.has(p.path);
      return `<div class="tile${on ? " pinned" : ""}" data-proj="${i}" data-path="${escapeHtml(p.path)}">
        <span class="pin-star${on ? " on" : ""}" data-pin="${i}" title="${on ? "Unpin" : "Pin"}">${on ? "★" : "☆"}</span>
        <div class="tile-name">${escapeHtml(p.name)}</div>
        <div class="tile-div">${escapeHtml(p.div || "")}</div>
      </div>`;
    })
  );
  el.className = "deck-tiles";
  el.innerHTML = tiles.join("");
  el.querySelectorAll(".tile").forEach((t) => {
    t.addEventListener("click", (e) => {
      const star = e.target.closest(".pin-star");
      if (star && t.dataset.proj != null) {
        e.stopPropagation();
        const p = projects[+t.dataset.proj];
        if (p && p.path) toggleProjectPin(p.path);
        return;
      }
      if (t.dataset.act === "forge") summon("shell");
      else if (t.dataset.act === "claude") summon("claude");
      else if (t.dataset.act === "grok") summon("grok");
      else if (t.dataset.act === "ollama") summon("ollama");
      else if (t.dataset.proj != null) {
        const p = projects[+t.dataset.proj];
        if (p) summon("shell", { cwd: p.path, label: p.name });
      }
      closeDeck();
    });
  });
}

let gitCache = null;
async function renderGitPulse(force) {
  const el = $("deck-gitpulse");
  if (!el) return;
  if (!window.hellforge || !window.hellforge.gitStatus) {
    el.innerHTML = `<div class="roster-empty">Git unavailable.</div>`;
    return;
  }
  if (gitCache && !force) {
    paintGitPulse(gitCache);
    return;
  }
  el.innerHTML = `<div class="roster-empty">Reading the runes&hellip;</div>`;
  const projects = window.HF_PROJECTS || [];
  const results = await window.hellforge.gitStatus(projects.map((p) => p.path));
  const byPath = new Map(results.map((r) => [r.dir, r]));
  gitCache = projects
    .map((p) => ({ ...p, ...(byPath.get(p.path) || { isRepo: false }) }))
    .filter((r) => r.isRepo);
  paintGitPulse(gitCache);
}
function paintGitPulse(repos) {
  const el = $("deck-gitpulse");
  if (!el) return;
  if (!repos.length) {
    el.innerHTML = `<div class="roster-empty">No git repos found.</div>`;
    return;
  }
  // dirty repos first, then by name
  const sorted = [...repos].sort((a, b) => b.dirty - a.dirty || a.name.localeCompare(b.name));
  el.innerHTML = sorted
    .map((r) => {
      const state = r.dirty
        ? `<span class="git-dirty">&#9679; ${r.dirty}</span>`
        : `<span class="git-clean">&#10003;</span>`;
      const ab =
        (r.ahead ? `<span class="git-ab">&#8593;${r.ahead}</span>` : "") +
        (r.behind ? `<span class="git-ab">&#8595;${r.behind}</span>` : "");
      return `<div class="git-item" data-path="${r.path}" title="${r.name} — ${r.branch}">
        <span class="git-name">${r.name}</span>
        <span class="git-branch">${r.branch || "—"}</span>
        ${ab}${state}
      </div>`;
    })
    .join("");
  el.querySelectorAll(".git-item").forEach((it) => {
    const p = (window.HF_PROJECTS || []).find((x) => x.path === it.dataset.path);
    it.addEventListener("click", () => {
      if (p) summon("shell", { cwd: p.path, label: p.name });
      closeDeck();
    });
  });
}

function openDeck() {
  deckOpen = true;
  deckEl.classList.remove("hidden");
  renderDeckVitals();
  renderDeckForges();
  renderDeckTiles();
  renderGitPulse(false);
}
function closeDeck() {
  deckOpen = false;
  deckEl.classList.add("hidden");
  const f = forges.get(activeId);
  if (f) f.term.focus();
}
function toggleDeck() {
  deckOpen ? closeDeck() : openDeck();
}
$("slot-forges").addEventListener("click", toggleDeck);
$("git-refresh").addEventListener("click", (e) => {
  e.stopPropagation();
  renderGitPulse(true);
});
setInterval(() => {
  const c = $("deck-clock");
  if (c && deckOpen) c.textContent = new Date().toLocaleTimeString();
}, 1000);

// ============ The Council: multi-agent comms ============
// A shared JSONL bus (backed by main.js) lets the Director dispatch orders
// straight into an agent's stdin while every message is logged for the team.
// Roles: Director (you) -> Orchestrator (Claude) -> Executor (Grok) + Local (Ollama).
let councilOpen = false;
const councilEl = $("council");
const KNOWN_ROLES = ["director", "orchestrator", "executor", "local", "shell"];
let councilQuery = "";

// API-backed agents: which are switched on, which providers have keys, and the
// recent bus history we feed them as context. executor=Grok/xai, orchestrator=Claude/anthropic.
const apiAgents = { executor: false, orchestrator: false };
let apiStatus = { xai: false, anthropic: false };
let councilHistory = [];

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

// current forges shaped for HFCouncil.resolveTargets / the target picker
function councilForges() {
  return order.map((id) => {
    const f = forges.get(id);
    return {
      id,
      role: HFCouncil.roleFor(f ? f.kind : "shell"),
      title: f ? f.title : "forge " + id,
    };
  });
}

// normalize a message's declared sender/target to a known role for styling
function normRole(name) {
  const r = String(name == null ? "" : name).toLowerCase();
  return KNOWN_ROLES.includes(r) ? r : "shell";
}
function councilToLabel(to) {
  const t = String(to == null ? "all" : to);
  if (t === "all" || t === "*" || t === "") return "Everyone";
  if (KNOWN_ROLES.includes(t.toLowerCase())) return HFCouncil.roleMeta(t).label;
  const f = forges.get(Number(t));
  return f ? f.title : t;
}
function councilTime(ts) {
  const n = Number(ts);
  if (!n) return "";
  try {
    return new Date(n).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

// Populate the dispatch target picker: Everyone, role groups, each open forge.
function renderCouncilTargets() {
  const sel = $("council-target");
  if (!sel) return;
  const prev = sel.value;
  const list = councilForges();
  const opts = ['<option value="all">\u{1F702} Everyone</option>'];
  const rolesSeen = [];
  for (const f of list) if (!rolesSeen.includes(f.role)) rolesSeen.push(f.role);
  for (const r of rolesSeen) {
    const n = list.filter((f) => f.role === r).length;
    if (n > 1) {
      const m = HFCouncil.roleMeta(r);
      opts.push(`<option value="${r}">${m.icon} All ${escapeHtml(m.label)}s (${n})</option>`);
    }
  }
  for (const f of list) {
    const m = HFCouncil.roleMeta(f.role);
    opts.push(`<option value="${f.id}">${m.icon} ${escapeHtml(f.title)}</option>`);
  }
  sel.innerHTML = opts.join("");
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

// Paint one message row (textContent throughout — bus content is untrusted).
function paintCouncilMsg(msg, log) {
  if (!log || !msg) return;
  const role = normRole(msg.from);
  const meta = HFCouncil.roleMeta(role);
  const row = document.createElement("div");
  row.className = "council-msg";
  row.dataset.role = role;
  const metaEl = document.createElement("div");
  metaEl.className = "council-meta";
  const parts = [
    ["council-icon", meta.icon],
    ["council-from", meta.label],
    ["council-arrow", "→"],
    ["council-to", councilToLabel(msg.to)],
    ["council-time", councilTime(msg.ts)],
  ];
  for (const [cls, txt] of parts) {
    const s = document.createElement("span");
    s.className = cls;
    s.textContent = txt;
    metaEl.appendChild(s);
  }
  const text = document.createElement("div");
  text.className = "council-text";
  text.textContent = String(msg.text == null ? "" : msg.text);
  row.append(metaEl, text);
  log.appendChild(row);
}

// Re-render the council log using the current search filter.
function renderCouncilLog() {
  const log = $("council-log");
  if (!log) return;
  const filter = councilFn("filterBus", (msgs, q) => {
    if (!Array.isArray(msgs)) return [];
    const qq = String(q == null ? "" : q).toLowerCase();
    if (!qq) return msgs.slice();
    return msgs.filter((m) => {
      if (!m || typeof m !== "object") return false;
      return [m.from, m.to, m.text].some((v) =>
        String(v == null ? "" : v)
          .toLowerCase()
          .includes(qq)
      );
    });
  });
  const visible = filter(councilHistory, councilQuery);
  log.innerHTML = "";
  if (!visible.length) {
    const empty = document.createElement("div");
    empty.className = "council-empty";
    if (councilHistory.length && councilQuery) {
      empty.textContent = "No messages match the search.";
    } else {
      empty.innerHTML =
        "The council chamber is silent.<br>Dispatch an order &mdash; or an agent posts back with hf-say.";
    }
    log.appendChild(empty);
    return;
  }
  for (const m of visible) paintCouncilMsg(m, log);
  log.scrollTop = log.scrollHeight;
}

// Push into history and refresh the filtered view.
function appendCouncilMsg(msg) {
  if (!msg) return;
  councilHistory.push({ from: msg.from, to: msg.to, text: msg.text, ts: msg.ts });
  if (councilHistory.length > 200) councilHistory.shift();
  if (councilOpen) renderCouncilLog();
}

async function exportCouncilBus() {
  let msgs = councilHistory.slice();
  if (window.hellforge && window.hellforge.council && window.hellforge.council.read) {
    try {
      const full = await window.hellforge.council.read();
      if (Array.isArray(full) && full.length) msgs = full;
    } catch {
      /* use in-memory history */
    }
  }
  const content = councilFn("formatBusExport", (list) => {
    const lines = ["# Council Bus Export", ""];
    for (const m of Array.isArray(list) ? list : []) {
      if (!m || typeof m !== "object") continue;
      lines.push("## " + (m.ts ? new Date(Number(m.ts)).toISOString() : ""));
      lines.push("- **from:** " + (m.from == null ? "?" : String(m.from)));
      lines.push("- **to:** " + (m.to == null ? "all" : String(m.to)));
      lines.push("");
      lines.push(m.text == null ? "" : String(m.text));
      lines.push("");
    }
    return lines.join("\n");
  })(msgs);
  const d = new Date();
  const p = (n) => (n < 10 ? "0" : "") + n;
  const filename =
    "council-export-" +
    d.getFullYear() +
    p(d.getMonth() + 1) +
    p(d.getDate()) +
    "-" +
    p(d.getHours()) +
    p(d.getMinutes()) +
    p(d.getSeconds()) +
    ".md";
  if (!(window.hellforge && window.hellforge.council && window.hellforge.council.export)) {
    flashStatus("Export failed · bridge offline");
    return;
  }
  try {
    const res = await window.hellforge.council.export({ filename, content });
    if (res && res.ok) flashStatus("Bus exported · " + (res.path || filename));
    else flashStatus("Export failed · " + ((res && res.error) || "unknown"));
  } catch (err) {
    flashStatus("Export failed · " + (err && err.message ? err.message : String(err)));
  }
}

// Reflect key presence + on/off state on the API-agent chips.
function renderApiChips() {
  for (const role of ["executor", "orchestrator"]) {
    const chip = $("api-chip-" + role);
    if (!chip) continue;
    const provider = role === "executor" ? "xai" : "anthropic";
    const hasKey = !!apiStatus[provider];
    if (!hasKey) apiAgents[role] = false;
    chip.disabled = !hasKey;
    chip.classList.toggle("active", hasKey && apiAgents[role]);
    chip.title = !hasKey
      ? "No " + provider + " key in " + settings.apiKeyFile
      : apiAgents[role]
        ? "On — answers dispatches over the API"
        : "Off — click to enable";
  }
  const hint = $("api-agents-hint");
  if (hint) hint.textContent = apiStatus.xai || apiStatus.anthropic ? "" : "add keys in Settings";
}

// Ask the main process which providers have keys (values never cross the bridge).
async function refreshApiStatus() {
  if (window.hellforge && window.hellforge.api) {
    try {
      apiStatus = (await window.hellforge.api.status(settings.apiKeyFile)) || {
        xai: false,
        anthropic: false,
      };
    } catch {
      apiStatus = { xai: false, anthropic: false };
    }
  } else {
    apiStatus = { xai: false, anthropic: false };
  }
  renderApiChips();
}

// A transient, non-persisted status line in the transcript (errors, notices).
function appendCouncilNote(text) {
  const log = $("council-log");
  if (!log) return;
  const note = document.createElement("div");
  note.className = "council-note";
  note.textContent = text;
  log.appendChild(note);
  log.scrollTop = log.scrollHeight;
}

// Ask an active API agent. On success main posts the reply to the bus (which
// streams back via onMsg); on failure we show a transient note.
async function askApiAgent(role, prompt) {
  if (!(window.hellforge && window.hellforge.api)) return;
  const meta = HFCouncil.roleMeta(role);
  const log = $("council-log");
  const pend = document.createElement("div");
  pend.className = "council-pending";
  pend.textContent = meta.icon + " " + meta.label + " (API) is deliberating…";
  if (log) {
    log.appendChild(pend);
    log.scrollTop = log.scrollHeight;
  }
  try {
    const res = await window.hellforge.api.ask({
      role,
      prompt,
      history: councilHistory.slice(-14),
      keyFile: settings.apiKeyFile,
      model: role === "executor" ? settings.xaiModel : settings.anthropicModel,
    });
    pend.remove();
    if (!res || !res.ok) {
      appendCouncilNote("⚠ " + meta.label + " (API): " + ((res && res.error) || "no response"));
    }
  } catch {
    pend.remove();
    appendCouncilNote("⚠ " + meta.label + " (API): call failed");
  }
}

// Dispatch: log to the bus AND type the order into each resolved agent's stdin.
function councilDispatch() {
  const input = $("council-input");
  const sel = $("council-target");
  if (!input || !sel) return;
  const text = input.value.trim();
  if (!text) return;
  const target = sel.value;
  const msg = HFCouncil.makeMessage("director", target, text, Date.now());
  if (window.hellforge && window.hellforge.council) window.hellforge.council.post(msg);
  else appendCouncilMsg(msg); // no bridge (e.g. browser preview) — render locally
  const line = HFCouncil.formatForPty(text);
  if (line && window.hellforge && window.hellforge.write) {
    for (const id of HFCouncil.resolveTargets(target, councilForges())) {
      window.hellforge.write(id, line);
    }
  }
  // fan out to any active API agents this dispatch addresses (Everyone or role)
  for (const role of ["executor", "orchestrator"]) {
    if (apiAgents[role] && (target === "all" || target === role)) askApiAgent(role, text);
  }
  input.value = "";
}

async function openCouncil() {
  councilOpen = true;
  councilEl.classList.remove("hidden");
  renderCouncilTargets();
  renderApiChips();
  refreshApiStatus();
  const search = $("council-search");
  if (search) search.value = councilQuery;
  const log = $("council-log");
  if (window.hellforge && window.hellforge.council) {
    try {
      const ws = await window.hellforge.council.workspace();
      if (ws && ws.dir) {
        $("council-ws").textContent = ws.dir;
        const p = $("council-ws-path");
        if (p) p.textContent = ws.dir;
      }
      const history = await window.hellforge.council.read();
      councilHistory = [];
      if (Array.isArray(history) && history.length) {
        for (const m of history) {
          councilHistory.push({ from: m.from, to: m.to, text: m.text, ts: m.ts });
          if (councilHistory.length > 200) councilHistory.shift();
        }
      }
      renderCouncilLog();
    } catch {
      /* best-effort; ignore */
      renderCouncilLog();
    }
  } else if (log) {
    log.innerHTML = '<div class="council-empty">Council bus offline (no bridge).</div>';
  }
  const input = $("council-input");
  if (input) input.focus();
}
function closeCouncil() {
  councilOpen = false;
  councilEl.classList.add("hidden");
  const f = forges.get(activeId);
  if (f) f.term.focus();
}
function toggleCouncil() {
  councilOpen ? closeCouncil() : openCouncil();
}

$("rune-council").addEventListener("click", toggleCouncil);
$("council-close").addEventListener("click", closeCouncil);
for (const role of ["executor", "orchestrator"]) {
  const chip = $("api-chip-" + role);
  if (chip)
    chip.addEventListener("click", () => {
      if (chip.disabled) return;
      apiAgents[role] = !apiAgents[role];
      renderApiChips();
    });
}
councilEl.addEventListener("click", (e) => {
  if (e.target === councilEl) closeCouncil();
});
$("council-send").addEventListener("click", councilDispatch);
$("council-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    councilDispatch();
  } else if (e.key === "Escape") {
    e.preventDefault();
    closeCouncil();
  }
});
const councilSearchEl = $("council-search");
if (councilSearchEl) {
  councilSearchEl.addEventListener("input", () => {
    councilQuery = councilSearchEl.value;
    if (councilOpen) renderCouncilLog();
  });
  councilSearchEl.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      if (councilSearchEl.value) {
        councilSearchEl.value = "";
        councilQuery = "";
        renderCouncilLog();
      } else closeCouncil();
    }
  });
}
const councilExportBtn = $("council-export");
if (councilExportBtn) councilExportBtn.addEventListener("click", () => exportCouncilBus());

// live bus feed: new messages (our own posts + external hf-say) stream in
if (window.hellforge && window.hellforge.council) {
  window.hellforge.council.onMsg((msg) => appendCouncilMsg(msg));
  // ensure the shared workspace exists up front
  try {
    window.hellforge.council.workspace();
  } catch {
    /* best-effort; ignore */
  }
}
refreshApiStatus();

function extinguish(id) {
  const f = forges.get(id);
  if (!f) return;
  window.hellforge.kill(id);
  f.term.dispose();
  f.holder.remove();
  f.tab.remove();
  forges.delete(id);
  const oi = order.indexOf(id);
  if (oi >= 0) order.splice(oi, 1);
  if (activeId === id) {
    const nxt = HFCore.nextActiveAfterClose(order, oi);
    if (nxt != null) {
      activeId = nxt;
      renderLayout();
      f_focus(activeId);
    } else {
      activeId = null;
      renderLayout();
    }
  } else {
    renderLayout();
  }
}

if (window.hellforge) {
  window.hellforge.onData(({ id, data }) => {
    const f = forges.get(id);
    if (!f) return;
    f.term.write(data);
    f.lastData = Date.now();
    f.busyBytes = (f.busyBytes || 0) + data.length;
    if (!f.busy && f.busyBytes > 400) {
      f.busy = true;
      f.busyStart = Date.now();
    }
  });
  window.hellforge.onExit(({ id }) => {
    const f = forges.get(id);
    if (f)
      f.term.write(
        "\r\n\x1b[38;2;255;122;38m⚒ the fire has gone out. close the tab, or relight elsewhere.\x1b[0m\r\n"
      );
  });
  window.hellforge.onStats((s) => {
    lastStats = s;
    const gf = $("gauge-fill"),
      gv = $("gauge-val");
    if (gf) gf.style.height = HFCore.gaugeHeight(s.cpu) + "%";
    if (gv) gv.textContent = s.cpu;
    const g = document.querySelector(".gauge-label");
    if (g) g.title = `CPU ${s.cpu}% · RAM ${s.mem}%`;
    if (deckOpen) renderDeckVitals();
  });
}

// ---- "sacrifice complete": notify when a long command finishes unwatched ----
setInterval(() => {
  const now = Date.now();
  for (const [id, f] of forges) {
    if (HFCore.commandFinished(f, now)) {
      f.busy = false;
      f.busyBytes = 0;
      sacrificeComplete(id);
    } else if (f.busy && now - (f.lastData || 0) > HFCore.IDLE_MS) {
      // went idle but ran too briefly to be worth a notification
      f.busy = false;
      f.busyBytes = 0;
    }
  }
}, 700);

function sacrificeComplete(id) {
  const f = forges.get(id);
  if (!f) return;
  if (!HFCore.shouldNotify(id, activeId, visibleIds(), document.hidden)) return;
  f.tab.classList.add("done");
  playClang();
  flashStatus(`⚒ SACRIFICE COMPLETE · ${f.title}`);
}

let statusTimer = null;
function flashStatus(msg) {
  const el = document.getElementById("status-left");
  if (!el) return;
  el.textContent = msg;
  el.classList.add("flash");
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    el.textContent = "WPAI · THE FORGE IS LIT";
    el.classList.remove("flash");
  }, 6000);
}

// ---- synthesized forge sound (WebAudio, no assets) ----
let audioCtx = null,
  soundOn = true,
  rumble = null;
function ac() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}
function playClang() {
  if (!soundOn) return;
  const c = ac(),
    t = c.currentTime;
  const master = c.createGain();
  master.gain.value = 0.5;
  master.connect(c.destination);
  // inharmonic metallic partials
  [523, 784, 1046, 1397, 1875].forEach((f, i) => {
    const o = c.createOscillator(),
      g = c.createGain();
    o.type = "triangle";
    o.frequency.value = f * (1 + (Math.random() - 0.5) * 0.02);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5 / (i + 1), t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6 + i * 0.12);
    o.connect(g);
    g.connect(master);
    o.start(t);
    o.stop(t + 0.9 + i * 0.12);
  });
  // strike transient
  const nb = c.createBuffer(1, c.sampleRate * 0.05, c.sampleRate),
    d = nb.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
  const ns = c.createBufferSource();
  ns.buffer = nb;
  const nf = c.createBiquadFilter();
  nf.type = "bandpass";
  nf.frequency.value = 2400;
  const ng = c.createGain();
  ng.gain.value = 0.6;
  ns.connect(nf);
  nf.connect(ng);
  ng.connect(master);
  ns.start(t);
}
function toggleRumble() {
  const c = ac();
  if (rumble) {
    rumble.stop();
    rumble = null;
    return false;
  }
  const buf = c.createBuffer(1, c.sampleRate * 2, c.sampleRate),
    d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * 0.5;
  const src = c.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  const lp = c.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 90;
  const g = c.createGain();
  g.gain.value = 0.06;
  src.connect(lp);
  lp.connect(g);
  g.connect(c.destination);
  src.start();
  rumble = src;
  return true;
}

// ============ Wave 4: font zoom, search, settings ============
function setFontSize(px) {
  settings.fontSize = Math.max(9, Math.min(28, Math.round(px * 2) / 2));
  saveSettings();
  for (const [, f] of forges) {
    f.term.options.fontSize = settings.fontSize;
    f.fit.fit();
  }
  const el = $("set-font"),
    v = $("set-font-val");
  if (el) el.value = settings.fontSize;
  if (v) v.textContent = settings.fontSize;
}

const searchBar = $("search"),
  searchInput = $("search-input");
function openSearch() {
  searchBar.classList.remove("hidden");
  searchInput.value = "";
  searchInput.focus();
}
function closeSearch() {
  searchBar.classList.add("hidden");
  const f = forges.get(activeId);
  if (f) f.term.focus();
}
function doSearch(dir) {
  const f = forges.get(activeId);
  if (!f || !f.search) return;
  const q = searchInput.value;
  if (!q) return;
  const opts = {
    caseSensitive: false,
    decorations: { matchOverviewRuler: "#ff7a26", activeMatchColorOverviewRuler: "#fff2cf" },
  };
  dir < 0 ? f.search.findPrevious(q, opts) : f.search.findNext(q, opts);
}
searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    closeSearch();
  } else if (e.key === "Enter") {
    e.preventDefault();
    doSearch(e.shiftKey ? -1 : 1);
  }
});
searchInput.addEventListener("input", () => doSearch(1));
$("search-next").onclick = () => doSearch(1);
$("search-prev").onclick = () => doSearch(-1);
$("search-close").onclick = closeSearch;

const settingsEl = $("settings");
function openSettings() {
  $("set-shell").value = settings.shell;
  $("set-font").value = settings.fontSize;
  $("set-font-val").textContent = settings.fontSize;
  $("set-glass").value = settings.glass;
  $("set-glass-val").textContent = settings.glass + "%";
  $("set-sound").checked = settings.sound;
  const aot = $("set-always-on-top");
  if (aot) aot.checked = !!settings.alwaysOnTop;
  const mtt = $("set-minimize-tray");
  if (mtt) mtt.checked = !!settings.minimizeToTray;
  $("set-ollama-model").value = settings.ollamaModel;
  $("set-ollama-cmd").value = settings.ollamaCmd;
  $("set-api-keyfile").value = settings.apiKeyFile;
  $("set-xai-model").value = settings.xaiModel;
  $("set-anthropic-model").value = settings.anthropicModel;
  settingsEl.classList.remove("hidden");
}
function closeSettings() {
  settingsEl.classList.add("hidden");
}
function toggleAlwaysOnTop() {
  settings.alwaysOnTop = !settings.alwaysOnTop;
  saveSettings();
  applyWindowPrefs();
  const aot = $("set-always-on-top");
  if (aot) aot.checked = !!settings.alwaysOnTop;
  flashStatus(settings.alwaysOnTop ? "Always on top · ON" : "Always on top · OFF");
}
$("settings-btn").onclick = openSettings;
$("set-close").onclick = closeSettings;
settingsEl.addEventListener("click", (e) => {
  if (e.target === settingsEl) closeSettings();
});
$("set-shell").onchange = (e) => {
  settings.shell = e.target.value;
  saveSettings();
};
$("set-font").oninput = (e) => setFontSize(parseFloat(e.target.value));
$("set-glass").oninput = (e) => {
  settings.glass = parseInt(e.target.value);
  $("set-glass-val").textContent = settings.glass + "%";
  applyGlass();
  saveSettings();
};
$("set-sound").onchange = (e) => {
  soundOn = settings.sound = e.target.checked;
  saveSettings();
  $("sound-btn").classList.toggle("active", soundOn);
};
const setAlwaysOnTopEl = $("set-always-on-top");
if (setAlwaysOnTopEl) {
  setAlwaysOnTopEl.onchange = (e) => {
    settings.alwaysOnTop = !!e.target.checked;
    saveSettings();
    applyWindowPrefs();
  };
}
const setMinimizeTrayEl = $("set-minimize-tray");
if (setMinimizeTrayEl) {
  setMinimizeTrayEl.onchange = (e) => {
    settings.minimizeToTray = !!e.target.checked;
    saveSettings();
    applyWindowPrefs();
  };
}
$("set-ollama-model").onchange = (e) => {
  settings.ollamaModel = e.target.value.trim() || "llama3.2";
  saveSettings();
  if (!$("deck").classList.contains("hidden")) renderDeckTiles();
};
$("set-ollama-cmd").onchange = (e) => {
  settings.ollamaCmd = e.target.value.trim() || "ollama run {model}";
  saveSettings();
};
$("set-api-keyfile").onchange = (e) => {
  settings.apiKeyFile = e.target.value.trim() || "C:\\WPAI\\MyGrokKeys.md";
  saveSettings();
  refreshApiStatus();
};
$("set-xai-model").onchange = (e) => {
  settings.xaiModel = e.target.value.trim() || "grok-4.5";
  saveSettings();
};
$("set-anthropic-model").onchange = (e) => {
  settings.anthropicModel = e.target.value.trim() || "claude-sonnet-5";
  saveSettings();
};

// apply persisted settings on boot
applyGlass();
soundOn = settings.sound;
$("sound-btn").classList.toggle("active", soundOn);
applyWindowPrefs();
renderSidebarPins();

// ---- chrome ----
$("btn-min").onclick = () => window.hellforge.winMin();
$("btn-max").onclick = () => window.hellforge.winMax();
$("btn-close").onclick = () => window.hellforge.winClose();
$("new-forge").onclick = () => summon("shell");
$("summon-claude").onclick = () => summon("claude");
$("summon-grok").onclick = () => summon("grok");
$("summon-ollama").onclick = () => summon("ollama");
$("rune-forge").onclick = () => summon("shell");
$("rune-claude").onclick = () => summon("claude");
$("rune-grok").onclick = () => summon("grok");
$("rune-ollama").onclick = () => summon("ollama");
const runeJournal = $("rune-journal");
if (runeJournal) runeJournal.onclick = () => saveJournalActive();
$("rune-clear").onclick = () => {
  const f = forges.get(activeId);
  if (f) f.term.clear();
};
$("lay-1").onclick = () => setLayout(1);
$("lay-2").onclick = () => setLayout(2);
$("lay-4").onclick = () => setLayout(4);
$("broadcast-btn").onclick = () => {
  broadcast = !broadcast;
  $("broadcast-btn").classList.toggle("active", broadcast);
  updateStatus();
};
function splitForge() {
  const target = layout === 1 ? 2 : 4;
  setLayout(target);
  if (order.length < target) summon("shell");
}
$("sound-btn").onclick = () => {
  soundOn = !soundOn;
  $("sound-btn").classList.toggle("active", soundOn);
  if (soundOn) playClang();
};
$("rumble-btn").onclick = () => {
  const on = toggleRumble();
  $("rumble-btn").classList.toggle("active", on);
};

window.addEventListener("keydown", (e) => {
  if (e.ctrlKey && !e.shiftKey && e.key === "t") {
    e.preventDefault();
    summon("shell");
  }
  if (e.ctrlKey && !e.shiftKey && e.key === "w") {
    e.preventDefault();
    if (activeId) extinguish(activeId);
  }
  if (e.ctrlKey && !e.shiftKey && (e.key === "p" || e.key === "P")) {
    e.preventDefault();
    togglePalette();
  }
  if (e.altKey && e.key === "1") {
    e.preventDefault();
    setLayout(1);
  }
  if (e.altKey && e.key === "2") {
    e.preventDefault();
    setLayout(2);
  }
  if (e.altKey && e.key === "4") {
    e.preventDefault();
    setLayout(4);
  }
  if (e.ctrlKey && !e.shiftKey && (e.key === "d" || e.key === "D")) {
    e.preventDefault();
    splitForge();
  }
  if (e.ctrlKey && !e.shiftKey && (e.key === "f" || e.key === "F")) {
    e.preventDefault();
    openSearch();
  }
  if (e.ctrlKey && e.shiftKey && (e.key === "j" || e.key === "J")) {
    e.preventDefault();
    saveJournalActive();
  }
  if (e.ctrlKey && (e.key === "=" || e.key === "+")) {
    e.preventDefault();
    setFontSize(settings.fontSize + 1);
  }
  if (e.ctrlKey && e.key === "-") {
    e.preventDefault();
    setFontSize(settings.fontSize - 1);
  }
  if (e.ctrlKey && e.key === "0") {
    e.preventDefault();
    setFontSize(14.5);
  }
  if (e.ctrlKey && e.key === "`") {
    e.preventDefault();
    toggleDeck();
  }
  if (e.altKey && (e.key === "c" || e.key === "C")) {
    e.preventDefault();
    toggleCouncil();
  }
  if (e.key === "F1") {
    e.preventDefault();
    toggleHelp();
  }
  if (e.key === "Escape") {
    if (!$("help").classList.contains("hidden")) {
      e.preventDefault();
      $("help").classList.add("hidden");
    } else if (councilOpen) {
      e.preventDefault();
      closeCouncil();
    } else if (deckOpen) {
      e.preventDefault();
      closeDeck();
    }
  }
});

// ============ command palette (Ctrl+P) ============
const runInActive = (cmd) => {
  const f = forges.get(activeId);
  if (f) window.hellforge.write(activeId, cmd + "\r");
  else summon("shell", { run: cmd });
};

const SPELLS = [
  { name: "Git status", cmd: "git status", icon: "ᚷ" },
  { name: "Git log (graph)", cmd: "git log --oneline --graph --all -20", icon: "ᚦ" },
  { name: "Clear the forge", cmd: "Clear-Host", icon: "ᛞ" },
  { name: "Activate venv", cmd: ".\\.venv\\Scripts\\Activate.ps1", icon: "ᛝ" },
  { name: "Create venv", cmd: "python -m venv .venv", icon: "ᚹ" },
  {
    name: "List by size",
    cmd: "Get-ChildItem -File | Sort-Object Length -Descending | Select-Object -First 20 Name,@{n='MB';e={[math]::Round($_.Length/1MB,2)}}",
    icon: "ᚠ",
  },
  { name: "Run tests (pytest)", cmd: "python -m pytest -q", icon: "ᚱ" },
];

const ACTIONS = [
  { name: "New forge (PowerShell)", icon: "⚒", run: () => summon("shell") },
  { name: "Summon Claude", icon: "\u{1F702}", run: () => summon("claude") },
  { name: "Summon Grok (Build TUI)", icon: "⚡", run: () => summon("grok") },
  { name: "Summon Ollama", icon: "\u{1F999}", run: () => summon("ollama") },
  {
    name: "Save journal (active forge)",
    icon: "📜",
    run: () => saveJournalActive(),
  },
  {
    name: "Save journals (all forges)",
    icon: "📚",
    run: () => saveJournalsAll(),
  },
  {
    name: "Export council bus",
    icon: "☰",
    run: () => exportCouncilBus(),
  },
  {
    name: "Toggle always on top",
    icon: "📌",
    run: () => toggleAlwaysOnTop(),
  },
  {
    name: "Clear active forge",
    icon: "ᛞ",
    run: () => {
      const f = forges.get(activeId);
      if (f) f.term.clear();
    },
  },
  {
    name: "Extinguish active forge",
    icon: "✕",
    run: () => {
      if (activeId) extinguish(activeId);
    },
  },
];

function allItems() {
  const items = [];
  for (const a of ACTIONS)
    items.push({ kind: "action", icon: a.icon, name: a.name, sub: "action", run: a.run });
  for (const p of window.HF_PROJECTS || [])
    items.push({
      kind: "project",
      icon: "⚒",
      name: p.name,
      sub: `open forge · ${p.div}`,
      path: p.path,
      run: () => summon("shell", { cwd: p.path, label: p.name }),
    });
  for (const s of SPELLS)
    items.push({
      kind: "spell",
      icon: s.icon,
      name: s.name,
      sub: `spell · ${s.cmd.slice(0, 42)}`,
      run: () => runInActive(s.cmd),
    });
  return items;
}

const palette = $("palette"),
  pInput = $("palette-input"),
  pList = $("palette-list");
let pItems = [],
  pSel = 0,
  pOpen = false;

function renderPalette() {
  const q = pInput.value.trim();
  const pins = pinList();
  const rank =
    typeof HFCore.rankItemsWithPins === "function"
      ? (items, qq, lim) => HFCore.rankItemsWithPins(items, qq, lim, pins)
      : (items, qq, lim) => HFCore.rankItems(items, qq, lim);
  pItems = rank(allItems(), q, 40);
  if (pSel >= pItems.length) pSel = 0;
  pList.innerHTML = pItems
    .map((it, i) => {
      const pinned =
        it.kind === "project" &&
        it.path &&
        coreFn("isPinned", (ps, path) => ps.indexOf(path) !== -1)(pins, it.path);
      const star =
        it.kind === "project" && it.path
          ? `<span class="pin-star${pinned ? " on" : ""}" data-pin-path="${escapeHtml(it.path)}" title="${pinned ? "Unpin" : "Pin project"}">${pinned ? "★" : "☆"}</span>`
          : "";
      return `<div class="pal-item${i === pSel ? " sel" : ""}" data-i="${i}">
       <span class="pal-icon pal-${it.kind}">${it.icon}</span>
       <span class="pal-name">${escapeHtml(it.name)}</span>
       <span class="pal-sub">${escapeHtml(it.sub)}</span>
       ${star}
     </div>`;
    })
    .join("");
  const sel = pList.querySelector(".sel");
  if (sel) sel.scrollIntoView({ block: "nearest" });
}

function togglePalette() {
  pOpen ? closePalette() : openPalette();
}
function openPalette() {
  pOpen = true;
  palette.classList.remove("hidden");
  pInput.value = "";
  pSel = 0;
  renderPalette();
  pInput.focus();
}
function closePalette() {
  pOpen = false;
  palette.classList.add("hidden");
  const f = forges.get(activeId);
  if (f) f.term.focus();
}
function invoke() {
  const it = pItems[pSel];
  closePalette();
  if (it) it.run();
}

pInput.addEventListener("input", () => {
  pSel = 0;
  renderPalette();
});
pInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    closePalette();
  } else if (e.key === "ArrowDown") {
    e.preventDefault();
    pSel = Math.min(pSel + 1, pItems.length - 1);
    renderPalette();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    pSel = Math.max(pSel - 1, 0);
    renderPalette();
  } else if (e.key === "Enter") {
    e.preventDefault();
    invoke();
  }
});
pList.addEventListener("click", (e) => {
  const star = e.target.closest(".pin-star");
  if (star) {
    e.stopPropagation();
    const path = star.getAttribute("data-pin-path");
    if (path) toggleProjectPin(path);
    return;
  }
  const el = e.target.closest(".pal-item");
  if (el) {
    pSel = +el.dataset.i;
    invoke();
  }
});
palette.addEventListener("click", (e) => {
  if (e.target === palette) closePalette();
});

window.addEventListener("resize", () => {
  for (const fid of visibleIds()) {
    const f = forges.get(fid);
    if (f) f.fit.fit();
  }
});

// ---- status ----
function updateStatus() {
  const n = forges.size;
  const clock = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const bc = broadcast ? "📡 BROADCAST · " : "";
  statusRight.textContent = `${bc}${n} fire${n === 1 ? "" : "s"} burning · ${clock}`;
  const fc = $("forge-count");
  if (fc) fc.textContent = n;
}
setInterval(updateStatus, 4000);

// ---- lava drips ----
const dripsEl = document.getElementById("drips");
if (dripsEl) {
  for (let i = 0; i < 7; i++) {
    const d = document.createElement("div");
    d.className = "drip";
    d.style.left = 7 + Math.random() * 86 + "%";
    d.style.animationDelay = (Math.random() * 6).toFixed(1) + "s";
    d.style.animationDuration = (4 + Math.random() * 5).toFixed(1) + "s";
    dripsEl.appendChild(d);
  }
}

// ---- embers ----
const canvas = document.getElementById("embers");
const ctx = canvas.getContext("2d");
let embers = [];

function sizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
sizeCanvas();
window.addEventListener("resize", sizeCanvas);

function spawnEmber() {
  return {
    x: Math.random() * canvas.width,
    y: canvas.height + 6,
    r: 0.6 + Math.random() * 1.8,
    vy: 0.25 + Math.random() * 0.75,
    vx: (Math.random() - 0.5) * 0.35,
    life: 0,
    max: 280 + Math.random() * 240,
    hue: 18 + Math.random() * 14,
  };
}

function tickEmbers() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (embers.length < 34 && Math.random() < 0.35) embers.push(spawnEmber());
  for (const p of embers) {
    p.life++;
    p.x += p.vx + Math.sin(p.life * 0.02) * 0.18;
    p.y -= p.vy;
    const k = 1 - p.life / p.max;
    if (k <= 0 || p.y < -8) {
      Object.assign(p, spawnEmber());
      continue;
    }
    const a = Math.max(0, k * 0.5) * (0.7 + 0.3 * Math.sin(p.life * 0.15));
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fillStyle = `hsla(${p.hue}, 95%, ${55 + k * 12}%, ${a})`;
    ctx.shadowColor = "rgba(255,110,30,0.8)";
    ctx.shadowBlur = 6;
    ctx.fill();
    ctx.shadowBlur = 0;
  }
  requestAnimationFrame(tickEmbers);
}
tickEmbers();

// ============ keybindings help (F1) ============
const HELP = [
  ["Ctrl+P", "Command palette"],
  ["Ctrl+`", "Command Deck"],
  ["Alt+C", "The Council (agent comms)"],
  ["Ctrl+Shift+J", "Save journal (active forge)"],
  ["F1", "This help"],
  ["Ctrl+T", "New forge"],
  ["🜂 / ⚡ / 🦙", "Summon Claude / Grok / Ollama"],
  ["Ctrl+W", "Extinguish forge"],
  ["Ctrl+D", "Split panes"],
  ["Alt+1 / 2 / 4", "Layout: single / split / grid"],
  ["Ctrl+F", "Search in terminal"],
  ["Ctrl+= / − / 0", "Font zoom / reset"],
  ["Double-click tab", "Rename forge"],
  ["Drag tabs", "Reorder forges"],
  ["★ in palette / deck", "Pin a project (sidebar runes)"],
  ["Drag pane edge", "Resize a split"],
  ["Broadcast toggle", "Type into every visible pane"],
  ["Settings", "Always on top · Minimize to tray"],
];
function toggleHelp() {
  const h = $("help");
  if (h.classList.contains("hidden")) {
    $("help-grid").innerHTML = HELP.map(
      ([k, d]) => `<div class="help-row"><kbd>${k}</kbd><span>${d}</span></div>`
    ).join("");
    h.classList.remove("hidden");
  } else {
    h.classList.add("hidden");
  }
}
$("help").addEventListener("click", (e) => {
  if (e.target === $("help")) $("help").classList.add("hidden");
});

// ============ session restore ============
function saveSession() {
  const forgesArr = order
    .map((id) => {
      const f = forges.get(id);
      return f ? { kind: f.kind, cwd: f.cwd, label: f.title, model: f.model } : null;
    })
    .filter(Boolean);
  localStorage.setItem("hf-session", JSON.stringify({ layout, forges: forgesArr }));
}
window.addEventListener("beforeunload", saveSession);

async function boot() {
  let saved;
  try {
    saved = JSON.parse(localStorage.getItem("hf-session") || "null");
  } catch {
    saved = null;
  }
  if (saved && Array.isArray(saved.forges) && saved.forges.length) {
    for (const f of saved.forges) {
      await summon(f.kind || "shell", { cwd: f.cwd, label: f.label, model: f.model });
    }
    if (saved.layout && saved.layout !== 1) setLayout(saved.layout);
  } else {
    summon("shell");
  }
}
boot();
