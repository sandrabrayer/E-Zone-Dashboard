/* CHANGELOG-billing-search-any-patient.md — the גבייה search finds the
 * PATIENT, whatever the date:
 *
 *   classic  billingSearchHits(q, patients, discharged, payments, leads)
 *            — every patient (any status) whose name / house matches, each
 *            with ALL their cycle rows (never receipts) in due-date order;
 *            discharged rows no longer on the Patients tab; orphan cycle rows
 *            found by their own patientName. Empty query → [].
 *   CRM      billingSearch(overview, q, patients) — the overview narrowed to
 *            one name: debtors, receipts, and every other patient (released
 *            included) so a person with nothing owed is still found.
 *
 * The reproduction first: a released patient with no open cycle on the
 * selected date — before this change the search had nobody to filter. */

const { test } = require('node:test');
const assert = require('node:assert');
// app.js runs in a vm realm: its arrays are not reference-equal to ours, so
// structural comparisons use deepEqual (same structure, any realm).
const same = (a, b) => assert.deepEqual(a, b);
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadApp() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const epilogue = `
    globalThis.__test = { billingSearchHits, billingSearchHitMeta, state };
  `;
  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/' },
    document: { addEventListener: noop, getElementById: () => null },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    URLSearchParams, Math, Date, JSON, Number, String, Array, Object, RegExp, Promise, Set, Map,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + epilogue, sandbox);
  return sandbox.__test;
}

const app = loadApp();
const crm = require('../public/crm/crm.js');

// אביעד as the live sheet holds him on 28/10/2026: released from rehab on
// 06/09, nothing due on 28/10, no open balance — invisible to a date filter.
const AVIAD = { id: 'p-aviad', name: 'אביעד חביביאן', houseId: 'rehab', date: '2026-08-16', exitDate: '2026-09-06', status: 'released', pay: 30000 };
const DAVID = { id: 'p-david', name: 'דוד לוי', houseId: 'ramot', date: '2026-10-01', status: 'active', pay: 35000 };
const PATIENTS = [AVIAD, DAVID];
const PAYMENTS = [
  { id: 'pay-1', patientId: 'p-aviad', patientUid: 'p-aviad', patientName: 'אביעד חביביאן', houseId: 'rehab', dueDate: '2026-08-16', amount: 30000, amountPaid: 30000, status: 'paid' },
  { id: 'pay-2', patientId: 'p-aviad', patientUid: 'p-aviad', patientName: 'אביעד חביביאן', houseId: 'rehab', dueDate: '2026-09-16', amount: 30000, amountPaid: 30000, status: 'paid' },
  { id: 'rcpt-1', patientId: 'p-aviad', patientUid: 'p-aviad', patientName: 'אביעד חביביאן', houseId: 'rehab', dueDate: '2026-08-16', amount: 30000, status: 'paid' },
  { id: 'pay-3', patientId: 'p-david', patientUid: 'p-david', patientName: 'דוד לוי', houseId: 'ramot', dueDate: '2026-10-01', amount: 35000, amountPaid: 0, status: 'unpaid' },
  { id: 'pay-9', patientName: 'אביעד כהן', houseId: 'asher', dueDate: '2026-05-01', amount: 20000, amountPaid: 0, status: 'unpaid' },
];

/* ===== classic ===== */

test('classic: a released patient with nothing due today is FOUND by name, with every cycle (no receipts), newest first', () => {
  const hits = app.billingSearchHits('אביעד', PATIENTS, [], PAYMENTS, []);
  const aviad = hits.find(h => h.patient === AVIAD);
  assert.ok(aviad, 'released patient must be a hit');
  same(aviad.cycles.map(c => c.id), ['pay-2', 'pay-1']);
  assert.ok(!hits.some(h => h.patient === DAVID));
});

test('classic: empty / blank query → no hits (the section stays hidden)', () => {
  same(app.billingSearchHits('', PATIENTS, [], PAYMENTS, []), []);
  same(app.billingSearchHits('   ', PATIENTS, [], PAYMENTS, []), []);
  same(app.billingSearchHits(null, PATIENTS, [], PAYMENTS, []), []);
});

test('classic: matches by house label too, and a patient with no cycles is still listed (so the screen can say so)', () => {
  const hits = app.billingSearchHits('רמות', PATIENTS, [], [], []);
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].patient, DAVID);
  same(hits[0].cycles, []);
});

test('classic: an orphan cycle row (no current patient) is found by its own patientName under a pseudo-patient', () => {
  const hits = app.billingSearchHits('אביעד', PATIENTS, [], PAYMENTS, []);
  const orphan = hits.find(h => h.kind === 'orphan');
  assert.ok(orphan);
  assert.strictEqual(orphan.patient.name, 'אביעד כהן');
  same(orphan.cycles.map(c => c.id), ['pay-9']);
  assert.strictEqual(app.billingSearchHitMeta(orphan), 'רעננה אשר · תשלום ללא שיוך למטופל');
});

test('classic: a discharged row whose patient left the Patients tab is listed once; a row duplicating a listed patient is not', () => {
  const gone = { id: 'd-1', name: 'אביעד ישן', houseId: 'arfoni', date: '2025-01-01', exitDate: '2025-03-01', pay: 25000 };
  const dup  = { id: 'd-2', name: 'אביעד חביביאן', houseId: 'rehab', date: '2026-08-16', exitDate: '2026-09-06' };
  const removed = { id: 'd-3', name: 'אביעד מחוק', houseId: 'ramot', deletedAt: '2026-01-01T00:00:00Z' };
  const hits = app.billingSearchHits('אביעד', PATIENTS, [gone, dup, removed], PAYMENTS, []);
  const names = hits.map(h => h.patient.name);
  assert.strictEqual(names.filter(n => n === 'אביעד חביביאן').length, 1);
  assert.ok(names.includes('אביעד ישן'));
  assert.ok(!names.includes('אביעד מחוק'));
  const goneHit = hits.find(h => h.patient.name === 'אביעד ישן');
  assert.strictEqual(goneHit.kind, 'discharged');
  assert.strictEqual(app.billingSearchHitMeta(goneHit), 'קיסריה עפרוני · שוחרר · כניסה 01/01/2025 · יציאה 01/03/2025');
});

test('classic: meta line of a released patient names house, status, entry and exit', () => {
  const [hit] = app.billingSearchHits('חביביאן', PATIENTS, [], [], []);
  assert.strictEqual(app.billingSearchHitMeta(hit), 'קיסריה ריהאב · שוחרר · כניסה 16/08/2026 · יציאה 06/09/2026');
});

test('classic: the markup has the search group and renderBilling calls the renderer', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.ok(/id="billing-search-group"[^>]*class="[^"]*hidden/.test(html), 'group starts hidden');
  assert.ok(html.includes('id="billing-search-list"'));
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.ok(/renderBillingOpenList\(selected\);\s*\n\s*renderBillingSearchResults\(q\);/.test(src));
  // Every value rendered goes through escapeHtml.
  const fn = src.slice(src.indexOf('function renderBillingSearchResults'), src.indexOf('/* The month split, rendered.'));
  assert.ok(fn.includes('escapeHtml(query)') && fn.includes('escapeHtml(hit.patient.name'));
});

/* ===== CRM ===== */

const OVERVIEW = {
  patients: [{ id: 'p-david', name: 'דוד לוי', houseName: 'רמות השבים', balance: 35000, cycles: 1, status: 'active', inHouse: true }],
  receipts: [{ id: 'rcpt-1', patientName: 'אביעד חביביאן', houseName: 'קיסריה ריהאב', receivedDate: '2026-08-16', amount: 30000, method: 'העברה' }],
};
const CRM_PATIENTS = [
  { id: 'p-aviad', name: 'אביעד חביביאן', houseId: 'rehab', status: 'released', date: '2026-08-16', exitDate: '2026-09-06' },
  { id: 'p-david', name: 'דוד לוי', houseId: 'ramot', status: 'active', date: '2026-10-01', exitDate: '' },
];

test('CRM: blank query → null (overview untouched)', () => {
  assert.strictEqual(crm.billingSearch(OVERVIEW, '', CRM_PATIENTS), null);
  assert.strictEqual(crm.billingSearch(OVERVIEW, '  ', CRM_PATIENTS), null);
});

test('CRM: a released patient with no debt is found (people), with the receipts in their name; a debtor is not repeated under people', () => {
  const r = crm.billingSearch(OVERVIEW, 'אביעד', CRM_PATIENTS);
  assert.deepStrictEqual(r.debtors, []);
  assert.deepStrictEqual(r.receipts.map(x => x.id), ['rcpt-1']);
  assert.deepStrictEqual(r.people.map(p => [p.id, p.status, p.houseName]), [['p-aviad', 'released', 'קיסריה ריהאב']]);
  assert.strictEqual(r.total, 2);
  const d = crm.billingSearch(OVERVIEW, 'דוד', CRM_PATIENTS);
  assert.deepStrictEqual(d.debtors.map(x => x.id), ['p-david']);
  assert.deepStrictEqual(d.people, []);
});

test('CRM: words match in any order, by house too; nobody → total 0', () => {
  assert.strictEqual(crm.billingSearch(OVERVIEW, 'חביביאן אביעד', CRM_PATIENTS).total, 2);
  assert.strictEqual(crm.billingSearch(OVERVIEW, 'ריהאב', CRM_PATIENTS).total, 2);
  assert.strictEqual(crm.billingSearch(OVERVIEW, 'אין כזה', CRM_PATIENTS).total, 0);
});

test('CRM: the search box keeps the גבייה area open, and renderBilling consults billingSearch', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'crm', 'crm.js'), 'utf8');
  assert.ok(src.includes("state.area !== 'clients' && state.area !== 'billing') state.area = 'leads'"));
  assert.ok(src.includes('billingSearch(b, state.filters.q'));
});
