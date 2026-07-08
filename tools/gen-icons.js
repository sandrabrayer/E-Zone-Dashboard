/* Self-contained PWA icon generator for the E-Zone Dashboard.
 *
 * Builds the installed-app icons from the ORIGINAL E-Zone brand logo (the
 * stylised "e" wordmark shared with ezone-outpatient) rather than drawing a
 * letter from scratch. The source PNGs in tools/brand-logo/ are the byte-exact
 * copies recovered from git history (dark #071410 background, #29d488 logo).
 *
 * Pipeline, per source icon:
 *   1. decode the source RGBA PNG (built-in inflate; filters 0-4);
 *   2. flatten over the dark background so the result is fully opaque;
 *   3. RECOLOUR by pixel blend-remap — every pixel is a blend of the dark
 *      background B and the green logo G, so we recover the logo coverage
 *      t ∈ [0,1] from the (dominant) green channel and repaint it as
 *      B·(1−t) + BLUE·t. Shape and anti-aliasing are preserved exactly; only
 *      the hue changes (green → #0055ff).
 *   4. add a white CONTOUR HALO: dilate the logo's own coverage mask by
 *      RING_F·N (≈2% of the canvas ≈10px @512, ≈4px @192) via an exact
 *      Euclidean distance transform, and paint that ring white BENEATH the
 *      blue logo, so the halo follows the logo's exact contour (anti-aliased,
 *      not a box).
 *
 *   background : #071410 (original dark, fully opaque, every pixel)
 *   logo       : #0055ff (recoloured from the original #29d488)
 *   outline    : #ffffff halo hugging the logo contour
 *
 * No canvas / sharp / new dependency — only Node built-ins (`fs`, `zlib`), with
 * a hand-rolled PNG reader + writer (CRC32 chunks, deflate/inflate IDAT).
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
const LOGO_SRC = [0x29, 0xd4, 0x88]; // #29d488 original green logo
const FG = [0x00, 0x55, 0xff]; // #0055ff recoloured logo
const OUTLINE = [0xff, 0xff, 0xff]; // #ffffff halo

const RING_F = 0.02; // white halo ≈ 2% of canvas (≈10px @512, ≈4px @192)

// ---- minimal PNG reader (built-ins only) -----------------------------------
function decodePng(buf) {
  let o = 8, w = 0, h = 0;
  const idat = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o);
    const type = buf.toString('ascii', o + 4, o + 8);
    const data = buf.slice(o + 8, o + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    o += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * 4;
  const px = Buffer.alloc(w * h * 4);
  let pos = 0;
  for (let y = 0; y < h; y++) {
    const ft = raw[pos++];
    for (let x = 0; x < stride; x++) {
      const a = raw[pos + x];
      const bpp = 4;
      const left = x >= bpp ? px[y * stride + x - bpp] : 0;
      const up = y > 0 ? px[(y - 1) * stride + x] : 0;
      const ul = (x >= bpp && y > 0) ? px[(y - 1) * stride + x - bpp] : 0;
      let v;
      switch (ft) {
        case 0: v = a; break;
        case 1: v = a + left; break;
        case 2: v = a + up; break;
        case 3: v = a + ((left + up) >> 1); break;
        case 4: {
          const p = left + up - ul;
          const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - ul);
          const pr = (pa <= pb && pa <= pc) ? left : (pb <= pc ? up : ul);
          v = a + pr; break;
        }
        default: v = a;
      }
      px[y * stride + x] = v & 255;
    }
    pos += stride;
  }
  return { w, h, px };
}

// ---- exact Euclidean distance transform (Felzenszwalb & Huttenlocher) ------
// 1-D squared-distance transform of a sampled function f over n points.
function edt1d(f, n) {
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
  return d;
}

// Squared EDT of a binary mask (1 = seed). Returns Float64Array of squared
// distances from every cell to the nearest seed cell.
function edt2d(mask, w, h) {
  const INF = 1e20;
  const g = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = mask[i] ? 0 : INF;
  // columns
  const col = new Float64Array(h);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) col[y] = g[y * w + x];
    const d = edt1d(col, h);
    for (let y = 0; y < h; y++) g[y * w + x] = d[y];
  }
  // rows
  const row = new Float64Array(w);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) row[x] = g[y * w + x];
    const d = edt1d(row, w);
    for (let x = 0; x < w; x++) g[y * w + x] = d[x];
  }
  return g;
}

// ---- recolour + halo one icon ----------------------------------------------
function build(srcBuf, ring) {
  const { w, h, px } = decodePng(srcBuf);
  const n = w * h;
  const denom = LOGO_SRC[1] - BG[1]; // green channel spread (dominant axis)

  // 1-2-3: flatten over BG and recover logo coverage t per pixel.
  const t = new Float32Array(n);
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const a = px[i * 4 + 3] / 255;
    // flatten over the dark background → opaque green-on-dark value
    const fg = px[i * 4 + 1] * a + BG[1] * (1 - a); // green channel only (needed for t)
    let tt = (fg - BG[1]) / denom; // linear un-blend along B→G
    if (tt < 0) tt = 0; else if (tt > 1) tt = 1;
    t[i] = tt;
    if (tt >= 0.5) mask[i] = 1;
  }

  // 4: dilate the logo mask by `ring` via exact EDT → anti-aliased halo.
  const dist2 = edt2d(mask, w, h);
  const out = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    const d = Math.sqrt(dist2[i]);
    // 1px-wide anti-aliased ring edge: full inside ring, 0 past it.
    let halo = ring + 0.5 - d;
    if (halo < 0) halo = 0; else if (halo > 1) halo = 1;
    const tt = t[i];
    for (let c = 0; c < 3; c++) {
      let v = BG[c];
      v = v * (1 - halo) + OUTLINE[c] * halo; // white halo over dark bg
      v = v * (1 - tt) + FG[c] * tt; // blue logo over halo
      out[i * 4 + c] = Math.round(v);
    }
    out[i * 4 + 3] = 255; // fully opaque
  }
  return { w, h, out };
}

// ---- minimal PNG writer (built-ins only) -----------------------------------
const CRC_TABLE = (() => {
  const tbl = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    tbl[n] = c;
  }
  return tbl;
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

function encodePng(w, h, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter 0 (none)
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

// ---- colored-ink report (logo-presence sanity check) -----------------------
function inkCoverage(rgba, n) {
  let ink = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    // "ink" = meaningfully blue logo body (low red + high blue); excludes the
    // dark #071410 background (low blue) and the white #ffffff halo (high red).
    if (rgba[i] < 160 && rgba[i + 2] > 200) ink++;
  }
  return ink / n;
}

// ---- emit ------------------------------------------------------------------
const srcDir = path.join(__dirname, 'brand-logo');
const outDir = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(outDir, { recursive: true });

const targets = ['icon-192.png', 'icon-512.png', 'icon-maskable-512.png'];

for (const file of targets) {
  const srcBuf = fs.readFileSync(path.join(srcDir, file));
  const N = decodePng(srcBuf).w; // square icons
  const ring = RING_F * N;
  const { w, h, out } = build(srcBuf, ring);
  fs.writeFileSync(path.join(outDir, file), encodePng(w, h, out));
  const cov = inkCoverage(out, w * h);
  console.log(
    `${file}: ${w}x${h} ring=${ring.toFixed(1)}px  logo-ink=${(cov * 100).toFixed(1)}%`
  );
}
console.log('done.');
