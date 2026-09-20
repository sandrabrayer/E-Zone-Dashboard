/* Real-browser cross-check for the spinner-glyph fix.
 *
 * test/spinner-glyph.test.js resolves the cascade itself (tools/css-cascade.js)
 * and is the guard that runs in CI. This file proves the same conclusions the
 * only way that is beyond argument: load the real stylesheet in Chromium, read
 * getComputedStyle(el, '::before'), then screenshot the busy button twice — once
 * as shipped and once with the ring's border forced transparent — and diff. Every
 * differing pixel is a ring pixel, so "is the spinner visible" becomes a number
 * instead of an opinion.
 *
 * SKIPPED unless BOTH `playwright` resolves AND a Chromium binary is present, so
 * it is inert in CI (the repo has one dependency, express, and adding a browser
 * to `npm ci` would cost minutes per run for a check the cascade test already
 * covers). It runs wherever a browser is available — e.g. Claude Code's own
 * sandbox, where /opt/pw-browsers/chromium ships preinstalled:
 *
 *     PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --no-save playwright
 *     node --test test/spinner-glyph-browser.test.js
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
const chromiumPath = CHROMIUM_CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch (_) { return false; } });

const skip = !playwright
  ? 'playwright is not installed (see the header of this file)'
  : (!chromiumPath ? 'no Chromium binary found' : false);

/* Same matrix as test/spinner-glyph.test.js. */
const VARIANTS = [
  ['style.css', 'btn primary',  'primary / blue (the reported save button)'],
  ['style.css', 'btn',          'secondary / surface'],
  ['style.css', 'btn danger',   'danger / red'],
  ['style.css', 'btn small',    'small / surface'],
  ['style.css', 'btn ghost',    'ghost / transparent'],
  ['style.css', 'btn ghost-sm', 'ghost-sm / transparent'],
  ['meeting-report.css', 'mr-submit', 'mr-submit / blue'],
  ['meeting-report.css', 'mr-again',  'mr-again / surface'],
  ['meeting-report.css', 'mr-wa',     'mr-wa / GREEN'],
];

/* Slightly below the 120 that test/spinner-glyph.test.js computes, to absorb the
 * antialiasing of a 2px arc (a rendered peak sits a few points under the nominal
 * colour distance, and it shifts with the Chromium build). For scale: the bug
 * measured 46–84 here, the fix measures 126–219, and the tightest variant is
 * ghost-sm, whose ink is deliberately muted. */
const MIN_RING_CONTRAST = 110;

const TYPES = { '.css': 'text/css', '.html': 'text/html; charset=utf-8' };

/* Serve public/ plus a synthetic page holding one busy button, so the stylesheet
 * is fetched over http — a file:// <link> is not reliably applied to a page
 * created with setContent. */
function serve() {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    if (u.pathname === '/probe') {
      const kill = u.searchParams.get('kill') === '1';
      res.writeHead(200, { 'Content-Type': TYPES['.html'] });
      res.end(`<!DOCTYPE html><html lang="he" dir="rtl"><head>
        <link rel="stylesheet" href="/${u.searchParams.get('css')}">
        <style>
          body { margin: 0; padding: 24px; background: #182142; }
          /* Freeze the spin so two screenshots of the same button are comparable. */
          *, *::before, *::after { animation: none !important; }
          ${kill ? '.is-busy::before { border-color: transparent !important; }' : ''}
        </style></head><body>
        <div class="modal"><div class="form-actions">
          <button id="t" class="${u.searchParams.get('cls')} is-busy" aria-busy="true" disabled>שומר…</button>
        </div></div></body></html>`);
      return;
    }
    const f = path.join(PUBLIC, u.pathname);
    if (!f.startsWith(PUBLIC) || !fs.existsSync(f) || !fs.statSync(f).isFile()) {
      res.writeHead(404); res.end(); return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' });
    res.end(fs.readFileSync(f));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/* Decode both PNGs inside the page (Chromium does the decoding) and return the
 * peak per-channel difference plus how many pixels the ring paints. */
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

test('the busy spinner is visibly rendered in Chromium, on every button variant',
  { skip, timeout: 180000 }, async (t) => {
    const server = await serve();
    const base = `http://127.0.0.1:${server.address().port}`;
    const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
    try {
      const page = await browser.newPage({ deviceScaleFactor: 4 });
      for (const [css, cls, label] of VARIANTS) {
        const url = (kill) => `${base}/probe?css=${css}&cls=${encodeURIComponent(cls)}&kill=${kill}`;

        await page.goto(url(0), { waitUntil: 'load' });
        const computed = await page.evaluate(() => {
          const el = document.getElementById('t');
          const pb = getComputedStyle(el, '::before');
          const cs = getComputedStyle(el);
          return {
            content: pb.content, display: pb.display,
            width: parseFloat(pb.width), height: parseFloat(pb.height),
            borderWidth: parseFloat(pb.borderTopWidth), borderColor: pb.borderTopColor,
            opacity: cs.opacity, color: cs.color,
            background: cs.backgroundImage !== 'none' ? cs.backgroundImage : cs.backgroundColor,
          };
        });

        // The box exists and has real size.
        assert.ok(/^["']{2}$/.test(computed.content), `${label}: ::before content=${computed.content}`);
        assert.strictEqual(computed.display, 'inline-block', `${label}: display`);
        assert.ok(computed.width >= 11 && computed.height >= 11,
          `${label}: ring box ${computed.width}x${computed.height}`);
        assert.ok(computed.borderWidth >= 2, `${label}: stroke ${computed.borderWidth}`);

        // The regression: the button must not be faded while busy.
        assert.strictEqual(computed.opacity, '1',
          `${label}: busy button rendered at opacity ${computed.opacity}`);

        // The ring's ink differs from the fill it sits on.
        assert.notStrictEqual(computed.borderColor, computed.background,
          `${label}: ring colour equals the button background`);

        // ...and it actually paints, measurably.
        const on = (await page.locator('#t').screenshot()).toString('base64');
        await page.goto(url(1), { waitUntil: 'load' });
        const off = (await page.locator('#t').screenshot()).toString('base64');
        const diff = await page.evaluate(DIFF_IN_PAGE, [on, off]);
        assert.ok(!diff.error, `${label}: ${diff.error}`);
        assert.ok(diff.changed > 100, `${label}: ring painted only ${diff.changed} pixels`);
        assert.ok(diff.max >= MIN_RING_CONTRAST,
          `${label}: ring peaks at ${diff.max}/255 against its fill; need >= ${MIN_RING_CONTRAST}`);

        t.diagnostic(`${label}: box ${computed.width}x${computed.height} ` +
          `ring ${computed.borderColor} opacity ${computed.opacity} ` +
          `peakDelta ${diff.max} pixels ${diff.changed}`);
      }
    } finally {
      await browser.close();
      server.close();
    }
  });

test('prefers-reduced-motion renders a static but fully visible ring in Chromium',
  { skip, timeout: 120000 }, async (t) => {
    const server = await serve();
    const base = `http://127.0.0.1:${server.address().port}`;
    const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
    try {
      const page = await browser.newPage({ deviceScaleFactor: 4 });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto(`${base}/probe?css=style.css&cls=${encodeURIComponent('btn primary')}&kill=0`,
        { waitUntil: 'load' });
      const r = await page.evaluate(() => {
        const el = document.getElementById('t');
        const pb = getComputedStyle(el, '::before');
        return { anim: pb.animationName, opacity: getComputedStyle(el).opacity,
                 inlineStart: pb.borderRightColor, top: pb.borderTopColor,
                 pbOpacity: pb.opacity };
      });
      assert.strictEqual(r.anim, 'none', 'the spin must stop under reduced motion');
      // RTL: inline-start is the RIGHT edge. It closes to the same ink as the rest.
      assert.strictEqual(r.inlineStart, r.top, 'the static ring should be a complete circle');
      assert.strictEqual(r.opacity, '1', 'reduced motion must not re-fade the button');
      assert.strictEqual(r.pbOpacity, '1', 'the static ring must not be dimmed');
      t.diagnostic(`reduced motion: animation=${r.anim} ring=${r.top} opacity=${r.opacity}`);
    } finally {
      await browser.close();
      server.close();
    }
  });
