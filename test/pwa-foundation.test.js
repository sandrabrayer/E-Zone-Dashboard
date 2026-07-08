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

test('cache version is at or above the v4 floor (purges pre-redesign icons)', () => {
  // Icon redesign: the SW cache version must be at least v4 so every earlier
  // cached icon set (green-on-dark v2, and the #5b8bff v3 rebrand) is evicted
  // on activate and the new bold #2962ff E takes its place. A FLOOR (not a
  // locked exact value) makes an accidental revert to an older version fail
  // loudly while still allowing future bumps.
  const CACHE_FLOOR = 4;
  const n = Number(String(sw.CACHE_VERSION).replace(/^v/, ''));
  assert.ok(
    Number.isInteger(n) && n >= CACHE_FLOOR,
    'CACHE_VERSION (' + sw.CACHE_VERSION + ') must be >= v' + CACHE_FLOOR
  );
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

test('redesign icons have a fully-opaque dark background (maskable safe zone included)', () => {
  REBRAND_ICONS.forEach((name) => {
    const { w, h, px } = decodePng(path.join(__dirname, '..', 'public', 'icons', name));
    // Corner (top-left) is always background: must be the original dark #071410
    // and fully opaque.
    assert.deepStrictEqual([px[0], px[1], px[2], px[3]], [0x07, 0x14, 0x10, 255], name + ' corner');
    // No pixel may be even partially transparent — a transparent maskable safe
    // zone would read as cropped on Android's mask.
    let nonOpaque = 0;
    for (let i = 3; i < px.length; i += 4) if (px[i] !== 255) nonOpaque++;
    assert.strictEqual(nonOpaque, 0, name + ' has ' + nonOpaque + ' non-opaque px');
  });
});

test('redesign icons use #0055ff on #071410 with a white halo, dropping earlier marks', () => {
  REBRAND_ICONS.forEach((name) => {
    const { px } = decodePng(path.join(__dirname, '..', 'public', 'icons', name));
    let bg = 0, blue = 0, white = 0, oldGreen = 0, prevBlue = 0;
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i], g = px[i + 1], b = px[i + 2];
      if (r === 0x07 && g === 0x14 && b === 0x10) bg++; // #071410 dark bg
      if (r === 0x00 && g === 0x55 && b === 0xff) blue++; // #0055ff letter
      if (r === 0xff && g === 0xff && b === 0xff) white++; // #ffffff halo
      // old green letter #2dd47a (41,212,136); flag anything near it.
      if (Math.abs(r - 41) < 12 && Math.abs(g - 212) < 12 && Math.abs(b - 136) < 12) oldGreen++;
      // earlier rebrand fills #5b8bff and #2962ff must be gone.
      if (r === 0x5b && g === 0x8b && b === 0xff) prevBlue++;
      if (r === 0x29 && g === 0x62 && b === 0xff) prevBlue++;
    }
    assert.ok(bg > 0, name + ' contains #071410 background pixels');
    assert.ok(blue > 0, name + ' contains #0055ff letter pixels');
    assert.ok(white > 0, name + ' contains white (#ffffff) halo outline pixels');
    assert.strictEqual(oldGreen, 0, name + ' still has ' + oldGreen + ' old-green px');
    assert.strictEqual(prevBlue, 0, name + ' still has ' + prevBlue + ' earlier-blue px');
  });
});

/* ---------- icon redesign: boldness guard ---------- */

// Ink-coverage floor: the fraction of pixels that are meaningfully "letter ink"
// (heavily blue) must clear a threshold, so a thin / hairline glyph can never
// silently regress the bold block "E". Measured coverage of the shipped icons
// is ~34% (192/512) and ~19% (maskable, glyph shrunk to the safe zone); the
// floors sit comfortably below those so anti-aliasing jitter won't flake, but
// well above what any thin-stroke letterform could reach.
function inkCoverage(px, w, h) {
  let ink = 0;
  for (let i = 0; i < px.length; i += 4) {
    // Ink = a pixel the blue letter covers by more than ~half: low red + high
    // blue. This excludes both the dark #071410 background (low blue) and the
    // white #ffffff halo (high red), so only the letter body is counted.
    if (px[i] < 160 && px[i + 2] > 200) ink++;
  }
  return ink / (w * h);
}

test('redesign icons are BOLD — letter ink coverage clears the floor', () => {
  const FLOORS = {
    'icon-192.png': 0.25,
    'icon-512.png': 0.25,
    'icon-maskable-512.png': 0.14, // glyph deliberately shrunk into safe zone
  };
  REBRAND_ICONS.forEach((name) => {
    const { w, h, px } = decodePng(path.join(__dirname, '..', 'public', 'icons', name));
    const cov = inkCoverage(px, w, h);
    assert.ok(
      cov >= FLOORS[name],
      name + ' ink coverage ' + (cov * 100).toFixed(1) + '% is below the ' +
        (FLOORS[name] * 100) + '% boldness floor'
    );
  });
});
