'use strict';

/* B0 — coordinators' discharge write → own house only
 * (CHANGELOG-coordinators-discharge-own-house.md, SPEC D12 / D13).
 *
 * The REAL Code.gs in a vm with in-memory sheets. Every call from the
 * coordinators app carries `actor` + `house` (ezone-coordinators #337). The
 * write is refused outside the caller's verified house; the two read feeds
 * keep serving. Names are SYNTHETIC. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { GS_SRC, richSheet, loadGs } = require('./helpers/gs-sandbox');

const SECRET = 'coord-secret-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
const PATIENTS = 'Patients';
const TODAY = new Date().toISOString().slice(0, 10);

function patientRow(o) {
  return [o.houseId, o.name, o.date || '2026-09-01', 29000, 0, o.status || 'active',
    '', o.exitDate || '', 'direct_admin', '', o.id, '', ''];
}
const FIXTURE = [
  { houseId: 'ramot', name: 'דנה כהן', id: 'id-dana' },
  { houseId: 'asher', name: 'יוסי לוי', id: 'id-yossi' },
  { houseId: 'pardes', name: 'נועה', id: 'id-noa' },
  { houseId: 'arfoni', name: 'מיכל', id: 'id-michal' },
  { houseId: 'rehab', name: 'אבי', id: 'id-avi' },
];

function load() {
  const g = loadGs({ props: { COORDINATORS_PATIENTS_SECRET: SECRET } });
  const cols = Array.from(g.run('PATIENT_COLUMNS'));
  const sh = richSheet(PATIENTS, cols);
  FIXTURE.forEach((r) => sh.grid.push(patientRow(r)));
  g.sandbox.__sheets[PATIENTS] = sh;
  g.sandbox.Session = { getScriptTimeZone: () => 'Asia/Jerusalem' };
  return g;
}
const snapshot = (g) => JSON.stringify(Object.keys(g.sandbox.__sheets).sort()
  .filter((n) => n !== 'SecurityLog' && n !== 'AuditLog')
  .map((n) => [n, g.sandbox.__sheets[n].grid]));
const audit = (g) => g.sheetRows('AuditLog', 'AUDIT_LOG_COLUMNS');
const discharge = (g, extra) => g.post(Object.assign({ action: 'recordDischargeFromCoordinators', secret: SECRET,
  id: 'id-dana', dischargeDate: TODAY, by: 'רכזת' }, extra || {}));
const status = (g, id) => {
  const cols = Array.from(g.run('PATIENT_COLUMNS'));
  return g.sandbox.__sheets[PATIENTS].grid.find((r) => r[cols.indexOf('id')] === id)[cols.indexOf('status')];
};

/* ===== allowed ===== */

test('own house: a code login (rakaz:<house>) discharges a patient of that house', () => {
  const g = load();
  const r = discharge(g, { actor: 'rakaz:ramot', house: 'ramot' });
  assert.deepEqual(r, { ok: true, discharged: true, id: 'id-dana', dischargeDate: TODAY });
  assert.equal(status(g, 'id-dana'), 'released');
  const row = audit(g).find((a) => a.action === 'patient_discharged_by_coordinators');
  assert.match(row.details, /"actor":"rakaz:ramot"/, 'the success audit carries the actor');
});

test('own house: a personal login (user:<id>) discharges in its session house; the alias hapardes resolves to pardes', () => {
  const g = load();
  const r = discharge(g, { id: 'id-noa', actor: 'user:u-17', house: 'hapardes' });
  assert.equal(r.discharged, true);
  assert.equal(status(g, 'id-noa'), 'released');
});

test('admin with house * reaches every house', () => {
  const g = load();
  assert.equal(discharge(g, { id: 'id-avi', actor: 'admin', house: '*' }).discharged, true);
  assert.equal(discharge(g, { id: 'id-michal', actor: 'admin', house: '*' }).discharged, true);
  // a personal login in an admin session is also marked '*' by the coordinators server
  assert.equal(discharge(g, { id: 'id-yossi', actor: 'user:u-admin', house: '*' }).discharged, true);
});

/* ===== refused — nothing written, audited ===== */

function refused(g, extra, error) {
  const before = snapshot(g);
  const r = discharge(g, extra);
  assert.equal(r.ok, false, JSON.stringify(extra));
  assert.equal(r.error, error, JSON.stringify(extra));
  assert.match(r.message, /דבר לא נשמר/, 'Hebrew message');
  assert.equal(snapshot(g), before, 'nothing written for ' + JSON.stringify(extra));
  const rows = audit(g).filter((a) => a.action === 'coord_discharge_refused');
  assert.ok(rows.length >= 1, 'audited');
  const last = rows[rows.length - 1];
  assert.match(last.details, new RegExp('"error":"' + error + '"'));
  assert.doesNotMatch(last.details + last.name, /דנה|יוסי|נועה|מיכל|אבי/, 'ids only, no names in the refusal audit');
  return r;
}

test('other house → forbidden_house, nothing written, audited', () => {
  const g = load();
  refused(g, { actor: 'rakaz:ramot', house: 'ramot', id: 'id-yossi' }, 'forbidden_house');
  refused(g, { actor: 'user:u-17', house: 'rehab', id: 'id-dana' }, 'forbidden_house');
  assert.equal(status(g, 'id-yossi'), 'active');
  assert.equal(status(g, 'id-dana'), 'active');
});

test('missing or malformed pair → refused before the lock', () => {
  const g = load();
  refused(g, {}, 'actor_not_allowed');
  refused(g, { actor: 'rakaz:ramot' }, 'forbidden_house');
  refused(g, { house: 'ramot' }, 'actor_not_allowed');
  refused(g, { actor: 'rakaz:ramot', house: 'nowhere' }, 'forbidden_house');
  refused(g, { actor: 'someone', house: 'ramot' }, 'actor_not_allowed');
  refused(g, { actor: '=HYPERLINK("x")', house: 'ramot' }, 'actor_not_allowed');
});

test('system:* never discharges; * from a code login is refused', () => {
  const g = load();
  refused(g, { actor: 'system:patientListSync', house: '*' }, 'actor_not_allowed');
  refused(g, { actor: 'system:committeeImport', house: 'ramot' }, 'actor_not_allowed');
  refused(g, { actor: 'rakaz:ramot', house: '*' }, 'forbidden_house');
});

test('the house compare happens before the idempotency branch: a released patient of another house is still forbidden', () => {
  const g = load();
  discharge(g, { id: 'id-avi', actor: 'rakaz:rehab', house: 'rehab' });
  refused(g, { id: 'id-avi', actor: 'rakaz:ramot', house: 'ramot' }, 'forbidden_house');
  // the same house replays idempotently as before
  const again = discharge(g, { id: 'id-avi', actor: 'rakaz:rehab', house: 'rehab' });
  assert.equal(again.alreadyDischarged, true);
});

/* ===== the feeds are untouched ===== */

test('the two read feeds accept system:* + * (and any pair) — behaviour unchanged', () => {
  const g = load();
  const feed = g.post({ action: 'getPatientsForCoordinators', secret: SECRET, actor: 'system:patientListSync', house: '*' });
  assert.equal(feed.ok, true);
  assert.ok(feed.patients.length === FIXTURE.length);
  const bare = g.post({ action: 'getPatientsForCoordinators', secret: SECRET });
  assert.deepEqual(bare, feed, 'the pair changes nothing on a read');
});

/* ===== source guards ===== */

test('guard: only recordDischargeFromCoordinators_ reads the B0 pair; the house never comes from another field', () => {
  const uses = GS_SRC.match(/coordActorInput_\(/g) || [];
  assert.equal(uses.length, 2, 'declared once, called once (the write)');
  const fn = GS_SRC.slice(GS_SRC.indexOf('function recordDischargeFromCoordinators_'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /coordDischargeActorRefusal_\(who\)/);
  assert.match(body, /canonicalDigestHouse_\(patient\.houseId\) !== who\.house/);
  assert.doesNotMatch(body, /params\.(houseId|coordHouse|h)\b/, 'no other house field is honoured');
  const refusal = GS_SRC.slice(GS_SRC.indexOf('function coordRefuse_'), GS_SRC.indexOf('function coordinatorsPatientsAuthOk_'));
  assert.doesNotMatch(refusal, /name|phone/, 'the refusal audit carries ids only');
});
