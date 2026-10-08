/* «מטופלים» — the patient list, PR 1 (foundation, zero visible change).
 * CHANGELOG-patients-tab-foundation.md.
 *
 * Locked here:
 *   1. patientLeadInfo — the lead travels with the patient: fromLead (any
 *      list: board, closed, removed) first; a blank fromLead falls back to
 *      the #192 match read from the patient's side (name + house); a missing
 *      fromLead is never re-guessed; ambiguous → no lead.
 *   2. patientProblems — the four chips: no funder, no payment 3+ days after
 *      entry, house ≠ lead's house, no linked lead. Finance kinds only with
 *      finance data. Released → none. Ambiguous → never «ללא ליד».
 *   3. patientPaymentState — the existing billing helpers' cycle status.
 *   4. patientListRows — filters, the display join (no lead field is copied
 *      onto a Patients row), and no money data without `finance`.
 *   5. pendingAdmissionRows — the #192 rule without its threshold, the chip
 *      from 3 days, ambiguous never listed.
 *   6. Admission (#7): «כניסה לבית» sets fromLead on the new patient and the
 *      lead's stage to admitted, in the same save; a failed save rolls both
 *      back. The load-time promote + retire path does the same.
 *   7. Scope: no write, no new action, Code.gs untouched, server.js still
 *      withholds money data from a restricted session.
 *   8. Mutation checks.
 * All names, ids and phone numbers are SYNTHETIC. */

// The device clock is UTC on purpose: "today" must come from Asia/Jerusalem.
process.env.TZ = 'UTC';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const APP_SRC = read('public', 'app.js');
const GS_SRC = read('apps-script', 'Code.gs');
const RULES_SRC = read('lib', 'payment-report-rules.js');
const FUNDER_SRC = read('public', 'funder.js');
const { FINANCE_ACTIONS } = require('../lib/finance-scope.js');

const TODAY = '2026-10-07';
const plain = (v) => JSON.parse(JSON.stringify(v));

function loadApp(src) {
  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/', hash: '', reload: noop },
    document: { addEventListener: noop, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    setTimeout: () => 0, clearTimeout: noop,
    URL, URLSearchParams, Intl, Math, Date, JSON, Number, String, Array, Object, RegExp, Set, Map,
    isNaN, isFinite, parseInt, parseFloat, Promise,
    fetch: () => { throw new Error('no network in this test'); },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(RULES_SRC, sandbox);
  vm.runInContext(FUNDER_SRC, sandbox);
  vm.runInContext((src || APP_SRC) + `
    globalThis.__errors = []; globalThis.__modal = null; globalThis.__saves = 0; globalThis.__saveFails = false;
    showError = (m) => { globalThis.__errors.push(String(m)); };
    showToast = () => {};
    renderAll = () => {};
    showModal = (m) => { globalThis.__modal = m; };
    saveAll = async () => { globalThis.__saves++; if (globalThis.__saveFails) throw new Error('boom'); return { ok: true }; };
    saveAdmissionFunder = async () => {};
    persistAuditsRestored = async () => {};
    todayISO = () => '${TODAY}';
    globalThis.__app = {
      get state() { return state; },
      patientLeadInfo, patientProblems, patientPaymentState, patientListRows, patientProblemSummary,
      pendingAdmissionRows, patientLeadDetails, patientDaysInHouse, patientHasReportedPayment, patientLeadPool,
      PATIENT_PROBLEMS, PATIENT_LIST_DEFAULT_FILTERS, PATIENT_NO_PAYMENT_AFTER_DAYS,
      normalizeLead, normalizePatient, normalizePayment, normalizeFunderRow, paymentId,
      openEntryModal, promoteEnteredLeads, retireAdmittedLeads,
      modal: () => globalThis.__modal, saves: () => globalThis.__saves, errors: () => globalThis.__errors,
      setSaveFails(v) { globalThis.__saveFails = v; },
    };`, sandbox);
  return sandbox.__app;
}

const app = loadApp();

const lead = (f) => app.normalizeLead(Object.assign({ id: 'L-1', name: 'דנה ישראלי', phone: '050-1234567',
  house: 'רמות השבים', stage: 'admitted', entryDate: '2026-10-01', source: 'גוגל', note: 'הערה',
  visitDate: '2026-09-20', advance: 5000, assignedTo: 'ורד', meetingWith: 'מנהל רמות' }, f));
const patient = (f) => app.normalizePatient(Object.assign({ id: 'P-1', houseId: 'ramot', name: 'דנה ישראלי',
  date: '2026-10-01', pay: 30000, status: 'active', fromLead: 'L-1' }, f));
const funder = (patientId, label, effectiveFrom) => app.normalizeFunderRow({ patientId, funder: label,
  effectiveFrom: effectiveFrom || '2026-10-01', setBy: 'ורד', setAt: '2026-10-01T09:00:00+03:00' });
const pay = (p, f) => app.normalizePayment(Object.assign({ id: app.paymentId(p, p.date), patientId: `${p.houseId}::${p.name}::${p.date}`,
  houseId: p.houseId, patientName: p.name, dueDate: p.date, amount: 30000, amountPaid: 30000, status: 'paid' }, f));
const codes = (list) => plain(list.map((x) => x.code));

/* ---------- 1. patientLeadInfo ---------- */

test('patientLeadInfo: fromLead finds the lead on the board, in the closed list and in the removed list', () => {
  const p = patient();
  for (const where of ['leads', 'irrelevant', 'removed']) {
    const L = lead({ stage: where === 'irrelevant' ? 'irrelevant' : 'admitted' });
    const info = app.patientLeadInfo(p, [lead({ id: 'L-other', name: 'אחר' }), L]);
    assert.equal(info.via, 'fromLead', where);
    assert.equal(info.lead.id, 'L-1', where);
    assert.equal(info.ambiguous, false);
  }
});

test('patientLeadInfo: a fromLead whose lead is gone is «fromLead_missing» — never re-guessed by name', () => {
  const p = patient({ fromLead: 'L-gone' });
  const info = app.patientLeadInfo(p, [lead()]);   // same name + house, different id
  assert.deepEqual(plain(info), { lead: null, via: 'fromLead_missing', ambiguous: false });
});

test('patientLeadInfo: blank fromLead → the #192 name + house match, Hebrew house name or id', () => {
  const p = patient({ fromLead: '' });
  const info = app.patientLeadInfo(p, [lead({ id: 'L-9', name: '  דנה   ישראלי ' })], [p]);
  assert.equal(info.via, 'name_house');
  assert.equal(info.lead.id, 'L-9');
  assert.equal(app.patientLeadInfo(p, [lead({ id: 'L-9', house: 'ramot' })], [p]).via, 'name_house');
  assert.equal(app.patientLeadInfo(p, [lead({ id: 'L-9', house: 'רעננה אשר' })], [p]).via, 'none', 'other house');
  assert.equal(app.patientLeadInfo(p, [lead({ id: 'L-9', name: 'שם אחר' })], [p]).via, 'none', 'other name');
  assert.equal(app.patientLeadInfo(p, [], [p]).via, 'none');
});

test('patientLeadInfo: ambiguous — two candidate leads, or two patients on the same name + house → no lead', () => {
  const p = patient({ fromLead: '' });
  const two = app.patientLeadInfo(p, [lead({ id: 'L-a' }), lead({ id: 'L-b', stage: 'irrelevant' })], [p]);
  assert.deepEqual(plain(two), { lead: null, via: 'ambiguous', ambiguous: true });
  const twin = patient({ id: 'P-2', fromLead: '', date: '2026-05-01' });
  const both = app.patientLeadInfo(p, [lead({ id: 'L-a' })], [p, twin]);
  assert.equal(both.ambiguous, true);
  // the same lead id listed twice (board + a stale copy) is ONE candidate
  assert.equal(app.patientLeadInfo(p, [lead({ id: 'L-a' }), lead({ id: 'L-a' })], [p]).via, 'name_house');
});

test('patientLeadInfo: a lead already linked to ANOTHER patient by fromLead is not claimed by name', () => {
  const owner = patient({ id: 'P-owner', fromLead: 'L-1', date: '2026-03-01', status: 'released' });
  const p = patient({ fromLead: '' });
  const info = app.patientLeadInfo(p, [lead()], [owner, p]);
  assert.equal(info.via, 'none');
});

/* ---------- 2. patientProblems ---------- */

const infoOf = (p, leads, pats) => app.patientLeadInfo(p, leads, pats || [p]);

test('patientProblems: a clean patient has none', () => {
  const p = patient();
  assert.deepEqual(plain(app.patientProblems(p, infoOf(p, [lead()]), [pay(p)], [funder('P-1', 'פרטי')], TODAY)), []);
});

test('patientProblems: «ללא גורם מממן» — no Funders row, an unknown label, or a future one', () => {
  const p = patient();
  const i = infoOf(p, [lead()]);
  assert.deepEqual(codes(app.patientProblems(p, i, [pay(p)], [], TODAY)), ['no_funder']);
  assert.deepEqual(codes(app.patientProblems(p, i, [pay(p)], [funder('P-1', 'לא קיים')], TODAY)), ['no_funder']);
  assert.deepEqual(codes(app.patientProblems(p, i, [pay(p)], [funder('P-1', 'מכבי', '2026-11-01')], TODAY)), ['no_funder']);
  assert.deepEqual(codes(app.patientProblems(p, i, [pay(p)], [funder('P-other', 'מכבי')], TODAY)), ['no_funder']);
});

test('patientProblems: «לא דווח תשלום» from day 3 after entry; day 2 is not flagged', () => {
  const F = [funder('P-1', 'פרטי', '2026-01-01')];
  const at = (date) => { const p = patient({ date }); return codes(app.patientProblems(p, infoOf(p, [lead()]), [], F, TODAY)); };
  assert.deepEqual(at('2026-10-05'), [], 'day 2');
  assert.deepEqual(at('2026-10-04'), ['no_payment'], 'day 3');
  assert.deepEqual(at('2026-08-01'), ['no_payment']);
  assert.deepEqual(at('2026-10-20'), [], 'future entry');
  assert.deepEqual(at(''), [], 'no entry date');
  assert.equal(app.PATIENT_NO_PAYMENT_AFTER_DAYS, 3);
});

test('patientProblems: what counts as a reported payment', () => {
  const p = patient();
  const F = [funder('P-1', 'פרטי')];
  const run = (pays) => codes(app.patientProblems(p, infoOf(p, [lead()]), pays, F, TODAY));
  assert.deepEqual(run([pay(p)]), [], 'paid');
  assert.deepEqual(run([pay(p, { status: 'partial', amountPaid: 1000 })]), [], 'partial');
  assert.deepEqual(run([pay(p, { status: 'void' })]), ['no_payment'], 'a void row is not money');
  assert.deepEqual(run([pay(p, { status: 'unpaid', amountPaid: 0 })]), ['no_payment'], 'an unpaid row');
  assert.deepEqual(run([pay(patient({ name: 'מישהו אחר' }))]), ['no_payment'], 'another patient');
  // matched by the server-owned uid, whatever the triple says (a renamed patient)
  assert.deepEqual(run([pay(patient({ name: 'שם ישן' }), { patientUid: 'P-1' })]), [], 'by uid');
  // the triple through the matcher's reduction (stray spaces)
  assert.deepEqual(run([pay(p, { patientId: 'ramot:: דנה  ישראלי ::2026-10-01' })]), [], 'by normalized triple');
});

test('patientProblems: a pro-bono patient owes nothing → no «לא דווח תשלום»', () => {
  const p = patient();
  assert.deepEqual(codes(app.patientProblems(p, infoOf(p, [lead()]), [], [funder('P-1', 'פרו-בונו')], TODAY)), []);
});

test('patientProblems: «בית שונה מהליד» only when the lead names a house and it differs', () => {
  const p = patient();
  const F = [funder('P-1', 'פרטי')];
  const run = (L) => codes(app.patientProblems(p, infoOf(p, [L]), [pay(p)], F, TODAY));
  assert.deepEqual(run(lead({ house: 'רעננה אשר' })), ['house_mismatch']);
  assert.deepEqual(run(lead({ house: 'asher' })), ['house_mismatch'], 'an id on the lead');
  assert.deepEqual(run(lead({ house: 'ramot' })), [], 'same house as an id');
  assert.deepEqual(run(lead({ house: '' })), [], 'no house on the lead');
});

test('patientProblems: «ללא ליד» only when fromLead is blank AND nothing matches; never when ambiguous', () => {
  const F = [funder('P-1', 'פרטי')];
  const p = patient({ fromLead: '' });
  const run = (leads, pats) => codes(app.patientProblems(p, infoOf(p, leads, pats), [pay(p)], F, TODAY));
  assert.deepEqual(run([]), ['no_lead']);
  assert.deepEqual(run([lead({ id: 'L-x' })]), [], 'matched by name + house');
  assert.deepEqual(run([lead({ id: 'L-a' }), lead({ id: 'L-b' })]), [], 'ambiguous is never flagged');
  const gone = patient({ fromLead: 'L-gone' });
  assert.deepEqual(codes(app.patientProblems(gone, infoOf(gone, []), [pay(gone)], F, TODAY)), [], 'fromLead set (lead gone) is not «no lead»');
});

test('patientProblems: no finance data (null) → no finance chips; released → nothing; chip order is fixed', () => {
  const p = patient({ fromLead: '', date: '2026-08-01' });
  assert.deepEqual(codes(app.patientProblems(p, infoOf(p, []), null, null, TODAY)), ['no_lead']);
  assert.deepEqual(codes(app.patientProblems(p, infoOf(p, []), [], [], TODAY)), ['no_funder', 'no_payment', 'no_lead']);
  const L = lead({ house: 'רעננה אשר' });
  const q = patient({ date: '2026-08-01' });
  assert.deepEqual(codes(app.patientProblems(q, infoOf(q, [L]), [], [], TODAY)), ['no_funder', 'no_payment', 'house_mismatch']);
  assert.deepEqual(plain(app.patientProblems(patient({ status: 'released', fromLead: '' }), infoOf(p, []), [], [], TODAY)), []);
  assert.deepEqual(plain(app.PATIENT_PROBLEMS.map((x) => x.code)), ['no_funder', 'no_payment', 'house_mismatch', 'no_lead']);
});

/* ---------- 3. patientPaymentState ---------- */

test('patientPaymentState: the current cycle through the billing helpers', () => {
  const p = patient({ date: '2026-09-15' });
  const due = '2026-09-15';
  const F = [funder('P-1', 'פרטי', '2026-01-01')];
  const row = (f) => app.normalizePayment(Object.assign({ id: app.paymentId(p, due), patientId: `ramot::דנה ישראלי::${p.date}`,
    dueDate: due, amount: 30000, amountPaid: 30000, status: 'paid' }, f));
  assert.deepEqual(plain(app.patientPaymentState(p, [row()], F, TODAY)), { key: 'paid', label: 'שולם', dueISO: due });
  assert.equal(app.patientPaymentState(p, [row({ status: 'partial' })], F, TODAY).label, 'שולם חלקית');
  assert.equal(app.patientPaymentState(p, [], F, TODAY).key, 'unpaid');
  assert.equal(app.patientPaymentState(p, [row({ status: 'void' })], F, TODAY).label, 'מבוטל');
  assert.equal(app.patientPaymentState(p, [], [funder('P-1', 'פרו-בונו', '2026-01-01')], TODAY).key, 'probono');
  assert.equal(app.patientPaymentState(patient({ date: '2026-10-20' }), [], F, TODAY).key, 'not_due');
  assert.equal(app.patientPaymentState(patient({ status: 'released' }), [], F, TODAY), null);
  assert.equal(app.patientPaymentState(patient({ date: '' }), [], F, TODAY), null);
  // the cycle moves with the month: entry 15/09 → on 07/10 the cycle is 15/09; on 20/10 it is 15/10
  assert.equal(app.patientPaymentState(p, [], F, '2026-10-20').dueISO, '2026-10-15');
});

/* ---------- 4. patientListRows ---------- */

function fixtureState(over) {
  const pA = patient({ id: 'P-A', name: 'אבי אלף', fromLead: 'L-A', houseId: 'ramot', date: '2026-09-01' });
  const pB = patient({ id: 'P-B', name: 'בני בית', fromLead: '', houseId: 'asher', date: '2026-10-02' });
  const pC = patient({ id: 'P-C', name: 'גלי גימל', fromLead: 'L-C', houseId: 'ramot', date: '2026-06-01', status: 'released', exitDate: '2026-08-01' });
  return Object.assign({
    finance: true,
    patients: [pA, pB, pC],
    leads: [lead({ id: 'L-A', name: 'אבי אלף', house: 'רמות השבים', note: '<img src=x onerror=alert(1)>' })],
    irrelevantLeads: [],
    removedLeads: [lead({ id: 'L-C', name: 'גלי גימל', removedAt: '2026-09-01' })],
    payments: [pay(pA)],
    funders: [funder('P-A', 'פרטי', '2026-01-01')],
  }, over || {});
}

test('patientListRows: default = active only, every house, newest entry first', () => {
  const rows = app.patientListRows(fixtureState(), undefined, TODAY);
  assert.deepEqual(plain(rows.map((r) => r.patient.id)), ['P-B', 'P-A']);
  assert.deepEqual(plain(app.PATIENT_LIST_DEFAULT_FILTERS), { house: '', status: 'active', problemsOnly: false, q: '' });
});

test('patientListRows: house, «משוחררים», «הכל», «בעיות בלבד» and name search', () => {
  const s = fixtureState();
  const ids = (f) => plain(app.patientListRows(s, f, TODAY).map((r) => r.patient.id));
  assert.deepEqual(ids({ house: 'ramot' }), ['P-A']);
  assert.deepEqual(ids({ status: 'released' }), ['P-C']);
  assert.deepEqual(ids({ status: 'all' }), ['P-B', 'P-A', 'P-C']);
  assert.deepEqual(ids({ problemsOnly: true }), ['P-B'], 'P-B: no funder, no payment, no lead');
  assert.deepEqual(ids({ q: 'בני' }), ['P-B']);
  assert.deepEqual(ids({ q: '  אבי   אלף ' }), ['P-A']);
  assert.deepEqual(ids({ q: 'אין כזה' }), []);
});

test('patientListRows: the lead travels with the patient (display join) — and nothing is copied onto the Patients row', () => {
  const s = fixtureState();
  const before = plain(s.patients);
  const rows = app.patientListRows(s, { status: 'all' }, TODAY);
  const a = rows.find((r) => r.patient.id === 'P-A');
  assert.deepEqual(plain(a.lead), { phone: '050-1234567', source: 'גוגל', visitDate: '2026-09-20', advance: 5000,
    note: '<img src=x onerror=alert(1)>', assignedTo: 'ורד', meetingWith: 'מנהל רמות', house: 'רמות השבים' });
  assert.equal(rows.find((r) => r.patient.id === 'P-C').lead.phone, '050-1234567', 'a removed lead still travels');
  assert.equal(rows.find((r) => r.patient.id === 'P-B').lead, null, '«ללא ליד»');
  assert.deepEqual(plain(s.patients), before, 'the Patients rows are untouched');
  assert.equal(a.days, 36);
  assert.equal(rows.find((r) => r.patient.id === 'P-C').days, 61, 'entry → exit for a released patient');
  // the column is the CURRENT cycle (01/10): the September money does not pay it
  assert.deepEqual(plain(a.payment), { key: 'unpaid', label: 'לא שולם', dueISO: '2026-10-01' });
  assert.deepEqual(plain(a.problems), [], 'a payment was reported, so no «לא דווח תשלום»');
});

test('patientListRows: a session without finance never reads payments or funders, even if arrays are present', () => {
  for (const finance of [false, null, undefined]) {
    const rows = app.patientListRows(fixtureState({ finance }), { status: 'all' }, TODAY);
    rows.forEach((r) => {
      assert.equal(r.payment, null, `finance=${finance}`);
      r.problems.forEach((p) => assert.ok(!['no_funder', 'no_payment'].includes(p.code), `finance=${finance}: ${p.code}`));
    });
    assert.deepEqual(codes(rows.find((r) => r.patient.id === 'P-B').problems), ['no_lead']);
  }
});

test('patientProblemSummary: counts the ACTIVE list only, per chip', () => {
  const sum = app.patientProblemSummary(fixtureState(), TODAY);
  assert.deepEqual(plain(sum), { patients: 1, byCode: { no_funder: 1, no_payment: 1, house_mismatch: 0, no_lead: 1 } });
  assert.equal(app.patientProblemSummary(fixtureState({ finance: false }), TODAY).byCode.no_funder, 0);
});

/* ---------- 5. pendingAdmissionRows ---------- */

test('pendingAdmissionRows: paid / entering leads with no patient record; chip from day 3; ambiguous never listed', () => {
  const board = [
    lead({ id: 'N-1', name: 'ממתין ותיק', stage: 'paid', entryDate: '2026-10-01' }),
    lead({ id: 'N-2', name: 'ממתין חדש', stage: 'visit', meetingOutcome: 'entered', entryDate: '2026-10-06' }),
    lead({ id: 'N-3', name: 'בלי תאריך', stage: 'paid', entryDate: '' }),
    lead({ id: 'N-4', name: 'דנה ישראלי', stage: 'paid', entryDate: '2026-10-01' }),   // has a patient (name + house)
    lead({ id: 'N-5', name: 'כפול', stage: 'paid', entryDate: '2026-09-01' }),          // two patients → ambiguous
    lead({ id: 'N-6', name: 'ביקור רגיל', stage: 'visit', advance: 0, entryDate: '2026-09-01' }),
    lead({ id: 'N-7', name: 'נקלט', stage: 'admitted', entryDate: '2026-09-01' }),
  ];
  const pats = [patient({ fromLead: '' }), patient({ id: 'D1', name: 'כפול', fromLead: '' }), patient({ id: 'D2', name: 'כפול', fromLead: '', date: '2026-01-01' })];
  const rows = app.pendingAdmissionRows(board, pats, [], TODAY, board);
  assert.deepEqual(plain(rows.map((r) => [r.lead.id, r.days, r.chipDays])), [['N-1', 6, 6], ['N-2', 1, null], ['N-3', null, null]]);
  assert.deepEqual(plain(app.pendingAdmissionRows(board, null, [], TODAY, board)), [], 'patients not loaded');
});

/* ---------- 6. admission: fromLead + stage admitted (#7) ---------- */

test('«כניסה לבית» sets fromLead on the new patient and the lead stage to admitted, in ONE save', async () => {
  const a = loadApp();
  a.state.finance = false; a.state.mode = 'edit';
  const L = app.normalizeLead({ id: 'L-77', name: 'ליד לקליטה', house: 'רמות השבים', stage: 'paid', entryDate: '2026-10-05', advance: 1000 });
  a.state.leads = [L]; a.state.patients = []; a.state.dischargedPatients = [];
  a.openEntryModal(L);
  const ok = await a.modal().onSubmit({ houseId: 'ramot', date: '2026-10-05', pay: '30000', adv: '1000', status: 'trial' });
  assert.equal(ok, true);
  assert.equal(a.saves(), 1);
  assert.equal(a.state.patients.length, 1);
  assert.equal(a.state.patients[0].fromLead, 'L-77');
  assert.equal(L.stage, 'admitted');
  // …and the new row's lead travels with it on the list
  const info = a.patientLeadInfo(a.state.patients[0], a.patientLeadPool(a.state), a.state.patients);
  assert.equal(info.via, 'fromLead');
  assert.equal(info.lead.id, 'L-77');
});

test('«כניסה לבית»: a failed save rolls back the patient AND the lead stage', async () => {
  const a = loadApp();
  a.state.finance = false; a.state.mode = 'edit';
  const L = app.normalizeLead({ id: 'L-78', name: 'ליד', house: 'רמות השבים', stage: 'paid', entryDate: '2026-10-05' });
  a.state.leads = [L]; a.state.patients = []; a.state.dischargedPatients = [];
  a.setSaveFails(true);
  a.openEntryModal(L);
  assert.equal(await a.modal().onSubmit({ houseId: 'ramot', date: '2026-10-05', pay: '30000', adv: '0', status: 'trial' }), false);
  assert.equal(a.state.patients.length, 0);
  assert.equal(L.stage, 'paid');
});

test('load-time promote + retire: the auto-created patient carries fromLead and the lead ends admitted', () => {
  const a = loadApp();
  const L = app.normalizeLead({ id: 'L-79', name: 'ליד ישן', house: 'רמות השבים', stage: 'entry', entryDate: '2026-09-01' });
  a.state.leads = [L]; a.state.patients = []; a.state.dischargedPatients = [];
  const created = a.promoteEnteredLeads();
  assert.equal(created.length, 1);
  assert.equal(created[0].fromLead, 'L-79');
  a.retireAdmittedLeads();
  assert.equal(L.stage, 'admitted');
});

/* ---------- 7. scope ---------- */

function helperBlock() {
  const start = APP_SRC.indexOf('/* ===== «מטופלים» — the patient list');
  const end = APP_SRC.indexOf('function buildLeadCard(');
  assert.ok(start > 0 && end > start, 'the helper block sits before buildLeadCard');
  return APP_SRC.slice(start, end);
}

test('scope: the helper block writes nothing and calls no server action', () => {
  const block = helperBlock();
  for (const banned of ['fetch(', 'apiCall', 'saveAll', 'sheetsPost', 'callAction', 'innerHTML', 'localStorage', '.push(patient']) {
    assert.ok(!block.includes(banned), banned);
  }
  assert.ok(!/\bstate\.\w+\s*=/.test(block), 'never assigns to state');
});

test('scope: Code.gs is untouched; the server keeps withholding money data from a restricted session', () => {
  for (const name of ['patientListRows', 'patientLeadInfo', 'patientProblems', 'pendingAdmissionRows']) {
    assert.ok(!GS_SRC.includes(name), name);
  }
  for (const a of ['getPayments', 'reportPayment', 'appendFunder']) assert.ok(FINANCE_ACTIONS.includes(a), a);
});

// PR 1 shipped with a "no tab, no screen yet" check here. PR 2 adds the tab;
// its placement and rendering are locked in test/patients-tab-ui.test.js.

/* ---------- 8. mutation checks ---------- */

function mutant(from, to) {
  assert.ok(APP_SRC.includes(from), 'mutation anchor missing: ' + from);
  return loadApp(APP_SRC.replace(from, to));
}

test('mutation: ambiguous lead match fails open → caught', () => {
  const m = mutant("if (hits.length > 1 || tierAmbiguous) return { lead: null, via: 'ambiguous', ambiguous: true };", '');
  const p = m.normalizePatient({ id: 'P-1', houseId: 'ramot', name: 'דנה ישראלי', date: '2026-10-01', status: 'active' });
  const L = (id) => m.normalizeLead({ id, name: 'דנה ישראלי', house: 'רמות השבים', stage: 'admitted' });
  assert.notEqual(m.patientLeadInfo(p, [L('a'), L('b')], [p]).via, 'ambiguous');
});

test('mutation: threshold 3 → 2 → caught; void counted as money → caught; finance gate dropped → caught', () => {
  const m1 = mutant('const PATIENT_NO_PAYMENT_AFTER_DAYS = 3;', 'const PATIENT_NO_PAYMENT_AFTER_DAYS = 2;');
  const p = m1.normalizePatient({ id: 'P-1', houseId: 'ramot', name: 'x', date: '2026-10-05', status: 'active', fromLead: 'L' });
  assert.ok(codes(m1.patientProblems(p, { lead: null, via: 'fromLead_missing' }, [], null, TODAY)).includes('no_payment'));

  const m2 = mutant('if (!pay || isVoidPayment(pay)) return false;', 'if (!pay) return false;');
  const q = m2.normalizePatient({ id: 'P-1', houseId: 'ramot', name: 'x', date: '2026-09-01', status: 'active' });
  const v = m2.normalizePayment({ id: 'x', patientId: 'ramot::x::2026-09-01', status: 'void', amountPaid: 100 });
  assert.equal(m2.patientHasReportedPayment(q, [v]), true, 'the mutant counts a void row');
  assert.equal(app.patientHasReportedPayment(app.normalizePatient({ id: 'P-1', houseId: 'ramot', name: 'x', date: '2026-09-01' }),
    [app.normalizePayment({ id: 'x', patientId: 'ramot::x::2026-09-01', status: 'void', amountPaid: 100 })]), false);

  const m3 = mutant('const finance = src.finance === true;', 'const finance = true;');
  const rows = m3.patientListRows(fixtureState({ finance: false }), { status: 'all' }, TODAY);
  assert.ok(rows.some((r) => r.payment !== null), 'the mutant leaks the payment state');
});
