"use strict";
/*
 * WeChat Channels Downloader - resident engine (memory-read edition)
 *
 * Original capture/decrypt research: my832/wechat-channels-downloader (MIT).
 *
 * ARCHITECTURE NOTE
 * -----------------
 * The original tool hijacked the *system* proxy (HKCU Internet Settings) and
 * installed a mitmproxy root CA to sniff HTTPS. That means every other app on
 * the machine is dragged through it, and it fights with Clash / other proxies
 * over the same registry key.
 *
 * This build removes all of that. The stodownload URL and the isaac64 seed both
 * live in plain sight inside the WeChat player's own process memory, so we just
 * read them:
 *
 *   read WeChat memory -> parse stodownload URL + decode_key
 *   -> curl download -> WASM keystream -> XOR first 128KB -> playable MP4
 *
 * Consequences: no system proxy, no root certificate, no network capture, and
 * nothing outside WeChat is touched.
 *
 * IPC protocol (process.send / process.on("message")):
 *   out: { ev: "state"|"log"|"captured"|"progress"|"done"|"error" }
 *   in : { cmd: "download" | "scan" | "setOutDir" | "shutdown" }
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const zlib = require("zlib");
const { execFileSync, spawn } = require("child_process");

const ENCLEN = 131072;
const WASM_BASE = "https://aladin.wxqcloud.qq.com/aladin/ffmepeg/video-decode/1.2.46/";

const ROOT = __dirname;
const TOOLS = process.env.WXDL_TOOLS || path.join(ROOT, "tools");
const WORK = path.join(os.tmpdir(), "channels_dl_work");
const WASM_FILE = path.join(TOOLS, "wasm", "decoded.wasm");
const WASM_LOADER = path.join(TOOLS, "wasm", "wasm_video_decode_plain.js");
const SCAN_PS1 = path.join(WORK, "scan_wechat.ps1");
const CONFIG_FILE = process.env.WXDL_CONFIG || path.join(ROOT, "config.json");

/* ------------------------------------------------------------------ utils */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

function ps(script) {
  return execFileSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
    { encoding: "utf8", timeout: 180000, windowsHide: true }
  );
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
/**
 * Earlier builds of this app pointed the whole machine at 127.0.0.1:8080.
 * If that residue is still around (crash / forced kill), the machine looks
 * offline. Undo it once, then never touch the registry again.
 */
function cleanupLegacyProxy() {
  try {
    const out = ps(
      `(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings') | ForEach-Object { "$($_.ProxyEnable)|$($_.ProxyServer)" }`
    ).trim();
    const [en, server] = out.split("|");
    if (server === "127.0.0.1:8080") {
      ps(`
        $reg='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
        $saved = ${JSON.stringify(loadConfig().proxyState || {})}
        Set-ItemProperty $reg ProxyEnable 0
        Remove-ItemProperty $reg ProxyServer -ErrorAction SilentlyContinue
        Add-Type -Namespace W -Name N -MemberDefinition '[DllImport("wininet.dll")] public static extern bool InternetSetOption(IntPtr h, int o, IntPtr b, int l);'
        [W.N]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0) | Out-Null
        [W.N]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0) | Out-Null
        'ok'
      `);
      log("已清理旧版本残留的系统代理设置（不会再有第二次）", "warn");
    }
    const cfg = loadConfig();
    if (cfg.proxyState) {
      delete cfg.proxyState;
      saveConfig(cfg);
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
public class BSW {
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
public class MMW {
  [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(int a, bool i, int pid);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] public static extern int VirtualQueryEx(IntPtr h, IntPtr addr, out MBI info, int len);
  [DllImport("kernel32.dll")] public static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, int size, out int read);
  [StructLayout(LayoutKind.Sequential)]
  public struct MBI { public IntPtr BaseAddress; public IntPtr AllocationBase; public uint AllocationProtect; public IntPtr RegionSize; public uint State; public uint Protect; public uint Type; }
}
"@
$needle = [Text.Encoding]::ASCII.GetBytes('stodownload')
# URL-safe charset used by the CDN link
$urlPat = 'https://[A-Za-z0-9\.\-/_%\?=&\:;,\+~\$@!\*''\(\)]+stodownload[A-Za-z0-9\.\-/_%\?=&\:;,\+~\$@!\*''\(\)]*'
$dkPat  = 'decode_key[\\"]*[:=]+[\\"]*(\d{6,12})'

$targets = @()
foreach ($n in @('WeChatAppEx','Weixin','WeChat')) {
  $targets += Get-Process $n -ErrorAction SilentlyContinue
}
if ($targets.Count -eq 0) { Write-Output 'NOWECHAT'; exit 0 }

$playerHit = $false
foreach ($p in $targets) {
  # once the Channels player itself yielded links, the main-process caches are
  # just history noise -> don't even read them
  if ($playerHit -and $p.ProcessName -ne 'WeChatAppEx') { continue }
  $h = [MMW]::OpenProcess(0x439, $false, $p.Id)
  if ($h -eq [IntPtr]::Zero) { continue }
  $addr = [IntPtr]::Zero
  while ($true) {
    $mbi = New-Object MMW+MBI
    $r = [MMW]::VirtualQueryEx($h, $addr, [ref]$mbi, [Runtime.InteropServices.Marshal]::SizeOf($mbi))
    if ($r -eq 0) { break }
    $size = [long]$mbi.RegionSize
    if ($size -le 0) { break }
    if ($size -lt 400MB -and $mbi.State -eq 0x1000 -and (($mbi.Protect -band 0xEE) -ne 0)) {
      $buf = New-Object byte[] $size
      $read = 0
      if ([MMW]::ReadProcessMemory($h, $addr, $buf, $size, [ref]$read) -and $read -gt 0) {
        $hits = [BSW]::Find($buf, $needle, 40)
        foreach ($pos in $hits) {
          $s = [Math]::Max(0, $pos - 500)
          $e = [Math]::Min($read - 1, $pos + 4000)
          if ($e -le $s) { continue }
          $txt = [Text.Encoding]::ASCII.GetString($buf, $s, $e - $s)
          foreach ($m in [regex]::Matches($txt, $urlPat)) {
            Write-Output ("URL " + $p.ProcessName + " " + $m.Value)
            if ($p.ProcessName -eq 'WeChatAppEx') { $playerHit = $true }
          }
          foreach ($m in [regex]::Matches($txt, $dkPat)) {
            Write-Output ("SEED " + $p.ProcessName + " " + $m.Groups[1].Value)
          }
        }
      }
    }
    $addr = [IntPtr]([long]$addr + $size)
  }
  [MMW]::CloseHandle($h) | Out-Null
}
Write-Output 'SCANDONE'
`;

/**
 * Read WeChat memory once and pull out every stodownload URL plus seed candidates.
 * @returns {{urls: Array<{proc:string,url:string}>, seeds: string[]}}
 */
function scanWeChatMemory() {
  fs.writeFileSync(SCAN_PS1, SCAN_SRC, "utf8");
  let out = "";
  try {
    out = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SCAN_PS1],
      { encoding: "utf8", timeout: 300000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }
    );
  } catch (e) {
    out = e.stdout || "";
  }
  if (out.includes("NOWECHAT")) return { noWechat: true, urls: [], seeds: [] };

  const urls = [];
  const seeds = [];
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith("URL ")) {
      const rest = line.slice(4);
      const sp = rest.indexOf(" ");
      if (sp < 0) continue;
      urls.push({ proc: rest.slice(0, sp), url: rest.slice(sp + 1).trim() });
    } else if (line.startsWith("SEED ")) {
      const rest = line.slice(5);
      const sp = rest.indexOf(" ");
      if (sp < 0) continue;
      seeds.push(rest.slice(sp + 1).trim());
    }
  }
  return { urls, seeds, noWechat: false };
}

/** Memory buffers can cut a %XX escape in half — never let that throw. */
function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
/** Drop a dangling "%" or "%A" left over from a truncated buffer read. */
function cleanUrl(u) {
  return u.replace(/%[0-9A-Fa-f]?$/, "");
}

/** Group URLs by encfilekey (one key = one video, many byte-range segments). */
function collectVideos(scan) {
  const map = new Map();
  let idx = 0;
  for (const { proc, url } of scan.urls) {
    idx++;
    const clean = cleanUrl(url);
    const m = clean.match(/encfilekey=([^&]+)/);
    if (!m) continue; // truncated fragment, not a usable link
    const key = safeDecode(m[1]);
    if (key.length < 16) continue;
    const isPlayer = /WeChatAppEx/i.test(proc);
    const prev = map.get(key);
    if (!prev) {
      map.set(key, { key, url: clean, proc, player: isPlayer, hits: 1, idx });
    } else {
      prev.hits++;
      prev.idx = idx;
      // prefer a link from the player process, and the longest (most complete) one
      if ((isPlayer && !prev.player) || clean.length > prev.url.length) {
        prev.url = clean;
        prev.proc = proc;
        prev.player = prev.player || isPlayer;
      }
    }
  }
  // player-sourced first; among those, the highest memory address (= most
  // recently allocated) is the best guess for "what is playing right now"
  return [...map.values()].sort(
    (a, b) => (b.player ? 1 : 0) - (a.player ? 1 : 0) || b.idx - a.idx
  );
}

/** Cheap liveness probe: pull the first 1KB and see if the CDN still serves it. */
function probeUrl(url) {
  return new Promise((resolve) => {
    const probe = path.join(WORK, `probe_${Date.now()}.bin`);
    const child = spawn(
      "curl.exe",
      ["-sSL", "-r", "0-1023", "--max-time", "10", "-o", probe, "-w", "%{http_code}", url],
      { windowsHide: true }
    );
    let code = "";
    child.stdout.on("data", (d) => (code += d.toString()));
    child.on("error", () => resolve(false));
    child.on("close", () => {
      let ok = false;
      try {
        const size = fs.existsSync(probe) ? fs.statSync(probe).size : 0;
        ok = size >= 256 && /^(200|206)$/.test(code.trim());
      } catch {}
      try {
        if (fs.existsSync(probe)) fs.unlinkSync(probe);
      } catch {}
      resolve(ok);
    });
  });
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
  // strict-mode file: direct eval would scope `var Module` away, so use the
  // indirect form which binds the loader's Module to global.Module.
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

function xorCheck(Module, encHead, seed) {
  return new Promise((resolve) => {
    try {
      let ks = null;
      global.__isaacCb = (ptr, len) => {
        ks = new Uint8Array(Module.HEAPU8.buffer, ptr, len);
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
        if (!ks || ks.length < ENCLEN) {
          setTimeout(finish, 30);
          return;
        }
        const rev = new Uint8Array(ks).reverse();
        let ok = true;
        for (let i = 4; i < 8; i++) {
          if (String.fromCharCode(encHead[i] ^ rev[i]) !== "ftyp"[i - 4]) {
            ok = false;
            break;
          }
        }
        done(ok);
      };
      const r = dec.generate(ENCLEN);
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

/* --------------------------------------------------------------- main flow */
let cfg = {};
let busy = false;
let lastScan = null;

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
    log("[1/5] 读取微信内存，定位正在播放的视频…（约 10 秒）");
    const scan = scanWeChatMemory();
    if (scan.noWechat) throw new Error("没有找到微信进程，请先打开微信并播放视频号视频");

    const videos = collectVideos(scan);
    lastScan = videos;
    send({ ev: "captured", count: videos.length });
    if (!videos.length) {
      throw new Error(
        "微信内存里没有找到视频地址。请先在视频号里点开视频并播放几秒（看过的拖一下进度条），再点下载。"
      );
    }

    /* Memory keeps history; only the freshest links still answer. Probe, then
     * verify the payload really is a video before committing to it. */
    state("downloading", { step: 2 });
    const outDir = cfg.outDir || defaultOutDir();
    ensureDir(outDir);
    tmpFile = path.join(WORK, `dl_${Date.now()}.enc.mp4`);

    log(`    内存中找到 ${videos.length} 个链接，正在找还活着的那一条…`);
    let target = null;
    let size = 0;
    const pool = videos.slice(0, 8);
    for (let i = 0; i < pool.length; i++) {
      const c = pool[i];
      const tag = `${i + 1}/${pool.length} ${c.key.slice(0, 10)}…`;
      if (!(await probeUrl(c.url))) {
        log(`    ${tag} 已失效`, "warn");
        continue;
      }
      let lastBytes = 0;
      try {
        await downloadTo(c.url, tmpFile, (bytes) => {
          if (bytes - lastBytes > 262144) {
            lastBytes = bytes;
            send({ ev: "progress", phase: "download", bytes });
          }
        });
      } catch (e) {
        log(`    ${tag} 下载失败：${e.message}`, "warn");
        continue;
      }
      const sz = fs.existsSync(tmpFile) ? fs.statSync(tmpFile).size : 0;
      if (sz < 200 * 1024) {
        log(`    ${tag} 内容异常（只有 ${(sz / 1024).toFixed(0)} KB），换下一个`, "warn");
        continue;
      }
      target = c;
      size = sz;
      log(`    ${tag} 有效 ✓`, "ok");
      break;
    }
    if (!target) {
      throw new Error(
        "内存里的视频链接都已失效或内容异常。请在微信里重新点开这个视频、播放几秒，然后马上再点下载。"
      );
    }
    const encPrefix = target.key.slice(0, 24);
    log(`    目标 encfilekey=${encPrefix.slice(0, 12)}…（来源 ${target.proc}）`, "ok");
    log(`    下载完成 ${(size / 1048576).toFixed(2)} MB`, "ok");

    const head = fs.readFileSync(tmpFile).subarray(0, ENCLEN);
    if (head.subarray(4, 8).toString("latin1") === "ftyp") {
      log("    该视频未加密，直接输出", "ok");
      const finalPath = uniqueOutPath(outDir, stampName());
      fs.copyFileSync(tmpFile, finalPath);
      finish(finalPath, size, t0);
      return;
    }

    /* 3. seed */
    state("downloading", { step: 3 });
    log("[3/5] 校验内存中的解密种子…");
    const Module = await loadWasmModule();
    if (!Module || !Module.WxIsaac64) throw new Error("解密模块加载失败");

    let seed = null;
    let cands = [...new Set([...scan.seeds, ...(cfg.lastSeeds || [])])].filter((s) =>
      /^\d{6,12}$/.test(s)
    );
    for (const m of target.url.matchAll(/(?:svrnonce|_pUid_|uzid)=?-?(\d{8,12})/g)) cands.push(m[1]);
    cands = [...new Set(cands)].slice(0, 80);
    log(`    候选种子 ${cands.length} 个，逐一验证…`);
    for (let i = 0; i < cands.length; i++) {
      send({ ev: "progress", phase: "seed", current: i + 1, total: cands.length });
      if (cands.length > 10 && i % 5 === 0) log(`    验证中 ${i + 1}/${cands.length}`);
      if (await xorCheck(Module, head, cands[i])) {
        seed = cands[i];
        break;
      }
    }
    if (!seed) {
      throw new Error(
        "没有验证出解密种子。请保持视频号播放器窗口打开（不要关闭），重新播放一下视频再点下载。"
      );
    }
    log(`    种子 = ${seed}`, "ok");

    /* 4. decrypt */
    state("downloading", { step: 4 });
    log("[4/5] 解密视频头部…");
    const video = await decryptHead(Module, tmpFile, seed);

    /* 5. write */
    state("downloading", { step: 5 });
    const finalPath = uniqueOutPath(outDir, stampName());
    fs.writeFileSync(finalPath, video);
    log("[5/5] 已写出完整视频", "ok");
    finish(finalPath, size, t0);
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

function finish(finalPath, size, t0) {
  busy = false;
  const t = ((Date.now() - t0) / 1000).toFixed(1);
  log(`✓ 完成（${t}s）：${finalPath}`, "ok");
  state("ready");
  send({ ev: "done", file: finalPath, size });
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
        const scan = scanWeChatMemory();
        const videos = collectVideos(scan);
        send({ ev: "captured", count: videos.length });
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

process.on("disconnect", () => {
  setTimeout(() => process.exit(0), 100);
});
process.on("uncaughtException", (e) => {
  log("内部错误: " + (e && e.message), "err");
});

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
