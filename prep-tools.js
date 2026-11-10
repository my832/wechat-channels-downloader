"use strict";
/* Pre-fetch runtime components (mitmdump.exe + WeChat WASM decoder) so the
 * first app launch is instant. Mirrors engine.js ensureMitmdump/ensureWasm. */

const fs = require("fs");
const path = require("path");
const os = require("os");
const zlib = require("zlib");
const { execFileSync } = require("child_process");

const MITM_VERSION = "12.2.3";
const MITMDUMP_URL = `https://downloads.mitmproxy.org/${MITM_VERSION}/mitmproxy-${MITM_VERSION}-windows-x86_64.zip`;
const WASM_BASE = "https://aladin.wxqcloud.qq.com/aladin/ffmepeg/video-decode/1.2.46/";

const TOOLS =
  process.argv[2] ||
  path.join(process.env.APPDATA || os.homedir(), "wechat-channels-downloader", "tools");
const WORK = path.join(os.tmpdir(), "channels_dl_prep");

fs.mkdirSync(TOOLS, { recursive: true });
fs.mkdirSync(WORK, { recursive: true });

function curl(url, dest) {
  execFileSync("curl.exe", ["-sSL", "--max-time", "600", "-o", dest, url], {
    stdio: "inherit",
    timeout: 620000,
  });
  const sz = fs.statSync(dest).size;
  if (sz < 1024) throw new Error("download too small: " + url);
  return sz;
}

(async () => {
  const exe = path.join(TOOLS, "mitmdump.exe");
  if (fs.existsSync(exe)) {
    console.log("mitmdump.exe already present");
  } else {
    console.log("downloading mitmproxy " + MITM_VERSION + " ...");
    const zip = path.join(WORK, "mitm.zip");
    console.log("  bytes:", curl(MITMDUMP_URL, zip));
    const out = path.join(WORK, "mitm");
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(out, { recursive: true });
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `Expand-Archive -Path '${zip}' -DestinationPath '${out}' -Force`,
      ],
      { stdio: "inherit", windowsHide: true }
    );
    fs.copyFileSync(path.join(out, "mitmdump.exe"), exe);
    console.log("mitmdump.exe ->", exe, fs.statSync(exe).size, "bytes");
  }

  const wasmDir = path.join(TOOLS, "wasm");
  fs.mkdirSync(wasmDir, { recursive: true });
  const wasmFile = path.join(wasmDir, "decoded.wasm");
  const loaderFile = path.join(wasmDir, "wasm_video_decode_plain.js");
  if (fs.existsSync(wasmFile) && fs.existsSync(loaderFile)) {
    console.log("wasm decoder already present");
  } else {
    console.log("downloading wasm decoder ...");
    const wgz = path.join(WORK, "w.bin");
    const jgz = path.join(WORK, "j.bin");
    console.log("  wasm bytes:", curl(WASM_BASE + "wasm_video_decode.wasm", wgz));
    console.log("  js   bytes:", curl(WASM_BASE + "wasm_video_decode.js", jgz));
    fs.writeFileSync(wasmFile, zlib.gunzipSync(fs.readFileSync(wgz)));
    fs.writeFileSync(loaderFile, zlib.gunzipSync(fs.readFileSync(jgz)));
    console.log("decoded.wasm ->", fs.statSync(wasmFile).size, "bytes");
  }
  console.log("DONE");
})().catch((e) => {
  console.error("PREP FAILED:", e.message);
  process.exit(1);
});
