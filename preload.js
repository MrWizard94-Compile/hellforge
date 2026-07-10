const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("hellforge", {
  createPty: (opts) => ipcRenderer.invoke("pty:create", opts),
  write: (id, data) => ipcRenderer.send("pty:input", { id, data }),
  resize: (id, cols, rows) => ipcRenderer.send("pty:resize", { id, cols, rows }),
  kill: (id) => ipcRenderer.send("pty:kill", id),
  onData: (cb) => ipcRenderer.on("pty:data", (e, m) => cb(m)),
  onExit: (cb) => ipcRenderer.on("pty:exit", (e, m) => cb(m)),
  onStats: (cb) => ipcRenderer.on("sys:stats", (e, s) => cb(s)),
  gitStatus: (dirs) => ipcRenderer.invoke("git:status", dirs),
  winMin: () => ipcRenderer.send("win:min"),
  winMax: () => ipcRenderer.send("win:max"),
  winClose: () => ipcRenderer.send("win:close"),
  onWinState: (cb) => ipcRenderer.on("win:state", (e, maxed) => cb(maxed)),
});
