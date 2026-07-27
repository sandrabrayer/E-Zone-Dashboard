/* Tests for the meetings board (לוח פגישות) + meetingWith dropdown resolution
 * in public/app.js.
 *
 * Same vm-sandbox approach as growth-graph.test.js: app.js is a browser global
 * script (no module.exports, touches document/location at top level), so we
 * read the source, append an epilogue exposing the pure functions, and evaluate
 * it in a vm context with browser globals stubbed. No changes to app.js needed.
 *
 * meetingsForWeek reuses weekStartSunday/addDaysISO/isoDate/isoTime, so the real
 * timezone-safe date handling is exercised. Week math depends on the host local
 * timezone; pin TZ=Asia/Jerusalem so the boundary assertions are deterministic. */

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
      meetingsForWeek,
      managerForHouse,
      managerOptions,
      weekStartSunday,
      addDaysISO,
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

// Arrays returned from the vm sandbox carry the sandbox realm's Array.prototype,
// which assert.deepStrictEqual treats as unequal to a test-realm array even with
// identical contents. Copy into a plain test-realm array before comparing.
const arr = x => Array.from(x);

// The four-house roster as getData exports it (house id → manager name).
const ROSTER = { arfoni: 'חנן', rehab: 'רנטה', asher: 'עידו', ramot: 'אורן' };

function lead(over) {
  return Object.assign(
    { id: 'x', name: 'ליד', house: '', visitDate: '', visitTime: '', meetingWith: '' },
    over || {}
  );
}

/* ===== Week-boundary bucketing ===== */
// 2026-07-26 is a Sunday; the week runs Sun 07-26 … Sat 08-01.
const WEEK_ANCHOR = '2026-07-26';

test('Sunday (week start) and Saturday (week end) both land in the week', () => {
  const leads = [
    lead({ id: 'sun', name: 'ראשון', visitDate: '2026-07-26', visitTime: '09:00' }),
    lead({ id: 'sat', name: 'שבת',   visitDate: '2026-08-01', visitTime: '10:00' }),
  ];
  const wk = app.meetingsForWeek(leads, WEEK_ANCHOR);
  assert.strictEqual(wk.weekStart, '2026-07-26');
  assert.strictEqual(wk.weekEnd, '2026-08-01');
  assert.strictEqual(wk.total, 2);
  const ids = wk.days.flatMap(d => d.timed.concat(d.noTime)).map(m => m.id);
  assert.deepStrictEqual(arr(ids).sort(), ['sat', 'sun']);
});

test('the day before the week start and the day after the week end are excluded', () => {
  const leads = [
    lead({ id: 'prevSat', visitDate: '2026-07-25', visitTime: '09:00' }), // Sat before
    lead({ id: 'nextSun', visitDate: '2026-08-02', visitTime: '09:00' }), // Sun after
  ];
  const wk = app.meetingsForWeek(leads, WEEK_ANCHOR);
  assert.strictEqual(wk.total, 0);
  assert.strictEqual(wk.days.length, 0);
});

test('any day within the week anchors to the same Sunday-start week', () => {
  // Anchor mid-week (Wed 07-29) — must resolve to the same Sun 07-26 week.
  const wk = app.meetingsForWeek(
    [lead({ id: 'wed', visitDate: '2026-07-29', visitTime: '12:00' })],
    '2026-07-29'
  );
  assert.strictEqual(wk.weekStart, '2026-07-26');
  assert.strictEqual(wk.total, 1);
});

/* ===== Sort order within a day (incl. the no-time case) ===== */
test('within a day, timed meetings sort by time ascending and no-time sort last', () => {
  const leads = [
    lead({ id: 'noon',  name: 'ב', visitDate: '2026-07-27', visitTime: '12:00' }),
    lead({ id: 'early', name: 'א', visitDate: '2026-07-27', visitTime: '08:30' }),
    lead({ id: 'late',  name: 'ג', visitDate: '2026-07-27', visitTime: '16:45' }),
    lead({ id: 'none',  name: 'ד', visitDate: '2026-07-27', visitTime: '' }),
  ];
  const wk = app.meetingsForWeek(leads, WEEK_ANCHOR);
  assert.strictEqual(wk.days.length, 1);
  const day = wk.days[0];
  assert.deepStrictEqual(arr(day.timed.map(m => m.id)), ['early', 'noon', 'late']);
  // The date-but-no-time lead is bucketed separately so the renderer can place
  // it last under "ללא שעה".
  assert.deepStrictEqual(arr(day.noTime.map(m => m.id)), ['none']);
});

test('no-time leads with the same day sort by name among themselves', () => {
  const leads = [
    lead({ id: 'b', name: 'בבב', visitDate: '2026-07-27', visitTime: '' }),
    lead({ id: 'a', name: 'אאא', visitDate: '2026-07-27', visitTime: '' }),
  ];
  const wk = app.meetingsForWeek(leads, WEEK_ANCHOR);
  assert.deepStrictEqual(arr(wk.days[0].noTime.map(m => m.id)), ['a', 'b']);
  assert.strictEqual(wk.days[0].timed.length, 0);
});

test('leads with no visitDate are not meetings', () => {
  const wk = app.meetingsForWeek(
    [lead({ id: 'nodate', visitDate: '', visitTime: '09:00' })],
    WEEK_ANCHOR
  );
  assert.strictEqual(wk.total, 0);
});

/* ===== Empty-week state ===== */
test('a week with no meetings returns zero days and total 0 (empty-state trigger)', () => {
  const wk = app.meetingsForWeek([], WEEK_ANCHOR);
  assert.strictEqual(wk.total, 0);
  assert.deepStrictEqual(arr(wk.days), []);
  // Boundaries are still computed so the nav range label renders.
  assert.strictEqual(wk.weekStart, '2026-07-26');
  assert.strictEqual(wk.weekEnd, '2026-08-01');
});

/* ===== Dropdown default: house → manager resolution ===== */
test('managerForHouse resolves the manager for all four house keys (by id)', () => {
  assert.strictEqual(app.managerForHouse('arfoni', ROSTER), 'חנן');
  assert.strictEqual(app.managerForHouse('rehab', ROSTER), 'רנטה');
  assert.strictEqual(app.managerForHouse('asher', ROSTER), 'עידו');
  assert.strictEqual(app.managerForHouse('ramot', ROSTER), 'אורן');
});

test('managerForHouse resolves by Hebrew house label too', () => {
  // The lead form stores the Hebrew label (h.name), not the id.
  assert.strictEqual(app.managerForHouse('קיסריה עפרוני', ROSTER), 'חנן'); // arfoni
  assert.strictEqual(app.managerForHouse('רמות השבים', ROSTER), 'אורן');   // ramot
});

test('managerForHouse returns blank for houses with no manager and for no house', () => {
  assert.strictEqual(app.managerForHouse('pardes', ROSTER), '');          // no manager
  assert.strictEqual(app.managerForHouse('sde', ROSTER), '');             // no manager
  assert.strictEqual(app.managerForHouse('רעננה הפרדס', ROSTER), '');     // pardes label
  assert.strictEqual(app.managerForHouse('', ROSTER), '');                // no house
  assert.strictEqual(app.managerForHouse('external-unknown', ROSTER), ''); // external
});

test('managerOptions lists exactly the four distinct managers', () => {
  assert.deepStrictEqual(arr(app.managerOptions(ROSTER)).sort(), ['אורן', 'חנן', 'עידו', 'רנטה']);
});

test('managerForHouse is empty when the roster is empty (older deploy)', () => {
  assert.strictEqual(app.managerForHouse('arfoni', {}), '');
  assert.deepStrictEqual(arr(app.managerOptions({})), []);
});
