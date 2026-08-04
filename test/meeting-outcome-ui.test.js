/* Tests for the meetingOutcome UI feature (public/app.js):
 *   - computeManagerConversion — the pure per-manager conversion metric
 *     (held/converted/total math, zero-held guard, multi-manager, leads without
 *     outcomes ignored, leads without meetingWith grouped under a placeholder);
 *   - meetingOutcomeEligible — the pure date predicate deciding which rows get
 *     an outcome <select> (today-or-earlier yes, future no), on LOCAL bare
 *     YYYY-MM-DD strings (never UTC);
 *   - admissionMeetingOutcome — the entry/admission rule (sets 'entered' when
 *     the lead had a meeting / visitDate; nothing when it did not).
 *
 * Same vm-sandbox approach as meetings-board.test.js: app.js is a browser-global
 * script, so we read the source, append an epilogue exposing the pure functions,
 * and evaluate it in a vm context with browser globals stubbed. No changes to
 * app.js are needed for testability. Pin TZ so the date predicate is
 * deterministic regardless of the host timezone. */

process.env.TZ = 'Asia/Jerusalem';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadApp() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const epilogue = `
    globalThis.__test = {
      computeManagerConversion,
      meetingOutcomeEligible,
      admissionMeetingOutcome,
      MEETING_OUTCOME_LABELS,
      MANAGER_CONVERSION_UNASSIGNED,
    };
  `;
  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/' },
    document: { addEventListener: noop, getElementById: () => null },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    URLSearchParams, Math, Date, JSON, Number, String, Array, Object, RegExp,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + epilogue, sandbox);
  return sandbox.__test;
}

const app = loadApp();
// Copy vm-realm arrays into the test realm before deepStrictEqual (cross-realm
// Array.prototype otherwise trips the comparison — see meetings-board.test.js).
const arr = x => Array.from(x);

function lead(over) {
  return Object.assign(
    { id: 'x', name: 'ליד', meetingWith: '', visitDate: '', meetingOutcome: '' },
    over || {}
  );
}

/* ===== computeManagerConversion ===== */

test('computeManagerConversion: held/converted/total math for one manager', () => {
  // חנן: not_relevant + thinking + entered are "held"; entered is "converted";
  // postponed is an outcome (counts in total) but NOT held. 1 entered / 3 held = 33%.
  const rows = arr(app.computeManagerConversion([
    lead({ meetingWith: 'חנן', meetingOutcome: 'not_relevant' }),
    lead({ meetingWith: 'חנן', meetingOutcome: 'thinking' }),
    lead({ meetingWith: 'חנן', meetingOutcome: 'entered' }),
    lead({ meetingWith: 'חנן', meetingOutcome: 'postponed' }),
  ]));
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].manager, 'חנן');
  assert.strictEqual(rows[0].total, 4);
  assert.strictEqual(rows[0].held, 3);
  assert.strictEqual(rows[0].converted, 1);
  assert.strictEqual(rows[0].rate, 33);   // round(1/3*100)
});

test('computeManagerConversion: zero-held guard yields 0% (no division by zero)', () => {
  // Only "not held" outcomes → held 0, converted 0, rate 0 (never NaN/Infinity).
  const rows = arr(app.computeManagerConversion([
    lead({ meetingWith: 'עידו', meetingOutcome: 'postponed' }),
    lead({ meetingWith: 'עידו', meetingOutcome: 'cancelled' }),
  ]));
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].held, 0);
  assert.strictEqual(rows[0].converted, 0);
  assert.strictEqual(rows[0].rate, 0);
  assert.ok(Number.isFinite(rows[0].rate), 'rate must be a finite number');
});

test('computeManagerConversion: multiple managers, sorted by held desc then name', () => {
  const rows = arr(app.computeManagerConversion([
    // אורן: 1 held, 1 converted
    lead({ meetingWith: 'אורן', meetingOutcome: 'entered' }),
    // חנן: 2 held, 1 converted
    lead({ meetingWith: 'חנן', meetingOutcome: 'entered' }),
    lead({ meetingWith: 'חנן', meetingOutcome: 'thinking' }),
  ]));
  assert.deepStrictEqual(rows.map(r => r.manager), ['חנן', 'אורן']);   // 2 held before 1 held
  assert.strictEqual(rows[0].converted, 1);
  assert.strictEqual(rows[0].held, 2);
  assert.strictEqual(rows[0].rate, 50);
  assert.strictEqual(rows[1].rate, 100);
});

test('computeManagerConversion: leads without an outcome are ignored', () => {
  const rows = arr(app.computeManagerConversion([
    lead({ meetingWith: 'חנן', meetingOutcome: '' }),        // blank → ignored
    lead({ meetingWith: 'חנן' }),                            // no meetingOutcome key at all
    lead({ meetingWith: 'חנן', meetingOutcome: 'bogus' }),   // invalid key → ignored
    lead({ meetingWith: 'חנן', meetingOutcome: 'entered' }), // the only one that counts
  ]));
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].total, 1);
  assert.strictEqual(rows[0].converted, 1);
});

test('computeManagerConversion: only managers with at least one outcome appear', () => {
  const rows = arr(app.computeManagerConversion([
    lead({ meetingWith: 'חנן', meetingOutcome: 'entered' }),
    lead({ meetingWith: 'עידו', meetingOutcome: '' }),   // no outcome → עידו absent
  ]));
  assert.deepStrictEqual(rows.map(r => r.manager), ['חנן']);
});

test('computeManagerConversion: leads with an outcome but no meetingWith group under a placeholder', () => {
  // Handled by grouping under MANAGER_CONVERSION_UNASSIGNED ("ללא מנהל") so they
  // are counted and shown, never silently dropped.
  const rows = arr(app.computeManagerConversion([
    lead({ meetingWith: '', meetingOutcome: 'entered' }),
    lead({ meetingWith: '   ', meetingOutcome: 'thinking' }),   // whitespace-only → same bucket
  ]));
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].manager, app.MANAGER_CONVERSION_UNASSIGNED);
  assert.strictEqual(rows[0].total, 2);
  assert.strictEqual(rows[0].held, 2);
  assert.strictEqual(rows[0].converted, 1);
  assert.strictEqual(rows[0].rate, 50);
});

test('computeManagerConversion: empty / nullish input yields no rows', () => {
  assert.deepStrictEqual(arr(app.computeManagerConversion([])), []);
  assert.deepStrictEqual(arr(app.computeManagerConversion(null)), []);
  assert.deepStrictEqual(arr(app.computeManagerConversion(undefined)), []);
});

/* ===== meetingOutcomeEligible (date predicate) ===== */

test('meetingOutcomeEligible: today-or-earlier gets a selector; future does not', () => {
  const today = '2026-08-04';
  assert.strictEqual(app.meetingOutcomeEligible('2026-08-04', today), true);   // today
  assert.strictEqual(app.meetingOutcomeEligible('2026-08-03', today), true);   // yesterday
  assert.strictEqual(app.meetingOutcomeEligible('2026-07-01', today), true);   // long past
  assert.strictEqual(app.meetingOutcomeEligible('2026-08-05', today), false);  // tomorrow
  assert.strictEqual(app.meetingOutcomeEligible('2026-12-31', today), false);  // far future
});

test('meetingOutcomeEligible: comparison is on local bare date parts, not UTC time-of-day', () => {
  // A bare YYYY-MM-DD equal to "today" is eligible. If the code parsed dates as
  // UTC midnight and compared to a local Date, a late-evening Israel run could
  // misclassify the boundary — the string compare avoids that entirely.
  assert.strictEqual(app.meetingOutcomeEligible('2026-08-04', '2026-08-04'), true);
  assert.strictEqual(app.meetingOutcomeEligible('2026-08-05', '2026-08-04'), false);
});

test('meetingOutcomeEligible: blank/invalid date is not eligible', () => {
  assert.strictEqual(app.meetingOutcomeEligible('', '2026-08-04'), false);
  assert.strictEqual(app.meetingOutcomeEligible(null, '2026-08-04'), false);
  assert.strictEqual(app.meetingOutcomeEligible(undefined, '2026-08-04'), false);
});

/* ===== admissionMeetingOutcome (entry action) ===== */

test('admissionMeetingOutcome: sets entered when the lead had a meeting (visitDate present)', () => {
  assert.strictEqual(app.admissionMeetingOutcome(lead({ visitDate: '2026-08-01' })), 'entered');
  // Overwrites any prior outcome — entering treatment is the final word.
  assert.strictEqual(
    app.admissionMeetingOutcome(lead({ visitDate: '2026-08-01', meetingOutcome: 'thinking' })),
    'entered'
  );
});

test('admissionMeetingOutcome: sets nothing when the lead had no meeting (no visitDate)', () => {
  assert.strictEqual(app.admissionMeetingOutcome(lead({ visitDate: '' })), null);
  assert.strictEqual(app.admissionMeetingOutcome(lead({})), null);
  assert.strictEqual(app.admissionMeetingOutcome(null), null);
});
