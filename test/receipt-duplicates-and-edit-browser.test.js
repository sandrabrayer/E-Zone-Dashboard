/* Receipts in REAL Chromium at 360px — the real server.js, index.html,
 * app.js, style.css and libs, with the REAL apps-script/Code.gs (vm sandbox)
 * answering every Apps Script call. CHANGELOG-receipt-duplicates-and-edit.md.
 *
 *   Vered: «דווח תשלום» of the same amount within 14 days → «קיימת כבר קבלה
 *     דומה (dd/mm, אסמכתא X). האם זו קבלה נוספת?»; «ביטול» sends nothing
 *     more; «כן, קבלה נוספת» re-sends with confirmDuplicate and the receipt
 *     lands (override audited). ✏️ on a receipt: no amount / date / status
 *     input; a changed reference is saved (one audit row), nothing else moves.
 *   Ortal: «כפילות» in the dropdown — the note is required (inline error,
 *     nothing sent); saved → the receipt leaves her list, void on the sheet,
 *     the cycle re-derived; «גבייה» shows her no ✏️.
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
const PEPPER = 'pepper-TEST-receipt-dup-browser-0123456789abcdef';
const SESSION_SECRET = 'session-secret-TEST-receipt-dup-browser-01234';
const PROXY_SECRET = 'proxy-secret-TEST-receipt-dup-browser-01234567';
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
  for (const [amount, d, payer] of [[10000, daysAgo(3), 'משפחת כהן'], [12000, daysAgo(2), 'ביטוח משלים']]) {
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
      actions.push({ action: parsed.action, user: parsed.proxyUserId, body: parsed });
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



const sent = (server, action) => server.actions.filter((a) => a.action === action);

test('Vered at 360px: the duplicate prompt («ביטול» / «כן, קבלה נוספת») and ✏️ on a receipt', { skip: skip && why, timeout: 120000 }, async () => {
  const server = await boot();
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  try {
    const v = await open(browser, server.port, 'vered', '#billing');
    const page = v.page;
    await page.waitForSelector('#screen-billing', { state: 'visible' });
    await page.fill('#billing-date', MONTH_START);
    await page.dispatchEvent('#billing-date', 'change');
    await page.waitForSelector('#billing-due-list .billing-row .receipt-item');
    const row = page.locator('#billing-due-list .billing-row').first();
    assert.equal(await row.locator('.receipt-edit-btn').count(), 2, '✏️ on each receipt');

    // ---- the duplicate prompt.
    await row.locator('.bill-report-btn').click();
    const modal = page.locator('.pay-report-modal');
    await modal.waitFor({ state: 'visible' });
    await page.fill('#pr-receivedDate', daysAgo(1));
    await page.fill('#pr-amount', '10000');
    await page.selectOption('#pr-method', 'מזומן');
    await page.fill('#pr-payer', 'משפחת כהן');
    await page.selectOption('#pr-funder', 'פרטי');
    await page.check('[name="invoiceWanted"][value="no"]');
    await page.click('.pr-submit');
    const box = page.locator('.pr-dup-confirm');
    await box.waitFor({ state: 'visible' });
    const dd = daysAgo(3).slice(8, 10) + '/' + daysAgo(3).slice(5, 7);
    assert.equal((await box.locator('.pr-dup-text').textContent()).trim(),
      `קיימת כבר קבלה דומה (${dd}, אסמכתא TRX-10000). האם זו קבלה נוספת?`);
    assert.equal(sent(server, 'reportPayment').length, 1);
    assert.equal(sent(server, 'reportPayment')[0].body.report.confirmDuplicate, undefined);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no sideways scroll');
    await shot(page, 'vered-360-duplicate-prompt.png');
    // «ביטול» closes the prompt only — nothing more is sent.
    await box.locator('[data-action="dup-no"]').click();
    assert.equal(await box.isVisible(), false);
    assert.equal(await modal.isVisible(), true, 'the form stays open');
    assert.equal(sent(server, 'reportPayment').length, 1);
    // Again → «כן, קבלה נוספת».
    await page.click('.pr-submit');
    await box.waitFor({ state: 'visible' });
    await box.locator('[data-action="dup-yes"]').click();
    await modal.waitFor({ state: 'detached', timeout: 10000 });
    const reports = sent(server, 'reportPayment');
    assert.equal(reports.length, 3);
    assert.equal(reports[2].body.report.confirmDuplicate, true);
    const rows = () => server.gs.sheetRows('Payments', 'PAYMENT_COLUMNS');
    assert.equal(rows().filter((r) => String(r.id).startsWith('rcpt-') && Number(r.amountPaid) === 10000).length, 2);
    const audit = server.gs.sheetRows('AuditLog', 'AUDIT_LOG_COLUMNS').filter((r) => r.action === 'payment_duplicate_override');
    assert.equal(audit.length, 1);

    // ---- ✏️ the 12,000 receipt: no money input; the reference is saved.
    const item = row.locator('.receipt-item', { hasText: '12,000' });
    await item.locator('.receipt-edit-btn').click();
    const em = page.locator('.receipt-edit-modal');
    await em.waitFor({ state: 'visible' });
    assert.equal(await em.locator('[name="amount"], [name="receivedDate"], [name="status"], [name="funder"]').count(), 0, 'no money / date / status field');
    assert.equal(await page.inputValue('#re-reference'), 'TRX-12000');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await shot(page, 'vered-360-receipt-edit.png');
    // Empty reference on a bank transfer → inline error, nothing sent.
    await page.fill('#re-reference', '');
    await em.locator('.re-submit').click();
    await page.waitForSelector('#re-err-reference:not(:empty)');
    assert.equal(sent(server, 'editReceipt').length, 0);
    await page.fill('#re-reference', 'TRX-99887');
    await page.fill('#re-reason', 'תיקון אסמכתא');
    await em.locator('.re-submit').click();
    await em.waitFor({ state: 'detached', timeout: 10000 });
    const edits = sent(server, 'editReceipt');
    assert.equal(edits.length, 1);
    assert.deepEqual(edits[0].body.edit.fields, { reference: 'TRX-99887' }, 'only the changed field');
    assert.equal(edits[0].body.edit.reason, 'תיקון אסמכתא');
    await page.waitForFunction(() => /TRX-99887/.test(document.querySelector('#billing-due-list').textContent));
    const r12 = rows().find((r) => Number(r.amountPaid) === 12000);
    assert.deepEqual([r12.reference, r12.confirmStatus, Number(r12.amountPaid)], ['TRX-99887', 'reported', 12000]);
    assert.equal(server.gs.sheetRows('AuditLog', 'AUDIT_LOG_COLUMNS').filter((r) => r.action === 'receipt_edited').length, 1);
    assert.deepEqual(v.errors, []);
    await v.ctx.close();
  } finally {
    await browser.close();
    server.close();
  }
});

test('Ortal at 360px: «כפילות» needs its note; saved → the receipt leaves her list and is void; no ✏️ in «גבייה»', { skip: skip && why, timeout: 120000 }, async () => {
  const server = await boot();
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  try {
    const o = await open(browser, server.port, 'ortal');
    const page = o.page;
    await page.waitForSelector('#bc-queue .bc-row', { timeout: 10000 });
    assert.equal(await page.locator('#bc-queue .bc-row').count(), 2);
    const r12 = page.locator('#bc-queue .bc-row', { hasText: '12,000' });
    await r12.locator('[data-bc-status]').selectOption('duplicate');
    const form = page.locator('.bc-dup-form');
    await form.waitFor();
    assert.equal(await form.locator('textarea').getAttribute('maxlength'), '300');
    await form.locator('[data-bc-dup-save]').click();
    await page.waitForSelector('.bc-dup-error:not(.hidden)');
    assert.match(await page.locator('.bc-dup-error').textContent(), /חובה לפרט/);
    assert.equal(sent(server, 'confirmPayment').length, 0, 'nothing sent');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await shot(page, 'ortal-360-duplicate-form.png');
    await form.locator('textarea').fill('אותה העברה דווחה פעמיים');
    await form.locator('[data-bc-dup-save]').click();
    await page.waitForFunction(() => document.querySelectorAll('#bc-queue .bc-row').length === 1);
    assert.match(await page.locator('#toast-banner').textContent(), /כפילות/);
    const r = server.gs.sheetRows('Payments', 'PAYMENT_COLUMNS').find((x) => Number(x.amountPaid) === 12000 && String(x.id).startsWith('rcpt-'));
    assert.deepEqual([r.status, r.linkStatus, r.linkNote], ['void', 'duplicate', 'אותה העברה דווחה פעמיים']);
    const cycle = server.gs.sheetRows('Payments', 'PAYMENT_COLUMNS').find((x) => x.id === CYCLE.id);
    assert.equal(Number(cycle.amountPaid), 10000, 'the cycle no longer counts it');
    // The last one cannot be a duplicate: Hebrew refusal, still listed.
    const last = page.locator('#bc-queue .bc-row').first();
    await last.locator('[data-bc-status]').selectOption('duplicate');
    await page.locator('.bc-dup-form textarea').fill('בדיקה');
    await page.locator('.bc-dup-form [data-bc-dup-save]').click();
    await page.waitForSelector('#error-banner:not(.hidden)');
    assert.match(await page.locator('#error-banner').textContent(), /זו הקבלה היחידה של המחזור/);
    assert.equal(await page.locator('#bc-queue .bc-row').count(), 1);
    // «גבייה»: read-only, no ✏️.
    await page.locator('.tabs .tab[data-screen="billing"]').click();
    await page.waitForSelector('#screen-billing', { state: 'visible' });
    await page.fill('#billing-date', MONTH_START);
    await page.dispatchEvent('#billing-date', 'change');
    await page.waitForSelector('#billing-due-list .billing-row .receipt-item');
    assert.equal(await page.locator('#screen-billing .receipt-edit-btn').count(), 0);
    assert.deepEqual(o.errors, []);
    await o.ctx.close();
  } finally {
    await browser.close();
    server.close();
  }
});
