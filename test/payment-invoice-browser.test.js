/* «חשבונית?» on the «דווח תשלום» form, in REAL Chromium at 360px — the real
 * server.js, index.html, app.js, style.css and lib/payment-report-rules.js,
 * with the REAL apps-script/Code.gs (vm sandbox) answering every Apps Script
 * call except getData. CHANGELOG-payment-invoice.md.
 *
 *   Vered: the form opens with NO choice; sending it paints «חסר: האם להפיק
 *     חשבונית (כן / לא)» and sends nothing; כן reveals «על שם» prefilled with
 *     the payer; emptying it paints «חסר: על שם מי החשבונית»; then the report
 *     lands with invoiceWanted 'yes' + the name; the receipt line shows
 *     «חשבונית: כן · על שם …»; «חשבונית ✎» switches it to לא (updatePayment,
 *     one AuditLog row) and the line shows «חשבונית: לא».
 *   Shiran: no form, no receipt line; a direct updatePayment gets 403.
 *
 * Set SHOT_DIR to write payment-invoice-360-error.png / -yes.png.
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
const PEPPER = 'pepper-TEST-payment-invoice-browser-0123456789ab';
const SESSION_SECRET = 'session-secret-TEST-payment-invoice-browser-0123';
const PROXY_SECRET = 'proxy-secret-TEST-payment-invoice-browser-012345';
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

test('«חשבונית?» at 360px: no default, both errors inline, nothing sent; כן prefills the payer; stored; edited to לא and audited', { skip: skip && why, timeout: 120000 }, async () => {
  const server = await boot();
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  try {
    const v = await open(browser, server.port, 'vered', '#billing');
    const page = v.page;
    await page.waitForSelector('#billing-due-list .billing-row', { timeout: 10000 });
    await page.locator('#billing-due-list .bill-report-btn').first().click();
    const modal = page.locator('.pay-report-modal');
    await modal.waitFor({ state: 'visible' });
    assert.equal(await page.locator('.pay-report-modal input[name="invoiceWanted"]:checked').count(), 0, 'no default');
    assert.equal(await page.locator('.pay-report-modal .pr-invoice-to').isVisible(), false, '«על שם» hidden until כן');
    await page.selectOption('#pr-funder', 'ביטוח לאומי');
    await page.fill('#pr-receivedDate', YESTERDAY);
    await page.selectOption('#pr-method', 'מזומן');
    await page.fill('#pr-payer', 'משפחת כהן');
    const sent = () => server.actions.filter((a) => a === 'reportPayment').length;
    const before = sent();

    // 1. no choice → one inline error, nothing sent
    await page.click('.pr-submit');
    const choiceErr = page.locator('[data-err="invoiceWanted"]');
    await choiceErr.waitFor({ state: 'visible' });
    assert.equal((await choiceErr.textContent()).trim(), 'חסר: האם להפיק חשבונית (כן / לא)');
    assert.equal(await page.locator('.pay-report-modal .field-error:not(:empty)').count(), 1, 'exactly one error');
    assert.equal(sent(), before, 'nothing was sent');
    await shot(page, 'payment-invoice-360-error.png');

    // 2. כן → «על שם» appears, prefilled with the payer
    await page.check('.pay-report-modal input[name="invoiceWanted"][value="yes"]');
    await page.locator('#pr-invoiceTo').waitFor({ state: 'visible' });
    assert.equal(await page.inputValue('#pr-invoiceTo'), 'משפחת כהן', 'prefilled with the payer name');
    assert.equal((await choiceErr.textContent()).trim(), '', 'the choice error clears');
    const box = await page.locator('.pay-report-modal .pr-radio').first().boundingBox();
    assert.ok(box && box.height >= 44, '44px touch target');

    // 3. an empty name → its own error, nothing sent
    await page.fill('#pr-invoiceTo', '');
    await page.click('.pr-submit');
    const toErr = page.locator('[data-err="invoiceTo"]');
    await toErr.waitFor({ state: 'visible' });
    assert.equal((await toErr.textContent()).trim(), 'חסר: על שם מי החשבונית');
    assert.equal(sent(), before);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no sideways scroll at 360px');

    // 4. a name → stored
    await page.fill('#pr-invoiceTo', 'קרן <סיוע> & בניו');
    await page.click('.pr-submit');
    await modal.waitFor({ state: 'detached', timeout: 10000 });
    const rcpt = () => server.gs.sheetRows('Payments', 'PAYMENT_COLUMNS').find((r) => /^rcpt-/.test(String(r.id)));
    assert.deepEqual([rcpt().invoiceWanted, rcpt().invoiceTo], ['yes', 'קרן <סיוע> & בניו']);
    const line = page.locator('#billing-due-list .receipt-item .receipt-invoice').first();
    await line.waitFor({ state: 'visible' });
    assert.equal((await line.textContent()).trim(), 'חשבונית: כן · על שם קרן <סיוע> & בניו', 'escaped text, not markup');
    assert.equal(await page.locator('#billing-due-list .receipt-invoice *').count(), 0, 'no injected element');
    await shot(page, 'payment-invoice-360-yes.png');

    // 5. «חשבונית ✎» → לא (updatePayment), audited
    await page.locator('#billing-due-list .receipt-invoice-btn').first().click();
    const edit = page.locator('.invoice-edit-modal');
    await edit.waitFor({ state: 'visible' });
    assert.equal(await edit.locator('input[name="invoiceWanted"][value="yes"]').isChecked(), true, 'opens on the stored choice');
    await edit.locator('input[name="invoiceWanted"][value="no"]').check();
    await edit.locator('.inv-submit').click();
    await edit.waitFor({ state: 'detached', timeout: 10000 });
    assert.deepEqual([rcpt().invoiceWanted, rcpt().invoiceTo], ['no', '']);
    await page.waitForFunction(() => /חשבונית: לא/.test((document.querySelector('#billing-due-list .receipt-invoice') || {}).textContent || ''));
    const audit = server.gs.sheetRows('AuditLog', 'AUDIT_LOG_COLUMNS').filter((r) => r.action === 'payment_invoice_changed');
    assert.equal(audit.length, 1);
    assert.equal(JSON.parse(audit[0].details).by, 'ורד');
    assert.deepEqual(v.errors, [], 'no page errors');
    await v.ctx.close();

    // ---- Shiran: nothing of it, and the server refuses it ----
    const s = await open(browser, server.port, 'shiran', '#billing');
    assert.equal(await s.page.locator('.pay-report-modal, .receipt-invoice, .receipt-invoice-btn').count(), 0);
    const id = rcpt().id;
    const direct = await s.page.evaluate(async (rid) => {
      const r = await fetch('/api/sheets', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'updatePayment', payment: { id: rid, invoiceWanted: 'yes', invoiceTo: 'x' } }) });
      return [r.status, await r.json()];
    }, id);
    assert.equal(direct[0], 403);
    assert.equal(direct[1].error, 'forbidden');
    assert.deepEqual([rcpt().invoiceWanted, rcpt().invoiceTo], ['no', ''], 'unchanged');
    assert.deepEqual(s.errors, []);
    await s.ctx.close();
  } finally {
    await browser.close();
    server.close();
  }
});
