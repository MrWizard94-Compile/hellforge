const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const os = require("os");
const fs = require("fs");
const pty = require("@lydell/node-pty");

let win;
let stateFile;
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
setInterval(() => {
  if (win && !win.isDestroyed()) {
    win.webContents.send("sys:stats", {
      cpu: Math.round(cpuPercent()),
      mem: Math.round(100 * (1 - os.freemem() / os.totalmem())),
    });
  }
}, 2000);

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
