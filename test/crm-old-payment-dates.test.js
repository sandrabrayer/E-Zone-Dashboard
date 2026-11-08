'use strict';

/* CHANGELOG-crm-old-payment-dates.md — Vered could not save «דווח תשלום» on an
 * OLD cycle from the new (CRM) screen.
 *
 * Older Payments rows hold real Date cells. getPayments_ hands them to the
 * browser as UTC timestamps (Israel's 1 April = "2026-03-31T21:00:00.000Z"),
 * and the CRM cut them with .slice(0, 10) → one day early. The form then
 * pre-filled a coverage start one day BEFORE the cycle and Code.gs refused it
 * (coverage_outside_cycle). These tests run the REAL Code.gs (test/helpers/
 * gs-sandbox.js) end to end: legacy row → getPayments → crm.js patientAccount
 * → the report form's cycle + defaults → reportPayment as Vered. */

// Code.gs runs with the script time zone Asia/Jerusalem (apps-script/appsscript.json);
// its localPartsISO_ reads a Date by LOCAL parts. node --test gives this file its own
// process, so pinning the zone here touches no other test.
process.env.TZ = 'Asia/Jerusalem';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGs } = require('./helpers/gs-sandbox');
const core = require('../public/crm/crm.js');

const PROXY_SECRET = 'proxy-secret-TEST-crm-old-payment-dates-0123456789';
const jerusalemDay = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(d);
// Israel midnight of a calendar day, as the Date a Sheets date cell holds.
const israelMidnight = (iso) => {
  for (const off of [2, 3]) {
    const d = new Date(Date.parse(iso + 'T00:00:00Z') - off * 3600000);
    if (jerusalemDay(d) === iso && jerusalemDay(new Date(d.getTime() - 1)) !== iso) return d;
  }
  throw new Error('no Israel midnight for ' + iso);
};
const vered = (body) => Object.assign({
  proxySecret: PROXY_SECRET, proxyUser: 'ורד', user: 'ורד', proxyAuth: 'personal', proxyUserId: 'vered',
  proxyRoles: ['staff', 'reporter', 'deleter'], proxyCaps: ['finance', 'billingControl'],
}, body);

function loadWithJerusalemDates() {
  const g = loadGs({ props: { PROXY_SECRET, PROXY_SECRET_MODE: 'enforce' } });
  // The real Utilities.formatDate honours its time-zone argument; the shared stub does not.
  g.sandbox.Utilities.formatDate = (d, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'Asia/Jerusalem' }).format(new Date(d));
  // A sheet cell is a Date of the SCRIPT's realm (instanceof Date holds there).
  g.cellDate = (iso) => g.run('new Date(' + israelMidnight(iso).getTime() + ')');
  return g;
}

test('sheetDay: a bare day stays; a UTC timestamp is its Israel calendar day; junk is blank', () => {
  assert.equal(core.sheetDay('2026-04-01'), '2026-04-01');
  assert.equal(core.sheetDay('2026-03-31T21:00:00.000Z'), '2026-04-01', 'summer time (UTC+3)');
  assert.equal(core.sheetDay('2026-01-14T22:00:00.000Z'), '2026-01-15', 'winter time (UTC+2)');
  assert.equal(core.sheetDay('2026-04-01T09:30:00.000Z'), '2026-04-01', 'a daytime stamp keeps its day');
  assert.equal(core.sheetDay(new Date('2026-03-31T21:00:00.000Z')), '2026-04-01', 'a Date object');
  assert.equal(core.sheetDay(''), '');
  assert.equal(core.sheetDay(null), '');
  assert.equal(core.sheetDay('not a date'), '');
  assert.equal(core.sheetDay(new Date('x')), '');
});

test('patientAccount / receiptsOf / creditsOf / detachedRows read Date-typed sheet cells on the right day', () => {
  const pat = { id: 'p1', name: 'דנה כהן', houseId: 'ramot', date: '2026-01-01' };
  const key = core.patientKeyOf(pat);
  const payments = { ok: true,
    payments: [{ id: 'pay::' + key + '::2026-04-01', patientId: key, patientName: 'דנה כהן', houseId: 'ramot', dueDate: '2026-03-31T21:00:00.000Z',
      amount: 6000, amountPaid: 0, balance: 6000, status: 'unpaid', coverageStart: '2026-03-31T21:00:00.000Z', coverageEnd: '2026-04-29T21:00:00.000Z' }],
    receipts: [{ id: 'rcpt-1', patientId: key, receivedDate: '2026-04-04T21:00:00.000Z', dueDate: '2026-03-31T21:00:00.000Z', coverageStart: '2026-03-31T21:00:00.000Z', coverageEnd: '2026-04-29T21:00:00.000Z', amount: 100 }],
    funders: [{ patientId: key, funder: 'פרטי', effectiveFrom: '2025-12-31T22:00:00.000Z' }] };
  const a = core.patientAccount(pat, { ok: true, byPatient: [] }, payments);
  assert.deepEqual([a.cycles[0].dueDate, a.cycles[0].coverageStart, a.cycles[0].coverageEnd], ['2026-04-01', '2026-04-01', '2026-04-30']);
  assert.deepEqual([a.receipts[0].receivedDate, a.receipts[0].dueDate, a.receipts[0].coverageStart], ['2026-04-05', '2026-04-01', '2026-04-01']);
  assert.equal(a.funders[0].effectiveFrom, '2026-01-01');
  const cr = core.creditsOf({ ok: true, credits: [{ id: 'c1', allocationMonth: '2026-03-31T21:00:00.000Z', payoutDate: '2026-04-09T21:00:00.000Z', amount: 5, status: 'pending' },
    { id: 'c2', allocationMonth: '2026-05', amount: 5, status: 'pending' }] });
  assert.deepEqual([cr[0].allocationMonth, cr[0].payoutDate, cr[1].allocationMonth], ['2026-04', '2026-04-10', '2026-05']);
  const det = core.detachedRows({ ok: true, detachedPayments: { rows: [{ paymentId: 'x', dueDate: '2026-03-31T21:00:00.000Z', reason: 'unmatched' }] } });
  assert.equal(det[0].dueDate, '2026-04-01');
});

test('END TO END (real Code.gs): Vered reports a payment on an OLD cycle stored with Date cells → saved, receipt on that cycle', () => {
  const g = loadWithJerusalemDates();
  // A real old cycle: two months ago, inside the 90-day staff window.
  const today = jerusalemDay(new Date());
  const due = core.addMonthsIso(today, -2).slice(0, 8) + '01';
  const end = core.addMonthsIso(due, 1).slice(0, 8) + '01';
  const endDay = new Date(Date.parse(end + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
  const pat = { id: 'p1', name: 'דנה כהן', houseId: 'ramot', date: core.addMonthsIso(due, -3), pay: 6000 };
  const key = core.patientKeyOf(pat);
  const cycleId = 'pay::' + key + '::' + due;

  // Seed the legacy row: dueDate / coverage as Date cells (pre text-format rows).
  const cols = Array.from(g.run('PAYMENT_COLUMNS'));
  const row = cols.map((c) => ({
    id: cycleId, patientId: key, patientName: 'דנה כהן', houseId: 'ramot', dueDate: g.cellDate(due), amount: 6000,
    status: 'unpaid', amountPaid: 0, balance: 6000, timestamp: '2025-01-01T00:00:00.000Z',
    coverageStart: g.cellDate(due), coverageEnd: g.cellDate(endDay),
  }[c] ?? ''));
  g.run('getOrCreateSheet_(PAYMENTS_SHEET, PAYMENT_COLUMNS)');
  g.sandbox.__sheets[g.run('PAYMENTS_SHEET')].grid.push(row);

  // The read the CRM makes (JSON over the wire: a Date becomes a UTC timestamp).
  const payments = g.post(vered({ action: 'getPayments' }));
  assert.equal(payments.ok, true);
  const wire = payments.payments.find((p) => p.id === cycleId);
  assert.match(String(wire.coverageStart), /T\d{2}:/, 'the legacy cell reaches the browser as a timestamp — the case under test');

  // The CRM builds the form exactly as the drawer does: debtAging's open cycle → the row.
  const debt = { ok: true, byPatient: [{ patientId: 'p1', cycles: [{ start: due, end: endDay, expected: 6000, received: 0, balance: 6000, days: 60, kind: 'recorded', paymentId: cycleId, month: due.slice(0, 7) }] }] };
  const account = core.patientAccount(pat, debt, payments);
  const cycle = core.reportCycleFor(pat, account.openCycles[0], account);
  assert.equal(cycle.coverageStart, due, 'coverage starts ON the cycle start, not the day before');
  assert.equal(cycle.dueDate, due);
  const values = Object.assign(core.reportDefaults(cycle, 6000, today, 'פרטי'),
    { receivedDate: core.addMonthsIso(today, -1), method: 'מזומן', payer: 'אמא של דנה', invoiceWanted: 'no' });
  assert.deepEqual(core.reportIssues(values, today, false), [], 'the form itself has nothing to complain about');

  const res = g.post(vered(core.reportBody(cycle, values, 'sub-' + 'b'.repeat(32), false)));
  assert.equal(res.ok, true, 'saved: ' + JSON.stringify(res).slice(0, 300));
  assert.ok(res.receipt && String(res.receipt.id).startsWith('rcpt-'));
  assert.equal(res.cycle.id, cycleId, 'the receipt pays the OLD cycle, no new cycle minted');
  assert.equal(core.reportOutcome(res).ok, true);
});

test('the bug, pinned: the old .slice(0, 10) cut lands the coverage start one day before the cycle and Code.gs refuses it', () => {
  const g = loadWithJerusalemDates();
  const today = jerusalemDay(new Date());
  const due = core.addMonthsIso(today, -2).slice(0, 8) + '01';
  const endDay = new Date(Date.parse(core.addMonthsIso(due, 1) + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
  const key = 'ramot::דנה כהן::' + core.addMonthsIso(due, -3);
  const cycleId = 'pay::' + key + '::' + due;
  const cols = Array.from(g.run('PAYMENT_COLUMNS'));
  g.run('getOrCreateSheet_(PAYMENTS_SHEET, PAYMENT_COLUMNS)');
  g.sandbox.__sheets[g.run('PAYMENTS_SHEET')].grid.push(cols.map((c) => ({
    id: cycleId, patientId: key, patientName: 'דנה כהן', houseId: 'ramot', dueDate: g.cellDate(due), amount: 6000, status: 'unpaid',
    amountPaid: 0, balance: 6000, coverageStart: g.cellDate(due), coverageEnd: g.cellDate(endDay) }[c] ?? '')));
  const wire = g.post(vered({ action: 'getPayments' })).payments.find((p) => p.id === cycleId);
  const sliced = String(wire.coverageStart).slice(0, 10);
  assert.notEqual(sliced, due, 'the naive cut is a day early');
  const res = g.post(vered({ action: 'reportPayment', report: { cycle: { id: cycleId, patientId: key, dueDate: sliced, amount: 6000, coverageStart: sliced, coverageEnd: endDay },
    report: { receivedDate: core.addMonthsIso(today, -1), amount: '6000', method: 'מזומן', payer: 'אמא', reference: '', funder: 'פרטי', coverageStart: sliced, coverageEnd: endDay, invoiceWanted: 'no', invoiceTo: '' },
    submissionId: 'sub-' + 'c'.repeat(32) } }));
  assert.equal(res.ok, false);
  assert.equal(res.issues[0].code, 'coverage_outside_cycle');
  assert.equal(core.sheetDay(wire.coverageStart), due, 'sheetDay reads the same cell on the right day');
});
