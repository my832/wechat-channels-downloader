"use strict";

const { contextBridge, ipcRenderer } = require("electron");

function on(channel, cb) {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld("api", {
  snapshot: () => ipcRenderer.invoke("app:snapshot"),
  download: () => ipcRenderer.invoke("app:download"),
  toggleListen: (on) => ipcRenderer.invoke("app:toggleListen", on),
  openOutDir: () => ipcRenderer.invoke("app:openOutDir"),
  revealFile: (f) => ipcRenderer.invoke("app:revealFile", f),
  chooseOutDir: () => ipcRenderer.invoke("app:chooseOutDir"),
  toggleFloat: (show) => ipcRenderer.invoke("float:toggle", show),

  onLog: (cb) => on("log", cb),
  onState: (cb) => on("state", cb),
  onCaptured: (cb) => on("captured", cb),
  onProgress: (cb) => on("progress", cb),
  onDone: (cb) => on("done", cb),
  onFailed: (cb) => on("failed", cb),
  onOutDir: (cb) => on("outdir", cb),

  // float button only
  press: () => ipcRenderer.send("float:press"),
  release: () => ipcRenderer.send("float:release"),
  contextMenu: () => ipcRenderer.send("float:context"),
});
