/* «בקרת גבייה» status dropdown + Ortal's read-only «גבייה» in REAL Chromium at
 * 360px — the real server.js, index.html, app.js, style.css and
 * lib/billing-control-rules.js, with the REAL apps-script/Code.gs (vm
 * sandbox) answering every Apps Script call.
 * CHANGELOG-ortal-verification-status.md (PR 2, UI).
 *
 *   Ortal: «גבייה» opens read-only (the row and its receipts, no report /
 *     edit / void / funder control, no sideways scroll); in «בקרת גבייה» the
 *     dropdown «שולם חלקית» opens the amount form — an amount ≥ the reported
 *     one is refused inline with nothing sent; a valid one shows the remaining
 *     balance live, saves, moves the row to «שולם חלקית» with «יתרה פתוחה» and
 *     the «יתרה פתוחה» card; the note (HTML-looking text) is saved and shown
 *     as TEXT — no element injected; RTL, the amount typed LTR.
 *   Vered: the same rows, no dropdown and no note editor; the remaining
 *     balance is shown.
 *   Shiran: neither tab; the «גבייה» reads are 403.
 *
 * Set SHOT_DIR to write the screenshots (docs/screenshots/ortal-verification-status/).
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
const PEPPER = 'pepper-TEST-ortal-status-browser-0123456789abcd';
const SESSION_SECRET = 'session-secret-TEST-ortal-status-browser-0123';
const PROXY_SECRET = 'proxy-secret-TEST-ortal-status-browser-0123456';
const ENV_KEYS = ['PROXY_SECRET', 'SESSION_SECRET', 'SHEETS_URL', 'USER_PIN_HASHES', 'PIN_PEPPER'];

const israelDay = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date(ms));
const TODAY = israelDay(Date.now());
const daysAgo = (n) => israelDay(Date.now() - n * 86400000);
/* A cycle that started on the first of this month, covering the month. */
const MONTH_START = TODAY.slice(0, 8) + '01';
const MONTH_END = (() => { const [y, m] = TODAY.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); })();
const PATIENT = { houseId: 'arfoni', name: 'דנה כהן', date: MONTH_START, pay: 30000, adv: 0, status: 'active', id: 'p1' };
const CYCLE = { id: `pay::arfoni::דנה כהן::${MONTH_START}::${MONTH_START}`, patientId: `arfoni::דנה כהן::${MONTH_START}`,
  patientName: 'דנה כהן', houseId: 'arfoni', dueDate: MONTH_START, amount: 30000 };
const DATA = {
  ok: true, leads: [], patients: { arfoni: [PATIENT] }, irrelevantLeads: [], removedLeads: [], dischargedPatients: [],
  billingOverrides: [], houseManagers: {}, managerPhones: {}, currentManagers: [], currentManagersSource: 'x',
};

async function boot() {
  const hash = await pinHash.hashPin('583920', PEPPER);
  const recs = ['vered', 'sandra', 'shiran', 'yael', 'ortal'].map((id) => JSON.parse(users.recordLine(id, hash, 1)));
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
  const gs = loadGs({ props: { PROXY_SECRET, PROXY_SECRET_MODE: 'enforce' } });
  const pcols = Array.from(gs.run('PATIENT_COLUMNS'));
  gs.sandbox.__sheets.Patients = richSheet('Patients', pcols);
  gs.sandbox.__sheets.Patients.appendRow(pcols.map((c) => (PATIENT[c] === undefined ? '' : PATIENT[c])));
  // Vered reports two payments (the real reportPayment, through the gate).
  const vered = { proxySecret: PROXY_SECRET, proxyUser: 'ורד', user: 'ורד', proxyAuth: 'personal', proxyUserId: 'vered',
    proxyRoles: ['staff', 'reporter', 'deleter'], proxyCaps: ['finance', 'billingControl'] };
  for (const [amount, d, payer] of [[18000, daysAgo(2), 'משפחת כהן'], [12000, daysAgo(1), 'ביטוח משלים']]) {
    const r = gs.post(Object.assign({ action: 'reportPayment', report: { cycle: CYCLE, report: {
      receivedDate: d, amount, method: 'העברה בנקאית', payer, reference: 'TRX-' + amount, funder: 'פרטי',
      invoiceWanted: 'no',   // required since CHANGELOG-payment-invoice.md
      coverageStart: MONTH_START, coverageEnd: MONTH_END } } }, vered));
    if (!r.ok) throw new Error('seed report failed: ' + JSON.stringify(r));
  }
  const actions = [];
  const original = https.request;
  https.request = (url, opts, cb) => {
    const req = new EventEmitter();
    let body = '';
    req.write = (c) => { body += c; };
    req.end = () => {
      let parsed = {};
      try { parsed = JSON.parse(body); } catch (_) { parsed = {}; }
      actions.push({ action: parsed.action, user: parsed.proxyUserId });
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
    timezoneId: 'Asia/Jerusalem', serviceWorkers: 'block', acceptDownloads: true });
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
  await target.screenshot({ path: path.join(process.env.SHOT_DIR, name), fullPage: true });
}

const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);


const confirmCalls = (server) => server.actions.filter((a) => a.action === 'confirmPayment').length;

test('Ortal at 360px: «גבייה» read-only; «שולם חלקית» with the amount bounds, the live remaining balance, the open-debt card; the note is shown as text', { skip: skip && why, timeout: 120000 }, async () => {
  const server = await boot();
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  try {
    const o = await open(browser, server.port, 'ortal');
    const page = o.page;
    await page.waitForSelector('#bc-queue .bc-row', { timeout: 10000 });
    assert.equal(await page.evaluate(() => document.body.className), 'view-controller view-billing-read');
    assert.equal(await page.evaluate(() => document.documentElement.dir), 'rtl');

    // ---- «גבייה», read-only.
    await page.locator('.tabs .tab[data-screen="billing"]').click();
    await page.waitForSelector('#screen-billing', { state: 'visible' });
    await page.fill('#billing-date', MONTH_START);
    await page.dispatchEvent('#billing-date', 'change');
    await page.waitForSelector('#billing-due-list .billing-row');
    const row = await page.locator('#billing-due-list .billing-row').first().textContent();
    assert.ok(row.includes('דנה כהן') && row.includes('תשלומים שהתקבלו'), 'the row and its receipts');
    assert.equal(await page.locator('#screen-billing .bill-report-btn, #screen-billing .bill-amount-edit-btn, #screen-billing .bill-cov-edit-btn, #screen-billing .receipt-void-btn, #screen-billing .funder-edit-btn, #funder-fill').count(), 0, 'no write control');
    assert.ok(server.actions.some((a) => a.action === 'getPayments' && a.user === 'ortal'));
    assert.equal(await noSideScroll(page), true, '«גבייה» at 360px');
    await shot(page, 'ortal-360-billing-read-only.png');

    // ---- «בקרת גבייה»: «שולם חלקית» on the 18,000 receipt.
    await page.locator('.tabs .tab[data-screen="billing-control"]').click();
    await page.waitForSelector('#bc-queue .bc-row');
    const r18 = page.locator('#bc-queue .bc-row', { hasText: '18,000' });
    assert.equal(await r18.locator('select[data-bc-status] option').evaluateAll((os) => os.map((x) => x.textContent)).then((t) => t.slice(1).join('|')), 'שולם|שולם חלקית|לא שולם|כפילות');
    await r18.locator('[data-bc-status]').selectOption('partial');
    const form = page.locator('.bc-partial-form');
    await form.waitFor();
    const input = form.locator('input');
    assert.equal(await input.getAttribute('inputmode'), 'decimal');
    assert.equal(await input.evaluate((el) => getComputedStyle(el).direction), 'ltr', 'the amount is typed LTR');
    assert.equal(await page.locator('[data-bc-status]').first().evaluate((el) => getComputedStyle(el).direction), 'rtl');
    // = the reported amount → refused inline, nothing sent.
    const before = confirmCalls(server);
    await input.fill('18000');
    await form.locator('[data-bc-partial-save]').click();
    await page.waitForSelector('.bc-partial-error:not(.hidden)');
    assert.match(await page.locator('.bc-partial-error').textContent(), /קטן מהסכום שדווח/);
    assert.equal(await input.getAttribute('aria-invalid'), 'true');
    assert.equal(confirmCalls(server), before, 'nothing sent');
    // A valid amount: the remaining balance updates as she types.
    await input.fill('5000');
    assert.match(await form.locator('[data-bc-remaining]').textContent(), /יתרה פתוחה: ₪ 13,000/);
    assert.equal(await page.locator('.bc-partial-error').isVisible(), false, 'the stale error is cleared');
    assert.equal(await input.getAttribute('aria-invalid'), null);
    assert.equal(await noSideScroll(page), true);
    await shot(page, 'ortal-360-partial-form.png');
    await form.locator('[data-bc-partial-save]').click();
    await page.waitForSelector('#bc-partial .bc-row');
    const partialRow = await page.locator('#bc-partial .bc-row').first().textContent();
    assert.match(partialRow, /אומת ₪ 5,000 מתוך ₪ 18,000/);
    assert.match(partialRow, /יתרה פתוחה: ₪ 13,000/);
    assert.match(await page.locator('#bc-card-open').textContent(), /13,000/);
    assert.match(await page.locator('#bc-partial-open').textContent(), /13,000/);
    assert.match(await page.locator('#toast-banner').textContent(), /שולם חלקית/);
    let pay = server.gs.sheetRows('Payments', 'PAYMENT_COLUMNS').find((r) => Number(r.amountPaid) === 18000);
    assert.deepEqual([pay.confirmStatus, Number(pay.confirmedAmount), pay.confirmedBy], ['partial', 5000, 'אורטל']);

    // ---- the note: HTML-looking text is saved and shown as text.
    const evil = '<img src=x onerror="window.__pwned=1"> בירור';
    await page.locator('#bc-partial .bc-row [data-bc-cnote-open]').click();
    const nform = page.locator('.bc-cnote-form');
    await nform.waitFor();
    assert.equal(await nform.locator('textarea').getAttribute('maxlength'), '500');
    await nform.locator('textarea').fill(evil);
    assert.match(await nform.locator('[data-bc-cnote-count]').textContent(), new RegExp(`${evil.length} / 500`));
    await nform.locator('[data-bc-cnote-save]').click();
    await page.waitForSelector('#bc-partial .bc-cnote-text');
    assert.ok((await page.locator('#bc-partial .bc-cnote-text').textContent()).includes(evil), 'shown verbatim, as text');
    assert.equal(await page.locator('#screen-billing-control img').count(), 0, 'no element injected');
    assert.equal(await page.evaluate(() => window.__pwned), undefined);
    pay = server.gs.sheetRows('Payments', 'PAYMENT_COLUMNS').find((r) => Number(r.amountPaid) === 18000);
    assert.equal(pay.controlNote, evil);
    assert.equal(pay.confirmStatus, 'partial', 'the note did not move the status');
    const audit = server.gs.sheetRows('AuditLog', 'AUDIT_LOG_COLUMNS').map((r) => r.action).filter((a) => /^payment_(confirm_|control_note)/.test(a));
    assert.deepEqual(audit, ['payment_confirm_partial', 'payment_control_note']);

    // ---- «שולם» on the 12,000 one (saved at once).
    await page.locator('#bc-queue .bc-row', { hasText: '12,000' }).locator('[data-bc-status]').selectOption('confirmed');
    await page.waitForFunction(() => document.querySelectorAll('#bc-queue .bc-row').length === 0);
    assert.equal(await noSideScroll(page), true);
    await shot(page, 'ortal-360-after.png');
    assert.deepEqual(o.errors, [], 'no page errors');
    await o.ctx.close();

    // ---- Vered: the same rows, read-only, the remaining balance shown.
    const v = await open(browser, server.port, 'vered', '#billing-control');
    await v.page.waitForSelector('#bc-partial .bc-row', { timeout: 10000 });
    assert.equal(await v.page.locator('#screen-billing-control [data-bc-status], #screen-billing-control [data-bc-cnote-open], #screen-billing-control textarea').count(), 0);
    assert.match(await v.page.locator('#bc-partial').textContent(), /יתרה פתוחה: ₪ 13,000/);
    assert.ok((await v.page.locator('#bc-partial .bc-cnote-text').textContent()).includes(evil));
    assert.equal(await v.page.locator('#screen-billing-control img').count(), 0);
    assert.deepEqual(v.errors, []);
    await v.ctx.close();

    // ---- Shiran: neither tab; the «גבייה» reads are 403.
    const sh = await open(browser, server.port, 'shiran', '#billing');
    assert.equal(await sh.page.locator('.tabs .tab[data-screen="billing"], .tabs .tab[data-screen="billing-control"]').count(), 0);
    const st = await sh.page.evaluate(async () => [(await fetch('/api/sheets?action=getPayments')).status, (await fetch('/api/sheets?action=getCredits')).status]);
    assert.deepEqual(st, [403, 403]);
    await sh.ctx.close();
  } finally {
    await browser.close();
    server.close();
  }
});
