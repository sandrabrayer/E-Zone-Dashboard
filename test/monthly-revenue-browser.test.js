/* Real-browser cross-check for the הכנסות חודשיות screen.
 *
 * test/monthly-revenue.test.js proves the ALLOCATION in a vm sandbox and is the
 * guard that runs in CI. This file proves the other half the only way that is
 * beyond argument: load the real index.html and app.js in Chromium, seed the
 * state the app would have loaded from Sheets, open the screen, and read the
 * figures off the rendered DOM. A renderer that throws, an id that does not
 * exist, or a number formatted into the wrong card all fail here and nowhere
 * else.
 *
 * It is the Dashboard counterpart of the Playwright e2e in ezone-outpatient
 * PR #109, and it asserts the SAME worked example: ₪2,542 ex-VAT for January
 * from two straddling cycles. If the two apps ever disagree, one of these two
 * tests goes red.
 *
 * SKIPPED unless BOTH `playwright` resolves AND a Chromium binary is present,
 * so it is inert in CI — same contract as test/spinner-glyph-browser.test.js
 * (the repo has one dependency, express, and adding a browser to `npm ci`
 * would cost minutes per run). It runs wherever a browser is available — e.g.
 * Claude Code's own sandbox, where /opt/pw-browsers/chromium ships
 * preinstalled:
 *
 *     PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --no-save playwright
 *     node --test test/monthly-revenue-browser.test.js
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
  // Same discovery fallback the sandbox needs when playwright is installed
  // globally rather than into this one-dependency repo.
  try {
    const groot = require('node:child_process').execSync('npm root -g').toString().trim();
    playwright = require(path.join(groot, 'playwright'));
  } catch (_) { /* still unavailable — skip */ }
}

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

const TYPES = {
  '.css': 'text/css',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
};

/* Serve public/ over http. Every /api/* call answers with a shape the app can
 * swallow, so the boot sequence settles instead of retrying — this test is
 * about RENDERING, and the data is injected directly below. */
function serve() {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    if (u.pathname.startsWith('/api/')) {
      res.writeHead(200, { 'Content-Type': TYPES['.json'] });
      return res.end(JSON.stringify({ ok: true, user: 'ורד', patients: [], leads: [], payments: [] }));
    }
    const rel = u.pathname === '/' ? 'index.html' : u.pathname.replace(/^\//, '');
    const file = path.join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file)) {
      res.writeHead(404); return res.end('nf');
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, () => resolve({ server, port: server.address().port })));
}

/* The worked example, identical to the one ezone-outpatient #109 drives:
 * a ₪3,000 patient whose entry day is the 20th, with December and January
 * both paid in full. January is therefore exactly one month of money —
 * 19 days from the December cycle plus 12 from the January one. */
async function openSeeded(page, port) {
  // 'networkidle', not 'load': the app boots by fetching /api/* and then calls
  // renderAll(). A seed planted before that resolves would be overwritten by
  // the stub's empty arrays and the screen would repaint as zeroes — which is
  // exactly what this test caught the first time it ran.
  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'networkidle' });
  await page.evaluate(seedScript());
}

function seedScript() {
  return `
    const KEY = patientKey({ houseId: 'arfoni', name: 'דנה כהן', date: '2025-06-20' });
    state.patients = [{
      id: 'p1', houseId: 'arfoni', name: 'דנה כהן', date: '2025-06-20',
      pay: 3000, status: 'active', exitDate: '',
    }];
    state.payments = [
      { id: 'a', patientId: KEY, patientName: 'דנה כהן', houseId: 'arfoni',
        dueDate: '2025-12-20', amount: 3000, amountPaid: 3000, status: 'paid', balance: 0 },
      { id: 'b', patientId: KEY, patientName: 'דנה כהן', houseId: 'arfoni',
        dueDate: '2026-01-20', amount: 3000, amountPaid: 3000, status: 'paid', balance: 0 },
    ];
    state.credits = [];
    state.billingOverrides = [];
    state.revenueMonth = '2026-01';
    // Reveal the app shell and the screen, the way initTabs would.
    const app = document.getElementById('app');
    if (app) app.classList.remove('hidden');
    document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
    document.getElementById('screen-revenue').classList.remove('hidden');
    renderMonthlyRevenue();
  `;
}

test('the monthly revenue screen renders the four figures in Chromium', { skip }, async () => {
  const { server, port } = await serve();
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await openSeeded(page, port);

    const text = (sel) => page.$eval(sel, (el) => el.textContent.trim());

    /* THE CROSS-APP NUMBER. ₪3,000 incl. VAT ÷ 1.18 = ₪2,542 — the same
     * figure #109's e2e reads off the outpatient screen. */
    const received = await text('#rev-received');
    assert.strictEqual(received.replace(/[^\d]/g, ''), '2542', 'נגבה בפועל, got ' + received);
    assert.strictEqual((await text('#rev-expected')).replace(/[^\d]/g, ''), '0',
      'the month is fully paid, so nothing is expected');
    assert.strictEqual((await text('#rev-net')).replace(/[^\d]/g, ''), '2542');
    assert.match(await text('#rev-month-label'), /2026/);

    /* The drill-down shows the split that produced it — the arithmetic is
     * visible on screen, not merely asserted in a unit test. */
    const detail = await text('#rev-detail');
    assert.match(detail, /12 מתוך 31 ימים/, 'the January cycle contributes 12 of its 31 days');
    assert.match(detail, /19 מתוך 31 ימים/, 'the December cycle contributes 19');
    assert.match(detail, /נגבה בפועל/, 'the group heading is rendered');
    /* Both coverage windows are printed, so the reader can check the maths —
       in the app-wide human date format (formatDate), the same one the גבייה
       row uses for the same window. Only the DISPLAY changed: the underlying
       row.coverageStart / coverageEnd are still bare ISO. */
    assert.match(detail, /20\.1\.2026 → 19\.2\.2026/);
    assert.match(detail, /20\.12\.2025 → 19\.1\.2026/);

    // The house breakdown resolves the id to its display name.
    assert.match(await text('#rev-by-house'), /קיסריה עפרוני/);

    assert.deepStrictEqual(errors, [], 'no page errors while rendering');
  } finally {
    await browser.close();
    server.close();
  }
});

test('February shows cash and forecast as two distinct figures', { skip }, async () => {
  const { server, port } = await serve();
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await openSeeded(page, port);
    await page.evaluate(`state.revenueMonth = '2026-02'; renderMonthlyRevenue();`);

    const num = async (sel) => Number((await page.$eval(sel, (el) => el.textContent)).replace(/[^\d]/g, ''));
    const received = await num('#rev-received');
    const expected = await num('#rev-expected');
    assert.ok(received > 0, 'February carries cash from the January cycle');
    assert.ok(expected > 0, 'and a forecast for the February one');
    assert.notStrictEqual(received, expected, 'they are different figures');
    // They are never printed as one number: NET is the only place they meet,
    // and it is labelled a projection right under the card.
    assert.match(await page.$eval('#screen-revenue', (el) => el.textContent), /נגבה \+ צפוי − זיכויים \(תחזית\)/);

    // The composition panel names the forecast for what it is.
    assert.match(await page.$eval('#rev-expected-breakdown', (el) => el.textContent), /מחזור עתידי|חויב וטרם נגבה|מחזור שחלף/);
    assert.deepStrictEqual(errors, [], 'no page errors while rendering');
  } finally {
    await browser.close();
    server.close();
  }
});

test('the daily גבייה screen still renders, with its own date untouched', { skip }, async () => {
  const { server, port } = await serve();
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await openSeeded(page, port);

    // Switching months on the monthly screen must not touch the daily date.
    const before = await page.evaluate(`state.billingDate = '2026-03-04'; state.billingDate`);
    await page.evaluate(`state.revenueMonth = '2026-05'; renderMonthlyRevenue();`);
    assert.strictEqual(await page.evaluate('state.billingDate'), before,
      'the daily screen kept its own date');

    // And the daily screen still paints.
    await page.evaluate(`
      document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
      document.getElementById('screen-billing').classList.remove('hidden');
      renderBilling();
    `);
    assert.ok(await page.$eval('#billing-due-list', (el) => el.innerHTML.length > 0),
      'the daily due list rendered something');
    assert.deepStrictEqual(errors, [], 'no page errors while rendering');
  } finally {
    await browser.close();
    server.close();
  }
});
