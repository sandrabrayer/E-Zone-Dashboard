'use strict';

/* Cross-release P0 regression: a single synthetic patient journey must retain
 * ALL THREE fixes landed on 2026-11-02:
 * - #354: exit date equal to billing anchor never begins a new cycle;
 * - #355: classic and CRM "due on date" agree without erasing historic debt;
 * - #356: exact fromLead admission retires stale board state, never by name.
 *
 * Source-owned amount/receipts are deliberately not modified by this test.
 * No production data, credentials, network I/O or patient identifiers. */
process.env.TZ = 'Asia/Jerusalem';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const crm = require('../public/crm/crm.js');
const CB = require('../lib/cycle-balance.js');

function oldBilling() {
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://synthetic.invalid', href: 'http://synthetic.invalid/' },
    document: { addEventListener: noop, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    URLSearchParams, Math, Date, JSON, Number, String, Array, Object, RegExp,
    isNaN, isFinite, parseInt, parseFloat, Promise
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(appSrc + '\n globalThis.__bill = { patientDueOnDate, patientStayCoversDate };', sandbox);
  return sandbox.__bill;
}

const NAME = 'מטופל נתוני דמה';
const HOUSE = 'ramot';
const STAY_ID = 'stay-synthetic-001';
const LEAD_ID = 'lead-synthetic-001';
const LEGACY_KEY = HOUSE + '::' + NAME + '::2026-07-27';
const CYCLE_ID = 'pay::' + LEGACY_KEY + '::2026-09-27';

const patient = (patch) => Object.assign({
  id: STAY_ID, name: NAME, houseId: HOUSE, date: '2026-07-27',
  pay: 33000, status: 'active', exitDate: '', fromLead: LEAD_ID
}, patch || {});

const lead = (patch) => Object.assign({
  id: LEAD_ID, name: NAME, stage: 'paid', house: 'רמות השבים',
  created: '2026-07-27', entryDate: '', phone: '0500000000'
}, patch || {});

const source = (p, leads) => ({
  ok: true,
  leads: leads || [lead()],
  patients: { ramot: [p] },
  dischargedPatients: [],
  billingOverrides: []
});

const paymentSource = {
  ok: true, funders: [{ patientId: STAY_ID, funder: 'פרטי', effectiveFrom: '2026-07-27' }],
  payments: [{
    id: CYCLE_ID, patientId: LEGACY_KEY, patientUid: STAY_ID,
    patientName: NAME, houseId: HOUSE, dueDate: '2026-09-27',
    coverageStart: '2026-09-27', coverageEnd: '2026-10-26',
    amount: 33000, amountPaid: 30000, balance: 3000, status: 'partial'
  }],
  receipts: []
};
const debtSource = {
  ok: true, byPatient: [{
    patientId: STAY_ID, patientKey: LEGACY_KEY, status: 'released',
    settledCycles: 2,
    cycles: [{ start: '2026-09-27', end: '2026-10-26', expected: 33000,
      received: 30000, balance: 3000, days: 36, kind: 'recorded', paymentId: CYCLE_ID }]
  }]
};

test('P0 cross-release: exact linked active patient retires stale paid lead but remains due on the current legitimate cycle', () => {
  const p = patient();
  const d = source(p, [lead(), lead({ id: 'unrelated-synthetic-002' })]);
  const model = crm.normalise(d);
  assert.equal(model.leads.find(l => l.id === LEAD_ID).stage, 'admitted',
    'the patient exists with fromLead; an old paid lead must NOT reappear on the board');
  assert.equal(model.leads.find(l => l.id === LEAD_ID).entryDate, '2026-07-27');
  assert.equal(model.leads.find(l => l.id === 'unrelated-synthetic-002').stage, 'paid',
    'same name and phone are not identity evidence for another lead');
  const due = crm.dueOnDate(d, paymentSource, '2026-10-27', CB);
  assert.equal(due.error, '');
  assert.equal(due.count, 1, 'a genuine active patient reaches the same billing anchor');
  assert.equal(due.rows[0].patientId, STAY_ID);
  assert.equal(due.rows[0].start, '2026-10-27');
  assert.equal(due.rows[0].end, '2026-11-26');
});

test('P0 cross-release: exit ON billing anchor means neither classic nor new CRM creates a new Oct/Nov cycle', () => {
  const p = patient({ status: 'released', exitDate: '2026-10-27' });
  const d = source(p);
  const legacy = oldBilling();
  assert.equal(legacy.patientStayCoversDate(p, '2026-10-27'), true,
    'the exit date remains a real day of stay; not an extra billing cycle');
  for (const date of ['2026-10-27', '2026-11-27']) {
    assert.equal(legacy.patientDueOnDate(p, date), false, 'classic ' + date);
    const fresh = crm.dueOnDate(d, paymentSource, date, CB);
    assert.equal(fresh.count, 0, 'CRM ' + date);
    assert.equal(fresh.total, 0, 'no invented receivable on ' + date);
  }
  assert.equal(crm.normalise(d).leads[0].stage, 'paid',
    'a legitimately released person is not forever locked in admitted; reopen is separate');
});

test('P0 cross-release: historical partial cycle is still discoverable after discharge; hiding future billing must never erase real arrears', () => {
  const p = patient({ status: 'released', exitDate: '2026-10-27' });
  const d = source(p);
  const legacy = oldBilling();
  assert.equal(legacy.patientDueOnDate(p, '2026-09-27'), true, 'old legitimate cycle');
  const prior = crm.dueOnDate(d, paymentSource, '2026-09-27', CB);
  assert.equal(prior.count, 1);
  assert.equal(prior.rows[0].start, '2026-09-27');
  assert.equal(prior.rows[0].end, '2026-10-26');
  assert.equal(prior.rows[0].balance, 3000);

  const account = crm.patientAccount(STAY_ID, debtSource, paymentSource);
  assert.equal(account.openTotal, 3000, 'known historic debt is still shown in the account');
  assert.deepEqual(account.openCycles.map(c => [c.start, c.end, c.balance, c.kind]), [
    ['2026-09-27', '2026-10-26', 3000, 'recorded']
  ]);
  assert.equal(account.cycles.some(c => c.dueDate === '2026-10-27'), false,
    'do not backfill a billing record as a test side effect');
});

test('P0 cross-release: missing finance read does NOT magically prove a cycle is paid', () => {
  const p = patient();
  const due = crm.dueOnDate(source(p), null, '2026-10-27', CB);
  assert.notEqual(due.error, '', 'absence of payments source must be explicit');
});
