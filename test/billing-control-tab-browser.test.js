/* «בקרת גבייה» in REAL Chromium at 360px — the real server.js, index.html,
 * app.js, style.css and lib/billing-control-rules.js, with the REAL
 * apps-script/Code.gs (vm sandbox) answering every Apps Script call.
 * CHANGELOG-billing-control-tab.md.
 *
 *   Ortal (controller): the page shows ONE tab, «בקרת גבייה», and nothing
 *     else (no other tab or screen in the DOM, getData never asked); the
 *     queue lists Vered's two receipts newest first; ✓ «אושר בבנק» on one →
 *     it moves to «אומתו» and the card «אומת החודש» counts it; ⚑ on the other
 *     with an EMPTY note → an inline Hebrew error and nothing sent; with a
 *     note → it moves to «סומנו כבעיה» with the note. Code.gs holds both
 *     decisions, stamped by Ortal, with two AuditLog rows. No sideways scroll.
 *   Sandra (approver): the tab with «חריגים פתוחים» — no button inside it;
 *     הכנסות חודשיות shows «מאומת».
 *   Vered: the tab, read-only (no ✓ / ⚑).
 *
 * Set SHOT_DIR to write the screenshots (docs/screenshots/billing-control-tab/).
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
const PEPPER = 'pepper-TEST-billing-control-browser-0123456789ab';
const SESSION_SECRET = 'session-secret-TEST-billing-control-browser-01';
const PROXY_SECRET = 'proxy-secret-TEST-billing-control-browser-01234';
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

test('Ortal at 360px: only «בקרת גבייה»; the queue → ✓ confirm one → ⚑ flag one (empty note refused inline, then with a note); Code.gs holds both decisions', { skip: skip && why, timeout: 120000 }, async () => {
  const server = await boot();
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  try {
    const o = await open(browser, server.port, 'ortal');
    const page = o.page;
    await page.waitForSelector('#bc-queue .bc-row', { timeout: 10000 });
    // ONE tab, ONE screen — everything else is gone from the DOM.
    assert.deepEqual(await page.locator('.tabs .tab').evaluateAll((els) => els.map((e) => e.getAttribute('data-screen'))), ['billing-control']);
    assert.deepEqual(await page.locator('section.screen').evaluateAll((els) => els.map((e) => e.id)), ['screen-billing-control']);
    assert.equal(await page.locator('[data-finance]').count(), 0);
    assert.equal(await page.evaluate(() => document.body.classList.contains('view-controller')), true);
    assert.equal(await page.locator('#pin-admin-open').isVisible(), false, 'no «קוד אישי חדש»');
    assert.ok(await page.locator('#logout').isVisible(), 'logout stays');
    assert.ok(!server.actions.some((a) => a.action === 'getData'), 'no patients / leads asked: ' + server.actions.map((a) => a.action).join(','));
    // The queue: newest first, every column.
    const names = await page.locator('#bc-queue .bc-row .bc-amount').allTextContents();
    assert.equal(names.length, 2);
    assert.match(names[0], /12,000/, 'newest first');
    const first = await page.locator('#bc-queue .bc-row').first().textContent();
    for (const s of ['דנה כהן', 'קיסריה עפרוני', 'העברה בנקאית', 'TRX-12000', 'ביטוח משלים', 'פרטי', 'ורד']) assert.ok(first.includes(s), s);
    assert.match(await page.locator('#bc-card-reported').textContent(), /2 · ₪ 30,000/);
    assert.equal(await noSideScroll(page), true, 'no sideways scroll');
    await shot(page, 'ortal-360-queue.png');

    // ✓ on the newest (12,000).
    await page.locator('#bc-queue .bc-row').first().locator('[data-bc-confirm]').click();
    await page.waitForFunction(() => document.querySelectorAll('#bc-queue .bc-row').length === 1);
    await page.waitForSelector('#bc-confirmed .bc-row');
    assert.match(await page.locator('#bc-confirmed').textContent(), /12,000/);
    assert.match(await page.locator('#bc-card-confirmed').textContent(), /12,000/);
    assert.match(await page.locator('#toast-banner').textContent(), /אושר בבנק/);

    // ⚑ on the other with an empty note → inline error, nothing sent.
    const sentBefore = server.actions.filter((a) => a.action === 'confirmPayment').length;
    await page.locator('#bc-queue .bc-row').first().locator('[data-bc-flag]').click();
    const form = page.locator('.bc-flag-form');
    await form.waitFor();
    await form.locator('[data-bc-flag-save]').click();
    await page.waitForSelector('.bc-note-error:not(.hidden)');
    assert.match(await page.locator('.bc-note-error').textContent(), /2 עד 300/);
    assert.equal(await form.locator('textarea').getAttribute('aria-invalid'), 'true');
    assert.equal(server.actions.filter((a) => a.action === 'confirmPayment').length, sentBefore, 'nothing sent');
    assert.equal(await noSideScroll(page), true);
    await shot(page, 'ortal-360-flag-note-required.png');
    await form.locator('textarea').fill('לא נמצא בבנק עד היום');
    await form.locator('[data-bc-flag-save]').click();
    await page.waitForFunction(() => document.querySelectorAll('#bc-queue .bc-row').length === 0);
    await page.waitForSelector('#bc-flagged .bc-row');
    assert.match(await page.locator('#bc-flagged').textContent(), /לא נמצא בבנק עד היום/);
    assert.match(await page.locator('#bc-card-flagged').textContent(), /1 · ₪ 18,000/);
    assert.ok(await page.locator('#bc-flagged [data-bc-unflag]').isVisible(), '«הסר דגל» offered');
    assert.equal(await noSideScroll(page), true);
    await shot(page, 'ortal-360-after.png');

    // Code.gs holds both decisions, stamped by Ortal, and two AuditLog rows.
    const rows = server.gs.sheetRows('Payments', 'PAYMENT_COLUMNS').filter((r) => String(r.id).indexOf('rcpt-') === 0);
    const by = Object.fromEntries(rows.map((r) => [Number(r.amountPaid), r]));
    assert.deepEqual([by[12000].confirmStatus, by[12000].confirmedBy], ['confirmed', 'אורטל']);
    assert.deepEqual([by[18000].confirmStatus, by[18000].flagNote, by[18000].confirmedBy], ['flagged', 'לא נמצא בבנק עד היום', '']);
    const audit = server.gs.sheetRows('AuditLog', 'AUDIT_LOG_COLUMNS').filter((r) => String(r.action).indexOf('payment_confirm_') === 0);
    assert.deepEqual(audit.map((r) => [r.action, r.actor]), [['payment_confirm_confirmed', 'אורטל'], ['payment_confirm_flagged', 'אורטל']]);
    // The server refuses anything else even if the page is bypassed.
    const direct = await page.evaluate(async () => {
      const a = await fetch('/api/sheets?action=getData');
      const b = await fetch('/api/sheets?action=getPayments');
      const c = await fetch('/api/export/cleanup.xlsx');
      return [a.status, b.status, c.status];
    });
    assert.deepEqual(direct, [403, 403, 403]);
    assert.deepEqual(o.errors, [], 'no page errors');
    await o.ctx.close();
  } finally {
    await browser.close();
    server.close();
  }
});

test("Sandra sees «חריגים פתוחים» read-only and «מאומת» on הכנסות חודשיות; Vered sees the tab without ✓ / ⚑", { skip: skip && why, timeout: 120000 }, async () => {
  const server = await boot();
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  try {
    // Ortal's decision first (one confirmed), through the real Code.gs.
    const ortal = { proxySecret: PROXY_SECRET, proxyUser: 'אורטל', user: 'אורטל', proxyAuth: 'personal', proxyUserId: 'ortal',
      proxyRoles: ['controller'], proxyCaps: ['billingControl'] };
    const q = server.gs.post(Object.assign({ action: 'billingControlQueue' }, ortal));
    const id12 = q.receipts.find((r) => r.amount === 12000).id;
    assert.equal(server.gs.post(Object.assign({ action: 'confirmPayment', confirm: { ids: [id12], status: 'confirmed' } }, ortal)).ok, true);

    const s = await open(browser, server.port, 'sandra', '#billing-control');
    const page = s.page;
    await page.waitForSelector('#bc-queue .bc-row', { timeout: 10000 });
    await page.waitForSelector('#bc-exceptions:not(.hidden)');
    assert.equal(await page.locator('#bc-exceptions button, #bc-exceptions input, #bc-exceptions textarea, #bc-exceptions select').count(), 0, 'read-only');
    assert.match(await page.locator('#bc-exceptions').textContent(), /חובות מעל 60 יום/);
    assert.ok(await page.locator('#bc-queue [data-bc-confirm]').first().isVisible(), 'Sandra (approver) may decide in the queue');
    assert.equal(await noSideScroll(page), true);
    await shot(page, 'sandra-360-tab.png');
    // הכנסות חודשיות: «מאומת» next to «נגבה».
    await page.locator('.tabs .tab[data-screen="revenue"]').click();
    await page.waitForSelector('#screen-revenue', { state: 'visible' });
    const verified = await page.locator('#rev-verified').textContent();
    assert.match(verified, /₪/);
    assert.notEqual(verified.trim(), '₪ 0', 'the confirmed receipt counts: ' + verified);
    assert.ok(await page.locator('.rev-stat-verified .stat-label').textContent(), 'מאומת');
    assert.deepEqual(s.errors, [], 'no page errors');
    await shot(page, 'sandra-360-revenue.png');
    await s.ctx.close();

    const v = await open(browser, server.port, 'vered', '#billing-control');
    await v.page.waitForSelector('#bc-queue .bc-row', { timeout: 10000 });
    assert.equal(await v.page.locator('#screen-billing-control button[data-bc-confirm], #screen-billing-control [data-bc-flag], #screen-billing-control [data-bc-pick]').count(), 0, 'Vered: read-only');
    assert.equal(await v.page.locator('#bc-exceptions').isVisible(), false, 'not Sandra: no «חריגים פתוחים»');
    assert.deepEqual(v.errors, []);
    await v.ctx.close();

    // Shiran: no tab at all.
    const sh = await open(browser, server.port, 'shiran', '#billing-control');
    assert.equal(await sh.page.locator('[data-billing-control]').count(), 0);
    assert.equal(await sh.page.locator('.tabs .tab.active').getAttribute('data-screen'), 'dashboard', 'the deep link falls back');
    await sh.ctx.close();
  } finally {
    await browser.close();
    server.close();
  }
});
