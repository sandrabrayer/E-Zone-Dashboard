/* Self-contained PWA icon generator for the E-Zone Dashboard.
 *
 * Draws a BOLD geometric letter "E" from scratch (four axis-aligned bars:
 * a thick vertical spine plus top / middle / bottom arms) and rasterises it
 * with supersampled anti-aliasing onto an opaque white canvas. No canvas,
 * sharp, or any other dependency — only Node built-ins (`fs`, `zlib`), using a
 * hand-rolled PNG writer (CRC32 chunks + deflate IDAT).
 *
 *   background : #ffffff (fully opaque, every pixel)
 *   letter     : #2962ff
 *
 * Geometry (fractions of the canvas edge N):
 *   stroke  ≈ 0.19 · N   (≈18-20% of canvas height — heavy, blocky strokes)
 *   height  ≈ 0.68 · N   (E fills ~65-70% of the canvas)
 *   width   ≈ 0.56 · N
 *   centred on the canvas.
 *
 * The maskable variant scales the whole glyph by MASK_SAFE (0.74) so all
 * strokes sit inside Android's mask safe zone; the padding it leaves is the
 * white background, so no pixel is ever transparent (no "cropped" border).
 *
 * Run:  node tools/gen-icons.js
 * Writes public/icons/icon-192.png, icon-512.png, icon-maskable-512.png.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---- palette ---------------------------------------------------------------
const BG = [0xff, 0xff, 0xff]; // #ffffff opaque white
const FG = [0x29, 0x62, 0xff]; // #2962ff bold blue

// ---- glyph geometry (fractions of canvas edge) -----------------------------
const STROKE_F = 0.19; // stroke thickness ≈ 19% of canvas height
const HEIGHT_F = 0.68; // E bounding-box height ≈ 68% of canvas
const WIDTH_F = 0.56; // E bounding-box width  ≈ 56% of canvas
const MASK_SAFE = 0.74; // maskable glyph shrink so strokes stay in safe zone
const SS = 4; // supersampling grid per axis (4×4 samples/pixel)

/* Build the four rectangles [x0, y0, x1, y1] (in pixels) that compose the E,
 * centred on an N×N canvas, optionally scaled by `scale` (for the maskable
 * variant). Returns rects in pixel space. */
function eRects(N, scale) {
  const stroke = STROKE_F * N * scale;
  const height = HEIGHT_F * N * scale;
  const width = WIDTH_F * N * scale;

  const left = (N - width) / 2;
  const top = (N - height) / 2;
  const right = left + width;
  const bottom = top + height;
  const midY0 = top + (height - stroke) / 2;

  return [
    [left, top, left + stroke, bottom], // spine (full height)
    [left, top, right, top + stroke], // top arm
    [left, midY0, right, midY0 + stroke], // middle arm
    [left, bottom - stroke, right, bottom], // bottom arm
  ];
}

/* Coverage of pixel (px, py) by the union of `rects`, sampled on an SS×SS
 * grid → anti-aliased edges. Returns a value in [0, 1]. */
function coverage(px, py, rects) {
  let hits = 0;
  for (let sy = 0; sy < SS; sy++) {
    const y = py + (sy + 0.5) / SS;
    for (let sx = 0; sx < SS; sx++) {
      const x = px + (sx + 0.5) / SS;
      for (let r = 0; r < rects.length; r++) {
        const [x0, y0, x1, y1] = rects[r];
        if (x >= x0 && x < x1 && y >= y0 && y < y1) {
          hits++;
          break; // union — one hit is enough for this sample
        }
      }
    }
  }
  return hits / (SS * SS);
}

/* Render an N×N RGBA buffer of the E. `scale` shrinks the glyph. */
function render(N, scale) {
  const rects = eRects(N, scale);
  const buf = Buffer.alloc(N * N * 4);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const cov = coverage(x, y, rects);
      const i = (y * N + x) * 4;
      // white·(1−cov) + blue·cov, rounded; alpha always fully opaque.
      buf[i] = Math.round(BG[0] * (1 - cov) + FG[0] * cov);
      buf[i + 1] = Math.round(BG[1] * (1 - cov) + FG[1] * cov);
      buf[i + 2] = Math.round(BG[2] * (1 - cov) + FG[2] * cov);
      buf[i + 3] = 255;
    }
  }
  return buf;
}

// ---- minimal PNG writer (built-ins only) -----------------------------------
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
  let c = ~0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (~c) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(N, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(N, 0);
  ihdr.writeUInt32BE(N, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  // filter byte 0 (none) per scanline
  const stride = N * 4;
  const raw = Buffer.alloc((stride + 1) * N);
  for (let y = 0; y < N; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- ink-coverage report (boldness sanity check) ---------------------------
function inkCoverage(N, rgba) {
  let ink = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    // "ink" = meaningfully blue (more than half covered by the letter).
    if (rgba[i] < 160 && rgba[i + 2] > 200) ink++;
  }
  return ink / (N * N);
}

// ---- emit ------------------------------------------------------------------
const outDir = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(outDir, { recursive: true });

const targets = [
  { file: 'icon-192.png', N: 192, scale: 1 },
  { file: 'icon-512.png', N: 512, scale: 1 },
  { file: 'icon-maskable-512.png', N: 512, scale: MASK_SAFE },
];

for (const t of targets) {
  const rgba = render(t.N, t.scale);
  fs.writeFileSync(path.join(outDir, t.file), encodePng(t.N, rgba));
  const cov = inkCoverage(t.N, rgba);
  console.log(
    `${t.file}: ${t.N}x${t.N} scale=${t.scale}  ink=${(cov * 100).toFixed(1)}%`
  );
}
console.log('done.');
