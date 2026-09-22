/* Real-browser cross-check for the תקופת כיסוי month split — פיצול לפי חודשים.
 *
 * test/coverage-period-split.test.js proves the arithmetic and the markup in a
 * vm sandbox and is the guard that runs in CI. This file proves the half that
 * is only provable in a browser: load the real index.html and app.js in
 * Chromium, seed the state the app would have loaded from Sheets, open the
 * גבייה screen, and watch the strip react to actual typing. A strip that
 * renders into the wrong cell, a live preview that never fires, or a split
 * that silently disagrees with the row's own amount fails here and nowhere
 * else.
 *
 * SKIPPED unless BOTH `playwright` resolves AND a Chromium binary is present,
 * so it is inert in CI — same contract as the other browser suites:
 *
 *     PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --no-save playwright
 *     node --test test/coverage-period-split-browser.test.js
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
 * exactly what the client tried to persist. */
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
          res.writeHead(state.failWrites ? 500 : 200, { 'Content-Type': TYPES['.json'] });
          return res.end(JSON.stringify(state.failWrites
            ? { ok: false, error: 'תאריך הסיום מוקדם מתאריך ההתחלה' }
            : { ok: true }));
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

/* One patient, one PAID payment row already in the sheet — the case the whole
 * change is about, since a payment already taken is the one whose period has
 * to be correctable. */
function seedScript(extra) {
  return `
    const KEY = patientKey({ houseId: 'arfoni', name: 'דנה כהן', date: '2025-06-20' });
    state.patients = [{
      id: 'p1', houseId: 'arfoni', name: 'דנה כהן', date: '2025-06-20',
      pay: 3000, status: 'active', exitDate: '',
    }];
    state.payments = [normalizePayment({
      id: 'pay::' + KEY + '::2026-01-20', patientId: KEY, patientName: 'דנה כהן',
      houseId: 'arfoni', dueDate: '2026-01-20', amount: 3000, amountPaid: 3000,
      status: 'paid', balance: 0, ${extra || ''}
    })];
    state.credits = [];
    state.billingOverrides = [];
    state.billingDate = '2026-01-20';
    state.mode = 'edit';
    const app = document.getElementById('app');
    if (app) app.classList.remove('hidden');
    document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
    document.getElementById('screen-billing').classList.remove('hidden');
    renderBilling();
  `;
}

async function open(page, port, extra) {
  // 'networkidle', not 'load': the app boots by fetching /api/* and then calls
  // renderAll(), which would overwrite a seed planted any earlier.
  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'networkidle' });
  await page.evaluate(seedScript(extra));
}

async function withPage(fn, srvState, extra) {
  const state = Object.assign({ posts: [], failWrites: false }, srvState || {});
  const { server, port } = await serve(state);
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await open(page, port, extra);
    await fn({ page, port, state, errors });
    assert.deepStrictEqual(errors, [], 'no page errors');
  } finally {
    await browser.close();
    server.close();
  }
}


/* The seeded row: ₪3,000 due 20 Jan 2026, so the inferred cycle is
 * 20 Jan – 19 Feb — a 31-day window with 12 days in January and 19 in
 * February. 3000 × 12/31 = 1,161.29 and 3000 × 19/31 = 1,838.71, which add up
 * to the row's ₪3,000 to the agora. */
const partsText = (page) => page.$eval('.bill-cov-parts', (el) => el.textContent.replace(/\s+/g, ' ').trim());

test('the month split is printed under the period, and the later month reads as deferred',
  { skip }, async () => {
    await withPage(async ({ page }) => {
      await page.waitForSelector('.bill-cov-split');
      assert.match(await page.$eval('.bill-cov-split .p-label', (el) => el.textContent),
        /פיצול לפי חודשים/);
      const text = await partsText(page);
      assert.match(text, /ינואר\s*12 ימים\s*₪ 1,161\.29/, 'got ' + text);
      assert.match(text, /פברואר\s*19 ימים\s*₪ 1,838\.71/, 'got ' + text);
      // Exactly one month is deferred — the one the money has not been earned in.
      const tags = await page.$$eval('.bill-cov-part .cov-part-tag', (els) => els.map((e) => e.textContent));
      assert.deepStrictEqual(tags, ['נדחה']);
      const deferred = await page.$$eval('.bill-cov-part',
        (els) => els.map((e) => e.classList.contains('deferred')));
      assert.deepStrictEqual(deferred, [false, true]);
      // And it is visibly muted, not merely class-tagged.
      const [first, second] = await page.$$eval('.bill-cov-part',
        (els) => els.map((e) => getComputedStyle(e).color));
      assert.notStrictEqual(first, second, 'the deferred month is toned down');
    });
  });

test('the printed lines add up to the row\'s own amount, to the agora', { skip }, async () => {
  await withPage(async ({ page }) => {
    await page.waitForSelector('.bill-cov-part');
    const sum = await page.$$eval('.bill-cov-part .cov-part-amount',
      (els) => els.reduce((t, e) => t + Number(e.textContent.replace(/[^0-9.]/g, '')), 0));
    assert.strictEqual(Math.round(sum * 100) / 100, 3000,
      'a split that does not sum to the payment reads as a bug');
  });
});

test('the split follows the date inputs LIVE, and nothing is saved while typing',
  { skip }, async () => {
    await withPage(async ({ page, state }) => {
      await page.click('.bill-cov-edit-btn');
      await page.fill('.bill-cov-start', '2026-03-01');
      await page.fill('.bill-cov-end', '2026-03-31');
      await page.waitForFunction(
        `document.querySelector('.bill-cov-parts').textContent.includes('מרץ')`);
      const text = await partsText(page);
      // A period inside one month collapses to a single, non-deferred line.
      assert.match(text, /מרץ\s*31 ימים\s*₪ 3,000/, 'got ' + text);
      assert.strictEqual(await page.$$eval('.bill-cov-part', (e) => e.length), 1);
      assert.strictEqual(await page.$$eval('.bill-cov-part.deferred', (e) => e.length), 0);
      // DISPLAY ONLY: the preview is not a write.
      assert.strictEqual(state.posts.filter((p) => p && p.action === 'savePayment').length, 0);
      assert.strictEqual(await page.evaluate(`state.payments[0].coverageStart`), '');

      // Cancelling puts the stored period's split back.
      await page.click('.bill-cov-cancel');
      await page.waitForFunction(
        `document.querySelector('.bill-cov-parts').textContent.includes('פברואר')`);
      assert.match(await partsText(page), /ינואר\s*12 ימים/);
    });
  });

test('an impossible period shows the refusal reason instead of a window', { skip }, async () => {
  await withPage(async ({ page }) => {
    await page.click('.bill-cov-edit-btn');
    await page.fill('.bill-cov-start', '2026-03-31');
    await page.fill('.bill-cov-end', '2026-03-01');          // backwards
    await page.waitForSelector('.bill-cov-split-err');
    assert.match(await page.$eval('.bill-cov-split-err', (el) => el.textContent),
      /תאריך הסיום מוקדם מתאריך ההתחלה/);
    assert.strictEqual(await page.$$eval('.bill-cov-part', (e) => e.length), 0,
      'no split is invented for a period that cannot be true');
  });
});

test('a RECORDED period splits by ITS months, not by the billing cycle\'s', { skip }, async () => {
  await withPage(async ({ page }) => {
    const text = await partsText(page);
    // 22 Sep – 21 Oct on ₪3,000: 9 of 30 days, then 21 of 30.
    assert.match(text, /ספטמבר\s*9 ימים\s*₪ 900/, 'got ' + text);
    assert.match(text, /אוקטובר\s*21 ימים\s*₪ 2,100/, 'got ' + text);
    assert.match(await page.$eval('.bill-cov-view', (el) => el.textContent), /22\.9\.2026 – 21\.10\.2026/);
  }, null, `coverageStart: '2026-09-22', coverageEnd: '2026-10-21',`);
});
