'use strict';

/* C2 — the CRM shell in a real Chromium at 1366 px and 390 px
 * (CHANGELOG-crm-shell-areas.md). SKIPPED unless playwright + a Chromium
 * binary are present (same rule as billing-control-tab-browser.test.js).
 * The real server.js with CRM_ENABLED=true; Apps Script is stubbed with a
 * synthetic getData. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const core = require('../public/crm/crm.js');
let playwright = null;
try { playwright = require('playwright'); } catch (_) { /* skip */ }
const CHROMIUM_CANDIDATES = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium/chrome-linux/chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
let chromiumPath = CHROMIUM_CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch (_) { return false; } });
if (!chromiumPath) {
  try {
    const d = '/opt/pw-browsers';
    chromiumPath = fs.readdirSync(d).filter((n) => n.startsWith('chromium-'))
      .flatMap((n) => [`${d}/${n}/chrome-linux/chrome`, `${d}/${n}/chrome-linux64/chrome`]).find((p) => fs.existsSync(p));
  } catch (_) { /* none */ }
}
const skip = !playwright || !chromiumPath;

const pinHash = require('../lib/pin-hash');
const users = require('../lib/users');
const { createSessionToken } = require('../lib/session');
const SERVER_PATH = require.resolve('../server');
const PEPPER = 'pepper-TEST-crm-shell-browser-0123456789abcdef';
const SESSION_SECRET = 'session-secret-TEST-crm-shell-browser-012345';
const PROXY_SECRET = 'proxy-secret-TEST-crm-shell-browser-0123456789';
const ENV_KEYS = ['PROXY_SECRET', 'SESSION_SECRET', 'SHEETS_URL', 'USER_PIN_HASHES', 'PIN_PEPPER', 'CRM_ENABLED'];
const israelDay = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date(ms));
const TODAY = israelDay(Date.now());
const daysAgo = (n) => israelDay(Date.now() - n * 86400000);

const DATA = {
  ok: true, irrelevantLeads: [], removedLeads: [], dischargedPatients: [], billingOverrides: [], houseManagers: {}, managerPhones: {}, currentManagers: [],
  leads: [
    { id: 'L1', name: 'אבי לוי', house: 'רמות השבים', stage: 'new', created: daysAgo(5), assignedTo: 'ורד', phone: '0501111111', source: 'פייסבוק' },
    { id: 'L2', name: 'גלי כהן', house: 'ramot', stage: 'visit', visitDate: TODAY, visitTime: '13:30', meetingWith: 'אורן', created: daysAgo(2) },
    { id: 'L3', name: 'דנה מזרחי', house: 'רעננה הפרדס', stage: 'visit', visitDate: daysAgo(3), meetingWith: 'חן', created: daysAgo(6) },
    { id: 'L5', name: 'רון אביב', house: 'קיסריה ריהאב', stage: 'visit', visitDate: daysAgo(4), meetingWith: 'רנטה', created: daysAgo(9), meetingReportOutcome: 'undecided', meetingCompanion: 'father', meetingNote: 'רוצה לחשוב', meetingReporter: 'רנטה', meetingReportedAt: daysAgo(2) + 'T07:00:00.000Z', meetingSeen: '' },
    { id: 'L4', name: 'טל ברק', house: 'רמות השבים', stage: 'paid', created: daysAgo(10), assignedTo: 'ורד' },
  ],
  patients: { ramot: [{ id: 'p1', name: 'דנה כהן', date: daysAgo(30), status: 'active', pay: 6000 }], rehab: [{ id: 'p2', name: 'אבי', date: daysAgo(7), status: 'active' }] },
};
const QUEUE = { ok: true, receipts: [{ id: 'r1', status: 'reported' }, { id: 'r2', status: 'flagged' }] };
const DEBT = { ok: true, asOf: TODAY,
  totals: { recorded_debt: { count: 1, total: 6000, d0_7: 0, d8_30: 0, d31_60: 0, d61_plus: 6000 }, unrecorded_cycles: { count: 1, total: 5000, d0_7: 5000, d8_30: 0, d31_60: 0, d61_plus: 0 } },
  byHouse: [{ houseId: 'ramot', recorded_debt: { count: 1, total: 6000 }, unrecorded_cycles: { count: 1, total: 5000 } }],
  byPatient: [{ patientId: 'p1', patientKey: 'ramot::דנה כהן::' + daysAgo(30), name: 'דנה כהן', houseId: 'ramot', status: 'active', inHouseAtAsOf: true, cycles: [
    { start: daysAgo(70), end: daysAgo(41), expected: 6000, received: 2500, balance: 3500, days: 70, kind: 'recorded', paymentId: 'cyc-1', month: daysAgo(70).slice(0, 7) },
    { start: daysAgo(3), end: daysAgo(-26), expected: 5000, received: 0, balance: 5000, days: 3, kind: 'unrecorded', month: daysAgo(3).slice(0, 7), discount: 0 }] }],
  detachedPayments: { count: 1 }, pendingCredits: { count: 0, total: 0 }, funderGrace: { count: 0, amount: 0 } };
const PAYMENTS = { ok: true, payments: [{ id: 'cyc-1', patientId: 'ramot::דנה כהן::' + daysAgo(30), patientUid: 'p1', patientName: 'דנה כהן', houseId: 'ramot', dueDate: daysAgo(70), amount: 6000, amountPaid: 2500, balance: 3500, status: 'partial', coverageStart: daysAgo(70), coverageEnd: daysAgo(41) }],
  receipts: [{ id: 'rcpt-1', patientId: 'ramot::דנה כהן::' + daysAgo(30), patientUid: 'p1', patientName: 'דנה כהן', houseId: 'ramot', dueDate: daysAgo(70), receivedDate: daysAgo(4), amount: 2500, method: 'ביט', payer: 'אמא', reference: '', funder: 'פרטי', coverageStart: daysAgo(70), coverageEnd: daysAgo(41), invoiceWanted: 'no', invoiceTo: '', confirmStatus: 'reported' }],
  funders: [{ patientId: 'p1', funder: 'משרד הביטחון', effectiveFrom: daysAgo(30), setBy: 'ורד' }] };
const CREDITS = { ok: true, credits: [
  { id: 'cr-1', patientId: 'p1', patientKey: 'ramot::דנה כהן::' + daysAgo(30), patientName: 'דנה כהן', houseId: 'ramot', creditType: 'days_unused', allocationMonth: daysAgo(40).slice(0, 7), amount: 1200, status: 'pending', payoutDate: daysAgo(10) },
  { id: 'cr-2', patientId: 'p2', patientKey: 'rehab::אבי::' + daysAgo(7), patientName: 'אבי', houseId: 'rehab', creditType: 'other', allocationMonth: daysAgo(40).slice(0, 7), amount: 300, status: 'paid', paidDate: daysAgo(2), method: 'ביט' }] };
const ACTIVITY = { ok: true, scope: 'full', total: 1, events: [{ eventId: 'x', occurredAt: '2026-10-20T09:00:00.000Z', kind: 'lead_created', source: 'system:x', actorName: 'ורד', summary: 'הליד נוצר', details: {} }] };

let saveAnswer = null;
async function boot() {
  const saves = [];
  const hash = await pinHash.hashPin('583920', PEPPER);
  const recs = ['vered', 'sandra', 'ortal'].map((id) => JSON.parse(users.recordLine(id, hash, 1)));
  const env = { PROXY_SECRET, SESSION_SECRET, SHEETS_URL: 'https://script.google.com/macros/s/TEST/exec', PIN_PEPPER: PEPPER, USER_PIN_HASHES: JSON.stringify(recs), CRM_ENABLED: 'true' };
  const saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; process.env[k] = env[k]; }
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  delete require.cache[SERVER_PATH];
  let mod;
  try { mod = require('../server'); } finally { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
  const actions = [];
  const original = https.request;
  https.request = (url, opts, cb) => {
    const req = new EventEmitter();
    let body = '';
    req.write = (c) => { body += c; };
    req.end = () => {
      let parsed = {};
      try { parsed = JSON.parse(body); } catch (_) { parsed = {}; }
      actions.push({ action: parsed.action, user: parsed.proxyUserId });
      if (parsed.action === 'saveAll') saves.push(parsed);
      if (['moveLeadIrrelevant', 'removeLead', 'restoreLead', 'appendFunder', 'dischargePatient', 'reportPayment', 'setBillingDiscount', 'upsertBillingOverride', 'settleRefund', 'editReceipt', 'savePayment'].indexOf(parsed.action) >= 0) saves.push(parsed);
      const answer = parsed.action === 'getData' ? DATA : parsed.action === 'billingControlQueue' ? QUEUE : parsed.action === 'getActivity' ? ACTIVITY
        : parsed.action === 'debtAging' ? DEBT : parsed.action === 'getPayments' ? PAYMENTS : parsed.action === 'getCredits' ? CREDITS
        : parsed.action === 'editReceipt' ? (saveAnswer ? saveAnswer(parsed) : { ok: true, receipt: { id: parsed.edit && parsed.edit.id } })
        : parsed.action === 'savePayment' ? (saveAnswer ? saveAnswer(parsed) : { ok: true, payment: { id: parsed.payment && parsed.payment.id, status: parsed.payment && parsed.payment.status } })
        : parsed.action === 'setBillingDiscount' ? (saveAnswer ? saveAnswer(parsed) : { ok: true })
        : parsed.action === 'upsertBillingOverride' ? (saveAnswer ? saveAnswer(parsed) : { ok: true, override: { id: parsed.override && parsed.override.id } })
        : parsed.action === 'settleRefund' ? (saveAnswer ? saveAnswer(parsed) : { ok: true, credit: { id: parsed.creditId } })
        : parsed.action === 'saveAll' ? (saveAnswer ? saveAnswer(parsed) : { ok: true, proven: { leads: (parsed.leads || []).map((l) => String(l.id)), patients: Object.values(parsed.patients || {}).flat().map((p) => String(p.id)) } })
        : parsed.action === 'reportPayment' ? (saveAnswer ? saveAnswer(parsed) : { ok: true, receipt: { id: 'rcpt-new' }, cycle: { id: parsed.report && parsed.report.cycle && parsed.report.cycle.id } })
        : parsed.action === 'appendFunder' ? { ok: true, row: { submissionId: parsed.funder && parsed.funder.submissionId } }
        : parsed.action === 'dischargePatient' ? (saveAnswer ? saveAnswer(parsed) : { ok: true, patient: { id: String(parsed.patient && parsed.patient.id) }, refund: { created: 1 } })
        : ['moveLeadIrrelevant', 'removeLead', 'restoreLead'].indexOf(parsed.action) >= 0 ? (saveAnswer ? saveAnswer(parsed) : { ok: true, lead: { id: String(parsed.lead && parsed.lead.id) } })
        : { ok: false, error: 'unexpected_' + parsed.action };
      const res = new EventEmitter();
      res.statusCode = 200; res.headers = {}; res.setEncoding = () => {}; res.resume = () => {};
      setImmediate(() => { cb(res); res.emit('data', JSON.stringify(answer)); res.emit('end'); });
    };
    return req;
  };
  const srv = await new Promise((resolve) => { const s = mod.app.listen(0, '127.0.0.1', () => resolve(s)); });
  return { port: srv.address().port, actions, saves, close() { saveAnswer = null; srv.close(); https.request = original; Object.assign(console, quiet); } };
}

async function open(browser, port, id, width) {
  const ctx = await browser.newContext({ viewport: { width, height: 800 }, locale: 'he-IL', timezoneId: 'Asia/Jerusalem', serviceWorkers: 'block' });
  const name = users.modelById(id).name;
  await ctx.addCookies([{ name: 'ezone_session', value: createSessionToken(SESSION_SECRET, undefined, undefined, name, { id, pinVersion: 1 }), url: `http://127.0.0.1:${port}` }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e && e.message)));
  await page.goto(`http://127.0.0.1:${port}/?view=crm`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#crm-nav button', { timeout: 15000 });
  await page.waitForFunction(() => !document.querySelector('#crm-main .crm-state') || !/טוען/.test(document.querySelector('#crm-main').textContent), null, { timeout: 15000 });
  return { ctx, page, errors };
}
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);

test('CRM shell at 1366 px (Vered): side menu, six areas, work queue, board/table toggle keeps filters, drawer with timeline', { skip: skip && 'playwright/chromium missing' }, async () => {
  const srv = await boot();
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  try {
    const { page, errors } = await open(browser, srv.port, 'vered', 1366);
    assert.equal(await page.getAttribute('html', 'dir'), 'rtl');
    assert.deepEqual(await page.$$eval('#crm-nav button span:first-child', (els) => els.map((e) => e.textContent)), ['היום שלי', 'פניות', 'תפוסה', 'מטופלים', 'יומן', 'גבייה', 'בקרה']);
    assert.ok(await page.isVisible('#crm-menu'));
    assert.ok(!(await page.isVisible('#crm-burger')), 'no burger on desktop');
    assert.equal(await page.$eval('#crm-user', (e) => e.textContent), 'ורד');
    // «היום שלי»: KPIs + the late row for the meeting without an outcome
    const kpis = await page.$$eval('.kpi .v', (els) => els.map((e) => e.textContent));
    assert.deepEqual(kpis, ['2', '2', '0', '1'], 'late ×2, today ×2 (a meeting today + an unseen manager report)');
    assert.match(await page.textContent('#crm-main'), /דנה מזרחי/);
    assert.match(await page.textContent('#crm-main'), /לקבל דיווח מהמנהל\/ת/);
    await page.click('.kpi[data-kpi="late"]');
    assert.ok(!/גלי כהן/.test(await page.textContent('#crm-main .rows')), 'the KPI filters the list');
    // «פניות»: board, filter, table keeps the filter
    await page.click('#crm-nav button[data-area="leads"]');
    assert.equal(await page.$$eval('.col', (els) => els.length), 4);
    await page.selectOption('#f-house', 'רמות השבים');
    const onBoard = await page.$$eval('.card .name', (els) => els.map((e) => e.textContent));
    assert.deepEqual(onBoard.sort(), ['אבי לוי', 'גלי כהן', 'טל ברק']);
    const dmy = (iso) => iso.split('-').reverse().join('/');
    assert.match(await page.textContent('.board'), new RegExp('נוצר ' + dmy(daysAgo(5))), 'created date on the card, DD/MM/YYYY');
    assert.ok(!/\d{4}-\d{2}-\d{2}/.test(await page.textContent('#crm-main')), 'no ISO date is ever shown');
    await page.click('button[data-view="table"]');
    assert.equal(await page.$eval('#f-house', (e) => e.value), 'רמות השבים', 'filter kept across the toggle');
    assert.equal(await page.$$eval('table.tbl tbody tr', (els) => els.length), 3);
    // drawer: existing fields + timeline from getActivity
    await page.click('table.tbl tbody tr');
    await page.waitForSelector('#crm-drawer[aria-hidden="false"]');
    assert.match(await page.textContent('#crm-drawer'), /סקירה/);
    await page.click('#crm-drawer [data-tab="activity"]');
    await page.waitForFunction(() => /הליד נוצר/.test(document.querySelector('#crm-tl').textContent), null, { timeout: 5000 });
    await page.keyboard.press('Escape');
    assert.equal(await page.getAttribute('#crm-drawer', 'aria-hidden'), 'true');
    assert.equal(await page.$eval('#f-house', (e) => e.value), 'רמות השבים', 'closing the card keeps the filter');
    // «תפוסה»: house cards; a card opens «מטופלים» filtered to that house
    await page.click('#crm-nav button[data-area="occupancy"]');
    assert.match(await page.textContent('#crm-main'), /מיטות פנויות/);
    assert.match(await page.textContent('#crm-main'), /רמות השבים/);
    await page.click('[data-house-open="קיסריה ריהאב"]');
    assert.equal(await page.textContent('#crm-title'), 'מטופלים');
    assert.equal(await page.$$eval('table.tbl tbody tr', (els) => els.length), 1);
    await page.selectOption('#f-house-c', '');
    // «מטופלים», «יומן», «גבייה», «בקרה» render
    await page.click('#crm-nav button[data-area="clients"]');
    assert.match(await page.textContent('#crm-main'), /דנה כהן/);
    await page.click('#crm-nav button[data-area="calendar"]');
    assert.match(await page.textContent('#crm-main'), /גלי כהן/);
    await page.click('#crm-nav button[data-area="billing"]');
    await page.waitForSelector('#crm-debtors');
    await page.click('#crm-nav button[data-area="control"]');
    assert.match(await page.textContent('#crm-main'), /פגישות ללא תוצאה/);
    assert.ok(await noHScroll(page), 'no horizontal page scroll');
    assert.deepEqual(errors, []);
    assert.deepEqual([...new Set(srv.actions.map((a) => a.action))].sort(), ['debtAging', 'getActivity', 'getCredits', 'getData', 'getPayments'], 'reads only, no queue for Vered');
  } finally { await browser.close(); srv.close(); }
});

test('CRM shell at 390 px (Vered): burger opens the drawer menu, areas work, no horizontal scroll', { skip: skip && 'playwright/chromium missing' }, async () => {
  const srv = await boot();
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  try {
    const { page, errors } = await open(browser, srv.port, 'vered', 390);
    assert.ok(await page.isVisible('#crm-burger'));
    assert.notEqual(await page.getAttribute('#crm-menu', 'data-open'), 'true');
    await page.click('#crm-burger');
    assert.equal(await page.getAttribute('#crm-menu', 'data-open'), 'true');
    await page.click('#crm-nav button[data-area="leads"]');
    assert.notEqual(await page.getAttribute('#crm-menu', 'data-open'), 'true', 'choosing an area closes the menu');
    assert.equal(await page.textContent('#crm-title'), 'פניות');
    assert.ok(await noHScroll(page), 'no horizontal page scroll at 390');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); srv.close(); }
});

test('CRM shell (Ortal, controller): only היום שלי / גבייה / בקרה; her day comes from billingControlQueue; no lead data requested', { skip: skip && 'playwright/chromium missing' }, async () => {
  const srv = await boot();
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  try {
    const { page, errors } = await open(browser, srv.port, 'ortal', 1366);
    assert.deepEqual(await page.$$eval('#crm-nav button span:first-child', (els) => els.map((e) => e.textContent)), ['היום שלי', 'גבייה', 'בקרה']);
    await page.waitForFunction(() => /דיווחים לאימות/.test(document.querySelector('#crm-main').textContent), null, { timeout: 5000 });
    assert.deepEqual(await page.$$eval('.kpi .v', (els) => els.map((e) => e.textContent)), ['1', '1', '0']);
    assert.ok(!/אבי לוי/.test(await page.textContent('#crm-main')), 'no lead names in her view');
    assert.deepEqual(errors, []);
    assert.ok(srv.actions.some((a) => a.action === 'billingControlQueue' && a.user === 'ortal'));
  } finally { await browser.close(); srv.close(); }
});

test('C8 גבייה read-only (Vered + Ortal): debtAging + getPayments fetched on first open only; KPIs, debtors, receipts; a debtor row opens the patient drawer; actions stay links to the classic app', { skip: skip && 'playwright/chromium missing' }, async () => {
  const srv = await boot();
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  try {
    const { page, errors } = await open(browser, srv.port, 'vered', 1366);
    assert.ok(!srv.actions.some((a) => a.action === 'debtAging' || a.action === 'getPayments'), 'not loaded on boot');
    await page.click('#crm-nav button[data-area="billing"]');
    await page.waitForSelector('#crm-debtors');
    assert.equal(await page.textContent('#crm-title'), 'גבייה');
    const kpis = await page.$$eval('.kpis .kpi .v', (els) => els.map((e) => e.textContent));
    assert.deepEqual(kpis.slice(0, 5), ['₪11,000', '₪6,000', '1', '₪2,500', '1']);
    assert.deepEqual(kpis.slice(5, 9), ['₪5,000', '₪0', '₪0', '₪6,000'], 'the four aging buckets');
    const main = await page.textContent('#crm-main');
    assert.match(main, /דנה כהן/); assert.match(main, /רמות השבים/); assert.match(main, /1 ללא דיווח/); assert.match(main, /70 ימים/); assert.match(main, /₪8,500/); assert.match(main, /ביט/); assert.match(main, /עריכת קבלות/);
    assert.match(await page.textContent('#crm-receipts'), new RegExp(core.fmtDate(daysAgo(4)).replace(/\//g, '\\/')), 'receipt dates are DD/MM/YYYY');
    assert.equal(await page.$$eval('#crm-main .links a', (els) => els.map((e) => e.getAttribute('href')).every((h) => h === '/?view=classic')), true, 'every action links to the classic dashboard (view=classic survives the switch)');
    // the debtor row opens the patient drawer
    await page.click('#crm-debtors tbody tr');
    assert.equal(await page.getAttribute('#crm-drawer', 'aria-hidden'), 'false');
    assert.match(await page.textContent('#crm-drawer'), /דנה כהן/);
    await page.keyboard.press('Escape');
    // leaving and coming back does NOT refetch
    await page.click('#crm-nav button[data-area="today"]');
    await page.click('#crm-nav button[data-area="billing"]');
    await page.waitForSelector('#crm-debtors');
    assert.equal(srv.actions.filter((a) => a.action === 'debtAging').length, 1);
    assert.equal(srv.actions.filter((a) => a.action === 'getPayments').length, 1);
    assert.equal(srv.actions.filter((a) => a.action === 'getCredits').length, 1);
    assert.match(main, /זיכויים לתשלום/); assert.match(await page.textContent('#crm-pending-credits'), /דנה כהן/);
    assert.deepEqual(errors, []);
    assert.deepEqual(srv.saves, [], 'read-only: nothing written');
    // Ortal: same reads under her own session; her action link is the verification queue only
    const o = await open(browser, srv.port, 'ortal', 1366);
    await o.page.click('#crm-nav button[data-area="billing"]');
    await o.page.waitForSelector('#crm-debtors');
    assert.ok(srv.actions.some((a) => a.action === 'debtAging' && a.user === 'ortal'));
    const links = await o.page.$$eval('#crm-main .links a', (els) => els.map((e) => e.textContent));
    assert.equal(links.length, 1); assert.match(links[0], /בקרת גבייה/);
    assert.deepEqual(o.errors, []);
  } finally { await browser.close(); srv.close(); }
});

test('C9 «חשבון» tab (Vered): a patient drawer shows open cycles, stamped cycles, own receipts and the funder from the shared billing reads (fetched once); a lead has no account', { skip: skip && 'playwright/chromium missing' }, async () => {
  const srv = await boot();
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  try {
    const { page, errors } = await open(browser, srv.port, 'vered', 1366);
    await page.click('#crm-nav button[data-area="clients"]');
    await page.click('table.tbl tbody tr[data-open-patient="p1"]');
    await page.waitForSelector('#crm-drawer[aria-hidden="false"]');
    await page.click('#crm-drawer [data-tab="account"]');
    await page.waitForSelector('#crm-account-open');
    const acc = await page.textContent('#crm-account');
    assert.match(acc, /חוב פתוח/); assert.match(acc, /₪8,500/); assert.match(acc, /2 מחזורים/);
    assert.match(acc, /ללא דיווח/); assert.match(acc, /משרד הביטחון/); assert.match(acc, /₪2,500/); assert.match(acc, /אמא/); assert.match(acc, /חלקי/);
    assert.match(acc, new RegExp(core.fmtDate(daysAgo(4)).replace(/\//g, '\\/')), 'DD/MM/YYYY');
    assert.equal(await page.$$eval('#crm-account-receipts tbody tr', (els) => els.length), 1);
    assert.equal(srv.actions.filter((a) => a.action === 'debtAging').length, 1);
    // the גבייה area reuses the same answers — no second fetch
    await page.keyboard.press('Escape');
    await page.click('#crm-nav button[data-area="billing"]');
    await page.waitForSelector('#crm-debtors');
    assert.equal(srv.actions.filter((a) => a.action === 'debtAging').length, 1);
    assert.equal(srv.actions.filter((a) => a.action === 'getPayments').length, 1);
    // a lead drawer: no account
    await page.click('#crm-nav button[data-area="leads"]');
    await page.click('.card .name');
    await page.waitForSelector('#crm-drawer[aria-hidden="false"]');
    await page.click('#crm-drawer [data-tab="account"]');
    assert.match(await page.textContent('#crm-account'), /נפתח עם הקליטה/);
    assert.deepEqual(errors, []);
    assert.deepEqual(srv.saves, [], 'read-only');
  } finally { await browser.close(); srv.close(); }
});

test('C10 «דווח תשלום» in the account pane (Vered): rules validate client-side, a valid report posts reportPayment with the cycle + submissionId and re-reads; a duplicate asks and re-sends with confirmDuplicate; the unrecorded cycle is minted pay::<key>::<due>', { skip: skip && 'playwright/chromium missing' }, async () => {
  const srv = await boot();
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  try {
    const { page, errors } = await open(browser, srv.port, 'vered', 1366);
    assert.equal(await page.evaluate(() => typeof window.PaymentReportRules), 'object', 'the shared rules are loaded by the shell');
    await page.click('#crm-nav button[data-area="clients"]');
    await page.click('table.tbl tbody tr[data-open-patient="p1"]');
    await page.waitForSelector('#crm-drawer[aria-hidden="false"]');
    await page.click('#crm-drawer [data-tab="account"]');
    await page.waitForSelector('#crm-account-open');
    assert.equal(await page.$$eval('#crm-account-open [data-report-open]', (els) => els.length), 2);
    // recorded cycle → the form, remaining prefilled, coverage from the row
    await page.click('#crm-account-open [data-report-open="0"]');
    await page.waitForSelector('form[data-form="payment-report"]');
    assert.equal(await page.inputValue('form.report [name="amount"]'), '3500');
    assert.equal(await page.inputValue('form.report [name="coverageStart"]'), daysAgo(70));
    assert.equal(await page.inputValue('form.report [name="funder"]'), 'משרד הביטחון');
    // empty submit: client-side issues, nothing posted
    await page.click('form.report button[type="submit"]');
    await page.waitForFunction(() => document.querySelector('form.report .err[data-err="method"]').textContent.length > 0);
    assert.match(await page.textContent('form.report .err[data-err="payer"]'), /משלם/);
    assert.equal(srv.saves.length, 0);
    // bank transfer needs a reference
    await page.selectOption('form.report [name="method"]', 'העברה בנקאית');
    await page.fill('form.report [name="payer"]', 'אמא של דנה');
    await page.selectOption('form.report [name="invoiceWanted"]', 'no');
    await page.click('form.report button[type="submit"]');
    await page.waitForFunction(() => /אסמכתא/.test(document.querySelector('form.report .err[data-err="reference"]').textContent));
    assert.equal(srv.saves.length, 0);
    await page.fill('form.report [name="reference"]', 'TR-123');
    // the server says duplicate → confirm → re-sent with confirmDuplicate
    let calls = 0;
    saveAnswer = (parsed) => { calls++; return calls === 1 ? { ok: false, error: 'possible_duplicate', existing: { id: 'rcpt-1', receivedDate: daysAgo(4), reference: 'TR-123' } } : { ok: true, receipt: { id: 'rcpt-new' }, cycle: { id: parsed.report.cycle.id } }; };
    page.once('dialog', (d) => { assert.match(d.message(), /קבלה דומה/); d.accept(); });
    await page.click('form.report button[type="submit"]');
    await page.waitForFunction(() => !document.querySelector('form.report'), null, { timeout: 5000 });
    assert.equal(srv.saves.length, 2);
    const first = srv.saves[0].report, second = srv.saves[1].report;
    assert.equal(srv.saves[0].action, 'reportPayment');
    assert.deepEqual(first.cycle, { id: 'cyc-1', patientId: 'ramot::דנה כהן::' + daysAgo(30), patientName: 'דנה כהן', houseId: 'ramot', dueDate: daysAgo(70), amount: 6000, coverageStart: daysAgo(70), coverageEnd: daysAgo(41) });
    assert.equal(first.report.amount, '3500'); assert.equal(first.report.method, 'העברה בנקאית'); assert.equal(first.report.reference, 'TR-123'); assert.equal(first.report.invoiceWanted, 'no');
    assert.match(first.submissionId, /^sub-[0-9a-f]{32}$/); assert.equal(first.confirmDuplicate, undefined);
    assert.equal(second.submissionId, first.submissionId, 'same idempotency key on the re-send'); assert.equal(second.confirmDuplicate, true);
    // saved → both reads again, pane repainted
    await page.waitForFunction(() => !!document.querySelector('#crm-account-open'));
    assert.equal(srv.actions.filter((a) => a.action === 'debtAging').length, 2);
    assert.equal(srv.actions.filter((a) => a.action === 'getPayments').length, 2);
    // the unrecorded cycle: minted id, debtAging's window and expected amount
    saveAnswer = null;
    await page.click('#crm-account-open [data-report-open="1"]');
    await page.waitForSelector('form[data-form="payment-report"]');
    assert.equal(await page.inputValue('form.report [name="amount"]'), '5000');
    await page.selectOption('form.report [name="method"]', 'מזומן');
    await page.fill('form.report [name="payer"]', 'דנה כהן');
    await page.selectOption('form.report [name="invoiceWanted"]', 'yes');
    await page.fill('form.report [name="invoiceTo"]', 'דנה כהן');
    await page.click('form.report button[type="submit"]');
    await page.waitForFunction(() => !document.querySelector('form.report'), null, { timeout: 5000 });
    const third = srv.saves[2].report;
    assert.deepEqual(third.cycle, { id: 'pay::ramot::דנה כהן::' + daysAgo(30) + '::' + daysAgo(3), patientId: 'ramot::דנה כהן::' + daysAgo(30), patientName: 'דנה כהן', houseId: 'ramot', dueDate: daysAgo(3), amount: 5000, coverageStart: daysAgo(3), coverageEnd: daysAgo(-26) });
    assert.equal(third.report.invoiceTo, 'דנה כהן');
    assert.notEqual(third.submissionId, first.submissionId, 'a new form, a new key');
    // C13: «מחזור אחר» — an advance for the next entry-anchored cycle, minted from the patient's pay
    assert.ok(await page.$('#crm-other-cycle'), 'the other-cycle picker');
    const picked = await page.$eval('#crm-other-cycle', (el) => el.options[el.selectedIndex].textContent);
    assert.match(picked, new RegExp(core.fmtDate(core.addMonthsIso(daysAgo(30), 1)).replace(/\//g, '\\/')), 'default = the first cycle after today');
    await page.click('[data-report-other]');
    await page.waitForSelector('form[data-form="payment-report"]');
    assert.equal(await page.inputValue('form.report [name="amount"]'), '6000');
    await page.selectOption('form.report [name="method"]', 'ביט'); await page.fill('form.report [name="payer"]', 'דנה כהן'); await page.selectOption('form.report [name="invoiceWanted"]', 'no');
    await page.click('form.report button[type="submit"]');
    await page.waitForFunction(() => !document.querySelector('form.report'), null, { timeout: 5000 });
    const adv = srv.saves[3].report;
    assert.equal(adv.cycle.id, 'pay::ramot::דנה כהן::' + daysAgo(30) + '::' + core.addMonthsIso(daysAgo(30), 1));
    assert.equal(adv.cycle.amount, 6000); assert.equal(adv.cycle.coverageStart, core.addMonthsIso(daysAgo(30), 1));
    // a refused report keeps the form open with the server's field issues
    await page.click('#crm-account-open [data-report-open="1"]');
    await page.waitForSelector('form[data-form="payment-report"]');
    saveAnswer = () => ({ ok: false, error: 'invalid_report', message: 'הדיווח לא נשמר — יש להשלים את השדות המסומנים', issues: [{ field: 'coverageStart', code: 'coverage_outside_cycle', hebrewMessage: 'תחילת תקופת הכיסוי חייבת להיות בתוך מחזור החיוב' }] });
    await page.selectOption('form.report [name="method"]', 'ביט'); await page.fill('form.report [name="payer"]', 'דנה כהן'); await page.selectOption('form.report [name="invoiceWanted"]', 'no');
    await page.click('form.report button[type="submit"]');
    await page.waitForFunction(() => /בתוך מחזור/.test(document.querySelector('form.report .err[data-err="coverageStart"]').textContent));
    assert.ok(await page.$('form.report'), 'form stays open');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); srv.close(); }
});

test('C11 discount / amount / settle (Vered): the three classic writes from the account pane with the legacy key; client errors first; a refusal keeps the form; saved → three reads again; «זיכויים לתשלום» in the area opens the drawer form', { skip: skip && 'playwright/chromium missing' }, async () => {
  const srv = await boot();
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  try {
    const { page, errors } = await open(browser, srv.port, 'vered', 1366);
    await page.click('#crm-nav button[data-area="clients"]');
    await page.click('table.tbl tbody tr[data-open-patient="p1"]');
    await page.waitForSelector('#crm-drawer[aria-hidden="false"]');
    await page.click('#crm-drawer [data-tab="account"]');
    await page.waitForSelector('#crm-account-open');
    assert.match(await page.textContent('#crm-account-credits'), /ימים שלא נוצלו/);
    assert.equal(await page.$$eval('#crm-account-credits [data-settle-open]', (els) => els.length), 1, 'only the pending credit can be settled');
    // discount: reason required (client), then the classic body
    await page.click('#crm-account-open [data-discount-open="1"]');
    await page.waitForSelector('form[data-form="small-discount"]');
    await page.fill('form.report [name="discountAmount"]', '500');
    await page.click('form.report button[type="submit"]');
    await page.waitForFunction(() => /סיבה/.test(document.querySelector('form.report .err[data-err="discountReason"]').textContent));
    assert.equal(srv.saves.length, 0);
    await page.fill('form.report [name="discountReason"]', 'הסכמה עם המשפחה');
    await page.click('form.report button[type="submit"]');
    await page.waitForFunction(() => !document.querySelector('form.report'), null, { timeout: 5000 });
    assert.equal(srv.saves[0].action, 'setBillingDiscount');
    assert.deepEqual(srv.saves[0].discount, { patientId: 'ramot::דנה כהן::' + daysAgo(30), month: daysAgo(3).slice(0, 7), discountAmount: 500, discountReason: 'הסכמה עם המשפחה' });
    await page.waitForFunction(() => !!document.querySelector('#crm-account-open'));
    assert.equal(srv.actions.filter((a) => a.action === 'getCredits').length, 2, 'saved → re-read');
    // amount override: refused by the server → the form stays with the message
    await page.click('#crm-account-open [data-amount-open="0"]');
    await page.waitForSelector('form[data-form="small-amount"]');
    assert.equal(await page.inputValue('form.report [name="amount"]'), '6000');
    saveAnswer = () => ({ ok: false, error: 'bad_amount' });
    await page.fill('form.report [name="amount"]', '5500');
    await page.click('form.report button[type="submit"]');
    await page.waitForFunction(() => /bad_amount/.test(document.querySelector('form.report .err[data-err="_form"]').textContent));
    assert.equal(srv.saves[1].action, 'upsertBillingOverride');
    assert.deepEqual(srv.saves[1].override, { id: 'ovr::ramot::דנה כהן::' + daysAgo(30) + '::' + daysAgo(70).slice(0, 7), patientId: 'ramot::דנה כהן::' + daysAgo(30), month: daysAgo(70).slice(0, 7), amount: 5500, created: TODAY });
    saveAnswer = null;
    await page.click('form.report button[type="submit"]');
    await page.waitForFunction(() => !document.querySelector('form.report'), null, { timeout: 5000 });
    assert.equal(srv.saves.length, 3);
    // settle a pending credit from the account pane
    await page.waitForSelector('#crm-account-credits [data-settle-open="cr-1"]');
    await page.click('#crm-account-credits [data-settle-open="cr-1"]');
    await page.waitForSelector('form[data-form="small-settle"]');
    await page.click('form.report button[type="submit"]');
    await page.waitForFunction(() => /אמצעי/.test(document.querySelector('form.report .err[data-err="method"]').textContent));
    await page.selectOption('form.report [name="method"]', 'ביט');
    await page.click('form.report button[type="submit"]');
    await page.waitForFunction(() => !document.querySelector('form.report'), null, { timeout: 5000 });
    assert.equal(srv.saves[3].action, 'settleRefund');
    assert.equal(srv.saves[3].creditId, 'cr-1'); assert.equal(srv.saves[3].paidDate, TODAY); assert.equal(srv.saves[3].method, 'ביט');
    // from the גבייה area: «סמן כשולם» opens the patient drawer on חשבון with the form
    await page.keyboard.press('Escape');
    await page.click('#crm-nav button[data-area="billing"]');
    await page.waitForSelector('#crm-pending-credits [data-settle-open="cr-1"]');
    await page.click('#crm-pending-credits [data-settle-open="cr-1"]');
    await page.waitForSelector('form[data-form="small-settle"]');
    assert.equal(await page.getAttribute('#crm-drawer', 'aria-hidden'), 'false');
    assert.match(await page.textContent('#crm-drawer h2'), /דנה כהן/);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); srv.close(); }
});

test('C13 receipt fix (Vered): «עריכה» posts editReceipt with ONLY the changed fields (validated), «ביטול» posts the classic void row after a confirm and a reason; a void receipt has no buttons', { skip: skip && 'playwright/chromium missing' }, async () => {
  const srv = await boot();
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  try {
    const { page, errors } = await open(browser, srv.port, 'vered', 1366);
    await page.click('#crm-nav button[data-area="clients"]');
    await page.click('table.tbl tbody tr[data-open-patient="p1"]');
    await page.waitForSelector('#crm-drawer[aria-hidden="false"]');
    await page.click('#crm-drawer [data-tab="account"]');
    await page.waitForSelector('#crm-account-receipts [data-receipt-edit="rcpt-1"]');
    await page.click('#crm-account-receipts [data-receipt-edit="rcpt-1"]');
    await page.waitForSelector('form[data-form="receipt-edit"]');
    assert.equal(await page.inputValue('form.report [name="payer"]'), 'אמא');
    // nothing changed → refused client-side
    await page.click('form.report button[type="submit"]');
    await page.waitForFunction(() => /לא שונה/.test(document.querySelector('form.report .err[data-err="_form"]').textContent));
    // bank transfer without a reference → the rule fires on the touched field
    await page.selectOption('form.report [name="method"]', 'העברה בנקאית');
    await page.click('form.report button[type="submit"]');
    await page.waitForFunction(() => /אסמכתא/.test(document.querySelector('form.report .err[data-err="reference"]').textContent));
    assert.equal(srv.saves.length, 0);
    await page.fill('form.report [name="reference"]', 'TR-9'); await page.fill('form.report [name="payer"]', 'אבא'); await page.fill('form.report [name="reason"]', 'תיקון');
    await page.click('form.report button[type="submit"]');
    await page.waitForFunction(() => !document.querySelector('form.report'), null, { timeout: 5000 });
    assert.deepEqual(srv.saves[0].action, 'editReceipt');
    assert.deepEqual(srv.saves[0].edit, { id: 'rcpt-1', fields: { reference: 'TR-9', method: 'העברה בנקאית', payer: 'אבא' }, reason: 'תיקון' });
    await page.waitForFunction(() => !!document.querySelector('#crm-account-receipts'));
    assert.equal(srv.actions.filter((a) => a.action === 'getPayments').length, 2, 're-read after the edit');
    // void: reason required, confirm, the classic savePayment void row
    await page.click('#crm-account-receipts [data-receipt-void="rcpt-1"]');
    await page.waitForSelector('form[data-form="receipt-void"]');
    await page.click('form.report button[type="submit"]');
    await page.waitForFunction(() => /סיבה/.test(document.querySelector('form.report .err[data-err="note"]').textContent));
    await page.fill('form.report [name="note"]', 'נרשם פעמיים');
    page.once('dialog', (d) => { assert.match(d.message(), /לבטל את הקבלה/); d.accept(); });
    await page.click('form.report button[type="submit"]');
    await page.waitForFunction(() => !document.querySelector('form.report'), null, { timeout: 5000 });
    assert.equal(srv.saves[1].action, 'savePayment');
    const v = srv.saves[1].payment;
    assert.equal(v.id, 'rcpt-1'); assert.equal(v.status, 'void'); assert.equal(v.linkStatus, 'duplicate'); assert.equal(v.linkNote, 'נרשם פעמיים'); assert.equal(v.dueDate, daysAgo(70)); assert.equal(v.patientId, 'ramot::דנה כהן::' + daysAgo(30));
    // (a void receipt → «בוטלה», no buttons: pinned in the core test; the proxy caches getPayments briefly so a fixture flip is not visible here)
    assert.deepEqual(errors, []);
  } finally { await browser.close(); srv.close(); }
});

test('C14 «פגישות ושירותים» (Vered): the manager report renders with its labels; opening the tab marks it seen through ONE lead saveAll (meetingSeen=1, nothing else changed); the work queue and the card flag it before', { skip: skip && 'playwright/chromium missing' }, async () => {
  const srv = await boot();
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  try {
    const { page, errors } = await open(browser, srv.port, 'vered', 1366);
    await page.waitForSelector('.row');
    assert.match(await page.textContent('#crm-main'), /לקרוא את דיווח המנהל\/ת/);
    await page.click('#crm-nav button[data-area="leads"]');
    const card = page.locator('.card', { hasText: 'רון אביב' });
    assert.match(await card.textContent(), /דיווח מנהל\/ת חדש/);
    await card.locator('.name').click();
    await page.waitForSelector('#crm-drawer[aria-hidden="false"]');
    await page.click('#crm-drawer [data-tab="meetings"]');
    const pane = await page.textContent('#crm-meetings');
    assert.match(pane, /התקיימה — מתלבט/); assert.match(pane, /אבא/); assert.match(pane, /רוצה לחשוב/); assert.match(pane, /רנטה/); assert.match(pane, /Therapists/);
    await page.waitForTimeout(500);
    assert.equal(srv.saves.length, 1, 'one save');
    const body = srv.saves[0];
    assert.equal(body.action, 'saveAll'); assert.equal(body.leads.length, 1); assert.equal(body.leads[0].id, 'L5'); assert.equal(body.leads[0].meetingSeen, '1');
    assert.equal(body.leads[0].meetingReportOutcome, 'undecided', 'the report fields travel untouched'); assert.deepEqual(body.patients, {});
    // opening again does not save twice
    await page.click('#crm-drawer [data-tab="overview"]'); await page.click('#crm-drawer [data-tab="meetings"]');
    await page.waitForTimeout(300);
    assert.equal(srv.saves.length, 1);
    assert.ok(!/דיווח מנהל\/ת חדש/.test(await page.textContent('#crm-main')), 'the card flag is gone');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); srv.close(); }
});

test('C15 calendar picker (Vered): today by default; ‹ › and the date input move the day; week view groups by day; past meetings appear with their status; «היום» returns', { skip: skip && 'playwright/chromium missing' }, async () => {
  const srv = await boot();
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  try {
    const { page, errors } = await open(browser, srv.port, 'vered', 1366);
    await page.click('#crm-nav button[data-area="calendar"]');
    assert.equal(await page.inputValue('#crm-cal-date'), TODAY);
    assert.match(await page.textContent('#crm-main'), /גלי כהן/);
    assert.match(await page.textContent('#crm-cal-bar'), /היום · /);
    // three days back: דנה מזרחי's past meeting with no outcome
    await page.fill('#crm-cal-date', daysAgo(3));
    await page.dispatchEvent('#crm-cal-date', 'change');
    const past = await page.textContent('#crm-main');
    assert.match(past, /דנה מזרחי/); assert.match(past, /ללא תוצאה/); assert.ok(!/גלי כהן/.test(past));
    assert.equal(await page.inputValue('#crm-cal-date'), daysAgo(3));
    // one day forward with ›
    await page.click('[data-cal-step="1"]');
    assert.equal(await page.inputValue('#crm-cal-date'), daysAgo(2));
    // week view: both the past meeting (4 days ago, with a report) and today's, grouped by day
    await page.click('[data-cal-mode="week"]');
    const week = await page.textContent('#crm-main');
    assert.match(await page.textContent('#crm-cal-bar'), /שבוע/);
    assert.ok(await page.$$eval('.group-title', (els) => els.length) >= 1, 'day headers in week view');
    await page.click('[data-cal-today]');
    assert.equal(await page.inputValue('#crm-cal-date'), TODAY, 'the input shows the chosen day, the title the week');
    await page.click('[data-cal-mode="day"]');
    assert.equal(await page.inputValue('#crm-cal-date'), TODAY);
    assert.match(await page.textContent('#crm-main'), /גלי כהן/);
    void week;
    assert.deepEqual(errors, []);
    assert.deepEqual(srv.saves, []);
  } finally { await browser.close(); srv.close(); }
});

test('C4 lead actions (Vered): «שלב הבא» on a card posts ONE lead to saveAll and moves the card; a refusal rolls back; the meeting form schedules', { skip: skip && 'playwright/chromium missing' }, async () => {
  const srv = await boot();
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  try {
    const { page, errors } = await open(browser, srv.port, 'vered', 1366);
    await page.click('#crm-nav button[data-area="leads"]');
    // 1. stage move from the card: new → visit
    await page.click('.card[data-open-lead="L1"] [data-stage-next]');
    await page.waitForFunction(() => document.querySelector('.col:nth-child(2) .card[data-open-lead="L1"]') !== null, null, { timeout: 5000 });
    assert.equal(srv.saves.length, 1);
    const body = srv.saves[0];
    assert.equal(body.leads.length, 1, 'ONE lead, never the board');
    assert.deepEqual(body.patients, {}, 'no patient is ever sent');
    assert.equal(body.leads[0].id, 'L1'); assert.equal(body.leads[0].stage, 'visit');
    assert.equal(body.leads[0].phone, '0501111111', 'the full raw row travels');
    assert.deepEqual(body.prove, { leads: ['L1'] });
    await page.waitForSelector('#crm-toast[data-show="true"]');
    assert.match(await page.textContent('#crm-toast'), /נשמר/);
    // 2. refusal → rollback to the previous column + error toast
    saveAnswer = () => ({ ok: false, invalidLeads: ['L1'] });
    await page.click('.card[data-open-lead="L1"] [data-stage-next]');
    await page.waitForFunction(() => /שם וטלפון/.test(document.querySelector('#crm-toast').textContent), null, { timeout: 5000 });
    assert.ok(await page.$('.col:nth-child(2) .card[data-open-lead="L1"]'), 'rolled back to ביקור נקבע');
    saveAnswer = null;
    // 3. meeting form in the drawer: date + time + נפגש עם
    await page.click('.card[data-open-lead="L1"] .name');
    await page.waitForSelector('#crm-drawer[aria-hidden="false"]');
    await page.click('#crm-drawer details.act:nth-of-type(1) summary');
    await page.fill('#crm-drawer form[data-form="meeting"] [name="visitDate"]', TODAY);
    await page.fill('#crm-drawer form[data-form="meeting"] [name="visitTime"]', '11:30');
    await page.selectOption('#crm-drawer form[data-form="meeting"] [name="meetingWith"]', 'אמבולטורי');
    await page.click('#crm-drawer form[data-form="meeting"] button[type="submit"]');
    await page.waitForFunction((n) => window.__x = document.querySelectorAll('#crm-drawer .kv dd').length > 0 && n, 1, { timeout: 5000 });
    await page.waitForFunction(() => /הפגישה נשמר/.test(document.querySelector('#crm-toast').textContent), null, { timeout: 5000 });
    const m = srv.saves[srv.saves.length - 1].leads[0];
    assert.deepEqual([m.visitDate, m.visitTime, m.meetingWith, m.stage], [TODAY, '11:30', 'אמבולטורי', 'visit']);
    assert.match(await page.textContent('#crm-drawer'), /11:30/);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); srv.close(); }
});

test('C5 lead lifecycle (Vered): new lead form validates and posts one new row; close moves the lead to «לידים סגורים»; restore brings it back; remove', { skip: skip && 'playwright/chromium missing' }, async () => {
  const srv = await boot();
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  try {
    const { page, errors } = await open(browser, srv.port, 'vered', 1366);
    await page.click('#crm-nav button[data-area="leads"]');
    // new lead: validation first
    await page.click('#crm-new-lead');
    await page.waitForSelector('#crm-drawer form[data-form="new-lead"]');
    await page.fill('[name="name"]', 'נועה');
    await page.fill('[name="phone"]', '052');
    await page.click('form[data-form="new-lead"] button[type="submit"]');
    assert.match(await page.textContent('[data-err="name"]'), /שם מלא/);
    assert.match(await page.textContent('[data-err="phone"]'), /טלפון/);
    assert.equal(srv.saves.length, 0, 'nothing posted while invalid');
    await page.fill('[name="name"]', 'נועה שמש');
    await page.fill('[name="phone"]', '052-999-8877');
    await page.selectOption('[name="assignedTo"]', 'ורד');
    await page.selectOption('[name="house"]', 'רמות השבים');
    await page.fill('[name="source"]', 'המלצה');
    await page.click('form[data-form="new-lead"] button[type="submit"]');
    await page.waitForFunction(() => /נוסף/.test(document.querySelector('#crm-toast') ? document.querySelector('#crm-toast').textContent : ''), null, { timeout: 5000 });
    const created = srv.saves[0];
    assert.equal(created.action, 'saveAll'); assert.equal(created.leads.length, 1); assert.deepEqual(created.patients, {});
    assert.deepEqual([created.leads[0].name, created.leads[0].phone, created.leads[0].stage, created.leads[0].assignedTo, created.leads[0].house, created.leads[0].created], ['נועה שמש', '0529998877', 'new', 'ורד', 'רמות השבים', TODAY]);
    assert.match(created.leads[0].id, /^id-[0-9a-f]{16}$/);
    assert.equal(await page.getAttribute('#crm-drawer', 'aria-hidden'), 'true');
    assert.ok(await page.$('.col:nth-child(1) .card[data-open-lead="' + created.leads[0].id + '"]'), 'on the board in «ליד חדש»');
    // close from the drawer
    await page.click('.card[data-open-lead="L1"] .name');
    await page.waitForSelector('#crm-drawer[aria-hidden="false"]');
    await page.click('#crm-drawer details.act summary:has-text("סגירת ליד")');
    await page.selectOption('form[data-form="close"] [name="disposition"]', 'completed');
    await page.fill('form[data-form="close"] [name="note"]', 'סיים');
    await page.click('form[data-form="close"] button[type="submit"]');
    await page.waitForFunction(() => /נסגר/.test(document.querySelector('#crm-toast').textContent), null, { timeout: 5000 });
    const closed = srv.saves[1];
    assert.equal(closed.action, 'moveLeadIrrelevant');
    assert.deepEqual([closed.lead.id, closed.lead.stage, closed.lead.originSheet, closed.lead.disposition, closed.lead.not_relevant_note], ['L1', 'irrelevant', 'new', 'completed', 'סיים']);
    assert.equal(await page.$('.card[data-open-lead="L1"]'), null, 'off the board');
    // closed list + restore
    await page.click('button[data-view="closed"]');
    assert.match(await page.textContent('#crm-main'), /אבי לוי/);
    assert.match(await page.textContent('#crm-main'), /סיים טיפול/);
    await page.click('[data-restore-lead="L1"]');
    await page.waitForFunction(() => /שוחזר/.test(document.querySelector('#crm-toast').textContent), null, { timeout: 5000 });
    assert.equal(srv.saves[2].action, 'restoreLead');
    await page.click('button[data-view="board"]');
    assert.ok(await page.$('.col:nth-child(1) .card[data-open-lead="L1"]'), 'back in its origin stage');
    // remove (confirm dialog accepted)
    page.once('dialog', (d) => d.accept());
    await page.click('.card[data-open-lead="L4"] .name');
    await page.waitForSelector('#crm-drawer[aria-hidden="false"]');
    await page.click('#crm-drawer details.act summary:has-text("סגירת ליד")');
    await page.click('[data-remove-lead="L4"]');
    await page.waitForFunction(() => /הוסר/.test(document.querySelector('#crm-toast').textContent), null, { timeout: 5000 });
    assert.equal(srv.saves[3].action, 'removeLead'); assert.equal(srv.saves[3].lead.id, 'L4');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); srv.close(); }
});

test('C6 admission + direct add (Vered, finance): «קליטה לבית» posts the house as read + the new patient + the admitted lead, then the funder; direct add posts patient + dl- lead', { skip: skip && 'playwright/chromium missing' }, async () => {
  const srv = await boot();
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  try {
    const { page, errors } = await open(browser, srv.port, 'vered', 1366);
    await page.click('#crm-nav button[data-area="leads"]');
    await page.click('.card[data-open-lead="L4"] .name');          // L4 is in «בטיפול פעיל»
    await page.waitForSelector('#crm-drawer form[data-form="admit"]');
    await page.click('form[data-form="admit"] button[type="submit"]');
    assert.match(await page.textContent('[data-err="pay"]'), /סכום/);
    assert.match(await page.textContent('[data-err="funder"]'), /מממן/);
    assert.equal(srv.saves.length, 0);
    await page.fill('form[data-form="admit"] [name="pay"]', '28000');
    await page.selectOption('form[data-form="admit"] [name="status"]', 'active');
    await page.selectOption('form[data-form="admit"] [name="funder"]', 'פרטי');
    await page.click('form[data-form="admit"] button[type="submit"]');
    await page.waitForFunction(() => /הקליטה/.test(document.querySelector('#crm-toast') ? document.querySelector('#crm-toast').textContent : ''), null, { timeout: 5000 });
    await page.waitForFunction(() => window.__ok = true, null, { timeout: 2000 }).catch(() => {});
    const admit = srv.saves.find((b) => b.action === 'saveAll');
    assert.deepEqual(Object.keys(admit.patients), ['ramot'], 'one house only');
    assert.deepEqual(admit.patients.ramot.map((p) => p.id).slice(0, 1), ['p1'], 'the house as read comes first');
    const np = admit.patients.ramot[admit.patients.ramot.length - 1];
    assert.deepEqual([np.name, np.fromLead, np.source, np.pay, np.status, np.date], ['טל ברק', 'L4', 'lead', 28000, 'active', TODAY]);
    assert.deepEqual([admit.leads[0].id, admit.leads[0].stage, admit.leads[0].entryDate], ['L4', 'admitted', TODAY]);
    assert.deepEqual(admit.prove, { patients: [np.id], leads: ['L4'] });
    await page.waitForFunction(() => true, null, { timeout: 500 }).catch(() => {});
    const funder = srv.saves.find((b) => b.action === 'appendFunder');
    assert.deepEqual([funder.funder.patientId, funder.funder.funder, funder.funder.effectiveFrom], [np.id, 'פרטי', TODAY]);
    assert.equal(await page.$('.card[data-open-lead="L4"]'), null, 'the admitted lead leaves the board');
    await page.click('#crm-nav button[data-area="clients"]');
    assert.match(await page.textContent('#crm-main'), /טל ברק/, 'and the patient is in «מטופלים»');
    // direct add
    await page.click('#crm-direct-add');
    await page.waitForSelector('form[data-form="direct-add"]');
    await page.fill('form[data-form="direct-add"] [name="name"]', 'רונית פרץ');
    await page.fill('form[data-form="direct-add"] [name="phone"]', '050-333-4444');
    await page.selectOption('form[data-form="direct-add"] [name="houseId"]', 'rehab');
    await page.fill('form[data-form="direct-add"] [name="pay"]', '21000');
    await page.selectOption('form[data-form="direct-add"] [name="funder"]', 'מכבי');
    await page.click('form[data-form="direct-add"] button[type="submit"]');
    await page.waitForFunction(() => /הוספת/.test(document.querySelector('#crm-toast').textContent), null, { timeout: 5000 });
    const da = srv.saves.filter((b) => b.action === 'saveAll')[1];
    assert.deepEqual(Object.keys(da.patients), ['rehab']);
    const dp = da.patients.rehab[da.patients.rehab.length - 1];
    assert.deepEqual([dp.name, dp.source, dp.fromLead, dp.pay], ['רונית פרץ', 'direct_admin', 'dl-' + dp.id, 21000]);
    assert.deepEqual([da.leads[0].id, da.leads[0].source, da.leads[0].stage, da.leads[0].phone], ['dl-' + dp.id, 'direct_approach', 'admitted', '0503334444']);
    assert.match(await page.textContent('#crm-main'), /רונית פרץ/);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); srv.close(); }
});

test('C7 patient actions (Vered): edit posts the house as read with the changed row; move posts the TARGET house with movedFrom; discharge posts the audit row then the released row', { skip: skip && 'playwright/chromium missing' }, async () => {
  const srv = await boot();
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  try {
    const { page, errors } = await open(browser, srv.port, 'vered', 1366);
    await page.click('#crm-nav button[data-area="clients"]');
    // edit
    await page.click('tr[data-open-patient="p1"]');
    await page.waitForSelector('#crm-drawer[aria-hidden="false"] form[data-form="patient-edit"]', { state: 'attached' });
    await page.click('#crm-drawer details.act summary:has-text("עריכה")');
    await page.fill('form[data-form="patient-edit"] [name="pay"]', '31000');
    await page.selectOption('form[data-form="patient-edit"] [name="status"]', 'trial');
    await page.fill('form[data-form="patient-edit"] [name="notes"]', 'הערה חדשה');
    await page.click('form[data-form="patient-edit"] button[type="submit"]');
    await page.waitForFunction(() => /העריכה/.test(document.querySelector('#crm-toast') ? document.querySelector('#crm-toast').textContent : ''), null, { timeout: 5000 });
    const edit = srv.saves[0];
    assert.equal(edit.action, 'saveAll'); assert.deepEqual(Object.keys(edit.patients), ['ramot']);
    const e1 = edit.patients.ramot.find((p) => p.id === 'p1');
    assert.deepEqual([e1.pay, e1.status, e1.notes, e1.name], [31000, 'trial', 'הערה חדשה', 'דנה כהן']);
    assert.deepEqual(edit.prove, { patients: ['p1'] });
    // move → asher (confirm accepted)
    page.once('dialog', (d) => d.accept());
    await page.click('tr[data-open-patient="p1"]');
    await page.waitForSelector('#crm-drawer[aria-hidden="false"] form[data-form="patient-move"]', { state: 'attached' });
    await page.click('#crm-drawer details.act summary:has-text("העברה")');
    await page.selectOption('form[data-form="patient-move"] [name="toHouseId"]', 'asher');
    await page.click('form[data-form="patient-move"] button[type="submit"]');
    await page.waitForFunction(() => /ההעברה/.test(document.querySelector('#crm-toast').textContent), null, { timeout: 5000 });
    const mv = srv.saves[1];
    assert.deepEqual(Object.keys(mv.patients), ['asher'], 'only the TARGET house travels');
    const moved = mv.patients.asher.find((p) => p.id === 'p1');
    assert.deepEqual([moved.houseId, moved.movedFrom], ['asher', 'ramot']);
    assert.match(await page.textContent('tr[data-open-patient="p1"]'), /רעננה אשר/);
    // discharge → released_outpatient: audit row, then the released row, then the handoff
    await page.click('tr[data-open-patient="p1"]');
    await page.waitForSelector('#crm-drawer[aria-hidden="false"] form[data-form="discharge"]', { state: 'attached' });
    await page.click('#crm-drawer details.act summary:has-text("שחרור")');
    await page.click('form[data-form="discharge"] button[type="submit"]');
    assert.match(await page.textContent('[data-err="disposition"]'), /סטטוס/);
    await page.selectOption('form[data-form="discharge"] [name="disposition"]', 'released_outpatient');
    await page.selectOption('form[data-form="discharge"] [name="continuity"]', 'continued_outpatient');
    await page.fill('form[data-form="discharge"] [name="note"]', 'עובר לאמבולטורי');
    await page.click('form[data-form="discharge"] button[type="submit"]');
    await page.waitForFunction(() => /שוחרר/.test(document.querySelector('#crm-toast').textContent) || /אמבולטורי|נכשלה/.test(document.querySelector('#crm-toast').textContent), null, { timeout: 8000 });
    const dis = srv.saves.find((b) => b.action === 'dischargePatient');
    assert.deepEqual([dis.patient.patientId, dis.patient.status, dis.patient.prior_status, dis.patient.disposition, dis.patient.continuity, dis.patient.discharge_note, dis.patient.exitDate], ['p1', 'released', 'trial', 'released_outpatient', 'continued_outpatient', 'עובר לאמבולטורי', TODAY]);
    assert.match(dis.patient.id, /^id-[0-9a-f]{16}$/, 'its own fresh audit id');
    const flip = srv.saves.filter((b) => b.action === 'saveAll')[2];
    const rel = flip.patients.asher.find((p) => p.id === 'p1');
    assert.deepEqual([rel.status, rel.exitDate], ['released', TODAY]);
    assert.equal(await page.$('tr[data-open-patient="p1"]'), null, 'left «מטופלים»');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); srv.close(); }
});
