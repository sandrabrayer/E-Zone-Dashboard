/* Tests for the meeting-report form logic (public/meeting-report.js) and the
 * service-worker treatment of the new routes:
 *
 *   - the lead-picker filter: visitDate ≤ today by default, everything under
 *     the "לא מוצא את הליד?" toggle, visitDate-desc sort with blanks last;
 *   - the companion אחר flow: free text becomes the submitted value;
 *   - the WhatsApp share message + wa.me encoding;
 *   - the duplicated label maps stay IN SYNC with app.js's PR-1 maps;
 *   - sw.js: /api/meeting-report/* is network-only (never cached), the
 *     /meeting-report page is plain network (also never cached) — no SW change
 *     was needed, this locks that in.
 *
 * meeting-report.js guards its DOM wiring behind `typeof document`, so a plain
 * require() loads just the constants + pure helpers. app.js and sw.js are
 * vm-sandbox-loaded per the repo convention. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const mr = require('../public/meeting-report.js');

/* ---------- load public/app.js for the PR-1 label maps ---------- */
function loadApp() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const epilogue = `globalThis.__test = {
    MEETING_REPORT_OUTCOME_LABELS: MEETING_REPORT_OUTCOME_LABELS,
    MEETING_COMPANION_LABELS: MEETING_COMPANION_LABELS,
    HOUSES: HOUSES,
  };`;
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

/* ---------- load public/sw.js (module.exports; SW globals stubbed) ---------- */
function loadSw() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');
  const noop = () => {};
  const moduleObj = { exports: {} };
  const sandbox = {
    self: { addEventListener: noop, skipWaiting: noop, clients: { claim: noop } },
    caches: {
      open: () => Promise.resolve({ add: noop, put: noop }),
      keys: () => Promise.resolve([]),
      match: () => Promise.resolve(undefined),
      delete: () => Promise.resolve(true),
    },
    Promise, URL, console: { log: noop, warn: noop, error: noop },
    module: moduleObj,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return moduleObj.exports;
}

const app = loadApp();

/* ===== label maps stay in sync with app.js (single source of truth: PR 1) ===== */

test('MR_OUTCOME_LABELS matches MEETING_REPORT_OUTCOME_LABELS in app.js exactly', () => {
  const a = app.MEETING_REPORT_OUTCOME_LABELS;
  assert.deepStrictEqual(Object.keys(mr.MR_OUTCOME_LABELS).sort(), Object.keys(a).sort());
  Object.keys(a).forEach((k) => assert.strictEqual(mr.MR_OUTCOME_LABELS[k], a[k], k));
});

test('MR_COMPANION_LABELS matches MEETING_COMPANION_LABELS in app.js exactly', () => {
  const a = app.MEETING_COMPANION_LABELS;
  assert.deepStrictEqual(Object.keys(mr.MR_COMPANION_LABELS).sort(), Object.keys(a).sort());
  Object.keys(a).forEach((k) => assert.strictEqual(mr.MR_COMPANION_LABELS[k], a[k], k));
});

test('MR_HOUSE_LABELS covers exactly the HOUSES in app.js', () => {
  const houseIds = Array.from(app.HOUSES).map((h) => h.id).sort();
  assert.deepStrictEqual(Object.keys(mr.MR_HOUSE_LABELS).sort(), houseIds);
  Array.from(app.HOUSES).forEach((h) =>
    assert.strictEqual(mr.MR_HOUSE_LABELS[h.id], h.name, 'label for ' + h.id));
});

test('MEETING_REPORTERS holds the real managers, keyed by valid house ids', () => {
  const houseIds = new Set(Array.from(app.HOUSES).map((h) => h.id));
  assert.deepStrictEqual(mr.MEETING_REPORTERS, {
    arfoni: 'חנן',
    rehab:  'רנטה',
    asher:  'שחר/אורן',
    pardes: 'חן',
    ramot:  'אורן',
  });
  Object.keys(mr.MEETING_REPORTERS).forEach((k) =>
    assert.ok(houseIds.has(k), k + ' is a real house id'));
});

/* ===== lead picker filter ===== */

const LEADS = [
  { id: 'a', name: 'א', house: 'ramot', visitDate: '2026-08-10' },
  { id: 'b', name: 'ב', house: 'sde', visitDate: '2026-08-29' },   // today
  { id: 'c', name: 'ג', house: 'arfoni', visitDate: '2026-09-15' }, // future
  { id: 'd', name: 'ד', house: 'rehab', visitDate: '' },            // never visited
];
const TODAY = '2026-08-29';

test('default view: only leads with visitDate ≤ today, sorted visitDate desc', () => {
  const ids = mr.mrLeadsForPicker(LEADS, TODAY, false).map((l) => l.id);
  assert.deepStrictEqual(ids, ['b', 'a'], 'future and blank visitDates hidden; newest visit first');
});

test('the "לא מוצא את הליד?" toggle shows ALL open leads, blanks last', () => {
  const ids = mr.mrLeadsForPicker(LEADS, TODAY, true).map((l) => l.id);
  assert.deepStrictEqual(ids, ['c', 'b', 'a', 'd']);
});

test('picker filter is defensive about bad input', () => {
  assert.deepStrictEqual(mr.mrLeadsForPicker(null, TODAY, false), []);
  assert.deepStrictEqual(mr.mrLeadsForPicker([null, {}, { id: '' }], TODAY, true), []);
});

/* ===== companion אחר flow ===== */

test('a preset chip submits its key; אחר submits the free text', () => {
  assert.strictEqual(mr.mrCompanionValue('mother', 'ignored'), 'mother');
  assert.strictEqual(mr.mrCompanionValue('alone', ''), 'alone');
  assert.strictEqual(mr.mrCompanionValue('other', 'סבתא רבתא'), 'סבתא רבתא');
  assert.strictEqual(mr.mrCompanionValue('other', '  מדריך  '), 'מדריך', 'free text is trimmed');
  assert.strictEqual(mr.mrCompanionValue('other', '   '), 'other', 'blank free text falls back to the other key');
});

test('companion display: preset key → label, free text → verbatim (PR-1 rule)', () => {
  assert.strictEqual(mr.mrCompanionDisplay('mother'), 'אמא');
  assert.strictEqual(mr.mrCompanionDisplay('other'), 'אחר');
  assert.strictEqual(mr.mrCompanionDisplay('סבתא רבתא'), 'סבתא רבתא');
});

/* ===== WhatsApp share ===== */

test('the WhatsApp message follows the agreed Hebrew template', () => {
  const msg = mr.mrWhatsAppMessage({
    name: 'דני', house: 'ramot', outcome: 'advancing',
    companion: 'mother', note: 'שיחה טובה', reporter: 'יעל',
  });
  assert.strictEqual(msg, [
    'דיווח פגישה — E-Zone',
    'ליד: דני (רמות השבים)',
    'תוצאה: התקיימה — מתקדם לכניסה',
    'הגיע/ה עם: אמא',
    'פירוט: שיחה טובה',
    'דווח ע"י: יעל',
  ].join('\n'));
});

test('free-text companion appears verbatim in the message', () => {
  const msg = mr.mrWhatsAppMessage({
    name: 'רות', house: 'arfoni', outcome: 'no_show',
    companion: 'סבתא', note: '', reporter: 'שירן',
  });
  assert.ok(msg.includes('הגיע/ה עם: סבתא'));
  assert.ok(msg.includes('תוצאה: לא הגיע / בוטל'));
});

test('the wa.me link is the chat picker with the message fully URL-encoded', () => {
  const link = mr.mrWhatsAppLink('דיווח\nשורה שנייה & סימנים?');
  assert.ok(link.startsWith('https://wa.me/?text='), 'no phone number — the manager picks the group');
  const encoded = link.slice('https://wa.me/?text='.length);
  assert.strictEqual(decodeURIComponent(encoded), 'דיווח\nשורה שנייה & סימנים?');
  assert.ok(!encoded.includes('&'), 'ampersand must be percent-encoded');
  assert.ok(!encoded.includes('\n'), 'newlines must be percent-encoded');
});

/* ===== service worker: the new routes are never cached ===== */

test('sw.js: /api/meeting-report/* is network-only; /meeting-report is plain network', () => {
  const sw = loadSw();
  assert.strictEqual(sw.cacheStrategy('https://x/api/meeting-report/leads'), 'network-only');
  assert.strictEqual(sw.cacheStrategy('https://x/api/meeting-report/submit'), 'network-only');
  assert.strictEqual(sw.cacheStrategy('https://x/api/meeting-report/verify-pin'), 'network-only');
  assert.strictEqual(sw.cacheStrategy('https://x/meeting-report'), 'network', 'page passes through, never cached');
  assert.strictEqual(sw.shouldCache('https://x/api/meeting-report/leads'), false);
});
