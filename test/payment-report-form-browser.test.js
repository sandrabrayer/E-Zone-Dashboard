/* The strict «דווח תשלום» form in REAL Chromium at 360px — the real
 * server.js, index.html, app.js, style.css and lib/payment-report-rules.js,
 * with the REAL apps-script/Code.gs (vm sandbox, test/helpers/gs-sandbox.js)
 * answering every Apps Script call except getData. CHANGELOG-payment-report-form.md.
 *
 *   Vered (finance, deleter): opens גבייה, taps «דווח תשלום» on today's
 *     cycle, sends a bank transfer WITHOUT a reference → the inline Hebrew
 *     error under «מספר אסמכתא», nothing sent; fills it → the toast «התשלום
 *     נרשם — יופיע אצל אורטל מחר בבוקר», the row shows «שולם» and the receipt;
 *     Code.gs holds the cycle + ONE receipt row. There is no default funder
 *     (CHANGELOG-patient-funder-on-funders.md): the form opens with the
 *     funder EMPTY and the patient card shows the amber «לא הוגדר».
 *   Shiran (no finance): no «דווח תשלום», no form, no funder editor; a direct
 *     POST of reportPayment / appendFunder gets 403.
 *
 * Set SHOT_DIR to write payment-report-360-error.png and
 * payment-report-360-success.png.
 *
 * SKIPPED unless BOTH `playwright` resolves AND a Chromium binary is present. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { richSheet, loadGs } = require('./helpers/gs-sandbox');

let playwright = null;
try { playwright = require('playwright'); } catch (_) { /* not installed — skip */ }
const CHROMIUM_CANDIDATES = [
  process.env.CHROMIUM_PATH,
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/opt/pw-browsers/chromium/chrome-linux/chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
].filter(Boolean);
const chromiumPath = CHROMIUM_CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch (_) { return false; } });
const skip = !playwright || !chromiumPath;
const why = !playwright ? 'playwright not installed' : (!chromiumPath ? 'no chromium binary' : '');

const pinHash = require('../lib/pin-hash');
const users = require('../lib/users');
const { createSessionToken } = require('../lib/session');

const SERVER_PATH = require.resolve('../server');
const PEPPER = 'pepper-TEST-payment-report-browser-0123456789abcd';
const SESSION_SECRET = 'session-secret-TEST-payment-report-browser-01234';
const PROXY_SECRET = 'proxy-secret-TEST-payment-report-browser-0123456';
const ENV_KEYS = ['PROXY_SECRET', 'SESSION_SECRET', 'SHEETS_URL', 'USER_PIN_HASHES', 'PIN_PEPPER'];

const israelDay = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date(ms));
const TODAY = israelDay(Date.now());
const YESTERDAY = israelDay(Date.now() - 86400000);
/* Entered on today's day of the month last month → a cycle is due today. */
const ENTRY = (() => { const [y, m, d] = TODAY.split('-').map(Number); const pm = m === 1 ? 12 : m - 1; const py = m === 1 ? y - 1 : y; return `${py}-${String(pm).padStart(2, '0')}-${String(Math.min(d, 28)).padStart(2, '0')}`; })();
const DUE_TODAY = (() => { const d = Number(ENTRY.slice(8)); return TODAY.slice(0, 8) + String(d).padStart(2, '0'); })();
const PATIENT = { houseId: 'arfoni', name: 'דנה כהן', date: ENTRY, pay: 30000, adv: 0, status: 'active', id: 'p1' };
const DATA = {
  ok: true, leads: [], patients: { arfoni: [PATIENT] }, irrelevantLeads: [], removedLeads: [], dischargedPatients: [],
  billingOverrides: [], houseManagers: {}, managerPhones: {}, currentManagers: [], currentManagersSource: 'x',
};

async function boot() {
  const hash = await pinHash.hashPin('583920', PEPPER);
  const recs = ['vered', 'sandra', 'shiran', 'yael'].map((id) => JSON.parse(users.recordLine(id, hash, 1)));
  const env = {
    PROXY_SECRET, SESSION_SECRET, SHEETS_URL: 'https://script.google.com/macros/s/TEST/exec', PIN_PEPPER: PEPPER,
    USER_PIN_HASHES: JSON.stringify(recs),
  };
  const saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; process.env[k] = env[k]; }
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  delete require.cache[SERVER_PATH];
  let mod;
  try { mod = require('../server'); } finally {
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
  // The REAL Code.gs behind the proxy, with the patient on its Patients tab.
  const gs = loadGs({ props: { PROXY_SECRET, PROXY_SECRET_MODE: 'enforce' } });
  const pcols = Array.from(gs.run('PATIENT_COLUMNS'));
  gs.sandbox.__sheets.Patients = richSheet('Patients', pcols);
  gs.sandbox.__sheets.Patients.appendRow(pcols.map((c) => (PATIENT[c] === undefined ? '' : PATIENT[c])));
  const actions = [];
  const original = https.request;
  https.request = (url, opts, cb) => {
    const req = new EventEmitter();
    let body = '';
    req.write = (c) => { body += c; };
    req.end = () => {
      let parsed = {};
      try { parsed = JSON.parse(body); } catch (_) { parsed = {}; }
      actions.push(parsed.action);
      const answer = parsed.action === 'getData' ? DATA
        : gs.sandbox.doPost({ parameter: {}, postData: { contents: body } }).json;
      const res = new EventEmitter();
      res.statusCode = 200; res.headers = {}; res.setEncoding = () => {}; res.resume = () => {};
      setImmediate(() => { cb(res); res.emit('data', JSON.stringify(answer)); res.emit('end'); });
    };
    return req;
  };
  const srv = await new Promise((resolve) => { const s = mod.app.listen(0, '127.0.0.1', () => resolve(s)); });
  return {
    port: srv.address().port, actions, gs,
    close() { srv.close(); https.request = original; Object.assign(console, quiet); },
  };
}

async function open(browser, port, id, hash) {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, deviceScaleFactor: 2, locale: 'he-IL',
    timezoneId: 'Asia/Jerusalem', serviceWorkers: 'block' });
  const name = users.modelById(id).name;
  await ctx.addCookies([{ name: 'ezone_session', value: createSessionToken(SESSION_SECRET, undefined, undefined, name, { id, pinVersion: 1 }), url: `http://127.0.0.1:${port}` }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e && e.message)));
  await page.goto(`http://127.0.0.1:${port}/${hash || ''}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#whoami', { state: 'visible', timeout: 15000 });
  return { ctx, page, errors };
}

async function shot(target, name) {
  if (!process.env.SHOT_DIR) return;
  fs.mkdirSync(process.env.SHOT_DIR, { recursive: true });
  await target.screenshot({ path: path.join(process.env.SHOT_DIR, name) });
}

test('«דווח תשלום» at 360px: one inline error, nothing sent; then success — one receipt row, the cycle paid, the toast', { skip: skip && why, timeout: 120000 }, async () => {
  const server = await boot();
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  try {
    const v = await open(browser, server.port, 'vered', '#billing');
    const page = v.page;
    await page.waitForSelector('#screen-billing', { state: 'visible' });
    await page.waitForSelector('#billing-due-list .billing-row', { timeout: 10000 });
    assert.equal(await page.locator('#billing-due-list select.billing-status').count(), 0, 'the old status dropdown is gone');
    assert.equal(await page.locator('#billing-due-list .billing-paid').count(), 0, 'and «שולם בפועל»');
    await page.locator('#billing-due-list .bill-report-btn').first().click();
    const modal = page.locator('.pay-report-modal');
    await modal.waitFor({ state: 'visible' });
    assert.match(await modal.textContent(), /דנה כהן/);
    assert.equal(await page.inputValue('#pr-amount'), '30000', 'the expected amount is prefilled');
    assert.equal(await page.inputValue('#pr-funder'), '', 'no Funders row → empty: there is no default funder');
    await page.selectOption('#pr-funder', 'ביטוח לאומי');

    // One error: a bank transfer with no reference.
    await page.fill('#pr-receivedDate', YESTERDAY);
    await page.selectOption('#pr-method', 'העברה בנקאית');
    await page.fill('#pr-payer', 'משפחת כהן');
    const before = server.actions.filter((a) => a === 'reportPayment').length;
    await page.click('.pr-submit');
    const refErr = page.locator('[data-err="reference"]');
    await refErr.waitFor({ state: 'visible' });
    assert.equal((await refErr.textContent()).trim(), "חסר: מספר אסמכתא (חובה בהעברה בנקאית ובצ'ק)");
    assert.equal(await page.getAttribute('#pr-reference', 'aria-invalid'), 'true');
    assert.equal(await page.locator('.pay-report-modal .field-error:not(:empty)').count(), 1, 'exactly one error');
    assert.equal(server.actions.filter((a) => a === 'reportPayment').length, before, 'nothing was sent');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no sideways scroll at 360px');
    await shot(page, 'payment-report-360-error.png');

    // Success.
    await page.fill('#pr-reference', 'TRX-2026/0042');
    await page.click('.pr-submit');
    await modal.waitFor({ state: 'detached', timeout: 10000 });
    const toast = page.locator('#toast-banner');
    await toast.waitFor({ state: 'visible' });
    assert.equal((await toast.textContent()).trim(), 'התשלום נרשם — יופיע אצל אורטל מחר בבוקר');
    const row = page.locator('#billing-due-list .billing-row').first();
    await row.locator('.receipt-item').waitFor({ state: 'visible' });
    assert.match(await row.locator('.pay-state').textContent(), /^שולם$/);
    const receipt = await row.locator('.receipt-item').textContent();
    assert.match(receipt, /העברה בנקאית/);
    assert.match(receipt, /TRX-2026\/0042/);
    assert.match(receipt, /ורד/);
    assert.equal(await row.locator('.bill-report-btn').count(), 0, 'paid in full — no second report');
    assert.equal((await row.locator('.receipt-void-btn').textContent()).trim(), 'ביטול קבלה', 'a deleter may void it');
    await shot(page, 'payment-report-360-success.png');

    const rows = server.gs.sheetRows('Payments', 'PAYMENT_COLUMNS');
    assert.equal(rows.length, 2, 'the cycle and ONE receipt');
    assert.equal(rows[0].status, 'paid');
    assert.match(rows[1].id, /^rcpt-/);
    assert.equal(rows[1].recordedBy, 'ורד');
    assert.equal(rows[1].receivedDate, YESTERDAY);
    assert.equal(rows[0].dueDate, DUE_TODAY);

    // The patient card: the funder, finance-only.
    await page.locator('.tabs .tab[data-screen="occupancy"]').click();
    await page.waitForSelector('.patient-funder', { state: 'visible' });
    assert.match(await page.locator('.patient-funder').first().textContent(), /לא הוגדר/);
    assert.equal(await page.locator('.patient-funder .funder-chip.funder-unset').count() > 0, true, 'the amber badge');
    assert.deepEqual(v.errors, [], 'no page errors');
    await v.ctx.close();

    // ---- Shiran: nothing of it, and the server refuses it ----
    const s = await open(browser, server.port, 'shiran', '#billing');
    assert.equal(await s.page.locator('.bill-report-btn, .pay-report-modal, #screen-billing').count(), 0);
    await s.page.locator('.tabs .tab[data-screen="occupancy"]').click();
    await s.page.waitForSelector('.patient-row', { state: 'visible' });
    assert.equal(await s.page.locator('.patient-funder, .funder-edit-btn').count(), 0, 'no funder editor');
    const direct = await s.page.evaluate(async () => {
      const post = (body) => fetch('/api/sheets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        .then(async (r) => [r.status, await r.json()]);
      return [await post({ action: 'reportPayment', report: {} }), await post({ action: 'appendFunder', funder: {} })];
    });
    for (const [status, body] of direct) {
      assert.equal(status, 403);
      assert.deepEqual(body, { ok: false, error: 'forbidden', message: 'אין הרשאה לצפות בנתוני גבייה' });
    }
    assert.equal(server.gs.sheetRows('Payments', 'PAYMENT_COLUMNS').length, 2, 'nothing more written');
    assert.deepEqual(s.errors, []);
    await s.ctx.close();
  } finally {
    await browser.close();
    server.close();
  }
});
