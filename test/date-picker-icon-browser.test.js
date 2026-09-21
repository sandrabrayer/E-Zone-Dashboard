/* Real-browser cross-check for the date/month picker icon contrast fix.
 *
 * test/date-picker-icon.test.js resolves the cascade itself (tools/css-cascade.js)
 * and is the guard that runs in CI. This file proves the same conclusions the one
 * way that is beyond argument: load the real stylesheet in Chromium — the engine
 * that actually draws the glyph, and the reason the bug existed at all — then
 * screenshot the control twice and diff.
 *
 * Two diffs, because they answer two different questions:
 *
 *  - AGAINST THE PRE-FIX SHEET (this block stripped out): the glyph pixels move
 *    from #000000 to #5b8bff, and the control's width does NOT move. That is both
 *    "the icon is now visible" and "this cost the layout nothing", measured.
 *  - AGAINST A KILLED GLYPH (the icon's paint forced to the field colour): every
 *    differing pixel is a glyph pixel, so "is the icon there" becomes a count
 *    instead of an opinion.
 *
 * SKIPPED unless BOTH `playwright` resolves AND a Chromium binary is present, so
 * it is inert in CI (the repo has one dependency, express, and adding a browser to
 * `npm ci` would cost minutes per run for a check the cascade test already
 * covers). It runs wherever a browser is available — e.g. Claude Code's own
 * sandbox, where /opt/pw-browsers/chromium ships preinstalled:
 *
 *     PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --no-save playwright
 *     node --test test/date-picker-icon-browser.test.js
 *
 * Point EZONE_CHROMIUM at a binary to override discovery.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const PUBLIC = path.join(__dirname, '..', 'public');

let playwright = null;
try { playwright = require('playwright'); } catch (_) { /* not installed — skip */ }

const CHROMIUM_CANDIDATES = [
  process.env.EZONE_CHROMIUM,
  '/opt/pw-browsers/chromium',
].filter(Boolean);
const chromiumPath = CHROMIUM_CANDIDATES.find((p) => {
  try { return fs.existsSync(p); } catch (_) { return false; }
});

const skip = !playwright
  ? 'playwright is not installed (see the header of this file)'
  : (!chromiumPath ? 'no Chromium binary found' : false);

/* Same two types as test/date-picker-icon.test.js. `month` is the field Sandra
 * reported (הכנסות חודשיות); `date` is every other picker in the app. */
const TYPES = [
  ['month', '2026-09', 'הכנסות חודשיות month field'],
  ['date', '2026-09-21', 'גבייה / לידים / תקופת כיסוי date fields'],
];

/* Slightly below the 120 the cascade test computes, to absorb the antialiasing of
 * a 2px stroke (a rendered peak sits under the nominal colour distance, and it
 * shifts with the Chromium build). For scale: the bug measures 66 here and the
 * fix measures 189. */
const MIN_ICON_CONTRAST = 110;

const FIELD = [24, 33, 66]; // --surface #182142, what the glyph sits on

const CSS = fs.readFileSync(path.join(PUBLIC, 'style.css'), 'utf8');

/* The shipped sheet with the whole picker block removed — i.e. the stylesheet as
 * it stood when the bug was reported. Anchored on the block's own comment banner
 * so an edit that moves the block still strips cleanly, and asserted below so a
 * silent miss can never turn this into a sheet-vs-itself comparison. */
const BLOCK = /\n\/\* -+\n \* NATIVE DATE \/ MONTH PICKERS[\s\S]*?\n\n(?=\.hidden)/;
const PREFIX_CSS = CSS.replace(BLOCK, '\n');

const TYPES_BY_EXT = { '.css': 'text/css', '.html': 'text/html; charset=utf-8' };

/* Serve public/ plus a synthetic page holding one picker, so the stylesheet is
 * fetched over http — a file:// <link> is not reliably applied to a page created
 * with setContent. `css=prefix` serves the stripped sheet; `kill=1` forces the
 * icon's paint to the field colour so the diff isolates the glyph. */
function serve() {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    if (u.pathname === '/prefix.css') {
      res.writeHead(200, { 'Content-Type': TYPES_BY_EXT['.css'] });
      res.end(PREFIX_CSS);
      return;
    }
    if (u.pathname === '/probe') {
      const type = u.searchParams.get('type');
      const value = u.searchParams.get('value');
      const sheet = u.searchParams.get('css') === 'prefix' ? '/prefix.css' : '/style.css';
      const kill = u.searchParams.get('kill') === '1';
      res.writeHead(200, { 'Content-Type': TYPES_BY_EXT['.html'] });
      res.end(`<!DOCTYPE html><html lang="he" dir="rtl"><head><meta charset="utf-8">
        <link rel="stylesheet" href="${sheet}">
        <style>
          body { margin: 0; padding: 24px; background: #182142; }
          *, *::before, *::after { animation: none !important; transition: none !important; }
          /* The universal selector above does NOT reach a UA pseudo-element, and
             the icon carries a .15s colour transition — without this the hover
             screenshot lands mid-fade and reads a blend instead of --text. */
          input::-webkit-calendar-picker-indicator { transition: none !important; }
          ${kill ? `input[type="${type}"]::-webkit-calendar-picker-indicator {
                      background-color: rgb(${FIELD}) !important;
                      background-image: none !important; }` : ''}
        </style></head><body>
        <input id="t" type="${type}" value="${value}">
        </body></html>`);
      return;
    }
    const f = path.join(PUBLIC, u.pathname);
    if (!f.startsWith(PUBLIC) || !fs.existsSync(f) || !fs.statSync(f).isFile()) {
      res.writeHead(404); res.end(); return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES_BY_EXT[path.extname(f)] || 'application/octet-stream',
    });
    res.end(fs.readFileSync(f));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/* Decode both PNGs inside the page (Chromium does the decoding) and report the
 * peak per-channel difference plus how many pixels differ at all. */
const DIFF_IN_PAGE = async ([a, b]) => {
  const load = async (s) => { const i = new Image(); i.src = 'data:image/png;base64,' + s; await i.decode(); return i; };
  const grab = (img) => {
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const x = c.getContext('2d'); x.drawImage(img, 0, 0);
    return { d: x.getImageData(0, 0, c.width, c.height).data, w: c.width, h: c.height };
  };
  const A = grab(await load(a)); const B = grab(await load(b));
  if (A.w !== B.w || A.h !== B.h) return { error: `size shift ${A.w}x${A.h} vs ${B.w}x${B.h}` };
  let max = 0; let changed = 0;
  for (let i = 0; i < A.d.length; i += 4) {
    const dd = Math.max(Math.abs(A.d[i] - B.d[i]),
                        Math.abs(A.d[i + 1] - B.d[i + 1]),
                        Math.abs(A.d[i + 2] - B.d[i + 2]));
    if (dd > 8) changed++;
    if (dd > max) max = dd;
  }
  return { max, changed };
};

/* The pixel in the icon's corner of the control that sits furthest from the field
 * colour — i.e. the darkest/brightest ink the glyph actually paints. This is the
 * number the bug report was about. */
const PEAK_IN_PAGE = async ([b64, field]) => {
  const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const x = c.getContext('2d'); x.drawImage(img, 0, 0);
  const d = x.getImageData(0, 0, c.width, c.height).data;
  /* The indicator sits at the inline-end of the control box, which Chromium lays
   * out at the visual right for these LTR-formatted fields. Scan the right fifth. */
  const x0 = Math.floor(c.width * 0.8);
  let peak = 0; let px = null;
  for (let y = 0; y < c.height; y++) {
    for (let xx = x0; xx < c.width; xx++) {
      const i = (y * c.width + xx) * 4;
      const dist = Math.max(Math.abs(d[i] - field[0]),
                            Math.abs(d[i + 1] - field[1]),
                            Math.abs(d[i + 2] - field[2]));
      if (dist > peak) { peak = dist; px = [d[i], d[i + 1], d[i + 2]]; }
    }
  }
  return { peak, px };
};

test('the picker sheet really does differ from the pre-fix sheet', { skip }, () => {
  /* Guards every comparison below: if the strip silently no-ops, the "before"
   * page would be the fixed page and the whole file would pass vacuously. */
  assert.notStrictEqual(PREFIX_CSS, CSS, 'failed to strip the picker block from style.css');
  assert.ok(!/calendar-picker-indicator/.test(PREFIX_CSS), 'strip left the indicator rules behind');
  assert.ok(!/color-scheme/.test(PREFIX_CSS), 'strip left color-scheme behind');
  assert.ok(/\.hidden \{ display: none !important; \}/.test(PREFIX_CSS),
    'strip ate more than the picker block');
});

test('the calendar icon is visibly rendered in Chromium, on both picker types',
  { skip, timeout: 180000 }, async (t) => {
    const server = await serve();
    const base = `http://127.0.0.1:${server.address().port}`;
    const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
    try {
      const page = await browser.newPage({ deviceScaleFactor: 3 });
      for (const [type, value, label] of TYPES) {
        const url = (opts) =>
          `${base}/probe?type=${type}&value=${value}&css=${opts.css || 'style'}&kill=${opts.kill ? 1 : 0}`;

        /* Warm the renderer on THIS control before anything is measured. The
         * first time Chromium rasterizes a given string it lands a hair
         * differently from every later paint, so without this the first shot of
         * each type carries a text delta the second shot does not — the glyph
         * diff came back 2486 pixels spanning the whole field instead of the 728
         * the icon actually paints. Throwaway navigation + throwaway shot. */
        await page.goto(url({}), { waitUntil: 'load' });
        await page.locator('#t').screenshot();

        /* --- the control as shipped --- */
        await page.goto(url({}), { waitUntil: 'load' });
        const shipped = await page.evaluate(() => {
          const el = document.getElementById('t');
          const cs = getComputedStyle(el);
          return {
            colorScheme: cs.colorScheme,
            width: el.getBoundingClientRect().width,
            background: cs.backgroundColor,
          };
        });

        /* The declaration that fixes Firefox and the UA-rendered dropdown panel. */
        assert.strictEqual(shipped.colorScheme, 'dark',
          `${label}: color-scheme resolved to "${shipped.colorScheme}"`);
        assert.strictEqual(shipped.background, `rgb(${FIELD.join(', ')})`,
          `${label}: the field moved off --surface; the contrast floor assumes #182142`);

        const onShot = (await page.locator('#t').screenshot()).toString('base64');
        const after = await page.evaluate(PEAK_IN_PAGE, [onShot, FIELD]);

        /* --- the same page with the icon's paint forced to the field colour ---
         * Taken back-to-back with the shot above, on the same stylesheet, so the
         * only thing that can differ is the glyph. */
        await page.goto(url({ kill: true }), { waitUntil: 'load' });
        const offShot = (await page.locator('#t').screenshot()).toString('base64');
        const diff = await page.evaluate(DIFF_IN_PAGE, [onShot, offShot]);
        assert.ok(!diff.error, `${label}: ${diff.error}`);
        assert.ok(diff.changed > 100, `${label}: icon painted only ${diff.changed} pixels`);
        assert.ok(diff.max >= MIN_ICON_CONTRAST,
          `${label}: icon peaks at ${diff.max}/255 against the field it covers`);

        /* --- the same control on the pre-fix stylesheet --- */
        await page.goto(url({ css: 'prefix' }), { waitUntil: 'load' });
        const prefix = await page.evaluate(() => ({
          colorScheme: getComputedStyle(document.getElementById('t')).colorScheme,
          width: document.getElementById('t').getBoundingClientRect().width,
        }));
        const beforeShot = (await page.locator('#t').screenshot()).toString('base64');
        const before = await page.evaluate(PEAK_IN_PAGE, [beforeShot, FIELD]);

        /* THE BUG, reproduced: on the pre-fix sheet the glyph's own ink is far
         * closer to the field than the floor this fix holds. If this ever stops
         * being true, Chromium changed its default and the numbers below need
         * re-measuring rather than quietly loosening. */
        assert.ok(before.peak < MIN_ICON_CONTRAST,
          `${label}: pre-fix icon already measured ${before.peak} — the bug no longer reproduces`);

        /* THE FIX: the glyph is painted in --primary and clears the floor. */
        assert.ok(after.peak >= MIN_ICON_CONTRAST,
          `${label}: icon peaks at ${after.peak}/255 against the field; need >= ${MIN_ICON_CONTRAST}`);
        assert.deepStrictEqual(after.px, [91, 139, 255],
          `${label}: icon ink is rgb(${after.px}), expected --primary #5b8bff`);

        /* CSS-only means CSS-only: the control must not have resized. */
        assert.strictEqual(shipped.width, prefix.width,
          `${label}: control width moved ${prefix.width} → ${shipped.width}; the repaint ` +
          'must cost the layout nothing');

        t.diagnostic(`${label}: before ${before.peak} rgb(${before.px}) → after ${after.peak} ` +
          `rgb(${after.px}), width ${prefix.width}→${shipped.width}, glyph pixels ${diff.changed}`);
      }
    } finally {
      await browser.close();
      server.close();
    }
  });

test('hover brightens the icon in Chromium without moving the control',
  { skip, timeout: 120000 }, async (t) => {
    const server = await serve();
    const base = `http://127.0.0.1:${server.address().port}`;
    const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
    try {
      const page = await browser.newPage({ deviceScaleFactor: 3 });
      for (const [type, value, label] of TYPES) {
        await page.goto(`${base}/probe?type=${type}&value=${value}&css=style&kill=0`,
          { waitUntil: 'load' });
        /* Park the pointer off the control first. A navigation does not move the
         * mouse, so without this the second iteration's "resting" shot is taken
         * with the cursor still sitting where the first iteration hovered — and
         * the hover diff comes back as zero changed pixels. */
        await page.mouse.move(0, 0);
        const rest = (await page.locator('#t').screenshot()).toString('base64');
        const restW = await page.evaluate(() => document.getElementById('t').getBoundingClientRect().width);

        await page.locator('#t').hover();
        const hot = (await page.locator('#t').screenshot()).toString('base64');
        const hotW = await page.evaluate(() => document.getElementById('t').getBoundingClientRect().width);
        const peak = await page.evaluate(PEAK_IN_PAGE, [hot, FIELD]);

        assert.deepStrictEqual(peak.px, [241, 245, 255],
          `${label}: hovered icon ink is rgb(${peak.px}), expected --text #f1f5ff`);
        assert.strictEqual(restW, hotW, `${label}: hover resized the control`);

        const diff = await page.evaluate(DIFF_IN_PAGE, [rest, hot]);
        assert.ok(!diff.error, `${label}: ${diff.error}`);
        assert.ok(diff.changed > 20, `${label}: hover changed only ${diff.changed} pixels`);

        t.diagnostic(`${label}: hover ink rgb(${peak.px}) at ${peak.peak}, ${diff.changed} pixels`);
      }
    } finally {
      await browser.close();
      server.close();
    }
  });
