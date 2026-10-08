/* Current house managers — the source for the meetings summary strip, the
 * meetingWith dropdowns and the per-house meetingWith default.
 * See CHANGELOG-meeting-summary-active-managers.md.
 *
 * Code.gs (vm sandbox, repo convention — see getdata-feed.test.js):
 *   - Managers tab: current = end_date blank or today-or-later (Asia/Jerusalem)
 *   - Managers tab empty / missing → bonusconfig `manager` column (tab and
 *     column found by name, case-insensitively — never by position)
 *   - neither → exactly getData's houseManagers (HOUSE_MANAGERS)
 *   - house keys come out as asher / ramot / arfoni / rehab / pardes
 *   - READ-ONLY: no tab created, no cell written; houseManagers unchanged
 * app.js (vm sandbox):
 *   - the strip shows current managers only (no former manager, no ללא מנהל)
 *   - the dropdowns offer current managers and keep a saved former manager
 *   - the per-house default follows the current roster */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const arr = (x) => JSON.parse(JSON.stringify(x));
const GS_SRC = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
const APP_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const TODAY = '2026-10-01';

/* ======================================================================== */
/* ================================ Code.gs ================================ */
/* ======================================================================== */

function fakeSheet(name, header, rows) {
  const grid = [header.slice()].concat((rows || []).map((r) => r.slice()));
  const writes = [];
  return {
    grid, writes,
    getName: () => name,
    getLastRow: () => grid.length,
    getLastColumn: () => grid.reduce((n, r) => Math.max(n, r.length), 0),
    getMaxRows: () => 1000,
    setFrozenRows() { writes.push('freeze'); },
    appendRow() { writes.push('append'); },
    getRange(r, c, nr, nc) {
      nr = nr || 1; nc = nc || 1;
      return {
        getValues() {
          const out = [];
          for (let i = 0; i < nr; i++) {
            const row = [];
            for (let j = 0; j < nc; j++) {
              const g = grid[r - 1 + i];
              row.push(g && g[c - 1 + j] !== undefined ? g[c - 1 + j] : '');
            }
            out.push(row);
          }
          return out;
        },
        setValues() { writes.push('setValues'); },
        setValue() { writes.push('setValue'); },
        setNumberFormat() { writes.push('fmt'); },
      };
    },
  };
}

/* `tabs`: { tabName: sheet }. getSheetByName is EXACT (like the real API is
 * for our purposes); getSheets lists every tab for the case-insensitive scan. */
/* Utilities.formatDate's real contract: the date as seen in `tz`. */
function formatInTz(d, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/* `opts.sheetTz` — the spreadsheet's own zone (what asISODate_ formats in). */
function loadGs(tabs, opts) {
  const sheetTz = (opts && opts.sheetTz) || 'Asia/Jerusalem';
  const registry = Object.assign({}, tabs || {});
  const inserted = [];
  const tzSeen = [];
  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    JSON, Math, Date, Number, String, Array, Object, RegExp, isFinite, isNaN,
    Logger: { log: noop },
    Utilities: {
      formatDate: (d, tz, fmt) => {
        tzSeen.push(tz);
        // "now" is pinned to TODAY so the suite does not depend on the clock.
        if (fmt === 'yyyy-MM-dd' && tz === 'Asia/Jerusalem' && Date.now() - d.getTime() < 60000) return TODAY;
        return formatInTz(d, tz);
      },
      getUuid: () => 'uuid',
    },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: noop }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
  };
  sandbox.SpreadsheetApp = {
    getActiveSpreadsheet: () => ({
      getSheetByName: (n) => registry[n] || null,
      getSheets: () => Object.values(registry),
      insertSheet: (n) => { inserted.push(n); return (registry[n] = fakeSheet(n, [], [])); },
      getSpreadsheetTimeZone: () => sheetTz,
    }),
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(GS_SRC + `
    globalThis.__t = {
      current: (d) => currentManagers_(d),
      managerDateIso: (v) => managerDateIso_(v),
      getData: () => getData_(),
      HOUSE_MANAGERS: HOUSE_MANAGERS,
    };`, sandbox);
  return { gs: sandbox.__t, registry, inserted, tzSeen };
}

const MANAGERS_HEADER = ['house', 'manager_name', 'start_date', 'end_date'];
/* bonusconfig as it is live: lowercase tab, `manager` in column K (index 10),
 * other columns around it. */
const BONUS_HEADER = ['house', 'bep_patients', 'capacity_patients', 'bonus_base', 'bonus_per_day', 'type', 'x1', 'x2', 'x3', 'x4', 'manager'];
function bonusRow(house, manager) {
  const r = [house, 10, 13, 1000, 50, 'residence', '', '', '', ''];
  r.push(manager);
  return r;
}
const bonusconfig = () => fakeSheet('bonusconfig', BONUS_HEADER, [
  bonusRow('raanana', 'עידו'), bonusRow('ramot', 'אורן'), bonusRow('efroni', 'חנן'), bonusRow('rehab', 'רנטה'),
]);

test('Code.gs: Managers tab MISSING → falls back to the bonusconfig `manager` column (lowercase tab, column K found by header)', () => {
  const { gs } = loadGs({ bonusconfig: bonusconfig() });
  const out = gs.current(TODAY);
  assert.strictEqual(out.source, 'bonusconfig');
  assert.deepStrictEqual(arr(out.managers), [
    { house: 'asher', name: 'עידו' }, { house: 'ramot', name: 'אורן' },
    { house: 'arfoni', name: 'חנן' }, { house: 'rehab', name: 'רנטה' },
  ]);
});

test('Code.gs: Managers tab EMPTY (header only) → falls back to bonusconfig', () => {
  const { gs } = loadGs({ Managers: fakeSheet('Managers', MANAGERS_HEADER, []), bonusconfig: bonusconfig() });
  assert.strictEqual(gs.current(TODAY).source, 'bonusconfig');
});

test('Code.gs: Managers tab with blank-name rows only counts as empty → fallback', () => {
  const { gs } = loadGs({ Managers: fakeSheet('Managers', MANAGERS_HEADER, [['ramot', '', '', '']]), bonusconfig: bonusconfig() });
  assert.strictEqual(gs.current(TODAY).source, 'bonusconfig');
});

test('Code.gs: no Managers rows and no bonusconfig → EXACTLY what getData sends as houseManagers', () => {
  const { gs } = loadGs({});
  const out = gs.current(TODAY);
  assert.strictEqual(out.source, 'default');
  const asMap = {};
  out.managers.forEach((m) => { asMap[m.house] = m.name; });
  assert.deepStrictEqual(asMap, arr(gs.HOUSE_MANAGERS));
});

test('Code.gs: bonusconfig without a `manager` header → houseManagers default (never a guessed column)', () => {
  const noMgr = fakeSheet('bonusconfig', BONUS_HEADER.slice(0, 10), [['ramot', 10, 13, 1, 1, 'r', 'עידו?', '', '', '']]);
  const { gs } = loadGs({ bonusconfig: noMgr });
  assert.strictEqual(gs.current(TODAY).source, 'default');
});

test('Code.gs: tab and header names are matched case-insensitively', () => {
  const hdr = BONUS_HEADER.slice(0, 10).concat(['  Manager ']);
  const { gs } = loadGs({ BONUSCONFIG: fakeSheet('BONUSCONFIG', hdr, [bonusRow('ramot', 'אורן')]) });
  assert.deepStrictEqual(arr(gs.current(TODAY).managers), [{ house: 'ramot', name: 'אורן' }]);
});

test('Code.gs: an end_date in the PAST hides the manager; today / future / blank are current', () => {
  const { gs } = loadGs({
    Managers: fakeSheet('Managers', MANAGERS_HEADER, [
      ['ramot',   'אורן',  '2025-01-01', '2026-09-30'],   // ended yesterday → hidden
      ['ramot',   'דנה',   '2026-10-01', ''],             // blank → current
      ['efroni',  'חנן',   '2025-01-01', '2026-10-01'],   // ends today → current
      ['rehab',   'רנטה',  '2025-01-01', '2027-03-31'],   // future → current
      ['raanana', 'עידו',  '2025-01-01', '15/09/2026'],   // DD/MM/YYYY in the past → hidden
      ['pardes',  'שירה',  '2026-01-01', new Date('2026-12-31T12:00:00Z')], // real date cell, future
    ]),
    bonusconfig: bonusconfig(),
  });
  const out = gs.current(TODAY);
  assert.strictEqual(out.source, 'managers');
  assert.deepStrictEqual(arr(out.managers), [
    { house: 'arfoni', name: 'חנן' },
    { house: 'pardes', name: 'שירה' },
    { house: 'ramot', name: 'דנה' },
    { house: 'rehab', name: 'רנטה' },
  ]);
});

test('Code.gs: every Managers row ended → the tab still wins (no current manager), NO fallback to bonusconfig', () => {
  const { gs } = loadGs({
    Managers: fakeSheet('Managers', MANAGERS_HEADER, [['ramot', 'אורן', '2025-01-01', '2026-01-31']]),
    bonusconfig: bonusconfig(),
  });
  const out = gs.current(TODAY);
  assert.strictEqual(out.source, 'managers');
  assert.deepStrictEqual(arr(out.managers), []);
});

test('Code.gs: house ids come out as asher / ramot / arfoni / rehab / pardes (bonus keys mapped, ids accepted, unknown skipped)', () => {
  const { gs } = loadGs({
    Managers: fakeSheet('Managers', MANAGERS_HEADER, [
      ['raanana', 'א', '', ''], ['ramot', 'ב', '', ''], ['efroni', 'ג', '', ''], ['rehab', 'ד', '', ''],
      ['pardes', 'ה', '', ''], ['Asher', 'ו', '', ''], ['arfoni', 'ז', '', ''], ['sde', 'ח', '', ''], ['nowhere', 'ט', '', ''],
    ]),
  });
  const houses = [...new Set(gs.current(TODAY).managers.map((m) => m.house))].sort();
  assert.deepStrictEqual(houses, ['arfoni', 'asher', 'pardes', 'ramot', 'rehab']);
});

test('Code.gs: two current managers in a house → both listed, newest start_date first (the default)', () => {
  const { gs } = loadGs({
    Managers: fakeSheet('Managers', MANAGERS_HEADER, [
      ['ramot', 'ותיק', '2024-01-01', ''], ['ramot', 'חדש', '2026-09-15', ''],
    ]),
  });
  assert.deepStrictEqual(arr(gs.current(TODAY).managers), [{ house: 'ramot', name: 'חדש' }, { house: 'ramot', name: 'ותיק' }]);
});

test("Code.gs: today is computed in Asia/Jerusalem", () => {
  const { gs, tzSeen } = loadGs({ Managers: fakeSheet('Managers', MANAGERS_HEADER, [['ramot', 'אורן', '', '2026-10-01']]) });
  assert.strictEqual(gs.current().managers.length, 1, 'ends today (Jerusalem) → current');
  assert.ok(tzSeen.includes('Asia/Jerusalem'));
});

test('Code.gs: a read error falls through — getData never breaks because of it', () => {
  const broken = fakeSheet('Managers', MANAGERS_HEADER, [['ramot', 'אורן', '', '']]);
  broken.getRange = () => { throw new Error('boom'); };
  const { gs } = loadGs({ Managers: broken, bonusconfig: bonusconfig() });
  assert.strictEqual(gs.current(TODAY).source, 'bonusconfig');
});

test('Code.gs getData_: adds currentManagers + source; houseManagers is UNCHANGED; READ-ONLY on Managers / bonusconfig', () => {
  const managers = fakeSheet('Managers', MANAGERS_HEADER, [['ramot', 'דנה', '2026-09-01', '']]);
  const bc = bonusconfig();
  const { gs, inserted } = loadGs({ Managers: managers, bonusconfig: bc });
  const out = gs.getData();
  assert.strictEqual(out.currentManagersSource, 'managers');
  assert.ok(out.currentManagers.some((m) => m.house === 'ramot' && m.name === 'דנה'));
  assert.deepStrictEqual(arr(out.houseManagers), arr(gs.HOUSE_MANAGERS), 'houseManagers is what Managers / Therapists already read');
  assert.deepStrictEqual(managers.writes, [], 'nothing written to Managers');
  assert.deepStrictEqual(bc.writes, [], 'nothing written to bonusconfig');
  assert.ok(!inserted.includes('Managers') && !inserted.includes('BonusConfig'));
});

test('Code.gs getData_: missing Managers / bonusconfig tabs are NOT created', () => {
  const { gs, inserted } = loadGs({});
  gs.getData();
  assert.ok(!inserted.includes('Managers'), 'getData must not create the Managers tab');
  assert.ok(!inserted.includes('BonusConfig') && !inserted.includes('bonusconfig'));
});

test('Code.gs: the bonus logic and its readers are untouched by the new reader', () => {
  const fn = (name) => {
    const s = GS_SRC.indexOf('function ' + name + '(');
    return GS_SRC.slice(s, GS_SRC.indexOf('\nfunction ', s + 1));
  };
  for (const name of ['currentManagers_', 'managersTabCurrent_', 'bonusConfigManagers_', 'readTabByHeader_', 'findSheetByNameCI_']) {
    const src = fn(name);
    for (const w of ['getOrCreateSheet_', 'insertSheet', 'setValue', 'appendRow', 'setNumberFormat', 'deleteRow', 'clear']) {
      assert.ok(!src.includes(w), name + ' must not use ' + w);
    }
  }
  assert.ok(!fn('managersOverview_').includes('currentManagers_'));
  assert.ok(!fn('managersHouse_').includes('currentManagers_'));
  assert.ok(fn('readManagers_').includes('getOrCreateSheet_(MANAGERS_SHEET, MANAGER_COLUMNS)'), 'bonus reader unchanged');
});

/* ======================================================================== */
/* ================================ app.js ================================= */
/* ======================================================================== */

function fakeEl() {
  return {
    className: '', dataset: {}, style: {}, _html: '', children: [],
    set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; },
    appendChild(c) { this.children.push(c); }, addEventListener() {}, remove() {},
    querySelector() { return fakeEl(); }, querySelectorAll() { return []; },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  };
}

function loadApp() {
  const noop = () => {};
  const saves = [];
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/' },
    document: { getElementById: () => fakeEl(), createElement: () => fakeEl(), querySelectorAll: () => [], addEventListener() {}, body: fakeEl() },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    URL, URLSearchParams, Math, Date, JSON, Number, String, Array, Object, RegExp, Promise, Set, Map,
    // Answers like saveAll_: proves the rows asked about (CHANGELOG-write-path-hardening.md).
    fetch: (_u, o) => { const b = JSON.parse(o.body); saves.push(b); return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, proven: b.prove || {} }) }); },
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(APP_SRC + `
    renderMeetings = () => {}; renderAll = () => {}; showError = () => {};
    globalThis.__a = {
      state,
      normalizeCurrentManagers: (r) => normalizeCurrentManagers(r),
      rosterFromCurrentManagers: (l) => rosterFromCurrentManagers(l),
      managerOptions: (m) => managerOptions(m),
      managerForHouse: (h, m) => managerForHouse(h, m),
      meetingWithOptionNames: (s, m) => meetingWithOptionNames(s, m),
      meetingWithSelectHTML: (l, m) => meetingWithSelectHTML(l, m),
      meetingWithField: (p) => meetingWithField(p),
      meetingsSummaryHTML: (l, m) => meetingsSummaryHTML(l, m),
      autosaveMeetingWithDefaults: () => autosaveMeetingWithDefaults(),
      meetingRowHTML: (m, t, o) => meetingRowHTML(m, t, o),
    };`, sandbox);
  return { app: sandbox.__a, saves };
}

/* What loadAll does with a getData response. */
function applyCurrent(app, list) {
  app.state.currentManagers = app.normalizeCurrentManagers(list);
  if (app.state.currentManagers) app.state.houseManagers = app.rosterFromCurrentManagers(app.state.currentManagers);
}

const CURRENT = [
  { house: 'asher', name: 'עידו' }, { house: 'ramot', name: 'דנה' },
  { house: 'arfoni', name: 'חנן' }, { house: 'rehab', name: 'רנטה' },
];

test('app.js: normalizeCurrentManagers keeps [] (no current manager) and returns null for an older backend', () => {
  const { app } = loadApp();
  assert.strictEqual(app.normalizeCurrentManagers(undefined), null);
  assert.strictEqual(app.normalizeCurrentManagers({ ramot: 'x' }), null);
  assert.deepStrictEqual(arr(app.normalizeCurrentManagers([])), []);
  assert.deepStrictEqual(arr(app.normalizeCurrentManagers([{ house: ' ramot ', name: ' דנה ' }, { house: 'x' }, null])),
    [{ house: 'ramot', name: 'דנה' }]);
  assert.deepStrictEqual(arr(app.rosterFromCurrentManagers([{ house: 'ramot', name: 'חדש' }, { house: 'ramot', name: 'ותיק' }])),
    { ramot: 'חדש' }, 'first per house = newest start');
});

test('app.js: the per-house meetingWith default follows the CURRENT roster, for all five Patients house ids', () => {
  const { app } = loadApp();
  applyCurrent(app, CURRENT.concat([{ house: 'pardes', name: 'שירה' }]));
  assert.strictEqual(app.managerForHouse('רעננה אשר'), 'עידו');
  assert.strictEqual(app.managerForHouse('ramot'), 'דנה');
  assert.strictEqual(app.managerForHouse('קיסריה עפרוני'), 'חנן');
  assert.strictEqual(app.managerForHouse('rehab'), 'רנטה');
  assert.strictEqual(app.managerForHouse('רעננה הפרדס'), 'שירה');
  assert.strictEqual(app.managerForHouse('שדה אליעזר'), '', 'no manager → blank default');
});

test('app.js: an older backend without currentManagers keeps houseManagers exactly as sent', () => {
  const { app } = loadApp();
  app.state.houseManagers = { ramot: 'אורן' };
  applyCurrent(app, undefined);
  assert.strictEqual(app.managerForHouse('ramot'), 'אורן');
  assert.ok(/state\.currentManagers = normalizeCurrentManagers\(data\.currentManagers\);\s*if \(state\.currentManagers\) state\.houseManagers = rosterFromCurrentManagers\(state\.currentManagers\);/
    .test(APP_SRC), 'loadAll wires currentManagers → houseManagers only when the field is present');
});

test('app.js summary strip: current managers only — a former manager and ללא מנהל are hidden', () => {
  const { app } = loadApp();
  applyCurrent(app, CURRENT);
  const leads = [
    { id: '1', meetingWith: 'דנה', meetingOutcome: 'entered' },
    { id: '2', meetingWith: 'אורן', meetingOutcome: 'entered' },   // former ramot manager
    { id: '3', meetingWith: '', meetingOutcome: 'thinking' },     // → ללא מנהל bucket
    { id: '4', meetingWith: 'חנן', meetingOutcome: 'not_relevant' },
  ];
  const html = app.meetingsSummaryHTML(leads);
  assert.ok(html.includes('דנה') && html.includes('חנן'));
  assert.ok(!html.includes('אורן'), 'former manager hidden');
  assert.ok(!html.includes('ללא מנהל'), 'unassigned row hidden');
  // and nothing to show → no strip
  assert.strictEqual(app.meetingsSummaryHTML([{ id: '5', meetingWith: 'אורן', meetingOutcome: 'entered' }]), '');
});

test('app.js dropdowns: options are the current managers; a SAVED former manager stays selected (pinned), never erased', () => {
  const { app } = loadApp();
  applyCurrent(app, CURRENT);
  assert.deepStrictEqual(arr(app.managerOptions()), ['חנן', 'רנטה', 'עידו', 'דנה']);
  assert.deepStrictEqual(arr(app.meetingWithOptionNames('אורן')), ['חנן', 'רנטה', 'עידו', 'דנה', 'אורן']);
  assert.deepStrictEqual(arr(app.meetingWithOptionNames('דנה')), ['חנן', 'רנטה', 'עידו', 'דנה'], 'no duplicate');

  // lead card select
  const card = app.meetingWithSelectHTML({ house: 'רמות השבים', meetingWith: 'אורן' });
  assert.match(card, /<option value="אורן" selected>אורן<\/option>/);
  // add / edit lead modal field
  const field = app.meetingWithField('אורן');
  assert.strictEqual(field.value, 'אורן');
  assert.ok(field.options.some((o) => o.value === 'אורן'), 'the saved value is an option, so saving the form keeps it');
  // meeting edit modal uses the same list
  const editModal = APP_SRC.slice(APP_SRC.indexOf('function openMeetingEditModal('), APP_SRC.indexOf('function openMeetingEditModal(') + 1500);
  assert.ok(editModal.includes('meetingWithOptionNames(m.meetingWith)'));
});

test('app.js dropdowns: a lead with no saved value defaults to its house\'s current manager', () => {
  const { app } = loadApp();
  applyCurrent(app, CURRENT);
  assert.match(app.meetingWithSelectHTML({ house: 'רמות השבים', meetingWith: '' }), /<option value="דנה" selected>/);
});

test('app.js dropdowns: a second current manager in the same house is still offered', () => {
  const { app } = loadApp();
  applyCurrent(app, [{ house: 'ramot', name: 'חדש' }, { house: 'ramot', name: 'ותיק' }]);
  assert.deepStrictEqual(arr(app.managerOptions()), ['חדש', 'ותיק']);
  assert.strictEqual(app.managerForHouse('ramot'), 'חדש');
});

test('app.js autosave: the meetingWith default written for a visit lead is the CURRENT manager', async () => {
  const { app, saves } = loadApp();
  applyCurrent(app, CURRENT);
  app.state.mode = 'edit';
  app.state.patients = [];
  app.state.leads = [{ id: 'L1', name: 'x', stage: 'visit', house: 'רמות השבים', meetingWith: '' }];
  await app.autosaveMeetingWithDefaults();
  assert.strictEqual(app.state.leads[0].meetingWith, 'דנה');
  assert.strictEqual(saves.length, 1);
});

/* ===== start_date (review follow-up) =====
 * CURRENT = (start_date blank OR start_date <= today) AND
 *           (end_date blank OR end_date >= today), today in Asia/Jerusalem. */

test('Code.gs: a FUTURE start_date is NOT current (and the tab still wins — no fallback)', () => {
  const { gs } = loadGs({
    Managers: fakeSheet('Managers', MANAGERS_HEADER, [
      ['ramot', 'עתידי', '2026-10-02', ''],               // starts tomorrow
      ['rehab', 'עתידית', '15/11/2026', '2027-01-01'],    // DD/MM future start
    ]),
    bonusconfig: bonusconfig(),
  });
  const out = gs.current(TODAY);
  assert.strictEqual(out.source, 'managers');
  assert.deepStrictEqual(arr(out.managers), []);
});

test('Code.gs: a BLANK start_date is current', () => {
  const { gs } = loadGs({ Managers: fakeSheet('Managers', MANAGERS_HEADER, [['ramot', 'דנה', '', '']]) });
  assert.deepStrictEqual(arr(gs.current(TODAY).managers), [{ house: 'ramot', name: 'דנה' }]);
});

test('Code.gs: start_date = today is current (string and Date cell)', () => {
  const { gs } = loadGs({
    Managers: fakeSheet('Managers', MANAGERS_HEADER, [
      ['ramot', 'דנה', TODAY, ''],
      ['rehab', 'רנטה', new Date('2026-10-01T00:00:00+03:00'), ''],
    ]),
  }, { sheetTz: 'UTC' });
  assert.deepStrictEqual(arr(gs.current(TODAY).managers), [{ house: 'ramot', name: 'דנה' }, { house: 'rehab', name: 'רנטה' }]);
});

test('Code.gs: an UNREADABLE start_date counts as blank → current', () => {
  const { gs } = loadGs({ Managers: fakeSheet('Managers', MANAGERS_HEADER, [['ramot', 'דנה', 'בקרוב', '']]) });
  assert.deepStrictEqual(arr(gs.current(TODAY).managers), [{ house: 'ramot', name: 'דנה' }]);
});

test('Code.gs: start and end together — the row must satisfy BOTH bounds', () => {
  const { gs } = loadGs({
    Managers: fakeSheet('Managers', MANAGERS_HEADER, [
      ['ramot',  'בטווח',  '2026-09-01', '2026-12-31'],   // inside → current
      ['rehab',  'עבר',    '2026-01-01', '2026-09-30'],   // ended → no
      ['efroni', 'עתיד',   '2026-11-01', '2026-12-31'],   // not started → no
      ['pardes', 'יום',    TODAY,        TODAY],          // one-day assignment today → current
    ]),
  });
  assert.deepStrictEqual(arr(gs.current(TODAY).managers), [{ house: 'pardes', name: 'יום' }, { house: 'ramot', name: 'בטווח' }]);
});

test('Code.gs managerDateIso_: a Date cell at 00:00 Asia/Jerusalem is that day — never the previous day, whatever the sheet zone', () => {
  const midnight = new Date('2026-10-01T00:00:00+03:00');   // = 2026-09-30T21:00:00Z
  for (const sheetTz of ['Asia/Jerusalem', 'UTC', 'America/New_York', 'Europe/London']) {
    const { gs } = loadGs({}, { sheetTz });
    assert.strictEqual(gs.managerDateIso(midnight), '2026-10-01', 'sheet zone ' + sheetTz);
  }
  const { gs } = loadGs({}, { sheetTz: 'UTC' });
  assert.strictEqual(gs.managerDateIso(new Date('2026-10-01T23:59:00+03:00')), '2026-10-01', 'late evening stays the same day');
  assert.strictEqual(gs.managerDateIso(new Date('invalid')), '');
  assert.strictEqual(gs.managerDateIso('2026-10-01'), '2026-10-01');
  assert.strictEqual(gs.managerDateIso('1/10/2026'), '2026-10-01');
});

test('Code.gs: an end_date Date cell at Jerusalem midnight TODAY keeps the manager current under a UTC sheet', () => {
  const { gs } = loadGs({
    Managers: fakeSheet('Managers', MANAGERS_HEADER, [['ramot', 'דנה', '', new Date('2026-10-01T00:00:00+03:00')]]),
  }, { sheetTz: 'UTC' });
  assert.deepStrictEqual(arr(gs.current(TODAY).managers), [{ house: 'ramot', name: 'דנה' }],
    'read as 2026-09-30 it would wrongly hide her a day early');
});

/* ===== rehab / רנטה end to end ===== */

test("rehab / 'רנטה': from the Managers tab, through getData's currentManagers, into the summary strip filter (exact string)", () => {
  const { gs } = loadGs({
    Managers: fakeSheet('Managers', MANAGERS_HEADER, [
      ['rehab', 'רנטה', '2025-01-01', ''],
      ['ramot', 'דנה',  '2026-09-01', ''],
    ]),
  });
  const data = gs.getData();
  assert.strictEqual(data.currentManagersSource, 'managers');
  assert.ok(data.currentManagers.some((m) => m.house === 'rehab' && m.name === 'רנטה'), 'rehab → רנטה in currentManagers');

  const { app } = loadApp();
  applyCurrent(app, arr(data.currentManagers));
  assert.ok(arr(app.managerOptions()).includes('רנטה'), 'רנטה is in the filter list, exact string');
  assert.strictEqual(app.managerForHouse('קיסריה ריהאב'), 'רנטה');
  const html = app.meetingsSummaryHTML([
    { id: '1', meetingWith: 'רנטה', meetingOutcome: 'entered' },
    { id: '2', meetingWith: 'רנטה ', meetingOutcome: 'entered' },   // trailing space: counted under רנטה
  ]);
  assert.ok(html.includes('<span class="mtg-sum-mgr">רנטה</span>'), 'the strip has a רנטה row');
  assert.match(html, /נכנסו: <b>2<\/b>/);
});

/* ===== Follow-up coverage (2026-10-06) =====
 * Escaping of a Managers-tab name end to end, and a SAVED former manager on a
 * meeting: displayed unchanged and never rewritten by the default autosave. */

const HOSTILE = '<img src=x onerror="alert(1)">&\'';

test('escaping: a hostile Managers-tab name passes through Code.gs as-is and is HTML-escaped by every renderer', () => {
  const { gs } = loadGs({ Managers: fakeSheet('Managers', MANAGERS_HEADER, [['ramot', HOSTILE, '', '']]) });
  const out = arr(gs.current(TODAY));
  assert.deepStrictEqual(out, { source: 'managers', managers: [{ house: 'ramot', name: HOSTILE }] },
    'the backend never mangles the cell — escaping is the renderer\'s job');

  const { app } = loadApp();
  applyCurrent(app, out.managers);
  const esc = '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;&#39;';
  const strip = app.meetingsSummaryHTML([{ id: '1', meetingWith: HOSTILE, meetingOutcome: 'entered' }]);
  assert.ok(strip.includes(esc), 'summary strip escapes the name');
  const select = app.meetingWithSelectHTML({ house: 'רמות השבים', meetingWith: '' });
  assert.ok(select.includes('<option value="' + esc + '" selected>' + esc + '</option>'), 'dropdown escapes value and label');
  app.state.mode = 'view';
  const row = app.meetingRowHTML({ id: 'L1', name: 'x', meetingWith: HOSTILE }, '10:00', false);
  assert.ok(row.includes('<span class="mtg-with">' + esc + '</span>'), 'meeting row escapes the saved name');
  for (const html of [strip, select, row]) assert.ok(!/<img/i.test(html), 'no raw tag survives');
});

test('former manager: a meeting saved with an ended manager is displayed unchanged and never rewritten', async () => {
  const { gs } = loadGs({ Managers: fakeSheet('Managers', MANAGERS_HEADER, [
    ['ramot', 'אורן', '2025-01-01', '2026-09-30'],   // ended yesterday
    ['ramot', 'דנה', '2026-10-01', ''],              // current from today
  ]) });
  const out = arr(gs.current(TODAY));
  assert.deepStrictEqual(out.managers, [{ house: 'ramot', name: 'דנה' }], 'only the current manager is sent');

  const { app, saves } = loadApp();
  applyCurrent(app, out.managers);
  app.state.mode = 'edit';
  app.state.patients = [];
  const saved = { id: 'L1', name: 'x', stage: 'visit', house: 'רמות השבים', meetingWith: 'אורן', meetingOutcome: 'entered' };
  app.state.leads = [saved];

  // the meetings row shows the saved value exactly
  assert.ok(app.meetingRowHTML(saved, '10:00', false).includes('<span class="mtg-with">אורן</span>'));
  // the dropdown keeps it selected, the current manager is offered alongside
  const sel = app.meetingWithSelectHTML(saved);
  assert.match(sel, /<option value="אורן" selected>אורן<\/option>/);
  assert.match(sel, /<option value="דנה" >דנה<\/option>/);
  // the strip hides the former manager's row but does not touch the lead
  assert.strictEqual(app.meetingsSummaryHTML(app.state.leads), '');
  // the default autosave never overwrites a saved value
  await app.autosaveMeetingWithDefaults();
  assert.strictEqual(saved.meetingWith, 'אורן');
  assert.strictEqual(saves.length, 0, 'nothing written');
});

