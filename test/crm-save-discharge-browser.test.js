'use strict';

/* CRM-SAVE-01: real Express + real Chromium with a synthetic Apps Script stub.
 * Audit write commits; subsequent Patients status save is refused. The tested
 * browser must reread the authoritative state and must not create another audit.
 * No real patients, emails, credentials or production writes. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const pinHash = require('../lib/pin-hash');
const users = require('../lib/users');
const { createSessionToken } = require('../lib/session');

let playwright = null;
try { playwright = require('playwright'); } catch (_) {}
const chromiumPath = [
  process.env.CHROMIUM_PATH,
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/opt/pw-browsers/chromium/chrome-linux/chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
].filter(Boolean).find((p) => fs.existsSync(p)) || (
  playwright && fs.existsSync(playwright.chromium.executablePath())
    ? playwright.chromium.executablePath() : ''
);
const skip = !playwright || !chromiumPath;
const SERVER_PATH = require.resolve('../server');
const PEPPER = 'pepper-TEST-crm-save-discharge-0123456789';
const SECRET = 'session-secret-TEST-crm-save-discharge';
const PROXY = 'proxy-secret-TEST-crm-save-discharge-0123';
const ENV_KEYS = ['PROXY_SECRET', 'SESSION_SECRET', 'SHEETS_URL', 'USER_PIN_HASHES', 'PIN_PEPPER', 'CRM_ENABLED'];
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());

async function boot(mode) {
  const hash = await pinHash.hashPin('583920', PEPPER);
  const roster = ['vered', 'dana'].map((id) => JSON.parse(users.recordLine(id, hash, 1)));
  const env = { PROXY_SECRET: PROXY, SESSION_SECRET: SECRET, SHEETS_URL: 'https://script.google.com/macros/s/TEST/exec', PIN_PEPPER: PEPPER, USER_PIN_HASHES: JSON.stringify(roster), CRM_ENABLED: 'true' };
  const saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; process.env[k] = env[k]; }
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  delete require.cache[SERVER_PATH];
  let mod;
  try { mod = require('../server'); } finally {
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
  const base = {
    ok: true, irrelevantLeads: [], removedLeads: [], billingOverrides: [], houseManagers: {},
    managerPhones: {}, currentManagers: [], outpatientSentLeadIds: [],
    dischargedPatients: [], leads: [],
    patients: { ramot: [{
      id: 'p-synthetic', name: 'מטופל בדיקה', houseId: 'ramot',
      date: '2026-10-01', status: 'active', pay: 8500,
      fromLead: 'L-synthetic', notes: ''
    }] }
  };
  const posts = [];
  const old = https.request;
  https.request = (url, opts, cb) => {
    const req = new EventEmitter();
    let body = '';
    req.write = (part) => { body += part; };
    req.end = () => {
      let p = {};
      try { p = JSON.parse(body); } catch (_) {}
      posts.push(p);
      let answer;
      if (p.action === 'getData') {
        answer = JSON.parse(JSON.stringify(base)); // independent source read each time
      } else if (p.action === 'getTasks') {
        answer = { ok: true, total: 0, tasks: [] };
      } else if (p.action === 'getActivity') {
        answer = { ok: true, events: [] };
      } else if (p.action === 'contactIndex') {
        answer = { ok: true, leads: {}, patients: {} };
      } else if (p.action === 'getPayments') {
        answer = { ok: true, payments: [], receipts: [], funders: [] };
      } else if (p.action === 'getCredits') {
        answer = { ok: true, credits: [] };
      } else if (p.action === 'debtAging') {
        answer = { ok: true, byPatient: [], totals: {}, byHouse: [] };
      } else if (p.action === 'dischargePatient') {
        const d = typeof p.patient === 'string' ? JSON.parse(p.patient) : p.patient;
        if (mode === 'duplicate') {
          // Source dedup result exposes an audit ID, but not the stored
          // patientId. This must NEVER mutate another Patients row.
          answer = { ok: true, duplicate: true, id: 'd-older-same-stay-key', exitDate: today };
        } else {
          if (!base.dischargedPatients.find((x) => x.id === d.id)) base.dischargedPatients.push(d);
          answer = { ok: true, patient: { id: d.id } };
        }
      } else if (p.action === 'saveAll') {
        // Fault AFTER the discharge audit was durably recorded.
        answer = { ok: false, error: 'synthetic_status_refused' };
      } else {
        answer = { ok: true };
      }
      const res = new EventEmitter();
      res.statusCode = 200; res.headers = {}; res.setEncoding = () => {}; res.resume = () => {};
      setImmediate(() => { cb(res); res.emit('data', JSON.stringify(answer)); res.emit('end'); });
    };
    return req;
  };
  const server = await new Promise((resolve) => {
    const instance = mod.app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  return {
    port: server.address().port, base, posts,
    close() { server.close(); https.request = old; Object.assign(console, quiet); }
  };
}

async function login(browser, port, identity) {
  const ctx = await browser.newContext({
    viewport: { width: 1024, height: 800 },
    locale: 'he-IL', timezoneId: 'Asia/Jerusalem', serviceWorkers: 'block'
  });
  await ctx.addCookies([{
    name: 'ezone_session',
    value: createSessionToken(SECRET, undefined, undefined,
      users.modelById(identity).name, { id: identity, pinVersion: 1 }),
    url: 'http://127.0.0.1:' + port
  }]);
  const page = await ctx.newPage();
  await page.goto('http://127.0.0.1:' + port + '/?view=crm', { waitUntil: 'networkidle' });
  await page.waitForSelector('#crm-nav button', { timeout: 15000 });
  return { ctx, page };
}

test('P0 browser: committed audit + rejected status save => durable exception, source reread, no duplicate discharge, second authorized reader', { skip }, async () => {
  const srv = await boot();
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  try {
    const { ctx, page } = await login(browser, srv.port, 'vered');
    await page.click('[data-area="clients"]');
    await page.click('tr[data-open-patient="p-synthetic"] td.name');
    const f = '#crm-drawer form[data-form="discharge"]';
    await page.locator(f).locator('..').locator('summary').click();
    await page.selectOption(f + ' select[name="disposition"]', 'completed');
    await page.fill(f + ' input[name="dischargeDate"]', today);
    await page.click(f + ' button[type="submit"]');
    await page.waitForFunction(() => {
      const t = document.querySelector('#crm-toast');
      return t && t.classList.contains('bad') && /מצב השחרור לא אומת/.test(t.textContent);
    }, null, { timeout: 5000 });
    await page.waitForFunction(() =>
      document.querySelector('#crm-main') && document.querySelector('#crm-main').textContent.includes('מטופל בדיקה'),
      null, { timeout: 5000 });

    assert.equal(srv.base.dischargedPatients.length, 1, 'audit persisted at source');
    assert.equal(srv.base.patients.ramot[0].status, 'active', 'patient status did NOT save');
    assert.equal(srv.posts.filter((p) => p.action === 'dischargePatient').length, 1);
    assert.equal(srv.posts.filter((p) => p.action === 'saveAll').length, 1);

    await page.click('[data-area="today"]');
    await page.waitForSelector('[data-row^="ex:discharge-state:"]', { timeout: 5000 });
    assert.match(await page.textContent('[data-row^="ex:discharge-state:"]'), /רישום שחרור קיים/);

    // Trying to discharge from the still-active patient must not emit a new audit.
    await page.click('[data-area="clients"]');
    await page.click('tr[data-open-patient="p-synthetic"] td.name');
    await page.locator(f).locator('..').locator('summary').click();
    await page.selectOption(f + ' select[name="disposition"]', 'completed');
    await page.click(f + ' button[type="submit"]');
    await page.waitForFunction(() => {
      const t = document.querySelector('#crm-toast');
      return t && /קיים רישום שחרור קודם/.test(t.textContent);
    }, null, { timeout: 5000 });
    assert.equal(srv.posts.filter((p) => p.action === 'dischargePatient').length, 1, 'no second audit');
    await ctx.close();

    // Independent reader: a different authorized user sees the same unresolved exception.
    const other = await login(browser, srv.port, 'dana');
    await other.page.waitForSelector('[data-row^="ex:discharge-state:"]', { timeout: 5000 });
    assert.match(await other.page.textContent('[data-row^="ex:discharge-state:"]'), /בדיקת שלמות שחרור/);
    await other.ctx.close();
  } finally {
    await browser.close(); srv.close();
  }
});

test('P0 duplicate discharge response without stored patient ID cannot update Patients or trigger refund', { skip }, async () => {
  const srv = await boot('duplicate');
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  try {
    const { ctx, page } = await login(browser, srv.port, 'vered');
    await page.click('[data-area="clients"]');
    await page.click('tr[data-open-patient="p-synthetic"] td.name');
    const f = '#crm-drawer form[data-form="discharge"]';
    await page.locator(f).locator('..').locator('summary').click();
    await page.selectOption(f + ' select[name="disposition"]', 'completed');
    await page.fill(f + ' input[name="dischargeDate"]', today);
    await page.click(f + ' button[type="submit"]');
    await page.waitForFunction(() => {
      const t = document.querySelector('#crm-toast');
      return t && t.classList.contains('bad') && /מצב השחרור לא אומת/.test(t.textContent);
    }, null, { timeout: 5000 });
    assert.equal(srv.posts.filter((p) => p.action === 'dischargePatient').length, 1);
    assert.equal(srv.posts.filter((p) => p.action === 'saveAll').length, 0, 'unverified duplicate cannot change another Patients status');
    assert.equal(srv.base.patients.ramot[0].status, 'active');
    assert.equal(srv.base.dischargedPatients.length, 0, 'duplicate did not create a new audit');
    await ctx.close();
  } finally {
    await browser.close(); srv.close();
  }
});
