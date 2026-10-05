#!/usr/bin/env node
/*
 * WeChat Channels Video Downloader (微信视频号视频下载器)
 * https://github.com/<yourname>/wechat-channels-downloader
 *
 * Flow:
 *   1. Start a local mitmproxy instance and take over the system proxy
 *   2. You play the target video in WeChat PC (Channels player)
 *   3. The real CDN URL (stodownload) is captured from the decrypted HTTPS traffic
 *   4. The file is downloaded; only its first 128KB is encrypted (X-enclen=131072)
 *   5. The Isaac64 seed (decode_key) is recovered from the WeChat player's memory
 *   6. The header is decrypted with WeChat's own WASM module -> playable MP4
 *
 * Usage:
 *   node channels_dl.js                    interactive download
 *   node channels_dl.js -o <output.mp4>    choose output file
 *   node channels_dl.js --setup            only download runtime components
 *   node channels_dl.js --test <file> --seed <n>
 *                                          verify decryption of an already
 *                                          downloaded (encrypted) file
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const zlib = require("zlib");
const { execFileSync, spawn } = require("child_process");

const VERSION = "1.0.0";
const TOOLDIR = __dirname;
const WORK = path.join(os.tmpdir(), "channels_dl_work");
const MITM_VERSION = "12.2.3";
const MITMDUMP_URL = `https://downloads.mitmproxy.org/${MITM_VERSION}/mitmproxy-${MITM_VERSION}-windows-x86_64.zip`;
const WASM_BASE = "https://aladin.wxqcloud.qq.com/aladin/ffmepeg/video-decode/1.2.46/";
const ENCLEN = 131072; // only the first 128KB of the file is encrypted (X-enclen)

const MITMDUMP = () => path.join(TOOLDIR, "tools", "mitmdump.exe");
const WASM_FILE = () => path.join(TOOLDIR, "tools", "wasm", "decoded.wasm");
const WASM_LOADER = () => path.join(TOOLDIR, "tools", "wasm", "wasm_video_decode_plain.js");
const FLOWS_LOG = path.join(WORK, "video_urls.log");
const ADDON_PY = path.join(WORK, "addon.py");
const MEMSCAN_PS1 = path.join(WORK, "memscan.ps1");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (s) => console.log(s);
const ts = () => new Date().toISOString().slice(11, 19);
const ask = (q) => new Promise((r) => {
  process.stdout.write(q);
  const onData = (d) => { process.stdin.removeListener("data", onData); if (process.stdin.isTTY) process.stdin.pause(); r(String(d).trim()); };
  if (process.stdin.isTTY) process.stdin.resume();
  process.stdin.once("data", onData);
});

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

function ps(script) {
  return execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], { encoding: "utf8", timeout: 180000 });
}
function download(url, dest) {
  execFileSync("curl.exe", ["-sSL", "-o", dest, "--max-time", "900", url], { stdio: "ignore", timeout: 920000 });
}

/* ---------------- system proxy ---------------- */
function proxyGet() {
  try {
    const out = ps(`(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings') | ForEach-Object { "$($_.ProxyEnable)|$($_.ProxyServer)" }`).trim();
    const [en, server] = out.split("|");
    return { enable: en === "1", server: server || "" };
  } catch { return { enable: false, server: "" }; }
}
function proxySet(enable, server) {
  ps(`
    $reg='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
    Set-ItemProperty $reg ProxyEnable ${enable ? 1 : 0}
    if ('${server}' -ne '') { Set-ItemProperty $reg ProxyServer '${server}' } else { Remove-ItemProperty $reg ProxyServer -ErrorAction SilentlyContinue }
    Add-Type -Namespace W -Name N -MemberDefinition '[DllImport("wininet.dll")] public static extern bool InternetSetOption(IntPtr h, int o, IntPtr b, int l);'
    [W.N]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0) | Out-Null
    [W.N]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0) | Out-Null
    'ok'
  `);
}

/* ---------------- mitmproxy CA ---------------- */
function caCertPath() { return path.join(os.homedir(), ".mitmproxy", "mitmproxy-ca-cert.cer"); }
function caInstalled() {
  try {
    const out = ps(`if (Get-ChildItem Cert:\\CurrentUser\\Root -ErrorAction SilentlyContinue | Where-Object { $_.Subject -match 'mitmproxy' }) { 'yes' } else { 'no' }`).trim();
    return out === "yes";
  } catch { return false; }
}
function caInstall() {
  if (!fs.existsSync(caCertPath())) throw new Error("mitmproxy CA not found; run the tool once to generate it first");
  ps(`Import-Certificate -FilePath '${caCertPath()}' -CertStoreLocation Cert:\\CurrentUser\\Root | Out-Null; 'ok'`);
}

/* ---------------- mitmdump ---------------- */
const ADDON_SRC = `
import re
OUT = r"${FLOWS_LOG.replace(/\\/g, "\\\\")}"
PAT = re.compile(r"stodownload.*(X-snsvideoflag|fexam=1)", re.I)
def request(flow):
    try:
        u = flow.request.pretty_url
        if "stodownload" in u and PAT.search(u):
            with open(OUT, "a", encoding="utf-8") as f:
                f.write(u + "\\n")
    except Exception:
        pass
`;

function killMitmdump() {
  try { execFileSync("taskkill", ["/IM", "mitmdump.exe", "/F"], { stdio: "ignore" }); } catch {}
}
function startMitmdump(exe) {
  fs.writeFileSync(ADDON_PY, ADDON_SRC, "utf8");
  return spawn(exe, [
    "--listen-port", "8080",
    "--set", "ssl_insecure",
    "--set", "stream_large_bodies=100k",
    "-s", ADDON_PY,
    "-w", path.join(WORK, "flows.mitm"),
  ], { stdio: "ignore", windowsHide: true });
}

/* ---------------- runtime component download ---------------- */
function ensureMitmdump() {
  const exe = MITMDUMP();
  if (fs.existsSync(exe)) return exe;
  log(`    首次运行：下载 mitmproxy v${MITM_VERSION}（约 27MB，仅需一次）...`);
  const zip = path.join(WORK, "mitmproxy.zip");
  download(MITMDUMP_URL, zip);
  ps(`Expand-Archive -Path '${zip}' -DestinationPath '${path.join(WORK, "mitm")}' -Force; New-Item -ItemType Directory -Force -Path '${path.join(TOOLDIR, "tools")}' | Out-Null; Copy-Item '${path.join(WORK, "mitm", "mitmdump.exe")}' '${exe}' -Force`);
  if (!fs.existsSync(exe)) throw new Error("mitmdump.exe 解压失败");
  return exe;
}
function ensureWasm() {
  const wasm = WASM_FILE();
  const loader = WASM_LOADER();
  if (fs.existsSync(wasm) && fs.existsSync(loader)) return;
  log("    首次运行：下载微信视频解密模块（WASM）...");
  ensureDir(path.dirname(wasm));
  const wgz = path.join(WORK, "w.bin");
  const jgz = path.join(WORK, "j.bin");
  download(WASM_BASE + "wasm_video_decode.wasm", wgz);
  download(WASM_BASE + "wasm_video_decode.js", jgz);
  fs.writeFileSync(wasm, zlib.gunzipSync(fs.readFileSync(wgz)));
  fs.writeFileSync(loader, zlib.gunzipSync(fs.readFileSync(jgz)));
}

/* ---------------- memory scan for the seed ---------------- */
const MEMSCAN_SRC = `
param([string]$needle)
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class BS {
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
public class MM {
  [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(int a, bool i, int pid);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] public static extern int VirtualQueryEx(IntPtr h, IntPtr addr, out MBI info, int len);
  [DllImport("kernel32.dll")] public static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, int size, out int read);
  [StructLayout(LayoutKind.Sequential)]
  public struct MBI { public IntPtr BaseAddress; public IntPtr AllocationBase; public uint AllocationProtect; public IntPtr RegionSize; public uint State; public uint Protect; public uint Type; }
}
"@
$needleA = [Text.Encoding]::ASCII.GetBytes($needle)
$dkA = [Text.Encoding]::ASCII.GetBytes('decode_key')
$dkU = [Text.Encoding]::Unicode.GetBytes('decode_key')
$cands = New-Object 'System.Collections.Generic.HashSet[string]'
$procs = Get-Process WeChatAppEx,Weixin -ErrorAction SilentlyContinue
foreach ($p in $procs) {
  $h = [MM]::OpenProcess(0x439, $false, $p.Id)
  if ($h -eq [IntPtr]::Zero) { continue }
  $addr = [IntPtr]::Zero
  while ($true) {
    $mbi = New-Object MM+MBI
    $r = [MM]::VirtualQueryEx($h, $addr, [ref]$mbi, [Runtime.InteropServices.Marshal]::SizeOf($mbi))
    if ($r -eq 0) { break }
    $size = [long]$mbi.RegionSize
    if ($size -le 0) { break }
    if ($size -lt 400MB -and $mbi.State -eq 0x1000 -and (($mbi.Protect -band 0xEE) -ne 0)) {
      $buf = New-Object byte[] $size
      $read = 0
      if ([MM]::ReadProcessMemory($h, $addr, $buf, $size, [ref]$read) -and $read -gt 0) {
        $hits = [BS]::Find($buf, $needleA, 60)
        foreach ($pos in $hits) {
          $wStart = [Math]::Max(0, $pos - 1500)
          $wEnd = [Math]::Min($read, $pos + 9000)
          if ($wEnd -le $wStart) { continue }
          $w = $buf[$wStart..($wEnd-1)]
          $rel = $pos - $wStart
          # 1) decode_key adjacent to the URL (ascii / utf16)
          $dkHits = [BS]::Find($w, $dkA, 20)
          foreach ($d in $dkHits) {
            $seg = [Text.Encoding]::ASCII.GetString($w, $d, [Math]::Min(80, $w.Length - $d))
            if ($seg -match 'decode_key[\\"]*[:=]+[\\"]*(\d{6,12})') { [void]$cands.Add($Matches[1]) }
          }
          $dkU = [BS]::Find($w, $dkU, 20)
          foreach ($d in $dkU) {
            $seg = [Text.Encoding]::Unicode.GetString($w, $d, [Math]::Min(120, $w.Length - $d))
            if ($seg -match 'decode_key[\\"]*[:=]+[\\"]*(\d{6,12})') { [void]$cands.Add($Matches[1]) }
          }
          # 2) digit runs after the URL (seed is a decimal string)
          if ($rel -lt $w.Length) {
            $after = [Text.Encoding]::ASCII.GetString($w, $rel, $w.Length - $rel)
            $ms = [regex]::Matches($after, '(?<![0-9])(\d{8,12})(?![0-9])')
            foreach ($m in $ms) { [void]$cands.Add($m.Groups[1].Value) }
          }
        }
      }
    }
    $addr = [IntPtr]([long]$addr + $size)
  }
  [MM]::CloseHandle($h) | Out-Null
}
$cands | ForEach-Object { Write-Output ("CAND " + $_) }
`;

function scanMemoryForSeeds(encfilekeyPrefix) {
  fs.writeFileSync(MEMSCAN_PS1, MEMSCAN_SRC, "utf8");
  let out = "";
  try {
    out = execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", MEMSCAN_PS1, "-needle", encfilekeyPrefix], { encoding: "utf8", timeout: 300000 });
  } catch (e) {
    out = (e.stdout || "");
  }
  return [...new Set(out.split(/\r?\n/).filter(l => l.startsWith("CAND ")).map(l => l.slice(5).trim()))];
}

/* ---------------- WASM decryption ---------------- */
function loadWasmModule() {
  const dirUrl = "file:///" + TOOLDIR.replace(/\\/g, "/") + "/";
  global.self = global;
  global.location = { href: dirUrl };
  global.document = { currentScript: { src: dirUrl + "wasm_video_decode.js" } };
  global.VTS_WASM_URL = "decoded.wasm";
  global.wasmBinary = fs.readFileSync(WASM_FILE());
  global.fetch = async () => new Response(global.wasmBinary, { headers: { "content-type": "application/wasm" } });
  global.wasm_isaac_generate = (ptr, len) => {
    if (global.__isaacCb) global.__isaacCb(ptr, len);
    else throw new Error("callback not ready");
  };
  global.Module = { wasmBinary: global.wasmBinary, print: () => {}, printErr: () => {} };
  const loaderSrc = fs.readFileSync(WASM_LOADER(), "utf8");
  eval(loaderSrc); // defines eval-scope Module with WxIsaac64
  return new Promise((resolve) => {
    const check = () => {
      if (typeof Module !== "undefined" && Module.WxIsaac64 && Module.HEAPU8) resolve(Module);
      else setTimeout(check, 100);
    };
    check();
    setTimeout(() => resolve(Module), 15000);
  });
}

function xorCheck(Module, encHead, seed) {
  return new Promise((resolve) => {
    try {
      let ks = null;
      global.__isaacCb = (ptr, len) => { ks = new Uint8Array(Module.HEAPU8.buffer, ptr, len); };
      const dec = new Module.WxIsaac64(String(seed));
      let settled = false;
      const done = (ok) => { if (settled) return; settled = true; try { dec.delete(); } catch {} resolve(ok); };
      const finish = () => {
        if (!ks || ks.length < ENCLEN) { setTimeout(finish, 30); return; }
        const rev = new Uint8Array(ks).reverse();
        let ok = true;
        for (let i = 4; i < 8; i++) if (String.fromCharCode(encHead[i] ^ rev[i]) !== "ftyp"[i - 4]) { ok = false; break; }
        done(ok);
      };
      const r = dec.generate(ENCLEN);
      if (r && typeof r.then === "function") r.then(() => setTimeout(finish, 30)).catch(() => done(false));
      else setTimeout(finish, 50);
      setTimeout(() => done(false), 8000);
    } catch { resolve(false); }
  });
}

function decryptHead(Module, file, seed) {
  const video = fs.readFileSync(file);
  const encBuf = video.slice(0, ENCLEN);
  return new Promise((resolve, reject) => {
    try {
      let ks = null;
      global.__isaacCb = (ptr, len) => { ks = new Uint8Array(Module.HEAPU8.buffer, ptr, len); };
      const dec = new Module.WxIsaac64(String(seed));
      let settled = false;
      const finish = () => {
        if (settled) return;
        if (!ks || ks.length < ENCLEN) { setTimeout(finish, 30); return; }
        settled = true;
        try {
          const rev = new Uint8Array(ks).reverse();
          for (let i = 0; i < ENCLEN; i++) video[i] = encBuf[i] ^ rev[i];
          dec.delete();
          resolve(video);
        } catch (e) { reject(e); }
      };
      const r = dec.generate(ENCLEN);
      if (r && typeof r.then === "function") r.then(() => setTimeout(finish, 30)).catch(reject);
      else setTimeout(finish, 60);
      setTimeout(() => { if (!settled) { settled = true; reject(new Error("decrypt timeout")); } }, 15000);
    } catch (e) { reject(e); }
  });
}

/* ---------------- cleanup on exit ---------------- */
let mitmChild = null;
let proxyChanged = false;
let savedProxy = null;
function cleanup() {
  try { if (mitmChild) mitmChild.kill(); } catch {}
  try { execFileSync("taskkill", ["/IM", "mitmdump.exe", "/F"], { stdio: "ignore" }); } catch {}
  if (proxyChanged && savedProxy) {
    proxyChanged = false;
    try { proxySet(savedProxy.enable, savedProxy.server); } catch {}
  }
}
process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));

/* ---------------- main ---------------- */
async function main() {
  const argv = process.argv.slice(2);
  let output = null, testFile = null, directSeed = null, setupOnly = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "-o") output = argv[++i];
    else if (argv[i] === "--test") testFile = argv[++i];
    else if (argv[i] === "--seed") directSeed = argv[++i];
    else if (argv[i] === "--setup") setupOnly = true;
  }
  ensureDir(WORK);

  log("==============================================");
  log(`  WeChat Channels Downloader v${VERSION}`);
  log("==============================================");
  if (process.platform !== "win32") { log("This tool requires Windows + WeChat PC."); process.exit(1); }

  // runtime components
  log(`[${ts()}] 0/6 准备运行组件 (mitmproxy / WASM)...`);
  const mitmdumpExe = ensureMitmdump();
  ensureWasm();

  if (setupOnly) {
    log(`[${ts()}] ✓ 组件就绪，配置完成。`);
    process.exit(0);
  }

  if (testFile) {
    await doTest(testFile, directSeed);
    return;
  }

  // CA
  log(`[${ts()}] 1/6 检查抓包证书...`);
  killMitmdump();
  if (!fs.existsSync(caCertPath())) {
    const tmp = spawn(mitmdumpExe, ["--listen-port", "8081"], { stdio: "ignore", windowsHide: true });
    await sleep(2500);
    try { execFileSync("taskkill", ["/PID", String(tmp.pid), "/F"], { stdio: "ignore" }); } catch {}
  }
  if (!caInstalled()) {
    log(`    首次使用：安装本地抓包根证书（仅当前用户，用于解密微信自身 HTTPS 流量）...`);
    caInstall();
    log(`    证书已安装。`);
  } else {
    log(`    证书已就绪。`);
  }

  // proxy + mitmdump
  log(`[${ts()}] 2/6 启动本地抓包代理 (127.0.0.1:8080)...`);
  fs.existsSync(FLOWS_LOG) && fs.unlinkSync(FLOWS_LOG);
  mitmChild = startMitmdump(mitmdumpExe);
  await sleep(2000);
  savedProxy = proxyGet();
  if (!savedProxy.enable || savedProxy.server !== "127.0.0.1:8080") {
    proxySet(true, "127.0.0.1:8080");
    proxyChanged = true;
  }

  // wait for the user to play the video
  log(`[${ts()}] 3/6 请现在在微信里打开你要下载的视频号视频：`);
  log(`           点开聊天里的视频号卡片（或从视频号里进入），`);
  log(`           让它播放几秒钟；如果之前看过，请拖动一下进度条。`);
  const videoUrls = new Set();
  let videoUrl = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 8 * 60 * 1000) {
    if (fs.existsSync(FLOWS_LOG)) {
      for (const line of fs.readFileSync(FLOWS_LOG, "utf8").split(/\r?\n/)) {
        if (line.startsWith("https") && !videoUrls.has(line)) {
          videoUrls.add(line);
          videoUrl = line;
          log(`[${ts()}]    已捕获视频地址 (${videoUrls.size})`);
        }
      }
    }
    if (videoUrls.size > 0) {
      const lastTime = fs.statSync(FLOWS_LOG).mtimeMs;
      if (Date.now() - lastTime > 8000) break; // 8s without new URLs = buffered
    }
    await sleep(1000);
  }
  cleanup();

  if (!videoUrl) {
    log(`[${ts()}] ✗ 等待超时，没有捕获到视频地址。`);
    log(`   请确认：微信已登录、视频确实在播放、8080 端口没有被其他代理占用。`);
    process.exit(2);
  }

  // download
  const encfilekey = (videoUrl.match(/encfilekey=([^&]+)/) || [])[1] || "";
  const encPrefix = decodeURIComponent(encfilekey).slice(0, 24);
  if (!output) {
    const flag = (videoUrl.match(/X-snsvideoflag=([^&]+)/) || [])[1] || "video";
    output = path.join(os.homedir(), "Videos", `视频号_${flag}_${Date.now()}.mp4`);
    ensureDir(path.dirname(output));
  }
  log(`[${ts()}] 4/6 下载视频 (encfilekey=${encPrefix}...)`);
  const curlArgs = ["-s", "-L", "-o", output, "--max-time", "900"];
  if (fs.existsSync(output) && fs.statSync(output).size > 0) curlArgs.push("-C", "-");
  curlArgs.push(videoUrl);
  execFileSync("curl.exe", curlArgs, { stdio: "ignore", timeout: 920000 });
  log(`[${ts()}]    已下载 ${(fs.statSync(output).size / 1048576).toFixed(2)} MB -> ${output}`);

  // seed hunt (with retries: the player process must still be alive)
  log(`[${ts()}] 5/6 从微信进程内存搜索解密种子 (decode_key)...`);
  const encBuf = fs.readFileSync(output).slice(0, ENCLEN);
  const Module = await loadWasmModule();
  let seed = null;
  for (let attempt = 1; attempt <= 3 && !seed; attempt++) {
    let candidates = scanMemoryForSeeds(encPrefix);
    for (const m of videoUrl.matchAll(/(?:svrnonce|_pUid_)=?-?(\d{8,12})/g)) candidates.push(m[1]);
    candidates = [...new Set(candidates)].filter(s => /^\d{6,12}$/.test(s)).slice(0, 60);
    if (candidates.length === 0) {
      log(`    第 ${attempt} 次扫描没有找到候选种子。`);
      if (attempt < 3) {
        log(`    请确认视频号播放器窗口还开着（可以先暂停），`);
        await ask("    然后按回车重新扫描...");
      }
      continue;
    }
    log(`    找到 ${candidates.length} 个候选种子，逐一验证...`);
    for (const c of candidates) {
      process.stdout.write(`    尝试 ${c} ... `);
      const ok = await xorCheck(Module, encBuf, c);
      log(ok ? "✓ 匹配！" : "✗");
      if (ok) { seed = c; break; }
    }
    if (!seed && attempt < 3) {
      log(`    都不匹配。请保持视频号播放器窗口打开，`);
      await ask("    然后按回车重新扫描...");
    }
  }
  if (directSeed && !seed) {
    process.stdout.write(`    尝试手动指定种子 ${directSeed} ... `);
    const ok = await xorCheck(Module, encBuf, directSeed);
    log(ok ? "✓ 匹配！" : "✗");
    if (ok) seed = directSeed;
  }
  if (!seed) {
    log(`[${ts()}] ✗ 未找到匹配的种子。`);
    log(`   最常见原因：播放器窗口已关闭（内存被释放）。请保持视频号窗口打开后重试。`);
    process.exit(4);
  }
  log(`    解密种子 = ${seed}`);

  // decrypt
  log(`[${ts()}] 6/6 解密前 128KB 并写出完整视频...`);
  const dec = await decryptHead(Module, output, seed);
  const finalPath = output.replace(/\.mp4$/i, "") + "_完整.mp4";
  fs.writeFileSync(finalPath, dec);
  log("==============================================");
  log(`✓ 完成！文件：${finalPath}`);
  log("==============================================");
  process.exit(0);
}

async function doTest(testFile, directSeed) {
  log(`[测试模式] 对 ${testFile} 执行 种子搜索 + 解密验证`);
  const buf = fs.readFileSync(testFile);
  const encBuf = buf.slice(0, ENCLEN);
  if (encBuf.slice(4, 8).toString("latin1") === "ftyp") {
    log("该文件头部已是明文 ftyp，无需解密。");
    return;
  }
  const Module = await loadWasmModule();
  let cands = [];
  const encPrefix = process.env.DL_KEY || "";
  if (encPrefix) cands = scanMemoryForSeeds(encPrefix);
  if (directSeed) cands.push(directSeed);
  cands = [...new Set(cands)].filter(s => /^\d{6,12}$/.test(s));
  log(`候选种子 ${cands.length} 个: ${cands.join(", ")}`);
  for (const c of cands.slice(0, 60)) {
    process.stdout.write(`尝试 ${c} ... `);
    const ok = await xorCheck(Module, encBuf, c);
    log(ok ? "✓ 匹配！" : "✗");
    if (ok) {
      const dec = await decryptHead(Module, testFile, c);
      const out = testFile.replace(/\.mp4$/i, "") + "_完整.mp4";
      fs.writeFileSync(out, dec);
      log(`✓ 解密完成: ${out}  (seed=${c})`);
      return;
    }
  }
  log("✗ 未找到匹配种子。");
  process.exit(4);
}

main().catch((e) => { log("出错: " + (e && e.message)); process.exit(1); });
