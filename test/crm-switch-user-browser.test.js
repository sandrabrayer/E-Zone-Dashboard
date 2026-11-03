'use strict';

/* «החלפת משתמש» end to end in a real Chromium at 360 px
 * (CHANGELOG-crm-dana-default-switch-user.md). SKIPPED unless playwright + a
 * Chromium binary are present (same rule as crm-shell-browser.test.js).
 * The real server.js with CRM_ENABLED + CRM_DEFAULT; Apps Script stubbed.
 *
 * Vered (CRM, «גבייה» open) → «החלפת משתמש» → the PIN screen at `/` with none
 * of her data, the old cookie 401 → Dana logs in with her PIN → the CRM, her
 * name, no «גבייה», no «חשבון», no money read, none of Vered's billing on the
 * page → «החלפת משתמש» → Ortal → the classic page (her default) with the same
 * control → «החלפת משתמש» → the name list. 44px tap target, no horizontal
 * scroll at 360 px on every screen. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const { EventEmitter } = require('node:events');
let playwright = null;
try { playwright = require('playwright'); } catch (_) { /* skip */ }
const CHROMIUM_CANDIDATES = [process.env.CHROMIUM_PATH, '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium/chrome-linux/chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean);
let chromiumPath = CHROMIUM_CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch (_) { return false; } });
if (!chromiumPath) {
  try {
    const d = '/opt/pw-browsers';
    chromiumPath = fs.readdirSync(d).filter((n) => n.startsWith('chromium-'))
      .flatMap((n) => [`${d}/${n}/chrome-linux/chrome`, `${d}/${n}/chrome-linux64/chrome`]).find((p) => fs.existsSync(p));
  } catch (_) { /* none */ }
}
const skip = !playwright || !chromiumPath;

const pinHash = require('../lib/pin-hash');
const users = require('../lib/users');
const { createSessionToken } = require('../lib/session');
const SERVER_PATH = require.resolve('../server');
const PEPPER = 'pepper-TEST-switch-browser-0123456789abcdef0';
const SESSION_SECRET = 'session-secret-TEST-switch-browser-0123456';
const PROXY_SECRET = 'proxy-secret-TEST-switch-browser-0123456789a';
const PIN = '583920';
const ENV_KEYS = ['PROXY_SECRET', 'SESSION_SECRET', 'SHEETS_URL', 'USER_PIN_HASHES', 'PIN_PEPPER', 'CRM_ENABLED', 'CRM_DEFAULT'];
const israelDay = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date(ms));
const TODAY = israelDay(Date.now());
const daysAgo = (n) => israelDay(Date.now() - n * 86400000);

const DATA = {
  ok: true, irrelevantLeads: [], removedLeads: [], billingOverrides: [], houseManagers: {}, managerPhones: {}, currentManagers: [], outpatientSentLeadIds: [], dischargedPatients: [],
  leads: [{ id: 'L1', name: 'אבי לוי', house: 'ramot', stage: 'new', created: daysAgo(5), assignedTo: 'ורד', phone: '0501111111' }],
  patients: { ramot: [{ id: 'p1', name: 'שירה כהן', date: daysAgo(30), status: 'active', pay: 6000 }] },
};
/* Vered's billing — a debtor only the finance view ever sees. */
const DEBT = { ok: true, asOf: TODAY,
  totals: { recorded_debt: { count: 1, total: 7777, d0_7: 0, d8_30: 0, d31_60: 0, d61_plus: 7777 }, unrecorded_cycles: { count: 0, total: 0, d0_7: 0, d8_30: 0, d31_60: 0, d61_plus: 0 } },
  byHouse: [{ houseId: 'ramot', recorded_debt: { count: 1, total: 7777 }, unrecorded_cycles: { count: 0, total: 0 } }],
  byPatient: [{ patientId: 'p1', name: 'שירה כהן', houseId: 'ramot', status: 'active', inHouseAtAsOf: true, cycles: [{ start: daysAgo(70), end: daysAgo(41), expected: 7777, received: 0, balance: 7777, days: 70, kind: 'recorded', paymentId: 'cyc-1' }] }],
  detachedPayments: { count: 0, rows: [] }, pendingCredits: { count: 0, total: 0 }, funderGrace: { count: 0, amount: 0 } };
const PAYMENTS = { ok: true, payments: [], receipts: [{ id: 'rcpt-1', patientUid: 'p1', patientName: 'שירה כהן', houseId: 'ramot', receivedDate: daysAgo(4), amount: 4321, method: 'ביט', confirmStatus: 'reported' }], funders: [] };

async function boot() {
  const hash = await pinHash.hashPin(PIN, PEPPER);
  const recs = ['vered', 'sandra', 'ortal', 'dana'].map((id) => JSON.parse(users.recordLine(id, hash, 1)));
  const env = { PROXY_SECRET, SESSION_SECRET, SHEETS_URL: 'https://script.google.com/macros/s/TEST/exec', PIN_PEPPER: PEPPER, USER_PIN_HASHES: JSON.stringify(recs), CRM_ENABLED: 'true', CRM_DEFAULT: 'true' };
  const saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; process.env[k] = env[k]; }
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  delete require.cache[SERVER_PATH];
  let mod;
  try { mod = require('../server'); } finally { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
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
      const answer = parsed.action === 'getData' ? DATA : parsed.action === 'debtAging' ? DEBT : parsed.action === 'getPayments' ? PAYMENTS
        : parsed.action === 'getTasks' ? { ok: true, total: 0, tasks: [] } : parsed.action === 'contactIndex' ? { ok: true, count: 0, leads: {}, patients: {} }
        : parsed.action === 'getActivity' ? { ok: true, scope: 'full', total: 0, events: [] } : parsed.action === 'billingControlQueue' ? { ok: true, receipts: [] }
        : parsed.action === 'getCredits' ? { ok: true, credits: [] } : { ok: true };
      const res = new EventEmitter();
      res.statusCode = 200; res.headers = {}; res.setEncoding = () => {}; res.resume = () => {};
      setImmediate(() => { cb(res); res.emit('data', JSON.stringify(answer)); res.emit('end'); });
    };
    return req;
  };
  const srv = await new Promise((resolve) => { const s = mod.app.listen(0, '127.0.0.1', () => resolve(s)); });
  return { port: srv.address().port, actions, close() { srv.close(); https.request = original; Object.assign(console, quiet); } };
}
function getMe(port, token) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/api/me', headers: { Cookie: 'ezone_session=' + token } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end();
  });
}
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
const height = (page, sel) => page.$eval(sel, (el) => el.getBoundingClientRect().height);
const waitCrm = async (page) => {
  await page.waitForSelector('#crm-nav button', { timeout: 15000 });
  await page.waitForFunction(() => !/טוען/.test((document.querySelector('#crm-main') || {}).textContent || ''), null, { timeout: 15000 });
};
async function pinLogin(page, name) {
  await page.waitForSelector('#login-names button[data-user-id]', { state: 'visible', timeout: 15000 });
  await page.locator('#login-names button', { hasText: name }).click();
  await page.waitForSelector('#login-step-pin', { state: 'visible' });
  await page.locator('#login-pin-input').fill(PIN);
  await page.locator('#login-pin-submit').click();
}

test('«החלפת משתמש» at 360 px: Vered (CRM) → PIN screen, nothing of hers left, old cookie 401 → Dana lands on the CRM without «גבייה» / «חשבון» / money → Ortal lands on classic → name list', { skip: skip && 'playwright/chromium missing', timeout: 120000 }, async () => {
  const srv = await boot();
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  try {
    const ctx = await browser.newContext({ viewport: { width: 360, height: 760 }, locale: 'he-IL', timezoneId: 'Asia/Jerusalem', serviceWorkers: 'block' });
    const veredToken = createSessionToken(SESSION_SECRET, undefined, undefined, 'ורד', { id: 'vered', pinVersion: 1 });
    await ctx.addCookies([{ name: 'ezone_session', value: veredToken, url: `http://127.0.0.1:${srv.port}` }]);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e && e.message)));

    // ---- Vered: `/` is the CRM; open «גבייה» so her billing is on the page ----
    await page.goto(`http://127.0.0.1:${srv.port}/`, { waitUntil: 'networkidle' });
    await waitCrm(page);
    assert.equal((await page.textContent('#crm-user')).trim(), 'ורד');
    await page.evaluate(() => document.querySelector('#crm-nav button[data-area="billing"]').click());
    await page.waitForFunction(() => /7,777/.test(document.querySelector('#crm-main').textContent), null, { timeout: 15000 });
    assert.ok(await page.isVisible('#crm-switch-user'), 'the button is visible at 360 px');
    assert.ok(await page.isVisible('#crm-who'), 'the current user’s name is in the header at 360 px');
    assert.equal((await page.textContent('#crm-who')).trim(), 'ורד');
    assert.ok((await height(page, '#crm-switch-user')) >= 44, '44px tap target (CRM)');
    assert.equal((await page.textContent('#crm-switch-user')).trim(), 'החלפת משתמש');
    assert.ok(await noHScroll(page), 'no horizontal scroll at 360 (CRM)');

    // ---- switch → the PIN screen, nothing of Vered's left ----
    await page.click('#crm-switch-user');
    await page.waitForSelector('#login-names button[data-user-id]', { state: 'visible', timeout: 15000 });
    assert.equal(new URL(page.url()).pathname + new URL(page.url()).search, '/', 'back on `/`');
    const pinText = await page.evaluate(() => document.body.innerText);
    for (const leak of ['7,777', '4,321', 'שירה כהן', 'אבי לוי', 'מחובר/ת']) assert.ok(!pinText.includes(leak), 'PIN screen shows no ' + leak);
    assert.equal(await page.$('#crm-root'), null, 'the CRM is gone');
    assert.ok(!(await ctx.cookies()).some((c) => c.name === 'ezone_session' && c.value), 'the cookie is cleared');
    assert.equal(await getMe(srv.port, veredToken), 401, 'the old cookie value is dead on the server');
    assert.ok(await noHScroll(page), 'no horizontal scroll at 360 (PIN)');

    // ---- Dana logs in: her own default (the CRM), no money ----
    const before = srv.actions.length;
    await pinLogin(page, 'דנה');
    await waitCrm(page);
    assert.equal((await page.textContent('#crm-user')).trim(), 'דנה');
    assert.equal((await page.textContent('#crm-who')).trim(), 'דנה');
    assert.equal(await page.$('#crm-nav button[data-area="billing"]'), null, 'no «גבייה» area');
    assert.ok(!/גבייה|כספים/.test(await page.textContent('#crm-nav')), 'no «גבייה» in the menu');
    await page.evaluate(() => document.querySelector('#crm-nav button[data-area="clients"]').click());
    await page.click('tr[data-open-patient="p1"]');
    await page.waitForSelector('#crm-drawer[aria-hidden="false"]');
    assert.equal(await page.$('#crm-drawer [data-tab="account"]'), null, 'no «חשבון» tab');
    assert.equal(await page.$('#crm-drawer [data-pane="account"]'), null, 'no «חשבון» pane');
    assert.ok(!/חשבון/.test(await page.textContent('#crm-drawer [role="tablist"]')));
    const danaHtml = await page.content();
    for (const leak of ['7,777', '4,321', '6,000', 'ורד</span>']) assert.ok(!danaHtml.includes(leak), 'Dana’s page has no ' + leak);
    const danaActions = srv.actions.slice(before).filter((a) => a.user === 'dana').map((a) => a.action);
    for (const money of ['debtAging', 'getPayments', 'getCredits', 'billingControlQueue']) assert.ok(!danaActions.includes(money), 'no ' + money + ' for Dana');
    assert.ok(danaActions.includes('getData'));
    assert.ok(await noHScroll(page), 'no horizontal scroll at 360 (Dana)');

    // ---- switch → Ortal: her default is the classic page ----
    await page.keyboard.press('Escape');
    await page.click('#crm-switch-user');
    await pinLogin(page, 'אורטל');
    await page.waitForSelector('#whoami:not(.hidden)', { timeout: 15000 });
    assert.equal(await page.$('#crm-root'), null, 'Ortal → classic');
    assert.match(await page.textContent('#whoami'), /אורטל/);
    assert.ok(!/דנה/.test(await page.textContent('#whoami')));
    assert.ok((await height(page, '#switch-user')) >= 44, '44px tap target (classic)');
    assert.ok(await noHScroll(page), 'no horizontal scroll at 360 (classic)');

    // ---- classic switch → the name list (not Ortal's PIN step) ----
    await page.click('#switch-user');
    await page.waitForSelector('#login-step-name:not(.hidden)', { timeout: 15000 });
    assert.ok(await page.isVisible('#login-names button[data-user-id]'));
    assert.ok(!/אורטל/.test(await page.textContent('#whoami').catch(() => '')), 'no leftover name');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); srv.close(); }
});
