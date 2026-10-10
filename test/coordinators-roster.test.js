'use strict';

/* Coordinators patient roster (2026-10-04) — CHANGELOG-coordinators-roster.md.
 *
 *   getPatientsForCoordinators       — read-only feed, FROZEN key set
 *   recordDischargeFromCoordinators  — the one write: status released +
 *                                      exitDate, audit row, idempotent, locked
 *
 * Both gated by Script Property COORDINATORS_PATIENTS_SECRET (constant-time,
 * fail-closed). Runs the REAL apps-script/Code.gs in the shared vm sandbox
 * (test/helpers/gs-sandbox.js), through the real doPost → proxyGate_ →
 * handle_ path. */

const { test } = require('node:test');
const assert = require('node:assert');
const { GS_SRC, richSheet, loadGs } = require('./helpers/gs-sandbox');

const SECRET = 'coord-secret-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
const PROXY = 'proxy-secret-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const PATIENTS = 'Patients';
const DISCHARGED = 'מטופלים משוחררים';
const arr = (x) => JSON.parse(JSON.stringify(x));

const FEED_KEYS = ['id', 'name', 'house', 'active', 'admissionDate', 'dischargeDate'];
const FORBIDDEN = ['pay', 'adv', 'phone', 'notes', 'fromLead', 'source', 'status', 'exitDate', 'date',
  'houseId', 'updatedAt', 'updatedBy', 'billing', 'payment', 'amount'];

const isoDaysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const TODAY = isoDaysAgo(0);

/* PATIENT_COLUMNS order: houseId name date pay adv status fromLead exitDate
 * source notes id updatedAt updatedBy */
function patientRow(o) {
  return [o.houseId, o.name, o.date || '', o.pay == null ? 29000 : o.pay, o.adv || 0, o.status || 'active',
    o.fromLead || '', o.exitDate || '', o.source || 'direct_admin', o.notes || '', o.id || '',
    o.updatedAt || '', o.updatedBy || ''];
}

const FIXTURE = [
  { houseId: 'ramot', name: 'דנה כהן', date: '2026-09-01', id: 'id-dana', notes: 'פרטי', fromLead: 'L1',
    updatedAt: '2026-09-01T08:00:00.000Z', updatedBy: 'ורד' },
  { houseId: 'asher', name: ' יוסי לוי ', date: '2026-08-15', id: 'id-yossi', status: 'wait' },
  { houseId: 'arfoni', name: 'מיכל', date: '2026-07-01', id: 'id-michal', status: 'released', exitDate: isoDaysAgo(5) },
  { houseId: 'rehab', name: 'אבי', date: '2026-01-01', id: 'id-avi', status: 'released', exitDate: '2026-02-01' },
  { houseId: 'sde', name: 'שדה', date: '2026-09-01', id: 'id-sde' },
  { houseId: 'pardes', name: 'נועה', date: '2026-09-10', id: 'id-noa' },
];

function load(opts) {
  const o = opts || {};
  const props = Object.assign({ COORDINATORS_PATIENTS_SECRET: SECRET }, o.props || {});
  if (o.noSecret) delete props.COORDINATORS_PATIENTS_SECRET;
  const g = loadGs({ props });
  const cols = Array.from(g.run('PATIENT_COLUMNS'));
  const sh = richSheet(PATIENTS, cols);
  (o.rows || FIXTURE).forEach((r) => sh.grid.push(patientRow(r)));
  g.sandbox.__sheets[PATIENTS] = sh;
  g.sandbox.Session = { getScriptTimeZone: () => 'Asia/Jerusalem' };
  return g;
}
const snapshot = (g) => JSON.stringify(Object.keys(g.sandbox.__sheets).sort()
  .filter((n) => n !== 'SecurityLog' && n !== 'AuditLog')
  .map((n) => [n, g.sandbox.__sheets[n].grid]));
const patientCell = (g, id, col) => {
  const cols = Array.from(g.run('PATIENT_COLUMNS'));
  const row = g.sandbox.__sheets[PATIENTS].grid.find((r) => r[cols.indexOf('id')] === id);
  return row[cols.indexOf(col)];
};

/* ===== A. the feed contract ===== */

test('feed: every row carries EXACTLY the six contract keys — no phone, billing or payment field', () => {
  const g = load();
  const res = g.post({ action: 'getPatientsForCoordinators', secret: SECRET });
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(Object.keys(res).sort(), ['ok', 'patients']);
  assert.ok(res.patients.length > 0);
  for (const p of res.patients) {
    assert.deepStrictEqual(Object.keys(p), FEED_KEYS, 'exact keys, exact order');
    for (const f of FORBIDDEN) assert.ok(!(f in p), f + ' must never be in the feed');
  }
  assert.deepStrictEqual(Array.from(g.run('COORD_FEED_KEYS')), FEED_KEYS, 'the code constant is the same contract');
});

test('feed: values — canonical house, trimmed name, active flag, yyyy-MM-dd dates, sde + old discharges excluded', () => {
  const g = load();
  const res = g.post({ action: 'getPatientsForCoordinators', secret: SECRET });
  const byId = Object.fromEntries(res.patients.map((p) => [p.id, p]));
  assert.deepStrictEqual(byId['id-dana'], { id: 'id-dana', name: 'דנה כהן', house: 'ramot', active: true,
    admissionDate: '2026-09-01', dischargeDate: '' });
  assert.deepStrictEqual(byId['id-yossi'], { id: 'id-yossi', name: 'יוסי לוי', house: 'raanana', active: true,
    admissionDate: '2026-08-15', dischargeDate: '' }, 'wait still occupies a bed → active');
  assert.deepStrictEqual(byId['id-michal'], { id: 'id-michal', name: 'מיכל', house: 'efroni', active: false,
    admissionDate: '2026-07-01', dischargeDate: isoDaysAgo(5) }, 'recent discharge stays visible');
  assert.strictEqual(byId['id-noa'].house, 'pardes');
  assert.ok(!byId['id-avi'], 'a discharge older than 30 days is not shared');
  assert.ok(!byId['id-sde'], 'a house outside the coordinators set is excluded');
  for (const p of res.patients) {
    assert.strictEqual(typeof p.active, 'boolean');
    assert.match(p.admissionDate, /^(\d{4}-\d{2}-\d{2})?$/);
    assert.match(p.dischargeDate, /^(\d{4}-\d{2}-\d{2})?$/);
  }
});

test('feed: a Sheets date serial / Date cell is rendered as yyyy-MM-dd, never a timestamp', () => {
  const g = load({ rows: [{ houseId: 'ramot', name: 'א', date: 46266, id: 'id-a' }] }); // serial 46266 = 2026-09-01
  const res = g.post({ action: 'getPatientsForCoordinators', secret: SECRET });
  assert.strictEqual(res.patients[0].admissionDate, '2026-09-01');
});

test('feed: a row without a persisted id gets one minted (never served id-less)', () => {
  const g = load({ rows: [{ houseId: 'ramot', name: 'בלי מזהה', date: '2026-09-01', id: '' }] });
  const res = g.post({ action: 'getPatientsForCoordinators', secret: SECRET });
  assert.strictEqual(res.patients.length, 1);
  assert.ok(res.patients[0].id, 'id minted');
  assert.strictEqual(patientCell(g, res.patients[0].id, 'name'), 'בלי מזהה', 'and persisted on the sheet');
});

test('buildCoordinatorsRoster_ is a pure allow-list projection (extra fields on the row never leak)', () => {
  const g = load();
  const out = arr(g.sandbox.buildCoordinatorsRoster_([{ id: 'x', name: 'n', houseId: 'ramot', date: '2026-01-01',
    status: 'active', pay: 1, adv: 2, phone: '050', notes: 'clinical', secret: 's' }], '2000-01-01'));
  assert.deepStrictEqual(out, [{ id: 'x', name: 'n', house: 'ramot', active: true, admissionDate: '2026-01-01', dischargeDate: '' }]);
});

/* ===== B. auth: own secret, constant time, fail closed ===== */

test('auth: unset / empty / wrong / missing / non-string secret → unauthorized, nothing served or written', () => {
  const cases = [
    [{ noSecret: true }, SECRET],
    [{ props: { COORDINATORS_PATIENTS_SECRET: '' } }, ''],
    [{}, SECRET + 'x'],
    [{}, undefined],
    [{}, ''],
    [{}, ['x']],
  ];
  for (const [opts, secret] of cases) {
    for (const action of ['getPatientsForCoordinators', 'recordDischargeFromCoordinators']) {
      const g = load(opts);
      const before = snapshot(g);
      const body = { action, id: 'id-dana', dischargeDate: TODAY, by: 'רכזת' };
      if (secret !== undefined) body.secret = secret;
      assert.deepStrictEqual(g.post(body), { ok: false, error: 'unauthorized' }, action + ' ' + JSON.stringify(secret));
      assert.strictEqual(snapshot(g), before, 'nothing written');
    }
  }
});

test('auth: other apps\' secrets do not unlock it; it does not unlock theirs', () => {
  const g = load({ props: { ADMITTED_ROSTER_SECRET: 'r', ACCOUNTING_SECRET: 'a', MEETING_REPORT_SECRET: 'm' } });
  for (const s of ['r', 'a', 'm', PROXY]) {
    assert.deepStrictEqual(g.post({ action: 'getPatientsForCoordinators', secret: s }), { ok: false, error: 'unauthorized' });
  }
  assert.deepStrictEqual(g.post({ action: 'getAdmittedRoster', secret: SECRET }), { ok: false, error: 'unauthorized' });
  assert.deepStrictEqual(g.post({ action: 'accountingPayments', secret: SECRET }), { ok: false, error: 'unauthorized' });
});

test('auth: constant-time compare, own Script Property, open action that survives PROXY_SECRET enforce mode', () => {
  const fn = GS_SRC.slice(GS_SRC.indexOf('function coordinatorsPatientsAuthOk_'), GS_SRC.indexOf('function coordStatusReleased_'));
  assert.match(fn, /constantTimeEquals_\(got, expected\)/);
  assert.doesNotMatch(fn, /===\s*expected|expected\s*===/, 'no plain equality on the secret');
  assert.match(GS_SRC, /const COORDINATORS_PATIENTS_SECRET_PROP = 'COORDINATORS_PATIENTS_SECRET';/);
  const g = load({ props: { PROXY_SECRET: PROXY, PROXY_SECRET_MODE: 'enforce' } });
  assert.strictEqual(g.post({ action: 'getPatientsForCoordinators', secret: SECRET }).ok, true);
  const known = Array.from(g.run('PROXY_KNOWN_ACTIONS'));
  assert.ok(known.includes('getPatientsForCoordinators') && known.includes('recordDischargeFromCoordinators'));
  assert.ok(!Array.from(g.run('FINANCE_ACTIONS')).some((a) => /Coordinators/.test(a)));
});

test('the secret value never appears in a response, the SecurityLog or the AuditLog', () => {
  const g = load();
  const r1 = g.post({ action: 'getPatientsForCoordinators', secret: SECRET });
  const r2 = g.post({ action: 'recordDischargeFromCoordinators', secret: SECRET, id: 'id-dana', dischargeDate: TODAY, by: 'רכזת' });
  const all = JSON.stringify([r1, r2, Object.values(g.sandbox.__sheets).map((s) => s.grid), g.logs]);
  assert.ok(!all.includes(SECRET));
});

/* ===== C. the discharge write ===== */

function discharge(g, extra) {
  return g.post(Object.assign({ action: 'recordDischargeFromCoordinators', secret: SECRET,
    id: 'id-dana', dischargeDate: TODAY, reason: 'סיים טיפול', by: 'רכזת רמות' }, extra || {}));
}

test('discharge: status released + exitDate + who/when; nothing else on the row changes; never deletes', () => {
  const g = load();
  const cols = Array.from(g.run('PATIENT_COLUMNS'));
  const grid = g.sandbox.__sheets[PATIENTS].grid;
  const rowsBefore = grid.length;
  const before = grid.find((r) => r[cols.indexOf('id')] === 'id-dana').slice();
  const res = discharge(g);
  assert.deepStrictEqual(res, { ok: true, discharged: true, id: 'id-dana', dischargeDate: TODAY });
  assert.strictEqual(grid.length, rowsBefore, 'no row added or removed');
  const after = grid.find((r) => r[cols.indexOf('id')] === 'id-dana');
  cols.forEach((c, i) => {
    if (['status', 'exitDate', 'updatedAt', 'updatedBy'].includes(c)) return;
    assert.deepStrictEqual(after[i], before[i], c + ' untouched');
  });
  assert.strictEqual(patientCell(g, 'id-dana', 'status'), 'released');
  assert.strictEqual(patientCell(g, 'id-dana', 'exitDate'), TODAY);
  // New writes stamp the inclusive plural (CHANGELOG-inclusive-role-wording.md).
  assert.strictEqual(patientCell(g, 'id-dana', 'updatedBy'), 'רכזים · רכזת רמות');
  assert.notStrictEqual(patientCell(g, 'id-dana', 'updatedAt'), '2026-09-01T08:00:00.000Z');
});

test('discharge: a row stamped before the wording change keeps its old updatedBy; nothing rewrites it', () => {
  /* Older coordinator discharges were stamped with the feminine plural. Such a
   * row is read, replayed and saved as is — the stamp is never parsed, so both
   * forms are accepted and the old one is never rewritten. */
  const OLD = 'רכזות · רכזת רמות';   // the pre-change stamp
  const rows = FIXTURE.map((r) => (r.id === 'id-dana'
    ? Object.assign({}, r, { status: 'released', exitDate: TODAY, updatedBy: OLD })
    : r));
  const g = load({ rows });
  const before = snapshot(g);
  const res = discharge(g);   // the same discharge replayed
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.alreadyDischarged, true);
  assert.strictEqual(patientCell(g, 'id-dana', 'updatedBy'), OLD, 'the old stamp is kept');
  assert.strictEqual(snapshot(g), before, 'nothing written');
  // The feed still lists the patient as discharged on that date.
  const feed = g.post({ action: 'getPatientsForCoordinators', secret: SECRET });
  const dana = feed.patients.find((p) => p.id === 'id-dana');
  assert.strictEqual(dana.dischargeDate, TODAY);
  assert.strictEqual(dana.active, false);
});

test('discharge: the standard discharged-audit row, with the appended coordinator audit columns', () => {
  const g = load();
  discharge(g);
  const rows = g.sheetRows(DISCHARGED, 'DISCHARGED_PATIENT_COLUMNS');
  assert.strictEqual(rows.length, 1);
  const a = rows[0];
  assert.strictEqual(a.id, 'coord-id-dana-' + TODAY, 'deterministic id');
  assert.strictEqual(a.houseId, 'ramot');
  assert.strictEqual(a.name, 'דנה כהן');
  assert.strictEqual(a.date, '2026-09-01', 'the heal key (houseId+name+date) matches the patient');
  assert.strictEqual(a.status, 'released');
  assert.strictEqual(a.exitDate, TODAY);
  assert.strictEqual(a.prior_status, 'active');
  assert.strictEqual(a.restored, '');
  assert.strictEqual(a.fromLead, 'L1', 'the discharge-loop guard sees the lead');
  assert.strictEqual(a.discharge_note, 'סיים טיפול');
  assert.strictEqual(a.dischargeSource, 'ezone-coordinators');
  assert.strictEqual(a.dischargedBy, 'רכזת רמות');
  assert.strictEqual(a.dischargeReason, 'סיים טיפול');
  assert.strictEqual(a.patientId, 'id-dana');
  assert.ok(a.dischargedAt);
});

test('discharge is IDEMPOTENT: a replay writes nothing and answers alreadyDischarged', () => {
  const g = load();
  assert.strictEqual(discharge(g).discharged, true);
  const before = snapshot(g);
  const again = discharge(g);
  assert.deepStrictEqual(again, { ok: true, discharged: false, alreadyDischarged: true, id: 'id-dana', dischargeDate: TODAY });
  assert.strictEqual(snapshot(g), before, 'zero writes on replay');
  assert.strictEqual(g.sheetRows(DISCHARGED, 'DISCHARGED_PATIENT_COLUMNS').length, 1);
});

test('discharge: a retry after an interrupted write completes it on the SAME audit row', () => {
  const g = load();
  discharge(g);
  // Simulate the Patients write having died after the audit row landed.
  const cols = Array.from(g.run('PATIENT_COLUMNS'));
  const row = g.sandbox.__sheets[PATIENTS].grid.find((r) => r[cols.indexOf('id')] === 'id-dana');
  row[cols.indexOf('status')] = 'active';
  assert.strictEqual(discharge(g).discharged, true);
  assert.strictEqual(patientCell(g, 'id-dana', 'status'), 'released');
  assert.strictEqual(g.sheetRows(DISCHARGED, 'DISCHARGED_PATIENT_COLUMNS').length, 1, 'still one audit row');
});

test('discharge: an already-released patient with a DIFFERENT date is refused, nothing written', () => {
  const g = load();
  const before = snapshot(g);
  const res = discharge(g, { id: 'id-michal', dischargeDate: TODAY });
  assert.deepStrictEqual(res, { ok: false, error: 'already_discharged', id: 'id-michal', dischargeDate: isoDaysAgo(5) });
  assert.strictEqual(snapshot(g), before);
});

test('discharge: validation — every bad input refused before the lock, nothing written', () => {
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const cases = [
    [{ id: '' }, 'invalid_id'],
    [{ id: 'x'.repeat(101) }, 'invalid_id'],
    [{ id: 'id-\u0000dana' }, 'invalid_id'],
    [{ dischargeDate: '' }, 'invalid_discharge_date'],
    [{ dischargeDate: '04/10/2026' }, 'invalid_discharge_date'],
    [{ dischargeDate: '2026-02-30' }, 'invalid_discharge_date'],
    [{ dischargeDate: '2026-09-01T00:00:00Z' }, 'invalid_discharge_date'],
    [{ dischargeDate: tomorrow }, 'discharge_date_in_future'],
    [{ by: '' }, 'missing_by'],
    [{ by: '  <>  ' }, 'missing_by'],
    [{ id: 'id-nobody' }, 'patient_not_found'],
    [{ id: 'id-sde' }, 'patient_not_found'], // a house the feed never shows
    [{ dischargeDate: '2026-08-01' }, 'discharge_before_admission'],
  ];
  for (const [extra, error] of cases) {
    const g = load();
    const before = snapshot(g);
    assert.strictEqual(discharge(g, extra).error, error, JSON.stringify(extra));
    assert.strictEqual(snapshot(g), before, 'nothing written for ' + error);
  }
});

test('discharge: free text is cleaned — formula lead-in stripped, control chars flattened, capped', () => {
  const g = load();
  discharge(g, { reason: '=HYPERLINK("x")\nשורה', by: '+רכזת<script>' });
  const a = g.sheetRows(DISCHARGED, 'DISCHARGED_PATIENT_COLUMNS')[0];
  assert.strictEqual(a.dischargeReason, 'HYPERLINK("x") שורה');
  assert.strictEqual(a.dischargedBy, 'רכזתscript');
  const g2 = load();
  discharge(g2, { reason: 'א'.repeat(900), by: 'ב'.repeat(200) });
  const b = g2.sheetRows(DISCHARGED, 'DISCHARGED_PATIENT_COLUMNS')[0];
  assert.strictEqual(b.dischargeReason.length, 500);
  assert.strictEqual(b.dischargedBy.length, 60);
  assert.ok(String(patientCell(g2, 'id-dana', 'updatedBy')).length <= 40, 'updatedBy stays within its cap');
});

test('discharge: a busy script lock refuses cleanly (lock_busy) and writes nothing', () => {
  const g = load();
  g.post({ action: 'getPatientsForCoordinators', secret: SECRET }); // ensure sheets exist first
  const before = snapshot(g);
  g.sandbox.LockService = { getScriptLock: () => ({ tryLock: () => false, releaseLock: () => {} }) };
  assert.strictEqual(discharge(g).error, 'lock_busy');
  assert.strictEqual(snapshot(g), before);
  assert.match(GS_SRC.slice(GS_SRC.indexOf('function recordDischargeFromCoordinators_')), /LockService\.getScriptLock\(\)/);
});

test('discharge: takes effect IMMEDIATELY — the feed, occupancy (Managers patientsNow) and admitted roster all drop the patient', () => {
  const g = load({ props: { ADMITTED_ROSTER_SECRET: 'r' } });
  const ym = TODAY.slice(0, 7);
  const ramotNow = () => g.sandbox.managersOverview_(ym).houses.find((h) => h.key === 'ramot').patientsNow;
  const nowBefore = ramotNow();
  assert.ok(g.sandbox.getAdmittedRoster_().patients.some((p) => p.name === 'דנה כהן'));
  discharge(g, { dischargeDate: isoDaysAgo(1) });
  const feed = g.post({ action: 'getPatientsForCoordinators', secret: SECRET }).patients.find((p) => p.id === 'id-dana');
  assert.deepStrictEqual([feed.active, feed.dischargeDate], [false, isoDaysAgo(1)]);
  assert.ok(!g.sandbox.getAdmittedRoster_().patients.some((p) => p.name === 'דנה כהן'));
  if (isoDaysAgo(1).slice(0, 7) === ym) assert.strictEqual(ramotNow(), nowBefore - 1, 'occupancy updated');
});

test('a STALE Dashboard tab cannot silently re-activate a coordinator discharge (stamp conflict refusal)', () => {
  const g = load();
  // The tab loaded dana BEFORE the coordinator discharge (old updatedAt).
  const stale = { houseId: 'ramot', name: 'דנה כהן', date: '2026-09-01', pay: 29000, adv: 0, status: 'active',
    fromLead: 'L1', exitDate: '', source: 'direct_admin', notes: 'פרטי', id: 'id-dana',
    updatedAt: '2026-09-01T08:00:00.000Z', updatedBy: 'ורד' };
  discharge(g);
  const res = arr(g.sandbox.saveAll_([], { ramot: [stale] }, 'ורד'));
  assert.ok(Array.isArray(res.conflicts) && res.conflicts.some((c) => c.id === 'id-dana'), JSON.stringify(res.conflicts));
  assert.strictEqual(patientCell(g, 'id-dana', 'status'), 'released', 'the discharge survives');
});

test('dispatch: the digest refresh runs after a real discharge only (fail-soft)', () => {
  const src = GS_SRC.slice(GS_SRC.indexOf("action === 'getPatientsForCoordinators' ||"), GS_SRC.indexOf("if (action === 'saveAll')"));
  assert.match(src, /coordinatorsPatientsAuthOk_\(params\)/);
  assert.match(src, /res\.discharged\) refreshDigestBestEffort_\(\)/);
});
