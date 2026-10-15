'use strict';

// Real Code.gs, synthetic Sheets only. Throw before/after an individual row
// write to model both a rejected write and a committed write with a lost ack.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGs, richSheet } = require('./helpers/gs-sandbox');

const SECRET = 'synthetic-report-recovery-0123456789abcdef';
const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());
const start = day.slice(0, 8) + '01';
const end = new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)), 0)).toISOString().slice(0, 10);
const key = 'sub-recovery-fixed-submission';

function world(kind) {
  const g = loadGs({ props: { PROXY_SECRET: SECRET, PROXY_SECRET_MODE: 'enforce' } });
  const patient = { id: 'fixture-patient', houseId: 'arfoni', name: 'SYNTHETIC RECOVERY', date: start, pay: 10000, status: 'active' };
  const pc = Array.from(g.run('PATIENT_COLUMNS'));
  const cols = Array.from(g.run('PAYMENT_COLUMNS'));
  const S = g.sandbox.__sheets;
  S.Patients = richSheet('Patients', pc);
  S.Patients.appendRow(pc.map(k => patient[k] ?? ''));
  S.Payments = richSheet('Payments', cols);
  const pid = `arfoni::${patient.name}::${start}`;
  const cycle = { id: `pay::${pid}::${start}`, patientId: pid, patientName: patient.name,
    houseId: 'arfoni', dueDate: start, amount: 10000, coverageStart: start, coverageEnd: end };
  const actor = { proxySecret: SECRET, proxyUser: 'ורד', user: 'ורד', proxyAuth: 'personal', proxyUserId: 'vered',
    proxyRoles: ['staff', 'reporter', 'deleter'], proxyCaps: ['finance', 'billingControl'] };
  const call = body => g.post(Object.assign({}, body, actor));
  const report = (amount = 6000, submissionId = key) => call({ action: 'reportPayment', report: { cycle, submissionId,
    report: { receivedDate: day, amount, method: 'העברה בנקאית', payer: 'SYNTHETIC PAYER', reference: 'FIXTURE-01',
      funder: 'פרטי', invoiceWanted: 'no', coverageStart: start, coverageEnd: end } } });
  if (kind === 'unpaid' || kind === 'legacy') {
    const paid = kind === 'legacy' ? 2000 : 0;
    const row = Object.assign({}, cycle, { status: paid ? 'partial' : 'unpaid', amountPaid: paid, balance: 10000 - paid,
      chargedAt: paid ? start : '', chargedBy: paid ? 'legacy' : '' });
    S.Payments.appendRow(cols.map(k => row[k] ?? ''));
  }
  if (kind === 'receipts') assert.equal(report(2000, 'sub-earlier-fixture-receipt').ok, true);
  const prior = kind === 'legacy' || kind === 'receipts' ? 2000 : 0;
  const rows = () => g.sheetRows('Payments', 'PAYMENT_COLUMNS');
  const read = () => {
    const r = call({ action: 'getPayments' });
    assert.equal(r.ok, true);
    return r;
  };
  const original = S.Payments.getRange;
  let fault = null, fired = false, writes = 0;
  S.Payments.getRange = function (...args) {
    const range = original(...args), set = range.setValues;
    range.setValues = function (values) {
      const row = values[0] || [];
      const isReceipt = String(row[0]).startsWith('rcpt-');
      const isSummary = row[0] === cycle.id && Number(row[cols.indexOf('amountPaid')]) === prior + 6000;
      const hit = fault && !fired && (fault.target === 'receipt' ? isReceipt : isSummary);
      if (hit) fired = true;
      if (hit && fault.when === 'before') throw new Error('SYNTHETIC write failure');
      const result = set.call(this, values);
      writes++;
      if (hit && fault.when === 'after') throw new Error('SYNTHETIC lost write acknowledgement');
      return result;
    };
    return range;
  };
  return { g, S, cycle, prior, report, rows, read,
    arm(target, when) { fault = { target, when }; }, fired: () => fired, writes: () => writes };
}

for (const kind of ['new', 'unpaid', 'legacy', 'receipts']) {
  for (const when of ['before', 'after']) {
    test(`${kind}: ${when} receipt append failure keeps only durable money; retry adds the report once`, () => {
      const w = world(kind);
      w.arm('receipt', when);
      assert.equal(w.report().ok, false);
      assert.equal(w.fired(), true);
      const interrupted = w.read();
      const storedReceipt = interrupted.receipts.filter(r => r.submissionId === key);
      assert.equal(storedReceipt.length, when === 'after' ? 1 : 0);
      assert.equal(Number(interrupted.payments.find(p => p.id === w.cycle.id).amountPaid), w.prior + (when === 'after' ? 6000 : 0));
      const retry = w.report();
      assert.equal(retry.ok, true);
      const read = w.read();
      assert.equal(read.receipts.filter(r => r.submissionId === key).length, 1);
      assert.equal(Number(read.payments.find(p => p.id === w.cycle.id).amountPaid), w.prior + 6000);
      assert.equal(Number(w.rows().find(p => p.id === w.cycle.id).amountPaid), w.prior + 6000, 'stored cycle repaired too');
      assert.equal(Number(w.rows().find(p => p.id === w.cycle.id).legacyAmountPaid || 0), kind === 'legacy' ? 2000 : 0);
      const snapshot = JSON.stringify(w.S.Payments.grid), writes = w.writes();
      assert.equal(w.report().replayed, true);
      assert.equal(w.writes(), writes, 'a settled replay performs no Payments write');
      assert.equal(JSON.stringify(w.S.Payments.grid), snapshot);
    });
  }
}

for (const when of ['before', 'after']) {
  test(`${when} derived-cycle write failure: durable receipt is readable and replay repairs the stored cycle`, () => {
    const w = world('new');
    w.arm('summary', when);
    assert.equal(w.report().ok, false);
    assert.equal(w.fired(), true);
    const read = w.read();
    assert.equal(read.receipts.filter(r => r.submissionId === key).length, 1);
    assert.equal(Number(read.payments.find(p => p.id === w.cycle.id).amountPaid), 6000);
    const uid = read.payments.find(p => p.id === w.cycle.id).paymentUid;
    const retry = w.report();
    assert.equal(retry.ok, true);
    assert.equal(retry.replayed, true);
    assert.equal(retry.cycle.paymentUid, uid);
    assert.equal(Number(w.rows().find(p => p.id === w.cycle.id).amountPaid), 6000);
    assert.equal(w.read().receipts.filter(r => r.submissionId === key).length, 1);
  });
}

test('repeated receipt failures never increase the stored legacy balance', () => {
  const w = world('legacy');
  const original = w.S.Payments.getRange;
  let failuresLeft = 3;
  w.S.Payments.getRange = (...args) => {
    const range = original(...args), set = range.setValues;
    range.setValues = values => {
      if (failuresLeft && String((values[0] || [])[0]).startsWith('rcpt-')) {
        failuresLeft--;
        throw new Error('SYNTHETIC repeated failure');
      }
      return set.call(range, values);
    };
    return range;
  };
  for (let i = 0; i < 3; i++) {
    assert.equal(w.report().ok, false);
    assert.equal(Number(w.read().payments[0].amountPaid), 2000);
  }
  assert.equal(w.report().ok, true);
  assert.equal(Number(w.read().payments[0].amountPaid), 8000);
  assert.equal(w.read().receipts.length, 1);
});
