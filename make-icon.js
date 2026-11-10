"use strict";
/* Generates assets/icon.png (256) and assets/icon.ico (multi-size) with zero deps. */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const OUT_DIR = path.join(__dirname, "assets");

/* ------------------------------------------------------------------ crc32 */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePNG(rgba, w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ drawing */
// Draw at 4x then box-downsample for cheap antialiasing.
function render(size) {
  const SS = 4;
  const S = size * SS;
  const acc = new Float64Array(size * size * 4);

  const radius = S * 0.225;
  const cx = S / 2;
  const cy = S / 2;
  const half = S / 2;

  const c1 = [59, 116, 245];
  const c2 = [123, 88, 240];

  // rounded-rect signed distance
  function inRoundRect(x, y) {
    const dx = Math.abs(x - cx) - (half - radius);
    const dy = Math.abs(y - cy) - (half - radius);
    const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
    return outside - radius <= 0;
  }

  // arrow geometry (relative units of S)
  const shaftHalf = S * 0.047;
  const shaftTop = S * 0.185;
  const shaftBottom = S * 0.5;
  const headHalf = S * 0.132;
  const headTop = S * 0.455;
  const tipY = S * 0.685;
  const barY0 = S * 0.775;
  const barY1 = S * 0.855;
  const barHalf = S * 0.185;

  function inArrow(x, y) {
    // vertical shaft
    if (Math.abs(x - cx) <= shaftHalf && y >= shaftTop && y <= shaftBottom) return true;
    // triangle head
    if (y >= headTop && y <= tipY) {
      const t = (y - headTop) / (tipY - headTop); // 0..1
      const w = headHalf * (1 - t);
      if (Math.abs(x - cx) <= w) return true;
    }
    // bottom bar: capsule = distance to its centerline segment
    const rr = (barY1 - barY0) / 2;
    const cyBar = (barY0 + barY1) / 2;
    const x0 = cx - (barHalf - rr);
    const x1 = cx + (barHalf - rr);
    const nx = Math.min(Math.max(x, x0), x1);
    if (Math.hypot(x - nx, y - cyBar) <= rr) return true;
    return false;
  }

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      let r = 0, g = 0, b = 0, a = 0;
      if (inRoundRect(px, py)) {
        const t = Math.min(1, Math.max(0, (px / S) * 0.45 + (py / S) * 0.55));
        r = c1[0] + (c2[0] - c1[0]) * t;
        g = c1[1] + (c2[1] - c1[1]) * t;
        b = c1[2] + (c2[2] - c1[2]) * t;
        a = 255;
        if (inArrow(px, py)) {
          r = 255; g = 255; b = 255;
        } else {
          // subtle top-left sheen
          const sh = 1 + 0.1 * (1 - (px + py) / (2 * S));
          r = Math.min(255, r * sh);
          g = Math.min(255, g * sh);
          b = Math.min(255, b * sh);
        }
      }
      // premultiply for correct downsampling of edges
      const ox = (x / SS) | 0;
      const oy = (y / SS) | 0;
      const idx = (oy * size + ox) * 4;
      acc[idx] += r * (a / 255);
      acc[idx + 1] += g * (a / 255);
      acc[idx + 2] += b * (a / 255);
      acc[idx + 3] += a;
    }
  }

  const out = Buffer.alloc(size * size * 4);
  const n = SS * SS;
  for (let i = 0; i < size * size; i++) {
    const a = acc[i * 4 + 3] / n;
    const af = a / 255 || 1;
    out[i * 4] = Math.min(255, Math.round(acc[i * 4] / n / af));
    out[i * 4 + 1] = Math.min(255, Math.round(acc[i * 4 + 1] / n / af));
    out[i * 4 + 2] = Math.min(255, Math.round(acc[i * 4 + 2] / n / af));
    out[i * 4 + 3] = Math.round(a);
  }
  return out;
}

/* -------------------------------------------------------------------- build */
fs.mkdirSync(OUT_DIR, { recursive: true });

const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = sizes.map((s) => ({ size: s, data: encodePNG(render(s), s, s) }));

// main png
fs.writeFileSync(path.join(OUT_DIR, "icon.png"), pngs[pngs.length - 1].data);

// ico (PNG-compressed entries, Vista+)
const entries = pngs;
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(entries.length, 4);
let offset = 6 + entries.length * 16;
const dir = Buffer.alloc(entries.length * 16);
entries.forEach((e, i) => {
  const b = i * 16;
  dir[b] = e.size >= 256 ? 0 : e.size;
  dir[b + 1] = e.size >= 256 ? 0 : e.size;
  dir[b + 2] = 0;
  dir[b + 3] = 0;
  dir.writeUInt16LE(1, b + 4);
  dir.writeUInt16LE(32, b + 6);
  dir.writeUInt32LE(e.data.length, b + 8);
  dir.writeUInt32LE(offset, b + 12);
  offset += e.data.length;
});
fs.writeFileSync(
  path.join(OUT_DIR, "icon.ico"),
  Buffer.concat([header, dir, ...entries.map((e) => e.data)])
);

console.log("icon.png + icon.ico written to", OUT_DIR);
