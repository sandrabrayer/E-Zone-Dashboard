/* Personal-PIN login (PR B) in REAL Chromium at 360px — the real server.js,
 * the real index.html / app.js / style.css, Apps Script stubbed.
 *
 *   1. A 401 on load shows step 1: one big button per ACTIVE name (Ortal and
 *      a revoked user are not there), RTL, no horizontal scroll.
 *   2. Tap «סנדרה» → step 2: the 6-digit field; a wrong PIN shows «קוד שגוי».
 *   3. The right PIN enters the app; «קוד אישי חדש» is offered to Sandra and
 *      makes a record line.
 *   4. Logout → the login screen remembers «סנדרה» (straight to step 2).
 *   5. The shared link → APP_PIN → the name picker → the amber banner.
 *
 * Set SHOT_DIR to also write login-360-step1.png, login-360-step2.png,
 * login-360-shared-banner.png and login-360-new-code.png.
 *
 * SKIPPED unless BOTH `playwright` resolves AND a Chromium binary is present
 * (the gate every browser test here uses):
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
const { israelDay, untilDisplay } = require('../lib/shared-pin-window');

const SERVER_PATH = require.resolve('../server');
const PEPPER = 'pepper-TEST-browser-0123456789abcdef0123456789';
const APP_PIN = '4711';
const SANDRA_PIN = '402917';
const UNTIL = israelDay(Date.now() + 7 * 864e5);
const ENV_KEYS = ['PROXY_SECRET', 'SESSION_SECRET', 'SHEETS_URL', 'APP_PIN', 'USER_PIN_HASHES', 'PIN_PEPPER', 'APP_PIN_UNTIL'];

async function rec(id, pin, over) {
  const m = users.modelById(id);
  return Object.assign({ id, name: m.name, roles: m.roles.slice(), hash: await pinHash.hashPin(pin, PEPPER), pinVersion: 1, status: 'active' }, over || {});
}

/* Boot a fresh server.js with the test env; Apps Script answers a minimal
 * empty dataset for every action. */
async function boot() {
  const recs = [await rec('vered', '583920'), await rec('sandra', SANDRA_PIN), await rec('shiran', '719305'),
    await rec('yael', '264081', { status: 'revoked' })];
  const env = {
    PROXY_SECRET: 'proxy-secret-TEST-browser-0123456789abcdef', SESSION_SECRET: 'session-secret-TEST-browser-0123456789abcdef',
    SHEETS_URL: 'https://script.google.com/macros/s/TEST/exec', APP_PIN, PIN_PEPPER: PEPPER, APP_PIN_UNTIL: UNTIL,
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
  const original = https.request;
  https.request = (url, opts, cb) => {
    const req = new EventEmitter();
    req.write = () => {};
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = 200; res.headers = {}; res.setEncoding = () => {}; res.resume = () => {};
      setImmediate(() => {
        cb(res);
        res.emit('data', JSON.stringify({
          ok: true, leads: [], patients: {}, irrelevantLeads: [], removedLeads: [], dischargedPatients: [],
          billingOverrides: [], houseManagers: {}, managerPhones: {}, payments: [], credits: [], snapshots: [],
        }));
        res.emit('end');
      });
    };
    return req;
  };
  const srv = await new Promise((resolve) => { const s = mod.app.listen(0, '127.0.0.1', () => resolve(s)); });
  return {
    port: srv.address().port,
    close() { srv.close(); https.request = original; Object.assign(console, quiet); },
  };
}

async function shot(page, el, name) {
  if (!process.env.SHOT_DIR) return;
  fs.mkdirSync(process.env.SHOT_DIR, { recursive: true });
  await (el || page).screenshot({ path: path.join(process.env.SHOT_DIR, name) });
}

const visible = (page, sel) => page.locator(sel).isVisible();

test('personal-PIN login at 360px: step 1 names → step 2 PIN → app; remembered name; shared link + banner; «קוד אישי חדש»', { skip: skip && why, timeout: 120000 }, async () => {
  const server = await boot();
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  try {
    const ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, deviceScaleFactor: 2, locale: 'he-IL', serviceWorkers: 'block' });
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e && e.message)));
    const base = `http://127.0.0.1:${server.port}`;

    // ---- Step 1 ----
    await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#login-names button[data-user-id]', { state: 'visible', timeout: 15000 });
    const names = await page.locator('#login-names button').allTextContents();
    assert.deepEqual(names.map((s) => s.trim()), ['ורד', 'סנדרה', 'שירן'], 'active records only — no revoked Yael, no Ortal');
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.pin-box')).direction), 'rtl');
    for (const h of await page.locator('#login-names button').evaluateAll((bs) => bs.map((b) => b.getBoundingClientRect().height))) {
      assert.ok(h >= 48, 'big touch target: ' + h);
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no horizontal scroll at 360px');
    assert.equal(await visible(page, '#login-shared-link'), true, 'the shared link during the window');
    assert.equal(await visible(page, '#app'), false);
    await shot(page, null, 'login-360-step1.png');

    // ---- Step 2 ----
    await page.locator('#login-names button', { hasText: 'סנדרה' }).click();
    await page.waitForSelector('#login-step-pin', { state: 'visible' });
    assert.equal((await page.locator('#login-chosen-name').textContent()).trim(), 'סנדרה');
    const input = page.locator('#login-pin-input');
    assert.equal(await input.getAttribute('maxlength'), '6');
    assert.equal(await input.getAttribute('inputmode'), 'numeric');
    await input.fill('111222');
    await page.locator('#login-pin-submit').click();
    await page.waitForSelector('#login-error', { state: 'visible' });
    assert.equal((await page.locator('#login-error').textContent()).trim(), 'קוד שגוי');
    assert.equal(await input.inputValue(), '', 'the field is cleared after a wrong PIN');
    await input.fill(SANDRA_PIN);
    await shot(page, null, 'login-360-step2.png');
    await page.locator('#login-pin-submit').click();
    await page.waitForSelector('#app', { state: 'visible', timeout: 15000 });
    await page.waitForSelector('#whoami', { state: 'visible', timeout: 15000 });
    assert.match(await page.locator('#whoami').textContent(), /סנדרה/);
    assert.equal(await visible(page, '#shared-banner'), false, 'no banner on a personal session');
    assert.equal(await page.evaluate(() => localStorage.getItem('ezone.lastLoginUser')), 'sandra');
    assert.ok(!(await page.evaluate(() => JSON.stringify(localStorage))).includes(SANDRA_PIN), 'the PIN is never stored');

    // ---- «קוד אישי חדש» (Sandra) ----
    await page.waitForSelector('#pin-admin-open', { state: 'visible' });
    await page.locator('#pin-admin-open').click();
    await page.waitForSelector('#pin-admin-screen', { state: 'visible' });
    const opts = await page.locator('#pin-admin-user option').allTextContents();
    assert.ok(opts.includes('סנדרה — איפוס הקוד שלי') && opts.includes('ורד (איפוס)'), opts.join(' | '));
    await page.selectOption('#pin-admin-user', 'shiran');
    await page.fill('#pin-admin-pin', '123456');
    await page.fill('#pin-admin-pin2', '123456');
    await page.locator('#pin-admin-make').click();
    await page.waitForSelector('#pin-admin-error', { state: 'visible' });
    assert.match(await page.locator('#pin-admin-error').textContent(), /קוד חלש/);
    await page.fill('#pin-admin-pin', '730418');
    await page.fill('#pin-admin-pin2', '730418');
    await page.locator('#pin-admin-make').click();
    await page.waitForSelector('#pin-admin-result', { state: 'visible' });
    const line = JSON.parse(await page.locator('#pin-admin-line').inputValue());
    assert.deepEqual([line.id, line.pinVersion, line.status], ['shiran', 2, 'active']);
    assert.equal(await page.locator('#pin-admin-pin').inputValue(), '', 'PIN fields cleared');
    assert.equal(await page.locator('#pin-admin-steps li').count(), 5);
    await shot(page, page.locator('#pin-admin-screen .modal'), 'login-360-new-code.png');
    await page.locator('#pin-admin-close').click();

    // ---- Logout → remembered name ----
    await page.locator('#logout').click();
    await page.waitForSelector('#login-step-pin', { state: 'visible', timeout: 15000 });
    assert.equal((await page.locator('#login-chosen-name').textContent()).trim(), 'סנדרה', 'remembered on this device');
    await page.locator('#login-back').click();
    await page.waitForSelector('#login-step-name', { state: 'visible' });

    // ---- Shared PIN (dual window) → banner ----
    await page.locator('#login-shared-link').click();
    await page.waitForSelector('#login-step-shared', { state: 'visible' });
    assert.equal(await page.locator('#pin-input').getAttribute('maxlength'), '4');
    await page.fill('#pin-input', APP_PIN);
    await page.locator('#pin-submit').click();
    await page.waitForSelector('#user-screen', { state: 'visible', timeout: 15000 });
    await page.locator('#user-options button', { hasText: 'ורד' }).click();
    await page.waitForSelector('#shared-banner', { state: 'visible', timeout: 15000 });
    assert.equal((await page.locator('#shared-banner').textContent()).trim(),
      'נכנסת עם הקוד המשותף — עד ' + untilDisplay(UNTIL) + ' יש לעבור לקוד אישי');
    assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('shared-banner')).backgroundColor), 'rgb(255, 176, 32)');
    assert.equal(await visible(page, '#pin-admin-open'), false, 'no «קוד אישי חדש» on a shared session');
    assert.equal(await visible(page, '#error-banner'), false, 'no leftover «unauthorized» toast from the pre-login 401');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await shot(page, null, 'login-360-shared-banner.png');

    assert.deepEqual(pageErrors, [], 'no page errors');
  } finally {
    await browser.close();
    server.close();
  }
});
