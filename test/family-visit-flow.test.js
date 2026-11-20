'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const { personalCookie, personalToken, TEST_PEPPER, userPinHashes } = require('./helpers/personal-session');
const { serverEcho } = require('./helpers/server-echo');
const { preview, internationalPhone } = require('../lib/family-visit-preview');
const { draftText } = require('../public/family-visit');
const { israelToday } = require('../lib/discharge-alerts');

const secret = 'test-only-visit-preview-session-2026-long';
const houseConfig = JSON.stringify({ ramot: { address: 'רחוב הבדיקה 1, עיר הבדיקה', instructions: 'כניסה ב׳' } });
const future = israelToday(Date.now() + 2 * 86400000);
const initial = { id: 'L-visit-test', stage: 'visit', visitDate: future, visitTime: '12:15', house: 'ramot', meetingWith: 'אורן',
  name: 'מטופל בדיקה', phone: '0501111111', contactName: 'אשת קשר בדיקה', contactPhone: '0522222222', billingPhone: '0533333333',
  note: 'PRIVATE-NOTE', created: israelToday(), assignedTo: 'ורד' };

test('draft uses approved address and directions; no billing numbers or private note enter the family text', () => {
  const p = preview(initial, houseConfig, new Date());
  const text = draftText(p.visit);
  assert.ok(text.includes('12:15') && text.includes('כניסה ב׳'));
  assert.ok(text.includes(encodeURIComponent('רחוב הבדיקה 1, עיר הבדיקה')));
  assert.deepEqual(p.recipients.map(r => r.phone), ['972522222222', '972501111111']);
  for (const sensitive of [initial.note, initial.billingPhone, initial.name, initial.contactName]) assert.ok(!text.includes(sensitive));
  for (const config of ['{}', '{', 'null']) assert.equal(draftText(preview(initial, config, new Date()).visit), '');
  for (const change of [{ stage: 'admitted' }, { visitTime: '' }, { meetingOutcome: 'cancelled' }, { meetingReportOutcome: 'no_show' },
    { meetingWith: 'אמבולטורי' }, { house: 'unknown' }, { visitDate: '2026-02-30' }]) {
    assert.equal(preview({ ...initial, ...change }, houseConfig, new Date()), null);
  }
  assert.equal(preview({ ...initial, visitDate: '2026-08-02', visitTime: '00:01' }, houseConfig, new Date('2026-08-01T21:02:00Z')), null);
  assert.equal(internationalPhone('052222222'), '');
  assert.equal(internationalPhone('+972-52-2222222'), '972522222222');
});

async function setup(t) {
  const env = { SESSION_SECRET: secret, SHEETS_URL: 'https://script.google.com/macros/s/SYNTHETIC/exec',
    PROXY_SECRET: 'test-only-visit-proxy-2026-long', PIN_PEPPER: TEST_PEPPER, USER_PIN_HASHES: userPinHashes(['vered', 'ortal']),
    FAMILY_VISIT_DIRECTIONS_JSON: houseConfig, CRM_ENABLED: 'true', SHEETS_READ_CACHE_MS: '0' };
  const old = {};
  for (const [key, value] of Object.entries(env)) { old[key] = process.env[key]; process.env[key] = value; }
  t.after(() => { for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  delete require.cache[require.resolve('../server')];
  const { app } = require('../server');
  const db = { lead: { ...initial }, calls: [], refuseSave: false, sourceError: '' };
  t.mock.method(https, 'request', (url, opts, cb) => {
    const req = new EventEmitter();
    let raw = '';
    req.write = part => { raw += part; };
    req.end = () => {
      const b = JSON.parse(raw);
      db.calls.push(b.action);
      let result = { ok: true };
      if (b.action === 'getFamilyVisitSource') {
        result = db.sourceError ? { ok: false, error: db.sourceError } : { ok: true, lead: { ...db.lead } };
      } else if (b.action === 'getData') {
        result = { ok: true, leads: [db.lead], patients: {}, dischargedPatients: [], removedLeads: [], irrelevantLeads: [],
          billingOverrides: [], houseManagers: {}, managerPhones: {}, currentManagers: [], outpatientSentLeadIds: [] };
      } else if (b.action === 'saveAll') {
        if (db.refuseSave) result = { ok: false, error: 'test_refusal' };
        else {
          const lead = (b.leads || []).find(x => x.id === db.lead.id);
          if (lead) db.lead = Object.assign({}, db.lead, lead);
          result = serverEcho(b, result);
        }
      }
      const r = new EventEmitter();
      r.statusCode = 200; r.headers = {}; r.setEncoding = () => {}; r.resume = () => {};
      setImmediate(() => { cb(r); r.emit('data', JSON.stringify(result)); r.emit('end'); });
    };
    return req;
  });
  const srv = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => { srv.close(resolve); srv.closeAllConnections(); }));
  return { db, url: 'http://127.0.0.1:' + srv.address().port };
}

test('authenticated preview reads the specific source every time and refuses controller, raw browser action and inconsistent source', async t => {
  const { db, url } = await setup(t);
  const endpoint = url + '/api/family-visit/' + initial.id + '/preview';
  const request = (u, id) => fetch(u, { headers: id ? { cookie: personalCookie(secret, id) } : {} });
  assert.equal((await request(endpoint)).status, 401);
  assert.equal((await request(endpoint, 'ortal')).status, 403);
  assert.equal((await request(url + '/api/sheets?action=getFamilyVisitSource&leadId=' + initial.id, 'vered')).status, 403);
  assert.equal(db.calls.length, 0);
  const r = await request(endpoint, 'vered');
  assert.equal(r.status, 200); assert.match(r.headers.get('cache-control'), /no-store/);
  assert.equal((await r.json()).visit.time, '12:15');
  db.lead.visitTime = '12:30';
  assert.equal((await (await request(endpoint, 'vered')).json()).visit.time, '12:30');
  db.sourceError = 'ambiguous_visit';
  assert.equal((await request(endpoint, 'vered')).status, 409);
  db.sourceError = 'missing_visit';
  assert.equal((await request(endpoint, 'vered')).status, 404);
  db.sourceError = '';
  db.lead.id = 'other';
  assert.equal((await request(endpoint, 'vered')).status, 502);
});

let playwright;
try { playwright = require('playwright'); } catch (_) { /* CI runs browser cases in its browser workflow. */ }
const executablePath = [process.env.CHROMIUM_PATH, playwright && playwright.chromium.executablePath(), '/usr/bin/chromium'].find(p => p && fs.existsSync(p));

for (const width of [390, 1366]) {
  test('saved visit to family draft through the CRM, width ' + width, { skip: !playwright || !executablePath, timeout: 65000 }, async t => {
    const { db, url } = await setup(t);
    const browser = await playwright.chromium.launch({ executablePath });
    t.after(() => browser.close());
    const ctx = await browser.newContext({ viewport: { width, height: 880 }, isMobile: width < 500, hasTouch: width < 500,
      serviceWorkers: 'block', locale: 'he-IL', timezoneId: 'Asia/Jerusalem' });
    await ctx.addCookies([{ name: 'ezone_session', value: personalToken(secret, 'vered'), url }]);
    const page = await ctx.newPage();
    const external = [];
    await page.route('https://wa.me/**', route => { external.push(route.request().url()); return route.abort(); });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(url + '/?view=crm');
    if (width < 500) await page.locator('#crm-burger').click();
    await page.locator('#crm-nav [data-area="leads"]').click();
    await page.locator('[data-open-lead="' + initial.id + '"]').first().click();
    const form = page.locator('[data-form="meeting"]');
    await form.locator('..').locator('summary').first().click();
    await form.locator('[name="visitTime"]').fill('12:45');
    await form.locator('button[type="submit"]').click();
    const dlg = page.locator('#family-visit-preview');
    const body = dlg.locator('[data-text]');
    await body.waitFor({ timeout: 8000 }).catch(async err => {
      const state = await page.evaluate(() => ({ module: typeof window.FamilyVisit, status: document.querySelector('#crm-toast')?.textContent,
        detail: document.querySelector('#family-visit-preview')?.textContent }));
      throw new Error(JSON.stringify({ state, errors, calls: db.calls.slice(-7) }) + ' ' + err.message);
    });
    assert.match(await body.innerText(), /12:45/);
    assert.equal(await dlg.locator('[data-confirm]').isDisabled(), true);
    assert.equal(await dlg.locator('select').inputValue(), '');
    await dlg.locator('select').selectOption('contact');
    db.lead.contactPhone = '0544444444';
    await dlg.locator('[data-confirm]').click();
    await page.waitForFunction(() => document.querySelector('#family-visit-preview select').value === '');
    assert.deepEqual(external, []);
    assert.equal(await dlg.locator('[data-confirm]').isDisabled(), true);
    assert.ok(await dlg.evaluate(d => d.offsetWidth <= document.documentElement.clientWidth));
    await dlg.locator('select').selectOption('contact');
    await dlg.locator('[data-confirm]').click();
    await dlg.waitFor({ state: 'detached' });
    assert.equal(external.length, 1);
    assert.match(external[0], /^https:\/\/wa\.me\/972544444444\?text=/);
    assert.deepEqual(errors, []);
  });
}

test('desktop CRM and mobile meetings board share the saved visit; a refused edit cannot open a family draft',
  { skip: !playwright || !executablePath, timeout: 65000 }, async t => {
    const { db, url } = await setup(t);
    const browser = await playwright.chromium.launch({ executablePath });
    t.after(() => browser.close());
    async function device(width, view) {
      const ctx = await browser.newContext({ viewport: { width, height: 880 }, isMobile: width < 500, hasTouch: width < 500,
        serviceWorkers: 'block', locale: 'he-IL', timezoneId: 'Asia/Jerusalem' });
      await ctx.addCookies([{ name: 'ezone_session', value: personalToken(secret, 'vered'), url }]);
      const page = await ctx.newPage();
      page.setDefaultTimeout(6500);
      await page.goto(url + '/?view=' + view);
      return page;
    }
    async function openCrmForm(page) {
      await page.locator('#crm-nav [data-area="leads"]').click();
      await page.locator('[data-open-lead="' + initial.id + '"]').first().click();
      const form = page.locator('[data-form="meeting"]');
      await form.locator('..').locator('summary').first().click();
      return form;
    }
    const pc = await device(1366, 'crm');
    let form = await openCrmForm(pc);
    await form.locator('[name="visitTime"]').fill('12:45');
    await form.locator('button[type="submit"]').click();
    await pc.locator('#family-visit-preview [data-text]').waitFor();
    await pc.locator('#family-visit-preview form button').click();
    const phone = await device(390, 'classic');
    await phone.locator('[data-screen="leads"]').click();
    await phone.locator('[data-id="' + initial.id + '"] .lc-wa-invite').click();
    await phone.locator('#family-visit-preview [data-text]').waitFor();
    assert.match(await phone.locator('#family-visit-preview [data-text]').innerText(), /12:45/);
    await phone.locator('#family-visit-preview form button').click();
    await phone.locator('[data-screen="meetings"]').click();
    const board = phone.locator('#meetings-board');
    await board.locator('[data-mtg="today"]').waitFor();
    const edit = board.locator('[data-mtg-edit="' + initial.id + '"]');
    if (!await edit.count()) await board.locator('[data-mtg="next"]').click();
    await edit.click();
    const modal = phone.locator('#modal-root form').filter({ has: phone.locator('[name="visitTime"]') });
    await modal.locator('[name="visitTime"]').selectOption('13:30');
    assert.equal(await modal.locator('.mtg-update-wa').isDisabled(), true);
    db.refuseSave = true;
    const refused = phone.waitForResponse(r => r.url().includes('/api/sheets') && r.request().method() === 'POST');
    await modal.locator('button[type="submit"]').click();
    await refused;
    await phone.waitForFunction(() => !document.querySelector('#modal-root form button[type=submit]')?.disabled);
    assert.equal(await phone.locator('#family-visit-preview').count(), 0);
    assert.equal(db.lead.visitTime, '12:45');
    db.refuseSave = false;
    await modal.locator('button[type="submit"]').click();
    await phone.locator('#family-visit-preview [data-text]').waitFor();
    assert.match(await phone.locator('#family-visit-preview [data-text]').innerText(), /13:30/);
    await pc.reload();
    form = await openCrmForm(pc);
    await form.locator('..').locator('[data-family-visit]').click();
    await pc.locator('#family-visit-preview [data-text]').waitFor();
    assert.match(await pc.locator('#family-visit-preview [data-text]').innerText(), /13:30/);
  });
