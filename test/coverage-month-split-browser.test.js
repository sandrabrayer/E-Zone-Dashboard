/* Real-browser cross-check for the גבייה row's month split.
 *
 * test/coverage-month-split.test.js proves the ARITHMETIC in a vm sandbox and
 * is the guard that runs in CI. This file proves the things a sandbox cannot:
 * that the split actually reaches the screen, that it repaints from the two
 * date inputs BEFORE anything is saved (and sends nothing while doing so),
 * that the deferred month really is painted apart from the one in view, and
 * that the period reads in the human date format rather than ISO.
 *
 * SKIPPED unless BOTH `playwright` resolves AND a Chromium binary is present,
 * so it is inert under `npm ci` (the repo has one dependency, express). It
 * runs wherever a browser is available — e.g. Claude Code's own sandbox:
 *
 *     PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --no-save playwright
 *     node --test test/coverage-month-split-browser.test.js
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
if (!playwright) {
  try {
    const groot = require('node:child_process').execSync('npm root -g').toString().trim();
    playwright = require(path.join(groot, 'playwright'));
  } catch (_) { /* still unavailable — skip */ }
}

const CHROMIUM_CANDIDATES = [process.env.EZONE_CHROMIUM, '/opt/pw-browsers/chromium'].filter(Boolean);
const chromiumPath = CHROMIUM_CANDIDATES.find((p) => {
  try { return fs.existsSync(p); } catch (_) { return false; }
});
const skip = !playwright
  ? 'playwright is not installed (see the header of this file)'
  : (!chromiumPath ? 'no Chromium binary found' : false);

const TYPES = {
  '.css': 'text/css',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
};

/* Serve public/ over http and RECORD every /api/ POST, so a test can assert
 * that a live repaint persisted NOTHING. */
function serve(state) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    if (u.pathname.startsWith('/api/')) {
      let body = '';
      req.on('data', (c) => { body += c; });
      return req.on('end', () => {
        if (req.method === 'POST') {
          let parsed = body;
          try { parsed = JSON.parse(body); } catch (_) { /* keep the raw text */ }
          state.posts.push(parsed);
          res.writeHead(200, { 'Content-Type': TYPES['.json'] });
          return res.end(JSON.stringify({ ok: true }));
        }
        res.writeHead(200, { 'Content-Type': TYPES['.json'] });
        res.end(JSON.stringify({ ok: true, user: 'ורד', patients: [], leads: [], payments: [] }));
      });
    }
    const rel = u.pathname === '/' ? 'index.html' : u.pathname.replace(/^\//, '');
    const file = path.join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file)) { res.writeHead(404); return res.end('nf'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, () => resolve({ server, port: server.address().port })));
}

/* The brief's own case: ₪29,000 covering 6 Sep – 5 Oct, viewed on a גבייה
 * screen set to September. A PAID row, because a settled payment is exactly
 * the one whose period has to be correctable. */
function seedScript(coverage, amount) {
  return `
    const KEY = patientKey({ houseId: 'arfoni', name: 'דנה כהן', date: '2025-09-06' });
    state.patients = [{
      id: 'p1', houseId: 'arfoni', name: 'דנה כהן', date: '2025-09-06',
      pay: ${amount}, status: 'active', exitDate: '',
    }];
    state.payments = [normalizePayment({
      id: 'pay::' + KEY + '::2026-09-06', patientId: KEY, patientName: 'דנה כהן',
      houseId: 'arfoni', dueDate: '2026-09-06', amount: ${amount},
      amountPaid: ${amount}, status: 'paid', balance: 0, ${coverage || ''}
    })];
    state.credits = [];
    state.billingOverrides = [];
    state.billingDate = '2026-09-06';
    state.mode = 'edit';
    const app = document.getElementById('app');
    if (app) app.classList.remove('hidden');
    document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
    document.getElementById('screen-billing').classList.remove('hidden');
    renderBilling();
  `;
}

async function open(page, port, coverage, amount) {
  // 'networkidle', not 'load': the app boots by fetching /api/* and then calls
  // renderAll(), which would overwrite a seed planted any earlier.
  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'networkidle' });
  await page.evaluate(seedScript(coverage, amount == null ? 29000 : amount));
}

async function withPage(fn) {
  const state = { posts: [] };
  const { server, port } = await serve(state);
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await fn({ page, port, state, errors });
    assert.deepStrictEqual(errors, [], 'no page errors');
  } finally {
    await browser.close();
    server.close();
  }
}

/** The split, one entry per rendered line: { text, deferred, color }. */
const readSplit = (page) => page.$$eval('.bill-cov-split .cov-split-line', (els) => els.map((el) => ({
  text: el.textContent.replace(/\s+/g, ' ').trim(),
  deferred: el.classList.contains('deferred'),
  color: getComputedStyle(el).color,
  fontSize: parseFloat(getComputedStyle(el).fontSize),
})));

/* ===================================================================== */

test('the month split renders on the row: 25 / 5 days, 24,167 + 4,833',
  { skip }, async () => {
    await withPage(async ({ page, port }) => {
      await open(page, port, `coverageStart: '2026-09-06', coverageEnd: '2026-10-05',`);
      const lines = await readSplit(page);
      assert.strictEqual(lines.length, 2, 'one line per month the window touches');
      assert.match(lines[0].text, /ספטמבר 2026/);
      assert.match(lines[0].text, /25 ימים/);
      assert.match(lines[0].text, /24,167/);
      assert.match(lines[1].text, /אוקטובר 2026/);
      assert.match(lines[1].text, /5 ימים/);
      assert.match(lines[1].text, /4,833/);
      // And the period above them reads as a person reads a date.
      const cell = await page.$eval('.bill-cov-view', (el) => el.textContent);
      assert.match(cell, /06\/09\/2026 – 05\/10\/2026/, 'human format, not ISO');
      assert.doesNotMatch(cell, /2026-09-06/, 'no ISO left on screen');
    });
  });

test('the deferred month is painted apart from the month in view', { skip }, async () => {
  await withPage(async ({ page, port }) => {
    await open(page, port, `coverageStart: '2026-09-06', coverageEnd: '2026-10-05',`);
    const lines = await readSplit(page);
    assert.strictEqual(lines[0].deferred, false, 'September is the selected month');
    assert.strictEqual(lines[1].deferred, true, 'October is deferred');
    // The two really do resolve to the screen's two accent tokens, not to the
    // same ink with a class nobody styled.
    assert.strictEqual(lines[0].color, 'rgb(91, 139, 255)', '--primary');
    assert.strictEqual(lines[1].color, 'rgb(255, 176, 32)', '--warning');
    assert.notStrictEqual(lines[0].color, lines[1].color);
    /* Prominent, not a footnote: at least as large as the row's own labels
     * and within a point of its values (.p-val is 14.5px). */
    assert.ok(lines[0].fontSize >= 14,
      `split renders at ${lines[0].fontSize}px — too small to be the key fact`);
  });
});

test('a single-month period renders ONE line and no split', { skip }, async () => {
  await withPage(async ({ page, port }) => {
    await open(page, port, `coverageStart: '2026-09-01', coverageEnd: '2026-09-30',`);
    const lines = await readSplit(page);
    assert.strictEqual(lines.length, 1);
    assert.match(lines[0].text, /ספטמבר 2026/);
    assert.match(lines[0].text, /30 ימים/);
    assert.match(lines[0].text, /29,000/, 'the whole payment, undivided');
    assert.strictEqual(lines[0].deferred, false);
  });
});

test('a three-month period renders three lines that sum to the payment', { skip }, async () => {
  await withPage(async ({ page, port }) => {
    await open(page, port, `coverageStart: '2026-08-20', coverageEnd: '2026-10-10',`);
    const lines = await readSplit(page);
    assert.strictEqual(lines.length, 3);
    assert.deepStrictEqual(lines.map((l) => l.deferred), [true, false, true],
      'only the selected month reads as current');
    const shekels = lines.map((l) => Number((l.text.match(/₪\s*([\d,]+)/) || [])[1].replace(/,/g, '')));
    assert.strictEqual(shekels.reduce((s, n) => s + n, 0), 29000,
      `the lines print ${shekels.join(' + ')} — they must sum to the ₪29,000 above them`);
  });
});

test('the split repaints AS THE PERIOD IS TYPED, and persists nothing',
  { skip }, async () => {
    /* The reason the split is on this row at all: answering "what does this
     * period do to my months?" while the period is still being chosen. */
    await withPage(async ({ page, port, state }) => {
      await open(page, port, `coverageStart: '2026-09-06', coverageEnd: '2026-10-05',`);
      assert.strictEqual((await readSplit(page)).length, 2);

      await page.click('.bill-cov-edit-btn');
      await page.fill('.bill-cov-end', '2026-11-20');
      await page.waitForFunction(
        `document.querySelectorAll('.bill-cov-split .cov-split-line').length === 3`);

      const lines = await readSplit(page);
      assert.match(lines[0].text, /ספטמבר 2026/);
      assert.match(lines[1].text, /אוקטובר 2026/);
      assert.match(lines[2].text, /נובמבר 2026/);
      assert.match(lines[1].text, /31 ימים/, 'October is now fully enclosed');
      const shekels = lines.map((l) => Number((l.text.match(/₪\s*([\d,]+)/) || [])[1].replace(/,/g, '')));
      assert.strictEqual(shekels.reduce((s, n) => s + n, 0), 29000,
        'the preview reconciles to the payment exactly, same as a saved one');

      // NOTHING was written. The preview is a preview.
      assert.deepStrictEqual(state.posts.filter((p) => p && p.action === 'savePayment'), [],
        'typing a period must not persist it');
      const live = await page.evaluate(`state.payments[0].coverageEnd`);
      assert.strictEqual(live, '2026-10-05', 'local state is untouched until שמור');
    });
  });

test('a half-typed period leaves the last good split on screen', { skip }, async () => {
  /* Clearing the end date mid-edit must not blank the row: the split is not a
   * validation message, and coveragePeriodError already owns saying what is
   * wrong when שמור is pressed. */
  await withPage(async ({ page, port }) => {
    await open(page, port, `coverageStart: '2026-09-06', coverageEnd: '2026-10-05',`);
    await page.click('.bill-cov-edit-btn');
    await page.fill('.bill-cov-end', '');
    await page.waitForTimeout(100);
    const lines = await readSplit(page);
    assert.strictEqual(lines.length, 2, 'the previous split is still shown');
    assert.match(lines[0].text, /24,167/);
  });
});

test('cancelling restores the stored period AND its split', { skip }, async () => {
  await withPage(async ({ page, port }) => {
    await open(page, port, `coverageStart: '2026-09-06', coverageEnd: '2026-10-05',`);
    await page.click('.bill-cov-edit-btn');
    await page.fill('.bill-cov-end', '2026-11-20');
    await page.waitForFunction(
      `document.querySelectorAll('.bill-cov-split .cov-split-line').length === 3`);
    await page.click('.bill-cov-cancel');
    await page.waitForFunction(
      `document.querySelectorAll('.bill-cov-split .cov-split-line').length === 2`);
    const lines = await readSplit(page);
    assert.match(lines[0].text, /24,167/, 'back to the stored period');
    assert.match(lines[1].text, /4,833/);
    assert.strictEqual(await page.$eval('.bill-cov-end', (el) => el.value), '2026-10-05',
      'and the input is ISO again, ready to edit');
  });
});

test('the split survives the editor opening — it is not inside the hidden view span',
  { skip }, async () => {
    await withPage(async ({ page, port }) => {
      await open(page, port, `coverageStart: '2026-09-06', coverageEnd: '2026-10-05',`);
      await page.click('.bill-cov-edit-btn');
      assert.strictEqual(await page.$eval('.bill-cov-view', (el) => el.classList.contains('hidden')),
        true, 'the view span is hidden while editing');
      const visible = await page.$eval('.bill-cov-split',
        (el) => el.getBoundingClientRect().height > 0);
      assert.strictEqual(visible, true, 'the split is still on screen');
    });
  });
