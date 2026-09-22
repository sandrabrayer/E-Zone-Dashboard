/* Real-browser cross-check for שיוך תשלומים — the reconnect tool.
 *
 * test/detached-payments.test.js proves the RULES in a vm sandbox and is the
 * guard that runs in CI. This file proves the half that is only provable in a
 * browser: load the real index.html and app.js in Chromium, seed the state the
 * app would have loaded from Sheets — including the live sheet's own detached
 * rows — and drive the screen with actual clicks. A candidate list that never
 * renders, a link button that posts the wrong body, or a "not a patient"
 * dismissal that slips through without a reason fails here and nowhere else.
 *
 * SKIPPED unless BOTH `playwright` resolves AND a Chromium binary is present,
 * so it is inert in CI — same contract as the other browser suites:
 *
 *     PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --no-save playwright
 *     node --test test/detached-payments-browser.test.js
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

/* The roster and the rows, from the bug report:
 *   עמית בורנשטיין (עפרוני, entered 7.9) with his OWN ₪30,000 on 07/09;
 *   "עמית יעקובי" — ₪30,000 on the same day, attached to nobody;
 *   "שחר חיון " — a trailing space, so its triple matches no patient;
 *   "החזר ספק" — not a patient at all. */
function seedScript() {
  return `
    state.patients = [
      normalizePatient({ id: 'id-amit', houseId: 'arfoni', name: 'עמית בורנשטיין',
        date: '2026-09-07', pay: 30000, status: 'active', exitDate: '' }),
      normalizePatient({ id: 'id-shachar', houseId: 'arfoni', name: 'שחר חיון',
        date: '2026-09-07', pay: 35000, status: 'active', exitDate: '' }),
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
      normalizePayment({ id: 'pay-refund', patientUid: '',
        patientId: 'arfoni::החזר ספק::2026-08-01', patientName: 'החזר ספק',
        houseId: 'arfoni', dueDate: '2026-08-01', amount: 1200, amountPaid: 1200,
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

async function open(page, port) {
  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'networkidle' });
  await page.evaluate(seedScript());
}

async function withPage(fn, srvState) {
  const state = Object.assign({ posts: [], failWrites: false }, srvState || {});
  const { server, port } = await serve(state);
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await open(page, port);
    await fn({ page, port, state, errors });
    assert.deepStrictEqual(errors, [], 'no page errors');
  } finally {
    await browser.close();
    server.close();
  }
}

const rowFor = (page, id) => page.$(`.reconnect-row:has(.p-name:text-is("${id}"))`);

test('the screen lists exactly the rows nobody can place, with their evidence',
  { skip }, async () => {
    await withPage(async ({ page }) => {
      await page.waitForSelector('.reconnect-row');
      const names = await page.$$eval('.reconnect-row .p-name', (els) => els.map((e) => e.textContent.trim()));
      assert.deepStrictEqual(names.sort(), ['החזר ספק', 'עמית יעקובי'].sort(),
        'the linked row is not on the worklist; got ' + names);
      assert.strictEqual(Number(await page.$eval('#reconnect-count', (el) => el.textContent)), 2);
      assert.strictEqual(Number(await page.$eval('#reconnect-linked-count', (el) => el.textContent)), 1);
      // The nav badge says so without anyone opening the screen.
      assert.strictEqual(await page.$eval('#reconnect-badge', (el) => el.textContent), '2');
      // The stored triple is shown verbatim — it IS the evidence.
      assert.match(await page.$eval('.reconnect-id', (el) => el.textContent), /arfoni::/);
    });
  });

test('the candidate carries its reasons, and a possible double entry is warned about',
  { skip }, async () => {
    await withPage(async ({ page }) => {
      const row = await rowFor(page, 'עמית יעקובי');
      assert.ok(row, 'the detached row rendered');
      const why = await row.$eval('.cand-why', (el) => el.textContent);
      assert.match(why, /שם דומה/);
      assert.match(why, /תאריך כניסה/);
      assert.match(await row.$eval('.cand-name', (el) => el.textContent), /עמית בורנשטיין/);
      /* עמית בורנשטיין already has ₪30,000 on 07/09 — a rename, or a double
         entry, and only a person knows which. Warned, and still linkable. */
      assert.match(await row.$eval('.cand-warn', (el) => el.textContent), /רישום כפול/);
      assert.ok(await row.$('.reconnect-cand.has-dup'));
      assert.strictEqual(await row.$eval('.cand-link', (el) => el.disabled), false,
        'a warning must not block the decision');
    });
  });

test('linking writes patientUid through savePayment, and moves no money', { skip }, async () => {
  await withPage(async ({ page, state }) => {
    const row = await rowFor(page, 'עמית יעקובי');
    await (await row.$('.cand-link')).click();
    await page.waitForFunction(`state.payments.find(p => p.id === 'pay-yaakovi').patientUid === 'id-amit'`);

    const post = state.posts.find((p) => p && p.action === 'savePayment');
    assert.ok(post, 'it went through the one payment write path');
    assert.strictEqual(post.payment.id, 'pay-yaakovi');
    assert.strictEqual(post.payment.patientUid, 'id-amit');
    assert.strictEqual(post.payment.linkStatus, 'linked');
    // Not one shekel moved.
    assert.strictEqual(post.payment.amount, 30000);
    assert.strictEqual(post.payment.amountPaid, 30000);
    assert.strictEqual(post.payment.status, 'paid');
    assert.strictEqual(post.payment.balance, 0);
    // And the row leaves the worklist immediately.
    await page.waitForFunction(
      `document.getElementById('reconnect-count').textContent === '1'`);
  });
});

test('"not a patient" is refused without a reason, and recorded with one', { skip }, async () => {
  await withPage(async ({ page, state }) => {
    const row = await rowFor(page, 'החזר ספק');
    await (await row.$('.reconnect-not-patient')).click();
    await page.waitForFunction(`document.body.textContent.includes('יש לציין סיבה')`);
    assert.strictEqual(state.posts.filter((p) => p && p.action === 'savePayment').length, 0,
      'a dismissal nobody can audit is not saved');

    await (await row.$('.reconnect-note')).fill('החזר לספק, לא שורת מטופל');
    await (await row.$('.reconnect-not-patient')).click();
    await page.waitForFunction(
      `state.payments.find(p => p.id === 'pay-refund').linkStatus === 'not_a_patient'`);
    const post = state.posts.filter((p) => p && p.action === 'savePayment').pop();
    assert.strictEqual(post.payment.linkStatus, 'not_a_patient');
    assert.strictEqual(post.payment.linkNote, 'החזר לספק, לא שורת מטופל');
    /* WHO and WHEN are not sent — the server stamps them from the signed
       session cookie and its own clock. */
    assert.ok(!post.payment.linkedBy, 'linkedBy is the server\'s to write');
    assert.ok(!post.payment.linkedAt, 'and so is linkedAt');
    // It leaves the worklist and appears under the decisions taken.
    await page.waitForFunction(
      `document.getElementById('reconnect-list').textContent.includes('סומנו כ"לא מטופל"')`);
  });
});

test('the backfill button says what it will do, and only runs on a click', { skip }, async () => {
  await withPage(async ({ page, state }) => {
    /* Plant a row whose triple names exactly one patient but which carries no
       uid — the "שחר חיון " case, trailing space and all. */
    await page.evaluate(`
      state.payments.push(normalizePayment({ id: 'pay-shachar', patientUid: '',
        patientId: 'arfoni::שחר חיון ::2026-09-07', patientName: 'שחר חיון ',
        houseId: 'arfoni', dueDate: '2026-09-07', amount: 35000, amountPaid: 35000,
        status: 'paid', balance: 0 }));
      renderReconnect();
    `);
    // It is NOT on the worklist: the loose triple still places it.
    const names = await page.$$eval('.reconnect-row .p-name', (els) => els.map((e) => e.textContent.trim()));
    assert.ok(!names.includes('שחר חיון'), 'the trailing space did not orphan it');

    const label = await page.$eval('#reconnect-backfill', (el) => el.textContent);
    assert.match(label, /השלמת שיוך ל־1 שורות/, 'got ' + label);
    assert.strictEqual(state.posts.filter((p) => p && p.action === 'savePayment').length, 0,
      'nothing was written by merely opening the screen');

    await page.click('#reconnect-backfill');
    await page.waitForFunction(
      `state.payments.find(p => p.id === 'pay-shachar').patientUid === 'id-shachar'`);
    const post = state.posts.filter((p) => p && p.action === 'savePayment').pop();
    assert.strictEqual(post.payment.patientUid, 'id-shachar');
    assert.strictEqual(post.payment.amountPaid, 35000, 'the backfill moves no money');
  });
});
