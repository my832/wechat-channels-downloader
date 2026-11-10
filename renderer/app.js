"use strict";

const $ = (id) => document.getElementById(id);

const el = {
  chip: $("statusChip"),
  dot: $("statusDot"),
  statusText: $("statusText"),
  count: $("capturedCount"),
  hint: $("statHint"),
  btn: $("downloadBtn"),
  btnTitle: $("btnTitle"),
  btnSub: $("btnSub"),
  outDir: $("outDir"),
  log: $("logBody"),
  floatSwitch: $("floatSwitch"),
  footHint: $("footHint"),
};

const STATE_LABEL = {
  starting: "正在准备…",
  ready: "就绪",
  downloading: "处理中",
  error: "出错了",
};

const STEP_TEXT = {
  1: "正在读取微信内存…",
  2: "正在下载视频…",
  3: "正在校验解密种子…",
  4: "正在解密…",
  5: "正在写出文件…",
};

let currentState = "starting";
let currentStep = 0;

/* ------------------------------------------------------------------- render */
function renderState(state, step) {
  currentState = state;
  if (typeof step === "number") currentStep = step;

  el.chip.className = "status-chip";
  if (state === "ready") el.chip.classList.add("is-live");
  if (state === "downloading") el.chip.classList.add("is-busy");
  if (state === "error") el.chip.classList.add("is-error");
  el.statusText.textContent = STATE_LABEL[state] || state;

  const busy = state === "downloading";
  el.btn.disabled = busy;
  if (busy) {
    el.btnTitle.textContent = STEP_TEXT[currentStep] || "处理中…";
    el.btnSub.textContent = "请保持视频号播放器窗口打开";
  } else {
    el.btnTitle.textContent = "下载当前视频";
    el.btnSub.textContent = "抓取正在播放的这一条";
  }

  if (state === "ready") {
    el.footHint.textContent = "不修改系统代理 · 不安装证书 · 不影响 Clash 等代理工具";
  } else if (state === "downloading") {
    el.footHint.textContent = "正在处理，请勿关闭微信播放器窗口";
  }
}

function appendLog(entry, scroll = true) {
  const empty = el.log.querySelector(".log-empty");
  if (empty) empty.remove();
  const line = document.createElement("div");
  line.className = "log-line " + (entry.level || "info");
  const t = document.createElement("span");
  t.className = "log-t";
  t.textContent = entry.t || "";
  const m = document.createElement("span");
  m.className = "log-m";
  m.textContent = entry.msg;
  line.append(t, m);
  el.log.appendChild(line);
  while (el.log.children.length > 400) el.log.firstChild.remove();
  if (scroll) el.log.scrollTop = el.log.scrollHeight;
}

function setCaptured(n) {
  el.count.textContent = String(n);
  if (n > 0) {
    el.hint.textContent = "已定位到视频，正在下载解密…";
  } else {
    el.hint.textContent = "点下载时读取微信内存，定位正在播放的那一条";
  }
}

/* -------------------------------------------------------------------- init */
async function init() {
  const snap = await window.api.snapshot();
  setCaptured(snap.captured || 0);
  renderState(snap.state || "starting", snap.step);
  if (snap.outDir) el.outDir.textContent = snap.outDir;
  el.floatSwitch.checked = snap.floatVisible !== false;
  if (snap.logs && snap.logs.length) {
    snap.logs.forEach((l) => appendLog(l, false));
    el.log.scrollTop = el.log.scrollHeight;
  } else {
    const d = document.createElement("div");
    d.className = "log-empty";
    d.textContent = "等待启动…";
    el.log.appendChild(d);
  }
}

window.api.onState(({ state, step }) => renderState(state, step));
window.api.onCaptured((n) => setCaptured(n));
window.api.onOutDir((d) => {
  el.outDir.textContent = d;
});
window.api.onLog((entry) => appendLog(entry));
window.api.onDone(({ file, size }) => {
  appendLog({
    t: new Date().toISOString().slice(11, 19),
    level: "ok",
    msg: `✓ 已保存：${file}（${(size / 1048576).toFixed(2)} MB）`,
  });
  el.footHint.textContent = "保存成功 · 可点击「打开」查看文件夹";
});
window.api.onFailed((msg) => {
  appendLog({
    t: new Date().toISOString().slice(11, 19),
    level: "err",
    msg: "✗ " + msg,
  });
});

/* ----------------------------------------------------------------- actions */
el.btn.addEventListener("click", () => {
  if (el.btn.disabled) return;
  window.api.download();
});

el.openBtn = $("openBtn");
el.openBtn.addEventListener("click", () => window.api.openOutDir());

$("chooseBtn").addEventListener("click", async () => {
  const d = await window.api.chooseOutDir();
  if (d) el.outDir.textContent = d;
});

$("clearBtn").addEventListener("click", () => {
  el.log.innerHTML = "";
  const d = document.createElement("div");
  d.className = "log-empty";
  d.textContent = "日志已清空";
  el.log.appendChild(d);
});

el.floatSwitch.addEventListener("change", () => {
  window.api.toggleFloat(el.floatSwitch.checked);
});

init();
