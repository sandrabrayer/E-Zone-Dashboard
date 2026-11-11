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

const pinHash = require('../lib/pin-hash');
const users = require('../lib/users');
const { createSessionToken } = require('../lib/session');
const SERVER_PATH = require.resolve('../server');
const PEPPER = 'pepper-TEST-crm-shell-browser-0123456789abcdef';
const SESSION_SECRET = 'session-secret-TEST-crm-shell-browser-012345';
const PROXY_SECRET = 'proxy-secret-TEST-crm-shell-browser-0123456789';
const ENV_KEYS = ['PROXY_SECRET', 'SESSION_SECRET', 'SHEETS_URL', 'USER_PIN_HASHES', 'PIN_PEPPER', 'CRM_ENABLED', 'SHEETS_READ_CACHE_MS'];
const israelDay = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date(ms));
const TODAY = israelDay(Date.now());
const daysAgo = (n) => israelDay(Date.now() - n * 86400000);

const DATA = {
  ok: true, irrelevantLeads: [], removedLeads: [], billingOverrides: [], houseManagers: {}, managerPhones: {}, currentManagers: [], outpatientSentLeadIds: [],
  dischargedPatients: [{ id: 'dx1', patientId: 'px', name: 'נועה לוי', houseId: 'ramot', date: daysAgo(60), exitDate: daysAgo(5), dischargedAt: daysAgo(5) + 'T09:00:00.000Z', disposition: 'released_outpatient', continuity: 'שחר', prior_status: 'active', fromLead: 'LX' }],
  leads: [
    { id: 'L1', name: 'אבי לוי', house: 'רמות השבים', stage: 'new', created: daysAgo(5), assignedTo: 'ורד', phone: '0501111111', source: 'פייסבוק' },
    { id: 'L2', name: 'גלי כהן', house: 'ramot', stage: 'visit', visitDate: TODAY, visitTime: '13:30', meetingWith: 'אורן', created: daysAgo(2) },
    { id: 'L3', name: 'דנה מזרחי', house: 'רעננה הפרדס', stage: 'visit', visitDate: daysAgo(3), meetingWith: 'חן', created: daysAgo(6) },
    { id: 'L5', name: 'רון אביב', house: 'קיסריה ריהאב', stage: 'visit', visitDate: daysAgo(4), meetingWith: 'רנטה', created: daysAgo(9), meetingReportOutcome: 'undecided', meetingCompanion: 'father', meetingNote: 'רוצה לחשוב', meetingReporter: 'רנטה', meetingReportedAt: daysAgo(2) + 'T07:00:00.000Z', meetingSeen: '' },
    { id: 'L4', name: 'טל ברק', house: 'רמות השבים', stage: 'paid', created: daysAgo(10), assignedTo: 'ורד' },
    { id: 'L6', name: 'מאיה שגב', house: 'קיסריה עפרוני', stage: 'new', created: daysAgo(1), assignedTo: 'דנה', phone: '0506666666' },
  ],
  patients: { ramot: [{ id: 'p1', name: 'דנה כהן', date: daysAgo(30), status: 'active', pay: 6000 }, { id: 'px', name: 'נועה לוי', date: daysAgo(60), status: 'released', exitDate: daysAgo(5), fromLead: 'LX' }], rehab: [{ id: 'p2', name: 'אבי', date: daysAgo(7), status: 'active' }] },
};
const QUEUE = { ok: true, receipts: [{ id: 'r1', confirmStatus: 'reported', patientName: 'דנה כהן', houseId: 'ramot', amount: 2500, receivedDate: daysAgo(1), recordedBy: 'ורד', method: 'העברה' }, { id: 'r2', confirmStatus: 'flagged', patientName: 'אבי', houseId: 'rehab', amount: 900, receivedDate: daysAgo(6), recordedBy: 'ורד', flagNote: 'הסכום לא תואם' }] };
const DEBT = { ok: true, asOf: TODAY,
  totals: { recorded_debt: { count: 1, total: 6000, d0_7: 0, d8_30: 0, d31_60: 0, d61_plus: 6000 }, unrecorded_cycles: { count: 1, total: 5000, d0_7: 5000, d8_30: 0, d31_60: 0, d61_plus: 0 } },
  byHouse: [{ houseId: 'ramot', recorded_debt: { count: 1, total: 6000 }, unrecorded_cycles: { count: 1, total: 5000 } }],
  byPatient: [{ patientId: 'p1', patientKey: 'ramot::דנה כהן::' + daysAgo(30), name: 'דנה כהן', houseId: 'ramot', status: 'active', inHouseAtAsOf: true, cycles: [
    { start: daysAgo(70), end: daysAgo(41), expected: 6000, received: 2500, balance: 3500, days: 70, kind: 'recorded', paymentId: 'cyc-1', month: daysAgo(70).slice(0, 7) },
    { start: daysAgo(3), end: daysAgo(-26), expected: 5000, received: 0, balance: 5000, days: 3, kind: 'unrecorded', month: daysAgo(3).slice(0, 7), discount: 0 }] }],
  detachedPayments: { count: 1, rows: [{ paymentId: 'pay::ramot::דנה כהן ::x::' + daysAgo(40), patientName: 'דנה כהן ', houseId: 'ramot', dueDate: daysAgo(40), amount: 6000, receivedByAsOf: 6000, reason: 'unmatched' }] }, pendingCredits: { count: 0, total: 0 }, funderGrace: { count: 0, amount: 0 } };
const PAYMENTS = { ok: true, payments: [{ id: 'pay::ramot::דנה כהן ::x::' + daysAgo(40), patientId: 'ramot::דנה כהן ::x', patientName: 'דנה כהן ', houseId: 'ramot', dueDate: daysAgo(40), amount: 6000, amountPaid: 6000, status: 'paid' }, { id: 'cyc-1', patientId: 'ramot::דנה כהן::' + daysAgo(30), patientUid: 'p1', patientName: 'דנה כהן', houseId: 'ramot', dueDate: daysAgo(70), amount: 6000, amountPaid: 2500, balance: 3500, status: 'partial', coverageStart: daysAgo(70), coverageEnd: daysAgo(41) }],
  receipts: [{ id: 'rcpt-1', patientId: 'ramot::דנה כהן::' + daysAgo(30), patientUid: 'p1', patientName: 'דנה כהן', houseId: 'ramot', dueDate: daysAgo(70), receivedDate: daysAgo(4), amount: 2500, method: 'ביט', payer: 'אמא', reference: '', funder: 'פרטי', coverageStart: daysAgo(70), coverageEnd: daysAgo(41), invoiceWanted: 'no', invoiceTo: '', confirmStatus: 'reported' }],
  funders: [{ patientId: 'p1', funder: 'משרד הביטחון', effectiveFrom: daysAgo(30), setBy: 'ורד' }] };
/* «זיכויים לתשלום» as the server lists them (CHANGELOG-cashflow-refunds.md): one saved credit due today, one computed line overdue. */
const REFUND_FORECAST = { ok: true, today: TODAY, toPay: { count: 2, total: 1734, rows: [
  { creditId: 'cr-9', auto: false, patientName: 'דנה כהן', houseId: 'ramot', amount: 1234, payoutDate: TODAY, creditType: 'days_unused' },
  { creditId: '', auto: true, patientName: 'גל רון', houseId: 'asher', amount: 500, payoutDate: '2026-01-15', creditType: 'prepaid_return' }] } };
const CREDITS = { ok: true, credits: [
  { id: 'cr-1', patientId: 'p1', patientKey: 'ramot::דנה כהן::' + daysAgo(30), patientName: 'דנה כהן', houseId: 'ramot', creditType: 'days_unused', allocationMonth: daysAgo(40).slice(0, 7), amount: 1200, status: 'pending', payoutDate: daysAgo(10) },
  { id: 'cr-2', patientId: 'p2', patientKey: 'rehab::אבי::' + daysAgo(7), patientName: 'אבי', houseId: 'rehab', creditType: 'other', allocationMonth: daysAgo(40).slice(0, 7), amount: 300, status: 'paid', paidDate: daysAgo(2), method: 'ביט' }] };
const ACTIVITY = { ok: true, scope: 'full', total: 1, events: [{ eventId: 'x', occurredAt: '2026-10-20T09:00:00.000Z', kind: 'lead_created', source: 'system:x', actorName: 'ורד', summary: 'הליד נוצר', details: {} }] };

const TASKS = { ok: true, total: 2, tasks: [
  { id: 'task-' + '1'.repeat(32), kind: 'call', leadId: 'L1', title: 'לחזור למשפחה', reason: 'ביקשו שנחזור', assignee: 'ורד', dueDate: daysAgo(2), dueTime: '', status: 'open', source: 'contact', createdBy: 'ורד' },
  { id: 'task-' + '2'.repeat(32), kind: 'review', patientId: 'p1', title: 'לבדוק מסמכים', reason: '', assignee: 'ורד', dueDate: TODAY, dueTime: '10:00', status: 'open', source: 'manual', createdBy: 'ורד' }] };
const INDEX = { ok: true, count: 1, leads: { L3: { at: '2026-10-20T09:00:00.000Z', outcome: 'no_answer', channel: 'phone', actorName: 'ורד', summary: '', noNext: '' } }, patients: {} };
let tasksAnswer = null;
let indexAnswer = null;
let saveAnswer = null;
async function boot(options = {}) {
  const saves = [];
  // One synthetic authoritative Credits ledger shared by all test sessions;
  // identity-specific source saves become visible after the next getCredits.
  const creditsLedger = JSON.parse(JSON.stringify(CREDITS));
  function syntheticRefund(parsed) {
    const row = creditsLedger.credits.filter((c) => c.id === parsed.creditId)[0];
    if (!row) return { ok: false, error: 'unknown_credit' };
    if (parsed.action === 'requestRefundPayoutApproval') {
      if (parsed.proxyUserId !== 'vered') return { ok: false, error: 'forbidden_role' };
      row.payoutApprovalRequestedBy = 'vered';
      row.payoutApprovalRequestedAt = '2026-11-03T10:00:00.000Z';
      row.payoutApprovalAmount = row.amount;
      row.payoutApprovedBy = '';
      row.payoutApprovedAt = '';
      return { ok: true, credit: { id: row.id, payoutApprovalRequestedAt: row.payoutApprovalRequestedAt } };
    }
    if (parsed.action === 'approveRefundPayout') {
      if (parsed.proxyUserId !== 'sandra' || row.payoutApprovalRequestedBy !== 'vered')
        return { ok: false, error: 'request_required' };
      row.payoutApprovedBy = 'sandra';
      row.payoutApprovedAt = '2026-11-03T10:05:00.000Z';
      return { ok: true, credit: { id: row.id, payoutApprovedAt: row.payoutApprovedAt } };
    }
    if (parsed.action === 'settleRefund') {
      if (parsed.proxyUserId !== 'ortal' || row.payoutApprovedBy !== 'sandra' ||
          Number(row.payoutApprovalAmount) !== Number(row.amount))
        return { ok: false, error: 'approval_required' };
      row.status = 'paid'; row.paidDate = parsed.paidDate; row.method = parsed.method;
      return { ok: true, credit: { id: row.id, status: 'paid', paidDate: row.paidDate } };
    }
    return { ok: false, error: 'unknown_refund_action' };
  }
  const hash = await pinHash.hashPin('583920', PEPPER);
  const recs = ['vered', 'sandra', 'ortal', 'dana'].map((id) => JSON.parse(users.recordLine(id, hash, 1)));
  const env = { PROXY_SECRET, SESSION_SECRET, SHEETS_URL: 'https://script.google.com/macros/s/TEST/exec', PIN_PEPPER: PEPPER, USER_PIN_HASHES: JSON.stringify(recs), CRM_ENABLED: 'true', SHEETS_READ_CACHE_MS: String(options.readCacheMs === undefined ? 30000 : options.readCacheMs) };
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
      if (parsed.action === 'saveCredit') saves.push(parsed);
      if (['moveLeadIrrelevant', 'removeLead', 'restoreLead', 'appendFunder', 'dischargePatient', 'reportPayment', 'setBillingDiscount', 'upsertBillingOverride', 'requestRefundPayoutApproval', 'approveRefundPayout', 'settleRefund', 'editReceipt', 'savePayment', 'restorePatient', 'restorePatientToActive'].indexOf(parsed.action) >= 0) saves.push(parsed);
      if (['logContact', 'createTask', 'completeTask', 'rescheduleTask', 'reassignTask', 'withdrawTask', 'logLeadFlag'].indexOf(parsed.action) >= 0) saves.push(parsed);
      const answer = parsed.action === 'getData' ? DATA : parsed.action === 'billingControlQueue' ? QUEUE : parsed.action === 'getActivity' ? ACTIVITY
        : parsed.action === 'getTasks' ? (tasksAnswer ? tasksAnswer() : (parsed.status === 'open' && parsed.proxyUserId !== 'ortal' ? TASKS : { ok: true, total: 0, tasks: [] }))   // Code.gs scopes Ortal to money tasks (none in the fixture)
        : parsed.action === 'contactIndex' ? (indexAnswer ? indexAnswer() : INDEX)
        : parsed.action === 'logContact' ? (saveAnswer ? saveAnswer(parsed) : { ok: true, event: { eventId: 'contact:' + parsed.submissionId }, completed: null, created: parsed.next && !parsed.next.none ? Object.assign({ id: 'task-x' }, parsed.next) : null })
        : ['createTask', 'completeTask', 'rescheduleTask', 'reassignTask', 'withdrawTask'].indexOf(parsed.action) >= 0 ? (saveAnswer ? saveAnswer(parsed) : { ok: true, task: { id: parsed.id || 'task-new' } })
        : parsed.action === 'logLeadFlag' ? (saveAnswer ? saveAnswer(parsed) : { ok: true, flag: Object.assign({ at: new Date().toISOString(), actorName: 'ורד' }, parsed.flag) })
        : parsed.action === 'debtAging' ? (options.debt || DEBT) : parsed.action === 'getPayments' ? PAYMENTS : parsed.action === 'getCredits' ? creditsLedger
        : parsed.action === 'refundPayoutForecast' ? (options.refunds || REFUND_FORECAST)
        : parsed.action === 'restorePatientToActive' ? (saveAnswer ? saveAnswer(parsed) : { ok: true, restoredToActive: true, id: parsed.patient && parsed.patient.id })
        : parsed.action === 'restorePatient' ? (saveAnswer ? saveAnswer(parsed) : { ok: true, restored: true, lead: { id: parsed.patient && parsed.patient.newLeadId } })
        : parsed.action === 'editReceipt' ? (saveAnswer ? saveAnswer(parsed) : { ok: true, receipt: { id: parsed.edit && parsed.edit.id } })
        : parsed.action === 'savePayment' ? (saveAnswer ? saveAnswer(parsed) : { ok: true, payment: { id: parsed.payment && parsed.payment.id, status: parsed.payment && parsed.payment.status, linkStatus: parsed.payment && parsed.payment.linkStatus } })
        : parsed.action === 'saveCredit' ? (saveAnswer ? saveAnswer(parsed) : { ok: true, credit: Object.assign({}, parsed.credit, { id: (parsed.credit && parsed.credit.id) || 'cr-new' }) })
        : parsed.action === 'setBillingDiscount' ? (saveAnswer ? saveAnswer(parsed) : { ok: true })
        : parsed.action === 'upsertBillingOverride' ? (saveAnswer ? saveAnswer(parsed) : { ok: true, override: { id: parsed.override && parsed.override.id } })
        : ['requestRefundPayoutApproval', 'approveRefundPayout', 'settleRefund'].indexOf(parsed.action) >= 0
          ? (saveAnswer ? saveAnswer(parsed) : syntheticRefund(parsed))
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
  return { port: srv.address().port, actions, saves, close() { saveAnswer = null; tasksAnswer = null; indexAnswer = null; srv.close(); https.request = original; Object.assign(console, quiet); } };
}

async function open(browser, port, id, width) {
  const ctx = await browser.newContext({ viewport: { width, height: 800 }, locale: 'he-IL', timezoneId: 'Asia/Jerusalem', serviceWorkers: 'block' });
  const name = users.modelById(id).name;
  await ctx.addCookies([{ name: 'ezone_session', value: createSessionToken(SESSION_SECRET, undefined, undefined, name, { id, pinVersion: 1 }), url: `http://127.0.0.1:${port}` }]);
  const page = await ctx.newPage();
  // Synthetic acceptance must never send browser traffic outside this fixture.
  await ctx.route('**/*', route => new URL(route.request().url()).origin === `http://127.0.0.1:${port}` ? route.continue() : route.abort());
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
    assert.deepEqual(await page.$$eval('#crm-nav button span:first-child', (els) => els.map((e) => { const c = e.cloneNode(true); const i = c.querySelector('.ic'); if (i) i.remove(); return c.textContent.trim(); })), ['היום שלי', 'בקרת עבודה', 'לידים', 'מטופלים', 'יומן', 'תפוסה', 'גבייה', 'KPI'], 'grouped nav (spec §3; «פניות» → «לידים» 04/11/2026; «בקרת עבודה» next to «היום שלי» + «KPI» 05/11/2026)');
    assert.deepEqual(await page.$$eval('#crm-nav .nav-group', (els) => els.map((e) => e.textContent)), ['לידים ומטופלים', 'פגישות ויומן', 'בתים והמשך טיפול', 'כספים', 'דוחות והגדרות']);
    assert.equal(await page.$eval('body', (b) => getComputedStyle(b).backgroundColor), 'rgb(230, 236, 242)', 'light theme (contrast pass)');
    assert.ok(await page.isVisible('#crm-menu'));
    assert.ok(!(await page.isVisible('#crm-burger')), 'no burger on desktop');
    assert.equal(await page.$eval('#crm-user', (e) => e.textContent), 'ורד');
    // «היום שלי» (Stage 2): the five cards, the urgent band, the domains, the side column
    await page.waitForSelector('.kpis.cards');
    assert.deepEqual(await page.$$eval('.kpis.cards .kpi .l', (els) => els.map((e) => e.textContent)), ['גבייה לביצוע', 'שיחות ומעקבים', 'פגישות היום', 'המשך טיפול לאחר פגישות', 'לידים חדשים ללא מגע']);
    const main = await page.textContent('#crm-main');
    // a missing manager report is late only 3 days after the meeting (CHANGELOG-crm-vered-feedback-1104.md): L3 met 3 days ago
    assert.match(main, /דיווח המנהל\/ת באיחור/, 'a meeting 3 days ago without a report is now late');
    assert.match(main, /3 ימים ללא דיווח המנהל\/ת/);
    assert.match(main, /אין מגע מתועד/); assert.match(main, /מאיה שגב/, 'a new lead with no documented contact and no open call');
    assert.ok(!/לידים חדשים ללא מגע[\s\S]*אבי לוי[\s\S]*שיחות ומעקבים/.test(main), 'a lead with an open call task is in «שיחות», not in «ללא מגע»');
    assert.ok(!/ממתין \d+ ימים/.test(main), 'no lateness by lead age');
    assert.match(await page.textContent('.day-side'), /פגישות היום/); assert.match(await page.textContent('.day-side'), /גלי כהן/);
    assert.equal(await page.locator('#crm-main section.urgent').count(), 0, 'no «חריגים דחופים» band (Vered 04/11/2026)');
    assert.match(await page.textContent('.day-main'), /לקרוא דיווח מנהל/, 'the unseen report is in its domain');
    await page.click('.kpi[data-domain="newleads"]');
    assert.ok(!/גלי כהן/.test(await page.textContent('.day-main')), 'a card filters to its domain');
    assert.match(await page.textContent('.day-main'), /מאיה שגב/);
    assert.equal(await page.$eval('.kpi[data-domain="newleads"] .v', (e) => e.textContent), '1');
    await page.click('.kpi[data-domain="newleads"]');
    // «פניות»: board, filter, table keeps the filter
    await page.click('#crm-nav button[data-area="leads"]');
    assert.equal(await page.$$eval('.col', (els) => els.length), 4);
    if (process.env.CRM_SHOT) await page.screenshot({ path: process.env.CRM_SHOT + '/board-1366.png', fullPage: false });
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
    if (process.env.CRM_SHOT) await page.screenshot({ path: process.env.CRM_SHOT + '/clients-1366.png', fullPage: false });
    assert.match(await page.textContent('table.clients'), /פעיל/, 'status as a word, never the raw id');
    assert.ok(!/\bactive\b/.test(await page.textContent('table.clients')));
    assert.equal(await page.$$eval('table.clients .chip.house', (els) => els.length) > 0, true, 'house tag');
    await page.click('table.clients tr[data-open-patient="p1"] td.name');
    await page.waitForSelector('#crm-drawer[aria-hidden="false"]');
    assert.match(await page.textContent('#crm-drawer .drawer-head'), /פעיל/); assert.match(await page.textContent('#crm-drawer [data-pane="overview"]'), /ימים בבית/);
    assert.ok(!/\bactive\b|id-/.test(await page.textContent('#crm-drawer [data-pane="overview"] .kv')), 'no raw ids / statuses in the card');
    await page.keyboard.press('Escape');
    await page.click('#crm-nav button[data-area="calendar"]');
    assert.match(await page.textContent('#crm-main'), /גלי כהן/);
    await page.click('#crm-nav button[data-area="billing"]');
    await page.waitForSelector('#crm-debtors');
    await page.click('#crm-nav button[data-area="control"]');
    assert.match(await page.textContent('#crm-main'), /פגישות שעברו ללא דיווח/);
    // every control number opens its list (clickable KPIs)
    await page.click('.kpi.acc-unseen');
    assert.equal(await page.textContent('#crm-title'), 'היום שלי');
    assert.match(await page.textContent('[data-control-section="unseen"]'), /רון אביב/, 'the exact unread-report list');
    await page.click('#crm-nav button[data-area="control"]');
    await page.click('.kpi.acc-noContact');
    assert.equal(await page.textContent('#crm-title'), 'רשומות שדורשות בירור');
    // גבייה tiles filter the debtors / receipts
    await page.click('#crm-nav button[data-area="billing"]');
    await page.waitForSelector('#crm-debtors');
    await page.click('button.kpi[data-billing-filter="d61_plus"]');
    assert.match(await page.textContent('#crm-debtors-title'), /סינון: 61\+ ימים/);
    assert.equal(await page.$$eval('#crm-debtors tbody tr', (els) => els.length), 1);
    await page.click('button.kpi[data-billing-filter="d0_7"]');
    assert.match(await page.textContent('#crm-main'), /אין חובות בטווח הזה/);
    await page.click('#crm-debtors-title button.chip');
    assert.ok(!/סינון:/.test(await page.textContent('#crm-debtors-title')));
    await page.click('button.kpi[data-billing-filter="toVerify"]');
    assert.match(await page.textContent('#crm-receipts-title'), /הממתינים לאימות/);
    await page.click('#crm-nav button[data-area="control"]');
    assert.ok(await noHScroll(page), 'no horizontal page scroll');
    assert.deepEqual(errors, []);
    assert.deepEqual([...new Set(srv.actions.map((a) => a.action))].sort(), ['contactIndex', 'debtAging', 'getActivity', 'getCredits', 'getData', 'getPayments', 'getTasks', 'refundPayoutForecast'], 'reads only, no queue for Vered');
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
    assert.equal(await page.textContent('#crm-title'), 'לידים');
    assert.ok(await noHScroll(page), 'no horizontal page scroll at 390');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); srv.close(); }
});

test('CRM shell (Ortal, controller): only היום שלי / גבייה / בקרה; her day comes from billingControlQueue; no lead data requested', { skip: skip && 'playwright/chromium missing' }, async () => {
  const srv = await boot();
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  try {
    const { page, errors } = await open(browser, srv.port, 'ortal', 1366);
    assert.deepEqual(await page.$$eval('#crm-nav button span:first-child', (els) => els.map((e) => { const c = e.cloneNode(true); const i = c.querySelector('.ic'); if (i) i.remove(); return c.textContent.trim(); })), ['היום שלי', 'בקרת עבודה', 'גבייה']);
    // she lands on «גבייה» (CHANGELOG-ortal-crm-default.md); «היום שלי» is one tap away
    await page.waitForSelector('#crm-fc-title', { timeout: 8000 });
    assert.equal(await page.getAttribute('#crm-controller-classic a', 'href'), '/?view=classic');
    await page.click('#crm-nav button[data-area="today"]');
    await page.waitForFunction(() => document.querySelector('.kpis.cards') && /דיווחים לאימות/.test(document.querySelector('#crm-main').textContent) && !/טוען…/.test(document.querySelector('.kpis.cards').textContent), null, { timeout: 8000 });
    assert.deepEqual(await page.$$eval('.kpis.cards .kpi .l', (els) => els.map((e) => e.textContent)), ['דיווחים לאימות', 'אימותים חלקיים / לבירור', 'חשבוניות מבוקשות', 'משימות כספיות שלך', 'זיכויים לתשלום'], 'Ortal: verification / gaps / documents / control (spec §5)');
    assert.deepEqual(await page.$$eval('.kpis.cards .kpi .v', (els) => els.map((e) => e.textContent)), ['1', '1', '0', '0', '1'], 'reported ×1, flagged ×1, no requested invoice, no money task in the fixture, one pending credit');
    assert.match(await page.textContent('.urgent'), /סומן לבירור/, 'the flagged receipt waits for her decision');
    assert.match(await page.textContent('#crm-main'), /ההנפקה אינה נרשמת כאן/, 'document issuance is not claimed');
    assert.ok(!/אבי לוי/.test(await page.textContent('#crm-main')), 'no lead names in her view');
    assert.deepEqual(errors, []);
    assert.ok(srv.actions.some((a) => a.action === 'billingControlQueue' && a.user === 'ortal'));
    assert.deepEqual([...new Set(srv.actions.map((a) => a.action))].sort(), ['billingControlQueue', 'debtAging', 'getCredits', 'getData', 'getPayments', 'getTasks', 'refundPayoutForecast'], 'her reads: the queue, her money tasks, the credits and the «גבייה» reads she lands on — never a lead read or a write');
  } finally { await browser.close(); srv.close(); }
});

test('C8 גבייה read-only (Vered + Ortal): debtAging + getPayments fetched on first open only; KPIs, debtors, receipts; a debtor row opens the patient drawer; actions stay links to the classic app', { skip: skip && 'playwright/chromium missing' }, async () => {
  const srv = await boot();
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  try {
    const { page, errors } = await open(browser, srv.port, 'vered', 1366);
    assert.ok(!srv.actions.some((a) => a.action === 'getCredits'), 'credits are not loaded on boot (debtAging + getPayments are — once — for the «גבייה לטיפול» card and the verification states, Stage 2 / 2b)');
    assert.equal(srv.actions.filter((a) => a.action === 'debtAging').length, 1);
    assert.equal(srv.actions.filter((a) => a.action === 'getPayments').length, 1);
    await page.click('#crm-nav button[data-area="billing"]');
    await page.waitForSelector('#crm-debtors');
    assert.equal(await page.textContent('#crm-title'), 'גבייה');
    // «צפי תזרים» KPIs are its own block (CHANGELOG-cashflow-forecast.md) — covered by its own scenario.
    const kpis = await page.$$eval('.kpis:not(#crm-fc-kpis) .kpi .v', (els) => els.map((e) => e.textContent));
    // «לגבייה בתאריך» opens the area (CHANGELOG-crm-collect-on-date.md): its three KPIs come first.
    assert.equal(kpis.length, 12);
    assert.ok(await page.$('#crm-due-date'), 'the date picker of «לגבייה בתאריך»');
    assert.deepEqual(kpis.slice(3, 8), ['₪11,000', '₪6,000', '1', '₪2,500', '1']);
    assert.deepEqual(kpis.slice(8, 12), ['₪5,000', '₪0', '₪0', '₪6,000'], 'the four aging buckets');
    const main = await page.textContent('#crm-main');
    assert.match(main, /דנה כהן/); assert.match(main, /רמות השבים/); assert.match(main, /1 ללא דיווח/); assert.match(main, /70 ימים/); assert.match(main, /₪8,500/); assert.match(main, /ביט/); assert.match(main, /דשבורד רגיל/);
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
    assert.equal(links.length, 2, 'top + bottom'); for (const l of links) assert.match(l, /בקרת גבייה/);
    assert.deepEqual(o.errors, []);
  } finally { await browser.close(); srv.close(); }
});

test('«לגבייה בתאריך» (Vered): pick a date → the patient due that day, KPIs, «דווח תשלום» opens «חשבון» with the form on THAT cycle; Ortal has no report button', { skip: skip && 'playwright/chromium missing' }, async () => {
  const srv = await boot();
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  try {
    const { page, errors } = await open(browser, srv.port, 'vered', 1366);
    await page.click('#crm-nav button[data-area="billing"]');
    await page.waitForSelector('#crm-due-date');
    await page.fill('#crm-due-date', daysAgo(30));
    await page.dispatchEvent('#crm-due-date', 'change');
    await page.waitForSelector('#crm-due tbody tr');
    // (a released patient whose month-anniversary may also fall on this day can be listed too — by design)
    const rows = await page.$$eval('#crm-due tbody tr', (els) => els.map((e) => e.textContent));
    const i = rows.findIndex((t) => /דנה כהן/.test(t));
    assert.ok(i >= 0, 'דנה כהן is due on her entry date');
    assert.match(rows[i], /₪6,000/); assert.match(rows[i], /לא שולם/);
    const kpis = await page.$$eval('.kpis .kpi .v', (els) => els.map((e) => e.textContent));
    assert.equal(kpis[0], String(rows.length));
    // the top search narrows the list and its KPIs
    await page.fill('#crm-search', 'דנה');
    await page.press('#crm-search', 'Enter');
    await page.waitForFunction(() => document.querySelectorAll('#crm-due tbody tr').length === 1);
    assert.deepEqual((await page.$$eval('.kpis .kpi .v', (els) => els.map((e) => e.textContent))).slice(0, 3), ['1', '₪6,000', '₪0']);
    await page.click('#crm-due [data-due-report="0"]');
    await page.waitForSelector('#crm-drawer form[data-form="payment-report"]');
    assert.equal(await page.getAttribute('#crm-drawer', 'aria-hidden'), 'false');
    assert.equal(await page.inputValue('#crm-drawer input[name="coverageStart"]'), daysAgo(30));
    assert.equal(await page.inputValue('#crm-drawer input[name="amount"]'), '6000');
    assert.deepEqual(errors, []);
    assert.deepEqual(srv.saves, [], 'opening the form writes nothing');
    // a date nobody is due on → the empty message
    await page.keyboard.press('Escape');
    await page.fill('#crm-due-date', daysAgo(31));
    await page.dispatchEvent('#crm-due-date', 'change');
    await page.waitForFunction(() => /אין תשלומים לגבייה בתאריך זה/.test(document.querySelector('#crm-main').textContent));
    // Ortal: the list, no report button
    const o = await open(browser, srv.port, 'ortal', 1366);
    await o.page.click('#crm-nav button[data-area="billing"]');
    await o.page.waitForSelector('#crm-due-date');
    await o.page.fill('#crm-due-date', daysAgo(30));
    await o.page.dispatchEvent('#crm-due-date', 'change');
    await o.page.waitForSelector('#crm-due tbody tr');
    assert.equal(await o.page.$('#crm-due [data-due-report]'), null);
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

test('C11 finance CRM: Vered discount + amount, Vered requests refund, Sandra approves exact amount, Ortal alone settles', { skip: skip && 'playwright/chromium missing' }, async () => {
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
    assert.equal(await page.$$eval('#crm-account-credits [data-refund-action="request"]', (els) => els.length), 1,
      'Vered requests approval, never settles directly');
    assert.equal(await page.$$eval('#crm-account-credits [data-refund-action="settle"]', (els) => els.length), 0);
    // Existing Vered discount remains authorized, with a required reason.
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
    // Existing amount override: server refusal keeps form; retry succeeds.
    await page.click('#crm-account-open [data-amount-open="0"]');
    await page.waitForSelector('form[data-form="small-amount"]');
    saveAnswer = () => ({ ok: false, error: 'bad_amount' });
    await page.fill('form.report [name="amount"]', '5500');
    await page.click('form.report button[type="submit"]');
    await page.waitForFunction(() => /bad_amount/.test(document.querySelector('form.report .err[data-err="_form"]').textContent));
    assert.equal(srv.saves[1].action, 'upsertBillingOverride');
    saveAnswer = null;
    await page.click('form.report button[type="submit"]');
    await page.waitForFunction(() => !document.querySelector('form.report'), null, { timeout: 5000 });
    assert.equal(srv.saves.length, 3);

    // Request from Vered's CRM account; after saving, source re-read changes the stage.
    await page.waitForSelector('#crm-account-credits [data-refund-action="request"][data-refund-id="cr-1"]');
    await page.click('#crm-account-credits [data-refund-action="request"][data-refund-id="cr-1"]');
    await page.waitForSelector('form[data-form="refund-action"]');
    assert.match(await page.textContent('form[data-form="refund-action"]'), /1200|1,200/);
    await page.click('form[data-form="refund-action"] button[type="submit"]');
    await page.waitForFunction(() => document.querySelector('#crm-account-credits') &&
      /הועבר לאישור סנדרה/.test(document.querySelector('#crm-account-credits').textContent), null, { timeout: 8000 });
    assert.equal(srv.saves.filter((x) => x.action === 'requestRefundPayoutApproval').length, 1);
    assert.ok(!srv.saves.some((x) => x.action === 'settleRefund'), 'Vered never sends a settlement');
    await page.keyboard.press('Escape');
    await page.click('#crm-nav button[data-area="billing"]');
    await page.waitForSelector('#crm-pending-credits');
    assert.equal(await page.$$eval('#crm-pending-credits [data-refund-action="settle"]', (els) => els.length), 0);

    // Sandra sees the same exact saved request and signs off the amount.
    const { page: sandra, errors: sandraErrors } = await open(browser, srv.port, 'sandra', 1366);
    await sandra.click('#crm-nav button[data-area="billing"]');
    await sandra.waitForSelector('#crm-pending-credits [data-refund-action="approve"][data-refund-id="cr-1"]');
    await sandra.click('#crm-pending-credits [data-refund-action="approve"][data-refund-id="cr-1"]');
    await sandra.waitForSelector('form[data-form="refund-action"]');
    assert.match(await sandra.textContent('form[data-form="refund-action"]'), /1200|1,200/);
    await sandra.click('form[data-form="refund-action"] button[type="submit"]');
    await sandra.waitForFunction(() => document.querySelector('#crm-pending-credits') &&
      /אושר על ידי סנדרה/.test(document.querySelector('#crm-pending-credits').textContent), null, { timeout: 8000 });
    assert.equal(srv.saves.filter((x) => x.action === 'approveRefundPayout').length, 1);
    assert.equal(await sandra.$$eval('#crm-pending-credits [data-refund-action="settle"]', (els) => els.length), 0);

    // Ortal, on her controller CRM tab, can pay only AFTER Sandra's approval.
    const { page: ortal, errors: ortalErrors } = await open(browser, srv.port, 'ortal', 1366);
    await ortal.click('#crm-nav button[data-area="billing"]');
    await ortal.waitForSelector('#crm-pending-credits [data-refund-action="settle"][data-refund-id="cr-1"]');
    await ortal.click('#crm-pending-credits [data-refund-action="settle"][data-refund-id="cr-1"]');
    await ortal.waitForSelector('form[data-form="refund-action"]');
    await ortal.click('form[data-form="refund-action"] button[type="submit"]');
    await ortal.waitForFunction(() => /אמצעי/.test(document.querySelector('form[data-form="refund-action"] .err[data-err="method"]').textContent));
    assert.equal(srv.saves.filter((x) => x.action === 'settleRefund').length, 0);
    await ortal.selectOption('form[data-form="refund-action"] [name="method"]', 'ביט');
    await ortal.click('form[data-form="refund-action"] button[type="submit"]');
    await ortal.waitForFunction(() => !document.querySelector('#crm-pending-credits [data-refund-action="settle"]'), null, { timeout: 8000 });
    const settled = srv.saves.filter((x) => x.action === 'settleRefund');
    assert.equal(settled.length, 1);
    assert.equal(settled[0].proxyUserId, 'ortal');
    assert.equal(settled[0].creditId, 'cr-1');
    assert.equal(settled[0].method, 'ביט');
    assert.equal(settled[0].paidDate, TODAY);
    assert.deepEqual(errors, []);
    assert.deepEqual(sandraErrors, []);
    assert.deepEqual(ortalErrors, []);
  } finally { await browser.close(); srv.close(); }
});

test('«שולם עם הנחה» (Vered, CHANGELOG-paid-with-discount.md): the box opens the reason; a missing reason posts nothing; a save posts reportPayment (no discount fields) THEN setBillingDiscount with the gap; a refused discount keeps the payment and says so', { skip: skip && 'playwright/chromium missing' }, async () => {
  const srv = await boot();
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  try {
    const { page, errors } = await open(browser, srv.port, 'vered', 1366);
    await page.click('#crm-nav button[data-area="clients"]');
    await page.click('table.tbl tbody tr[data-open-patient="p1"]');
    await page.waitForSelector('#crm-drawer[aria-hidden="false"]');
    await page.click('#crm-drawer [data-tab="account"]');
    await page.waitForSelector('#crm-account-open');
    // the unrecorded open cycle: 5,000, month = its start month
    await page.click('#crm-account-open [data-report-open="1"]');
    await page.waitForSelector('form[data-form="payment-report"]');
    assert.ok(await page.$('form.report [name="withDiscount"]'), 'offered on an open cycle');
    assert.equal(await page.isVisible('form.report [name="discountReason"]'), false, 'reason hidden until checked');
    await page.fill('form.report [name="amount"]', '4000');
    await page.selectOption('form.report [name="method"]', 'מזומן');
    await page.fill('form.report [name="payer"]', 'דנה כהן');
    await page.selectOption('form.report [name="invoiceWanted"]', 'no');
    await page.check('form.report [name="withDiscount"]');
    assert.equal(await page.isVisible('form.report [name="discountReason"]'), true);
    assert.match(await page.textContent('form.report [data-pwd-preview]'), /הנחה ₪1,000|הנחה ₪?1,000/);
    // no reason → nothing posted
    await page.click('form.report button[type="submit"]');
    await page.waitForFunction(() => /סיבה/.test(document.querySelector('form.report .err[data-err="discountReason"]').textContent));
    assert.equal(srv.saves.length, 0);
    await page.fill('form.report [name="discountReason"]', 'סוכם עם המשפחה');
    await page.click('form.report button[type="submit"]');
    await page.waitForFunction(() => !document.querySelector('form.report'), null, { timeout: 5000 });
    assert.deepEqual(srv.saves.map((x) => x.action), ['reportPayment', 'setBillingDiscount'], 'payment first, then the discount');
    const rep = srv.saves[0].report.report;
    assert.equal(rep.amount, '4000');
    assert.equal('withDiscount' in rep, false); assert.equal('discountReason' in rep, false);
    assert.deepEqual(srv.saves[1].discount, { patientId: 'ramot::דנה כהן::' + daysAgo(30), month: daysAgo(3).slice(0, 7), discountAmount: 1000, discountReason: 'סוכם עם המשפחה' });
    // unchecked → a normal report, no discount
    await page.waitForSelector('#crm-account-open');
    await page.click('#crm-account-open [data-report-open="1"]');
    await page.waitForSelector('form[data-form="payment-report"]');
    await page.fill('form.report [name="amount"]', '4000');
    await page.selectOption('form.report [name="method"]', 'מזומן'); await page.fill('form.report [name="payer"]', 'דנה כהן'); await page.selectOption('form.report [name="invoiceWanted"]', 'no');
    await page.click('form.report button[type="submit"]');
    await page.waitForFunction(() => !document.querySelector('form.report'), null, { timeout: 5000 });
    assert.deepEqual(srv.saves.slice(2).map((x) => x.action), ['reportPayment']);
    // the discount refused by the server: the payment stays saved, the message says what to do
    await page.waitForSelector('#crm-account-open');
    await page.click('#crm-account-open [data-report-open="1"]');
    await page.waitForSelector('form[data-form="payment-report"]');
    saveAnswer = (parsed) => parsed.action === 'setBillingDiscount' ? { ok: false, error: 'forbidden_role' } : { ok: true, receipt: { id: 'rcpt-z' }, cycle: { id: parsed.report.cycle.id } };
    await page.fill('form.report [name="amount"]', '4500');
    await page.selectOption('form.report [name="method"]', 'מזומן'); await page.fill('form.report [name="payer"]', 'דנה כהן'); await page.selectOption('form.report [name="invoiceWanted"]', 'no');
    await page.check('form.report [name="withDiscount"]');
    await page.fill('form.report [name="discountReason"]', 'עיגול');
    await page.click('form.report button[type="submit"]');
    await page.waitForFunction(() => /ההנחה לא נשמרה/.test(document.body.textContent), null, { timeout: 5000 });
    assert.deepEqual(srv.saves.slice(3).map((x) => x.action), ['reportPayment', 'setBillingDiscount']);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); srv.close(); }
});

test('«שולם עם הנחה» is not offered on «מחזור אחר» (its balance is not net of a discount)', { skip: skip && 'playwright/chromium missing' }, async () => {
  const srv = await boot();
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  try {
    const { page, errors } = await open(browser, srv.port, 'vered', 1366);
    await page.click('#crm-nav button[data-area="clients"]');
    await page.click('table.tbl tbody tr[data-open-patient="p1"]');
    await page.waitForSelector('#crm-drawer[aria-hidden="false"]');
    await page.click('#crm-drawer [data-tab="account"]');
    await page.waitForSelector('#crm-account-open');
    await page.click('[data-report-other]');
    await page.waitForSelector('form[data-form="payment-report"]');
    assert.equal(await page.$('form.report [name="withDiscount"]'), null, '«מחזור אחר» never offers it');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); srv.close(); }
});

test('«צפי תזרים» (Vered, CHANGELOG-cashflow-forecast.md): renders under «לגבייה בתאריך» from the loaded reads only, the presets and dates re-render, a row opens the patient; 390 px has no page overflow', { skip: skip && 'playwright/chromium missing' }, async () => {
  const srv = await boot();
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  try {
    for (const width of [1366, 390]) {
      const { page, errors } = await open(browser, srv.port, 'vered', width);
      if (width === 390) await page.click('#crm-burger');
      await page.click('#crm-nav button[data-area="billing"]');
      await page.waitForSelector('#crm-fc-kpis');
      const order = await page.evaluate(() => {
        const a = document.querySelector('#crm-due-title'), b = document.querySelector('#crm-fc-title');
        return !!(a && b && (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING));
      });
      assert.ok(order, 'the forecast follows «לגבייה בתאריך»');
      const reads = srv.actions.length;
      assert.equal(await page.inputValue('#crm-fc-from'), TODAY);
      assert.match(await page.textContent('#crm-fc-kpis'), /סה"כ צפוי/);
      assert.match(await page.textContent('#crm-fc-kpis'), /שוטף \+30/);
      // refunds to pay are taken off (CHANGELOG-cashflow-refunds.md): the saved credit due today + the overdue computed line
      assert.match(await page.textContent('#crm-fc-refunds'), /−₪1,734/);
      assert.match(await page.textContent('#crm-fc-refunds'), /זיכויים לתשלום \(2\) · 1 באיחור/);
      assert.match(await page.textContent('#crm-fc-net'), /נטו צפוי/);
      assert.match(await page.textContent('#crm-fc-weeks thead'), /זיכויים.*נטו/);
      await page.click('#crm-fc-refund-detail summary');
      assert.match(await page.textContent('#crm-fc-refund-rows'), /דנה כהן/);
      assert.match(await page.textContent('#crm-fc-refund-rows'), /מחושב — טרם הוחלט/);
      assert.equal(srv.actions.filter((a) => a.action === 'refundPayoutForecast').length, 1, 'read once, with the other «גבייה» reads');
      // «רשימת חייבים לגבייה» (CHANGELOG-billing-debtors-list.md): open, right under the forecast cards, before the weekly table
      assert.equal(await page.$eval('#crm-fc-debtors', (e) => e.open), true, 'open by default');
      assert.match(await page.textContent('#crm-fc-debtors summary'), /רשימת חייבים לגבייה.*1 חייבים · ₪8,500/);
      assert.match(await page.textContent('#crm-fc-debtor-rows'), /דנה כהן.*משרד הביטחון.*₪8,500.*70 ימים/);
      assert.ok(await page.evaluate(() => {
        const k = document.querySelector('#crm-fc-kpis'), d = document.querySelector('#crm-fc-debtors'), w = document.querySelector('#crm-fc-weeks') || document.querySelector('#crm-debtors-title');
        return !!(k.compareDocumentPosition(d) & Node.DOCUMENT_POSITION_FOLLOWING) && !!(d.compareDocumentPosition(w) & Node.DOCUMENT_POSITION_FOLLOWING);
      }), 'under the cards, above the rest');
      if (process.env.CRM_SHOT_DIR) await page.screenshot({ path: require('node:path').join(process.env.CRM_SHOT_DIR, 'billing-' + width + '.png'), fullPage: true });
      await page.click('#crm-fc-debtors summary');
      await page.click('[data-fc-preset="90"]');
      await page.waitForFunction((t) => document.querySelector('#crm-fc-to') && document.querySelector('#crm-fc-to').value > t, TODAY);
      assert.equal(srv.actions.length, reads, 'no extra request: computed from the loaded reads');
      // within 90 days the patient's monthly cycles (משרד הביטחון → שוטף +30) are listed
      await page.click('#crm-fc-detail summary');
      const rows = await page.$$eval('#crm-fc-rows tbody tr', (els) => els.length);
      assert.ok(rows >= 1, 'at least one expected receipt in 90 days');
      assert.match(await page.textContent('#crm-fc-rows'), /שוטף \+30/);
      if (width === 390) assert.ok(await noHScroll(page), 'no horizontal page scroll at 390 px');
      assert.equal(await page.$eval('#crm-fc-debtors', (e) => e.open), false, 'closing it survives the re-render');
      await page.click('#crm-fc-debtors summary');
      await page.click('#crm-fc-debtor-rows tbody tr');
      await page.waitForSelector('#crm-drawer[aria-hidden="false"] [data-tab="account"][aria-selected="true"]');
      await page.keyboard.press('Escape');
      await page.click('#crm-fc-rows tbody tr');
      await page.waitForSelector('#crm-drawer[aria-hidden="false"]');
      assert.deepEqual(errors, []);
      await page.close();
    }
    assert.deepEqual(srv.saves, [], 'read-only');
  } finally { await browser.close(); srv.close(); }
});

test('«ניקוי חובות היסטוריים» (Vered, CHANGELOG-historical-debt-cleanup.md): only released debtors; ticking keeps the typed reason; a confirm; one setBillingDiscount per patient + month with the full balance; Ortal never sees it', { skip: skip && 'playwright/chromium missing' }, async () => {
  const KEYX = 'ramot::נועה לוי::' + daysAgo(60);
  const debt = JSON.parse(JSON.stringify(DEBT));
  debt.byPatient.push({ patientId: 'px', patientKey: KEYX, name: 'נועה לוי', houseId: 'ramot', status: 'released', inHouseAtAsOf: false, cycles: [
    { start: daysAgo(60), end: daysAgo(31), expected: 6000, received: 1000, balance: 5000, days: 60, kind: 'recorded', paymentId: 'cx', month: daysAgo(60).slice(0, 7), discount: 0 },
    { start: daysAgo(30), end: daysAgo(5), expected: 6000, received: 0, balance: 6000, days: 30, kind: 'unrecorded', month: daysAgo(30).slice(0, 7), discount: 0 }] });
  const srv = await boot({ debt });
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  try {
    const { page, errors } = await open(browser, srv.port, 'vered', 1366);
    await page.click('#crm-nav button[data-area="billing"]');
    await page.waitForSelector('#crm-cleanup');
    await page.click('#crm-cleanup summary');
    assert.equal(await page.$$eval('#crm-cleanup-rows [data-cleanup-row]', (els) => els.length), 2, 'only the released patient\'s cycles (p1 is in a house)');
    await page.selectOption('form[data-form="cleanup"] [name="reason"]', 'paid_unrecorded');
    await page.fill('form[data-form="cleanup"] [name="note"]', 'בדיקה מול הבנק');
    // nothing ticked → refused, nothing sent
    await page.click('form[data-form="cleanup"] button[type="submit"]');
    await page.waitForFunction(() => /לא נבחרו/.test(document.querySelector('form[data-form="cleanup"] .err[data-err="_form"]').textContent));
    await page.check('[data-cleanup-all]');
    assert.match(await page.textContent('#crm-cleanup-sum'), /נבחרו 2 מחזורים של 1 מטופלים · ₪11,000/);
    assert.equal(await page.inputValue('form[data-form="cleanup"] [name="note"]'), 'בדיקה מול הבנק', 'ticking never wipes the form');
    // a cancelled confirm sends nothing
    page.once('dialog', (d) => d.dismiss());
    await page.click('form[data-form="cleanup"] button[type="submit"]');
    await page.waitForTimeout(200);
    assert.equal(srv.saves.length, 0);
    page.once('dialog', (d) => { assert.match(d.message(), /2 מחזורים/); d.accept(); });
    await page.click('form[data-form="cleanup"] button[type="submit"]');
    await page.waitForFunction(() => /נסגרו 2 מחזורים/.test(document.body.textContent), null, { timeout: 5000 });
    assert.deepEqual(srv.saves.map((x) => x.action), ['setBillingDiscount', 'setBillingDiscount']);
    const sent = srv.saves.map((x) => x.discount).sort((a, b) => (a.month < b.month ? -1 : 1));
    assert.ok(sent.every((d) => d.patientId === KEYX && /^ניקוי חוב היסטורי · שולם — לא נרשם באפליקציה · בדיקה מול הבנק$/.test(d.discountReason)));
    assert.deepEqual(sent.map((d) => d.discountAmount).sort((a, b) => a - b), [5000, 6000]);
    for (let i = 0; i < 30 && srv.actions.filter((a) => a.action === 'debtAging').length < 2; i++) await page.waitForTimeout(100);
    assert.ok(srv.actions.filter((a) => a.action === 'debtAging').length >= 2, 're-read after the run');
    assert.deepEqual(errors, []);
    // Ortal (controller) never sees the tool
    const { page: ortal } = await open(browser, srv.port, 'ortal', 1366);
    await ortal.click('#crm-nav button[data-area="billing"]');
    await ortal.waitForSelector('#crm-debtors');
    assert.equal(await ortal.$('#crm-cleanup'), null);
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
    assert.match(await page.textContent('#crm-main'), /לקרוא דיווח מנהל\/ת/);
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

test('C17 «משוחררים» (Vered): the discharged list with its flags; restore to the previous status = house-as-read saveAll + audit flag; restore as a new lead = restorePatient with a minted lead id; «העבר לאמבולטורי» posts manual:true', { skip: skip && 'playwright/chromium missing' }, async () => {
  const srv = await boot();
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  try {
    const { page, errors } = await open(browser, srv.port, 'vered', 1366);
    await page.click('#crm-nav button[data-area="clients"]');
    assert.ok(!/נועה לוי/.test(await page.textContent('table.tbl')), 'released patients are not in «בבית»');
    await page.click('[data-clients-view="out"]');
    await page.waitForSelector('#crm-discharged');
    const txt = await page.textContent('#crm-discharged');
    assert.match(txt, /נועה לוי/); assert.match(txt, /משוחרר לטיפול חוץ/); assert.match(txt, /שחר/); assert.match(txt, /לא נשלח/);
    // «העבר לאמבולטורי»
    const outCalls = [];
    // first answer: no phone → the row asks for it (CHANGELOG-crm-followups-1104.md); then the send with the phone goes through
    await page.route('**/api/outpatient-lead', (route) => {
      const b = JSON.parse(route.request().postData()); outCalls.push(b);
      route.fulfill({ status: b.phone ? 200 : 502, contentType: 'application/json', body: JSON.stringify(b.phone ? { ok: true, sent: true } : { ok: false, error: 'no_phone', message: 'לא נשלח לאמבולטורי: אין טלפון למטופל/ת.' }) });
    });
    page.once('dialog', (d) => d.accept());
    await page.click('[data-to-outpatient="dx1"]');
    await page.waitForSelector('#crm-out-phone input[name="phone"]', { timeout: 5000 });
    assert.match(await page.textContent('#crm-discharged'), /לא נשלח/, 'still not sent');
    await page.fill('#crm-out-phone input[name="phone"]', '12');
    await page.click('#crm-out-phone button[type="submit"]');
    assert.match(await page.textContent('#crm-out-phone [data-err="phone"]'), /טלפון לא תקין/);
    assert.equal(outCalls.length, 1, 'an invalid phone is not sent');
    await page.fill('#crm-out-phone input[name="phone"]', '052-765 4321');
    await page.click('#crm-out-phone button[type="submit"]');
    await page.waitForFunction(() => /נשלח/.test(document.querySelector('#crm-discharged').textContent) && !/לא נשלח/.test(document.querySelector('#crm-discharged').textContent), null, { timeout: 5000 });
    assert.deepEqual(outCalls, [{ dischargeId: 'dx1', manual: true }, { dischargeId: 'dx1', manual: true, phone: '0527654321' }]);
    assert.equal(await page.$('#crm-out-phone'), null, 'the phone row closes once sent');
    assert.ok(!(await page.$('[data-to-outpatient="dx1"]')), 'sent → no second button');
    // restore to the previous status
    await page.click('[data-restore="dx1"]');
    await page.waitForSelector('form[data-form="restore"]');
    assert.equal(await page.inputValue('form[data-form="restore"] input[name="how"]:checked'), 'active');
    await page.click('form[data-form="restore"] button[type="submit"]');
    await page.waitForFunction(() => !document.querySelector('form[data-form="restore"]'), null, { timeout: 8000 });
    assert.equal(srv.saves.length, 2);
    const sa = srv.saves[0];
    assert.equal(sa.action, 'saveAll'); assert.deepEqual(Object.keys(sa.patients), ['ramot']);
    const restored = sa.patients.ramot.filter((p) => p.id === 'px')[0];
    assert.equal(restored.status, 'active'); assert.equal(restored.exitDate, ''); assert.equal(sa.patients.ramot.length, 2, 'the house as read');
    assert.deepEqual(sa.prove, { patients: ['px'] });
    assert.equal(srv.saves[1].action, 'restorePatientToActive'); assert.equal(srv.saves[1].patient.id, 'dx1'); assert.equal(srv.saves[1].patient.restored, 'TRUE');
    // restore as a new lead (the data is static, so the row is still listed after the reload)
    await page.waitForSelector('[data-restore="dx1"]');
    await page.click('[data-restore="dx1"]');
    await page.waitForSelector('form[data-form="restore"]');
    await page.check('form[data-form="restore"] input[value="lead"]');
    await page.click('form[data-form="restore"] button[type="submit"]');
    await page.waitForFunction(() => !document.querySelector('form[data-form="restore"]'), null, { timeout: 8000 });
    assert.equal(srv.saves[2].action, 'restorePatient'); assert.equal(srv.saves[2].patient.id, 'dx1'); assert.match(srv.saves[2].patient.newLeadId, /^lead-[0-9a-f]{16}$/);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); srv.close(); }
});

test('C18 payment linking (Vered): the detached row in גבייה; «שייך» preselects the look-alike patient and posts the classic savePayment link row; «לא מטופל/ת» needs a reason; the three reads refresh', { skip: skip && 'playwright/chromium missing' }, async () => {
  const srv = await boot();
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  try {
    const { page, errors } = await open(browser, srv.port, 'vered', 1366);
    await page.click('#crm-nav button[data-area="billing"]');
    await page.waitForSelector('#crm-detached');
    assert.match(await page.textContent('#crm-detached'), /דנה כהן/);
    await page.click('[data-link-open]');
    await page.waitForSelector('form[data-form="link-link"]');
    assert.equal(await page.inputValue('form.report [name="patientId"]'), 'p1', 'the look-alike patient of the same house is preselected');
    await page.click('form.report button[type="submit"]');
    await page.waitForFunction(() => !document.querySelector('form.report'), null, { timeout: 5000 });
    assert.equal(srv.saves.length, 1);
    const b = srv.saves[0];
    assert.equal(b.action, 'savePayment'); assert.equal(b.payment.id, 'pay::ramot::דנה כהן ::x::' + daysAgo(40)); assert.equal(b.payment.linkPatientUid, 'p1'); assert.equal(b.payment.linkStatus, 'linked'); assert.equal(b.payment.amount, 6000, 'the row as read travels with it');
    await page.waitForSelector('#crm-detached');
    assert.equal(srv.actions.filter((a) => a.action === 'debtAging').length, 2, 'the reads refresh after the decision');
    // not a patient: reason required
    await page.click('[data-notpatient-open]');
    await page.waitForSelector('form[data-form="link-not"]');
    await page.click('form.report button[type="submit"]');
    await page.waitForFunction(() => /סיבה/.test(document.querySelector('form.report .err[data-err="note"]').textContent));
    assert.equal(srv.saves.length, 1);
    await page.fill('form.report [name="note"]', 'החזר לספק');
    await page.click('form.report button[type="submit"]');
    await page.waitForFunction(() => !document.querySelector('form.report'), null, { timeout: 5000 });
    assert.equal(srv.saves[1].payment.linkStatus, 'not_a_patient'); assert.equal(srv.saves[1].payment.linkNote, 'החזר לספק'); assert.equal(srv.saves[1].payment.linkPatientUid, '');
    assert.deepEqual(errors, []);
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
    // 1b. arriving at «ביקור נקבע» with no date opens the drawer on «תיאום פגישה»
    //     (CHANGELOG-undated-visit-leads.md); the date field has focus. Closed here.
    await page.waitForSelector('#crm-drawer[aria-hidden="false"]');
    assert.ok(await page.$('#crm-drawer form[data-form="meeting"]'), 'meeting form in the drawer');
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.name), 'visitDate', 'date field focused');
    assert.match(await page.textContent('#crm-toast'), /תאריך הפגישה/);
    await page.click('#crm-drawer-close');
    await page.waitForSelector('#crm-drawer[aria-hidden="true"]');
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
    await page.waitForFunction(() => /הקליטה/.test(document.querySelector('#crm-toast')?.textContent || ''), null, { timeout: 5000 });
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

test('Stage 1c (Vered): «שיחות לביצוע» on היום שלי from getTasks (overdue call first, no «בוצע»); «תיעוד שיחה» opens the panel with the history; no default next-contact; a relative choice shows the real date; save = ONE logContact with the task id and the follow-up; a refusal keeps the text; the tasks tab creates / reschedules (reason required for a promised date); a failed getTasks shows «המידע אינו זמין», never 0', { skip: skip && 'playwright/chromium missing' }, async () => {
  const srv = await boot();
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  try {
    const { page, errors } = await open(browser, srv.port, 'vered', 1366);
    await page.waitForSelector('[data-domain-section="calls"]');
    const calls = await page.textContent('[data-domain-section="calls"]');
    assert.match(calls, /שיחות ומעקבים/); assert.match(calls, /אבי לוי/); assert.match(calls, /לחזור למשפחה/); assert.match(calls, /באיחור/);
    assert.match(await page.textContent('.kpi[data-domain="calls"]'), /1 באיחור/);
    assert.equal(await page.$$eval('[data-domain-section="calls"] button', (els) => els.filter((b) => /בוצע/.test(b.textContent)).length), 0, 'no «בוצע» on a call');
    assert.match(await page.textContent('#crm-nav button[data-area="today"] .n'), /^\d+$/, 'the nav count is the urgent + due calls');
    // the panel
    await page.click('[data-domain-section="calls"] [data-contact-open][data-task-id]');
    await page.waitForSelector('#crm-drawer[aria-hidden="false"] form[data-form="contact"]');
    const head = await page.textContent('#crm-drawer .drawer-head');
    assert.match(head, /תיעוד שיחה · אבי לוי/); assert.match(head, /0501111111/); assert.match(head, /קישור חיוג אינו תיעוד/);
    await page.waitForFunction(() => /הליד נוצר/.test(document.querySelector('#crm-tl').textContent), null, { timeout: 5000 });
    assert.equal(await page.$$eval('form[data-form="contact"] input[name="next"]:checked', (els) => els.length), 0, 'no default follow-up');
    assert.equal(await page.inputValue('form[data-form="contact"] input[name="reason"]'), 'לחזור למשפחה');
    // save without outcome / next → client errors, nothing posted
    await page.click('form[data-form="contact"] button[type="submit"]');
    assert.match(await page.textContent('form[data-form="contact"] [data-err="outcome"]'), /בחרי תוצאה/);
    assert.match(await page.textContent('form[data-form="contact"] [data-err="next"]'), /אין ברירת מחדל/);
    assert.equal(srv.saves.length, 0);
    // fill: outcome, summary, next = in 3 days → the real date is shown
    await page.selectOption('form[data-form="contact"] select[name="outcome"]', 'call_back_later');
    await page.fill('form[data-form="contact"] textarea[name="summary"]', 'ביקשו שנחזור אחרי החג');
    await page.check('form[data-form="contact"] input[name="next"][value="d3"]');
    const dmy = (iso) => iso.split('-').reverse().join('/');
    assert.match(await page.textContent('#crm-next-preview'), new RegExp('בעוד 3 ימים — ' + dmy(daysAgo(-3))));
    // a refusal keeps the text
    saveAnswer = () => ({ ok: false, error: 'lock_busy' });
    await page.click('form[data-form="contact"] button[type="submit"]');
    await page.waitForFunction(() => /עסוקה/.test(document.querySelector('form[data-form="contact"] [data-err="_form"]').textContent), null, { timeout: 5000 });
    assert.equal(await page.inputValue('form[data-form="contact"] textarea[name="summary"]'), 'ביקשו שנחזור אחרי החג', 'the text survives a failed save');
    assert.equal(srv.saves.length, 1);
    // retry → accepted, ONE logContact with the same submission id, the task id, the follow-up; back to the card on «משימות»
    saveAnswer = null;
    await page.click('form[data-form="contact"] button[type="submit"]');
    await page.waitForFunction(() => document.querySelector('#crm-drawer [data-tab="tasks"]') && document.querySelector('#crm-drawer [data-tab="tasks"]').getAttribute('aria-selected') === 'true', null, { timeout: 5000 });
    const posted = srv.saves.filter((x) => x.action === 'logContact');
    assert.equal(posted.length, 2); assert.equal(posted[0].submissionId, posted[1].submissionId, 'the retry reuses the submission id (idempotent)');
    const b = posted[1];
    assert.equal(b.contact.leadId, 'L1'); assert.equal(b.contact.taskId, 'task-' + '1'.repeat(32)); assert.equal(b.contact.outcome, 'call_back_later'); assert.equal(b.contact.channel, 'phone');
    assert.equal(b.contact.summary, 'ביקשו שנחזור אחרי החג'); assert.equal(b.next.dueDate, daysAgo(-3)); assert.equal(b.next.assignee, 'ורד');
    assert.ok(srv.actions.filter((a) => a.action === 'getTasks').length >= 2, 'the lists re-read after the save');
    // the tasks tab: create (validated) and reschedule (reason required for a contact-promised date)
    assert.match(await page.textContent('#crm-tasks'), /לחזור למשפחה/);
    await page.click('#crm-tasks details summary');
    await page.click('#crm-tasks form[data-form="task-new"] button[type="submit"]');
    assert.match(await page.textContent('#crm-tasks [data-err="title"]'), /כותרת/);
    await page.fill('#crm-tasks form[data-form="task-new"] input[name="title"]', 'לשלוח טופס');
    await page.fill('#crm-tasks form[data-form="task-new"] input[name="dueDate"]', daysAgo(-1));
    await page.click('#crm-tasks form[data-form="task-new"] button[type="submit"]');
    assert.match(await page.textContent('#crm-tasks form[data-form="task-new"] [data-err="dueTime"]'), /שעה/, 'a time is required (CHANGELOG-crm-task-date-time.md)');
    assert.equal(srv.saves.filter((x) => x.action === 'createTask').length, 0);
    assert.equal(await page.$('#crm-tasks form[data-form="task-new"] [name="weekStart"]'), null, 'no week field');
    assert.equal(await page.$('#crm-tasks form[data-form="task-new"] [name="reason"]'), null, 'no «למה עכשיו»');
    await page.fill('#crm-tasks form[data-form="task-new"] input[name="dueTime"]', '10:30');
    await page.click('#crm-tasks form[data-form="task-new"] button[type="submit"]');
    await page.waitForFunction(() => /המשימה נוצרה/.test((document.querySelector('#crm-toast') || {}).textContent || ''), null, { timeout: 5000 });
    const created = srv.saves.filter((x) => x.action === 'createTask')[0];
    assert.equal(created.task.leadId, 'L1'); assert.equal(created.task.title, 'לשלוח טופס'); assert.equal(created.task.dueDate, daysAgo(-1)); assert.equal(created.task.dueTime, '10:30'); assert.equal(created.task.reason, ''); assert.match(created.submissionId, /^sub-[0-9a-f]{32}$/);
    await page.click('#crm-tasks [data-task-resched="task-' + '1'.repeat(32) + '"]');
    await page.fill('#crm-tasks form[data-form="task-resched"] input[name="dueDate"]', daysAgo(-5));
    await page.click('#crm-tasks form[data-form="task-resched"] button[type="submit"]');
    assert.match(await page.textContent('#crm-tasks form[data-form="task-resched"] [data-err="reason"]'), /הובטח למשפחה/);
    await page.fill('#crm-tasks form[data-form="task-resched"] input[name="reason"]', 'ביקשו לדחות');
    await page.click('#crm-tasks form[data-form="task-resched"] button[type="submit"]');
    await page.waitForFunction(() => /המועד עודכן/.test((document.querySelector('#crm-toast') || {}).textContent || ''), null, { timeout: 5000 });
    const rs = srv.saves.filter((x) => x.action === 'rescheduleTask')[0];
    assert.deepEqual(rs, { action: 'rescheduleTask', id: 'task-' + '1'.repeat(32), reason: 'ביקשו לדחות', dueDate: daysAgo(-5), dueTime: '', proxySecret: rs.proxySecret, proxyUser: rs.proxyUser, proxyAuth: rs.proxyAuth, proxyUserId: rs.proxyUserId, proxyRoles: rs.proxyRoles, proxyCaps: rs.proxyCaps, user: rs.user });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); srv.close(); }
  // a failed source never shows 0 (390 px, mobile layout)
  const srv2 = await boot();
  const browser2 = await playwright.chromium.launch({ executablePath: chromiumPath });
  try {
    tasksAnswer = () => ({ ok: false, error: 'boom' });
    const { page } = await open(browser2, srv2.port, 'vered', 390);
    await page.waitForSelector('.kpis.cards');
    assert.match(await page.textContent('.kpi[data-domain="calls"]'), /המידע אינו זמין/);
    assert.equal(await page.$eval('.kpi[data-domain="calls"] .v', (e) => e.textContent), '—', 'never 0');
    assert.match(await page.textContent('[data-domain-section="calls"]'), /המידע אינו זמין/);
    assert.ok(await noHScroll(page), 'no horizontal scroll at 390 px');
  } finally { await browser2.close(); srv2.close(); }
});

test('Stage 2 «היום שלי» (Vered + Dana, 1366 + 390 px): header date; views היום / השבוע (range, grouped by day, the follow-up on its day) / הושלמו (who / when, opens the record); quick actions pick a subject; Dana has no money card and no «גבייה» (no «מה דחוף בבתים» since 04/11/2026); mobile: two-column cards, no horizontal scroll', { skip: skip && 'playwright/chromium missing' }, async () => {
  const srv = await boot();
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  const dmy = (iso) => iso.split('-').reverse().join('/');
  try {
    const { page, errors } = await open(browser, srv.port, 'vered', 1366);
    await page.waitForSelector('.kpis.cards');
    if (process.env.CRM_SHOT) await page.screenshot({ path: process.env.CRM_SHOT + '/today-1366.png', fullPage: true });
    assert.match(await page.textContent('#crm-date'), /יום .+, \d{2}\/\d{2}\/\d{4}/, 'the header shows the day');
    assert.match(await page.textContent('#crm-date'), new RegExp(dmy(TODAY)));
    // the week
    await page.click('[data-day-view="week"]');
    await page.waitForSelector('.week');
    const ws = core.weekStart(TODAY);
    const we = (() => { const d = new Date(ws + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 6); return d.toISOString().slice(0, 10); })();
    assert.match(await page.textContent('.week-bar'), new RegExp(dmy(ws) + ' – ' + dmy(we)), 'the visible range');
    assert.equal(await page.$$eval('.wday', (els) => els.length), 7);
    const todayDay = await page.textContent('.wday.is-today');
    assert.match(todayDay, /לבדוק מסמכים/, 'today\'s timed task sits on today');
    assert.match(todayDay, /גלי כהן/, 'today\'s meeting too');
    await page.click('[data-week-step="7"]');
    assert.equal(await page.$$eval('.wday.is-today', (els) => els.length), 0, 'next week has no today');
    await page.click('[data-week-today]');
    assert.equal(await page.$$eval('.wday.is-today', (els) => els.length), 1);
    // done
    tasksAnswer = () => ({ ok: true, total: 1, tasks: [{ id: 'task-' + '9'.repeat(32), kind: 'call', leadId: 'L1', title: 'שיחה שבוצעה', status: 'done', doneAt: TODAY + 'T08:00:00.000Z', doneBy: 'דנה', outcome: 'לא היה מענה', source: 'contact' }] });
    await page.click('[data-day-view="done"]');
    await page.waitForFunction(() => /שיחה שבוצעה/.test(document.querySelector('#crm-main').textContent), null, { timeout: 5000 });
    const done = await page.textContent('#crm-main');
    assert.match(done, /דנה/); assert.match(done, /לא היה מענה/); assert.match(done, /אבי לוי/);
    await page.click('.row.done [data-open-lead]');
    await page.waitForSelector('#crm-drawer[aria-hidden="false"]');
    assert.match(await page.textContent('#crm-drawer h2'), /אבי לוי/);
    await page.keyboard.press('Escape');
    tasksAnswer = null;
    // quick action: «תיעוד שיחה» → pick → the panel
    await page.click('[data-day-view="today"]');
    await page.click('[data-quick="contact"]');
    await page.fill('#crm-quick-q', 'מאיה');
    await page.click('[data-quick-pick="lead:L6"]');
    await page.waitForSelector('form[data-form="contact"]');
    assert.match(await page.textContent('#crm-drawer .drawer-head'), /מאיה שגב/);
    await page.keyboard.press('Escape');
    assert.ok(await noHScroll(page));
    assert.deepEqual(errors, []);
  } finally { await browser.close(); srv.close(); }
  const srv2 = await boot();
  const browser2 = await playwright.chromium.launch({ executablePath: chromiumPath });
  try {
    const { page, errors } = await open(browser2, srv2.port, 'dana', 390);
    await page.waitForSelector('.kpis.cards');
    if (process.env.CRM_SHOT) await page.screenshot({ path: process.env.CRM_SHOT + '/today-390-dana.png', fullPage: true });
    const labels = await page.$$eval('.kpis.cards .kpi .l', (els) => els.map((e) => e.textContent));
    assert.deepEqual(labels, ['שיחות ומעקבים', 'פגישות היום', 'המשך טיפול לאחר פגישות', 'לידים חדשים ללא מגע'], 'no money card; «מה דחוף בבתים» left «היום שלי» (04/11/2026)');
    assert.ok(!/גבייה|₪/.test(await page.textContent('#crm-main')), 'no money anywhere on her day');
    assert.ok(!srv2.actions.some((a) => a.action === 'debtAging'), 'debtAging never requested for her');
    assert.ok(!(await page.$$eval('#crm-nav button span:first-child', (els) => els.map((e) => { const c = e.cloneNode(true); const i = c.querySelector('.ic'); if (i) i.remove(); return c.textContent.trim(); }))).includes('גבייה'));
    const cols = await page.$eval('.kpis.cards', (e) => getComputedStyle(e).gridTemplateColumns.split(' ').length);
    assert.equal(cols, 2, 'two-column cards on mobile');
    assert.ok(await noHScroll(page), 'no horizontal scroll at 390 px');
    assert.deepEqual(errors, []);
  } finally { await browser2.close(); srv2.close(); }
});

test('Stage 3 triage (Vered, 1366 px): reached from «פניות» with a computed count; one record at a time, oldest first; «לחזור בתאריך» creates a call task and the record leaves the queue; «רשימת המתנה» validates, posts ONE lead saveAll (stage + appended note) and a review task on the check date; «סגירה» needs a reason and posts moveLeadIrrelevant; skip moves on; «שיחה עכשיו» opens the panel; progress counter', { skip: skip && 'playwright/chromium missing' }, async () => {
  const srv = await boot();
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  // two more old leads with no contact and no task
  const extra = [{ id: 'T1', name: 'ישן מאוד', house: 'רמות השבים', stage: 'new', created: daysAgo(90), assignedTo: 'ורד', phone: '0507777777', note: 'אבא מטפל' }, { id: 'T2', name: 'ישן', house: 'קיסריה ריהאב', stage: 'new', created: daysAgo(60) }];
  DATA.leads.push(...extra);
  let openTasks = TASKS.tasks.slice();
  tasksAnswer = () => ({ ok: true, total: openTasks.length, tasks: openTasks });
  saveAnswer = (p) => {
    if (p.action === 'createTask') { openTasks = openTasks.concat([Object.assign({ id: 'task-new-' + openTasks.length, status: 'open' }, p.task)]); return { ok: true, task: { id: 'task-new' } }; }
    if (p.action === 'saveAll') return { ok: true, proven: { leads: (p.leads || []).map((l) => String(l.id)), patients: [] } };
    if (p.action === 'moveLeadIrrelevant') return { ok: true, lead: { id: String(p.lead && p.lead.id) } };
    return null;
  };
  try {
    const { page, errors } = await open(browser, srv.port, 'vered', 1366);
    await page.waitForSelector('.kpis.cards');
    await page.waitForFunction(() => !/טוען/.test(document.querySelector('.kpi[data-domain="newleads"]').textContent), null, { timeout: 5000 });
    await page.click('#crm-nav button[data-area="leads"]');
    const btn = page.locator('button[data-area="triage"]');
    assert.match(await btn.textContent(), /רשומות שדורשות בירור\s*3/, 'T1, T2 and L6 — computed, not 75');
    await btn.click();
    assert.equal(await page.textContent('#crm-title'), 'רשומות שדורשות בירור');
    assert.match(await page.textContent('.day-date'), /0 \/ 3 הוחלט/);
    let card = await page.textContent('.triage-card');
    assert.match(card, /ישן מאוד/, 'oldest first'); assert.match(card, /90 ימים/); assert.match(card, /אבא מטפל/); assert.match(card, /אין מגע מתועד/);
    assert.match(card, /הבאה: ישן/);
    assert.equal(await page.$$eval('.triage-options .opt', (els) => els.length), 6);
    // «לחזור בתאריך» → a call task → the record leaves the queue
    await page.click('[data-triage-opt="later"]');
    await page.click('form[data-form="triage-later"] button[type="submit"]');
    assert.match(await page.textContent('form[data-form="triage-later"] [data-err="dueDate"]'), /תאריך/);
    await page.fill('form[data-form="triage-later"] input[name="dueDate"]', daysAgo(-2));
    await page.fill('form[data-form="triage-later"] input[name="reason"]', 'לבדוק אם עדיין רלוונטי');
    await page.click('form[data-form="triage-later"] button[type="submit"]');
    await page.waitForFunction(() => /1 \/ 3 הוחלט/.test(document.querySelector('#crm-main').textContent), null, { timeout: 5000 });
    const created = srv.saves.filter((x) => x.action === 'createTask')[0];
    assert.equal(created.task.leadId, 'T1'); assert.equal(created.task.kind, 'call'); assert.equal(created.task.dueDate, daysAgo(-2)); assert.match(created.task.title, /לבדוק אם עדיין רלוונטי/);
    card = await page.textContent('.triage-card');
    assert.match(card, /^(?!.*ישן מאוד)/, 'T1 left the queue'); assert.match(card, /קיסריה ריהאב/);
    // «רשימת המתנה» → validation → ONE lead saveAll + the review task
    await page.click('[data-triage-opt="waitlist"]');
    await page.click('form[data-form="triage-waitlist"] button[type="submit"]');
    assert.match(await page.textContent('form[data-form="triage-waitlist"] [data-err="reason"]'), /סיבה/);
    assert.match(await page.textContent('form[data-form="triage-waitlist"] [data-err="checkDate"]'), /תאריך בדיקה/);
    assert.equal(srv.saves.filter((x) => x.action === 'saveAll').length, 0, 'nothing posted on a client error');
    await page.selectOption('form[data-form="triage-waitlist"] select[name="assignee"]', 'דנה');
    await page.fill('form[data-form="triage-waitlist"] input[name="checkDate"]', daysAgo(-14));
    await page.fill('form[data-form="triage-waitlist"] input[name="reason"]', 'אין מקום בריהאב');
    await page.click('form[data-form="triage-waitlist"] button[type="submit"]');
    await page.waitForFunction(() => /2 \/ 3 הוחלט/.test(document.querySelector('#crm-main').textContent), null, { timeout: 5000 });
    const wl = srv.saves.filter((x) => x.action === 'saveAll')[0];
    assert.equal(wl.leads.length, 1); assert.equal(wl.leads[0].id, 'T2'); assert.equal(wl.leads[0].stage, 'waitlist'); assert.equal(wl.leads[0].assignedTo, 'דנה'); assert.match(wl.leads[0].note, /רשימת המתנה: אין מקום בריהאב/);
    assert.deepEqual(wl.patients, {}, 'no house touched');
    const review = srv.saves.filter((x) => x.action === 'createTask')[1];
    assert.equal(review.task.kind, 'review'); assert.equal(review.task.leadId, 'T2'); assert.equal(review.task.dueDate, daysAgo(-14)); assert.match(review.task.title, /לבדוק מקום פנוי/);
    // skip → next; «שיחה עכשיו» opens the panel; «סגירה» needs a reason
    card = await page.textContent('.triage-card');
    assert.match(card, /מאיה שגב/); assert.match(card, /זו האחרונה/);
    await page.click('[data-triage-opt="call"]');
    await page.waitForSelector('form[data-form="contact"]');
    assert.match(await page.textContent('#crm-drawer .drawer-head'), /מאיה שגב/);
    await page.click('[data-contact-cancel]');
    await page.keyboard.press('Escape');
    await page.click('[data-triage-opt="close"]');
    await page.click('form[data-form="triage-close"] button[type="submit"]');
    assert.match(await page.textContent('form[data-form="triage-close"] [data-err="reason"]'), /סיבה/);
    await page.fill('form[data-form="triage-close"] input[name="reason"]', 'כפול');
    await page.click('form[data-form="triage-close"] button[type="submit"]');
    await page.waitForFunction(() => /3 \/ 3 הוחלט/.test(document.querySelector('#crm-main').textContent), null, { timeout: 5000 });
    const closed = srv.saves.filter((x) => x.action === 'moveLeadIrrelevant')[0];
    assert.equal(closed.lead.id, 'L6'); assert.equal(closed.lead.disposition, 'not_relevant'); assert.match(closed.lead.note || closed.lead.closeNote || JSON.stringify(closed.lead), /כפול/);
    assert.match(await page.textContent('#crm-main'), /אין רשומות שדורשות בירור/);
    assert.deepEqual(errors, []);
  } finally { DATA.leads.splice(DATA.leads.length - extra.length, extra.length); await browser.close(); srv.close(); }
});

test('Vered 04/11/2026: the app icon in the menu; «לידים»; no urgent band; a patient-side reschedule saves the lead, records the change and offers the manager WhatsApp (CHANGELOG-crm-vered-feedback-1104.md)', { skip: skip && 'playwright/chromium missing' }, async () => {
  const srv = await boot();
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  try {
    const { page, errors } = await open(browser, srv.port, 'vered', 1366);
    assert.equal(await page.getAttribute('.crm-brand img.logo', 'src'), '/icons/icon-192.png');
    assert.equal(await page.getAttribute('link[rel="icon"]', 'href'), '/icons/icon-192.png');
    assert.equal(await page.locator('#crm-main section.urgent').count(), 0);
    await page.click('[data-area="leads"]');
    assert.equal(await page.textContent('#crm-title'), 'לידים');
    await page.click('.card[data-open-lead="L2"] .name');
    const f = '#crm-drawer form[data-form="patient-change"]';
    await page.locator(f).locator('..').locator('summary').click();
    await page.click(f + ' button[type="submit"]');
    assert.match(await page.textContent(f + ' [data-err="change"]'), /בוטלה או שונה מועד/, 'nothing is chosen → refused in the page');
    const newDay = daysAgo(-3);
    await page.check(f + ' input[name="change"][value="rescheduled"]');
    await page.fill(f + ' input[name="newDate"]', newDay);
    await page.fill(f + ' input[name="newTime"]', '12:15');
    await page.fill(f + ' input[name="note"]', 'ביקשו לדחות');
    await page.click(f + ' button[type="submit"]');
    await page.waitForSelector('#crm-drawer a[data-wa-manager]', { timeout: 5000 });
    const save = srv.saves.filter((x) => x.action === 'saveAll').pop();
    assert.deepEqual([save.leads[0].id, save.leads[0].visitDate, save.leads[0].visitTime, save.leads[0].meetingOutcome], ['L2', newDay, '12:15', '']);
    const flag = srv.saves.filter((x) => x.action === 'logLeadFlag').pop();
    assert.deepEqual([flag.flag.leadId, flag.flag.kind, flag.flag.change, flag.flag.prevDate, flag.flag.prevTime, flag.flag.newDate, flag.flag.withWhom], ['L2', 'meeting_patient_change', 'rescheduled', TODAY, '13:30', newDay, 'אורן']);
    assert.match(flag.submissionId, /^sub-[0-9a-f]{32}$/);
    const href = await page.getAttribute('#crm-drawer a[data-wa-manager]', 'href');
    assert.match(href, /^https:\/\/wa\.me\/\d*\?text=/);
    assert.match(decodeURIComponent(href.split('?text=')[1]), /גלי כהן.*שינה\/תה את מועד הפגישה.*ביקשו לדחות/s);
    assert.match(await page.textContent('#crm-drawer .drawer-head'), /שונתה ע״י המטופל\/ת/, 'the card says who changed it');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); srv.close(); }
});

test('Vered 04/11/2026 (2): every save shows a spinner on its button until the answer; «סיבת המתנה» saves on the click (no hidden «שמירה»), the chip shows the reason next to any other next step (CHANGELOG-crm-followups-1104.md)', { skip: skip && 'playwright/chromium missing' }, async () => {
  const srv = await boot();
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  try {
    const { page, errors } = await open(browser, srv.port, 'vered', 1366);
    // slow every write by 700 ms so the busy state is observable
    await page.route('**/api/sheets', async (route) => {
      const b = route.request().postData();
      if (b && /"action":"(saveAll|logLeadFlag)"/.test(b)) await new Promise((r) => setTimeout(r, 700));
      route.continue();
    });
    await page.click('[data-area="leads"]');
    await page.click('.card[data-open-lead="L2"] .name');
    const f = '#crm-drawer form[data-form="note"]';
    await page.locator(f).locator('..').locator('summary').click();
    await page.fill(f + ' textarea[name="note"]', 'בדיקת ספינר');
    await page.click(f + ' button[type="submit"]');
    await page.waitForSelector(f + ' button[type="submit"][aria-busy="true"]', { state: 'attached', timeout: 2000 });
    assert.equal(await page.$eval(f + ' button[type="submit"]', (b) => b.disabled), true, 'disabled while saving');
    await page.waitForFunction((sel) => { const b = document.querySelector(sel); return b && b.getAttribute('aria-busy') !== 'true' && !b.disabled; }, f + ' button[type="submit"]', { timeout: 5000 });
    // → רשימת המתנה, then the reason saves on the click
    await page.click('#crm-drawer [data-stage-next="L2"]');
    await page.waitForSelector('#crm-drawer form[data-form="wait-reason"]', { timeout: 5000 });
    assert.equal(await page.locator('#crm-drawer form[data-form="wait-reason"] button[type="submit"]').count(), 0, 'no separate «שמירה» to forget');
    // clicked while the stage move is still saving (700 ms) — the choice waits, it is never dropped
    await page.check('#crm-drawer form[data-form="wait-reason"] input[value="funder"]');
    await page.waitForFunction(() => /שומר/.test((document.querySelector('#crm-drawer [data-wait-state]') || {}).textContent || ''), null, { timeout: 2000 });
    await page.waitForFunction(() => /נשמר/.test((document.querySelector('#crm-drawer [data-wait-state]') || {}).textContent || ''), null, { timeout: 5000 });
    const flag = srv.saves.filter((x) => x.action === 'logLeadFlag').pop();
    assert.deepEqual([flag.flag.leadId, flag.flag.kind, flag.flag.reason], ['L2', 'waitlist_reason', 'funder']);
    assert.match(await page.textContent('#crm-drawer .drawer-head'), /ממתין לאישור הקופה/);
    await page.click('#crm-drawer-close');
    assert.match(await page.textContent('.card[data-open-lead="L2"]'), /ממתין לאישור הקופה/, 'the board card shows the reason');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); srv.close(); }
});

test('Vered 04/11/2026 (3): a released patient\'s card says «שוחרר/ה» with the exit date and offers «העבר לאמבולטורי» — phone optional, asked only when none is found (CHANGELOG-crm-followups-1104.md)', { skip: skip && 'playwright/chromium missing' }, async () => {
  const srv = await boot();
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  try {
    const { page, errors } = await open(browser, srv.port, 'vered', 1366);
    const outCalls = [];
    await page.route('**/api/outpatient-lead', (route) => {
      const b = JSON.parse(route.request().postData()); outCalls.push(b);
      route.fulfill({ status: b.phone ? 200 : 502, contentType: 'application/json', body: JSON.stringify(b.phone ? { ok: true, sent: true } : { ok: false, error: 'no_phone', message: 'לא נשלח לאמבולטורי: אין טלפון למטופל/ת.' }) });
    });
    await page.fill('#crm-search', 'נועה');
    await page.click('#crm-search-go');
    await page.locator('[data-open-patient="px"]').first().click();
    await page.waitForSelector('#crm-drawer form[data-form="out-phone"]', { timeout: 5000 });
    const head = await page.textContent('#crm-drawer');
    assert.match(head, /שוחרר\/ה/); assert.ok(!/\breleased\b/.test(head), 'no raw status key'); assert.match(head, /תאריך יציאה/);
    await page.click('#crm-drawer form[data-form="out-phone"] button[type="submit"]');   // no phone typed → the server is asked first
    await page.waitForFunction(() => /לא נמצא טלפון/.test((document.querySelector('#crm-drawer form[data-form="out-phone"] [data-err="phone"]') || {}).textContent || ''), null, { timeout: 5000 });
    await page.fill('#crm-drawer form[data-form="out-phone"] input[name="phone"]', '0527654321');
    await page.click('#crm-drawer form[data-form="out-phone"] button[type="submit"]');
    await page.waitForFunction(() => /נשלח לאמבולטורי ✓/.test(document.querySelector('#crm-drawer').textContent), null, { timeout: 5000 });
    assert.deepEqual(outCalls, [{ dischargeId: 'dx1', manual: true }, { dischargeId: 'dx1', manual: true, phone: '0527654321' }]);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); srv.close(); }
});

/* «KPI», «תפוסה היום», «בקרת עבודה», «חריגים לבדיקה» (CHANGELOG-crm-kpi-tab.md) */
test('CRM «KPI» (Vered + Dana): sections render, break-even is finance-only and its expenses save to the shared browser key; «תפוסה היום»; «חריגים לבדיקה» in «גבייה»', { skip: skip && 'playwright/chromium missing' }, async () => {
  const srv = await boot();
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  try {
    for (const width of [1366, 390]) {
      const { ctx, page, errors } = await open(browser, srv.port, 'vered', width);
      if (width === 390) await page.click('#crm-burger');
      await page.click('#crm-nav button[data-area="kpi"]');
      await page.waitForSelector('#crm-kpi-occ');
      for (const sel of ['#crm-kpi-periods', '#crm-kpi-occ-houses', '#crm-kpi-conv', '#crm-kpi-network', '#crm-kpi-breakeven', '#crm-kpi-stay']) assert.ok(await page.$(sel), sel + ' at ' + width);
      assert.match(await page.textContent('#crm-title'), /KPI/);
      await page.click('[data-kpi-period="this_year"]');
      assert.equal(await page.getAttribute('[data-kpi-period="this_year"]', 'aria-pressed'), 'true');
      assert.ok(await noHScroll(page), 'no horizontal scroll at ' + width);
      if (width === 1366) {
        await page.click('#crm-be-edit summary');
        await page.fill('form[data-form="breakeven"] [name="hqCost"]', '250000');
        await page.click('form[data-form="breakeven"] button[type="submit"]');
        await page.waitForFunction(() => /עלות מטה/.test(document.querySelector('#crm-kpi-network').textContent) && /250,000/.test(document.querySelector('#crm-kpi-network').textContent));
        const stored = JSON.parse(await page.evaluate(() => localStorage.getItem('ezone-breakeven-v1')));
        assert.equal(stored.hqCost, 250000, 'the classic tab\'s key');
        await page.click('#crm-nav button[data-area="occupancy"]');
        await page.waitForSelector('#crm-occ-today');
        assert.match(await page.textContent('#crm-occ-today'), /תפוסה היום/);
        assert.match(await page.textContent('#crm-occ-today'), /%/);
        await page.click('#crm-nav button[data-area="control"]');
        await page.waitForSelector('#crm-control-about');
        await page.click('#crm-nav button[data-area="billing"]');
        await page.waitForSelector('#crm-anomalies-title');
        assert.ok(await page.$('#crm-anomalies tr[data-anomaly="zero_pay_in_house"]'), 'a patient in the house with price 0 is listed');
        await page.click('#crm-anomalies tr[data-anomaly="zero_pay_in_house"] [data-open-patient]');
        await page.waitForSelector('#crm-drawer[aria-hidden="false"]');
      }
      assert.deepEqual(errors, []);
      await ctx.close();
    }
    const { ctx, page, errors } = await open(browser, srv.port, 'dana', 1366);
    await page.click('#crm-nav button[data-area="kpi"]');
    await page.waitForSelector('#crm-kpi-occ');
    assert.equal(await page.$('#crm-kpi-breakeven'), null, 'no break-even for an operational session');
    assert.deepEqual(errors, []);
    await ctx.close();
  } finally { await browser.close(); srv.close(); }
});

/* Manual credits + credit edit in the CRM (CHANGELOG-crm-manual-credits.md) */
test('CRM credits (Vered edits, Sandra adds a manual credit): saveCredit from the patient card; reasons enforced; no classic link', { skip: skip && 'playwright/chromium missing' }, async () => {
  const srv = await boot();
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  try {
    const openAccount = async (id) => {
      const o = await open(browser, srv.port, id, 1366);
      await o.page.click('#crm-nav button[data-area="clients"]');
      await o.page.click('table.tbl tbody tr[data-open-patient="p1"]');
      await o.page.waitForSelector('#crm-drawer[aria-hidden="false"]');
      await o.page.click('#crm-drawer [data-tab="account"]');
      await o.page.waitForSelector('#crm-account-credits');
      return o;
    };
    const v = await openAccount('vered');
    assert.equal(await v.page.$('[data-credit-new]'), null, 'Vered has no manual-credit button (Sandra only)');
    await v.page.click('#crm-account-credits [data-credit-edit="cr-1"]');
    await v.page.waitForSelector('form[data-form="credit-edit"]');
    assert.equal(await v.page.getAttribute('form[data-form="credit-edit"] [name="amount"]', 'readonly'), '', 'amount is Sandra\'s');
    await v.page.fill('form[data-form="credit-edit"] [name="notes"]', 'עודכן מול המשפחה');
    await v.page.click('form[data-form="credit-edit"] button[type="submit"]');
    await v.page.waitForFunction(() => /הזיכוי נשמר/.test((document.querySelector('#crm-toast') || {}).textContent || ''), null, { timeout: 5000 });
    const edit = srv.saves.filter((x) => x.action === 'saveCredit')[0];
    assert.deepEqual([edit.credit.id, edit.credit.amount, edit.credit.status, edit.credit.notes], ['cr-1', 1200, 'pending', 'עודכן מול המשפחה']);
    assert.ok(!(await v.page.textContent('#crm-drawer')).includes('וזיכויים ידניים בדשבורד'));
    assert.deepEqual(v.errors, []);
    await v.ctx.close();
    const sa = await openAccount('sandra');
    await sa.page.click('[data-credit-new]');
    await sa.page.waitForSelector('form[data-form="credit-new"]');
    await sa.page.fill('form[data-form="credit-new"] [name="amount"]', '500');
    await sa.page.click('form[data-form="credit-new"] button[type="submit"]');
    await sa.page.waitForFunction(() => /סיבה/.test((document.querySelector('form[data-form="credit-new"] .err[data-err="reason"]') || {}).textContent || ''));
    assert.equal(srv.saves.filter((x) => x.action === 'saveCredit').length, 1, 'nothing sent without a reason');
    await sa.page.fill('form[data-form="credit-new"] [name="reason"]', 'מחווה למשפחה');
    await sa.page.click('form[data-form="credit-new"] button[type="submit"]');
    await sa.page.waitForFunction(() => /הזיכוי נשמר/.test((document.querySelector('#crm-toast') || {}).textContent || ''), null, { timeout: 5000 });
    const made = srv.saves.filter((x) => x.action === 'saveCredit')[1];
    assert.deepEqual([made.credit.id, made.credit.creditType, made.credit.amount, made.credit.reason, made.credit.patientId], ['', 'other', 500, 'מחווה למשפחה', 'p1']);
    assert.deepEqual(sa.errors, []);
    await sa.ctx.close();
  } finally { await browser.close(); srv.close(); }
});

/* A task reminder before it is due (CHANGELOG-crm-task-date-time.md) */
test('task reminder: a task of mine due in ~10 minutes is announced once (toast); it is on «היום שלי»', { skip: skip && 'playwright/chromium missing' }, async () => {
  const hm = (ms) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));
  const soon = Date.now() + 10 * 60000;
  if (israelDay(soon) !== TODAY) return;   // never across midnight
  const srv = await boot();
  tasksAnswer = () => ({ ok: true, total: 1, tasks: [{ id: 'task-' + '9'.repeat(32), kind: 'call', leadId: 'L1', title: 'להתקשר לבעלה', assignee: 'ורד', dueDate: TODAY, dueTime: hm(soon), status: 'open', source: 'manual' }] });
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  try {
    const { page, errors } = await open(browser, srv.port, 'vered', 1366);
    await page.waitForFunction(() => /להתקשר לבעלה/.test((document.querySelector('#crm-toast') || {}).textContent || ''), null, { timeout: 8000 });
    assert.match(await page.textContent('#crm-toast'), /⏰ בעוד (9|10) דק׳/);
    assert.match(await page.textContent('#crm-main'), /להתקשר לבעלה/, 'on «היום שלי»');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); srv.close(); }
});

for (const width of [1366, 390]) {
  test(`audit acceptance ${width}px: collection owner, cancellation and exact report drill-down`, { skip: skip && 'playwright/chromium missing' }, async () => {
    const savedLeads = DATA.leads;
    const makeLead = (id, extra = {}) => ({ id, name: 'בדיקת קבלה ' + id, house: 'ramot', stage: 'visit', assignedTo: 'ורד', visitDate: daysAgo(4), created: daysAgo(8), ...extra });
    DATA.leads = [
      ...Array.from({ length: 3 }, (_, i) => makeLead('unread-' + i, { meetingReportedAt: daysAgo(2) + 'T09:00:00Z' })),
      ...Array.from({ length: 14 }, (_, i) => makeLead('decision-' + i, { meetingReportedAt: daysAgo(2) + 'T09:00:00Z', meetingSeen: '1' })),
      ...Array.from({ length: 8 }, (_, i) => makeLead('missing-' + i)),
      makeLead('cancelled', { meetingOutcome: 'cancelled' })
    ];
    // This fixture changes upstream data directly between reads; disable its
    // read cache so the case measures queue behavior, not the 30-second TTL.
    const srv = await boot({ readCacheMs: 0 });
    let nextTasks = [];
    tasksAnswer = () => ({ ok: true, total: nextTasks.length, tasks: nextTasks });
    indexAnswer = () => ({ ok: true, leads: {}, patients: {}, flags: {} });
    const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
    try {
      const { page, errors } = await open(browser, srv.port, 'vered', width);
      await page.waitForSelector('[data-row^="d:"]');
      await page.selectOption('#f-owner', 'ורד');
      assert.equal(await page.locator('[data-row^="d:"]').count(), 2, 'both debt cycles survive owner filter');
      await page.locator('button.kpi[data-domain="followup"]').click();
      assert.equal(await page.locator('[data-row="f:cancel:cancelled"]').count(), 1);
      if (width < 600) await page.click('#crm-burger');
      await page.click('#crm-nav [data-area="control"]');
      const unread = page.locator('.kpi').filter({ hasText: 'דיווחי מנהל/ת שלא נקראו' });
      assert.equal(await unread.locator('.v').textContent(), '3');
      await unread.click();
      const section = page.locator('[data-control-section="unseen"]');
      assert.equal(await section.locator('[data-row]').count(), 3);
      assert.equal(await section.locator('[data-open-lead^="decision-"]').count(), 0);
      assert.equal(await section.locator('[data-open-lead^="missing-"]').count(), 0);
      assert.equal(await noHScroll(page), true, 'exact queue fits the viewport');
      if (process.env.EZONE_AUDIT_SCREENSHOT_DIR) await page.screenshot({ path: pathForAuditScreenshot(width), fullPage: true });
      await section.getByRole('button', { name: 'חזרה לכל התחומים', exact: true }).click();
      assert.equal(await page.locator('[data-control-section]').count(), 0);
      nextTasks = [{ id: 'task-audit-callback', kind: 'call', leadId: 'cancelled', title: 'חזרה אחרי ביטול', assignee: 'ורד', dueDate: daysAgo(-3), status: 'open', source: 'manual' }];
      await page.reload({ waitUntil: 'networkidle' });
      await page.locator('button.kpi[data-domain="followup"]').click();
      assert.equal(await page.locator('[data-row="f:cancel:cancelled"]').count(), 0, 'existing future callback prevents duplicate follow-up');
      await page.locator('button.kpi[data-domain="calls"]').click();
      assert.equal(await page.locator('[data-row]').filter({ hasText: 'חזרה אחרי ביטול' }).count(), 1);
      assert.deepEqual(srv.saves, [], 'all browser actions are fixture reads');
      assert.deepEqual(errors, []);
    } finally { await browser.close(); srv.close(); DATA.leads = savedLeads; }
  });
}
function pathForAuditScreenshot(width) {
  return require('node:path').join(process.env.EZONE_AUDIT_SCREENSHOT_DIR, 'dashboard-control-' + width + '.png');
}
