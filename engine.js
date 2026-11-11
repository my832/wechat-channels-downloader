"use strict";
/*
 * WeChat Channels Downloader - resident engine (v2.1 memory edition)
 *
 * Original capture/decrypt research: my832/wechat-channels-downloader (MIT).
 *
 * KEY FACTS (learned by probing real processes — verify before "improving"):
 *  - The video JSON lives in WeChat memory as **UTF-16** text. Searching ASCII
 *    finds nothing at all.
 *  - Inside that JSON, "url" with path /251/20302/stodownload is the VIDEO.
 *    /251/20304/... is only a cover/thumb image (tiny, only ~26KB).
 *  - The playable link is  url + url_token.  Without the token the CDN
 *    answers HTTP 400.
 *  - "decode_key" sits AFTER the media array inside the same object, so we
 *    anchor the scan on decode_key and look ~16KB backwards for the urls.
 *  - Only the first 128KB is XOR-encrypted with an Isaac64 keystream.
 *
 * Consequences: no system proxy, no root certificate, no network capture,
 * and nothing outside WeChat is touched.
 *
 * IPC protocol:
 *   out: { ev: "state"|"log"|"captured"|"progress"|"done"|"error" }
 *   in : { cmd: "download" | "scan" | "setOutDir" | "shutdown" }
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const zlib = require("zlib");
const { execFileSync, spawnSync, spawn } = require("child_process");

const ENCLEN = 131072;
const WASM_BASE = "https://aladin.wxqcloud.qq.com/aladin/ffmepeg/video-decode/1.2.46/";

const ROOT = __dirname;
const TOOLS = process.env.WXDL_TOOLS || path.join(ROOT, "tools");
const WORK = path.join(os.tmpdir(), "channels_dl_work");
const WASM_FILE = path.join(TOOLS, "wasm", "decoded.wasm");
const WASM_LOADER = path.join(TOOLS, "wasm", "wasm_video_decode_plain.js");
const SCAN_PS1 = path.join(WORK, "scan_videos.ps1");
const CONFIG_FILE = process.env.WXDL_CONFIG || path.join(ROOT, "config.json");

/* ------------------------------------------------------------------ utils */
const ts = () => new Date().toISOString().slice(11, 19);
const ensureDir = (p) => fs.mkdirSync(p, { recursive: true });

function send(o) {
  try {
    if (process.send) process.send(o);
  } catch {}
}
function log(msg, level) {
  send({ ev: "log", msg, level: level || "info", t: ts() });
}
function state(s, extra) {
  send({ ev: "state", state: s, ...(extra || {}) });
}
function downloadTo(url, dest, onTick) {
  return new Promise((resolve, reject) => {
    const child = spawn("curl.exe", ["-sSL", "-o", dest, "--max-time", "900", url], {
      windowsHide: true,
    });
    let timer = null;
    if (onTick) {
      timer = setInterval(() => {
        try {
          if (fs.existsSync(dest)) onTick(fs.statSync(dest).size);
        } catch {}
      }, 500);
    }
    child.on("error", (e) => {
      if (timer) clearInterval(timer);
      reject(e);
    });
    child.on("close", (code) => {
      if (timer) clearInterval(timer);
      if (code === 0) resolve();
      else reject(new Error("curl 退出码 " + code));
    });
  });
}

/* ----------------------------------------------------------- config store */
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return {};
  }
}
function saveConfig(cfg) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), "utf8");
  } catch {}
}
function defaultOutDir() {
  const v = path.join(os.homedir(), "Videos");
  ensureDir(v);
  return v;
}

/* ------------------------------------------------ legacy proxy clean-up */
function cleanupLegacyProxy() {
  try {
    const out = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings') | ForEach-Object { "$($_.ProxyEnable)|$($_.ProxyServer)" }`,
      ],
      { encoding: "utf8", timeout: 30000, windowsHide: true }
    ).trim();
    if (out.split("|")[1] === "127.0.0.1:8080") {
      execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          `$reg='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'; Set-ItemProperty $reg ProxyEnable 0; Remove-ItemProperty $reg ProxyServer -ErrorAction SilentlyContinue; 'ok'`,
        ],
        { encoding: "utf8", timeout: 30000, windowsHide: true }
      );
      log("已清理旧版本残留的系统代理设置", "warn");
    }
  } catch {}
}

/* -------------------------------------------------- memory scan (the core) */
const SCAN_SRC = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class BSX {
  public static List<int> Find(byte[] hay, byte[] nd, int max) {
    var hits = new List<int>();
    if (nd.Length == 0 || hay.Length < nd.Length) return hits;
    int last = hay.Length - nd.Length;
    for (int i = 0; i <= last; i++) {
      if (hay[i] == nd[0]) {
        int j = 1;
        for (; j < nd.Length; j++) if (hay[i + j] != nd[j]) break;
        if (j == nd.Length) { hits.Add(i); if (hits.Count >= max) return hits; }
      }
    }
    return hits;
  }
}
public class MMX {
  [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(int a, bool i, int pid);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] public static extern int VirtualQueryEx(IntPtr h, IntPtr addr, out MBI info, int len);
  [DllImport("kernel32.dll")] public static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, int size, out int read);
  [StructLayout(LayoutKind.Sequential)]
  public struct MBI { public IntPtr BaseAddress; public IntPtr AllocationBase; public uint AllocationProtect; public IntPtr RegionSize; public uint State; public uint Protect; public uint Type; }
}
"@
$needle = [Text.Encoding]::Unicode.GetBytes('decode_key')
$procs = @(Get-Process WeChatAppEx -ErrorAction SilentlyContinue)
if ($procs.Count -eq 0) { Write-Output 'NOWECHAT'; exit 0 }
foreach ($p in $procs) {
  $h = [MMX]::OpenProcess(0x439, $false, $p.Id)
  if ($h -eq [IntPtr]::Zero) { continue }
  $addr = [IntPtr]::Zero
  while ($true) {
    $mbi = New-Object MMX+MBI
    $r = [MMX]::VirtualQueryEx($h, $addr, [ref]$mbi, [Runtime.InteropServices.Marshal]::SizeOf($mbi))
    if ($r -eq 0) { break }
    $size = [long]$mbi.RegionSize
    if ($size -le 0) { break }
    if ($size -lt 400MB -and $mbi.State -eq 0x1000 -and (($mbi.Protect -band 0xEE) -ne 0)) {
      $buf = New-Object byte[] $size
      $read = 0
      if ([MMX]::ReadProcessMemory($h, $addr, $buf, $size, [ref]$read) -and $read -gt 0) {
        $hits = [BSX]::Find($buf, $needle, 400)
        foreach ($pos in $hits) {
          # the urls sit BEFORE decode_key inside the same JSON object
          $s = [Math]::Max(0, $pos - 16000)
          $e = [Math]::Min($read - 1, $pos + 1200)
          if ($e -le $s) { continue }
          if (($e - $s) % 2 -ne 0) { $e = $e - 1 }
          $txt = [Text.Encoding]::Unicode.GetString($buf, $s, $e - $s)
          $clean = -join ($txt.ToCharArray() | ForEach-Object { if ([int]$_ -ge 32 -and [int]$_ -le 126) { $_ } else { ' ' } })
          Write-Output ("REC " + $clean)
        }
      }
    }
    $addr = [IntPtr]([long]$addr + $size)
  }
  [MMX]::CloseHandle($h) | Out-Null
}
Write-Output 'END'
`;

/**
 * Read WeChat memory and return candidate videos, newest-first.
 * @returns {{videos: Array, noWechat: boolean}}
 */
function scanWeChatVideos() {
  fs.writeFileSync(SCAN_PS1, SCAN_SRC, "utf8");
  let out = "";
  try {
    out = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SCAN_PS1],
      { encoding: "utf8", timeout: 300000, windowsHide: true, maxBuffer: 192 * 1024 * 1024 }
    );
  } catch (e) {
    out = e.stdout || "";
  }
  if (out.includes("NOWECHAT")) return { videos: [], noWechat: true };

  const urlRe = /\\?"(?:url|video_url|play_url)\\?"\s*:\s*\\?"(https:\/\/finder\.video\.qq\.com\/251\/20302\/stodownload[^"\\]*)/g;
  const tokenRe = /\\?"(?:url_token|token_url)\\?"\s*:\s*\\?"(&token=[^"\\]*)/g;
  const keyRe = /\\?"decode_key\\?"\s*:\s*\\?"?(\d{6,14})/g;
  const durRe = /\\?"duration_ms\\?"\s*:\s*(\d{3,9})/g;
  const wRe = /\\?"width\\?"\s*:\s*(\d{2,5})/g;
  const hRe = /\\?"height\\?"\s*:\s*(\d{2,5})/g;

  const videos = [];
  let order = 0;

  for (const line of out.split(/\r?\n/)) {
    if (!line.startsWith("REC ")) continue;
    const text = line.slice(4);
    order++;

    const keyM = [...text.matchAll(keyRe)];
    if (!keyM.length) continue;
    const seed = keyM[keyM.length - 1][1];
    const keyPos = keyM[keyM.length - 1].index;

    const tokenM = [...text.matchAll(tokenRe)];
    const token = tokenM.length ? tokenM[tokenM.length - 1][1].replace(/\\+$/, "") : "";

    // urls appearing BEFORE the decode_key belong to this object
    const urls = [...text.matchAll(urlRe)]
      .filter((m) => m.index < keyPos)
      .map((m) => m[1].replace(/\\+$/, ""));

    if (!urls.length) continue;

    const dur = ([...text.matchAll(durRe)].map((m) => +m[1]).pop()) || 0;
    const w = ([...text.matchAll(wRe)].map((m) => +m[1]).pop()) || 0;
    const h = ([...text.matchAll(hRe)].map((m) => +m[1]).pop()) || 0;

    // several urls = several renditions of the SAME video; keep them all as candidates
    for (const u of urls.slice(-6)) {
      const ek = u.match(/encfilekey=([^&]+)/);
      if (!ek) continue;
      let key;
      try {
        key = decodeURIComponent(ek[1]);
      } catch {
        key = ek[1];
      }
      if (key.length < 16) continue;
      videos.push({
        key,
        url: token ? u + token : u,
        seed,
        dur,
        w,
        h,
        order,
        hasToken: !!token,
      });
    }
  }

  // dedupe by encfilekey, keep the highest resolution
  const byKey = new Map();
  for (const v of videos) {
    const prev = byKey.get(v.key);
    if (!prev || v.w * v.h > prev.w * prev.h || (v.w * v.h === prev.w * prev.h && v.order > prev.order)) {
      byKey.set(v.key, v);
    }
  }
  const list = [...byKey.values()];
  // newest-first: later memory allocation = more recently touched by the player
  list.sort((a, b) => b.order - a.order);
  return { videos: list, noWechat: false };
}

/* --------------------------------------------------------- WASM decryption */
async function loadWasmModule() {
  const dirUrl = "file:///" + TOOLS.replace(/\\/g, "/") + "/";
  global.self = global;
  global.location = { href: dirUrl };
  global.document = { currentScript: { src: dirUrl + "wasm_video_decode.js" } };
  global.VTS_WASM_URL = "decoded.wasm";
  global.wasmBinary = fs.readFileSync(WASM_FILE);
  global.fetch = async () =>
    new Response(global.wasmBinary, { headers: { "content-type": "application/wasm" } });
  global.wasm_isaac_generate = (ptr, len) => {
    if (global.__isaacCb) global.__isaacCb(ptr, len);
    else throw new Error("callback not ready");
  };
  global.Module = { wasmBinary: global.wasmBinary, print: () => {}, printErr: () => {} };
  const loaderSrc = fs.readFileSync(WASM_LOADER, "utf8");
  // strict mode: indirect eval so the loader's `var Module` binds to global.Module
  (0, eval)(loaderSrc);
  return new Promise((resolve) => {
    const check = () => {
      const M = global.Module;
      if (M && M.WxIsaac64 && M.HEAPU8) resolve(M);
      else setTimeout(check, 100);
    };
    check();
    setTimeout(() => resolve(global.Module), 15000);
  });
}

/** Generate `len` keystream bytes for seed and check the MP4 'ftyp' box. */
function verifySeed(Module, head, seed, len) {
  return new Promise((resolve) => {
    try {
      let ks = null;
      global.__isaacCb = (ptr, l) => {
        ks = new Uint8Array(Module.HEAPU8.buffer, ptr, l);
      };
      const dec = new Module.WxIsaac64(String(seed));
      let settled = false;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        try {
          dec.delete();
        } catch {}
        resolve(ok);
      };
      const finish = () => {
        if (!ks || ks.length < len) {
          setTimeout(finish, 30);
          return;
        }
        const rev = new Uint8Array(ks).reverse();
        let ok = true;
        for (let i = 4; i < 8; i++) {
          if (String.fromCharCode(head[i] ^ rev[i]) !== "ftyp"[i - 4]) {
            ok = false;
            break;
          }
        }
        done(ok);
      };
      const r = dec.generate(len);
      if (r && typeof r.then === "function") r.then(() => setTimeout(finish, 30)).catch(() => done(false));
      else setTimeout(finish, 50);
      setTimeout(() => done(false), 8000);
    } catch {
      resolve(false);
    }
  });
}

function decryptHead(Module, file, seed) {
  const video = fs.readFileSync(file);
  const encBuf = video.slice(0, ENCLEN);
  return new Promise((resolve, reject) => {
    try {
      let ks = null;
      global.__isaacCb = (ptr, len) => {
        ks = new Uint8Array(Module.HEAPU8.buffer, ptr, len);
      };
      const dec = new Module.WxIsaac64(String(seed));
      let settled = false;
      const finish = () => {
        if (settled) return;
        if (!ks || ks.length < ENCLEN) {
          setTimeout(finish, 30);
          return;
        }
        settled = true;
        try {
          const rev = new Uint8Array(ks).reverse();
          for (let i = 0; i < ENCLEN; i++) video[i] = encBuf[i] ^ rev[i];
          dec.delete();
          resolve(video);
        } catch (e) {
          reject(e);
        }
      };
      const r = dec.generate(ENCLEN);
      if (r && typeof r.then === "function") r.then(() => setTimeout(finish, 30)).catch(reject);
      else setTimeout(finish, 60);
      setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error("解密超时"));
        }
      }, 15000);
    } catch (e) {
      reject(e);
    }
  });
}

/* --------------------------------------------------- runtime components DL */
async function ensureWasm() {
  if (fs.existsSync(WASM_FILE) && fs.existsSync(WASM_LOADER)) return;
  log("首次运行：下载微信视频解密模块（WASM）");
  ensureDir(path.dirname(WASM_FILE));
  const wgz = path.join(WORK, "w.bin");
  const jgz = path.join(WORK, "j.bin");
  await downloadTo(WASM_BASE + "wasm_video_decode.wasm", wgz);
  await downloadTo(WASM_BASE + "wasm_video_decode.js", jgz);
  fs.writeFileSync(WASM_FILE, zlib.gunzipSync(fs.readFileSync(wgz)));
  fs.writeFileSync(WASM_LOADER, zlib.gunzipSync(fs.readFileSync(jgz)));
  log("解密模块就绪", "ok");
}

/* ------------------------------------------------------------------- paths */
function stampName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(
    d.getMinutes()
  )}${p(d.getSeconds())}`;
}
function uniqueOutPath(dir, stamp) {
  let p = path.join(dir, `视频号_${stamp}.mp4`);
  let i = 2;
  while (fs.existsSync(p)) p = path.join(dir, `视频号_${stamp}_${i++}.mp4`);
  return p;
}

/** Pull only the first 128KB to test a link+key pair cheaply. */
function fetchHead128(url, dest) {
  const r = spawnSync(
    "curl.exe",
    ["-sSL", "-r", `0-${ENCLEN - 1}`, "--max-time", "30", "-o", dest, "-w", "%{http_code}", url],
    { encoding: "utf8", windowsHide: true, timeout: 40000 }
  );
  const code = (r.stdout || "").trim();
  const size = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
  return { code, size };
}

/* --------------------------------------------------------------- main flow */
let cfg = {};
let busy = false;

async function doDownload() {
  if (busy) {
    log("正在处理上一个任务，请稍候", "warn");
    return;
  }
  busy = true;
  const t0 = Date.now();
  let tmpFile = null;
  try {
    state("downloading", { step: 1 });
    log("[1/5] 读取微信内存（约 15 秒）…");
    const scan = scanWeChatVideos();
    if (scan.noWechat) throw new Error("没有找到微信进程，请先打开微信并播放视频号视频");

    const videos = scan.videos;
    send({ ev: "captured", count: videos.length });
    if (!videos.length) {
      throw new Error(
        "内存里没有找到视频。请先在视频号里点开视频、播放几秒（看过的拖一下进度条），再点下载。"
      );
    }
    const withToken = videos.filter((v) => v.hasToken).length;
    log(`    找到 ${videos.length} 个视频（${withToken} 个含完整播放令牌）`, "ok");

    const outDir = cfg.outDir || defaultOutDir();
    ensureDir(outDir);
    tmpFile = path.join(WORK, `dl_${Date.now()}.enc.mp4`);

    /* 2. pick a working (url, key) pair by verifying the first 128KB */
    state("downloading", { step: 2 });
    log("[2/5] 逐个校验链接与密钥…");
    const Module = await loadWasmModule();
    if (!Module || !Module.WxIsaac64) throw new Error("解密模块加载失败");

    // Skip videos already saved in earlier clicks, so each click advances to
    // the next available one instead of downloading the same file again.
    let downloaded = new Set(cfg.downloaded || []);
    let pool = videos.filter((v) => v.seed && !downloaded.has(v.key)).slice(0, 30);
    if (!pool.length) {
      downloaded = new Set();
      pool = videos.filter((v) => v.seed).slice(0, 30);
      log("    已下载过全部已知视频，重新从头开始", "warn");
    } else if (downloaded.size) {
      log(`    已跳过 ${downloaded.size} 个此前下载过的视频`, "info");
    }

    let target = null;
    for (let i = 0; i < pool.length; i++) {
      const v = pool[i];
      const tag = `${i + 1}/${pool.length} ${v.w}x${v.h} ${(v.dur / 1000).toFixed(0)}s`;
      const probe = path.join(WORK, `probe_${i}.bin`);
      const { code, size } = fetchHead128(v.url, probe);
      if (size < 1024) {
        log(`    ${tag} → HTTP ${code}，内容过小`, "warn");
        try { fs.unlinkSync(probe); } catch {}
        continue;
      }
      const head = fs.readFileSync(probe).subarray(0, ENCLEN);
      const plain = head.subarray(4, 8).toString("latin1") === "ftyp";
      const ok = plain || (await verifySeed(Module, head, v.seed, ENCLEN));
      if (ok) {
        log(`    ${tag} → ${plain ? "未加密" : "密钥匹配"} ✓`, "ok");
        target = v;
        try { fs.unlinkSync(probe); } catch {}
        break;
      }
      log(`    ${tag} → 密钥不匹配`, "warn");
      try { fs.unlinkSync(probe); } catch {}
    }
    if (!target) {
      throw new Error(
        "没有验证成功的视频。请保持视频号播放器窗口打开、视频正在播放，然后再点一次下载。"
      );
    }

    /* 3. download full file */
    state("downloading", { step: 3 });
    log(`[3/5] 下载视频 ${target.w}x${target.h}…`);
    let lastBytes = 0;
    await downloadTo(target.url, tmpFile, (bytes) => {
      if (bytes - lastBytes > 524288) {
        lastBytes = bytes;
        send({ ev: "progress", phase: "download", bytes });
        log(`    已接收 ${(bytes / 1048576).toFixed(1)} MB`);
      }
    });
    const size = fs.statSync(tmpFile).size;
    if (size < 128 * 1024) throw new Error("下载内容异常（文件过小）");
    log(`    下载完成 ${(size / 1048576).toFixed(2)} MB`, "ok");

    /* 4. decrypt */
    state("downloading", { step: 4 });
    log("[4/5] 解密视频头部…");
    const videoBuf = await decryptHead(Module, tmpFile, target.seed);

    /* 5. write */
    state("downloading", { step: 5 });
    const finalPath = uniqueOutPath(outDir, stampName());
    fs.writeFileSync(finalPath, videoBuf);
    log("[5/5] 已写出完整视频", "ok");
    busy = false;
    const cost = ((Date.now() - t0) / 1000).toFixed(1);
    cfg.downloaded = [...new Set([...(cfg.downloaded || []), target.key])].slice(-200);
    saveConfig(cfg);
    log(`✓ 完成（${cost}s）：${finalPath}`, "ok");
    state("ready");
    send({ ev: "done", file: finalPath, size });
  } catch (e) {
    busy = false;
    const msg = (e && e.message) || String(e);
    log("✗ " + msg, "err");
    state("ready");
    send({ ev: "error", msg });
  } finally {
    try {
      if (tmpFile && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    } catch {}
  }
}

/* --------------------------------------------------------------- ipc input */
process.on("message", (msg) => {
  if (!msg || !msg.cmd) return;
  switch (msg.cmd) {
    case "download":
      doDownload();
      break;
    case "scan":
      try {
        const s = scanWeChatVideos();
        send({ ev: "captured", count: s.videos.length });
      } catch {}
      break;
    case "setOutDir":
      cfg.outDir = msg.dir;
      saveConfig(cfg);
      log("输出目录已设为 " + msg.dir);
      break;
    case "shutdown":
      setTimeout(() => process.exit(0), 100);
      break;
  }
});

process.on("disconnect", () => setTimeout(() => process.exit(0), 100));
process.on("uncaughtException", (e) => log("内部错误: " + (e && e.message), "err"));

/* ------------------------------------------------------------------- boot */
async function boot() {
  cfg = loadConfig();
  if (!cfg.outDir) {
    cfg.outDir = defaultOutDir();
    saveConfig(cfg);
  }
  ensureDir(WORK);
  ensureDir(TOOLS);

  state("starting");
  log("正在准备…");
  cleanupLegacyProxy();
  await ensureWasm();
  state("ready");
  log("就绪 — 在微信里播放视频号视频，然后点「下载当前视频」", "ok");
  send({ ev: "ready", outDir: cfg.outDir });
}

boot().catch((e) => {
  const msg = (e && e.message) || String(e);
  log("启动失败: " + msg, "err");
  state("error");
  send({ ev: "error", msg });
});
