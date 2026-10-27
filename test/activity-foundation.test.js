'use strict';

/* B1 — Activity sheet + writer, NOT wired (CHANGELOG-crm-activity-foundation.md,
 * docs/crm/ROLLOUT.md §B1).
 *
 * The REAL Code.gs in a vm with in-memory sheets. Pins the append-only header,
 * the pure validator, the locked idempotent writer, and that NOTHING calls it
 * yet (no action, no writer, no getData change). */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { GS_SRC, loadGs } = require('./helpers/gs-sandbox');

const COLUMNS = ['eventId', 'occurredAt', 'recordedAt', 'kind', 'source', 'actorId', 'actorName',
  'leadId', 'patientId', 'personId', 'paymentUid', 'dischargeId', 'houseId', 'summary', 'detailsJson',
  'supersedesEventId'];

const EVENT = () => ({ eventId: 'discharge:id-dana', occurredAt: '2026-10-27T10:00:00.000Z', kind: 'patient_discharged',
  source: 'system:recordDischargeFromCoordinators_', actorId: 'rakaz:ramot', actorName: 'רכזת רמות',
  patientId: 'id-dana', houseId: 'ramot', summary: 'שוחרר/ה מהבית', details: { dischargeDate: '2026-10-27' } });

function load() {
  const g = loadGs({});
  g.sandbox.Session = { getScriptTimeZone: () => 'Asia/Jerusalem' };
  return g;
}
const rows = (g) => g.sheetRows('Activity', 'ACTIVITY_COLUMNS');
const append = (g, ev) => JSON.parse(JSON.stringify(g.sandbox.appendActivity_(ev)));

/* ===== header contract ===== */

test('Activity column order is PINNED — append-only; a new column goes at the END', () => {
  const g = load();
  assert.deepEqual(Array.from(g.run('ACTIVITY_COLUMNS')), COLUMNS);
  assert.equal(g.run('ACTIVITY_SHEET'), 'Activity');
  const text = Array.from(g.run('ACTIVITY_TEXT_COLUMNS'));
  for (const c of text) assert.ok(COLUMNS.includes(c), c + ' is a real column');
  assert.ok(text.includes('eventId') && text.includes('occurredAt') && text.includes('recordedAt'));
});

test('the sheet is created with that header, frozen, ids + timestamps text-forced — and only when the writer runs', () => {
  const g = load();
  assert.equal(g.sandbox.__sheets.Activity, undefined, 'no sheet before any write');
  const r = append(g, EVENT());
  assert.equal(r.written, true);
  const sh = g.sandbox.__sheets.Activity;
  assert.deepEqual(sh.grid[0], COLUMNS);
  assert.equal(rows(g).length, 1);
});

/* ===== the writer ===== */

test('one event → one row with every column filled as given; recordedAt is the server clock, details is JSON', () => {
  const g = load();
  const before = Date.now();
  const r = append(g, EVENT());
  assert.equal(r.ok, true);
  assert.equal(r.eventId, 'discharge:id-dana');
  const row = rows(g)[0];
  assert.equal(row.eventId, 'discharge:id-dana');
  assert.equal(row.occurredAt, '2026-10-27T10:00:00.000Z');
  assert.ok(Date.parse(row.recordedAt) >= before - 1000, 'recordedAt = now');
  assert.equal(row.kind, 'patient_discharged');
  assert.equal(row.source, 'system:recordDischargeFromCoordinators_');
  assert.equal(row.actorId, 'rakaz:ramot');
  assert.equal(row.actorName, 'רכזת רמות');
  assert.equal(row.patientId, 'id-dana');
  assert.equal(row.houseId, 'ramot');
  assert.equal(row.leadId, '');
  assert.equal(row.summary, 'שוחרר/ה מהבית');
  assert.deepEqual(JSON.parse(row.detailsJson), { dischargeDate: '2026-10-27' });
  assert.equal(row.supersedesEventId, '');
});

test('IDEMPOTENT: the same eventId twice → one row, the second call reports duplicate and writes nothing', () => {
  const g = load();
  append(g, EVENT());
  const sh = g.sandbox.__sheets.Activity;
  const snap = JSON.stringify(sh.grid);
  const r2 = append(g, Object.assign(EVENT(), { summary: 'שונה' }));
  assert.deepEqual(r2, { ok: true, written: false, duplicate: true, eventId: 'discharge:id-dana' });
  assert.equal(JSON.stringify(sh.grid), snap, 'zero writes');
  assert.equal(rows(g).length, 1);
  append(g, Object.assign(EVENT(), { eventId: 'discharge:id-yossi' }));
  assert.equal(rows(g).length, 2, 'a different eventId appends');
});

test('occurredAt defaults to recordedAt; a malformed occurredAt is ignored, not refused', () => {
  const g = load();
  append(g, Object.assign(EVENT(), { occurredAt: '27/10/2026' }));
  const row = rows(g)[0];
  assert.equal(row.occurredAt, row.recordedAt);
});

test('validation — refused before the lock, nothing written: missing id, bad kind, bad source, bad details', () => {
  const cases = [
    [{ eventId: '' }, 'missing_event_id'],
    [{ eventId: '=HYPERLINK("x")' }, 'invalid_event_id'],
    [{ eventId: 'id with spaces' }, 'invalid_event_id'],
    [{ kind: 'Patient Discharged' }, 'invalid_kind'],
    [{ kind: '' }, 'invalid_kind'],
    [{ source: 'vered' }, 'invalid_source'],
    [{ source: 'system:' }, 'invalid_source'],
    [{ source: 'app:coordinators;drop' }, 'invalid_source'],
    [{ details: 'free text' }, 'invalid_details'],
    [{ details: [1, 2] }, 'invalid_details'],
    [{ details: { blob: 'x'.repeat(4001) } }, 'details_too_long'],
  ];
  for (const [extra, error] of cases) {
    const g = load();
    const r = append(g, Object.assign(EVENT(), extra));
    assert.equal(r.ok, false, JSON.stringify(extra));
    assert.equal(r.error, error, JSON.stringify(extra));
    assert.equal(g.sandbox.__sheets.Activity, undefined, 'no sheet, nothing written for ' + error);
  }
});

test('source accepts exactly manual / system:<fn> / app:<sibling>', () => {
  for (const s of ['manual', 'system:dischargePatient_', 'app:coordinators', 'app:outpatient']) {
    const g = load();
    assert.equal(append(g, Object.assign(EVENT(), { source: s })).ok, true, s);
  }
});

test('text hygiene: control chars flattened, formula lead-in stripped, angle brackets removed, caps applied', () => {
  const g = load();
  append(g, Object.assign(EVENT(), { summary: '=SUM(1)\u0000<b>שלום</b>' + 'א'.repeat(300), actorName: '+רכזת' }));
  const row = rows(g)[0];
  assert.ok(!row.summary.startsWith('='));
  assert.ok(!/[<>\u0000]/.test(row.summary));
  assert.ok(row.summary.length <= 200);
  assert.equal(row.actorName, 'רכזת');
});

test('runs under the script lock; busy → lock_busy, nothing written', () => {
  const g = load();
  g.run("LockService.getScriptLock = function () { return { tryLock: function () { return false; }, releaseLock: function () {} }; };");
  const r = append(g, EVENT());
  assert.equal(r.error, 'lock_busy');
  assert.equal(g.sandbox.__sheets.Activity, undefined);
});

test('activityRow_ is PURE: validates and normalises without touching any sheet', () => {
  const g = load();
  const v = JSON.parse(JSON.stringify(g.sandbox.activityRow_(EVENT(), '2026-10-27T12:00:00.000Z')));
  assert.equal(v.ok, true);
  assert.equal(v.row.recordedAt, '2026-10-27T12:00:00.000Z');
  assert.deepEqual(Object.keys(v.row), COLUMNS, 'row keys = the columns, in order');
  assert.equal(g.sandbox.__sheets.Activity, undefined);
});

/* ===== NOT wired ===== */

test('NOT WIRED: no action dispatches to the Activity sheet, no writer calls appendActivity_, getData unchanged', () => {
  const g = load();
  const known = Array.from(g.run('PROXY_KNOWN_ACTIONS'));
  assert.ok(!known.some((a) => /activity/i.test(a)), 'no Activity action in the registry');
  const calls = GS_SRC.match(/appendActivity_\(/g) || [];
  assert.equal(calls.length, 1, 'declared once, called nowhere (B2 wires it behind ACTIVITY_WRITES)');
  assert.doesNotMatch(GS_SRC, /ACTIVITY_WRITES/, 'the B2 switch does not exist yet');
  const keysBefore = Object.keys(g.sandbox.__sheets).sort();
  const r = g.post({ action: 'getData' });
  assert.ok(!('activity' in (r || {})), 'getData does not expose activity');
  assert.ok(!Object.keys(g.sandbox.__sheets).includes('Activity'), 'a read never creates the sheet');
  assert.ok(keysBefore.every((k) => k in g.sandbox.__sheets));
});
