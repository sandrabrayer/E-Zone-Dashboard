/* Real-browser check for «חובות פתוחים» (CHANGELOG-debt-aging-ui.md).
 *
 * test/debt-aging-ui.test.js proves the view and the HTML in a vm sandbox and
 * is the guard that runs in CI. This file loads the real index.html + app.js
 * in Chromium, opens the section, and reads the rendered DOM: the two blocks
 * (never one summed figure), the drill-down expanding house → patient →
 * cycles, the filters, and an escaped hostile name that never executes.
 *
 * SKIPPED unless BOTH `playwright` resolves AND a Chromium binary is present,
 * so it is inert in CI — the same contract as monthly-revenue-browser.test.js.
 *
 *     PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --no-save playwright
 *     node --test test/debt-aging-ui-browser.test.js
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
const chromiumPath = [process.env.EZONE_CHROMIUM, '/opt/pw-browsers/chromium'].filter(Boolean)
  .find((p) => { try { return fs.existsSync(p); } catch (_) { return false; } });
const skip = !playwright ? 'playwright is not installed' : (!chromiumPath ? 'no Chromium binary found' : false);

const TYPES = { '.css': 'text/css', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png' };

const EVIL = '<img src=x onerror="window.__pwned=1">';
const cyc = (start, end, expected, received, bucket, kind, days) =>
  ({ start, end, expected, received, balance: expected - received, bucket, kind, days });
const DATA = {
  ok: true, asOf: '', recordsCutoff: '2026-07-01', vatInclusive: true,
  totals: {
    recorded_debt: { count: 1, total: 25000, d0_7: 0, d8_30: 25000, d31_60: 0, d61_plus: 0 },
    unrecorded_cycles: { count: 2, total: 43000, d0_7: 15000, d8_30: 0, d31_60: 28000, d61_plus: 0 },
  },
  byHouse: [],
  byPatient: [
    { patientId: 'pt-1', name: 'אבי כהן', houseId: 'ramot', status: 'active', entryDate: '2026-07-10', exitDate: '',
      cycles: [cyc('2026-09-10', '2026-10-09', 25000, 0, 'd8_30', 'recorded', 20)] },
    { patientId: 'pt-4', name: 'נועה ים', houseId: 'pardes', status: 'released', entryDate: '2026-07-15', exitDate: '2026-08-20',
      cycles: [cyc('2026-08-15', '2026-08-20', 28000, 0, 'd31_60', 'unrecorded', 46)] },
    { patientId: 'pt-6', name: EVIL, houseId: 'asher', status: 'active', entryDate: '2026-07-31', exitDate: '',
      cycles: [cyc('2026-09-30', '2026-10-30', 15000, 0, 'd0_7', 'unrecorded', 0)] },
  ],
  detachedPayments: { count: 0, amount: 0, receivedByAsOf: 0, rows: [] },
  pendingCredits: { count: 1, total: 5000, createdDateUnknown: 0, byHouse: [{ houseId: 'pardes', count: 1, total: 5000 }] },
  receivedDateUnknown: { count: 0, amount: 0 },
  outsideStay: { count: 0, rows: [] }, releasedWithoutExit: { count: 0, rows: [] }, noEntryDate: { count: 0, rows: [] },
  voidExcluded: 0,
};

function serve(asked) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    if (u.pathname.startsWith('/api/')) {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch (_) { /* GET */ }
        res.writeHead(200, { 'Content-Type': TYPES['.json'] });
        if (body.action === 'debtAging') {
          asked.push(body.asOf);
          return res.end(JSON.stringify(Object.assign({}, DATA, { asOf: body.asOf })));
        }
        res.end(JSON.stringify({ ok: true, user: 'ורד', patients: [], leads: [], payments: [] }));
      });
      return;
    }
    const rel = u.pathname === '/' ? 'index.html' : u.pathname.replace(/^\//, '');
    const file = path.join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file)) { res.writeHead(404); return res.end('nf'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, () => resolve({ server, port: server.address().port })));
}

test('«חובות פתוחים» renders in Chromium: two blocks, drill-down, filters, escaped names', { skip }, async () => {
  const asked = [];
  const { server, port } = await serve(asked);
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'networkidle' });
    await page.evaluate(() => {
      const app = document.getElementById('app');
      if (app) app.classList.remove('hidden');
      document.querySelectorAll('.screen').forEach((s) => s.classList.add('hidden'));
      document.getElementById('screen-billing').classList.remove('hidden');
    });
    assert.deepStrictEqual(asked, [], 'nothing fetched before the section is opened');
    await page.click('#debt-aging-view > summary');
    await page.waitForSelector('#debt-aging .debt-block');
    assert.strictEqual(asked.length, 1);

    assert.strictEqual(await page.$$eval('#debt-aging .debt-block', (els) => els.length), 2);
    const totals = await page.$$eval('#debt-aging .debt-block-total', (els) => els.map((e) => e.textContent.trim()));
    assert.deepStrictEqual(totals, ['₪ 25,000', '₪ 43,000']);
    const text = await page.$eval('#debt-aging', (el) => el.textContent);
    assert.ok(!text.includes('68,000'), 'the two blocks are never summed');
    assert.ok(text.includes('זיכויים ממתינים — לא מקוזזים מהחוב'));

    // drill-down: closed until clicked, then house → patient → cycles
    assert.strictEqual(await page.isVisible('[data-patient="pt-1"]'), false);
    await page.click('details.debt-house[data-house="ramot"] > summary');
    assert.strictEqual(await page.isVisible('[data-patient="pt-1"] > summary'), true);
    await page.click('[data-patient="pt-1"] > summary');
    const cells = await page.$$eval('[data-patient="pt-1"] tr.debt-cycle td', (tds) => tds.map((t) => t.textContent.trim()));
    assert.deepStrictEqual(cells, ['10/09/2026', '09/10/2026', '₪ 25,000', '₪ 0', '₪ 25,000', '8–30', 'חוב רשום']);

    // the hostile name is text, never markup
    const evilName = await page.$eval('[data-patient="pt-6"] .p-name', (el) => el.textContent);
    assert.strictEqual(evilName, EVIL);
    assert.strictEqual(await page.evaluate(() => window.__pwned), undefined);

    // filters re-render without a fetch
    await page.selectOption('#debt-status', 'discharged');
    assert.strictEqual(asked.length, 1);
    assert.deepStrictEqual(await page.$$eval('#debt-aging .debt-block-total', (els) => els.map((e) => e.textContent.trim())), ['₪ 0', '₪ 28,000']);
    await page.selectOption('#debt-status', 'all');
    await page.selectOption('#debt-house', 'ramot');
    assert.deepStrictEqual(await page.$$eval('#debt-aging .debt-block-total', (els) => els.map((e) => e.textContent.trim())), ['₪ 25,000', '₪ 0']);

    // «סוף חודש קודם» refetches with the previous month end
    await page.click('#debt-asof-prev-month');
    await page.waitForFunction(() => document.querySelector('#debt-aging .debt-block'));
    assert.strictEqual(asked.length, 2);
    assert.match(asked[1], /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(asked[1] < asked[0]);
    assert.ok((await page.$eval('#debt-aging', (el) => el.textContent)).includes('בתאריך עבר'));
    assert.deepStrictEqual(errors, []);
  } finally {
    await browser.close();
    server.close();
  }
});
