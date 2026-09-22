/* Real-browser cross-check for the stay window and the records cutoff.
 *
 * test/stay-window-records-cutoff.test.js proves the RULES in a vm sandbox and
 * is the guard that runs in CI. This file proves the half that is only
 * provable in a browser: load the real index.html and app.js in Chromium, seed
 * the state the app would have loaded from Sheets, and look at what the גבייה
 * and הכנסות חודשיות screens actually paint. A patient still listed two months
 * before he arrived, a debt total that quietly includes a pre-cutoff cycle, or
 * a bucket that renders nowhere, fails here and nowhere else.
 *
 * SKIPPED unless BOTH `playwright` resolves AND a Chromium binary is present,
 * so it is inert in CI — same contract as the other browser suites:
 *
 *     PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --no-save playwright
 *     node --test test/stay-window-records-cutoff-browser.test.js
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

/* The roster from the bug report, trimmed to what each assertion needs:
 * עמית בורנשטיין entered עפרוני on 7.9.2026 — and used to appear on the
 * 07/07/2026 גבייה list. רות entered 10.7.2026 and was discharged 20.8.2026,
 * so July is hers and September is not. יוני entered 20.6.2026: a real cycle,
 * from before this app was recording payments. */
function seedScript(extra) {
  return `
    state.patients = [
      { id: 'a', houseId: 'arfoni', name: 'עמית בורנשטיין', date: '2026-09-07',
        pay: 35000, status: 'active', exitDate: '' },
      { id: 'b', houseId: 'arfoni', name: 'רות', date: '2026-07-10',
        pay: 30000, status: 'released', exitDate: '2026-08-20' },
      { id: 'c', houseId: 'arfoni', name: 'יוני', date: '2026-06-20',
        pay: 30000, status: 'active', exitDate: '' },
    ];
    state.payments = [];
    state.credits = [];
    state.billingOverrides = [];
    state.mode = 'edit';
    ${extra || ''}
    const app = document.getElementById('app');
    if (app) app.classList.remove('hidden');
  `;
}

async function open(page, port, extra) {
  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'networkidle' });
  await page.evaluate(seedScript(extra));
}

async function withPage(fn) {
  const state = { posts: [], failWrites: false };
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

const showBilling = (page, dateISO) => page.evaluate(`
  state.billingDate = '${dateISO}';
  document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
  document.getElementById('screen-billing').classList.remove('hidden');
  renderBilling();
`);
const showRevenue = (page, month) => page.evaluate(`
  state.revenueMonth = '${month}';
  document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
  document.getElementById('screen-revenue').classList.remove('hidden');
  renderMonthlyRevenue();
`);
const digits = async (page, sel) =>
  Number((await page.$eval(sel, (el) => el.textContent)).replace(/[^\d]/g, ''));

test('the September admission is gone from the 07/07 גבייה list', { skip }, async () => {
  await withPage(async ({ page }) => {
    await showBilling(page, '2026-07-07');
    const list = await page.$eval('#billing-due-list', (el) => el.textContent);
    assert.ok(!list.includes('עמית בורנשטיין'),
      'he entered on 7.9.2026 — 07/07/2026 is two months before that. Got: ' + list);
    assert.strictEqual(await digits(page, '#bill-due-count'), 0);
    assert.strictEqual(await digits(page, '#bill-due-total'), 0);
    // And he IS there on his own entry day.
    await showBilling(page, '2026-09-07');
    assert.match(await page.$eval('#billing-due-list', (el) => el.textContent), /עמית בורנשטיין/);
    assert.strictEqual(await digits(page, '#bill-due-total'), 35000);
  });
});

test('a pre-cutoff cycle is listed, badged, and left out of סך לגבייה', { skip }, async () => {
  await withPage(async ({ page }) => {
    // 20 June 2026 — יוני's entry day, before RECORDS_COMPLETE_FROM.
    await showBilling(page, '2026-06-20');
    const list = await page.$eval('#billing-due-list', (el) => el.textContent);
    assert.match(list, /יוני/, 'the cycle is real and still shown');
    assert.match(list, /לפני תחילת הרישום/, 'and says why it is not counted');
    assert.ok(await page.$('.badge.pre-records'), 'the badge renders');
    assert.strictEqual(await digits(page, '#bill-due-count'), 1, 'it is a listed cycle');
    assert.strictEqual(await digits(page, '#bill-due-total'), 0, 'but not a debt');
    // The note under the cards states the rule and names the date.
    const note = await page.$eval('#bill-pre-records-note', (el) => el.textContent);
    // DD/MM/YYYY, the Israeli display form (formatDateHe) — not the he-IL
    // locale default "1.7.2026" this used to assert.
    assert.match(note, /01\/07\/2026/, 'got ' + note);
    assert.match(note, /אינם נספרים כחוב/);

    // A post-cutoff date has no note at all.
    await showBilling(page, '2026-07-10');
    assert.strictEqual(await digits(page, '#bill-due-total'), 30000);
    assert.strictEqual(await page.$$eval('#bill-pre-records-note', (e) => e.length), 0);
  });
});

test('July counts the patient discharged in August, and buckets the June cycle apart',
  { skip }, async () => {
    await withPage(async ({ page }) => {
      await showRevenue(page, '2026-07');
      const detail = await page.$eval('#rev-detail', (el) => el.textContent);
      // B: רות was in the house all July; her status in September is irrelevant.
      assert.match(detail, /רות/, 'the August discharge is counted for July');
      assert.ok(!detail.includes('עמית בורנשטיין'), 'the September admission is not');
      // C: the June cycle appears under its own heading, and in no total.
      assert.match(detail, /לפני תחילת הרישום — לא נספר/);
      assert.ok(await page.$('.billing-row.rev-pre-records'), 'the row renders, muted');
      const comp = await page.$eval('#rev-expected-breakdown', (el) => el.textContent);
      assert.match(comp, /לא נכלל בצפוי ובנטו/);

      /* The arithmetic, on screen. רות: 30,000 × 22/31 of her 10 Jul cycle.
       * יוני: 30,000 × 12/31 of his 20 Jul cycle. The 20 Jun cycle's
       * 19 July days (₪19,000 incl. VAT) are in NEITHER figure. */
      const expected = await digits(page, '#rev-expected');
      const exVat = (n) => Math.round(Math.round(n * 100) / 100 / 1.18);
      assert.strictEqual(expected,
        exVat(30000 * 22 / 31) + exVat(30000 * 12 / 31),
        'צפוי is the two in-records cycles and nothing else');
    });
  });
