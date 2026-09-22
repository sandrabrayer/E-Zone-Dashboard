/* Real-browser cross-check for תקופת כיסוי — the recorded coverage period.
 *
 * test/payment-coverage-period.test.js proves the RULE in a vm sandbox and is
 * the guard that runs in CI. This file proves the half that is only provable
 * in a browser: load the real index.html and app.js in Chromium, seed the
 * state the app would have loaded from Sheets, open the גבייה screen, and
 * drive the editor with actual clicks. A renderer that throws, a selector
 * that does not exist, a save that never fires or a period that renders into
 * the wrong cell fails here and nowhere else.
 *
 * SKIPPED unless BOTH `playwright` resolves AND a Chromium binary is present,
 * so it is inert in CI — same contract as test/monthly-revenue-browser.test.js:
 *
 *     PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --no-save playwright
 *     node --test test/payment-coverage-period-browser.test.js
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

async function withPage(fn, srvState) {
  const state = Object.assign({ posts: [], failWrites: false }, srvState || {});
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

test('the coverage period renders on the גבייה row, defaulted to the inferred cycle',
  { skip }, async () => {
    await withPage(async ({ page, port }) => {
      await open(page, port);
      const cell = await page.$eval('.billing-row .bill-cov-view', (el) => el.textContent.trim());
      /* The row records nothing, so the cycle is inferred: 20 Jan → 19 Feb —
         printed in the app's PEOPLE-facing date format (formatDate), not ISO.
         ISO survives only where it belongs: the two date inputs below. */
      assert.match(cell, /20\.1\.2026 – 19\.2\.2026/, 'got ' + cell);
      assert.doesNotMatch(cell, /2026-01-20/, 'ISO is storage, not display');
      assert.strictEqual(await page.$eval('.bill-cov-start', (el) => el.value), '2026-01-20',
        'the native date input still takes bare ISO');
      assert.strictEqual(await page.$eval('.bill-cov-end', (el) => el.value), '2026-02-19');
      // Nothing was decided differently, so no badge.
      assert.strictEqual(await page.$$eval('.bill-cov-view .badge.override', (e) => e.length), 0);
      assert.ok(await page.$('.bill-cov-edit-btn'), 'the pencil is offered on a persisted row in edit mode');
      // The label is present and the editor starts closed.
      assert.match(await page.$eval('.bill-cov-cell .p-label', (el) => el.textContent), /תקופת כיסוי/);
      assert.ok(await page.$eval('.bill-cov-edit', (el) => el.classList.contains('hidden')));
    });
  });

test('editing the period persists BOTH columns and marks the row as adjusted',
  { skip }, async () => {
    await withPage(async ({ page, port, state }) => {
      await open(page, port);
      await page.click('.bill-cov-edit-btn');
      assert.ok(!(await page.$eval('.bill-cov-edit', (el) => el.classList.contains('hidden'))),
        'the editor opened');
      await page.fill('.bill-cov-start', '2026-03-01');
      await page.fill('.bill-cov-end', '2026-03-31');
      await page.click('.bill-cov-save');
      await page.waitForFunction(`state.payments[0].coverageStart === '2026-03-01'`);

      // What actually went to the backend.
      const post = state.posts.find((p) => p && p.action === 'savePayment');
      assert.ok(post, 'a savePayment was sent');
      assert.strictEqual(post.payment.coverageStart, '2026-03-01');
      assert.strictEqual(post.payment.coverageEnd, '2026-03-31');
      // A period edit must never move money.
      assert.strictEqual(post.payment.amount, 3000);
      assert.strictEqual(post.payment.amountPaid, 3000);
      assert.strictEqual(post.payment.status, 'paid');

      // And the row now says it differs from the billing cycle.
      await page.waitForSelector('.bill-cov-view .badge.override');
      assert.match(await page.$eval('.bill-cov-view', (el) => el.textContent), /1\.3\.2026 – 31\.3\.2026/);
      assert.ok(await page.$('.bill-cov-reset-btn'), 'and offers a way back to the cycle');
    });
  });

test('the recorded period moves the money on הכנסות חודשיות, and says so', { skip }, async () => {
  await withPage(async ({ page, port }) => {
    await open(page, port, `coverageStart: '2026-03-01', coverageEnd: '2026-03-31',`);
    const inMonth = async (m) => page.evaluate(`
      state.revenueMonth = '${m}';
      document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
      document.getElementById('screen-revenue').classList.remove('hidden');
      renderMonthlyRevenue();
      document.getElementById('rev-received').textContent.replace(/[^0-9]/g, '');
    `);
    assert.strictEqual(await inMonth('2026-01'), '0', 'January owns none of it any more');
    // ₪3,000 incl. VAT ÷ 1.18 = ₪2,542 — all of it, in March.
    assert.strictEqual(await inMonth('2026-03'), '2542');
    const detail = await page.$eval('#rev-detail', (el) => el.textContent);
    assert.match(detail, /1\.3\.2026 → 31\.3\.2026/, 'the window is printed, in the app date format');
    assert.doesNotMatch(detail, /2026-03-01/, 'the drill-down speaks the same date format as the row');
    assert.match(detail, /תקופה מותאמת/, 'and flagged as not the default cycle');
  });
});

test('resetting returns the row to the billing cycle', { skip }, async () => {
  await withPage(async ({ page, port, state }) => {
    await open(page, port, `coverageStart: '2026-03-01', coverageEnd: '2026-03-31',`);
    await page.waitForSelector('.bill-cov-reset-btn');
    await page.click('.bill-cov-reset-btn');
    /* Wait on the DOM, not on state: savePayment's optimistic upsert lands
       synchronously, so a state-only wait races the re-render that follows
       the round-trip. */
    await page.waitForFunction(
      `document.querySelector('.bill-cov-view').textContent.includes('20.1.2026 \u2013 19.2.2026')`);
    const post = state.posts.filter((p) => p && p.action === 'savePayment').pop();
    /* Reset does not write blanks: savePayment re-stamps the inferred cycle,
     * so the row keeps an explicit period rather than reverting to a cell
     * somebody would have to interpret later. */
    assert.strictEqual(post.payment.coverageStart, '2026-01-20');
    assert.strictEqual(post.payment.coverageEnd, '2026-02-19');
    assert.strictEqual(await page.$$eval('.bill-cov-view .badge.override', (e) => e.length), 0,
      'back to the default → the badge is gone');
  });
});

test('an impossible period is refused at the keyboard, and nothing is sent', { skip }, async () => {
  await withPage(async ({ page, port, state }) => {
    await open(page, port);
    await page.click('.bill-cov-edit-btn');
    await page.fill('.bill-cov-start', '2026-03-31');
    await page.fill('.bill-cov-end', '2026-03-01');       // backwards
    await page.click('.bill-cov-save');
    await page.waitForFunction(`document.body.textContent.includes('מוקדם')`);
    assert.strictEqual(state.posts.filter((p) => p && p.action === 'savePayment').length, 0,
      'no round-trip for a period that cannot be true');
    assert.strictEqual(await page.evaluate(`state.payments[0].coverageStart`), '',
      'and nothing changed locally either');
  });
});

test('a BACKEND refusal is surfaced and the local row rolls back', { skip }, async () => {
  await withPage(async ({ page, port, state }) => {
    await open(page, port);
    state.failWrites = true;
    await page.click('.bill-cov-edit-btn');
    await page.fill('.bill-cov-start', '2026-03-01');
    await page.fill('.bill-cov-end', '2026-03-31');
    await page.click('.bill-cov-save');
    // savePayment rolls the optimistic upsert back and shows the error — the
    // UI must never claim a period was recorded when the sheet refused it.
    await page.waitForFunction(`document.body.textContent.includes('שמירת גבייה נכשלה')`);
    assert.strictEqual(await page.evaluate(`state.payments[0].coverageStart`), '',
      'rolled back to what the sheet actually holds');
  });
});

test('the editor is not offered in view mode, nor on an unsaved placeholder row', { skip }, async () => {
  await withPage(async ({ page, port }) => {
    await open(page, port);
    // View mode: the period is still shown, but there is nothing to click.
    await page.evaluate(`state.mode = 'view'; renderBilling();`);
    assert.ok(await page.$('.bill-cov-view'), 'the period is still readable');
    assert.strictEqual(await page.$$eval('.bill-cov-edit-btn', (e) => e.length), 0);

    /* A due-list row with no persisted payment is a placeholder built by
     * paymentForPatientOnDate. Editing it would conjure an unpaid Payments
     * row that does not exist today, so the pencil is withheld. */
    await page.evaluate(`state.mode = 'edit'; state.payments = []; renderBilling();`);
    assert.ok(await page.$('.bill-cov-view'), 'the inferred period is still shown');
    assert.strictEqual(await page.$$eval('.bill-cov-edit-btn', (e) => e.length), 0,
      'but not editable until the payment itself is recorded');
  });
});
