'use strict';
/* ONE answer for "has this patient paid this cycle" — CHANGELOG-payment-status-unified.md.
 *
 * Live symptom (11/10/2026): patients whose money was recorded still showed
 * «דווח תשלום» on «מטופלים». «מטופלים» looked the cycle up by the EXACT id
 * built from the patient's CURRENT triple; גבייה attached rows through
 * matchPatientForPayment (uid first). A house move, a rename or a payment
 * reported under the LEAD's name split the two answers.
 *
 * Contracts pinned here:
 *   - a payment reported on the lead before admission still counts after the
 *     admission (tier 5, lead_link — exact lead triple → ONE lead → ONE
 *     patient by fromLead);
 *   - a payment linked by patient id (uid) counts after a house move, and a
 *     new report lands on THAT cycle row (no second cycle);
 *   - an unmatched payment stays unattached and is flagged (detachedPayments);
 *   - multi-matches are never auto-attached (two leads, two patients);
 *   - names carrying U+FFFD crash nothing;
 *   - Code.gs recMatchPatient_ gives the same owner (parity).
 *
 * vm sandbox on the REAL public/app.js and apps-script/Code.gs. */

process.env.TZ = 'Asia/Jerusalem';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPage } = require('./helpers/app-sandbox');
const { loadGs } = require('./helpers/gs-sandbox');

const TODAY = '2026-10-11';
const plain = (v) => JSON.parse(JSON.stringify(v));

function page(fixture) {
  const p = loadPage();
  p.set({ patients: [], leads: [], irrelevantLeads: [], removedLeads: [], payments: [], receipts: [],
    billingOverrides: [], funders: [] });
  p.sandbox.__fx = fixture;
  p.run(`Object.assign(state, {
    patients: globalThis.__fx.patients || [],
    leads: globalThis.__fx.leads || [],
    payments: (globalThis.__fx.payments || []).map(normalizePayment),
  })`);
  const call = (fn, ...args) => { p.sandbox.__args = args; return p.run(`${fn}(...globalThis.__args)`); };
  const pt = (id) => p.run(`state.patients.find(x => x.id === ${JSON.stringify(id)})`);
  const pay = (id) => p.run(`state.payments.find(x => x.id === ${JSON.stringify(id)})`);
  return Object.assign(p, { call, pt, pay });
}

/* The live shapes (Payments rows 45 / 86 / 76, Patients, Leads — 11/10/2026). */
const LEAD_ERAN = { id: 'id-thozv9t9mseaelvd', name: 'ערן', house: 'קיסריה עפרוני', entryDate: '2026-10-05', stage: 'admitted' };
const PT_ERAN = { id: 'id-b345da0b', houseId: 'arfoni', name: 'ערן יצחק חונה', date: '2026-10-05', pay: 35000, status: 'active', fromLead: LEAD_ERAN.id };
const PAY_ERAN = { id: 'pay::arfoni::ערן::2026-10-05::2026-10-05', patientId: 'arfoni::ערן::2026-10-05', patientName: 'ערן',
  houseId: 'arfoni', dueDate: '2026-10-05', amount: 35000, status: 'paid', amountPaid: 35000, balance: 0 };

const PT_NOAM = { id: 'id-noam', houseId: 'arfoni', name: 'נועם שני', date: '2026-09-02', pay: 28000, status: 'active' };
const PAY_NOAM = { id: 'pay::pardes::נועם שני::2026-09-02::2026-10-02', patientId: 'pardes::נועם שני::2026-09-02', patientName: 'נועם שני',
  houseId: 'pardes', dueDate: '2026-10-02', amount: 28000, status: 'paid', amountPaid: 28000, balance: 0, patientUid: 'id-noam' };

const LEAD_AMIT = { id: 'id-o1h0tw9jmtr2gxyd', name: 'עמית יעקובי', house: 'קיסריה עפרוני', entryDate: '2026-09-07', stage: 'admitted' };
const PAY_AMIT = { id: 'pay::arfoni::עמית יעקובי::2026-09-07::2026-09-07', patientId: 'arfoni::עמית יעקובי::2026-09-07',
  patientName: 'עמית יעקובי', houseId: 'arfoni', dueDate: '2026-09-07', amount: 30000, status: 'paid', amountPaid: 30000, balance: 0 };

test('a payment reported on the LEAD before admission still counts after the admission (lead_link)', () => {
  const p = page({ patients: [PT_ERAN], leads: [LEAD_ERAN], payments: [PAY_ERAN] });
  const patient = p.pt(PT_ERAN.id);
  const m = p.call('matchPatientForPayment', p.pay(PAY_ERAN.id), p.run('state.patients'));
  assert.equal(m.via, 'lead_link');
  assert.equal(m.patient.id, PT_ERAN.id);
  // «מטופלים»: paid, no «לא דווח תשלום», no «דווח תשלום» button.
  const st = plain(p.call('patientPaymentState', patient, p.run('state.payments'), null, TODAY));
  assert.deepEqual(st, { key: 'paid', label: 'שולם', dueISO: '2026-10-05' });
  assert.equal(p.call('patientHasReportedPayment', patient, p.run('state.payments')), true);
  const row = plain(p.call('patientListRows', p.run('state'), { status: 'active' }, TODAY))[0];
  assert.equal(row.payment.key, 'paid');
  assert.ok(!row.problems.some((x) => x.code === 'no_payment'));
  // גבייה: the same row, the same patient.
  assert.equal(p.call('findPatientForPayment', p.pay(PAY_ERAN.id)).id, PT_ERAN.id);
  assert.equal(p.call('paymentForPatientOnDate', patient, '2026-10-05').id, PAY_ERAN.id);
});

test('a payment linked by patient id counts after a house move, and a new report targets THAT cycle', () => {
  const p = page({ patients: [PT_NOAM], payments: [PAY_NOAM] });
  const patient = p.pt(PT_NOAM.id);
  // Before the fix the exact id was pay::arfoni::… — not found → «לא שולם».
  assert.equal(p.call('paymentId', patient, '2026-10-02'), 'pay::arfoni::נועם שני::2026-09-02::2026-10-02');
  assert.equal(plain(p.call('patientPaymentState', patient, p.run('state.payments'), null, TODAY)).key, 'paid');
  assert.equal(p.call('patientCycleRecord', patient, '2026-10-02', p.run('state.payments')).id, PAY_NOAM.id);
  assert.equal(p.call('paymentForPatientOnDate', patient, '2026-10-02').id, PAY_NOAM.id,
    'גבייה reports onto the existing cycle — no second cycle under the new key');
});

test('an unmatched payment stays unattached and is flagged on שיוך תשלומים', () => {
  const p = page({ patients: [PT_ERAN], leads: [LEAD_ERAN, LEAD_AMIT], payments: [PAY_ERAN, PAY_AMIT] });
  assert.equal(p.call('matchPatientForPayment', p.pay(PAY_AMIT.id), p.run('state.patients')), null);
  assert.equal(p.call('findPatientForPayment', p.pay(PAY_AMIT.id)), null);
  const detached = plain(p.call('detachedPayments', p.run('state.payments'), p.run('state.patients'))).map((x) => x.id);
  assert.deepEqual(detached, [PAY_AMIT.id], 'flagged for a person; ערן\'s row is attached');
});

test('fail-closed: two leads with the same triple, or two patients from one lead, attach nothing', () => {
  const twin = Object.assign({}, LEAD_ERAN, { id: 'id-lead-twin' });
  let p = page({ patients: [PT_ERAN], leads: [LEAD_ERAN, twin], payments: [PAY_ERAN] });
  assert.equal(p.call('matchPatientForPayment', p.pay(PAY_ERAN.id), p.run('state.patients')), null, 'two leads');
  assert.equal(plain(p.call('patientPaymentState', p.pt(PT_ERAN.id), p.run('state.payments'), null, TODAY)).key, 'unpaid');

  const second = Object.assign({}, PT_ERAN, { id: 'id-other', name: 'ערן כהן' });
  p = page({ patients: [PT_ERAN, second], leads: [LEAD_ERAN], payments: [PAY_ERAN] });
  assert.equal(p.call('matchPatientForPayment', p.pay(PAY_ERAN.id), p.run('state.patients')), null, 'two patients');
  // A narrowed list cannot hide the second claimant.
  assert.equal(p.call('matchPatientForPayment', p.pay(PAY_ERAN.id), [p.pt(PT_ERAN.id)]), null, 'narrowed list');

  // Lead entry date differs → not the same lead triple → no match.
  const moved = Object.assign({}, LEAD_ERAN, { entryDate: '2026-10-06' });
  p = page({ patients: [PT_ERAN], leads: [moved], payments: [PAY_ERAN] });
  assert.equal(p.call('matchPatientForPayment', p.pay(PAY_ERAN.id), p.run('state.patients')), null, 'entry date');
  // leads: [] switches tier 5 off.
  p = page({ patients: [PT_ERAN], leads: [LEAD_ERAN], payments: [PAY_ERAN] });
  assert.equal(p.call('matchPatientForPayment', p.pay(PAY_ERAN.id), p.run('state.patients'), []), null);
});

test('Hebrew names carrying U+FFFD crash nothing and never match a clean name', () => {
  const bad = '��רן';
  const lead = Object.assign({}, LEAD_ERAN, { name: bad });
  const payBad = Object.assign({}, PAY_ERAN, { id: 'pay::arfoni::' + bad + '::2026-10-05::2026-10-05',
    patientId: 'arfoni::' + bad + '::2026-10-05', patientName: bad });
  const pt = Object.assign({}, PT_ERAN, { name: 'ערן יצחק �ונה' });
  const p = page({ patients: [pt], leads: [lead, LEAD_AMIT], payments: [payBad, PAY_ERAN, PAY_AMIT] });
  const patient = p.pt(PT_ERAN.id);
  assert.doesNotThrow(() => p.call('patientListRows', p.run('state'), {}, TODAY));
  assert.doesNotThrow(() => p.call('detachedPayments', p.run('state.payments'), p.run('state.patients')));
  // The U+FFFD lead is the exact twin of the U+FFFD row → still attached via the lead id.
  assert.equal(p.call('matchPatientForPayment', p.pay(payBad.id), p.run('state.patients')).via, 'lead_link');
  // The clean row "ערן" names no lead now (the lead reads "��רן") → unattached.
  assert.equal(p.call('matchPatientForPayment', p.pay(PAY_ERAN.id), p.run('state.patients')), null);
  assert.equal(plain(p.call('patientPaymentState', patient, p.run('state.payments'), null, TODAY)).key, 'paid');
});

test('ONE function: «מטופלים», גבייה due list and the problems chip read patientCycleRecord / matchPatientForPayment', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const APP = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const body = (name) => {
    const i = APP.indexOf('function ' + name + '(');
    assert.ok(i >= 0, name);
    return APP.slice(i, APP.indexOf('\n}\n', i));
  };
  assert.match(body('patientPaymentState'), /patientCycleRecord\(patient, dueISO, payments, patients, leads\)/);
  assert.match(body('paymentForPatientOnDate'), /patientCycleRecord\(patient, dueDateISO, state\.payments\)/);
  assert.match(body('patientHasReportedPayment'), /paymentBelongsToPatient\(/);
  assert.match(body('paymentBelongsToPatient'), /matchPatientForPayment\(/);
  assert.match(body('patientCycleRecord'), /matchPatientForPayment\(/);
  assert.doesNotMatch(body('patientPaymentState'), /x\.id === id/, 'no exact-id-only lookup left');
});

test('Code.gs parity: recMatchPatient_ gives the same owner, lead_link included', () => {
  const g = loadGs();
  const p = page({ patients: [PT_ERAN, PT_NOAM], leads: [LEAD_ERAN, LEAD_AMIT], payments: [PAY_ERAN, PAY_NOAM, PAY_AMIT] });
  // Code.gs reads lead/patient objects in its rec* shape.
  const gsLeads = [LEAD_ERAN, LEAD_AMIT].map((l) => Object.assign({}, l, { houseId: '' }));
  for (const row of [PAY_ERAN, PAY_NOAM, PAY_AMIT]) {
    const a = p.call('matchPatientForPayment', p.pay(row.id), p.run('state.patients'));
    g.sandbox.__a = [row, [PT_ERAN, PT_NOAM], gsLeads];
    const gs = g.run('recMatchPatient_(globalThis.__a[0], globalThis.__a[1], globalThis.__a[2])');
    assert.deepEqual(gs ? [gs.patient.id, gs.via] : null, a ? [a.patient.id, a.via] : null, row.id);
  }
  // Two leads with the same triple: Code.gs refuses too.
  g.sandbox.__a = [PAY_ERAN, [PT_ERAN], [LEAD_ERAN, Object.assign({}, LEAD_ERAN, { id: 'twin' })]];
  assert.equal(g.run('recMatchPatient_(globalThis.__a[0], globalThis.__a[1], globalThis.__a[2])'), null);
  // The reconciliation model feeds every lead to the matcher.
  assert.match(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8'),
    /m\.payOwner = payments\.map\(function \(p\) \{ return recMatchPatient_\(p, patients, allLeads\); \}\);/);
});
