'use strict';
// PW-04/05/06: synthetic Chromium click -> audit commits -> Patients save fails
// -> reload from source -> durable derived exception -> no blind repeat.
// No real Sheets, no production URLs, no patient data.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const pinHash = require('../lib/pin-hash');
const users = require('../lib/users');
const { createSessionToken } = require('../lib/session');

let playwright;
try { playwright = require('playwright'); } catch (_) { /* normal unit CI skips browser */ }
const browserCandidates = [
  process.env.CHROMIUM_PATH,
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/opt/pw-browsers/chromium/chrome-linux/chrome',
  '/usr/bin/chromium'
].filter(Boolean);
let chromiumPath = browserCandidates.find((p) => fs.existsSync(p));
if (!chromiumPath && playwright) {
  try { const p = playwright.chromium.executablePath(); if (fs.existsSync(p)) chromiumPath = p; } catch (_) { /* no browser */ }
}
const skip = !playwright || !chromiumPath;

const SERVER_PATH = require.resolve('../server');
const PEPPER = 'pepper-TEST-crm-partial-discharge-01234567';
const SECRET = 'session-secret-TEST-crm-partial-discharge';
const PROXY_SECRET = 'proxy-secret-TEST-crm-partial-discharge';
const ENV = ['PROXY_SECRET', 'SESSION_SECRET', 'SHEETS_URL', 'USER_PIN_HASHES', 'PIN_PEPPER', 'CRM_ENABLED'];
const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());

async function boot(mode) {
  const hash = await pinHash.hashPin('583920', PEPPER);
  const recs = ['vered', 'sandra'].map(id => JSON.parse(users.recordLine(id, hash, 1)));
  const variables = { PROXY_SECRET, SESSION_SECRET: SECRET, SHEETS_URL: 'https://script.google.com/macros/s/SYNTHETIC/exec', PIN_PEPPER: PEPPER, USER_PIN_HASHES: JSON.stringify(recs), CRM_ENABLED: 'true' };
  const previous = {}, quiet = { log: console.log, warn: console.warn, error: console.error };
  for (const k of ENV) { previous[k] = process.env[k]; process.env[k] = variables[k]; }
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  delete require.cache[SERVER_PATH];
  let mod;
  try { mod = require('../server'); }
  finally { for (const k of ENV) { if (previous[k] === undefined) delete process.env[k]; else process.env[k] = previous[k]; } }
  const DATA = {
    ok: true, leads: [], irrelevantLeads: [], removedLeads: [], dischargedPatients: [],
    billingOverrides: [], houseManagers: {}, managerPhones: {}, currentManagers: [], outpatientSentLeadIds: [],
    patients: { ramot: [{ id: 'P1', houseId: 'ramot', name: 'משתמש בדיקה', date: '2026-08-01', pay: 31000, adv: 0, status: 'active', fromLead: '' }] }
  };
  const posts = [], original = https.request;
  https.request = (url, opts, cb) => {
    const req = new EventEmitter();
    let body = '';
    req.write = (v) => { body += v; };
    req.end = () => {
      let payload = {};
      try { payload = JSON.parse(body); } catch (_) { /* return empty */ }
      posts.push(payload);
      let answer;
      if (payload.action === 'getData') answer = DATA;
      else if (payload.action === 'getTasks') answer = {ok:true,tasks:[],total:0};
      else if (payload.action === 'contactIndex') answer = {ok:true,leads:{},patients:{}};
      else if (payload.action === 'getActivity') answer = {ok:true,events:[]};
      else if (payload.action === 'debtAging') answer = {ok:true,byPatient:[]};
      else if (payload.action === 'getPayments') answer = {ok:true,payments:[],receipts:[],funders:[]};
      else if (payload.action === 'getCredits') answer = {ok:true,credits:[]};
      else if (payload.action === 'dischargePatient') {
        if (mode === 'duplicate') answer = {ok:true,duplicate:true,id:'old-audit-other-person',exitDate:day};
        else {
          DATA.dischargedPatients.push(payload.patient);
          answer = {ok:true,discharged:true,patient:payload.patient,refund:{created:0}};
        }
      }
      else if (payload.action === 'saveAll') answer = {ok:false,error:'synthetic_second_stage_rejected'};
      else answer = {ok:true};
      const res = new EventEmitter();
      res.statusCode = 200; res.headers = {}; res.setEncoding = () => {}; res.resume = () => {};
      setImmediate(() => { cb(res); res.emit('data', JSON.stringify(answer)); res.emit('end'); });
    };
    return req;
  };
  const server = await new Promise(resolve => {
    const s = mod.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return {port:server.address().port,posts,close() {server.close(); https.request=original;Object.assign(console,quiet);}};
}

async function loginPage(browser, port, principal = 'vered') {
  const ctx = await browser.newContext({viewport:{width:1024,height:850},locale:'he-IL',timezoneId:'Asia/Jerusalem',serviceWorkers:'block'});
  const token = createSessionToken(SECRET, undefined, undefined, users.modelById(principal).name, {id:principal,pinVersion:1});
  await ctx.addCookies([{name:'ezone_session',value:token,url:'http://127.0.0.1:'+port}]);
  const page = await ctx.newPage();
  await page.goto('http://127.0.0.1:'+port+'/?view=crm',{waitUntil:'networkidle'});
  await page.waitForSelector('#crm-nav button',{timeout:15000});
  return {ctx,page};
}

test('PW-04 Chromium: partial discharge remains visible after reload and cannot be blindly re-posted', {skip}, async () => {
  const srv = await boot();
  const browser = await playwright.chromium.launch({executablePath:chromiumPath});
  try {
    const {ctx,page} = await loginPage(browser,srv.port);
    await page.locator('[data-area="clients"]').click();
    await page.locator('[data-open-patient="P1"]').first().click();
    await page.waitForSelector('#crm-drawer [data-form="discharge"]', {state:'attached'});
    await page.locator('#crm-drawer details.act:has(form[data-form="discharge"]) summary').click();
    await page.locator('#crm-drawer form[data-form="discharge"] select[name="disposition"]').selectOption('completed');
    await page.locator('#crm-drawer form[data-form="discharge"] select[name="continuity"]').selectOption('none');
    await page.locator('#crm-drawer form[data-form="discharge"] button[type="submit"]').click();
    await page.waitForSelector('#crm-main .crm-state.bad',{timeout:10000});
    assert.match(await page.locator('#crm-main .crm-state.bad').innerText(),/רישום השחרור אושר/);
    assert.equal(srv.posts.filter(x => x.action === 'dischargePatient').length,1);
    assert.equal(srv.posts.filter(x => x.action === 'saveAll').length,1);
    await page.locator('#crm-retry').click();
    await page.locator('[data-area="today"]').click();
    await page.waitForSelector('[data-row^="ex:discharge-state:"]',{timeout:10000});
    assert.match(await page.locator('[data-row^="ex:discharge-state:"]').first().innerText(),/רישום שחרור קיים/);
    const second = await loginPage(browser,srv.port,'sandra');
    await second.page.waitForSelector('[data-row^="ex:discharge-state:"]',{timeout:10000});
    await second.ctx.close();
    await page.locator('[data-area="clients"]').click();
    await page.locator('[data-open-patient="P1"]').first().click();
    await page.waitForSelector('#crm-drawer [data-form="discharge"]', {state:'attached'});
    await page.locator('#crm-drawer details.act:has(form[data-form="discharge"]) summary').click();
    await page.locator('#crm-drawer form[data-form="discharge"] select[name="disposition"]').selectOption('completed');
    await page.locator('#crm-drawer form[data-form="discharge"] button[type="submit"]').click();
    await page.waitForSelector('#crm-toast.bad[data-show="true"]',{timeout:7000});
    assert.match(await page.locator('#crm-toast').innerText(),/כבר נרשם שחרור/);
    assert.equal(srv.posts.filter(x => x.action === 'dischargePatient').length,1,'no second audit/credit request');
    await ctx.close();
  } finally {await browser.close();srv.close();}
});

test('PW-05 Chromium: unverified duplicate audit never updates a possibly different Patients row', {skip}, async () => {
  const srv = await boot('duplicate');
  const browser = await playwright.chromium.launch({executablePath:chromiumPath});
  try {
    const {ctx,page} = await loginPage(browser,srv.port);
    await page.locator('[data-area="clients"]').click();
    await page.locator('[data-open-patient="P1"]').first().click();
    await page.waitForSelector('#crm-drawer [data-form="discharge"]',{state:'attached'});
    await page.locator('#crm-drawer details.act:has(form[data-form="discharge"]) summary').click();
    await page.locator('#crm-drawer form[data-form="discharge"] select[name="disposition"]').selectOption('completed');
    await page.locator('#crm-drawer form[data-form="discharge"] button[type="submit"]').click();
    await page.waitForSelector('#crm-main .crm-state.bad',{timeout:10000});
    assert.match(await page.locator('#crm-main .crm-state.bad').innerText(),/לא אומתה התאמתו למזהה המטופל/);
    assert.equal(srv.posts.filter(x => x.action === 'dischargePatient').length,1);
    assert.equal(srv.posts.filter(x => x.action === 'saveAll').length,0,'no secondary Patients update on an unverified duplicate');
    await ctx.close();
  } finally {await browser.close();srv.close();}
});
