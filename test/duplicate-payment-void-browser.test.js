/* Real-browser cross-check for כפילות — voiding a payment entered twice.
 *
 * test/duplicate-payment-void.test.js proves the RULES in a vm sandbox and is
 * the guard that runs in CI. This file proves the half that is only provable
 * in a browser: load the real index.html and app.js in Chromium, seed the
 * עמית יעקובי / עמית בורנשטיין pair from the live sheet, and watch the
 * numbers on הכנסות חודשיות and גבייה actually move when the duplicate is
 * marked. A figure that still double-counts, a side-by-side panel that never
 * renders, or an un-void button offered to the wrong person fails here and
 * nowhere else.
 *
 * SKIPPED unless BOTH `playwright` resolves AND a Chromium binary is present,
 * so it is inert in CI — same contract as the other browser suites:
 *
 *     PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --no-save playwright
 *     node --test test/duplicate-payment-void-browser.test.js
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

/* The live pair: עמית בורנשטיין (עפרוני, entered 7.9) with his ₪30,000, and
 * "עמית יעקובי" — the same ₪30,000, recorded before the rename. */
function seedScript(sessionUser) {
  return `
    state.sessionUser = ${JSON.stringify(sessionUser || 'ורד')};
    state.patients = [
      normalizePatient({ id: 'id-amit', houseId: 'arfoni', name: 'עמית בורנשטיין',
        date: '2026-09-07', pay: 30000, status: 'active', exitDate: '' }),
    ];
    state.payments = [
      normalizePayment({ id: 'pay-amit', patientUid: 'id-amit',
        patientId: 'arfoni::עמית בורנשטיין::2026-09-07', patientName: 'עמית בורנשטיין',
        houseId: 'arfoni', dueDate: '2026-09-07', amount: 30000, amountPaid: 30000,
        status: 'paid', balance: 0 }),
      normalizePayment({ id: 'pay-yaakovi', patientUid: '',
        patientId: 'arfoni::עמית יעקובי::2026-09-07', patientName: 'עמית יעקובי',
        houseId: 'arfoni', dueDate: '2026-09-07', amount: 30000, amountPaid: 30000,
        status: 'paid', balance: 0 }),
    ];
    state.credits = [];
    state.billingOverrides = [];
    state.mode = 'edit';
    const app = document.getElementById('app');
    if (app) app.classList.remove('hidden');
    document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
    document.getElementById('screen-reconnect').classList.remove('hidden');
    renderReconnect();
  `;
}

async function open(page, port, sessionUser) {
  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'networkidle' });
  await page.evaluate(seedScript(sessionUser));
}

async function withPage(fn, sessionUser) {
  const state = { posts: [], failWrites: false };
  const { server, port } = await serve(state);
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await open(page, port, sessionUser);
    await fn({ page, port, state, errors });
    assert.deepStrictEqual(errors, [], 'no page errors');
  } finally {
    await browser.close();
    server.close();
  }
}

const revenueDigits = (page) => page.evaluate(`
  state.revenueMonth = '2026-09';
  document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
  document.getElementById('screen-revenue').classList.remove('hidden');
  renderMonthlyRevenue();
  Number(document.getElementById('rev-received').textContent.replace(/[^0-9]/g, ''));
`);

test('כפילות is the primary action where the warning is, שייך is still offered',
  { skip }, async () => {
    await withPage(async ({ page }) => {
      await page.waitForSelector('.reconnect-cand');
      assert.ok(await page.$('.reconnect-cand.has-dup'), 'the pair is flagged');
      const dupBtn = await page.$('.cand-dup');
      assert.ok(dupBtn, 'כפילות is offered');
      assert.strictEqual(await dupBtn.evaluate((el) => el.textContent.trim()), 'כפילות');
      assert.ok(await dupBtn.evaluate((el) => el.classList.contains('primary')),
        'and it leads');
      const link = await page.$('.cand-link');
      assert.ok(link, 'שייך is still there — the pair CAN be a rename');
      assert.ok(!(await link.evaluate((el) => el.classList.contains('primary'))),
        'it just steps down to secondary');
    });
  });

test('the original is shown side by side, and nothing is written until confirmed',
  { skip }, async () => {
    await withPage(async ({ page, state }) => {
      await page.click('.cand-dup');
      await page.waitForSelector('.dup-modal');
      const panels = await page.$$eval('.dup-panel .dup-panel-title', (els) =>
        els.map((e) => e.textContent.trim()));
      assert.deepStrictEqual(panels, ['תסומן ככפילות', 'המקור שנשאר']);
      const text = await page.$eval('.dup-compare', (el) => el.textContent);
      assert.match(text, /עמית יעקובי/, 'the row to be voided');
      assert.match(text, /עמית בורנשטיין/, 'and the one that survives');
      assert.match(text, /pay-yaakovi/);
      assert.match(text, /pay-amit/);
      // Both agree on the two things that make it a duplicate.
      const flags = await page.$eval('.dup-flags', (el) => el.textContent);
      assert.match(flags, /אותו סכום/);
      assert.match(flags, /אותו מחזור/);
      // The note is pre-filled with the original's id, and editable.
      assert.match(await page.$eval('.dup-note', (el) => el.value), /כפילות של pay-amit/);
      assert.strictEqual(state.posts.filter((p) => p && p.action === 'savePayment').length, 0,
        'opening the comparison writes nothing');

      // Cancelling leaves the row exactly as it was.
      await page.click('.dup-modal [data-action="cancel"]');
      await page.waitForFunction(`!document.querySelector('.dup-modal')`);
      assert.strictEqual(await page.evaluate(`state.payments[1].status`), 'paid');
    });
  });

test('confirming voids the row, keeps its money, and halves the month\'s revenue',
  { skip }, async () => {
    await withPage(async ({ page, state }) => {
      /* ₪30,000 incl. VAT × 24/30 days in September ÷ 1.18 = ₪20,339 per row.
         Two rows read as ₪40,678 — the same money, counted twice. */
      const before = await revenueDigits(page);
      assert.strictEqual(before, 40678, 'before: the duplicate is double-counted');

      await page.evaluate(`
        document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
        document.getElementById('screen-reconnect').classList.remove('hidden');
        renderReconnect();
      `);
      await page.click('.cand-dup');
      await page.waitForSelector('.dup-modal');
      await page.click('.dup-modal [data-action="confirm"]');
      await page.waitForFunction(`state.payments.find(p => p.id === 'pay-yaakovi').status === 'void'`);

      const post = state.posts.filter((p) => p && p.action === 'savePayment').pop();
      assert.strictEqual(post.payment.id, 'pay-yaakovi');
      assert.strictEqual(post.payment.status, 'void');
      assert.strictEqual(post.payment.linkStatus, 'duplicate');
      assert.match(post.payment.linkNote, /pay-amit/);
      /* THE ROW IS NEVER DELETED and the money stays on it — that record is
         the only evidence the ₪30,000 was entered twice. */
      assert.strictEqual(post.payment.amount, 30000);
      assert.strictEqual(post.payment.amountPaid, 30000);

      assert.strictEqual(await revenueDigits(page), 20339, 'after: counted once');
    });
  });

test('a voided row leaves the worklist, stays on the screen, and locks its undo',
  { skip }, async () => {
    await withPage(async ({ page }) => {
      await page.click('.cand-dup');
      await page.waitForSelector('.dup-modal');
      await page.click('.dup-modal [data-action="confirm"]');
      await page.waitForFunction(
        `document.getElementById('reconnect-count').textContent === '0'`);

      const list = await page.$eval('#reconnect-list', (el) => el.textContent);
      assert.match(list, /סומנו ככפילות/, 'it is still shown, under its own heading');
      assert.match(list, /עמית יעקובי/);
      assert.ok(await page.$('.reconnect-row.voided'));
      /* ורד may mark a duplicate and may not unmark one, so she is told whom
         to ask instead of being handed a button that would be refused. */
      assert.strictEqual(await page.$$eval('.reconnect-unvoid', (e) => e.length), 0);
      assert.match(await page.$eval('.reconnect-locked', (el) => el.textContent),
        /פנו לסנדרה/);
    });
  });

test('Sandra, and only Sandra, is offered the un-void', { skip }, async () => {
  await withPage(async ({ page, state }) => {
    await page.click('.cand-dup');
    await page.waitForSelector('.dup-modal');
    await page.click('.dup-modal [data-action="confirm"]');
    await page.waitForSelector('.reconnect-unvoid');
    assert.strictEqual(await page.$$eval('.reconnect-locked', (e) => e.length), 0);

    await page.click('.reconnect-unvoid');
    await page.waitForFunction(`state.payments.find(p => p.id === 'pay-yaakovi').status !== 'void'`);
    const post = state.posts.filter((p) => p && p.action === 'savePayment').pop();
    // Restored from the money the row still carries — exact, because voiding
    // never touched it.
    assert.strictEqual(post.payment.status, 'paid');
    assert.strictEqual(post.payment.linkStatus, '');
    assert.strictEqual(await revenueDigits(page), 40678, 'and the money comes back');
  }, 'סנדרה');
});

test('the גבייה row shows a void payment as void, and will not let it be edited',
  { skip }, async () => {
    await withPage(async ({ page }) => {
      /* The daily list finds a row by the id paymentId() computes for the
         patient and the due date, so the planted row must carry exactly that
         id — otherwise renderBilling builds a fresh placeholder and the test
         would be asserting against a row that is not the one on the sheet. */
      await page.evaluate(`
        const P = state.patients[0];
        state.payments = [normalizePayment({
          id: paymentId(P, '2026-09-07'), patientUid: 'id-amit',
          patientId: patientKey(P), patientName: P.name, houseId: 'arfoni',
          dueDate: '2026-09-07', amount: 30000, amountPaid: 30000, balance: 0,
          status: 'void', linkStatus: 'duplicate', linkNote: 'כפילות של pay-amit',
        })];
        state.billingDate = '2026-09-07';
        document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
        document.getElementById('screen-billing').classList.remove('hidden');
        renderBilling();
      `);
      await page.waitForSelector('.billing-row');
      const badges = await page.$$eval('.badge.void', (els) => els.map((e) => e.textContent.trim()));
      assert.ok(badges.includes('מבוטל'), 'got ' + JSON.stringify(badges));
      // Its select is disabled: the way back is the שיוך תשלומים screen, where
      // the decision was taken and where the audit trail lives.
      const anyEnabled = await page.$$eval('.billing-row',
        (rows) => rows.some((r) => r.querySelector('.badge.void')
          && !r.querySelector('.billing-status').disabled));
      assert.strictEqual(anyEnabled, false);
    });
  });
