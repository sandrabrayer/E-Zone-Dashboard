/* Tests for the visitTime corruption fix.
 *
 * Server side (apps-script/Code.gs): asISOTime_ normalizes a cell value to
 * 'HH:MM', extracting a Date's time in the SPREADSHEET timezone (never UTC).
 * Client side (public/app.js): isoTime uses local getters (consistent with
 * isoDate) and autosaveMeetingWithDefaults no longer retries a lead whose save
 * already failed this session.
 *
 * Both files are non-Node scripts; per the repo's vm-sandbox convention we read
 * the source, stub the globals, and exercise the REAL shipped functions. */

process.env.TZ = 'Asia/Jerusalem';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SHEET_TZ = 'Asia/Jerusalem';

/* ---------- load apps-script/Code.gs (asISOTime_ / asISODate_) ---------- */
function loadCode() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
  const fmtCalls = [];
  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    JSON, Math, Date, Number, String, Array, Object, RegExp,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({ getSpreadsheetTimeZone: () => SHEET_TZ }),
    },
    Utilities: {
      // Records the tz it was asked to format in; returns a tz-sensitive value so
      // a UTC read (wrong) would produce a different result than the sheet tz.
      formatDate: (d, tz, fmt) => {
        fmtCalls.push({ tz, fmt });
        if (fmt !== 'HH:mm') return 'XX:XX';
        return tz === SHEET_TZ ? '08:18' : '06:18';
      },
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + '\nglobalThis.__test = { asISOTime_: asISOTime_, asISODate_: asISODate_ };', sandbox);
  return { code: sandbox.__test, fmtCalls };
}

/* ---------- load public/app.js (isoTime + autosave) ---------- */
function loadApp() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const epilogue = `
    globalThis.__test = {
      isoTime: (v) => isoTime(v),
      leadsNeedingMeetingWithDefault: (l, r) => leadsNeedingMeetingWithDefault(l, r),
      autosave: () => autosaveMeetingWithDefaults(),
      setLeads(ls) { state.leads = ls; },
      setRoster(r) { state.houseManagers = r; },
      setMode(m) { state.mode = m; },
      getLead(id) { return state.leads.find(l => l.id === id); },
      stubSaveAll(fail) {
        const calls = [];
        saveAll = async () => { calls.push(true); if (fail) throw new Error('save failed'); };
        return calls;
      },
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

/* ===== 1. 'HH:MM' round-trips unchanged through write and read ===== */
test("'HH:MM' passes through asISOTime_ and isoTime unchanged", () => {
  const { code } = loadCode();
  const app = loadApp();
  for (const t of ['08:18', '00:00', '23:59', '13:07', '09:30']) {
    assert.strictEqual(code.asISOTime_(t), t, `server asISOTime_(${t})`);
    assert.strictEqual(app.isoTime(t), t, `client isoTime(${t})`);
  }
  // Empty / missing stays empty.
  assert.strictEqual(code.asISOTime_(''), '');
  assert.strictEqual(code.asISOTime_(null), '');
});

/* ===== 2. A Date-valued cell normalizes via the SPREADSHEET tz, not UTC ===== */
test('asISOTime_ formats a Date in the spreadsheet timezone (never UTC)', () => {
  const { code, fmtCalls } = loadCode();
  const out = code.asISOTime_(new Date(Date.UTC(1899, 11, 30, 5, 57, 6))); // a coerced time cell
  // The stub returns '08:18' only when asked to format in the sheet tz; a UTC
  // read would have returned '06:18'. So this proves the sheet-tz branch ran.
  assert.strictEqual(out, '08:18');
  assert.strictEqual(fmtCalls.length, 1);
  assert.strictEqual(fmtCalls[0].tz, SHEET_TZ, 'must format in the spreadsheet tz');
  assert.strictEqual(fmtCalls[0].fmt, 'HH:mm');
  assert.notStrictEqual(fmtCalls[0].tz, 'UTC');
  assert.notStrictEqual(fmtCalls[0].tz, 'GMT');
});

/* ===== 3. save→read→save is idempotent — no drift after three cycles ===== */
test('a save→read→save cycle does not drift over three iterations', () => {
  const { code } = loadCode();
  const app = loadApp();
  // Models the real path with the fix: WRITE canonicalizes visitTime via
  // asISOTime_ and stores it as TEXT (identity for 'HH:MM'); READ runs asISOTime_
  // again server-side; the CLIENT then runs isoTime. All three are passthrough on
  // a clean 'HH:MM', so the value must be stable across repeated cycles.
  const cycle = (v) => app.isoTime(code.asISOTime_(code.asISOTime_(v)));
  for (const start of ['08:18', '13:07']) {
    let v = start;
    for (let i = 0; i < 3; i++) v = cycle(v);
    assert.strictEqual(v, start, `${start} must survive 3 cycles unchanged (got ${v})`);
  }
});

/* ===== 4. autosave does not re-fire for a lead whose save already failed ===== */
test('autosave retries at most once per lead per session under a failing backend', async () => {
  const app = loadApp();
  app.setMode('edit');
  app.setRoster({ arfoni: 'חנן' });
  app.setLeads([{ id: 'L1', name: 'דנה', stage: 'visit', house: 'קיסריה עפרוני',
    visitDate: '2026-07-27', visitTime: '09:00', meetingWith: '' }]);
  const calls = app.stubSaveAll(true); // every save fails

  await app.autosave();               // attempt 1 → fails, rolls back, records failure
  assert.strictEqual(calls.length, 1, 'first attempt saved once');
  assert.strictEqual(app.getLead('L1').meetingWith, '', 'rolled back to empty on failure');

  await app.autosave();               // attempt 2 → lead is in the failed set → skipped
  await app.autosave();               // attempt 3 → still skipped
  assert.strictEqual(calls.length, 1, 'no further saves — no infinite write loop');
});

test('a lead that still needs a default but has not failed is not blocked by another lead\'s failure', async () => {
  const app = loadApp();
  app.setMode('edit');
  app.setRoster({ arfoni: 'חנן', ramot: 'אורן' });
  app.setLeads([{ id: 'A', name: 'א', stage: 'visit', house: 'קיסריה עפרוני', visitTime: '', meetingWith: '' }]);
  const calls = app.stubSaveAll(true);
  await app.autosave();               // A fails, recorded
  assert.strictEqual(calls.length, 1);

  // A new lead B appears that also needs a default; it has NOT failed, so it saves.
  app.setLeads([
    { id: 'A', name: 'א', stage: 'visit', house: 'קיסריה עפרוני', visitTime: '', meetingWith: '' },
    { id: 'B', name: 'ב', stage: 'visit', house: 'רמות השבים', visitTime: '', meetingWith: '' },
  ]);
  await app.autosave();               // B qualifies (A is skipped); one more save
  assert.strictEqual(calls.length, 2, 'B is attempted even though A already failed');
});
