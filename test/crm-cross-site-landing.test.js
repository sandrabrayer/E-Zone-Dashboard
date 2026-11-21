'use strict';

/* A link from OUTSIDE the site must not strand a CRM user on the classic page
 * (CHANGELOG-crm-cross-site-landing.md).
 *
 * The session cookie is SameSite=Strict, so a browser withholds it on a
 * navigation that starts on another site — the daily reminder mail, WhatsApp,
 * a search result. The server then sees no session and answers `/` with the
 * classic page; that page's own same-origin requests DO carry the cookie, so it
 * used to open the classic dashboard for a signed-in CRM user.
 *
 *   - pure: crmBounceTarget (app.js) — when the classic page hands over to the CRM;
 *   - source pins: the startup check runs it before the role view is applied;
 *   - real Chromium, real server.js: a cross-site link (localhost → 127.0.0.1)
 *     with a Strict cookie ends on the CRM; `?view=classic` stays classic; a
 *     classic-landing server is never bounced; no reload loop. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const https = require('node:https');
const { EventEmitter } = require('node:events');

const APP_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const SERVER_SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const CRM_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'crm', 'crm.js'), 'utf8');

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

/* ---------------- pure ---------------- */

function bounceFns() {
  const pick = (name) => { const m = new RegExp('function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}').exec(APP_SRC); assert.ok(m, name + ' is in app.js'); return m[0]; };
  const win = /const CRM_BOUNCE_WINDOW_MS = \d+;/.exec(APP_SRC);
  assert.ok(win, 'the loop-guard window is a named constant');
  const ctx = { URLSearchParams };
  vm.runInNewContext(win[0] + pick('loginShouldReload') + pick('crmBounceTarget') + '; this.f = crmBounceTarget; this.W = CRM_BOUNCE_WINDOW_MS;', ctx);
  return ctx;
}

test('crmBounceTarget: a signed-in CRM-landing session on the classic page goes to `/` (or `/?view=crm` when asked); `?view=classic`, a classic-landing session, no session and a bounce that just happened all stay', () => {
  const { f, W } = bounceFns();
  const NOW = 1_800_000_000_000;
  const crm = { user: 'סנדרה', landing: 'crm' };
  assert.equal(f(crm, '', 0, NOW), '/');
  assert.equal(f(crm, '?x=1', 0, NOW), '/');
  assert.equal(f(crm, '?view=crm', 0, NOW), '/?view=crm');
  assert.equal(f({ user: 'אורטל', landing: 'classic' }, '?view=crm', 0, NOW), '/?view=crm', 'an explicit ask for the CRM is honoured like after a login');
  assert.equal(f(crm, '?view=classic', 0, NOW), '', 'an explicit classic visit stays classic');
  assert.equal(f({ user: 'אורטל', landing: 'classic' }, '', 0, NOW), '', 'a classic-landing session is never moved');
  for (const none of [null, undefined, {}, { landing: 'crm' }, { user: '', landing: 'crm' }]) assert.equal(f(none, '', 0, NOW), '', 'no signed-in user → the PIN flow owns it');
  // never a loop: one bounce per window
  assert.equal(f(crm, '', NOW - 1000, NOW), '', 'bounced a second ago and still on the classic page → stay');
  assert.equal(f(crm, '', NOW - W + 1, NOW), '');
  assert.equal(f(crm, '', NOW - W - 1, NOW), '/', 'an old bounce no longer blocks');
  assert.equal(f(crm, '', NOW + 5000, NOW), '/', 'a timestamp from the future (clock change) does not block');
  for (const junk of ['abc', NaN, -1, {}]) assert.equal(f(crm, '', junk, NOW), '/', 'a corrupt stored value does not block');
  assert.ok(W >= 10000 && W <= 120000);
});

test('the classic page checks at startup, before it applies the role view; the target is a fixed same-origin path (never built from the URL); the cookie stays SameSite=Strict', () => {
  const check = APP_SRC.slice(APP_SRC.indexOf('async function checkSessionUser()'), APP_SRC.indexOf('function initPin()'));
  assert.ok(check.indexOf('if (bounceToCrm(info)) return;') > 0, 'the startup check hands over');
  assert.ok(check.indexOf('if (bounceToCrm(info)) return;') < check.indexOf('applySessionInfo(info);'), '…before the classic view is applied');
  const bounce = APP_SRC.slice(APP_SRC.indexOf('function bounceToCrm(info)'), APP_SRC.indexOf('async function checkSessionUser()'));
  assert.match(bounce, /location\.replace\(target\);/, 'replace (a same-site navigation that carries the Strict cookie; no extra history entry)');
  assert.match(bounce, /sessionStorage\.setItem\(CRM_BOUNCE_KEY, String\(now\)\)/, 'the loop guard is written before leaving');
  const target = /function crmBounceTarget\([^)]*\) \{[\s\S]*?\n\}/.exec(APP_SRC)[0];
  assert.match(target, /return view === 'crm' \? '\/\?view=crm' : '\/';/, 'only two literal targets');
  assert.ok(!/location\.(href|search|hash)\s*\+|\+\s*search/.test(target), 'nothing from the URL is concatenated into the target');
  // the marker stops only a bounce that did NOT reach the CRM: the CRM clears it on arrival (same key on both pages)
  const key = /const CRM_BOUNCE_KEY = '([^']+)';/;
  assert.equal(key.exec(APP_SRC)[1], key.exec(CRM_SRC)[1]);
  assert.match(CRM_SRC, /function boot\(win, doc\) \{[\s\S]{0,420}win\.sessionStorage\.removeItem\(CRM_BOUNCE_KEY\)/);
  assert.match(SERVER_SRC, /'SameSite=Strict'/, 'the session cookie is not weakened to fix this');
  assert.ok(!/SameSite=(Lax|None)/.test(SERVER_SRC));
});

/* ---------------- real Chromium + real server.js ---------------- */

const pinHash = require('../lib/pin-hash');
const users = require('../lib/users');
const { createSessionToken } = require('../lib/session');
const SERVER_PATH = require.resolve('../server');
const PEPPER = 'pepper-TEST-cross-site-landing-0123456789abcdef';
const SESSION_SECRET = 'session-secret-TEST-cross-site-landing-0123456';
const PROXY_SECRET = 'proxy-secret-TEST-cross-site-landing-012345678';
const ENV_KEYS = ['PROXY_SECRET', 'SESSION_SECRET', 'SHEETS_URL', 'USER_PIN_HASHES', 'PIN_PEPPER', 'CRM_ENABLED', 'CRM_DEFAULT', 'SHEETS_READ_CACHE_MS'];

async function boot(crmDefault) {
  const hash = await pinHash.hashPin('583920', PEPPER);
  const recs = ['vered', 'sandra'].map((id) => JSON.parse(users.recordLine(id, hash, 1)));
  const env = { PROXY_SECRET, SESSION_SECRET, SHEETS_URL: 'https://script.google.com/macros/s/TEST/exec', PIN_PEPPER: PEPPER, USER_PIN_HASHES: JSON.stringify(recs), CRM_ENABLED: 'true', CRM_DEFAULT: crmDefault ? 'true' : '', SHEETS_READ_CACHE_MS: '0' };
  const saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; process.env[k] = env[k]; }
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  delete require.cache[SERVER_PATH];
  let mod;
  try { mod = require('../server'); } finally { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
  const original = https.request;
  https.request = (url, opts, cb) => {   // Apps Script: every read answers empty-but-ok; nothing leaves the machine
    const req = new EventEmitter();
    req.write = () => {}; req.setTimeout = () => {}; req.destroy = () => {};
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = 200; res.headers = {}; res.setEncoding = () => {}; res.resume = () => {};
      setImmediate(() => { cb(res); res.emit('data', JSON.stringify({ ok: true, leads: [], patients: {}, discharged: [], closedLeads: [], tasks: [], events: [], payments: [], credits: [] })); res.emit('end'); });
    };
    return req;
  };
  const srv = await new Promise((resolve) => { const s = mod.app.listen(0, '127.0.0.1', () => resolve(s)); });
  const port = srv.address().port;
  // "Another site": the same machine under a different host name. localhost and 127.0.0.1 are
  // different SITES to a browser, exactly like a mail client and the dashboard.
  const outside = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>mail</title>'
        + `<a id="home" href="http://127.0.0.1:${port}/">home</a>`
        + `<a id="classic" href="http://127.0.0.1:${port}/?view=classic">classic</a>`
        + `<a id="crm" href="http://127.0.0.1:${port}/?view=crm">crm</a>`);
    });
    s.listen(0, 'localhost', () => resolve(s));
  });
  return { port, outsidePort: outside.address().port, close() { srv.close(); outside.close(); https.request = original; Object.assign(console, quiet); } };
}

async function session(browser, srv, id) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, locale: 'he-IL', timezoneId: 'Asia/Jerusalem', serviceWorkers: 'block' });
  // the real cookie's attributes (server.js buildSessionCookie): HttpOnly, SameSite=Strict, Path=/
  await ctx.addCookies([{ name: 'ezone_session', value: createSessionToken(SESSION_SECRET, undefined, undefined, users.modelById(id).name, { id, pinVersion: 1 }), domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Strict' }]);
  const page = await ctx.newPage();
  const docs = [];   // every top-level document the dashboard origin served: [url, sent a cookie?]
  page.on('request', (r) => { if (r.isNavigationRequest() && r.frame() === page.mainFrame() && r.url().indexOf(`127.0.0.1:${srv.port}`) > 0) docs.push(new URL(r.url()).pathname + new URL(r.url()).search); });
  return { ctx, page, docs };
}
const isCrm = (page) => page.evaluate(() => !!document.querySelector('#crm-nav'));
const isClassic = (page) => page.evaluate(() => !!document.querySelector('#app') && !document.querySelector('#crm-nav'));

test('a link from another site (the reminder mail, WhatsApp): the Strict cookie is withheld and the server answers the classic page — which now hands a signed-in CRM user over to the CRM, once', { skip: skip && 'playwright/chromium missing' }, async () => {
  const srv = await boot(true);
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  try {
    // control: opened directly (the home-screen icon, a typed address) → the CRM at once
    const direct = await session(browser, srv, 'sandra');
    await direct.page.goto(`http://127.0.0.1:${srv.port}/`, { waitUntil: 'domcontentloaded' });
    await direct.page.waitForSelector('#crm-nav', { timeout: 15000 });
    assert.deepEqual(direct.docs, ['/'], 'no bounce when the server could already see the session');
    await direct.ctx.close();

    // the bug: the same session, arriving through a link on another site
    const s = await session(browser, srv, 'sandra');
    await s.page.goto(`http://localhost:${srv.outsidePort}/`, { waitUntil: 'domcontentloaded' });
    await s.page.click('#home');
    await s.page.waitForSelector('#crm-nav', { timeout: 15000 });
    assert.equal(await isCrm(s.page), true, 'ends on the CRM, not the classic dashboard');
    assert.deepEqual(s.docs, ['/', '/'], 'the classic page was served first (no cookie on a cross-site navigation) and handed over exactly once');
    assert.equal(new URL(s.page.url()).pathname + new URL(s.page.url()).search, '/');
    assert.equal(await s.page.evaluate(() => sessionStorage.getItem('ezone:crm-bounce-at')), null, 'the CRM cleared the marker, so the next outside link is handed over too');
    // history: the classic page was REPLACED — «back» returns to where the link was, not to a page that bounces forward again
    await s.page.goBack({ waitUntil: 'domcontentloaded' });
    assert.equal(new URL(s.page.url()).host, `localhost:${srv.outsidePort}`);

    // an explicit «?view=classic» link stays on the classic page
    await s.page.click('#classic');
    await s.page.waitForSelector('#app', { timeout: 15000 });
    await s.page.waitForTimeout(1500);   // long enough for /api/me to have answered
    assert.equal(await isClassic(s.page), true);
    assert.equal(new URL(s.page.url()).search, '?view=classic');

    // an explicit «?view=crm» link keeps its query
    await s.page.goto(`http://localhost:${srv.outsidePort}/`, { waitUntil: 'domcontentloaded' });
    await s.page.click('#crm');
    await s.page.waitForSelector('#crm-nav', { timeout: 15000 });
    assert.equal(new URL(s.page.url()).search, '?view=crm');
    await s.ctx.close();
  } finally { await browser.close(); srv.close(); }
});

test('no loop and no surprise: where the server does NOT put anyone on the CRM (CRM_DEFAULT off) the classic page stays put; without a session the PIN screen is untouched', { skip: skip && 'playwright/chromium missing' }, async () => {
  const srv = await boot(false);
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  try {
    const s = await session(browser, srv, 'sandra');
    await s.page.goto(`http://localhost:${srv.outsidePort}/`, { waitUntil: 'domcontentloaded' });
    await s.page.click('#home');
    await s.page.waitForSelector('#app', { timeout: 15000 });
    await s.page.waitForTimeout(1500);
    assert.equal(await isClassic(s.page), true);
    assert.deepEqual(s.docs, ['/'], 'one document, no reload');
    await s.ctx.close();

    const anon = await browser.newContext({ serviceWorkers: 'block' });
    const page = await anon.newPage();
    const docs = [];
    page.on('request', (r) => { if (r.isNavigationRequest() && r.frame() === page.mainFrame()) docs.push(r.url()); });
    await page.goto(`http://127.0.0.1:${srv.port}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    assert.equal(docs.length, 1, 'a visitor with no session is never redirected');
    assert.equal(await page.evaluate(() => !!document.querySelector('#crm-nav')), false);
    await anon.close();
  } finally { await browser.close(); srv.close(); }
});
