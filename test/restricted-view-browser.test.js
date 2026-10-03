/* Restricted view in REAL Chromium at 360px — the real server.js, index.html,
 * app.js and style.css; Apps Script stubbed.
 *
 *   Shiran (no `finance`): opened on a deep link to #billing →
 *     - exactly 7 tabs, the four money tabs and their screens are NOT in the
 *       DOM, no [data-finance] node at all, body.view-restricted from the first
 *       byte the server sent;
 *     - the deep link fell back to the dashboard;
 *     - no renewal / overdue widget on the dashboard, no «זיכויים» button on
 *       מטופלים משוחררים (its «שחזר» is still there);
 *     - the page never asked for getPayments / getCredits.
 *   Vered and a shared session (dual window): all 11 tabs; #billing opens גבייה.
 *
 * Set SHOT_DIR to also write restricted-360-dashboard.png and
 * restricted-360-discharged.png.
 *
 * SKIPPED unless BOTH `playwright` resolves AND a Chromium binary is present:
 *     PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --no-save playwright */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
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
const { israelDay } = require('../lib/shared-pin-window');
const { createSessionToken } = require('../lib/session');

const SERVER_PATH = require.resolve('../server');
const PEPPER = 'pepper-TEST-restricted-browser-0123456789abcdef';
const SESSION_SECRET = 'session-secret-TEST-restricted-browser-0123456789';
const ENV_KEYS = ['PROXY_SECRET', 'SESSION_SECRET', 'SHEETS_URL', 'APP_PIN', 'USER_PIN_HASHES', 'PIN_PEPPER', 'APP_PIN_UNTIL'];
const ALL_TABS = ['dashboard', 'leads', 'meetings', 'occupancy', 'discharged-patients', 'billing', 'revenue', 'reconnect', 'breakeven', 'growth', 'retention'];
const RESTRICTED_TABS = ['dashboard', 'leads', 'meetings', 'occupancy', 'discharged-patients', 'breakeven', 'retention'];

/* Today-relative data, so the dashboard renewal / overdue widgets WOULD show
 * for a full-view session: a patient who entered on today's day of the month
 * last month is due today and unpaid. */
const TODAY = israelDay(Date.now());
const ENTRY = (() => { const [y, m, d] = TODAY.split('-').map(Number); const pm = m === 1 ? 12 : m - 1; const py = m === 1 ? y - 1 : y; return `${py}-${String(pm).padStart(2, '0')}-${String(Math.min(d, 28)).padStart(2, '0')}`; })();
const DATA = {
  ok: true,
  leads: [{ id: 'L1', name: 'מיכל לוי', phone: '050-1111111', house: 'קיסריה עפרוני', stage: 'new', created: TODAY }],
  patients: { arfoni: [{ houseId: 'arfoni', name: 'דנה כהן', date: ENTRY, pay: 30000, adv: 0, status: 'active', id: 'p1' }] },
  irrelevantLeads: [], removedLeads: [],
  dischargedPatients: [{ houseId: 'rehab', name: 'יוסי מזרחי', date: '2026-06-01', exitDate: '2026-09-20', dischargedAt: '2026-09-20T10:00:00Z', disposition: 'home', pay: 28000 }],
  billingOverrides: [], houseManagers: {}, managerPhones: {}, currentManagers: [], currentManagersSource: 'x',
};

async function boot() {
  const hash = await pinHash.hashPin('583920', PEPPER);
  const recs = ['vered', 'sandra', 'shiran', 'yael'].map((id) => JSON.parse(users.recordLine(id, hash, 1)));
  const env = {
    PROXY_SECRET: 'proxy-secret-TEST-restricted-browser-0123456789', SESSION_SECRET,
    SHEETS_URL: 'https://script.google.com/macros/s/TEST/exec', APP_PIN: '4711', PIN_PEPPER: PEPPER,
    APP_PIN_UNTIL: israelDay(Date.now() + 7 * 864e5), USER_PIN_HASHES: JSON.stringify(recs),
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
      const action = (() => { try { return JSON.parse(body).action; } catch (_) { return ''; } })();
      actions.push(action);
      const res = new EventEmitter();
      res.statusCode = 200; res.headers = {}; res.setEncoding = () => {}; res.resume = () => {};
      setImmediate(() => {
        cb(res);
        res.emit('data', JSON.stringify(action === 'getData' ? DATA : { ok: true, payments: [], credits: [] }));
        res.emit('end');
      });
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
  if (!id) return createSessionToken(SESSION_SECRET, undefined, undefined, 'ורד'); // shared (dual window)
  return createSessionToken(SESSION_SECRET, undefined, undefined, users.modelById(id).name, { id, pinVersion: 1 });
}

async function open(browser, port, id, hash) {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, deviceScaleFactor: 2, locale: 'he-IL', serviceWorkers: 'block' });
  await ctx.addCookies([{ name: 'ezone_session', value: tokenFor(id), url: `http://127.0.0.1:${port}` }]);
  const page = await ctx.newPage();
  const errors = [];
  const sheetActions = [];
  page.on('pageerror', (e) => errors.push(String(e && e.message)));
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.pathname === '/api/sheets') sheetActions.push(u.searchParams.get('action') || (() => { try { return JSON.parse(r.postData() || '{}').action; } catch (_) { return ''; } })());
  });
  await page.goto(`http://127.0.0.1:${port}/${hash || ''}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#whoami', { state: 'visible', timeout: 15000 });
  return { ctx, page, errors, sheetActions };
}

async function shot(target, name) {
  if (!process.env.SHOT_DIR) return;
  fs.mkdirSync(process.env.SHOT_DIR, { recursive: true });
  await target.screenshot({ path: path.join(process.env.SHOT_DIR, name) });
}

const tabs = (page) => page.locator('.tabs .tab').evaluateAll((bs) => bs.map((b) => b.dataset.screen));

test('restricted view at 360px: Shiran gets 7 tabs, no money tab in the DOM, the #billing deep link falls back, no billing widget; Vered / shared keep all 11', { skip: skip && why, timeout: 120000 }, async () => {
  const server = await boot();
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  try {
    // ---- Shiran, arriving on a deep link to גבייה ----
    const s = await open(browser, server.port, 'shiran', '#billing');
    const page = s.page;
    assert.deepEqual(await tabs(page), RESTRICTED_TABS, 'exactly the allowed tabs');
    assert.equal(await page.locator('[data-finance]').count(), 0, 'no money tab, screen or widget in the DOM');
    for (const scr of ['billing', 'revenue', 'reconnect', 'growth']) {
      assert.equal(await page.locator('#screen-' + scr).count(), 0, scr);
    }
    assert.equal(await page.evaluate(() => document.body.className), 'view-restricted');
    assert.equal(await page.locator('.tabs .tab.active').getAttribute('data-screen'), 'dashboard', 'the deep link fell back');
    assert.equal(await page.locator('#screen-dashboard').isVisible(), true);
    assert.equal(await page.locator('#renewal-alert, #overdue-alert').count(), 0, 'no dashboard billing widget');
    assert.match(await page.locator('#whoami').textContent(), /שירן/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no sideways scroll');
    await shot(page, 'restricted-360-dashboard.png');

    // מטופלים משוחררים: visible, «שחזר» kept, no «זיכויים».
    await page.locator('.tabs .tab[data-screen="discharged-patients"]').click();
    await page.waitForSelector('#screen-discharged-patients', { state: 'visible' });
    await page.waitForSelector('#discharged-patients-list button', { state: 'visible', timeout: 10000 });
    const buttons = (await page.locator('#discharged-patients-list button').allTextContents()).map((t) => t.trim());
    assert.ok(buttons.includes('שחזר'), buttons.join('|'));
    assert.ok(!buttons.some((t) => t.startsWith('זיכויים')), 'no credits button: ' + buttons.join('|'));
    await shot(page, 'restricted-360-discharged.png');

    assert.ok(!s.sheetActions.some((a) => a === 'getPayments' || a === 'getCredits'), 'never asked: ' + s.sheetActions.join(','));
    assert.ok(s.sheetActions.includes('getData'));
    assert.deepEqual(s.errors, [], 'no page errors');
    // The server refuses the data even if the page is bypassed.
    const direct = await page.evaluate(async () => { const r = await fetch('/api/sheets?action=getPayments'); return [r.status, await r.json()]; });
    assert.deepEqual(direct, [403, { ok: false, error: 'forbidden', message: 'אין הרשאה לצפות בנתוני גבייה' }]);
    await s.ctx.close();

    // ---- Vered and a shared session: unchanged, all 11 tabs ----
    for (const id of ['vered', '']) {
      const f = await open(browser, server.port, id, '#billing');
      assert.deepEqual(await tabs(f.page), ALL_TABS, id || 'shared');
      assert.equal(await f.page.evaluate(() => document.body.className), '');
      assert.equal(await f.page.locator('.tabs .tab.active').getAttribute('data-screen'), 'billing', 'the deep link opens גבייה');
      assert.equal(await f.page.locator('#screen-billing').isVisible(), true);
      assert.ok(f.sheetActions.includes('getPayments') && f.sheetActions.includes('getCredits'));
      // The same data DOES raise the dashboard billing widget for full view —
      // so its absence for Shiran above is the restriction, not empty data.
      assert.equal(await f.page.locator('#overdue-alert:not(.hidden)').count(), 1, 'overdue strip present for ' + (id || 'shared'));
      assert.deepEqual(f.errors, [], 'no page errors');
      await f.ctx.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
});
