/* Tests for the מטופלים משוחררים (discharged patients) tab search:
 *   - dischargedPatientMatchesQuery — the pure matcher over an audit row:
 *     name + house label by lowercased substring, phone by raw substring OR
 *     normalized-digit substring (normalizePhone);
 *   - dischargedHouseLabel — the house-label resolver injected into the
 *     matcher ('' fallback so the '—' placeholder never matches a query).
 *
 * Same vm-sandbox approach as retention-search.test.js: app.js is a
 * browser-global script, so we read the source, append an epilogue exposing
 * the pure functions, and evaluate it in a vm context with browser globals
 * stubbed. No changes to app.js are needed for testability. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadApp() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const epilogue = `
    globalThis.__test = {
      dischargedPatientMatchesQuery,
      dischargedHouseLabel,
      normalizePhone,
    };
  `;
  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/' },
    document: { addEventListener: noop, getElementById: () => null },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    URLSearchParams, Math, Date, JSON, Number, String, Array, Object, RegExp, Promise,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + epilogue, sandbox);
  return sandbox.__test;
}

const app = loadApp();

// A discharged audit row as normalizeDischargedPatient produces it (the fields
// the search touches). The input handler lowercases+trims the query, so tests
// pass queries the same way the live call site does.
function discharged(over) {
  return Object.assign(
    { id: 'x', name: '', phone: '', houseId: '', restored: '' },
    over || {}
  );
}

// The matcher receives the house label pre-resolved (as renderDischargedPatients
// injects it via dischargedHouseLabel).
function matches(row, q) {
  return app.dischargedPatientMatchesQuery(row, q, app.dischargedHouseLabel(row));
}

/* ===== empty query ===== */

test('empty query matches everything', () => {
  assert.strictEqual(matches(discharged({}), ''), true);
  assert.strictEqual(matches(discharged({ name: 'דוד' }), ''), true);
  assert.strictEqual(app.dischargedPatientMatchesQuery(discharged({}), null, ''), true);
});

/* ===== name match ===== */

test('name matches by substring, case-insensitive', () => {
  assert.strictEqual(matches(discharged({ name: 'דניאל כהן' }), 'דני'), true);
  assert.strictEqual(matches(discharged({ name: 'דניאל כהן' }), 'כהן'), true);
  assert.strictEqual(matches(discharged({ name: 'David Levi' }), 'david'), true);
  assert.strictEqual(matches(discharged({ name: 'David Levi' }), 'LEVI'.toLowerCase()), true);
});

/* ===== phone match (via normalizePhone) ===== */

test('phone matches raw as-displayed substring', () => {
  assert.strictEqual(matches(discharged({ phone: '050-111-2222' }), '050-111'), true);
});

test('phone matches across formatting via normalizePhone', () => {
  // stored with dashes, searched without
  assert.strictEqual(matches(discharged({ phone: '050-111-2222' }), '0501112222'), true);
  // stored plain, searched in international format
  assert.strictEqual(matches(discharged({ phone: '0501112222' }), '+972-50-111-2222'), true);
  // partial digit run still hits regardless of separators
  assert.strictEqual(matches(discharged({ phone: '050 111 2222' }), '50111'), true);
});

test('a different phone does not match', () => {
  assert.strictEqual(matches(discharged({ phone: '050-111-2222' }), '0539999999'), false);
});

/* ===== house match ===== */

test('house matches by the displayed house name (resolved from houseId)', () => {
  const row = discharged({ houseId: 'arfoni' });           // displays as 'קיסריה עפרוני'
  assert.strictEqual(app.dischargedHouseLabel(row), 'קיסריה עפרוני');
  assert.strictEqual(matches(row, 'עפרוני'), true);
  assert.strictEqual(matches(row, 'קיסריה'), true);
});

test('unknown houseId falls back to the raw id for matching', () => {
  const row = discharged({ houseId: 'old-house-7' });
  assert.strictEqual(app.dischargedHouseLabel(row), 'old-house-7');
  assert.strictEqual(matches(row, 'old-house'), true);
});

test('missing house yields empty label — the "—" placeholder never matches', () => {
  const row = discharged({ houseId: '' });
  assert.strictEqual(app.dischargedHouseLabel(row), '');
  assert.strictEqual(matches(row, '—'), false);
});

/* ===== no match ===== */

test('no field matches → false', () => {
  const row = discharged({ name: 'דוד', phone: '050-111-2222', houseId: 'arfoni' });
  assert.strictEqual(matches(row, 'זזזזז'), false);
  assert.strictEqual(matches(row, '0399999'), false);
});

test('nullish row never throws; empty query still matches it', () => {
  assert.strictEqual(app.dischargedPatientMatchesQuery(null, '', ''), true);
  assert.strictEqual(app.dischargedPatientMatchesQuery(null, 'x', ''), false);
});
