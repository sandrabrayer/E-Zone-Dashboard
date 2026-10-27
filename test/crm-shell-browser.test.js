'use strict';

/* C2 — the CRM shell in a real Chromium at 1366 px and 390 px
 * (CHANGELOG-crm-shell-areas.md). SKIPPED unless playwright + a Chromium
 * binary are present (same rule as billing-control-tab-browser.test.js).
 * The real server.js with CRM_ENABLED=true; Apps Script is stubbed with a
 * synthetic getData. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const https = require('node:https');
const { EventEmitter } = require('node:events');
let playwright = null;
try { playwright = require('playwright'); } catch (_) { /* skip */ }
const CHROMIUM_CANDIDATES = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium/chrome-linux/chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
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
const PEPPER = 'pepper-TEST-crm-shell-browser-0123456789abcdef';
const SESSION_SECRET = 'session-secret-TEST-crm-shell-browser-012345';
const PROXY_SECRET = 'proxy-secret-TEST-crm-shell-browser-0123456789';
const ENV_KEYS = ['PROXY_SECRET', 'SESSION_SECRET', 'SHEETS_URL', 'USER_PIN_HASHES', 'PIN_PEPPER', 'CRM_ENABLED'];
const israelDay = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date(ms));
const TODAY = israelDay(Date.now());
const daysAgo = (n) => israelDay(Date.now() - n * 86400000);

const DATA = {
  ok: true, irrelevantLeads: [], removedLeads: [], dischargedPatients: [], billingOverrides: [], houseManagers: {}, managerPhones: {}, currentManagers: [],
  leads: [
    { id: 'L1', name: 'אבי לוי', house: 'רמות השבים', stage: 'new', created: daysAgo(5), assignedTo: 'ורד', phone: '0501111111', source: 'פייסבוק' },
    { id: 'L2', name: 'גלי כהן', house: 'ramot', stage: 'visit', visitDate: TODAY, visitTime: '13:30', meetingWith: 'אורן', created: daysAgo(2) },
    { id: 'L3', name: 'דנה מזרחי', house: 'רעננה הפרדס', stage: 'visit', visitDate: daysAgo(3), meetingWith: 'חן', created: daysAgo(6) },
    { id: 'L4', name: 'טל ברק', house: 'רמות השבים', stage: 'paid', created: daysAgo(10), assignedTo: 'ורד' },
  ],
  patients: { ramot: [{ id: 'p1', name: 'דנה כהן', date: daysAgo(30), status: 'active' }], rehab: [{ id: 'p2', name: 'אבי', date: daysAgo(7), status: 'active' }] },
};
const QUEUE = { ok: true, receipts: [{ id: 'r1', status: 'reported' }, { id: 'r2', status: 'flagged' }] };
const ACTIVITY = { ok: true, scope: 'full', total: 1, events: [{ eventId: 'x', occurredAt: '2026-10-20T09:00:00.000Z', kind: 'lead_created', source: 'system:x', actorName: 'ורד', summary: 'הליד נוצר', details: {} }] };

async function boot() {
  const hash = await pinHash.hashPin('583920', PEPPER);
  const recs = ['vered', 'sandra', 'ortal'].map((id) => JSON.parse(users.recordLine(id, hash, 1)));
  const env = { PROXY_SECRET, SESSION_SECRET, SHEETS_URL: 'https://script.google.com/macros/s/TEST/exec', PIN_PEPPER: PEPPER, USER_PIN_HASHES: JSON.stringify(recs), CRM_ENABLED: 'true' };
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
      const answer = parsed.action === 'getData' ? DATA : parsed.action === 'billingControlQueue' ? QUEUE : parsed.action === 'getActivity' ? ACTIVITY : { ok: false, error: 'unexpected_' + parsed.action };
      const res = new EventEmitter();
      res.statusCode = 200; res.headers = {}; res.setEncoding = () => {}; res.resume = () => {};
      setImmediate(() => { cb(res); res.emit('data', JSON.stringify(answer)); res.emit('end'); });
    };
    return req;
  };
  const srv = await new Promise((resolve) => { const s = mod.app.listen(0, '127.0.0.1', () => resolve(s)); });
  return { port: srv.address().port, actions, close() { srv.close(); https.request = original; Object.assign(console, quiet); } };
}

async function open(browser, port, id, width) {
  const ctx = await browser.newContext({ viewport: { width, height: 800 }, locale: 'he-IL', timezoneId: 'Asia/Jerusalem', serviceWorkers: 'block' });
  const name = users.modelById(id).name;
  await ctx.addCookies([{ name: 'ezone_session', value: createSessionToken(SESSION_SECRET, undefined, undefined, name, { id, pinVersion: 1 }), url: `http://127.0.0.1:${port}` }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e && e.message)));
  await page.goto(`http://127.0.0.1:${port}/?view=crm`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#crm-nav button', { timeout: 15000 });
  await page.waitForFunction(() => !document.querySelector('#crm-main .crm-state') || !/טוען/.test(document.querySelector('#crm-main').textContent), null, { timeout: 15000 });
  return { ctx, page, errors };
}
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);

test('CRM shell at 1366 px (Vered): side menu, six areas, work queue, board/table toggle keeps filters, drawer with timeline', { skip: skip && 'playwright/chromium missing' }, async () => {
  const srv = await boot();
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  try {
    const { page, errors } = await open(browser, srv.port, 'vered', 1366);
    assert.equal(await page.getAttribute('html', 'dir'), 'rtl');
    assert.deepEqual(await page.$$eval('#crm-nav button span:first-child', (els) => els.map((e) => e.textContent)), ['היום שלי', 'פניות', 'לקוחות', 'יומן', 'גבייה', 'בקרה']);
    assert.ok(await page.isVisible('#crm-menu'));
    assert.ok(!(await page.isVisible('#crm-burger')), 'no burger on desktop');
    assert.equal(await page.$eval('#crm-user', (e) => e.textContent), 'ורד');
    // «היום שלי»: KPIs + the late row for the meeting without an outcome
    const kpis = await page.$$eval('.kpi .v', (els) => els.map((e) => e.textContent));
    assert.deepEqual(kpis, ['2', '1', '0', '1']);
    assert.match(await page.textContent('#crm-main'), /דנה מזרחי/);
    assert.match(await page.textContent('#crm-main'), /לקבל דיווח מהמנהל\/ת/);
    await page.click('.kpi[data-kpi="late"]');
    assert.ok(!/גלי כהן/.test(await page.textContent('#crm-main .rows')), 'the KPI filters the list');
    // «פניות»: board, filter, table keeps the filter
    await page.click('#crm-nav button[data-area="leads"]');
    assert.equal(await page.$$eval('.col', (els) => els.length), 4);
    await page.selectOption('#f-house', 'רמות השבים');
    const onBoard = await page.$$eval('.card .name', (els) => els.map((e) => e.textContent));
    assert.deepEqual(onBoard.sort(), ['אבי לוי', 'גלי כהן', 'טל ברק']);
    await page.click('button[data-view="table"]');
    assert.equal(await page.$eval('#f-house', (e) => e.value), 'רמות השבים', 'filter kept across the toggle');
    assert.equal(await page.$$eval('table.tbl tbody tr', (els) => els.length), 3);
    // drawer: existing fields + timeline from getActivity
    await page.click('table.tbl tbody tr');
    await page.waitForSelector('#crm-drawer[aria-hidden="false"]');
    assert.match(await page.textContent('#crm-drawer'), /סקירה/);
    await page.click('#crm-drawer [data-tab="activity"]');
    await page.waitForFunction(() => /הליד נוצר/.test(document.querySelector('#crm-tl').textContent), null, { timeout: 5000 });
    await page.keyboard.press('Escape');
    assert.equal(await page.getAttribute('#crm-drawer', 'aria-hidden'), 'true');
    assert.equal(await page.$eval('#f-house', (e) => e.value), 'רמות השבים', 'closing the card keeps the filter');
    // «לקוחות», «יומן», «גבייה», «בקרה» render
    await page.click('#crm-nav button[data-area="clients"]');
    assert.match(await page.textContent('#crm-main'), /דנה כהן/);
    await page.click('#crm-nav button[data-area="calendar"]');
    assert.match(await page.textContent('#crm-main'), /גלי כהן/);
    await page.click('#crm-nav button[data-area="billing"]');
    assert.match(await page.textContent('#crm-main'), /בקרת גבייה/);
    await page.click('#crm-nav button[data-area="control"]');
    assert.match(await page.textContent('#crm-main'), /פגישות ללא תוצאה/);
    assert.ok(await noHScroll(page), 'no horizontal page scroll');
    assert.deepEqual(errors, []);
    assert.deepEqual([...new Set(srv.actions.map((a) => a.action))].sort(), ['getActivity', 'getData'], 'reads only, no queue for Vered');
  } finally { await browser.close(); srv.close(); }
});

test('CRM shell at 390 px (Vered): burger opens the drawer menu, areas work, no horizontal scroll', { skip: skip && 'playwright/chromium missing' }, async () => {
  const srv = await boot();
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  try {
    const { page, errors } = await open(browser, srv.port, 'vered', 390);
    assert.ok(await page.isVisible('#crm-burger'));
    assert.notEqual(await page.getAttribute('#crm-menu', 'data-open'), 'true');
    await page.click('#crm-burger');
    assert.equal(await page.getAttribute('#crm-menu', 'data-open'), 'true');
    await page.click('#crm-nav button[data-area="leads"]');
    assert.notEqual(await page.getAttribute('#crm-menu', 'data-open'), 'true', 'choosing an area closes the menu');
    assert.equal(await page.textContent('#crm-title'), 'פניות');
    assert.ok(await noHScroll(page), 'no horizontal page scroll at 390');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); srv.close(); }
});

test('CRM shell (Ortal, controller): only היום שלי / גבייה / בקרה; her day comes from billingControlQueue; no lead data requested', { skip: skip && 'playwright/chromium missing' }, async () => {
  const srv = await boot();
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  try {
    const { page, errors } = await open(browser, srv.port, 'ortal', 1366);
    assert.deepEqual(await page.$$eval('#crm-nav button span:first-child', (els) => els.map((e) => e.textContent)), ['היום שלי', 'גבייה', 'בקרה']);
    await page.waitForFunction(() => /דיווחים לאימות/.test(document.querySelector('#crm-main').textContent), null, { timeout: 5000 });
    assert.deepEqual(await page.$$eval('.kpi .v', (els) => els.map((e) => e.textContent)), ['1', '1', '0']);
    assert.ok(!/אבי לוי/.test(await page.textContent('#crm-main')), 'no lead names in her view');
    assert.deepEqual(errors, []);
    assert.ok(srv.actions.some((a) => a.action === 'billingControlQueue' && a.user === 'ortal'));
  } finally { await browser.close(); srv.close(); }
});
