"use strict";
/* Inject the app icon + version metadata into the built exe (rcedit CLI).
 * Needed because the build disables electron-builder's own sign/edit step. */

const path = require("path");
const fs = require("fs");
const { execFileSync } = require("child_process");

const exe =
  process.argv[2] || path.join(__dirname, "dist", "win-unpacked", "WeChatChannelsDownloader.exe");
const ico = path.join(__dirname, "assets", "icon.ico");
const rcedit = path.join(__dirname, "node_modules", "rcedit", "bin", "rcedit-x64.exe");

for (const f of [exe, ico, rcedit]) {
  if (!fs.existsSync(f)) {
    console.error("missing:", f);
    process.exit(1);
  }
}

const before = fs.statSync(exe).size;

const args = [
  exe,
  "--set-icon",
  ico,
  "--set-file-version",
  "1.0.0.0",
  "--set-product-version",
  "1.0.0.0",
  "--set-version-string",
  "CompanyName",
  "Personal Backup Tools",
  "--set-version-string",
  "FileDescription",
  "视频号视频下载器",
  "--set-version-string",
  "ProductName",
  "视频号下载器",
  "--set-version-string",
  "InternalName",
  "WeChatChannelsDownloader",
  "--set-version-string",
  "OriginalFilename",
  "WeChatDownloader.exe",
  "--set-version-string",
  "LegalCopyright",
  "MIT License",
];

try {
  const out = execFileSync(rcedit, args, { encoding: "utf8", windowsHide: true });
  if (out && out.trim()) console.log(out.trim());
  console.log("icon applied ->", exe);
  console.log("exe size", before, "->", fs.statSync(exe).size);
} catch (e) {
  console.error("rcedit failed:", e.message);
  if (e.stderr) console.error(String(e.stderr).slice(0, 500));
  process.exit(1);
}
