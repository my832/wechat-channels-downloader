"use strict";

const {
  app,
  BrowserWindow,
  ipcMain,
  screen,
  shell,
  dialog,
  Menu,
  Tray,
  nativeImage,
} = require("electron");
const path = require("path");
const fs = require("fs");
const { fork } = require("child_process");

const ROOT = __dirname;

/*
 * The original userData folder (%APPDATA%\wechat-channels-downloader) ended up
 * with broken ACLs: Chromium could not create its cache and the single-instance
 * lock failed, so the app quit immediately on launch. Use a clean, writable
 * location instead and migrate the old config/tools once.
 */
const USER_DATA_DIR = path.join(process.env.LOCALAPPDATA || app.getPath("appData"), "WxChannelsDL");
try {
  app.setPath("userData", USER_DATA_DIR);
} catch {}
const ICON = path.join(ROOT, "assets", "icon.png");
const ICO = path.join(ROOT, "assets", "icon.ico");

/** user-writable locations: install dir may be read-only */
const userDir = () => app.getPath("userData");
const configPath = () => path.join(userDir(), "config.json");
const toolsDir = () => path.join(userDir(), "tools");

let mainWin = null;
let floatWin = null;
let tray = null;
let engine = null;

/** mirrored engine state so a reloaded renderer can sync instantly */
const snapshot = {
  state: "starting", // starting | listening | paused | downloading | error
  step: 0,
  captured: 0,
  outDir: "",
  logs: [],
  progress: null,
  floatVisible: true,
};

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showMain());
}

/* ------------------------------------------------------------- engine pipe */
/** Copy config + wasm tools from the legacy (ACL-broken) folder, once. */
function migrateLegacyData() {
  try {
    const oldDir = path.join(app.getPath("appData"), "wechat-channels-downloader");
    if (!fs.existsSync(oldDir)) return;
    const oldCfg = path.join(oldDir, "config.json");
    if (fs.existsSync(oldCfg) && !fs.existsSync(configPath())) {
      fs.copyFileSync(oldCfg, configPath());
    }
    const oldTools = path.join(oldDir, "tools");
    const newTools = toolsDir();
    if (fs.existsSync(oldTools) && !fs.existsSync(path.join(newTools, "wasm", "decoded.wasm"))) {
      fs.cpSync(oldTools, newTools, { recursive: true });
    }
  } catch (e) {
    console.log("[migrate] skipped:", e && e.message);
  }
}

function startEngine() {
  try {
    fs.mkdirSync(userDir(), { recursive: true });
    fs.mkdirSync(toolsDir(), { recursive: true });
  } catch {}
  migrateLegacyData();
  engine = fork(path.join(ROOT, "engine.js"), [], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
    env: {
      ...process.env,
      WXDL_TOOLS: toolsDir(),
      WXDL_CONFIG: configPath(),
    },
  });

  engine.stdout.on("data", (d) => process.stdout.write("[engine] " + d));
  engine.stderr.on("data", (d) => process.stderr.write("[engine:err] " + d));

  engine.on("message", (m) => {
    if (!m || !m.ev) return;
    switch (m.ev) {
      case "log":
        pushLog(m);
        break;
      case "state":
        snapshot.state = m.state;
        snapshot.step = m.step || 0;
        if (m.state !== "downloading") snapshot.progress = null;
        broadcast("state", { state: snapshot.state, step: snapshot.step });
        break;
      case "ready":
        snapshot.outDir = m.outDir || "";
        broadcast("outdir", snapshot.outDir);
        break;
      case "captured":
        snapshot.captured = m.count;
        broadcast("captured", m.count);
        break;
      case "progress":
        snapshot.progress = m;
        broadcast("progress", m);
        break;
      case "done":
        snapshot.progress = null;
        broadcast("done", m);
        break;
      case "error":
        snapshot.progress = null;
        broadcast("failed", m.msg);
        break;
    }
  });

  engine.on("exit", (code) => {
    if (code !== 0 && !app.isQuitting) {
      pushLog({ msg: "引擎已退出（" + code + "），请重启应用", level: "err", t: now() });
      broadcast("state", { state: "error", step: 0 });
    }
  });
}

const now = () => new Date().toISOString().slice(11, 19);

function pushLog(m) {
  const entry = { msg: m.msg, level: m.level || "info", t: m.t || now() };
  snapshot.logs.push(entry);
  if (snapshot.logs.length > 400) snapshot.logs.shift();
  broadcast("log", entry);
}

function broadcast(channel, payload) {
  for (const w of [mainWin, floatWin]) {
    if (w && !w.isDestroyed() && w.webContents && !w.webContents.isDestroyed()) {
      w.webContents.send(channel, payload);
    }
  }
}

function sendCmd(cmd, extra) {
  if (engine && engine.connected) {
    try {
      engine.send({ cmd, ...(extra || {}) });
    } catch {}
  }
}

/* ------------------------------------------------------------------ windows */
function showMain() {
  if (!mainWin || mainWin.isDestroyed()) return createMainWindow();
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.show();
  mainWin.focus();
}

function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 960,
    height: 690,
    minWidth: 820,
    minHeight: 580,
    show: false,
    backgroundColor: "#f6f7fb",
    title: "视频号视频下载器",
    icon: fs.existsSync(ICO) ? ICO : undefined,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(ROOT, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  mainWin.loadFile(path.join(ROOT, "renderer", "index.html"));
  mainWin.once("ready-to-show", () => mainWin.show());
  mainWin.on("close", () => {
    // closing the main window quits the whole app (proxy must be restored)
    app.isQuitting = true;
  });
  mainWin.on("closed", () => {
    mainWin = null;
  });
}

function floatDefaultPos() {
  const d = screen.getPrimaryDisplay().workArea;
  const w = 132;
  return [d.x + d.width - w - 18, d.y + Math.round((d.height - w) / 2)];
}

function createFloatWindow() {
  let pos = floatDefaultPos();
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath(), "utf8"));
    if (cfg.floatPos && Array.isArray(cfg.floatPos)) pos = cfg.floatPos;
  } catch {}

  floatWin = new BrowserWindow({
    width: 132,
    height: 132,
    x: pos[0],
    y: pos[1],
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: true,
    alwaysOnTop: true,
    acceptFirstMouse: true,
    webPreferences: {
      preload: path.join(ROOT, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  floatWin.setAlwaysOnTop(true, "screen-saver");
  floatWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  floatWin.loadFile(path.join(ROOT, "float", "float.html"));

  floatWin.on("closed", () => {
    floatWin = null;
  });
}

function saveFloatPos() {
  if (!floatWin || floatWin.isDestroyed()) return;
  try {
    const cfgPath = configPath();
    let cfg = {};
    try {
      cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    } catch {}
    cfg.floatPos = floatWin.getPosition();
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), "utf8");
  } catch {}
}

/* ------------------------------------------------------ float drag handling */
let dragTimer = null;
let dragOrigin = null;
let dragWinStart = null;
let wasDragging = false;

function startDrag() {
  if (!floatWin || floatWin.isDestroyed()) return;
  const cur = screen.getCursorScreenPoint();
  dragOrigin = cur;
  dragWinStart = floatWin.getPosition();
  wasDragging = false;
  if (dragTimer) clearInterval(dragTimer);
  dragTimer = setInterval(() => {
    if (!floatWin || floatWin.isDestroyed()) return stopDrag();
    const p = screen.getCursorScreenPoint();
    const dx = p.x - dragOrigin.x;
    const dy = p.y - dragOrigin.y;
    if (!wasDragging && Math.hypot(dx, dy) > 4) wasDragging = true;
    if (wasDragging) {
      floatWin.setPosition(Math.round(dragWinStart[0] + dx), Math.round(dragWinStart[1] + dy));
    }
  }, 16);
}

function stopDrag() {
  if (dragTimer) {
    clearInterval(dragTimer);
    dragTimer = null;
  }
  if (wasDragging) saveFloatPos();
  return wasDragging;
}

/* ---------------------------------------------------------------------- tray */
function createTray() {
  let img = null;
  if (fs.existsSync(ICON)) img = nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 });
  if (!img || img.isEmpty()) return;
  tray = new Tray(img);
  tray.setToolTip("视频号视频下载器");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "打开主窗口", click: () => showMain() },
      {
        label: "悬浮下载按钮",
        type: "checkbox",
        checked: true,
        click: (item) => {
          snapshot.floatVisible = item.checked;
          if (floatWin && !floatWin.isDestroyed()) floatWin.showInactive();
          if (!item.checked && floatWin) floatWin.hide();
        },
      },
      { type: "separator" },
      { label: "退出", click: () => quitApp() },
    ])
  );
  tray.on("double-click", () => showMain());
}

/* ---------------------------------------------------------------------- ipc */
ipcMain.handle("app:snapshot", () => snapshot);

ipcMain.handle("app:download", () => {
  sendCmd("download");
  return true;
});

ipcMain.handle("app:toggleListen", (_e, on) => {
  sendCmd(on ? "resume" : "pause");
  return true;
});

ipcMain.handle("app:openOutDir", () => {
  if (snapshot.outDir) shell.openPath(snapshot.outDir);
});

ipcMain.handle("app:revealFile", (_e, file) => {
  if (file && fs.existsSync(file)) shell.showItemInFolder(file);
});

ipcMain.handle("app:chooseOutDir", async () => {
  const r = await dialog.showOpenDialog(mainWin, {
    title: "选择视频保存目录",
    properties: ["openDirectory", "createDirectory"],
  });
  if (r.canceled || !r.filePaths.length) return snapshot.outDir;
  snapshot.outDir = r.filePaths[0];
  sendCmd("setOutDir", { dir: snapshot.outDir });
  broadcast("outdir", snapshot.outDir);
  return snapshot.outDir;
});

ipcMain.handle("float:toggle", (_e, show) => {
  snapshot.floatVisible = show;
  if (!floatWin) createFloatWindow();
  if (show) floatWin.showInactive();
  else floatWin.hide();
  return show;
});

ipcMain.on("float:press", () => startDrag());
ipcMain.on("float:release", () => {
  const dragged = stopDrag();
  if (!dragged) sendCmd("download");
});

ipcMain.on("float:context", () => {
  if (!floatWin) return;
  Menu.buildFromTemplate([
    { label: "下载当前播放的视频", click: () => sendCmd("download") },
    { label: "打开主窗口", click: () => showMain() },
    { label: "隐藏悬浮按钮", click: () => { snapshot.floatVisible = false; floatWin.hide(); } },
    { type: "separator" },
    { label: "退出", click: () => quitApp() },
  ]).popup({ window: floatWin });
});

/* --------------------------------------------------------------------- life */
function quitApp() {
  app.isQuitting = true;
  if (engine && engine.connected) {
    try {
      engine.send({ cmd: "shutdown" });
    } catch {}
  }
  setTimeout(() => app.quit(), 700);
}

app.whenReady().then(() => {
  if (fs.existsSync(ICO)) app.setAppUserModelId("com.local.wxchannelsdl");
  startEngine();
  createMainWindow();
  createFloatWindow();
  createTray();

  screen.on("display-metrics-changed", () => {
    if (floatWin && !floatWin.isDestroyed()) {
      const [x, y] = floatWin.getPosition();
      const d = screen.getDisplayNearestPoint({ x, y }).workArea;
      floatWin.setPosition(
        Math.min(Math.max(x, d.x), d.x + d.width - 132),
        Math.min(Math.max(y, d.y), d.y + d.height - 132)
      );
    }
  });
});

app.on("window-all-closed", () => {
  app.isQuitting = true;
  app.quit();
});

app.on("before-quit", () => {
  app.isQuitting = true;
  if (engine && engine.connected) {
    try {
      engine.send({ cmd: "shutdown" });
    } catch {}
  }
});
