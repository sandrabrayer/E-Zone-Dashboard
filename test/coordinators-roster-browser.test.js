/* Coordinators roster — the Dashboard side in REAL Chromium at 360px (the real
 * server.js, index.html, app.js and style.css; Apps Script stubbed).
 *
 *   - «🟢 קליטת מטופל חדש» is on the dashboard, top level, visible;
 *     it opens the intake form whose required fields are exactly name,
 *     house and admission date — plus, for a finance session (Vered), the
 *     «גורם מממן» picker every admission requires (PR #178); submitting
 *     saves a NEW active patient through saveAll (source direct_admin) — no
 *     status / pay required — and then appends the picked funder
 *   - «🚪 שחרורים מהבתים» lists ONLY the coordinators' discharges from the
 *     last 30 days (not the Dashboard's own, not older, not restored), with
 *     reason and reporter rendered as text
 *   - no sideways scroll, no page errors
 *
 * Set SHOT_DIR to also write coordinators-360-dashboard.png and
 * coordinators-360-intake.png.
 *
 * SKIPPED unless BOTH `playwright` resolves AND a Chromium binary is present. */

const { serverEcho } = require('./helpers/server-echo');
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
const { createSessionToken } = require('../lib/session');

const SERVER_PATH = require.resolve('../server');
const PEPPER = 'pepper-TEST-coord-browser-0123456789abcdef';
const SESSION_SECRET = 'session-secret-TEST-coord-browser-0123456789';
const ENV_KEYS = ['PROXY_SECRET', 'SESSION_SECRET', 'SHEETS_URL', 'USER_PIN_HASHES', 'PIN_PEPPER'];

const israelDay = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date(ms));
const daysAgo = (n) => israelDay(Date.now() - n * 86400000);

const COORD = { houseId: 'ramot', name: 'אורי רכז', date: '2026-08-01', exitDate: daysAgo(2), status: 'released',
  dischargedAt: new Date().toISOString(), id: 'coord-id-uri-' + daysAgo(2), restored: '',
  dischargeSource: 'ezone-coordinators', dischargedBy: 'רכזת רמות', dischargeReason: '<b>סיים טיפול</b>', patientId: 'id-uri' };
const DATA = {
  ok: true,
  leads: [],
  patients: { arfoni: [{ houseId: 'arfoni', name: 'דנה כהן', date: daysAgo(40), pay: 30000, adv: 0, status: 'active', id: 'p1' }] },
  irrelevantLeads: [], removedLeads: [],
  dischargedPatients: [
    COORD,
    // The Dashboard's own discharge — not the coordinators' panel.
    { houseId: 'rehab', name: 'יוסי מזרחי', date: '2026-06-01', exitDate: daysAgo(3), dischargedAt: '2026-09-20T10:00:00Z', disposition: 'home', id: 'd-own' },
    // A coordinators discharge older than 30 days.
    Object.assign({}, COORD, { name: 'ישן מאוד', exitDate: daysAgo(45), id: 'coord-old' }),
    // A coordinators discharge Vered already restored.
    Object.assign({}, COORD, { name: 'הוחזר', id: 'coord-restored', restored: 'TRUE' }),
  ],
  billingOverrides: [], houseManagers: {}, managerPhones: {}, currentManagers: [], currentManagersSource: 'x',
};

async function boot() {
  const hash = await pinHash.hashPin('583920', PEPPER);
  const recs = ['vered', 'sandra'].map((id) => JSON.parse(users.recordLine(id, hash, 1)));
  const env = {
    PROXY_SECRET: 'proxy-secret-TEST-coord-browser-0123456789', SESSION_SECRET,
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
  const bodies = [];
  const original = https.request;
  https.request = (url, opts, cb) => {
    const req = new EventEmitter();
    let body = '';
    req.write = (c) => { body += c; };
    req.end = () => {
      let parsed = {};
      try { parsed = JSON.parse(body); } catch (_) { /* not JSON */ }
      bodies.push(parsed);
      const res = new EventEmitter();
      res.statusCode = 200; res.headers = {}; res.setEncoding = () => {}; res.resume = () => {};
      setImmediate(() => {
        cb(res);
        // serverEcho: answers like the real handler (the proof the page needs,
        // CHANGELOG-write-path-hardening.md).
        res.emit('data', JSON.stringify(parsed.action === 'getData' ? DATA : serverEcho(parsed, { ok: true, payments: [], credits: [] })));
        res.emit('end');
      });
    };
    return req;
  };
  const srv = await new Promise((resolve) => { const s = mod.app.listen(0, '127.0.0.1', () => resolve(s)); });
  return {
    port: srv.address().port,
    bodies,
    close() { srv.close(); https.request = original; Object.assign(console, quiet); },
  };
}

async function shot(target, name) {
  if (!process.env.SHOT_DIR) return;
  fs.mkdirSync(process.env.SHOT_DIR, { recursive: true });
  await target.screenshot({ path: path.join(process.env.SHOT_DIR, name) });
}

test('dashboard at 360px: the intake entry is top level and saves a new active patient; the coordinators-discharge panel lists only recent coordinator discharges', { skip: skip && why, timeout: 120000 }, async () => {
  const server = await boot();
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  try {
    const ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, deviceScaleFactor: 2, locale: 'he-IL', serviceWorkers: 'block' });
    const token = createSessionToken(SESSION_SECRET, undefined, undefined, users.modelById('vered').name, { id: 'vered', pinVersion: 1 });
    await ctx.addCookies([{ name: 'ezone_session', value: token, url: `http://127.0.0.1:${server.port}` }]);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e && e.message)));
    await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: 'networkidle' });
    await page.waitForSelector('#whoami', { state: 'visible', timeout: 15000 });

    // ---- the panel ----
    await page.waitForSelector('#coord-discharges .coord-discharge-row', { timeout: 10000 });
    assert.match(await page.locator('#coord-discharges .coord-discharges-title').textContent(), /🚪 שחרורים מהבתים/);
    const names = await page.locator('#coord-discharges .coord-discharge-row .p-name').allTextContents();
    assert.deepEqual(names, ['אורי רכז'], 'only the recent, non-restored coordinators discharge');
    assert.equal((await page.locator('#coord-discharges-count').textContent()).trim(), '1');
    const rowText = await page.locator('#coord-discharges .coord-discharge-row').textContent();
    assert.ok(rowText.includes('רמות השבים') && rowText.includes('רכזת רמות'), rowText);
    assert.ok(rowText.includes('<b>סיים טיפול</b>'), 'reason rendered as TEXT, never HTML');
    assert.equal(await page.locator('#coord-discharges b').count(), 0);

    // ---- the intake entry ----
    const btn = page.locator('#intake-patient-btn');
    assert.equal(await btn.isVisible(), true, 'visible on the dashboard without scrolling to a tab');
    assert.equal((await btn.textContent()).trim(), '🟢 קליטת מטופל חדש');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no sideways scroll');
    await shot(page, 'coordinators-360-dashboard.png');

    await btn.click();
    await page.waitForSelector('#modal-root .modal form', { state: 'visible', timeout: 5000 }).catch(async (e) => {
      throw new Error(e.message + ' | errors: ' + errors.join(' ; ') + ' | root: ' + (await page.locator('#modal-root').innerHTML()).slice(0, 300));
    });
    assert.equal((await page.locator('#modal-root .modal h3').textContent()).trim(), 'קליטת מטופל חדש');
    // showModal marks a required field with « *» on its label.
    const required = await page.locator('#modal-root .form-row').evaluateAll((rows) => rows
      .filter((r) => /\*\s*$/.test(r.querySelector('label').textContent))
      .map((r) => r.querySelector('[name]').getAttribute('name')).sort());
    assert.deepEqual(required, ['date', 'funder', 'houseId', 'name'],
      'name, house, admission date — and the funder, required at every admission for a finance session');
    assert.equal(await page.locator('form [name="status"]').count(), 0, 'a new inpatient is always active');
    await page.fill('form [name="name"]', 'נועה חדשה');
    await page.selectOption('form [name="houseId"]', 'pardes');
    await page.fill('form [name="date"]', daysAgo(0));
    await page.fill('form [name="pay"]', '');
    const funder = await page.locator('form [name="funder"] option').evaluateAll((os) => os.map((o) => o.value).find((v) => v));
    assert.ok(funder, 'the funder picker offers labels');
    await page.selectOption('form [name="funder"]', funder);
    await shot(page, 'coordinators-360-intake.png');
    await page.locator('form button[type="submit"]').click();

    await page.waitForFunction(() => !document.querySelector('form [name="name"]'), null, { timeout: 10000 });
    const save = server.bodies.filter((b) => b.action === 'saveAll').pop();
    assert.ok(save, 'saveAll was sent');
    const patients = typeof save.patients === 'string' ? JSON.parse(save.patients) : save.patients;
    const flat = Object.values(patients).flat();
    const added = flat.find((p) => p.name === 'נועה חדשה');
    assert.ok(added, 'the new patient is in the save');
    assert.equal(added.houseId, 'pardes');
    assert.equal(added.date, daysAgo(0));
    assert.equal(added.status, 'active');
    assert.equal(added.source, 'direct_admin');
    assert.equal(added.pay, 0, 'optional monthly amount left blank → 0');
    assert.ok(added.id, 'carries a client id');
    // The funder lands after the save, from the admission date (PR #178 flow).
    for (let i = 0; i < 50 && !server.bodies.some((b) => b.action === 'appendFunder'); i++) await page.waitForTimeout(100);
    const fund = server.bodies.find((b) => b.action === 'appendFunder');
    assert.ok(fund, 'appendFunder was sent after the admission');
    assert.ok(JSON.stringify(fund).includes(funder) && JSON.stringify(fund).includes(daysAgo(0)), JSON.stringify(fund));
    assert.deepEqual(errors, [], 'no page errors');
    await ctx.close();
  } finally {
    await browser.close();
    server.close();
  }
});
