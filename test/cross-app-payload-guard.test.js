'use strict';

/* Guard (2026-10-04, coordinators roster PR — CHANGELOG-coordinators-roster.md).
 *
 * This one Apps Script also serves the Managers app (managersOverview,
 * managersHouse, occupancySnapshots) and the Therapists/Outpatient apps
 * (getAdmittedRoster). The coordinators roster adds a feed and a discharge
 * write next to them; these tests pin what those consumers receive so that
 * no change here (or later) silently alters their payloads, and pin the
 * sheet headers the new code reads and writes by POSITION.
 *
 *   - the Patients header is APPEND-ONLY: pinned in full, exact order
 *   - the discharged-audit header: legacy layout + stamps + the four
 *     coordinators audit columns appended LAST
 *   - Managers / Therapists response key sets pinned exactly
 *
 * A legitimate future change to one of these payloads must update this file
 * on purpose — that is the point. */

const { test } = require('node:test');
const assert = require('node:assert');
const { richSheet, loadGs } = require('./helpers/gs-sandbox');

const arr = (x) => JSON.parse(JSON.stringify(x));

function load() {
  const g = loadGs({});
  g.sandbox.Session = { getScriptTimeZone: () => 'Asia/Jerusalem' };
  const cols = Array.from(g.run('PATIENT_COLUMNS'));
  const sh = richSheet('Patients', cols);
  sh.grid.push(['ramot', 'דנה', '2026-09-01', 29000, 0, 'active', 'L1', '', 'lead', 'note', 'id-d', '', '']);
  sh.grid.push(['asher', 'יוסי', '2026-08-01', 29000, 0, 'released', '', '2026-09-10', 'direct_admin', '', 'id-y', '', '']);
  g.sandbox.__sheets.Patients = sh;
  return g;
}

/* ===== headers (append-only) ===== */

test('Patients header: pinned in full — append-only, never reordered or removed', () => {
  const g = load();
  assert.deepStrictEqual(Array.from(g.run('PATIENT_COLUMNS')), [
    'houseId', 'name', 'date', 'pay', 'adv',
    'status', 'fromLead', 'exitDate', 'source', 'notes',
    'id', 'updatedAt', 'updatedBy',
  ]);
});

test('discharged-audit header: legacy layout byte-identical; stamps; coordinators audit columns appended LAST', () => {
  const g = load();
  assert.deepStrictEqual(Array.from(g.run('DISCHARGED_PATIENT_COLUMNS')), [
    'id',
    'houseId', 'name', 'date', 'pay', 'adv',
    'status', 'fromLead', 'exitDate', 'source', 'notes',
    'dischargedAt', 'disposition', 'discharge_note', 'restored', 'prior_status',
    'updatedAt', 'updatedBy',
    'dischargeSource', 'dischargedBy', 'dischargeReason', 'patientId',
    // Duplicate-discharge soft delete (CHANGELOG-duplicate-discharges.md), appended LAST.
    'deletedAt', 'deletedBy', 'deleteReason',
  ]);
});

test('a live discharged sheet with the OLD 18-column header gets the 4 new headers appended, existing cells untouched', () => {
  const g = load();
  const old = Array.from(g.run('DISCHARGED_PATIENT_COLUMNS')).slice(0, 18);
  const sh = richSheet('מטופלים משוחררים', old);
  const legacyRow = ['d1', 'ramot', 'x', '2026-01-01', 1, 0, 'released', '', '2026-02-01', '', '', 't', 'completed', 'n', '', 'active', 't', 'ורד'];
  sh.grid.push(legacyRow.slice());
  g.sandbox.__sheets['מטופלים משוחררים'] = sh;
  g.run("getOrCreateSheet_(DISCHARGED_PATIENTS_SHEET, DISCHARGED_PATIENT_COLUMNS)");
  assert.deepStrictEqual(sh.grid[0].slice(0, 18), old, 'existing headers untouched');
  assert.deepStrictEqual(sh.grid[0].slice(18), ['dischargeSource', 'dischargedBy', 'dischargeReason', 'patientId',
    'deletedAt', 'deletedBy', 'deleteReason']);
  assert.deepStrictEqual(sh.grid[1].slice(0, 18), legacyRow, 'existing row untouched');
});

test('the occupancy snapshot header is unchanged', () => {
  const g = load();
  assert.deepStrictEqual(Array.from(g.run('OCCUPANCY_SNAPSHOT_COLUMNS')),
    ['month', 'houseId', 'treatmentDays', 'daysInMonth', 'avgDaily', 'capacity', 'occupancyPct', 'manager', 'capturedAt']);
});

/* ===== Managers payloads ===== */

const BONUS_KEYS = ['qualifies', 'bep', 'avgDaily', 'aboveBepDays', 'base', 'daily', 'dailyRate', 'quarterly',
  'quarterlyEligible', 'consecutiveAboveBep', 'continuity', 'total'];
const CONTINUITY_KEYS = ['maintenance', 'day_2x', 'day_daily', 'total', 'rates'];

test('Managers: managersOverview payload keys are pinned', () => {
  const o = arr(load().sandbox.managersOverview_('2026-09'));
  assert.deepStrictEqual(Object.keys(o), ['ok', 'month', 'totals', 'houses']);
  assert.deepStrictEqual(Object.keys(o.totals), ['activePatients', 'networkCapacity', 'totalTreatmentDays', 'totalBonus']);
  assert.ok(o.houses.length > 0);
  for (const h of o.houses) {
    assert.deepStrictEqual(Object.keys(h), ['key', 'name', 'manager', 'type', 'bep', 'capacity', 'patientsNow',
      'avgDaily', 'treatmentDays', 'entriesMonth', 'exitsMonth', 'qualifies', 'bonus']);
    assert.deepStrictEqual(Object.keys(h.bonus), BONUS_KEYS);
    assert.deepStrictEqual(Object.keys(h.bonus.continuity), CONTINUITY_KEYS);
  }
});

test('Managers: managersHouse payload keys are pinned', () => {
  const h = arr(load().sandbox.managersHouse_('ramot', '2026-09'));
  assert.deepStrictEqual(Object.keys(h), ['ok', 'month', 'key', 'name', 'manager', 'type', 'bep', 'capacity',
    'bonusBase', 'bonusPerDay', 'patientsNow', 'avgDaily', 'treatmentDays', 'entriesMonth', 'exitsMonth',
    'dailyChart', 'activity', 'bonus']);
  assert.deepStrictEqual(Object.keys(h.bonus), BONUS_KEYS);
  assert.deepStrictEqual(Object.keys(h.dailyChart[0]), ['date', 'count']);
  assert.deepStrictEqual(Object.keys(h.activity[0]), ['date', 'kind', 'name']);
});

test('Managers: occupancySnapshots payload keys are pinned', () => {
  assert.deepStrictEqual(Object.keys(arr(load().sandbox.occupancySnapshots_())), ['ok', 'rows']);
});

/* ===== Therapists / Outpatient payload ===== */

test('Therapists: getAdmittedRoster payload keys are pinned (and released patients stay out)', () => {
  const r = arr(load().sandbox.getAdmittedRoster_());
  assert.deepStrictEqual(Object.keys(r), ['ok', 'patients']);
  assert.strictEqual(r.patients.length, 1);
  assert.deepStrictEqual(Object.keys(r.patients[0]), ['sourceApp', 'name', 'phone', 'house', 'entryDate']);
});

/* ===== Dashboard's own bulk read: additive only ===== */

test('getData top-level keys are unchanged (the new audit columns ride inside dischargedPatients rows)', () => {
  const d = arr(load().sandbox.getData_());
  assert.deepStrictEqual(Object.keys(d), ['ok', 'leads', 'patients', 'irrelevantLeads', 'removedLeads',
    'dischargedPatients', 'billingOverrides', 'houseManagers', 'managerPhones', 'currentManagers', 'currentManagersSource']);
});
