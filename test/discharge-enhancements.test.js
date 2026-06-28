/* Tests for the discharge enhancements in public/app.js (PR 2).
 *
 * Covers: the new released_outpatient disposition key→label mapping, that the
 * שחרור modal is offered all three discharge dispositions, and that the pure
 * dischargeAuditRow helper persists the chosen discharge date (→ exitDate) when
 * provided and falls back to today when empty — across all three dispositions.
 *
 * The modal itself is DOM-heavy and the harness has no jsdom, so "renders three
 * options" is asserted at the data level (DISCHARGE_DISPOSITIONS + label map),
 * and the date persistence is asserted on the extracted pure helper. No DOM shim.
 *
 * Same vm-sandbox approach as the other suites: read app.js, append an epilogue
 * that closes over the functions/constants under test, evaluate in a sandbox
 * with browser globals stubbed. Exercises the REAL shipped code. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadApp() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'app.js'),
    'utf8'
  );

  const epilogue = `
    globalThis.__test = {
      DISPOSITION_LABELS,
      dischargeDispositions() { return DISCHARGE_DISPOSITIONS; },
      dischargeAuditRow,
    };
  `;

  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/' },
    document: { addEventListener: noop, getElementById: () => null },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    URLSearchParams,
    Math, Date, JSON, Number, String, Array, Object, RegExp,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + epilogue, sandbox);
  return sandbox.__test;
}

const app = loadApp();

const PATIENT = {
  id: 'P1', houseId: 'arfoni', name: 'דנה כהן', date: '2026-01-10',
  pay: 30000, adv: 0, status: 'active',
};

/* ===== new disposition key → label ===== */

test('released_outpatient maps to its Hebrew label', () => {
  assert.strictEqual(app.DISPOSITION_LABELS.released_outpatient, 'משוחרר לטיפול חוץ');
});

test('the three original disposition labels are unchanged', () => {
  assert.strictEqual(app.DISPOSITION_LABELS.not_relevant,  'לא רלוונטי');
  assert.strictEqual(app.DISPOSITION_LABELS.completed,     'סיים טיפול');
  assert.strictEqual(app.DISPOSITION_LABELS.stopped_early, 'הפסיק לפני הזמן');
});

/* ===== modal is offered three discharge options (data level) ===== */

test('discharge offers exactly the three dispositions in order', () => {
  const keys = Array.from(app.dischargeDispositions());
  assert.deepStrictEqual(keys, ['completed', 'stopped_early', 'released_outpatient']);
});

test('every discharge disposition has a registered Hebrew label', () => {
  Array.from(app.dischargeDispositions()).forEach(key => {
    assert.ok(app.DISPOSITION_LABELS[key], `missing label for ${key}`);
  });
});

/* ===== discharge date persistence (pure helper) ===== */

test('a provided discharge date is persisted as exitDate', () => {
  const row = app.dischargeAuditRow(
    PATIENT,
    { disposition: 'completed', note: '', dischargeDate: '2026-07-15' },
    '2026-06-28'
  );
  assert.strictEqual(row.exitDate, '2026-07-15');
  assert.strictEqual(row.status, 'released');
  assert.strictEqual(row.disposition, 'completed');
});

test('an empty discharge date falls back to today', () => {
  const row = app.dischargeAuditRow(
    PATIENT,
    { disposition: 'stopped_early', note: 'הערה', dischargeDate: '' },
    '2026-06-28'
  );
  assert.strictEqual(row.exitDate, '2026-06-28');     // today fallback
  assert.strictEqual(row.disposition, 'stopped_early');
  assert.strictEqual(row.discharge_note, 'הערה');
});

test('date-present persistence works for all three dispositions', () => {
  Array.from(app.dischargeDispositions()).forEach(disposition => {
    const row = app.dischargeAuditRow(
      PATIENT,
      { disposition, note: '', dischargeDate: '2026-08-01' },
      '2026-06-28'
    );
    assert.strictEqual(row.exitDate, '2026-08-01');
    assert.strictEqual(row.disposition, disposition);
    assert.strictEqual(row.status, 'released');
  });
});

test('empty-date fallback works for all three dispositions', () => {
  Array.from(app.dischargeDispositions()).forEach(disposition => {
    const row = app.dischargeAuditRow(
      PATIENT,
      { disposition, note: '', dischargeDate: '' },
      '2026-06-28'
    );
    assert.strictEqual(row.exitDate, '2026-06-28');
    assert.strictEqual(row.disposition, disposition);
  });
});

test('the released_outpatient discharge records disposition + date only (no extra cross-app fields)', () => {
  const row = app.dischargeAuditRow(
    PATIENT,
    { disposition: 'released_outpatient', note: '', dischargeDate: '2026-09-03' },
    '2026-06-28'
  );
  assert.strictEqual(row.disposition, 'released_outpatient');
  assert.strictEqual(row.exitDate, '2026-09-03');
  // PR 2 must not introduce any Outpatient cross-app payload (that's PR 3).
  assert.strictEqual(row.outpatientLeadId, undefined);
  assert.strictEqual(row.outpatient, undefined);
});

test('the audit row preserves the original patient fields', () => {
  const row = app.dischargeAuditRow(
    PATIENT,
    { disposition: 'completed', note: '', dischargeDate: '2026-07-15' },
    '2026-06-28'
  );
  assert.strictEqual(row.id, 'P1');
  assert.strictEqual(row.houseId, 'arfoni');
  assert.strictEqual(row.name, 'דנה כהן');
  assert.strictEqual(row.pay, 30000);
});
