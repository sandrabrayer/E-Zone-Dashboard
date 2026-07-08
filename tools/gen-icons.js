/* Self-contained PWA icon generator for the E-Zone Dashboard.
 *
 * Draws a BOLD geometric letter "E" from scratch (four axis-aligned bars:
 * a thick vertical spine plus top / middle / bottom arms) on the original dark
 * brand background, wraps it in a white contour halo, and rasterises the whole
 * thing with supersampled anti-aliasing. No canvas, sharp, or any other
 * dependency — only Node built-ins (`fs`, `zlib`), using a hand-rolled PNG
 * writer (CRC32 chunks + deflate IDAT).
 *
 *   background : #071410 (original dark, fully opaque, every pixel)
 *   letter     : #0055ff
 *   outline    : #ffffff — a halo that follows the glyph's EXACT contour
 *
 * The white halo is the glyph's own coverage mask DILATED by RING_F·N (≈2% of
 * the canvas ≈ 10 px @512, ≈ 4 px @192) and painted beneath the blue glyph, so
 * it hugs the letter's outline (rounded at corners, anti-aliased) rather than
 * being a rectangular box. Dilation is done with a true Euclidean distance
 * field to the union of the bars, so the ring width is uniform along the
 * contour.
 *
 * Geometry (fractions of the canvas edge N):
 *   stroke  ≈ 0.19 · N   (≈18-20% of canvas height — heavy, blocky strokes)
 *   height  ≈ 0.68 · N   (E fills ~65-70% of the canvas)
 *   width   ≈ 0.56 · N
 *   ring    ≈ 0.02 · N   (white halo thickness)
 *   centred on the canvas.
 *
 * The maskable variant scales the whole glyph by MASK_SAFE (0.74) so the glyph
 * plus its halo sit inside Android's mask safe zone; the padding it leaves is
 * the opaque dark background, so no pixel is ever transparent (no "cropped"
 * border).
 *
 * Run:  node tools/gen-icons.js
 * Writes public/icons/icon-192.png, icon-512.png, icon-maskable-512.png.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---- palette ---------------------------------------------------------------
const BG = [0x07, 0x14, 0x10]; // #071410 original dark background (opaque)
const FG = [0x00, 0x55, 0xff]; // #0055ff bold blue letter
const OUTLINE = [0xff, 0xff, 0xff]; // #ffffff halo

// ---- glyph geometry (fractions of canvas edge) -----------------------------
const STROKE_F = 0.19; // stroke thickness ≈ 19% of canvas height
const HEIGHT_F = 0.68; // E bounding-box height ≈ 68% of canvas
const WIDTH_F = 0.56; // E bounding-box width  ≈ 56% of canvas
const RING_F = 0.02; // white halo ≈ 2% of canvas (≈10px @512, ≈4px @192)
const MASK_SAFE = 0.74; // maskable glyph shrink so glyph+halo stay in safe zone
const SS = 6; // supersampling grid per axis (6×6 samples/pixel)

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

/* Euclidean distance from point (x, y) to the union of `rects` (0 when the
 * point is inside any rect). Distance to a single axis-aligned rect is the
 * length of the componentwise overshoot outside it; the union is the min. This
 * is what makes the dilated halo follow the exact contour with rounded corners
 * instead of forming a box. */
function distToRects(x, y, rects) {
  let best = Infinity;
  for (let r = 0; r < rects.length; r++) {
    const [x0, y0, x1, y1] = rects[r];
    const dx = Math.max(x0 - x, 0, x - x1);
    const dy = Math.max(y0 - y, 0, y - y1);
    const d = dx === 0 && dy === 0 ? 0 : Math.hypot(dx, dy);
    if (d < best) best = d;
    if (best === 0) break; // inside a rect — can't get closer
  }
  return best;
}

/* Render an N×N RGBA buffer: dark background, white halo (glyph dilated by
 * `ring`), blue glyph on top. `scale` shrinks the glyph+halo. Both the glyph
 * edge and the halo edge are anti-aliased by SS×SS supersampling. */
function render(N, scale) {
  const rects = eRects(N, scale);
  const ring = RING_F * N; // halo thickness stays ≈2% of the canvas
  const buf = Buffer.alloc(N * N * 4);
  const samples = SS * SS;

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let glyphHits = 0; // subsamples inside the letter
      let haloHits = 0; // subsamples inside the dilated (glyph+ring) mask
      for (let sy = 0; sy < SS; sy++) {
        const py = y + (sy + 0.5) / SS;
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const d = distToRects(px, py, rects);
          if (d === 0) glyphHits++;
          if (d <= ring) haloHits++;
        }
      }
      const glyphCov = glyphHits / samples;
      const haloCov = haloHits / samples;

      // Composite: bg → white·haloCov → blue·glyphCov. alpha always opaque.
      const i = (y * N + x) * 4;
      for (let c = 0; c < 3; c++) {
        let v = BG[c];
        v = v * (1 - haloCov) + OUTLINE[c] * haloCov; // white halo over bg
        v = v * (1 - glyphCov) + FG[c] * glyphCov; // blue glyph over halo
        buf[i + c] = Math.round(v);
      }
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
    // "ink" = meaningfully blue (letter body, not white halo / dark bg).
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
    `${t.file}: ${t.N}x${t.N} scale=${t.scale} ring=${(RING_F * t.N).toFixed(1)}px  ink=${(cov * 100).toFixed(1)}%`
  );
}
console.log('done.');
