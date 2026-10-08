/* Duplicate discharges (CHANGELOG-duplicate-discharges.md, 2026-10-07).
 *
 * The bug: the «מטופלים משוחררים» tab showed one stay twice (same patient,
 * house, entry and exit date, «סיים טיפול», each row «זיכויים (1)»).
 * Root cause: dischargePatient minted a FRESH audit id on every confirm, and
 * dischargePatient_ upserted by that id — so any second send for the same stay
 * (a retry after a lost answer, the «נשמר חלקית» rollback, a stale second tab)
 * appended a second row. «זיכויים (1)» on both rows is ONE credit: the count
 * is per stay (patientKey), not per discharge row.
 *
 * Covered here, on the REAL shipped Code.gs and app.js (vm sandboxes):
 *   1. the root-cause scenario, end to end (app.js → real Code.gs);
 *   2. the server guard: duplicate refused, same id = idempotent retry,
 *      re-discharge after a restore allowed, coordinators path guarded;
 *   3. double tap / two doors to the same stay → ONE write;
 *   4. client handling of duplicate:true;
 *   5. credit dedupe (same stay + rule);
 *   6. «מחק כפילות»: role-gated, reason required, last row protected,
 *      a row with its own credit (or a double credit) refused, audit row,
 *      Patients / Payments never touched, idempotent;
 *   7. listDuplicateDischargesNow: dry run, read-only;
 *   8. every open-row filter skips a soft-deleted row; escaping.
 * All names, ids and dates are SYNTHETIC except the shape of the reported
 * stay (house / dates / disposition), which carries no personal data. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadGs, richSheet } = require('./helpers/gs-sandbox');

const ROOT = path.join(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const GS_SRC = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');
const arr = (x) => Array.from(x);

const PROXY_SECRET = 'proxy-secret-TEST-duplicate-discharges-0123456789';
const DSHEET = 'מטופלים משוחררים';
const NAME = 'מטופל בדיקה';
const HOUSE = 'rehab';           // קיסריה ריהאב
const ENTRY = '2026-09-09';
const EXIT = '2026-10-06';

const gsActor = (id, user, roles) => ({
  proxySecret: PROXY_SECRET, proxyUser: user, user, proxyAuth: 'personal', proxyUserId: id, proxyRoles: roles,
});
const VERED = () => gsActor('vered', 'ורד', ['staff', 'reporter', 'deleter']);
const SANDRA = () => gsActor('sandra', 'סנדרה', ['staff', 'deleter', 'approver', 'viewer']);
const SHIRAN = () => gsActor('shiran', 'שירן', ['staff', 'reporter']);
const YAEL = () => gsActor('yael', 'יעל', ['staff', 'reporter']);

function audit(over) {
  return Object.assign({
    id: 'aud-1', houseId: HOUSE, name: NAME, date: ENTRY, pay: 30000, adv: 0, status: 'released',
    fromLead: '', exitDate: EXIT, source: 'direct_admin', notes: '',
    dischargedAt: '2026-10-06T09:00:00.000Z', disposition: 'completed', discharge_note: '',
    restored: '', prior_status: 'active',
  }, over || {});
}
function credit(over) {
  return Object.assign({
    id: 'credit::pt-1::2026-09::1', patientId: 'pt-1', patientKey: HOUSE + '::' + NAME + '::' + ENTRY,
    patientName: NAME, houseId: HOUSE, facilityType: 'detox_dual', creditType: 'days_unused',
    allocationMonth: '2026-09', calculatedAmount: 1000, amount: 1000, status: 'pending',
    basis: JSON.stringify({ exitDate: EXIT, rule: 'detox_prorata' }), createdAt: '2026-10-06T09:05:00.000Z',
  }, over || {});
}

/* A Code.gs with the Patients / Payments / discharged / Credits sheets seeded. */
function seeded(opts) {
  const o = opts || {};
  const g = loadGs({ props: { PROXY_SECRET } });
  const S = g.sandbox.__sheets;
  const put = (name, colsExpr, rows) => {
    const cols = arr(g.run(colsExpr));
    S[name] = richSheet(name, cols);
    (rows || []).forEach((r) => S[name].appendRow(cols.map((c) => (r[c] === undefined ? '' : r[c]))));
  };
  put('Patients', 'PATIENT_COLUMNS', o.patients || [{ id: 'pt-1', houseId: HOUSE, name: NAME, date: ENTRY, pay: 30000, status: 'released', exitDate: EXIT }]);
  put(DSHEET, 'DISCHARGED_PATIENT_COLUMNS', o.discharged || []);
  put('Credits', 'CREDIT_COLUMNS', o.credits || []);
  put('Payments', 'PAYMENT_COLUMNS', o.payments || [{ id: 'pay-1', patientId: HOUSE + '::' + NAME + '::' + ENTRY, patientName: NAME, houseId: HOUSE, dueDate: ENTRY, amount: 30000, amountPaid: 30000, status: 'paid' }]);
  const rows = (name, colsExpr) => g.sheetRows(name, colsExpr);
  const snapshot = (name) => JSON.stringify(S[name] ? S[name].grid : null);
  return { g, S, rows, snapshot, discharged: () => rows(DSHEET, 'DISCHARGED_PATIENT_COLUMNS'),
    audits: () => rows('AuditLog', 'AUDIT_LOG_COLUMNS') };
}
const openRows = (rows) => rows.filter((r) => String(r.restored) !== 'TRUE' && !String(r.deletedAt || '').trim());

/* ---------- app.js in a vm sandbox; fetch → `route(body)` ---------- */
function fakeEl() {
  return {
    className: '', dataset: {}, style: {}, _html: '', children: [], textContent: '',
    set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; },
    appendChild(c) { this.children.push(c); }, addEventListener() {}, remove() {},
    set onclick(_f) {}, set onchange(_f) {}, set onsubmit(_f) {},
    querySelector() { return fakeEl(); }, querySelectorAll() { return []; },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  };
}
function loadApp(route) {
  const calls = [];
  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/' },
    document: { getElementById: () => fakeEl(), createElement: () => fakeEl(), querySelectorAll: () => [], addEventListener() {}, body: fakeEl() },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    URL, URLSearchParams, Math, Date, JSON, Number, String, Array, Object, RegExp, Promise, Set, Map,
    confirm: () => true,
    Funder: require(path.join(ROOT, 'public', 'funder.js')),
    fetch: (url, opts) => {
      const body = opts && opts.body ? JSON.parse(opts.body) : null;
      calls.push(body);
      const out = (route && route(body)) || (body && body.action === 'suggestRefunds' ? { ok: true, suggestions: [] } : { ok: true });
      const status = out.__status || 200;
      delete out.__status;
      return Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(JSON.parse(JSON.stringify(out))) });
    },
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  const epilogue = `
    globalThis.__errors = []; globalThis.__toasts = []; globalThis.__confirms = [];
    lockBusyDelay = () => Promise.resolve();
    showError = (m) => { globalThis.__errors.push(String(m)); };
    showToast = (m) => { globalThis.__toasts.push(String(m)); };
    renderAll = () => {};
    showCloseLeadModal = (o) => { globalThis.__confirms.push(o.onConfirm); };
    showCreditsModal = () => { globalThis.__creditsModal = (globalThis.__creditsModal || 0) + 1; return Promise.resolve(); };
    globalThis.__test = {
      state,
      normalizePatient: (p) => normalizePatient(p),
      normalizeDischargedPatient: (p) => normalizeDischargedPatient(p),
      dischargePatient: (p) => dischargePatient(p),
      healClobberedDischarges: () => healClobberedDischarges(),
      dischargeRowOpen: (d) => dischargeRowOpen(d),
      dischargeStayKey: (d) => dischargeStayKey(d),
      openDuplicateSiblings: (d, l) => openDuplicateSiblings(d, l),
      openDischargeAuditsFor: (p, l) => openDischargeAuditsFor(p, l),
      auditRowForReleasedPatient: (p, l) => auditRowForReleasedPatient(p, l),
      coordinatorDischarges: (l, t) => coordinatorDischarges(l, t),
      duplicateDischargeReasonError: (r) => duplicateDischargeReasonError(r),
      deleteDuplicateDischarge: (d, r) => deleteDuplicateDischarge(d, r),
      saveCredit: (c) => saveCredit(c),
      confirms: () => globalThis.__confirms,
      errors: () => globalThis.__errors,
      toasts: () => globalThis.__toasts,
      creditsModals: () => globalThis.__creditsModal || 0,
      DISCHARGE_ALREADY_RECORDED_HE,
    };`;
  vm.createContext(sandbox);
  vm.runInContext(APP_SRC + epilogue, sandbox);
  const app = sandbox.__test;
  app.state.mode = 'edit';
  app.state.deleter = true;
  app.state.leads = []; app.state.patients = []; app.state.payments = [];
  app.state.credits = []; app.state.dischargedPatients = []; app.state.irrelevantLeads = [];
  app.state.removedLeads = []; app.state.billingOverrides = [];
  const sent = (action) => calls.filter((c) => c && c.action === action);
  return { app, calls, sent };
}
const PICK = { disposition: 'completed', note: '', dischargeDate: EXIT };

/* ================== 1. THE ROOT CAUSE, end to end ================== */

test('ROOT CAUSE: the first discharge lands but its answer is lost; the user discharges again → ONE open row, «השחרור כבר נרשם»', async () => {
  const s = seeded({ patients: [{ id: 'pt-1', houseId: HOUSE, name: NAME, date: ENTRY, pay: 30000, status: 'active' }] });
  let lose = true;
  const { app, sent } = loadApp((body) => {
    if (body.action !== 'dischargePatient') return null;
    const real = s.g.post(Object.assign({}, body, VERED()));
    // The write landed on the sheet; the proxy answered 502 (timeout / lost answer).
    if (lose) { lose = false; return { ok: false, error: 'sheets_unreachable', __status: 502 }; }
    return real;
  });
  app.state.patients = [app.normalizePatient({ id: 'pt-1', houseId: HOUSE, name: NAME, date: ENTRY, pay: 30000, status: 'active' })];
  const p = app.state.patients[0];

  // Attempt 1: the error rolls the UI back — the patient looks active again.
  app.dischargePatient(p);
  await assert.rejects(app.confirms()[0](PICK));
  assert.equal(p.status, 'active', 'rolled back locally');
  assert.equal(openRows(s.discharged()).length, 1, '…while the sheet already holds the discharge');

  // Attempt 2: the user presses שחרר again (a NEW modal → a NEW audit id).
  app.dischargePatient(p);
  await app.confirms()[1](PICK);
  assert.equal(sent('dischargePatient').length, 2);
  const rows = openRows(s.discharged());
  assert.equal(rows.length, 1, 'still ONE open discharge row for the stay (was 2 before the fix)');
  assert.ok(app.toasts().includes('השחרור כבר נרשם'), app.toasts().join('|'));
  assert.equal(p.status, 'released', 'the patient is released on the recorded discharge');
  assert.equal(p.exitDate, EXIT);
  assert.equal(app.creditsModals(), 0, 'no second credits step for a stay already discharged');
  assert.equal(app.state.dischargedPatients.filter((d) => d.name === NAME).length, 0, 'the optimistic duplicate was dropped');
});

test('ROOT CAUSE, same modal: a retry after «נשמר חלקית» re-sends the SAME audit id → the row is updated in place', async () => {
  const s = seeded();
  let saveFails = true;
  const { app, sent } = loadApp((body) => {
    if (body.action === 'dischargePatient') return s.g.post(Object.assign({}, body, VERED()));
    if (body.action === 'saveAll' && saveFails) { saveFails = false; return { ok: false, error: 'sheets_unreachable', __status: 502 }; }
    return null;
  });
  app.state.patients = [app.normalizePatient({ id: 'pt-1', houseId: HOUSE, name: NAME, date: ENTRY, status: 'active' })];
  app.dischargePatient(app.state.patients[0]);
  await assert.rejects(app.confirms()[0](PICK));
  assert.ok(app.errors().some((m) => m.includes('נשמר חלקית')));
  await app.confirms()[0](PICK);            // the modal stayed open: same onConfirm
  const ids = sent('dischargePatient').map((b) => b.patient.id);
  assert.equal(ids.length, 2);
  assert.equal(ids[0], ids[1], 'one audit id per modal');
  assert.equal(s.discharged().length, 1, 'one row on the sheet');
});

/* ================== 2. the server guard ================== */

test('dischargePatient_: a second open row for the same stay is refused — duplicate:true, the existing id, NOTHING written', () => {
  const s = seeded({ discharged: [audit({ id: 'aud-1' })] });
  const before = s.snapshot(DSHEET);
  const auditBefore = s.audits().length;
  // Name with doubled / trailing spaces and a Date-typed entry cell → the same stay.
  const r = s.g.post(Object.assign({ action: 'dischargePatient', patient: audit({ id: 'aud-2', name: '  מטופל   בדיקה ' }) }, VERED()));
  assert.deepEqual(r, { ok: true, duplicate: true, discharged: false, id: 'aud-1', exitDate: EXIT });
  assert.equal(s.snapshot(DSHEET), before, 'not one cell moved');
  assert.equal(s.audits().length, auditBefore, 'no AuditLog row either');
  // A legacy Date-typed `date` cell on the stored row matches 'YYYY-MM-DD'.
  const s2 = seeded({ discharged: [audit({ id: 'aud-1', date: new Date('2026-09-09T00:00:00Z') })] });
  assert.equal(s2.g.post(Object.assign({ action: 'dischargePatient', patient: audit({ id: 'aud-9' }) }, VERED())).duplicate, true);
});

test('dischargePatient_: the SAME id is a plain retry (upsert in place); a different stay is never blocked', () => {
  const s = seeded({ discharged: [audit({ id: 'aud-1' })] });
  const r = s.g.post(Object.assign({ action: 'dischargePatient', patient: audit({ id: 'aud-1', discharge_note: 'עודכן' }) }, VERED()));
  assert.equal(r.ok, true);
  assert.equal(r.duplicate, undefined);
  assert.equal(s.discharged().length, 1);
  assert.equal(s.discharged()[0].discharge_note, 'עודכן');
  // Re-admission (new entry date) and another house: separate stays.
  assert.equal(s.g.post(Object.assign({ action: 'dischargePatient', patient: audit({ id: 'aud-2', date: '2026-10-01' }) }, VERED())).duplicate, undefined);
  assert.equal(s.g.post(Object.assign({ action: 'dischargePatient', patient: audit({ id: 'aud-3', houseId: 'ramot' }) }, VERED())).duplicate, undefined);
  assert.equal(s.discharged().length, 3);
});

test('a legitimate re-discharge after a restore is allowed (the restored row is not open)', () => {
  const s = seeded({ discharged: [audit({ id: 'aud-1' })] });
  assert.equal(s.g.post(Object.assign({ action: 'restorePatientToActive', patient: audit({ id: 'aud-1' }) }, VERED())).ok, true);
  const r = s.g.post(Object.assign({ action: 'dischargePatient', patient: audit({ id: 'aud-2', exitDate: '2026-10-20' }) }, VERED()));
  assert.equal(r.ok, true);
  assert.equal(r.duplicate, undefined);
  const rows = s.discharged();
  assert.equal(rows.length, 2);
  assert.deepEqual(openRows(rows).map((x) => x.id), ['aud-2']);
  // …and a third send for that new stay discharge is a duplicate again.
  assert.equal(s.g.post(Object.assign({ action: 'dischargePatient', patient: audit({ id: 'aud-3' }) }, VERED())).duplicate, true);
});

test('recordDischargeFromCoordinators_: an open Dashboard row for the stay → duplicate, nothing written (Patients untouched)', () => {
  const s = seeded({
    patients: [{ id: 'pt-1', houseId: HOUSE, name: NAME, date: ENTRY, status: 'active' }],
    discharged: [audit({ id: 'aud-1' })],
  });
  s.g.sandbox.__props.COORDINATORS_PATIENTS_SECRET = 'coord-secret-TEST-0123456789';
  const before = [s.snapshot(DSHEET), s.snapshot('Patients')];
  const r = s.g.post({ action: 'recordDischargeFromCoordinators', secret: 'coord-secret-TEST-0123456789', id: 'pt-1', dischargeDate: '2026-10-06', by: 'רכזת' });
  assert.equal(r.ok, true);
  assert.equal(r.duplicate, true);
  assert.equal(r.auditId, 'aud-1');
  assert.equal(r.id, 'pt-1', 'the coordinators contract keeps id = the patient id');
  assert.deepEqual([s.snapshot(DSHEET), s.snapshot('Patients')], before);
});

/* ================== 3. double tap ================== */

test('double tap: two confirms of the same stay in flight (two doors: house row + renewals row) → ONE dischargePatient write', async () => {
  const { app, sent } = loadApp();
  app.state.patients = [app.normalizePatient({ id: 'pt-1', houseId: HOUSE, name: NAME, date: ENTRY, status: 'active' })];
  const p = app.state.patients[0];
  app.dischargePatient(p);          // the house row's שחרר
  app.dischargePatient(p);          // the renewals row's שחרור
  // Both pressed before the first write answered.
  const a = app.confirms()[0](PICK);
  const b = app.confirms()[1](PICK);
  await Promise.all([a, b]);
  assert.equal(sent('dischargePatient').length, 1, 'the second confirm wrote nothing');
  assert.equal(app.creditsModals(), 1, 'one credits step');
  // Once the first finished, the guard is released (a later legit action is not blocked forever).
  app.dischargePatient(p);
  await app.confirms()[2](PICK);
  assert.equal(sent('dischargePatient').length, 2);
});

test('double tap on the modal button: busyButton is the first lock — the confirm handler ignores a click while busy', () => {
  const body = APP_SRC.slice(APP_SRC.indexOf('form.onsubmit = e => {', APP_SRC.indexOf('function showCloseLeadModal')),
    APP_SRC.indexOf('function showToast('));
  assert.match(body, /return busyButton\(submitBtn, 'save', async \(\) => \{/);
  const bb = APP_SRC.slice(APP_SRC.indexOf('function busyButton('), APP_SRC.indexOf('/* ===== BUSY-BUTTON PATTERN — END'));
  assert.match(bb, /if \(busyButtonActive\(btn\)\) return Promise\.resolve\(undefined\);/);
  assert.match(bb, /btn\.disabled = true;/);
});

/* ================== 4. credits ================== */

test('credits: «זיכויים (N)» counts per STAY — two duplicate rows show the SAME one credit (no second row is implied)', () => {
  const src = APP_SRC.slice(APP_SRC.indexOf('function renderDischargedPatients('), APP_SRC.indexOf('/* ===== «מחק כפילות»'));
  assert.match(src, /creditsForPatient\(state\.credits, '', patientKey\(p\)\)\.length/, 'the pill is keyed by patientKey (house+name+entry)');
});

test('upsertCredit_: a second OPEN credit for the same stay + rule is refused (duplicate:true, the existing id); cancelled / other rules / other stays are not', () => {
  const s = seeded();
  const base = { patientId: 'pt-1', patientKey: HOUSE + '::' + NAME + '::' + ENTRY, patientName: NAME, houseId: HOUSE,
    creditType: 'days_unused', allocationMonth: '2026-09', calculatedAmount: 1000, amount: 1000, basis: { exitDate: EXIT } };
  const r1 = s.g.post(Object.assign({ action: 'saveCredit', credit: base }, VERED()));
  assert.equal(r1.ok, true); assert.equal(r1.created, true);
  const before = s.snapshot('Credits');
  // Same stay — even with the name spaced differently in the key — same rule.
  const r2 = s.g.post(Object.assign({ action: 'saveCredit', credit: Object.assign({}, base, { patientKey: HOUSE + '::  מטופל  בדיקה ::' + ENTRY }) }, VERED()));
  assert.equal(r2.ok, true); assert.equal(r2.duplicate, true); assert.equal(r2.id, r1.credit.id);
  assert.equal(r2.credit.id, r1.credit.id, 'the answer carries the existing row for the client');
  assert.equal(s.snapshot('Credits'), before, 'nothing written');
  // Another month / rule / stay → created.
  assert.equal(s.g.post(Object.assign({ action: 'saveCredit', credit: Object.assign({}, base, { allocationMonth: '2026-10' }) }, VERED())).created, true);
  assert.equal(s.g.post(Object.assign({ action: 'saveCredit', credit: Object.assign({}, base, { creditType: 'prepaid_return' }) }, VERED())).created, true);
  assert.equal(s.g.post(Object.assign({ action: 'saveCredit', credit: Object.assign({}, base, { patientKey: HOUSE + '::' + NAME + '::2026-10-01' }) }, VERED())).created, true);
  // Manual 'other': the identical retry is a duplicate, a different one is not.
  const other = Object.assign({}, base, { creditType: 'other', reason: 'פיצוי', calculatedAmount: 200, amount: 200 });
  assert.equal(s.g.post(Object.assign({ action: 'saveCredit', credit: other }, VERED())).created, true);
  assert.equal(s.g.post(Object.assign({ action: 'saveCredit', credit: other }, VERED())).duplicate, true);
  assert.equal(s.g.post(Object.assign({ action: 'saveCredit', credit: Object.assign({}, other, { reason: 'פיצוי נוסף' }) }, VERED())).created, true);
  // A CANCELLED credit does not block a new one.
  const s2 = seeded({ credits: [credit({ status: 'cancelled' })] });
  assert.equal(s2.g.post(Object.assign({ action: 'saveCredit', credit: base }, VERED())).created, true);
});

test('saveCredit (client): duplicate:true keeps the existing credit, once, in state', async () => {
  const existing = credit();
  const { app } = loadApp((body) => (body.action === 'saveCredit' ? { ok: true, duplicate: true, id: existing.id, credit: existing } : null));
  app.state.credits = [];
  const saved = await app.saveCredit({ patientId: 'pt-1', patientKey: existing.patientKey, creditType: 'days_unused', allocationMonth: '2026-09' });
  assert.equal(saved.id, existing.id);
  await app.saveCredit({ patientId: 'pt-1' });
  assert.equal(app.state.credits.length, 1, 'not pushed twice');
});

/* ================== 5. «מחק כפילות» ================== */

const TWO = () => [audit({ id: 'aud-1' }), audit({ id: 'aud-2', dischargedAt: '2026-10-06T09:01:00.000Z' })];

test('delete: role-gated — Shiran / Yael refused (forbidden_role), NOTHING written; Vered and Sandra allowed', () => {
  for (const who of [SHIRAN, YAEL]) {
    const s = seeded({ discharged: TWO() });
    const before = s.snapshot(DSHEET);
    const r = s.g.post(Object.assign({ action: 'deleteDuplicateDischarge', id: 'aud-2', reason: 'כפילות' }, who()));
    assert.equal(r.error, 'forbidden_role');
    assert.equal(s.snapshot(DSHEET), before);
  }
  // No proxy identity at all (a direct caller) → refused too.
  const s0 = seeded({ discharged: TWO() });
  assert.equal(s0.g.post({ action: 'deleteDuplicateDischarge', id: 'aud-2', reason: 'כפילות' }).error, 'forbidden_role');
  for (const who of [VERED, SANDRA]) {
    const s = seeded({ discharged: TWO() });
    const r = s.g.post(Object.assign({ action: 'deleteDuplicateDischarge', id: 'aud-2', reason: 'כפילות' }, who()));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.deleted, true);
    assert.equal(r.keptId, 'aud-1');
  }
  // The server.js mirror classifies it the same way.
  const roleScope = require('../lib/role-scope');
  assert.equal(roleScope.requiredRoleFor('deleteDuplicateDischarge'), 'deleter');
});

test('delete: a reason is REQUIRED (2–120 chars, cleaned) — refused with nothing written otherwise', () => {
  const s = seeded({ discharged: TWO() });
  const before = s.snapshot(DSHEET);
  for (const [reason, err] of [['', 'reason_required'], [' א ', 'reason_required'], [undefined, 'reason_required'],
    ['<>', 'reason_required'], ['=+', 'reason_required'], ['א'.repeat(121), 'reason_too_long']]) {
    const r = s.g.post(Object.assign({ action: 'deleteDuplicateDischarge', id: 'aud-2', reason }, VERED()));
    assert.equal(r.ok, false, String(reason));
    assert.equal(r.error, err, String(reason));
    assert.match(r.message, /[א-ת]/, 'a Hebrew message');
  }
  assert.equal(s.snapshot(DSHEET), before);
  const ok = s.g.post(Object.assign({ action: 'deleteDuplicateDischarge', id: 'aud-2', reason: '=כפ<img>' }, VERED()));
  assert.equal(ok.ok, true);
  assert.equal(ok.deleteReason, 'כפimg', 'formula lead-in and angle brackets stripped');
  assert.equal(s.discharged().find((r) => r.id === 'aud-2').deleteReason, 'כפimg');
});

test('delete: the LAST open row of a stay is protected (a restored or deleted sibling does not count); unknown / restored rows refused', () => {
  const s = seeded({ discharged: [audit({ id: 'aud-1' }), audit({ id: 'aud-0', restored: 'TRUE' })] });
  const before = s.snapshot(DSHEET);
  assert.equal(s.g.post(Object.assign({ action: 'deleteDuplicateDischarge', id: 'aud-1', reason: 'כפילות' }, VERED())).error, 'last_discharge_row');
  assert.equal(s.g.post(Object.assign({ action: 'deleteDuplicateDischarge', id: 'aud-0', reason: 'כפילות' }, VERED())).error, 'not_open');
  assert.equal(s.g.post(Object.assign({ action: 'deleteDuplicateDischarge', id: 'nope', reason: 'כפילות' }, VERED())).error, 'not_found');
  assert.equal(s.g.post(Object.assign({ action: 'deleteDuplicateDischarge', id: '', reason: 'כפילות' }, VERED())).error, 'missing_id');
  assert.equal(s.snapshot(DSHEET), before);
  // Two open rows: the first delete works, the survivor is then the last one.
  const t = seeded({ discharged: TWO() });
  assert.equal(t.g.post(Object.assign({ action: 'deleteDuplicateDischarge', id: 'aud-2', reason: 'כפילות' }, VERED())).ok, true);
  assert.equal(t.g.post(Object.assign({ action: 'deleteDuplicateDischarge', id: 'aud-1', reason: 'כפילות' }, VERED())).error, 'last_discharge_row');
  assert.deepEqual(openRows(t.discharged()).map((r) => r.id), ['aud-1']);
});

test('delete: a row with its OWN credit, or a stay with TWO open credits for one rule (double refund), is refused', () => {
  // aud-2 has a different exit date and a credit computed for it → its own.
  const own = seeded({
    discharged: [audit({ id: 'aud-1' }), audit({ id: 'aud-2', exitDate: '2026-10-07' })],
    credits: [credit({ basis: JSON.stringify({ exitDate: '2026-10-07' }) })],
  });
  const r1 = own.g.post(Object.assign({ action: 'deleteDuplicateDischarge', id: 'aud-2', reason: 'כפילות' }, VERED()));
  assert.equal(r1.error, 'row_has_credit');
  assert.match(r1.message, /סנדרה/);
  assert.deepEqual(r1.creditIds, ['credit::pt-1::2026-09::1']);
  // …while its sibling (whose exit date has no credit) can go.
  assert.equal(own.g.post(Object.assign({ action: 'deleteDuplicateDischarge', id: 'aud-1', reason: 'כפילות' }, VERED())).ok, true);

  const dbl = seeded({
    discharged: TWO(),
    credits: [credit({ id: 'c-1' }), credit({ id: 'c-2' })],
  });
  const before = dbl.snapshot(DSHEET);
  const r2 = dbl.g.post(Object.assign({ action: 'deleteDuplicateDischarge', id: 'aud-2', reason: 'כפילות' }, VERED()));
  assert.equal(r2.error, 'duplicate_credit');
  assert.match(r2.message, /החזר כפול/);
  assert.deepEqual(r2.creditIds, ['c-1', 'c-2']);
  assert.equal(dbl.snapshot(DSHEET), before);
  assert.equal(dbl.snapshot('Credits'), JSON.stringify(dbl.S.Credits.grid), 'credits never touched');

  // ONE credit shared by identical duplicates (the reported case) → allowed; the credit stays.
  const shared = seeded({ discharged: TWO(), credits: [credit()] });
  const creditsBefore = shared.snapshot('Credits');
  assert.equal(shared.g.post(Object.assign({ action: 'deleteDuplicateDischarge', id: 'aud-2', reason: 'כפילות' }, VERED())).ok, true);
  assert.equal(shared.snapshot('Credits'), creditsBefore);
  // A CANCELLED second credit is no double refund.
  const cancelled = seeded({ discharged: TWO(), credits: [credit({ id: 'c-1' }), credit({ id: 'c-2', status: 'cancelled' })] });
  assert.equal(cancelled.g.post(Object.assign({ action: 'deleteDuplicateDischarge', id: 'aud-2', reason: 'כפילות' }, VERED())).ok, true);
});

test('delete: soft — three appended cells on that ONE row, an AuditLog row (at / by / prev); Patients, Payments, the sibling untouched; idempotent', () => {
  const s = seeded({ discharged: TWO() });
  const keep = ['Patients', 'Payments', 'Credits'].map((n) => s.snapshot(n));
  const sibling = JSON.stringify(s.discharged()[0]);
  const r = s.g.post(Object.assign({ action: 'deleteDuplicateDischarge', id: 'aud-2', reason: 'שורה כפולה' }, VERED()));
  assert.equal(r.ok, true);
  assert.deepEqual(['Patients', 'Payments', 'Credits'].map((n) => s.snapshot(n)), keep, 'patient, payments, credits untouched');
  const rows = s.discharged();
  assert.equal(rows.length, 2, 'never physically removed');
  assert.equal(JSON.stringify(rows[0]), sibling, 'the kept row is untouched');
  const del = rows[1];
  assert.ok(Number.isFinite(Date.parse(del.deletedAt)));
  assert.equal(del.deletedBy, 'ורד', 'the verified actor, never the payload');
  assert.equal(del.deleteReason, 'שורה כפולה');
  assert.equal(del.name, NAME, 'every other cell kept');
  const log = s.audits().filter((a) => a.action === 'discharge_duplicate_deleted');
  assert.equal(log.length, 1);
  assert.equal(log[0].actor, 'ורד');
  const d = JSON.parse(log[0].details);
  assert.equal(d.at, del.deletedAt);
  assert.equal(d.by, 'ורד');
  assert.equal(d.reason, 'שורה כפולה');
  assert.equal(d.keptId, 'aud-1');
  assert.equal(d.prev.id, 'aud-2');
  assert.equal(d.prev.deletedAt, '', 'prev is the row BEFORE the delete');
  // Idempotent: a second delete answers alreadyDeleted and writes nothing.
  const snap = s.snapshot(DSHEET);
  const again = s.g.post(Object.assign({ action: 'deleteDuplicateDischarge', id: 'aud-2', reason: 'שוב' }, VERED()));
  assert.equal(again.alreadyDeleted, true);
  assert.equal(s.snapshot(DSHEET), snap);
  assert.equal(s.audits().filter((a) => a.action === 'discharge_duplicate_deleted').length, 1);
  // The guard now sees ONE open row; a deleted row is no discharge.
  assert.equal(s.g.post(Object.assign({ action: 'dischargePatient', patient: audit({ id: 'aud-3' }) }, VERED())).id, 'aud-1');
});

test('restore paths never blank the soft-delete stamps of a stored row', () => {
  const s = seeded({ discharged: TWO() });
  assert.equal(s.g.post(Object.assign({ action: 'deleteDuplicateDischarge', id: 'aud-2', reason: 'כפילות' }, VERED())).ok, true);
  // A stale client copy (no deletedAt) of the deleted row sent through both restore actions.
  assert.equal(s.g.post(Object.assign({ action: 'restorePatientToActive', patient: audit({ id: 'aud-2' }) }, VERED())).ok, true);
  assert.equal(s.g.post(Object.assign({ action: 'restorePatient', patient: audit({ id: 'aud-2' }) }, VERED())).ok, true);
  const row = s.discharged().find((r) => r.id === 'aud-2');
  assert.ok(row.deletedAt, 'still deleted');
  assert.equal(row.deleteReason, 'כפילות');
});

/* ================== 6. listDuplicateDischargesNow — dry run ================== */

test('listDuplicateDischargesNow: logs every stay with 2+ open rows and its credits — and writes NOTHING', () => {
  const s = seeded({
    discharged: [
      audit({ id: 'aud-1' }), audit({ id: 'aud-2' }),                         // the reported pair
      audit({ id: 'aud-x', name: 'אחר' }),                                     // a single stay
      audit({ id: 'aud-r1', name: 'שלישי' }), audit({ id: 'aud-r2', name: 'שלישי', restored: 'TRUE' }), // restored: not a dup
    ],
    credits: [credit()],
  });
  const before = JSON.stringify(Object.keys(s.S).sort().map((k) => [k, s.S[k].grid]));
  const out = s.g.run('listDuplicateDischargesNow()');
  assert.equal(JSON.stringify(Object.keys(s.S).sort().map((k) => [k, s.S[k].grid])), before, 'not one sheet or cell created or changed');
  assert.equal(out.dryRun, true);
  assert.equal(out.stays.length, 1);
  const stay = out.stays[0];
  assert.equal(stay.stay, HOUSE + '::' + NAME + '::' + ENTRY);
  assert.deepEqual(arr(stay.rows).map((r) => [r.id, r.sheetRow, r.exitDate, r.disposition]), [['aud-1', 2, EXIT, 'completed'], ['aud-2', 3, EXIT, 'completed']]);
  assert.deepEqual(arr(stay.credits).map((c) => [c.id, c.status, c.basisExitDate]), [['credit::pt-1::2026-09::1', 'pending', EXIT]]);
  assert.deepEqual(arr(stay.rows).map((r) => arr(r.ownCredits)), [[], []], 'ONE credit shared by identical rows — owned by neither');
  assert.deepEqual(arr(stay.doubleRefund), []);
  assert.ok(s.g.logs.some((l) => l.includes('[dup-discharges] DRY RUN — 1 stay(s)')), s.g.logs.join('\n'));
  // Not reachable over HTTP: handle_ never dispatches it.
  assert.equal(s.g.post(Object.assign({ action: 'listDuplicateDischargesNow' }, VERED())).ok, false);
  const fn = GS_SRC.slice(GS_SRC.indexOf('function listDuplicateDischargesNow('), GS_SRC.indexOf('/* ===== Cross-app: admitted roster'));
  assert.ok(!/setValue|setValues|appendRow|getOrCreateSheet_|logAudit_|LockService|deleteRow|insertSheet/.test(fn), 'read-only by construction');
});

test('listDuplicateDischargesNow: a double refund is flagged; no sheet at all → empty, still nothing created', () => {
  const s = seeded({ discharged: TWO(), credits: [credit({ id: 'c-1' }), credit({ id: 'c-2' })] });
  assert.deepEqual(arr(s.g.run('listDuplicateDischargesNow()').stays[0].doubleRefund), ['days_unused::2026-09']);
  const g = loadGs({});
  const out = g.run('listDuplicateDischargesNow()');
  assert.equal(out.stays.length, 0);
  assert.deepEqual(Object.keys(g.sandbox.__sheets), []);
});

/* ================== 7. client: open-row filters, helpers, escaping ================== */

test('client: a soft-deleted row is NOT a discharge anywhere — tab, heal, restore bridge, coordinators panel', () => {
  const { app } = loadApp();
  const del = app.normalizeDischargedPatient(Object.assign(audit({ id: 'aud-2', dischargeSource: 'ezone-coordinators' }), { deletedAt: '2026-10-07T08:00:00.000Z', deletedBy: 'ורד', deleteReason: 'כפילות' }));
  assert.equal(del.deletedAt, '2026-10-07T08:00:00.000Z', 'normalize carries the stamps');
  assert.equal(app.dischargeRowOpen(del), false);
  assert.equal(app.dischargeRowOpen(app.normalizeDischargedPatient(audit())), true);
  assert.equal(app.dischargeRowOpen(app.normalizeDischargedPatient(audit({ restored: 'TRUE' }))), false);
  app.state.dischargedPatients = [del];
  app.state.patients = [app.normalizePatient({ id: 'pt-1', houseId: HOUSE, name: NAME, date: ENTRY, status: 'active' })];
  assert.equal(app.healClobberedDischarges().length, 0, 'the heal ignores a deleted row');
  assert.equal(app.state.patients[0].status, 'active');
  assert.equal(app.openDischargeAuditsFor(app.state.patients[0], [del]).length, 0);
  assert.notEqual(app.auditRowForReleasedPatient(app.state.patients[0], [del]).id, 'aud-2');
  assert.equal(app.coordinatorDischarges([del], '2026-10-07').length, 0);
  const tab = APP_SRC.slice(APP_SRC.indexOf('function renderDischargedPatients('), APP_SRC.indexOf('/* ===== «מחק כפילות»'));
  assert.match(tab, /\.filter\(d => dischargeRowOpen\(d\)\)/);
});

test('client: «מחק כפילות» is offered only on a row with an OPEN sibling of the same stay, and only to a deleter', () => {
  const { app } = loadApp();
  const a = app.normalizeDischargedPatient(audit({ id: 'aud-1' }));
  const b = app.normalizeDischargedPatient(audit({ id: 'aud-2', name: ' מטופל  בדיקה' }));
  const other = app.normalizeDischargedPatient(audit({ id: 'aud-9', date: '2026-10-01' }));
  const restored = app.normalizeDischargedPatient(audit({ id: 'aud-0', restored: 'TRUE' }));
  assert.equal(app.dischargeStayKey(a), app.dischargeStayKey(b), 'whitespace-normalized like Code.gs');
  assert.deepEqual(arr(app.openDuplicateSiblings(a, [a, b, other, restored])).map((d) => d.id), ['aud-2']);
  assert.equal(app.openDuplicateSiblings(a, [a, other, restored]).length, 0, 'the last open row offers nothing');
  const tab = APP_SRC.slice(APP_SRC.indexOf('function renderDischargedPatients('), APP_SRC.indexOf('/* ===== «מחק כפילות»'));
  assert.match(tab, /if \(canDelete\(\) && openDuplicateSiblings\(p, state\.dischargedPatients\)\.length > 0\) \{/);
  assert.match(tab, /dupBtn\.dataset\.role = 'deleter';/);
  assert.match(tab, /dupBtn\.textContent = 'מחק כפילות';/);
});

test('client: deleteDuplicateDischarge — reason checked before any send; a refusal keeps the row; success hides it', async () => {
  let answer = { ok: false, error: 'row_has_credit', message: 'לשורת שחרור זו יש זיכוי משלה. ביטול זיכוי דורש אישור סנדרה — השורה לא נמחקה' };
  const { app, sent } = loadApp((body) => (body.action === 'deleteDuplicateDischarge' ? answer : null));
  app.state.dischargedPatients = [app.normalizeDischargedPatient(audit({ id: 'aud-1' })), app.normalizeDischargedPatient(audit({ id: 'aud-2' }))];
  assert.equal(app.duplicateDischargeReasonError(''), 'יש להזין סיבה למחיקה (2–120 תווים)');
  assert.equal(app.duplicateDischargeReasonError('א'.repeat(121)), 'הסיבה ארוכה מדי (עד 120 תווים)');
  assert.equal(app.duplicateDischargeReasonError('אב'), '');
  await assert.rejects(app.deleteDuplicateDischarge(app.state.dischargedPatients[1], ' '), /סיבה/);
  assert.equal(sent('deleteDuplicateDischarge').length, 0, 'nothing sent without a reason');
  await assert.rejects(app.deleteDuplicateDischarge(app.state.dischargedPatients[1], 'כפילות'), /זיכוי משלה/);
  assert.equal(app.dischargeRowOpen(app.state.dischargedPatients[1]), true, 'a refusal keeps the row');
  answer = { ok: true, deleted: true, id: 'aud-2', deletedAt: '2026-10-07T08:00:00.000Z', deletedBy: 'ורד', deleteReason: 'כפילות' };
  await app.deleteDuplicateDischarge(app.state.dischargedPatients[1], 'כפילות');
  assert.deepEqual(sent('deleteDuplicateDischarge').map((b) => [b.id, b.reason]), [['aud-2', 'כפילות'], ['aud-2', 'כפילות']]);
  assert.equal(app.dischargeRowOpen(app.state.dischargedPatients[1]), false);
  assert.ok(app.toasts().includes('הכפילות נמחקה'));
  // A non-deleter session never sends.
  app.state.deleter = false;
  await assert.rejects(app.deleteDuplicateDischarge(app.state.dischargedPatients[0], 'כפילות'), /אין הרשאה/);
  assert.equal(sent('deleteDuplicateDischarge').length, 2);
});

test('escaping: the delete modal escapes every interpolated value; the tab writes names with textContent', () => {
  const modal = APP_SRC.slice(APP_SRC.indexOf('function showDeleteDuplicateDischargeModal('), APP_SRC.indexOf('/* Restore path A'));
  const interpolations = [...modal.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1].trim());
  assert.ok(interpolations.length >= 4);
  for (const i of interpolations) assert.match(i, /^escapeHtml\(/, 'unescaped interpolation: ' + i);
  // Code.gs messages are static Hebrew strings — never echo the payload.
  const msgs = GS_SRC.slice(GS_SRC.indexOf('const DUP_DELETE_MESSAGES = {'), GS_SRC.indexOf('function dupDeleteRefusal_('));
  assert.ok(!/\+/.test(msgs), 'no concatenated (user-supplied) text in the refusal messages');
});

test('wiring: Code.gs dispatch + registries, server.js role mirror, append-only columns, SW v43+', () => {
  const h = GS_SRC.slice(GS_SRC.indexOf('function handle_('), GS_SRC.indexOf('function collectParams_('));
  assert.match(h, /if \(action === 'deleteDuplicateDischarge'\) \{\n\s+\/\/[^\n]*\n[\s\S]*?return jsonOut_\(deleteDuplicateDischarge_\(params, actorLabel_\(params\)\)\);/);
  const g = loadGs({});
  assert.ok(arr(g.run('DELETE_ACTIONS')).includes('deleteDuplicateDischarge'));
  assert.ok(arr(g.run('PROXY_KNOWN_ACTIONS')).includes('deleteDuplicateDischarge'));
  assert.ok(!arr(g.run('OPEN_ACTIONS')).includes('deleteDuplicateDischarge'), 'never served without PROXY_SECRET');
  assert.deepEqual(arr(g.run('DISCHARGED_PATIENT_COLUMNS')).slice(-3), ['deletedAt', 'deletedBy', 'deleteReason']);
  // Every server reader that treats a row as a live discharge skips a soft-deleted one.
  assert.match(GS_SRC, /if \(!d \|\| diagIsRestored_\(d\.restored\) \|\| dischargeRowDeleted_\(d\)\) return;/, 'refund forecast');
  assert.match(GS_SRC, /if \(dischargeRowDeleted_\(rows\[i\]\)\) continue;   \/\/ a soft-deleted duplicate is not a discharge/, 'promotion guard');
  assert.match(GS_SRC, /audits: rows\('discharged'\)\.filter\(function \(r\) \{ return !dischargeRowDeleted_\(r\.obj\); \}\)/, 'reconciliation');
  assert.deepEqual([...require('../lib/role-scope').DELETE_ACTIONS], arr(g.run('DELETE_ACTIONS')));
  const sw = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');
  const v = /var CACHE_VERSION = '(v\d+)';/.exec(sw)[1];
  // v43 shipped this fix; later public/ changes bump past it (v44: the
  // receipt duplicates / edit PR). v17 must never come back.
  assert.ok(Number(v.slice(1)) >= 43 && v !== 'v17', 'got ' + v);
  // Shared-action changes are ADDITIVE: dischargePatient still answers ok:true
  // (a duplicate is ok:true + duplicate), so ezone-managers / ezone-therapists
  // callers that only read `ok` see no change.
  const s = seeded({ discharged: [audit({ id: 'aud-1' })] });
  assert.equal(s.g.post(Object.assign({ action: 'dischargePatient', patient: audit({ id: 'aud-2' }) }, VERED())).ok, true);
});
