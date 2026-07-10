const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { execFile } = require("child_process");
const pty = require("@lydell/node-pty");
const HFCore = require("./renderer/core.js");
const HFCouncil = require("./renderer/council.js");
const HFApi = require("./renderer/api.js");

let win;
let stateFile;

// ---- The Council: shared JSONL message bus ----
const COUNCIL_WORKSPACE = "C:\\WPAI\\Workspace";
const COUNCIL_DIR = path.join(COUNCIL_WORKSPACE, ".hellforge");
const COUNCIL_BUS = path.join(COUNCIL_DIR, "bus.jsonl");
let busOffset = 0;
let busWatcher = null;
let busWatchTimer = null;

function ensureCouncilDirs() {
  try {
    fs.mkdirSync(COUNCIL_DIR, { recursive: true });
    return { dir: COUNCIL_WORKSPACE, bus: COUNCIL_BUS };
  } catch {
    return { dir: "", bus: "" };
  }
}

function broadcastCouncilMsg(msg) {
  if (win && !win.isDestroyed()) {
    try {
      win.webContents.send("council:msg", msg);
    } catch {
      /* best-effort; ignore */
    }
  }
}

function flushBusWatch() {
  try {
    let size = 0;
    try {
      size = fs.statSync(COUNCIL_BUS).size;
    } catch {
      return;
    }
    if (size < busOffset) busOffset = 0;
    if (size <= busOffset) return;

    const fd = fs.openSync(COUNCIL_BUS, "r");
    try {
      const len = size - busOffset;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, busOffset);
      const chunk = buf.toString("utf8");
      // Only advance past complete lines so a concurrent partial write is retried.
      const lastNl = chunk.lastIndexOf("\n");
      if (lastNl === -1) return;
      const complete = chunk.slice(0, lastNl + 1);
      busOffset += Buffer.byteLength(complete, "utf8");
      const msgs = HFCouncil.parseBus(complete);
      for (let i = 0; i < msgs.length; i++) broadcastCouncilMsg(msgs[i]);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    /* best-effort; ignore */
  }
}

function startBusWatch() {
  try {
    ensureCouncilDirs();
    try {
      busOffset = fs.statSync(COUNCIL_BUS).size;
    } catch {
      busOffset = 0;
    }
    if (busWatcher) {
      try {
        busWatcher.close();
      } catch {
        /* best-effort; ignore */
      }
      busWatcher = null;
    }
    busWatcher = fs.watch(COUNCIL_DIR, (eventType, filename) => {
      if (filename && filename !== "bus.jsonl") return;
      if (busWatchTimer) clearTimeout(busWatchTimer);
      busWatchTimer = setTimeout(() => {
        busWatchTimer = null;
        flushBusWatch();
      }, 50);
    });
  } catch {
    /* best-effort; ignore */
  }
}

function stopBusWatch() {
  if (busWatchTimer) {
    try {
      clearTimeout(busWatchTimer);
    } catch {
      /* best-effort; ignore */
    }
    busWatchTimer = null;
  }
  if (busWatcher) {
    try {
      busWatcher.close();
    } catch {
      /* best-effort; ignore */
    }
    busWatcher = null;
  }
}

ipcMain.handle("council:workspace", () => {
  try {
    return ensureCouncilDirs();
  } catch {
    return { dir: "", bus: "" };
  }
});

// Append a message to the bus and broadcast it. Returns the stored record or
// null. Shared by the council:post IPC and the API-agent replies.
function postToBus(msg) {
  try {
    ensureCouncilDirs();
    const line = HFCouncil.serializeMsg(msg) + "\n";
    fs.appendFileSync(COUNCIL_BUS, line, "utf8");
    // Advance offset past our own write so the watcher does not double-emit.
    try {
      busOffset = fs.statSync(COUNCIL_BUS).size;
    } catch {
      /* best-effort; ignore */
    }
    const stored = HFCouncil.parseBus(HFCouncil.serializeMsg(msg))[0] || null;
    if (stored) broadcastCouncilMsg(stored);
    return stored;
  } catch {
    return null;
  }
}

ipcMain.handle("council:post", (e, msg) => !!postToBus(msg));

ipcMain.handle("council:read", () => {
  try {
    let content = "";
    try {
      content = fs.readFileSync(COUNCIL_BUS, "utf8");
    } catch {
      content = "";
    }
    return HFCouncil.parseBus(content);
  } catch {
    return [];
  }
});

// ---- API-backed Council agents (keys live ONLY here, never in the renderer) ----
const DEFAULT_KEY_FILE = "C:\\WPAI\\MyGrokKeys.md";

// Load provider keys from the key file + environment. The raw key never leaves
// this process: it is only ever placed in an outbound request header.
function loadKeys(keyFile) {
  let text;
  try {
    text = fs.readFileSync(keyFile || DEFAULT_KEY_FILE, "utf8");
  } catch {
    text = "";
  }
  return HFApi.extractKeys(text, process.env);
}

ipcMain.handle("api:status", (e, keyFile) => {
  try {
    return HFApi.keyStatus(loadKeys(keyFile));
  } catch {
    return { xai: false, anthropic: false };
  }
});

// Ask an API agent. opts: { role, prompt, history, keyFile, model, maxTokens }.
// On success the reply is posted to the shared bus (so it streams into every
// Council transcript) and returned; on failure a reason is returned (never a key).
ipcMain.handle("api:ask", async (e, opts) => {
  const o = opts && typeof opts === "object" ? opts : {};
  const role = String(o.role || "");
  const provider = HFApi.providerForRole(role);
  if (!provider) return { ok: false, error: "no API provider for role '" + role + "'" };
  const keys = loadKeys(o.keyFile);
  const key = keys[provider];
  if (!key) return { ok: false, error: "no " + provider + " key configured" };

  const { system, messages } = HFApi.buildMessages(role, o.prompt, o.history);
  const req = HFApi.buildRequest(provider, key, o.model, system, messages, {
    maxTokens: o.maxTokens,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const res = await fetch(req.url, {
      method: "POST",
      headers: req.headers,
      body: JSON.stringify(req.body),
      signal: controller.signal,
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      return { ok: false, error: "HTTP " + res.status + " (non-JSON response)" };
    }
    const parsed = HFApi.parseResponse(provider, json);
    if (parsed.error) return { ok: false, error: parsed.error, status: res.status };
    postToBus(HFCouncil.makeMessage(role, "all", parsed.text, Date.now()));
    return { ok: true, text: parsed.text };
  } catch (err) {
    const reason = err && err.name === "AbortError" ? "request timed out" : "network error";
    return { ok: false, error: reason };
  } finally {
    clearTimeout(timer);
  }
});
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return {};
  }
}
function saveState() {
  try {
    if (win && !win.isDestroyed()) fs.writeFileSync(stateFile, JSON.stringify(win.getBounds()));
  } catch {
    /* best-effort; ignore */
  }
}
const ptys = new Map();
let nextId = 1;

// ---- system load sampling (real hellfire pressure) ----
function cpuTimes() {
  let idle = 0,
    total = 0;
  for (const c of os.cpus()) {
    for (const t in c.times) total += c.times[t];
    idle += c.times.idle;
  }
  return { idle, total };
}
let lastCpu = cpuTimes();
function cpuPercent() {
  const cur = cpuTimes();
  const di = cur.idle - lastCpu.idle,
    dt = cur.total - lastCpu.total;
  lastCpu = cur;
  return dt > 0 ? Math.max(0, Math.min(100, 100 * (1 - di / dt))) : 0;
}
function diskStats() {
  try {
    const s = fs.statfsSync(process.platform === "win32" ? "C:\\" : "/");
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    return { diskPct: Math.round(100 * (1 - free / total)), diskFreeGB: +(free / 1e9).toFixed(1) };
  } catch {
    return { diskPct: 0, diskFreeGB: 0 };
  }
}
setInterval(() => {
  if (win && !win.isDestroyed()) {
    const total = os.totalmem();
    win.webContents.send("sys:stats", {
      cpu: Math.round(cpuPercent()),
      mem: Math.round(100 * (1 - os.freemem() / total)),
      memUsedGB: +((total - os.freemem()) / 1e9).toFixed(1),
      memTotalGB: +(total / 1e9).toFixed(1),
      cores: os.cpus().length,
      uptime: Math.round(process.uptime()),
      ...diskStats(),
    });
  }
}, 2000);

// ---- git pulse: branch + working-tree status per project ----
function gitStatus(dir) {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", dir, "status", "--porcelain=2", "--branch"],
      { timeout: 4000, windowsHide: true, maxBuffer: 1 << 20 },
      (err, stdout) => {
        if (err) return resolve({ dir, isRepo: false });
        resolve({ dir, isRepo: true, ...HFCore.parseGitStatus(stdout) });
      }
    );
  });
}
ipcMain.handle("git:status", async (e, dirs) => {
  const queue = [...dirs];
  const out = [];
  const worker = async () => {
    while (queue.length) out.push(await gitStatus(queue.shift()));
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return out;
});

function createWindow() {
  stateFile = path.join(app.getPath("userData"), "window-state.json");
  const s = loadState();
  win = new BrowserWindow({
    width: s.width || 1280,
    height: s.height || 800,
    x: s.x,
    y: s.y,
    minWidth: 720,
    minHeight: 480,
    frame: false,
    backgroundColor: "#0c0907",
    icon: path.join(__dirname, "renderer", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  win.on("maximize", () => win.webContents.send("win:state", true));
  win.on("unmaximize", () => win.webContents.send("win:state", false));
  win.on("close", saveState);
  win.on("close", stopBusWatch);
  startBusWatch();
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());

// ---- window chrome ----
ipcMain.on("win:min", () => win.minimize());
ipcMain.on("win:max", () => (win.isMaximized() ? win.unmaximize() : win.maximize()));
ipcMain.on("win:close", () => win.close());

// ---- PTY management ----
ipcMain.handle("pty:create", (e, opts) => {
  const id = nextId++;
  const shell = opts.shell || "pwsh.exe";
  const args = opts.args || [];
  const p = pty.spawn(shell, args, {
    name: "xterm-256color",
    cols: opts.cols || 100,
    rows: opts.rows || 30,
    cwd: opts.cwd || "C:\\WPAI",
    env: process.env,
  });
  ptys.set(id, p);
  p.onData((data) => {
    if (!win.isDestroyed()) win.webContents.send("pty:data", { id, data });
  });
  p.onExit(({ exitCode }) => {
    ptys.delete(id);
    if (!win.isDestroyed()) win.webContents.send("pty:exit", { id, exitCode });
  });
  return id;
});

ipcMain.on("pty:input", (e, { id, data }) => {
  const p = ptys.get(id);
  if (p) p.write(data);
});

ipcMain.on("pty:resize", (e, { id, cols, rows }) => {
  const p = ptys.get(id);
  if (p) {
    try {
      p.resize(cols, rows);
    } catch {
      /* best-effort; ignore */
    }
  }
});

ipcMain.on("pty:kill", (e, id) => {
  const p = ptys.get(id);
  if (p) {
    try {
      p.kill();
    } catch {
      /* best-effort; ignore */
    }
    ptys.delete(id);
  }
});
