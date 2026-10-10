/* Tests for CHANGELOG-inclusive-role-wording.md.
 *
 *   1. House-manager labels use the slash form (display text only):
 *      «דיווח מנהל/ת», «דיווח המנהל/ת», «עריכת דיווח מנהל/ת»,
 *      «המרת פגישות למנהל/ת», «דיווח מנהלי הבתים».
 *   2. «ללא מנהל»: only the DISPLAYED label becomes «ללא מנהל/ת». The bucket
 *      key stays byte-identical — it is matched in code — so bucketing and the
 *      strip's filter are unchanged.
 *   3. The coordinators-feed updatedBy stamp: new writes say «רכזים · …»; old
 *      rows keep «רכזות · …». The only place updatedBy reaches a screen is the
 *      stale-save conflict banner (conflictsMessage), which shows the stored
 *      stamp verbatim — both forms are accepted. */

process.env.TZ = 'Asia/Jerusalem';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const arr = (x) => JSON.parse(JSON.stringify(x));

function loadApp() {
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
  vm.runInContext(APP_SRC + `
    globalThis.__test = { state, computeManagerConversion, meetingsSummaryHTML, managerConversionLabel,
      meetingReportBlockHTML, conflictsMessage,
      MANAGER_CONVERSION_UNASSIGNED, MANAGER_CONVERSION_UNASSIGNED_LABEL };`, sandbox);
  return sandbox.__test;
}
const app = loadApp();
const lead = (o) => Object.assign({ id: 'x', name: 'ליד', house: '', meetingWith: '', meetingOutcome: '' }, o || {});

/* ===== 2. «ללא מנהל» — key unchanged, label inclusive ===== */

test('the unassigned bucket KEY is byte-identical to before («ללא מנהל»)', () => {
  assert.strictEqual(app.MANAGER_CONVERSION_UNASSIGNED, 'ללא מנהל');
  assert.deepStrictEqual(Array.from(Buffer.from(app.MANAGER_CONVERSION_UNASSIGNED, 'utf8')),
    Array.from(Buffer.from('ללא מנהל', 'utf8')));
});

test('bucketing is unchanged: blank / whitespace meetingWith land in the same key with the same counts', () => {
  const rows = arr(app.computeManagerConversion([
    lead({ meetingWith: '', meetingOutcome: 'entered' }),
    lead({ meetingWith: '   ', meetingOutcome: 'thinking' }),
    lead({ meetingWith: 'חן', meetingOutcome: 'entered' }),
    lead({ meetingWith: 'חן', meetingOutcome: 'postponed' }),
  ]));
  assert.deepStrictEqual(rows, [
    { manager: 'ללא מנהל', total: 2, held: 2, converted: 1, rate: 50 },
    { manager: 'חן', total: 2, held: 1, converted: 1, rate: 100 },
  ]);
});

test('the displayed label for the bucket is «ללא מנהל/ת»; a manager name is shown as is', () => {
  assert.strictEqual(app.MANAGER_CONVERSION_UNASSIGNED_LABEL, 'ללא מנהל/ת');
  assert.strictEqual(app.managerConversionLabel('ללא מנהל'), 'ללא מנהל/ת');
  assert.strictEqual(app.managerConversionLabel('חן'), 'חן');
  assert.strictEqual(app.managerConversionLabel(''), '');
});

test('the strip still hides the unassigned bucket; its head reads «המרת פגישות למנהל/ת»', () => {
  const html = app.meetingsSummaryHTML([
    lead({ meetingWith: '', meetingOutcome: 'entered' }),
    lead({ meetingWith: 'חן', meetingOutcome: 'entered' }),
  ], { pardes: 'חן' });
  assert.ok(html.includes('המרת פגישות למנהל/ת'));
  assert.ok(html.includes('>חן<'));
  assert.ok(!html.includes('ללא מנהל'), 'unassigned bucket not shown (neither key nor label)');
});

/* ===== 1. house-manager labels ===== */

test('the report block on a lead card reads «דיווח מנהל/ת»', () => {
  app.state.mode = 'view';
  const html = app.meetingReportBlockHTML(lead({ meetingReportedAt: '2026-10-09T10:00:00Z', meetingReportOutcome: 'thinking' }));
  assert.ok(html.includes('<span class="mrv-title">דיווח מנהל/ת</span>'));
});

test('every changed house-manager label is in the source, and no bare singular label is left', () => {
  [
    '<span class="mrv-title">דיווח מנהל/ת</span>',
    "'למחוק את דיווח המנהל/ת? ",
    '<h3>עריכת דיווח מנהל/ת</h3>',
    "'דיווח המנהל/ת השתנה בזמן העריכה",
    '<div class="mtg-summary-head">המרת פגישות למנהל/ת</div>',
  ].forEach(s => assert.ok(APP_SRC.includes(s), s));
  const page = fs.readFileSync(path.join(ROOT, 'public', 'meeting-report.html'), 'utf8');
  assert.ok(page.includes('E-Zone — דיווח מנהלי הבתים'));
  // Outside comments, a singular «מנהל» not followed by «/ת» survives only as
  // the bucket key.
  const lines = APP_SRC.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l));
  const bare = lines.filter(l => /מנהל(?![\/א-ת])/.test(l) && !l.includes("MANAGER_CONVERSION_UNASSIGNED = 'ללא מנהל'"));
  assert.deepStrictEqual(bare, []);
});

/* ===== 3. updatedBy: both stamp forms are shown as stored ===== */

test('the conflict banner shows a stored updatedBy verbatim — old «רכזות · …» and new «רכזים · …» alike', () => {
  const msg = (by) => app.conflictsMessage({ conflicts: [{ id: 'p1', name: 'דנה', sheetUpdatedBy: by }] });
  assert.ok(msg('רכזים · שירה').includes('רכזים · שירה עדכן/ה קודם'));
  assert.ok(msg('רכזות · שירה').includes('רכזות · שירה עדכן/ה קודם'), 'an old row still reads');
  assert.ok(msg('').includes('משתמש/ת אחר/ת'));
});
