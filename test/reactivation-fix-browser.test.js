/* Reactivation fix (CHANGELOG-reactivation-fix.md) in REAL Chromium at 360px:
 * the real server.js, index.html, app.js and style.css, with every
 * /api/sheets call routed into the REAL apps-script/Code.gs (vm sandbox over
 * fake sheets) — so a reload is a genuine getData round trip.
 *
 *   1. A genuine clobber (active on the sheet, discharge record open) is
 *      healed on load and ANNOUNCED by a toast. The name in it is an HTML
 *      payload: it must render as text (no <img>, no script run).
 *   2. THE BUG: ✏️ on a released ramot patient → פעיל → save → reload. The
 *      patient must still be in the ramot house tab, the sheet must say
 *      active, and the discharge record must be kept, flagged restored.
 *
 * All names, ids and dates are SYNTHETIC.
 *
 * SKIPPED unless BOTH `playwright` resolves AND a Chromium binary is present. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

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
const chromiumPath = CHROMIUM_CANDIDATES.find((p) => {
  try { return fs.existsSync(p); } catch (_) { return false; }
});
const skip = !playwright || !chromiumPath;
const why = !playwright ? 'playwright not installed' : (!chromiumPath ? 'no chromium binary' : '');

const pinHash = require('../lib/pin-hash');
const users = require('../lib/users');
const { createSessionToken } = require('../lib/session');

const ROOT = path.join(__dirname, '..');
const GS_SRC = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');
const SERVER_PATH = require.resolve('../server');
const PEPPER = 'pepper-TEST-reactivation-browser-0123456789abcdef';
const SESSION_SECRET = 'session-secret-TEST-reactivation-browser-012345';
const ENV_KEYS = ['PROXY_SECRET', 'SESSION_SECRET', 'SHEETS_URL', 'USER_PIN_HASHES', 'PIN_PEPPER'];
const arr = (x) => Array.from(x);

const NAME = 'ישראלה ישראלי';
const OTHER = 'פלוני אלמוני';
const EVIL = '<img src=x onerror="window.__xss=1">';
const ENTRY = '2026-06-01';

/* ---------- the REAL Code.gs over fake sheets ---------- */
function fakeSheet(headerRow, dataRows) {
  const grid = [headerRow.slice()].concat((dataRows || []).map((r) => r.slice()));
  let hidden = false;
  return {
    grid,
    getLastRow() { return grid.length; },
    getLastColumn() { return grid[0] ? grid[0].length : 0; },
    getMaxRows() { return Math.max(grid.length, 1000); },
    setFrozenRows() {},
    hideSheet() { hidden = true; },
    isSheetHidden() { return hidden; },
    getRange(r, c, nr, nc) {
      nr = nr || 1; nc = nc || 1;
      return {
        setNumberFormat() {},
        getValue() { const g = grid[r - 1]; return g && g[c - 1] !== undefined ? g[c - 1] : ''; },
        setValue(v) { if (!grid[r - 1]) grid[r - 1] = []; grid[r - 1][c - 1] = v; },
        getValues() {
          const out = [];
          for (let i = 0; i < nr; i++) {
            const row = [];
            for (let j = 0; j < nc; j++) {
              const g = grid[r - 1 + i];
              row.push(g && g[c - 1 + j] !== undefined ? g[c - 1 + j] : '');
            }
            out.push(row);
          }
          return out;
        },
        setValues(vals) {
          for (let i = 0; i < vals.length; i++) {
            if (!grid[r - 1 + i]) grid[r - 1 + i] = [];
            for (let j = 0; j < vals[i].length; j++) grid[r - 1 + i][c - 1 + j] = vals[i][j];
          }
        },
        clearContent() {
          for (let i = 0; i < nr; i++) {
            if (!grid[r - 1 + i]) continue;
            for (let j = 0; j < nc; j++) grid[r - 1 + i][c - 1 + j] = '';
          }
        },
      };
    },
  };
}

function loadBackend() {
  const noop = () => {};
  let uuid = 0;
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    JSON, Math, Date, Number, String, Array, Object, RegExp, isFinite,
    Logger: { log: noop },
    __sheets: {},
  };
  sandbox.SpreadsheetApp = {
    getActiveSpreadsheet: () => ({
      getSheetByName: (name) => sandbox.__sheets[name] || null,
      insertSheet: (name) => (sandbox.__sheets[name] = fakeSheet([], [])),
      getSpreadsheetTimeZone: () => 'Asia/Jerusalem',
    }),
  };
  sandbox.PropertiesService = { getScriptProperties: () => ({ getProperty: () => null, setProperty() { return this; } }) };
  sandbox.ContentService = {
    createTextOutput: (s) => ({ setMimeType: () => ({ json: JSON.parse(s) }) }),
    MimeType: { JSON: 'json' },
  };
  sandbox.Utilities = { getUuid: () => 'uuid-' + (++uuid), formatDate: (d) => d.toISOString().slice(0, 10) };
  sandbox.LockService = { getScriptLock: () => ({ tryLock: () => true, waitLock: noop, releaseLock: noop }) };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(GS_SRC + `
    globalThis.__gs = {
      handle: (p) => handle_(p).json,
      readSheet: (sh, cols) => readSheet_(sh, cols),
      PATIENT_COLUMNS, DISCHARGED_PATIENT_COLUMNS, PATIENTS_SHEET, DISCHARGED_PATIENTS_SHEET,
    };`, sandbox);
  const gs = sandbox.__gs;
  const rowOf = (cols, f) => arr(cols).map((c) => (f[c] === undefined ? '' : f[c]));
  return {
    gs,
    handle: (p) => JSON.parse(JSON.stringify(gs.handle(JSON.parse(JSON.stringify(p))))),
    seed(sheetName, cols, rows) { sandbox.__sheets[sheetName] = fakeSheet(arr(cols), rows.map((f) => rowOf(cols, f))); },
    rows(sheetName, cols) {
      const sh = sandbox.__sheets[sheetName];
      return sh ? arr(gs.readSheet(sh, cols)).map((r) => JSON.parse(JSON.stringify(r))) : [];
    },
  };
}

function patientRow(over) {
  return Object.assign({
    id: 'id-syn-1', houseId: 'ramot', name: NAME, date: ENTRY, pay: 9000, adv: 0,
    status: 'released', fromLead: '', exitDate: '2026-09-20', source: 'direct_admin', notes: '',
  }, over || {});
}
function auditRow(over) {
  return Object.assign({
    id: 'aud-syn-1', houseId: 'ramot', name: NAME, date: ENTRY, pay: 9000, adv: 0,
    status: 'released', fromLead: '', exitDate: '2026-09-20', source: 'direct_admin', notes: '',
    dischargedAt: '2026-09-20T08:00:00.000Z', disposition: 'completed', discharge_note: '',
    restored: '', prior_status: 'active',
  }, over || {});
}

async function boot(backend) {
  const hash = await pinHash.hashPin('583920', PEPPER);
  const recs = ['vered', 'sandra'].map((id) => JSON.parse(users.recordLine(id, hash, 1)));
  const env = {
    PROXY_SECRET: 'proxy-secret-TEST-reactivation-browser-0123456789', SESSION_SECRET,
    SHEETS_URL: 'https://script.google.com/macros/s/TEST/exec', PIN_PEPPER: PEPPER,
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
        out = backend.handle(params);
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
  return {
    port: srv.address().port,
    actions,
    close() { srv.close(); https.request = original; Object.assign(console, quiet); },
  };
}

function tokenFor(id) {
  return createSessionToken(SESSION_SECRET, undefined, undefined, users.modelById(id).name, { id, pinVersion: 1 });
}

async function openPage(browser, port) {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, deviceScaleFactor: 2, locale: 'he-IL', serviceWorkers: 'block' });
  await ctx.addCookies([{ name: 'ezone_session', value: tokenFor('vered'), url: `http://127.0.0.1:${port}` }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e && e.message)));
  return { ctx, page, errors };
}

async function load(page, port) {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#whoami', { state: 'visible', timeout: 15000 });
}

async function ramotNames(page) {
  await page.locator('.tabs .tab[data-screen="occupancy"]').click();
  await page.locator('#house-tabs .h-tab', { hasText: 'רמות השבים' }).click();
  return (await page.locator('#patients-list .p-name').allTextContents()).map((t) => t.trim());
}

test('heal toast: announced, and an HTML name renders as text', { skip: skip && why, timeout: 120000 }, async () => {
  const backend = loadBackend();
  const g = backend.gs;
  backend.seed(g.PATIENTS_SHEET, g.PATIENT_COLUMNS, [
    patientRow({ id: 'id-syn-0', name: OTHER, status: 'active', exitDate: '' }),
    patientRow({ id: 'id-evil', name: EVIL, status: 'active', exitDate: '' }),
  ]);
  backend.seed(g.DISCHARGED_PATIENTS_SHEET, g.DISCHARGED_PATIENT_COLUMNS, [auditRow({ id: 'aud-evil', name: EVIL })]);
  const server = await boot(backend);
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  try {
    const { ctx, page, errors } = await openPage(browser, server.port);
    await load(page, server.port);
    await page.waitForFunction(() => /רישום שחרור פתוח/.test(document.getElementById('toast-banner').textContent), null, { timeout: 10000 });
    const toast = page.locator('#toast-banner');
    assert.equal(await toast.textContent(), 'סומנו כמשוחררים לפי רישום שחרור פתוח: ' + EVIL, 'the name, verbatim, as text');
    assert.equal(await toast.locator('img').count(), 0, 'no element was parsed out of the name');
    assert.equal(await page.evaluate(() => window.__xss), undefined, 'nothing ran');
    assert.deepEqual(await ramotNames(page), [OTHER], 'the clobbered row is released again (the heal still works)');
    const evilOnSheet = backend.rows(g.PATIENTS_SHEET, g.PATIENT_COLUMNS).find((r) => r.id === 'id-evil');
    assert.equal(evilOnSheet.status, 'released', 'and persisted');
    assert.deepEqual(errors, [], 'no page errors');
    await ctx.close();
  } finally {
    await browser.close();
    server.close();
  }
});

test('THE BUG in Chromium: ✏️ released → פעיל, save, reload — still in the ramot tab', { skip: skip && why, timeout: 120000 }, async () => {
  const backend = loadBackend();
  const g = backend.gs;
  backend.seed(g.PATIENTS_SHEET, g.PATIENT_COLUMNS, [
    patientRow({ id: 'id-syn-0', name: OTHER, status: 'active', exitDate: '' }),
    patientRow(),
  ]);
  backend.seed(g.DISCHARGED_PATIENTS_SHEET, g.DISCHARGED_PATIENT_COLUMNS, [auditRow()]);
  const server = await boot(backend);
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  try {
    const { ctx, page, errors } = await openPage(browser, server.port);
    await load(page, server.port);
    assert.deepEqual(await ramotNames(page), [OTHER], 'released: hidden by default');

    await page.locator('#show-released-toggle').check();
    const row = page.locator('#patients-list .patient-row', { hasText: NAME });
    await row.locator('[data-action="edit"]').click();
    const form = page.locator('.modal form');
    await form.locator('select[name="status"]').selectOption('active');
    await form.locator('button[type="submit"]').click();
    // The modal closes once every write of the save has answered.
    await page.waitForSelector('.modal form', { state: 'detached', timeout: 10000 });
    await page.waitForLoadState('networkidle');

    // The reload — the load-time heal runs here.
    await load(page, server.port);
    assert.deepEqual((await ramotNames(page)).sort(), [NAME, OTHER].sort(), 'the re-activated patient is still in the house tab');
    assert.equal(await page.locator('#toast-banner').evaluate((el) => /רישום שחרור פתוח/.test(el.textContent)), false, 'nothing healed');
    const onSheet = backend.rows(g.PATIENTS_SHEET, g.PATIENT_COLUMNS).find((r) => r.id === 'id-syn-1');
    assert.equal(onSheet.status, 'active');
    assert.ok(server.actions.includes('restorePatientToActive'), 'the stay\'s discharge record was closed: ' + server.actions.join(','));
    const audit = backend.rows(g.DISCHARGED_PATIENTS_SHEET, g.DISCHARGED_PATIENT_COLUMNS)[0];
    assert.equal(audit.restored, 'TRUE', 'the discharge record is kept, flagged restored');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no sideways scroll');
    assert.deepEqual(errors, [], 'no page errors');
    await ctx.close();
  } finally {
    await browser.close();
    server.close();
  }
});
