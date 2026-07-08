/* Tests for the PWA foundation (PR 1): the manifest is a valid, complete
 * web-app manifest, and the service worker's cache policy is correct —
 * specifically that patient-data requests ("sheets" / the /api path) are
 * NEVER cached and that the cache name is versioned.
 *
 * public/sw.js is a browser Service Worker: its top level calls
 * self.addEventListener(...) and touches `caches`, so it can't be `require`d
 * in Node. Following the repo's vm-sandbox convention (see
 * breakeven-revenue.test.js), we read the source and evaluate it in a vm
 * context with the SW globals stubbed, then read the shouldCache() decision
 * function and the cache-name constants off the module.exports the file
 * assigns for exactly this purpose. This exercises the REAL shipped code. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadSw() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'sw.js'),
    'utf8'
  );

  const noop = () => {};
  const moduleObj = { exports: {} };
  const sandbox = {
    // Service Worker global surface — stubbed so the top-level listener
    // registrations and skipWaiting/clients.claim don't throw.
    self: {
      addEventListener: noop,
      skipWaiting: noop,
      clients: { claim: noop },
    },
    caches: {
      open: () => Promise.resolve({ add: noop, put: noop }),
      keys: () => Promise.resolve([]),
      match: () => Promise.resolve(undefined),
      delete: () => Promise.resolve(true),
    },
    Promise,
    URL,
    console: { log: noop, warn: noop, error: noop },
    module: moduleObj,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return moduleObj.exports;
}

const sw = loadSw();

/* ---------- manifest.json ---------- */

function loadManifest() {
  const raw = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'manifest.json'),
    'utf8'
  );
  return JSON.parse(raw); // throws (fails the test) if not valid JSON
}

test('manifest.json is valid JSON with the required PWA fields', () => {
  const m = loadManifest();
  assert.strictEqual(m.name, 'E-Zone Dashboard');
  // Icon rebrand: short_name shortened to "Dashboard" (full name unchanged).
  assert.strictEqual(m.short_name, 'Dashboard');
  assert.strictEqual(m.display, 'standalone');
  assert.strictEqual(m.dir, 'rtl');
  assert.strictEqual(m.lang, 'he');
  assert.strictEqual(m.start_url, '/');
  // theme + background colors must be present (palette match asserted loosely)
  assert.match(m.theme_color, /^#[0-9a-fA-F]{6}$/);
  assert.match(m.background_color, /^#[0-9a-fA-F]{6}$/);
});

test('manifest declares 192, 512 and a maskable icon', () => {
  const m = loadManifest();
  assert.ok(Array.isArray(m.icons) && m.icons.length >= 3);
  const bySize = {};
  m.icons.forEach((ic) => { bySize[ic.sizes] = (bySize[ic.sizes] || []).concat(ic); });
  assert.ok(bySize['192x192'], 'has a 192x192 icon');
  assert.ok(bySize['512x512'], 'has a 512x512 icon');
  const maskable = m.icons.filter((ic) => (ic.purpose || '').indexOf('maskable') !== -1);
  assert.ok(maskable.length >= 1, 'has at least one maskable icon');
  m.icons.forEach((ic) => assert.strictEqual(ic.type, 'image/png'));
});

test('every manifest icon file exists on disk', () => {
  const m = loadManifest();
  m.icons.forEach((ic) => {
    const p = path.join(__dirname, '..', 'public', ic.src.replace(/^\//, ''));
    assert.ok(fs.existsSync(p), 'missing icon file: ' + ic.src);
  });
});

/* ---------- service worker: cache name versioning ---------- */

test('cache name is versioned and carries the version string', () => {
  assert.ok(sw.CACHE_VERSION, 'CACHE_VERSION is exported');
  assert.match(sw.CACHE_VERSION, /^v\d+$/, 'version looks like v<N>');
  assert.ok(
    sw.CACHE_NAME.indexOf(sw.CACHE_VERSION) !== -1,
    'CACHE_NAME embeds CACHE_VERSION so bumping the version invalidates old caches'
  );
  assert.match(sw.CACHE_NAME, /^ezone-dashboard-v\d+$/);
});

test('cache version is at or above the v4 floor (never regresses)', () => {
  // Each icon change must advance the SW cache version so stale icons are
  // evicted on activate. This is a FLOOR, not an exact lock: the version may go
  // higher on later changes, but must never drop below v4 (the #2962ff bold-E
  // rebrand), so an accidental revert to an older cached icon set fails loudly.
  const n = Number(String(sw.CACHE_VERSION).replace(/^v/, ''));
  assert.ok(Number.isInteger(n), 'CACHE_VERSION looks like v<N>');
  assert.ok(n >= 4, 'CACHE_VERSION ' + sw.CACHE_VERSION + ' is below the v4 floor');
  assert.strictEqual(sw.CACHE_NAME, 'ezone-dashboard-' + sw.CACHE_VERSION);
});

/* ---------- service worker: sheets / data exclusion ---------- */

test('shouldCache is NETWORK-ONLY (false) for any URL containing "sheets"', () => {
  assert.strictEqual(sw.shouldCache('https://app.test/api/sheets'), false);
  assert.strictEqual(sw.shouldCache('https://app.test/api/sheets?action=getData'), false);
  assert.strictEqual(sw.shouldCache('https://app.test/sheets'), false);
  // even a would-be static path is refused if "sheets" appears anywhere
  assert.strictEqual(sw.shouldCache('https://app.test/icons/sheets.png'), false);
});

test('shouldCache is NETWORK-ONLY (false) for any /api/ request', () => {
  assert.strictEqual(sw.shouldCache('https://app.test/api/verify-pin'), false);
  assert.strictEqual(sw.shouldCache('https://app.test/api/outpatient-lead'), false);
  assert.strictEqual(sw.shouldCache('https://app.test/api/debug/env'), false);
});

test('shouldCache is CACHE-FIRST (true) for versioned static assets', () => {
  assert.strictEqual(sw.shouldCache('https://app.test/app.js'), true);
  assert.strictEqual(sw.shouldCache('https://app.test/app.js?v=1751900000-abc123'), true);
  assert.strictEqual(sw.shouldCache('https://app.test/style.css'), true);
  assert.strictEqual(sw.shouldCache('https://app.test/manifest.json'), true);
  assert.strictEqual(sw.shouldCache('https://app.test/icons/icon-192.png'), true);
  assert.strictEqual(sw.shouldCache('https://app.test/icons/icon-maskable-512.png'), true);
});

test('shouldCache is NOT cache-first for the shell (network-first handled separately)', () => {
  // "/" and "/index.html" are served network-first in the fetch handler, so
  // shouldCache must return false for them — otherwise they'd be cache-first
  // and could be served stale after a deploy.
  assert.strictEqual(sw.shouldCache('https://app.test/'), false);
  assert.strictEqual(sw.shouldCache('https://app.test/index.html'), false);
});

/* ---------- icon rebrand: palette of the generated PNGs ---------- */

// Minimal 8-bit RGBA, non-interlaced PNG decoder (built-ins only) so the tests
// can assert the ACTUAL pixels of the regenerated icons — not just that files
// exist. Mirrors the decode step of the self-contained generator.
function decodePng(file) {
  const zlib = require('node:zlib');
  const b = fs.readFileSync(file);
  let o = 8, w = 0, h = 0;
  const idat = [];
  while (o < b.length) {
    const len = b.readUInt32BE(o);
    const type = b.toString('ascii', o + 4, o + 8);
    const data = b.slice(o + 8, o + 8 + len);
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

const REBRAND_ICONS = ['icon-192.png', 'icon-512.png', 'icon-maskable-512.png'];

test('rebrand icons have a fully-opaque white background (maskable safe zone included)', () => {
  REBRAND_ICONS.forEach((name) => {
    const { w, h, px } = decodePng(path.join(__dirname, '..', 'public', 'icons', name));
    // Corner (top-left) is always background: must be pure white + opaque.
    assert.deepStrictEqual([px[0], px[1], px[2], px[3]], [255, 255, 255, 255], name + ' corner');
    // No pixel may be even partially transparent — a transparent maskable safe
    // zone would read as cropped on Android's mask.
    let nonOpaque = 0;
    for (let i = 3; i < px.length; i += 4) if (px[i] !== 255) nonOpaque++;
    assert.strictEqual(nonOpaque, 0, name + ' has ' + nonOpaque + ' non-opaque px');
  });
});

test('rebrand icons use the #2962ff letter and drop the superseded colors', () => {
  REBRAND_ICONS.forEach((name) => {
    const { px } = decodePng(path.join(__dirname, '..', 'public', 'icons', name));
    let letter = 0, stale = 0;
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i], g = px[i + 1], b = px[i + 2];
      if (r === 0x29 && g === 0x62 && b === 0xff) letter++;
      // superseded letter colors that must be fully gone: the old green
      // #2dd47a (41,212,136) and the interim blue #5b8bff (91,139,255).
      const nearGreen = Math.abs(r - 41) < 12 && Math.abs(g - 212) < 12 && Math.abs(b - 136) < 12;
      const nearInterim = r === 0x5b && g === 0x8b && b === 0xff;
      if (nearGreen || nearInterim) stale++;
    }
    assert.ok(letter > 0, name + ' contains #2962ff letter pixels');
    assert.strictEqual(stale, 0, name + ' still has ' + stale + ' superseded-color px');
  });
});

test('icons are BOLD — letter ink coverage stays above the floor', () => {
  // Boldness guard: a thin-stroke glyph would ink only a small fraction of the
  // canvas. The bold block-E inks ~36% of the full-size icons and ~20% of the
  // (smaller, safe-zone-fit) maskable. Flooring coverage well below those
  // actuals makes any regression to a thin glyph fail loudly.
  const FLOOR = { 'icon-192.png': 0.25, 'icon-512.png': 0.25, 'icon-maskable-512.png': 0.13 };
  REBRAND_ICONS.forEach((name) => {
    const { w, h, px } = decodePng(path.join(__dirname, '..', 'public', 'icons', name));
    let ink = 0;
    for (let i = 0; i < px.length; i += 4) {
      // any non-white pixel is letter ink (background is pure opaque white).
      if (!(px[i] === 255 && px[i + 1] === 255 && px[i + 2] === 255)) ink++;
    }
    const coverage = ink / (w * h);
    assert.ok(
      coverage >= FLOOR[name],
      name + ' ink coverage ' + (coverage * 100).toFixed(1) + '% is below the ' +
        (FLOOR[name] * 100) + '% boldness floor'
    );
  });
});
