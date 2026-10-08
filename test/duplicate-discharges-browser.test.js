/* Duplicate discharges (CHANGELOG-duplicate-discharges.md) in REAL Chromium at
 * 360px: the real server.js, index.html, app.js and style.css, with every
 * /api/sheets call routed through the REAL Code.gs doPost (PROXY_SECRET gate,
 * roles from the signed session) over in-memory sheets.
 *
 *   1. The reported pair (one stay, two open rows, ONE shared credit): both rows
 *      read «זיכויים (1)» and offer «מחק כפילות» to Vered. The modal shows the
 *      (HTML-payload) name as text; an empty reason is refused before any send;
 *      with a reason the row leaves the tab, the survivor no longer offers the
 *      button, and the sheet holds the soft-delete stamps + an AuditLog row.
 *   2. Shiran (no deleter role) never sees «מחק כפילות».
 *   3. Double-click on the discharge «אישור» → ONE dischargePatient write; a
 *      stale second tab discharging the same stay → «השחרור כבר נרשם» and
 *      still ONE open row on the sheet.
 *
 * All names, ids and dates are SYNTHETIC.
 * SKIPPED unless BOTH `playwright` resolves AND a Chromium binary is present. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { loadGs, richSheet } = require('./helpers/gs-sandbox');

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
const PEPPER = 'pepper-TEST-dup-discharge-browser-0123456789abcdef';
const SESSION_SECRET = 'session-secret-TEST-dup-discharge-browser-0123';
const PROXY_SECRET = 'proxy-secret-TEST-dup-discharge-browser-0123456789';
const ENV_KEYS = ['PROXY_SECRET', 'SESSION_SECRET', 'SHEETS_URL', 'USER_PIN_HASHES', 'PIN_PEPPER'];
const DSHEET = 'מטופלים משוחררים';
const EVIL = '<img src=x onerror="window.__xss=1">בדיקה';
const NAME = 'מטופלת בדיקה';
const HOUSE = 'rehab';
const ENTRY = '2026-09-09';
const EXIT = '2026-10-06';

function backend(seed) {
  const g = loadGs({ props: { PROXY_SECRET } });
  const S = g.sandbox.__sheets;
  const put = (name, colsExpr, rows) => {
    const cols = Array.from(g.run(colsExpr));
    S[name] = richSheet(name, cols);
    (rows || []).forEach((r) => S[name].appendRow(cols.map((c) => (r[c] === undefined ? '' : r[c]))));
  };
  put('Patients', 'PATIENT_COLUMNS', seed.patients);
  put(DSHEET, 'DISCHARGED_PATIENT_COLUMNS', seed.discharged || []);
  put('Credits', 'CREDIT_COLUMNS', seed.credits || []);
  return { g, S, rows: (n, c) => g.sheetRows(n, c) };
}
const audit = (over) => Object.assign({
  houseId: HOUSE, name: EVIL, date: ENTRY, pay: 30000, adv: 0, status: 'released', fromLead: '', exitDate: EXIT,
  source: 'direct_admin', notes: '', dischargedAt: '2026-10-06T09:00:00.000Z', disposition: 'completed',
  discharge_note: '', restored: '', prior_status: 'active',
}, over);

async function boot(be) {
  const hash = await pinHash.hashPin('583920', PEPPER);
  const recs = ['vered', 'sandra', 'shiran'].map((id) => JSON.parse(users.recordLine(id, hash, 1)));
  const env = { PROXY_SECRET, SESSION_SECRET, SHEETS_URL: 'https://script.google.com/macros/s/TEST/exec', PIN_PEPPER: PEPPER, USER_PIN_HASHES: JSON.stringify(recs) };
  const saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; process.env[k] = env[k]; }
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  delete require.cache[SERVER_PATH];
  let mod;
  try { mod = require('../server'); } finally {
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
  const actions = [];
  const original = https.request;
  https.request = (url, opts, cb) => {
    const req = new EventEmitter();
    let body = '';
    req.write = (c) => { body += c; };
    req.end = () => {
      let out;
      try {
        const params = JSON.parse(body || '{}');
        actions.push(params.action);
        out = be.g.post(params);
      } catch (e) {
        out = { ok: false, error: 'exception', message: String(e && e.message) };
      }
      const res = new EventEmitter();
      res.statusCode = 200; res.headers = {}; res.setEncoding = () => {}; res.resume = () => {};
      setImmediate(() => { cb(res); res.emit('data', JSON.stringify(out)); res.emit('end'); });
    };
    return req;
  };
  const srv = await new Promise((resolve) => { const s = mod.app.listen(0, '127.0.0.1', () => resolve(s)); });
  return { port: srv.address().port, actions, close() { srv.close(); https.request = original; Object.assign(console, quiet); } };
}

async function openPage(browser, port, id) {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, deviceScaleFactor: 2, locale: 'he-IL', serviceWorkers: 'block' });
  const token = createSessionToken(SESSION_SECRET, undefined, undefined, users.modelById(id).name, { id, pinVersion: 1 });
  await ctx.addCookies([{ name: 'ezone_session', value: token, url: `http://127.0.0.1:${port}` }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e && e.message)));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#whoami', { state: 'visible', timeout: 15000 });
  return { ctx, page, errors };
}

const dischargedRows = (page) => page.locator('#discharged-patients-list .irrelevant-row');

test('«מחק כפילות» in Chromium: the reported pair, one shared credit, escaped name, reason required, soft delete + audit', { skip: skip && why, timeout: 120000 }, async () => {
  const be = backend({
    patients: [{ id: 'pt-1', houseId: HOUSE, name: EVIL, date: ENTRY, pay: 30000, status: 'released', exitDate: EXIT }],
    discharged: [audit({ id: 'aud-1' }), audit({ id: 'aud-2', dischargedAt: '2026-10-06T09:01:00.000Z' })],
    credits: [{ id: 'credit::pt-1::2026-09::1', patientId: 'pt-1', patientKey: HOUSE + '::' + EVIL + '::' + ENTRY, patientName: EVIL,
      houseId: HOUSE, facilityType: 'detox_dual', creditType: 'days_unused', allocationMonth: '2026-09', calculatedAmount: 1000,
      amount: 1000, status: 'pending', basis: JSON.stringify({ exitDate: EXIT }) }],
  });
  const server = await boot(be);
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  try {
    const { ctx, page, errors } = await openPage(browser, server.port, 'vered');
    await page.locator('.tabs .tab[data-screen="discharged-patients"]').click();
    await page.waitForFunction(() => document.querySelectorAll('#discharged-patients-list .irrelevant-row').length === 2);
    assert.deepEqual(await dischargedRows(page).locator('button', { hasText: 'זיכויים' }).allTextContents(), ['זיכויים (1)', 'זיכויים (1)'],
      'ONE credit, shown on both rows of the stay');
    assert.equal(await dischargedRows(page).locator('button', { hasText: 'מחק כפילות' }).count(), 2);

    await dischargedRows(page).nth(1).locator('button', { hasText: 'מחק כפילות' }).click();
    const modal = page.locator('.modal-backdrop .modal', { hasText: 'מחיקת שורת שחרור כפולה' });
    await modal.waitFor();
    assert.ok((await modal.locator('.confirm-text').first().textContent()).includes(EVIL), 'the name as literal text');
    assert.equal(await modal.locator('img').count(), 0, 'no element parsed out of the name');
    // No reason → the browser's own required check blocks the submit; nothing is sent.
    await modal.locator('button[type="submit"]').click();
    assert.equal(server.actions.filter((a) => a === 'deleteDuplicateDischarge').length, 0);
    await modal.locator('input[name="reason"]').fill('שורה כפולה מאותו שחרור');
    await modal.locator('button[type="submit"]').dblclick();
    await modal.waitFor({ state: 'detached', timeout: 10000 });
    await page.waitForFunction(() => document.querySelectorAll('#discharged-patients-list .irrelevant-row').length === 1);
    assert.equal(server.actions.filter((a) => a === 'deleteDuplicateDischarge').length, 1, 'the double click sent once');
    assert.equal(await dischargedRows(page).locator('button', { hasText: 'מחק כפילות' }).count(), 0, 'the survivor is the last row: no button');
    assert.equal(await page.locator('#discharged-patients-count').textContent(), '1');

    const rows = be.rows(DSHEET, 'DISCHARGED_PATIENT_COLUMNS');
    assert.equal(rows.length, 2, 'soft: still on the sheet');
    assert.equal(rows[1].deletedBy, 'ורד');
    assert.equal(rows[1].deleteReason, 'שורה כפולה מאותו שחרור');
    assert.ok(rows[1].deletedAt);
    assert.equal(rows[0].deletedAt, '');
    assert.equal(be.rows('AuditLog', 'AUDIT_LOG_COLUMNS').filter((a) => a.action === 'discharge_duplicate_deleted').length, 1);
    assert.equal(be.rows('Patients', 'PATIENT_COLUMNS').length, 1, 'the patient row is untouched');

    // After a reload the deleted row stays out of the tab.
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('#whoami', { state: 'visible', timeout: 15000 });
    await page.locator('.tabs .tab[data-screen="discharged-patients"]').click();
    await page.waitForFunction(() => document.querySelectorAll('#discharged-patients-list .irrelevant-row').length === 1);
    assert.equal(await page.evaluate(() => window.__xss), undefined, 'nothing ran');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no sideways scroll');
    assert.deepEqual(errors, [], 'no page errors');
    await ctx.close();
  } finally {
    await browser.close();
    server.close();
  }
});

test('Shiran (no deleter role) never sees «מחק כפילות»', { skip: skip && why, timeout: 120000 }, async () => {
  const be = backend({
    patients: [{ id: 'pt-1', houseId: HOUSE, name: NAME, date: ENTRY, status: 'released', exitDate: EXIT }],
    discharged: [audit({ id: 'aud-1', name: NAME }), audit({ id: 'aud-2', name: NAME })],
  });
  const server = await boot(be);
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  try {
    const { ctx, page, errors } = await openPage(browser, server.port, 'shiran');
    await page.locator('.tabs .tab[data-screen="discharged-patients"]').click();
    await page.waitForFunction(() => document.querySelectorAll('#discharged-patients-list .irrelevant-row').length === 2);
    assert.equal(await page.locator('#discharged-patients-list button', { hasText: 'מחק כפילות' }).count(), 0);
    assert.deepEqual(errors, []);
    await ctx.close();
  } finally {
    await browser.close();
    server.close();
  }
});

test('discharge: a double click writes ONCE; a stale second tab gets «השחרור כבר נרשם» and the sheet keeps ONE open row', { skip: skip && why, timeout: 120000 }, async () => {
  const be = backend({ patients: [{ id: 'pt-1', houseId: HOUSE, name: NAME, date: ENTRY, pay: 30000, status: 'active' }] });
  const server = await boot(be);
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  try {
    const a = await openPage(browser, server.port, 'vered');
    const b = await openPage(browser, server.port, 'vered');   // loaded BEFORE the discharge: stale
    const discharge = async (page) => {
      await page.locator('.tabs .tab[data-screen="occupancy"]').click();
      await page.locator('#house-tabs .h-tab', { hasText: 'קיסריה ריהאב' }).click();
      await page.locator('#patients-list .patient-row', { hasText: NAME }).locator('[data-action="release"]').click();
      const modal = page.locator('.modal-backdrop .modal', { hasText: 'שחרור מטופל' });
      await modal.locator('input[name="disposition"][value="completed"]').check();
      await modal.locator('input[name="dischargeDate"]').fill(EXIT);
      await modal.locator('button[type="submit"]').dblclick();
      return modal;
    };
    await discharge(a.page);
    // The credits step opens after a full discharge; close it.
    const credits = a.page.locator('.credits-modal');
    await credits.waitFor({ timeout: 10000 });
    await credits.locator('[data-action="cancel"]').click();
    assert.equal(server.actions.filter((x) => x === 'dischargePatient').length, 1, 'double click → one write');

    await discharge(b.page);
    await b.page.waitForFunction(() => document.getElementById('toast-banner').textContent.includes('השחרור כבר נרשם'), null, { timeout: 10000 });
    assert.equal(server.actions.filter((x) => x === 'dischargePatient').length, 2);
    const open = be.rows(DSHEET, 'DISCHARGED_PATIENT_COLUMNS').filter((r) => String(r.restored) !== 'TRUE' && !r.deletedAt);
    assert.equal(open.length, 1, 'ONE open discharge row for the stay');
    assert.equal(await b.page.locator('.credits-modal').count(), 0, 'no second credits step');
    assert.equal(be.rows('Patients', 'PATIENT_COLUMNS')[0].status, 'released');
    assert.deepEqual(a.errors.concat(b.errors), []);
    await a.ctx.close(); await b.ctx.close();
  } finally {
    await browser.close();
    server.close();
  }
});
