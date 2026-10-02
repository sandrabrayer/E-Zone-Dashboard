/* Real-browser check of the גבייה tab's colour-coded groups
 * (CHANGELOG-billing-tab-section-colors.md).
 *
 * test/billing-tab-section-colors.test.js proves the tokens, the markup and
 * the contrast in a vm sandbox and is the guard that runs in CI. This file
 * loads the real index.html + app.js + style.css in Chromium with fixture
 * data and reads the COMPUTED styles: each group's heading is bold, larger
 * than the row text, in its own colour with a 4px bar on the right (RTL
 * start); each panel is tinted; nothing scrolls sideways at 360px; the
 * «… מופיעים ב״חובות פתוחים״» line opens and loads that section.
 *
 * Set SHOT_DIR to also write billing-360.png and billing-1280.png.
 *
 * SKIPPED unless BOTH `playwright` resolves AND a Chromium binary is present,
 * so it is inert in CI — the same contract as the other *-browser tests. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const PUBLIC = path.join(__dirname, '..', 'public');
const { GROUP_COLORS, hexToRgb } = require('../lib/report-colors');

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

const FORECAST = {
  ok: true, today: '2026-10-02', recordsCutoff: '2026-07-01', payoutDateIfDecidedToday: '2026-10-15', zeroByPolicyCount: 1,
  decided: { count: 0, total: 0, byPayoutDate: [], byHouse: [] },
  awaiting_decision: { count: 1, total: 6200, byPayoutDate: [{ payoutDate: '2026-10-15', count: 1, total: 6200,
    rows: [{ patientName: 'מיכל לוי', houseId: 'pardes', entryDate: '2026-08-10', exitDate: '2026-09-24', suggestedAmount: 6200, rule: 'residential_prorata', payoutDate: '2026-10-15' }] }],
  byHouse: [{ houseId: 'pardes', count: 1, total: 6200 }] },
  missing_payment_data: { count: 2, rows: [
    { patientName: 'נועה ים', houseId: 'rehab', entryDate: '2026-09-01', exitDate: '2026-09-05', note: '' },
    { patientName: 'עדי כץ', houseId: 'asher', entryDate: '2026-07-05', exitDate: '2026-08-20', note: '' }] },
  unresolved: { count: 1, rows: [{ patientName: 'יוסי', houseId: 'mars', entryDate: '2026-08-01', exitDate: '2026-09-01', error: 'unknown_house' }] },
};
const cyc = (start, end, expected, received, bucket, kind, days) => ({ start, end, expected, received, balance: expected - received, bucket, kind, days });
const AGING = {
  ok: true, asOf: '', recordsCutoff: '2026-07-01', vatInclusive: true,
  totals: { recorded_debt: { count: 1, total: 8000, d0_7: 0, d8_30: 8000, d31_60: 0, d61_plus: 0 },
    unrecorded_cycles: { count: 2, total: 58000, d0_7: 0, d8_30: 28000, d31_60: 30000, d61_plus: 0 } },
  byHouse: [],
  byPatient: [
    { patientId: 'p2', name: 'גל דוד', houseId: 'rehab', status: 'active', entryDate: '2026-08-05', exitDate: '', cycles: [cyc('2026-09-05', '2026-10-04', 20000, 12000, 'd8_30', 'recorded', 27)] },
    { patientId: 'p3', name: 'נועה ים', houseId: 'rehab', status: 'released', entryDate: '2026-09-01', exitDate: '2026-09-05', cycles: [cyc('2026-09-01', '2026-09-05', 28000, 0, 'd8_30', 'unrecorded', 31)] },
    { patientId: 'p4', name: 'עדי כץ', houseId: 'asher', status: 'released', entryDate: '2026-07-05', exitDate: '2026-08-20', cycles: [cyc('2026-08-05', '2026-08-20', 30000, 0, 'd31_60', 'unrecorded', 58)] },
  ],
  detachedPayments: { count: 0, amount: 0, receivedByAsOf: 0, rows: [] },
  pendingCredits: { count: 1, total: 3500, createdDateUnknown: 0, byHouse: [{ houseId: 'ramot', count: 1, total: 3500 }] },
  receivedDateUnknown: { count: 0, amount: 0 }, outsideStay: { count: 0, rows: [] },
  releasedWithoutExit: { count: 0, rows: [] }, noEntryDate: { count: 0, rows: [] }, voidExcluded: 0,
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
        if (body.action) asked.push(body.action);
        if (body.action === 'refundPayoutForecast') return res.end(JSON.stringify(FORECAST));
        if (body.action === 'debtAging') return res.end(JSON.stringify(Object.assign({}, AGING, { asOf: body.asOf })));
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

/* Fixture: two patients due on 02/10, one older partial balance, one pending credit. */
const SEED = `
  state.patients = [
    normalizePatient({ id: 'p1', houseId: 'ramot', name: 'אבי כהן', date: '2026-07-02', pay: 30000, status: 'active', exitDate: '' }),
    normalizePatient({ id: 'p5', houseId: 'sde', name: 'הדס שמעוני', date: '2026-08-02', pay: 24000, status: 'active', exitDate: '' }),
    normalizePatient({ id: 'p2', houseId: 'rehab', name: 'גל דוד', date: '2026-08-05', pay: 20000, status: 'active', exitDate: '' }),
  ];
  state.payments = [
    normalizePayment({ id: paymentId(state.patients[2], '2026-09-05'), patientId: patientKey(state.patients[2]), patientName: 'גל דוד',
      houseId: 'rehab', dueDate: '2026-09-05', amount: 20000, amountPaid: 12000, balance: 8000, status: 'partial' }),
  ];
  state.credits = [{ id: 'credit::p9::2026-09::1', patientId: 'p9', patientKey: 'ramot::רון לוי::2026-07-01', patientName: 'רון לוי',
    houseId: 'ramot', facilityType: 'residential', creditType: 'days_unused', allocationMonth: '2026-09', calculatedAmount: 3500,
    amount: 3500, decidedDate: '2026-10-01', payoutDate: '2026-10-15', status: 'pending', basis: '{}' }];
  state.billingOverrides = [];
  state.billingDate = '2026-10-02';
  state.mode = 'edit';
  const app = document.getElementById('app');
  if (app) app.classList.remove('hidden');
  state.currentScreen = 'billing';
  document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
  document.getElementById('screen-billing').classList.remove('hidden');
  // The billing renderers only, like the other *-browser tests: renderAll()
  // also runs the leads' autosave, which this stub server does not model.
  renderBilling();
  renderCreditsPayouts();
`;

const rgb = (hex) => `rgb(${hexToRgb(hex).join(', ')})`;
const GROUPS = { due: 'due', open: 'open', credits: 'credits', awaiting: 'awaiting', unresolved: 'unresolved', debt: 'debt' };

test('גבייה groups in Chromium: bold coloured headings with a right-side bar, tinted panels, no sideways scroll at 360px', { skip }, async () => {
  const asked = [];
  const { server, port } = await serve(asked);
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  try {
    for (const width of [360, 1280]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'networkidle' });
      await page.evaluate(SEED);
      await page.waitForSelector('#credits-forecast .bill-group--awaiting');

      for (const key of Object.keys(GROUPS)) {
        const s = await page.$eval(`.bill-group--${key} .bill-group-title`, (h) => {
          const cs = getComputedStyle(h);
          const row = document.querySelector('.billing-row .p-name') || document.body;
          const panel = getComputedStyle(h.closest('.bill-group'));
          return { weight: cs.fontWeight, size: parseFloat(cs.fontSize), rowSize: parseFloat(getComputedStyle(row).fontSize),
            color: cs.color, barRight: cs.borderRightWidth, barRightColor: cs.borderRightColor, barLeft: cs.borderLeftWidth,
            bg: panel.backgroundColor, right: h.getBoundingClientRect().right, vw: innerWidth, text: h.textContent };
        });
        assert.strictEqual(s.weight, '700', key);
        assert.ok(s.size > s.rowSize, `${key}: heading ${s.size}px > row ${s.rowSize}px`);
        assert.strictEqual(s.color, rgb(GROUP_COLORS[key]), key + ' colour');
        assert.strictEqual(s.barRight, '4px', key + ' bar on the right (RTL start)');
        assert.strictEqual(s.barRightColor, rgb(GROUP_COLORS[key]));
        assert.strictEqual(s.barLeft, '0px');
        assert.notStrictEqual(s.bg, 'rgba(0, 0, 0, 0)', key + ' tinted panel');
        assert.ok(s.right <= s.vw, `${key}: heading inside the viewport`);
      }
      // the chip takes the group colour
      assert.strictEqual(await page.$eval('#credits-pending-total', (e) => getComputedStyle(e).color), rgb(GROUP_COLORS.credits));
      // labels
      assert.strictEqual((await page.textContent('#credits-forecast-export')).trim(), 'ייצוא זיכויים לאקסל');
      assert.strictEqual((await page.textContent('.forecast-missing-line a')).trim(), '2 משוחררים ללא תשלום רשום — מופיעים ב״חובות פתוחים״');
      const refundText = await page.$eval('#credits-forecast', (e) => e.textContent);
      for (const n of ['נועה ים', 'עדי כץ']) assert.ok(!refundText.includes(n), n + ' is not listed in the refund view');
      // the link opens and loads «חובות פתוחים»
      await page.click('.forecast-missing-line a');
      await page.waitForSelector('#debt-aging .debt-block');
      assert.strictEqual(await page.$eval('#debt-aging-view', (d) => d.open), true);
      assert.ok(asked.includes('debtAging'));
      // no sideways scroll
      const sw = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
      assert.ok(sw[0] <= sw[1], `scrollWidth ${sw[0]} > ${sw[1]}`);
      if (process.env.SHOT_DIR) {
        await page.evaluate(() => window.scrollTo(0, 0));
        const el = await page.$('#screen-billing');
        await el.screenshot({ path: path.join(process.env.SHOT_DIR, `billing-${width}.png`) });
      }
      assert.deepStrictEqual(errors, []);
      await page.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
});
