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
const settings = Object.assign(
  { shell: "pwsh.exe", fontSize: 14.5, glass: 50, sound: true },
  JSON.parse(localStorage.getItem("hf-settings") || "{}")
);
function saveSettings() {
  localStorage.setItem("hf-settings", JSON.stringify(settings));
}
function applyGlass() {
  const a = settings.glass / 100;
  document.documentElement.style.setProperty("--glass-top", (0.15 + a * 0.7).toFixed(2));
  document.documentElement.style.setProperty("--glass-bot", (a * 0.12).toFixed(2));
}

const THEME = {
  background: "rgba(0,0,0,0)",
  foreground: "#f0e6d4",
  cursor: "#ff7a26",
  cursorAccent: "#0c0907",
  selectionBackground: "rgba(255,122,38,0.28)",
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

async function summon(kind, o = {}) {
  forgeCount++;
  const isClaude = kind === "claude";
  const title = o.label || (isClaude ? `Claude ${forgeCount}` : `Forge ${forgeCount}`);

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

  const promptCmd =
    'function prompt { "`e[38;2;255;122;38m[HELLFORGE]`e[0m ' +
    '`e[38;2;170;130;90m$(Get-Location)`e[0m `e[38;2;232;69;28m>`e[0m " }; ' +
    "Write-Host '  the forge is lit. speak, and it shapes.' -ForegroundColor DarkYellow";
  const shell = isClaude ? "pwsh.exe" : o.shell || settings.shell || "pwsh.exe";
  const { args, deferredRun } = HFCore.buildShellArgs(shell, { isClaude, run: o.run, promptCmd });
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
  tab.className = "tab";
  tab.innerHTML = `<span class="flame">${isClaude ? "\u{1F702}" : "⚒"}</span><span class="t">${title}</span><span class="x" title="Extinguish">×</span>`;
  tab.addEventListener("click", (e) => {
    if (e.target.classList.contains("x")) extinguish(id);
    else activate(id);
  });
  tab.addEventListener("auxclick", (e) => {
    if (e.button === 1) extinguish(id);
  });
  tabsEl.appendChild(tab);

  holder.addEventListener("mousedown", () => focusPane(id));
  term.onData((data) => {
    if (broadcast && visibleIds().includes(id)) {
      for (const pid of visibleIds()) window.hellforge.write(pid, data);
    } else {
      window.hellforge.write(id, data);
    }
  });
  term.onResize(({ cols, rows }) => window.hellforge.resize(id, cols, rows));

  forges.set(id, { term, fit, holder, tab, title, search });
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

function setLayout(n) {
  layout = n;
  for (const b of document.querySelectorAll(".lay")) b.classList.remove("active");
  const btn = document.getElementById("lay-" + n);
  if (btn) btn.classList.add("active");
  renderLayout();
  if (activeId != null) f_focus(activeId);
}

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
    if (order.length) {
      activeId = order[Math.min(oi, order.length - 1)];
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
  window.hellforge.onStats(({ cpu, mem }) => {
    const gf = $("gauge-fill"),
      gv = $("gauge-val");
    if (gf) gf.style.height = HFCore.gaugeHeight(cpu) + "%";
    if (gv) gv.textContent = cpu;
    const g = document.querySelector(".gauge-label");
    if (g) g.title = `CPU ${cpu}% · RAM ${mem}%`;
  });
}

// ---- "sacrifice complete": notify when a long command finishes unwatched ----
setInterval(() => {
  const now = Date.now();
  for (const [id, f] of forges) {
    if (f.busy && now - (f.lastData || 0) > 1400) {
      const dur = (f.lastData || 0) - (f.busyStart || 0);
      f.busy = false;
      f.busyBytes = 0;
      if (dur > 2500) sacrificeComplete(id);
    }
  }
}, 700);

function sacrificeComplete(id) {
  const f = forges.get(id);
  if (!f) return;
  const watching = !document.hidden && activeId === id && visibleIds().includes(id);
  if (watching) return;
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
  settingsEl.classList.remove("hidden");
}
function closeSettings() {
  settingsEl.classList.add("hidden");
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

// apply persisted settings on boot
applyGlass();
soundOn = settings.sound;
$("sound-btn").classList.toggle("active", soundOn);

// ---- chrome ----
$("btn-min").onclick = () => window.hellforge.winMin();
$("btn-max").onclick = () => window.hellforge.winMax();
$("btn-close").onclick = () => window.hellforge.winClose();
$("new-forge").onclick = () => summon("shell");
$("summon-claude").onclick = () => summon("claude");
$("rune-forge").onclick = () => summon("shell");
$("rune-claude").onclick = () => summon("claude");
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
  pItems = HFCore.rankItems(allItems(), q, 40);
  if (pSel >= pItems.length) pSel = 0;
  pList.innerHTML = pItems
    .map(
      (it, i) =>
        `<div class="pal-item${i === pSel ? " sel" : ""}" data-i="${i}">
       <span class="pal-icon pal-${it.kind}">${it.icon}</span>
       <span class="pal-name">${it.name}</span>
       <span class="pal-sub">${it.sub}</span>
     </div>`
    )
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

// ---- first fire ----
summon("shell");
