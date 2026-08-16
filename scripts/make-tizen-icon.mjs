#!/usr/bin/env node
// Rasterise public/favicon.svg into tizen/icon.png (512×512).
//
// Tizen refuses to package a widget without a PNG icon, and the brand mark only
// exists as SVG. Rather than add an image dependency for one 512px square, this
// redraws the favicon's four shapes directly — they're a background, a hairline
// border and two polygons — with 4× supersampling for clean edges, then writes
// the PNG by hand (zlib is in core; a PNG is just CRC'd chunks around a
// deflated bitmap). Re-run it whenever the mark changes.
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SIZE = 512;
const SS = 4;                 // supersampling factor
const S = SIZE * SS;
const UNIT = S / 64;          // the SVG's viewBox is 64×64

// ---- the favicon, in its own 64×64 coordinate space ----
const BG = [0x0f, 0x0f, 0x0f];
const ACCENT = [0x28, 0xbb, 0xe4];
const SPARKLE = [0x7f, 0xd8, 0xf0];

const rect = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
// stroke-width 1.5 centred on a rect inset 1.75 → a ring between 1.0 and 2.5
const border = { outer: rect(1, 1, 62, 62), inner: rect(2.5, 2.5, 59, 59), color: ACCENT, alpha: 0.22 };
const play = { poly: [[26, 21], [46, 32], [26, 43]], color: ACCENT, alpha: 1 };
// four-pointed sparkle: the relative path from the SVG, resolved to absolute
const sparkle = {
  poly: [[46.5, 12.5], [47.75, 15.75], [51, 17], [47.75, 18.25],
    [46.5, 21.5], [45.25, 18.25], [42, 17], [45.25, 15.75]],
  color: SPARKLE, alpha: 1,
};

// Even-odd point-in-polygon, in SVG units.
function inside(poly, x, y) {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

// ---- render at SS× then box-filter down ----
const big = new Float64Array(S * S * 3);
for (let py = 0; py < S; py++) {
  for (let px = 0; px < S; px++) {
    const x = (px + 0.5) / UNIT, y = (py + 0.5) / UNIT;
    let [r, g, b] = BG;
    const paint = (color, a) => { r += (color[0] - r) * a; g += (color[1] - g) * a; b += (color[2] - b) * a; };
    if (inside(border.outer, x, y) && !inside(border.inner, x, y)) paint(border.color, border.alpha);
    if (inside(play.poly, x, y)) paint(play.color, play.alpha);
    if (inside(sparkle.poly, x, y)) paint(sparkle.color, sparkle.alpha);
    const o = (py * S + px) * 3;
    big[o] = r; big[o + 1] = g; big[o + 2] = b;
  }
}

// RGBA scanlines, each prefixed with PNG filter type 0 (none)
const raw = Buffer.alloc(SIZE * (1 + SIZE * 4));
for (let y = 0; y < SIZE; y++) {
  const row = y * (1 + SIZE * 4);
  raw[row] = 0;
  for (let x = 0; x < SIZE; x++) {
    let r = 0, g = 0, b = 0;
    for (let dy = 0; dy < SS; dy++) {
      for (let dx = 0; dx < SS; dx++) {
        const o = ((y * SS + dy) * S + (x * SS + dx)) * 3;
        r += big[o]; g += big[o + 1]; b += big[o + 2];
      }
    }
    const n = SS * SS, p = row + 1 + x * 4;
    raw[p] = Math.round(r / n); raw[p + 1] = Math.round(g / n); raw[p + 2] = Math.round(b / n);
    raw[p + 3] = 255; // launcher icons are opaque squares
  }
}

// ---- minimal PNG writer ----
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 6;  // colour type: RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "tizen", "icon.png");
writeFileSync(out, png);
console.log(`wrote ${out} — ${SIZE}×${SIZE}, ${(png.length / 1024).toFixed(1)} kB`);
