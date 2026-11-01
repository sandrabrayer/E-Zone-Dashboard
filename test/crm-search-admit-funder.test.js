'use strict';

/* CRM: top search from any area + spinner; a direct add admits the person's open
 * lead; «כבר בבית» on an open lead; the funder save's idempotency key
 * (CHANGELOG-crm-search-admit-funder.md). Names / phones are SYNTHETIC. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const core = require('../public/crm/crm.js');

const israelDay = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date(ms));
const TODAY = israelDay(Date.now());
const daysAgo = (n) => israelDay(Date.now() - n * 86400000);

/* ================= A. pure ================= */

const LEADS = [
  { id: 'L-matan', name: 'מתן כחלון', phone: '0521234567', house: 'קיסריה ריהאב', stage: 'paid' },
  { id: 'L-dup1', name: 'דור לוי', phone: '0501111111', house: 'רמות השבים', stage: 'new' },
  { id: 'L-dup2', name: 'דור לוי', phone: '0502222222', house: 'רמות השבים', stage: 'visit' },
  { id: 'L-closed', name: 'סגור סגור', phone: '0503333333', house: 'רמות השבים', stage: 'admitted' },
  { id: 'dl-p-matan', name: 'מתן כחלון', phone: '0521234567', house: 'קיסריה ריהאב', stage: 'admitted', source: 'direct_approach' },
];
const PATIENTS = [
  { id: 'p-matan', houseId: 'rehab', name: 'מתן  כחלון', date: daysAgo(5), status: 'active', fromLead: 'dl-p-matan' },
  { id: 'p-or', houseId: 'ramot', name: 'אור זיו', date: daysAgo(90), status: 'released', exitDate: daysAgo(10), fromLead: '' },
];

test('A: openLeadOfPerson — by phone first, else by full name; open stages only; two hits → ambiguous', () => {
  assert.equal(core.openLeadOfPerson(LEADS, 'מתן כחלון', '052-123-4567').id, 'L-matan');
  assert.equal(core.openLeadOfPerson(LEADS, 'מתן   כחלון', '').id, 'L-matan', 'by name when no phone');
  assert.equal(core.openLeadOfPerson(LEADS, 'מישהו אחר', '0521234567').id, 'L-matan', 'the phone decides');
  assert.equal(core.openLeadOfPerson(LEADS, 'דור לוי', ''), 'ambiguous');
  assert.equal(core.openLeadOfPerson(LEADS, 'דור לוי', '0502222222').id, 'L-dup2');
  assert.equal(core.openLeadOfPerson(LEADS, 'סגור סגור', ''), null, 'an admitted lead is not open');
  assert.equal(core.openLeadOfPerson(LEADS, 'מתן', ''), null, 'a single word never matches by name');
});

test('A: leadAlreadyInHouse — an open lead whose person is in a house (same full name, or same phone via the patient\'s own lead)', () => {
  assert.equal(core.leadAlreadyInHouse(LEADS[0], PATIENTS, LEADS).id, 'p-matan');
  const byPhone = Object.assign({}, LEADS[0], { name: 'מ. כחלון' });
  assert.equal(core.leadAlreadyInHouse(byPhone, PATIENTS, LEADS).id, 'p-matan');
  assert.equal(core.leadAlreadyInHouse(LEADS[3], PATIENTS, LEADS), null, 'closed lead: nothing to flag');
  assert.equal(core.leadAlreadyInHouse({ id: 'x', name: 'אור זיו', stage: 'new' }, PATIENTS, LEADS), null, 'a released patient is not in a house');
});

test('A: globalSearch — leads of every stage + patients of every status, by name / phone digits / house; in-house first', () => {
  const c = { leads: LEADS, patients: PATIENTS };
  const r = core.globalSearch(c, ' אור ');
  assert.deepEqual(r.patients.map((p) => p.id), ['p-or'], 'a released patient is found');
  const m = core.globalSearch(c, 'כחלון');
  assert.deepEqual(m.patients.map((p) => p.id), ['p-matan']);
  assert.deepEqual(m.leads.map((l) => l.id).sort(), ['L-matan', 'dl-p-matan']);
  assert.deepEqual(core.globalSearch(c, '4567').leads.map((l) => l.id).sort(), ['L-matan', 'dl-p-matan']);
  assert.deepEqual(core.globalSearch(c, '4567').patients.map((p) => p.id), ['p-matan'], 'phone via the patient\'s lead');
  assert.equal(core.globalSearch(c, '  '), null);
  assert.equal(core.globalSearch(c, 'אין כזה').total, 0);
});

test('A: source guards — the funder save sends the server\'s key shape (sub- + hex); search is debounced with a busy state', () => {
  const src = fs.readFileSync(require.resolve('../public/crm/crm.js'), 'utf8');
  assert.doesNotMatch(src, /submissionId: randomId\(\)/, 'randomId() has no "sub-" prefix → Code.gs refused it (bad_submission_id)');
  assert.match(src, /action: 'appendFunder', funder: \{[^}]*submissionId: newSubmissionId\(\)/);
  const gs = fs.readFileSync(require.resolve('../apps-script/Code.gs'), 'utf8');
  const re = new RegExp(/const SUBMISSION_ID_RE = (\/.*\/);/.exec(gs)[1].slice(1, -1));
  assert.ok(re.test(core.newSubmissionId ? core.newSubmissionId() : 'sub-' + 'a'.repeat(32)));
  assert.match(src, /setAttribute\('aria-busy', 'true'\)/);
  const html = fs.readFileSync(require.resolve('../public/crm/crm.html'), 'utf8');
  assert.match(html, /id="crm-search-go"/);
});

/* ================= B. browser ================= */

let playwright = null;
try { playwright = require('playwright'); } catch (_) { /* skip */ }
let chromiumPath = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium/chrome-linux/chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => { try { return fs.existsSync(p); } catch (_) { return false; } });
if (!chromiumPath && playwright) { try { const p = playwright.chromium.executablePath(); if (p && fs.existsSync(p)) chromiumPath = p; } catch (_) { /* none */ } }
const skip = !playwright || !chromiumPath;

const pinHash = require('../lib/pin-hash');
const users = require('../lib/users');
const { createSessionToken } = require('../lib/session');
const SERVER_PATH = require.resolve('../server');
const PEPPER = 'pepper-TEST-crm-search-admit-funder-0123456789';
const SESSION_SECRET = 'session-secret-TEST-crm-search-admit-funder';
const PROXY_SECRET = 'proxy-secret-TEST-crm-search-admit-funder-012';
const ENV_KEYS = ['PROXY_SECRET', 'SESSION_SECRET', 'SHEETS_URL', 'USER_PIN_HASHES', 'PIN_PEPPER', 'CRM_ENABLED'];

function data() {
  return {
    ok: true, irrelevantLeads: [], removedLeads: [], billingOverrides: [], houseManagers: {}, managerPhones: {}, currentManagers: [], outpatientSentLeadIds: [],
    dischargedPatients: [{ id: 'dx-or', name: 'אור זיו', houseId: 'ramot', date: daysAgo(90), exitDate: daysAgo(10), dischargedAt: daysAgo(10) + 'T09:00:00.000Z', disposition: 'released_outpatient', restored: '' }],
    leads: [
      { id: 'L-matan', name: 'מתן כחלון', phone: '0521234567', house: 'קיסריה ריהאב', stage: 'paid', created: daysAgo(20), assignedTo: 'ורד' },
      { id: 'L-noa', name: 'נועה ברק', phone: '0547654321', house: 'רמות השבים', stage: 'paid', created: daysAgo(9), assignedTo: 'ורד' },
    ],
    patients: {
      rehab: [{ id: 'p-matan', name: 'מתן כחלון', date: daysAgo(5), status: 'active', fromLead: 'dl-p-matan' }],
      ramot: [{ id: 'p-or', name: 'אור זיו', date: daysAgo(90), status: 'released', exitDate: daysAgo(10) }],
    },
  };
}

async function boot() {
  const posts = [];
  const hash = await pinHash.hashPin('583920', PEPPER);
  const recs = ['vered'].map((id) => JSON.parse(users.recordLine(id, hash, 1)));
  const env = { PROXY_SECRET, SESSION_SECRET, SHEETS_URL: 'https://script.google.com/macros/s/TEST/exec', PIN_PEPPER: PEPPER, USER_PIN_HASHES: JSON.stringify(recs), CRM_ENABLED: 'true' };
  const saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; process.env[k] = env[k]; }
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  delete require.cache[SERVER_PATH];
  let mod;
  try { mod = require('../server'); } finally { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
  const original = https.request;
  const DATA = data();
  const SUB = /^sub-[A-Za-z0-9-]{8,64}$/;
  https.request = (url, opts, cb) => {
    const req = new EventEmitter();
    let body = '';
    req.write = (c) => { body += c; };
    req.end = () => {
      let parsed = {};
      try { parsed = JSON.parse(body); } catch (_) { parsed = {}; }
      posts.push(parsed);
      let f = parsed.funder;
      if (typeof f === 'string') { try { f = JSON.parse(f); } catch (_) { f = {}; } }
      const answer = parsed.action === 'getData' ? DATA
        : parsed.action === 'getTasks' ? { ok: true, total: 0, tasks: [] }
        : parsed.action === 'contactIndex' ? { ok: true, count: 0, leads: {}, patients: {} }
        : parsed.action === 'getActivity' ? { ok: true, events: [] }
        : parsed.action === 'debtAging' ? { ok: true, byPatient: [], totals: {}, byHouse: [] }
        : parsed.action === 'getPayments' ? { ok: true, payments: [], receipts: [], funders: [] }
        : parsed.action === 'getCredits' ? { ok: true, credits: [] }
        // the REAL rule of Code.gs appendFunder_: a key not shaped sub-… is refused
        : parsed.action === 'appendFunder' ? (f && SUB.test(String(f.submissionId)) ? { ok: true, row: { submissionId: f.submissionId } } : { ok: false, error: 'bad_submission_id' })
        : parsed.action === 'saveAll' ? { ok: true, proven: { leads: (parsed.leads || []).map((l) => String(l.id)), patients: Object.values(parsed.patients || {}).flat().map((p) => String(p.id)) } }
        : { ok: true };
      const res = new EventEmitter();
      res.statusCode = 200; res.headers = {}; res.setEncoding = () => {}; res.resume = () => {};
      setImmediate(() => { cb(res); res.emit('data', JSON.stringify(answer)); res.emit('end'); });
    };
    return req;
  };
  const srv = await new Promise((resolve) => { const s = mod.app.listen(0, '127.0.0.1', () => resolve(s)); });
  return { port: srv.address().port, posts, close() { srv.close(); https.request = original; Object.assign(console, quiet); } };
}

async function openPage(browser, port, width) {
  const ctx = await browser.newContext({ viewport: { width: width || 1280, height: 800 }, locale: 'he-IL', timezoneId: 'Asia/Jerusalem', serviceWorkers: 'block' });
  await ctx.addCookies([{ name: 'ezone_session', value: createSessionToken(SESSION_SECRET, undefined, undefined, users.modelById('vered').name, { id: 'vered', pinVersion: 1 }), url: `http://127.0.0.1:${port}` }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e && e.message)));
  await page.goto(`http://127.0.0.1:${port}/?view=crm`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#crm-nav button', { timeout: 15000 });
  return { ctx, page, errors };
}

test('B: search from «היום שלי» finds a RELEASED patient (not a jump to an empty «פניות»); the 🔍 shows a spinner; Enter works; clearing returns', { skip }, async () => {
  const srv = await boot();
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  try {
    const { ctx, page, errors } = await openPage(browser, srv.port);
    await page.fill('#crm-search', 'אור זיו');
    assert.equal(await page.getAttribute('#crm-search-go', 'aria-busy'), 'true', 'spinner while the search runs');
    await page.waitForSelector('#crm-search-patients tr[data-open-patient="p-or"]', { timeout: 3000 });
    assert.equal(await page.textContent('#crm-title'), 'חיפוש');
    assert.equal(await page.getAttribute('#crm-search-go', 'aria-busy'), null);
    await page.click('#crm-search-patients tr[data-open-patient="p-or"] td.name');
    await page.waitForFunction(() => document.querySelector('#crm-drawer').getAttribute('aria-hidden') === 'false');
    await page.click('#crm-drawer-close');
    await page.fill('#crm-search', '');
    await page.press('#crm-search', 'Enter');
    await page.waitForFunction(() => document.querySelector('#crm-title').textContent === 'היום שלי');
    // the 🔍 button searches at once
    await page.fill('#crm-search', '7654321');
    await page.click('#crm-search-go');
    await page.waitForSelector('#crm-search-leads tr[data-open-lead="L-noa"]', { timeout: 3000 });
    assert.deepEqual(errors, []);
    await ctx.close();
  } finally { await browser.close(); srv.close(); }
});

test('B: an open lead whose person is already in a house shows «כבר בבית» and closes as admitted with one lead save', { skip }, async () => {
  const srv = await boot();
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  try {
    const { ctx, page, errors } = await openPage(browser, srv.port);
    await page.click('[data-area="leads"]');
    await page.waitForSelector('.card[data-open-lead="L-matan"] .chip.late', { timeout: 3000 });
    await page.click('.card[data-open-lead="L-matan"]');
    await page.click('#crm-drawer [data-close-admitted="L-matan"]');
    await page.waitForFunction(() => !document.querySelector('.card[data-open-lead="L-matan"]'), null, { timeout: 3000 });
    const save = srv.posts.filter((p) => p.action === 'saveAll').pop();
    const leads = typeof save.leads === 'string' ? JSON.parse(save.leads) : save.leads;
    assert.equal(leads.length, 1);
    assert.equal(leads[0].id, 'L-matan');
    assert.equal(leads[0].stage, 'admitted');
    assert.equal(leads[0].entryDate, daysAgo(5));
    const pts = typeof save.patients === 'string' ? JSON.parse(save.patients) : save.patients;
    assert.deepEqual(pts, {}, 'no patient row touched');
    assert.deepEqual(errors, []);
    await ctx.close();
  } finally { await browser.close(); srv.close(); }
});

test('B: a direct add of a person with an open lead ADMITS that lead (no new «פנייה ישירה» lead), and the funder is saved', { skip }, async () => {
  const srv = await boot();
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  try {
    const { ctx, page, errors } = await openPage(browser, srv.port);
    await page.click('[data-area="clients"]');
    await page.click('#crm-direct-add');
    const f = '#crm-drawer form[data-form="direct-add"]';
    await page.fill(f + ' input[name="name"]', 'נועה ברק');
    await page.fill(f + ' input[name="phone"]', '054-765-4321');
    await page.selectOption(f + ' select[name="houseId"]', 'ramot');
    await page.fill(f + ' input[name="pay"]', '9000');
    await page.selectOption(f + ' select[name="funder"]', { index: 1 });
    await page.click(f + ' button[type="submit"]');
    await page.waitForFunction(() => /נשמר|נקלט/.test(document.body.textContent), null, { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(500);
    const save = srv.posts.filter((p) => p.action === 'saveAll').pop();
    const leads = typeof save.leads === 'string' ? JSON.parse(save.leads) : save.leads;
    assert.equal(leads.length, 1);
    assert.equal(leads[0].id, 'L-noa', 'the open lead, not a new dl- lead');
    assert.equal(leads[0].stage, 'admitted');
    const pts = typeof save.patients === 'string' ? JSON.parse(save.patients) : save.patients;
    assert.equal(pts.ramot.filter((p) => p.fromLead === 'L-noa').length, 1);
    const fund = srv.posts.filter((p) => p.action === 'appendFunder');
    assert.equal(fund.length, 1);
    const fb = typeof fund[0].funder === 'string' ? JSON.parse(fund[0].funder) : fund[0].funder;
    assert.match(fb.submissionId, /^sub-[0-9a-f]{32}$/);
    assert.ok(!(await page.textContent('body')).includes('שמירת הגורם המממן נכשלה'), 'no funder failure toast');
    assert.deepEqual(errors, []);
    await ctx.close();
  } finally { await browser.close(); srv.close(); }
});
