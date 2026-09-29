/* diagnoseRamotPatientsNow() — the READ-ONLY, editor-run diagnostic for the
 * missing-ramot-patient investigation (apps-script/Code.gs).
 *
 * Locked here:
 *   1. It is READ-ONLY, proven two ways:
 *      - SOURCE: neither the function nor ANY Code.gs helper it reaches
 *        (transitive closure) calls setValue / setValues / appendRow /
 *        deleteRow / insertRow / clear* — nor any other mutator, the
 *        sheet-creating getOrCreateSheet_, logAudit_, a lock or a property;
 *      - RUNTIME: it runs to completion against a spreadsheet whose every
 *        non-read method THROWS and records the attempt — zero attempts.
 *   2. It is not reachable over HTTP (handle_ never names it).
 *   3. Sections (0)/(a)/(b)/(c)/(d) report what they promise on synthetic
 *      Hebrew data: every ramot house form (id / label / padded / invisible
 *      mark / U+FFFD), the Dashboard verdict per Patients row, U+FFFD names in
 *      ANY tab, duplicate ids and phones across tabs, identity twins, header
 *      drift, and the summary line.
 *   4. Its verdicts mirror public/app.js exactly (resolveHouseId,
 *      normalizeStatus), so "VISIBLE / HIDDEN" in the log is what the
 *      Dashboard really does.
 *   5. Section (e), ANY house: every Patients / PatientsTombstones row whose
 *      house resolves to no known house id (with a one-house "looks like"
 *      hint, never a guess), and every PatientsTombstones 'user-delete' row
 *      from the last 60 days (frozen clock) — deleter, date, and whether the
 *      patient is back on Patients; older ones counted, unreadable dates
 *      listed. The SUMMARY stays the last line and carries the (e) counts.
 *   6. The re-land is ADDITIVE only: every diag helper name is declared once
 *      in Code.gs (Apps Script lets a second declaration silently replace the
 *      first), and the section runs nothing at script load.
 * All names, ids and phone numbers are SYNTHETIC. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const GS_SRC = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const arr = (x) => Array.from(x);
const FFFD = String.fromCharCode(0xfffd);   // U+FFFD REPLACEMENT CHARACTER
const RLM = String.fromCharCode(0x200f);    // U+200F RIGHT-TO-LEFT MARK (invisible)
const LABEL = 'רמות השבים';

/* ---------- a spreadsheet that can only be READ ---------- */
/* Every method a test does not list as a reader throws and is recorded in
 * `attempts` — a write, a format change, a new tab, anything. */
function trap(readers, label, attempts) {
  return new Proxy(readers, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === 'symbol' || prop === 'then' || prop === 'toJSON') return undefined;
      return () => {
        attempts.push(label + '.' + String(prop));
        throw new Error('read-only fake: ' + label + '.' + String(prop) + ' is not allowed');
      };
    },
  });
}
function roSheet(name, header, rows, attempts) {
  const grid = [header.slice()].concat(rows.map((r) => r.slice()));
  const width = () => grid.reduce((m, r) => Math.max(m, r.length), 0);
  return trap({
    getName: () => name,
    getLastRow: () => grid.length,
    getLastColumn: () => width(),
    getMaxColumns: () => Math.max(26, width()),
    getMaxRows: () => Math.max(1000, grid.length),
    getRange: (r, c, nr, nc) => {
      nr = nr || 1; nc = nc || 1;
      const read = () => {
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
      };
      return trap({ getValues: read, getValue: () => read()[0][0] }, 'Range(' + name + ')', attempts);
    },
  }, 'Sheet(' + name + ')', attempts);
}

/* A Date whose no-argument form is pinned to `iso` — section (e)'s 60-day
 * window is relative to "now", so its tests freeze the clock. */
function frozenDate(iso) {
  const fixed = new Date(iso).getTime();
  return class FrozenDate extends Date {
    constructor(...a) { if (a.length === 0) super(fixed); else super(...a); }
    static now() { return fixed; }
  };
}

function loadCode(tabs, nowIso) {
  const attempts = [];
  const logs = [];
  const sheets = (tabs || []).map((t) => roSheet(t.name, t.header, t.rows, attempts));
  const ss = trap({
    getSheetByName: (n) => sheets.find((s) => s.getName() === n) || null,
    getSheets: () => sheets.slice(),
    getSpreadsheetTimeZone: () => 'Asia/Jerusalem',
  }, 'Spreadsheet', attempts);
  const sandbox = {
    console: { log() {}, warn() {}, error() {}, info() {} },
    JSON, Math, Date: nowIso ? frozenDate(nowIso) : Date, Number, String, Array, Object, RegExp, isFinite,
    Logger: { log: (m) => logs.push(String(m)) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    Utilities: { formatDate: (d) => d.toISOString().slice(0, 10), getUuid: () => { attempts.push('Utilities.getUuid'); return 'x'; } },
    LockService: { getScriptLock: () => { attempts.push('LockService.getScriptLock'); throw new Error('no lock in a read-only diagnostic'); } },
    PropertiesService: { getScriptProperties: () => { attempts.push('PropertiesService'); throw new Error('no properties in a read-only diagnostic'); } },
    ContentService: {
      createTextOutput: (s) => ({ setMimeType: () => ({ json: JSON.parse(s) }) }),
      MimeType: { JSON: 'json' },
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(GS_SRC + `
    globalThis.__cols = {
      LEAD_COLUMNS, PATIENT_COLUMNS, DISCHARGED_PATIENT_COLUMNS, IRRELEVANT_LEAD_COLUMNS,
      REMOVED_LEAD_COLUMNS, PATIENT_TOMBSTONE_COLUMNS, OUTPATIENT_COLUMNS, AUDIT_LOG_COLUMNS,
      LEADS_SHEET, PATIENTS_SHEET, DISCHARGED_PATIENTS_SHEET, IRRELEVANT_LEADS_SHEET,
      REMOVED_LEADS_SHEET, PATIENTS_TOMBSTONES_SHEET, OUTPATIENTS_SHEET, AUDIT_LOG_SHEET,
    };`, sandbox);
  return { sandbox, attempts, logs, C: sandbox.__cols };
}

const rowOf = (cols, f) => arr(cols).map((c) => (f[c] === undefined ? '' : f[c]));

/* ---------- the synthetic spreadsheet every behavioral test uses ---------- */
function world() {
  const { C } = loadCode([]);
  const P = (f) => rowOf(C.PATIENT_COLUMNS, f);
  const D = (f) => rowOf(C.DISCHARGED_PATIENT_COLUMNS, f);
  const L = (f) => rowOf(C.LEAD_COLUMNS, f);
  const I = (f) => rowOf(C.IRRELEVANT_LEAD_COLUMNS, f);
  const R = (f) => rowOf(C.REMOVED_LEAD_COLUMNS, f);
  const T = (f) => rowOf(C.PATIENT_TOMBSTONE_COLUMNS, f);
  const removedHeader = arr(C.REMOVED_LEAD_COLUMNS);
  // Header drift on the removed-leads tab: two columns swapped by hand.
  const drifted = removedHeader.slice();
  [drifted[1], drifted[2]] = [drifted[2], drifted[1]];
  const base = { date: '2026-06-01', pay: 9000, source: 'direct_admin' };
  return [
    { name: C.PATIENTS_SHEET, header: arr(C.PATIENT_COLUMNS), rows: [
      P({ ...base, id: 'id-p2', houseId: 'ramot', name: 'אלף בדיקה', status: 'active', fromLead: 'lead-1' }),  // row 2
      P({ ...base, id: 'id-p3', houseId: LABEL, name: 'בית בדיקה', status: 'active' }),                         // row 3
      P({ ...base, id: 'id-p4', houseId: 'ramot ', name: 'גימל בדיקה', status: 'trial' }),                      // row 4
      P({ ...base, id: 'id-p5', houseId: 'ramot' + RLM, name: 'דלת בדיקה', status: 'active' }),                // row 5
      P({ ...base, id: 'id-p6', houseId: 'ramot', name: 'הא בדיקה', status: 'released', exitDate: '2026-09-01' }), // row 6
      P({ ...base, id: 'id-p7', houseId: 'ramot', name: 'וו בדיקה', status: 'active' }),                        // row 7
      P({ ...base, id: 'id-p8', houseId: 'ramot', name: 'זין בד' + FFFD + FFFD + 'קה', status: 'active' }),    // row 8
      P({ ...base, id: 'id-p9', houseId: '', name: 'חית בדיקה', status: 'active' }),                            // row 9
      P({ ...base, id: 'id-p10', houseId: 'arfoni', name: 'טית בדיקה', status: 'active' }),                     // row 10
      P({ ...base, id: 'id-p11', houseId: 'רמ' + FFFD + FFFD + 'ת השבים', name: 'יוד בדיקה', status: 'active' }), // row 11
      P({ ...base, id: 'id-p12', houseId: 'ramot', name: 'אלף בדיקה', status: 'released', fromLead: 'lead-1' }), // row 12 — twin of row 2
    ] },
    { name: C.DISCHARGED_PATIENTS_SHEET, header: arr(C.DISCHARGED_PATIENT_COLUMNS), rows: [
      D({ ...base, id: 'aud-7', houseId: 'ramot', name: 'וו בדיקה', status: 'released', dischargedAt: '2026-09-02T08:00:00.000Z', disposition: 'completed', restored: '' }), // row 2 — OPEN
      D({ ...base, id: 'aud-6', houseId: 'ramot', name: 'הא בדיקה', status: 'released', dischargedAt: '2026-09-01T08:00:00.000Z', disposition: 'completed', restored: true }), // row 3 — closed (boolean)
      D({ ...base, id: 'id-p2', houseId: 'ramot', name: 'אלף בדיקה', status: 'released', restored: 'TRUE' }), // row 4 — shares a Patients id
    ] },
    { name: C.LEADS_SHEET, header: arr(C.LEAD_COLUMNS), rows: [
      L({ id: 'lead-1', name: 'אלף בדיקה', phone: '050-000-0001', house: LABEL, stage: 'admitted' }),   // row 2
      L({ id: 'lead-2', name: 'כף בד' + FFFD + 'קה', phone: '0500000002', house: 'קיסריה עפרוני', stage: 'new' }), // row 3
      L({ id: 'lead-3', name: 'למד בדיקה', phone: '', house: LABEL, stage: 'visit' }),                 // row 4
    ] },
    { name: C.IRRELEVANT_LEADS_SHEET, header: arr(C.IRRELEVANT_LEAD_COLUMNS), rows: [
      I({ id: 'lead-4', name: 'מם בדיקה', phone: '0500000004', house: LABEL, stage: 'irrelevant', disposition: 'completed', movedAt: '2026-08-01T10:00:00.000Z' }),
    ] },
    { name: C.REMOVED_LEADS_SHEET, header: drifted, rows: [
      R({ id: 'lead-5', name: 'נון בדיקה', phone: 972500000001, house: LABEL, stage: 'new', removedAt: '2026-08-02T10:00:00.000Z' }),
    ] },
    { name: C.PATIENTS_TOMBSTONES_SHEET, header: arr(C.PATIENT_TOMBSTONE_COLUMNS), rows: [
      T({ ...base, houseId: 'ramot', name: 'סמך בדיקה', status: 'active', reason: 'user-delete', droppedAt: '2026-09-10T08:00:00.000Z', savedByAction: 'deletePatientRow', id: 'id-gone' }),
      T({ ...base, houseId: 'ramot', name: 'אלף בדיקה', status: 'active', reason: 'saveAll-omitted-preserved', droppedAt: '2026-09-11T08:00:00.000Z' }),
      T({ ...base, houseId: 'ramot', name: 'אלף בדיקה', status: 'active', reason: 'saveAll-omitted-preserved', droppedAt: '2026-09-12T08:00:00.000Z' }),
    ] },
    { name: C.OUTPATIENTS_SHEET, header: arr(C.OUTPATIENT_COLUMNS), rows: [
      rowOf(C.OUTPATIENT_COLUMNS, { patient_name: 'עין בדיקה', house_of_origin: 'ramot', therapy_type: 'maintenance' }),
    ] },
    { name: 'Clients', header: ['id', 'name', 'phone', 'location', 'status'], rows: [
      ['cl-1', 'פא בד' + FFFD + 'קה', '0500000009', LABEL, 'פעיל'],
      ['cl-2', 'צדי בדיקה', '0500000010', 'רעננה', 'פעיל'],
    ] },
    { name: C.AUDIT_LOG_SHEET, header: arr(C.AUDIT_LOG_COLUMNS), rows: [
      rowOf(C.AUDIT_LOG_COLUMNS, { timestamp: '2026-08-15T10:00:00.000Z', action: 'patient_edited', name: 'קוף ב' + FFFD + FFFD + 'יקה' }),
    ] },
  ];
}

function run() {
  const h = loadCode(world());
  const report = h.sandbox.diagnoseRamotPatientsNow();
  return Object.assign(h, { report: JSON.parse(JSON.stringify(report)) });
}

/* ===== 1. READ-ONLY — source ===== */

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
}
/* String literals emptied: a function NAME inside a log message is not a call. */
function stripStrings(src) {
  return src.replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, '""');
}

/* The diagnostic + every Code.gs function it reaches, by name → source. */
function reachableFunctions() {
  const { sandbox } = loadCode([]);
  const out = {};
  const queue = ['diagnoseRamotPatientsNow'];
  while (queue.length) {
    const name = queue.shift();
    if (out[name]) continue;
    assert.strictEqual(typeof sandbox[name], 'function', 'not a Code.gs function: ' + name);
    const src = sandbox[name].toString();
    out[name] = src;
    const calls = stripStrings(stripComments(src)).match(/\b[A-Za-z_$][\w$]*(?=\s*\()/g) || [];
    calls.forEach((id) => {
      if (!out[id] && typeof sandbox[id] === 'function' && GS_SRC.includes('function ' + id + '(')) queue.push(id);
    });
  }
  return out;
}

test('diagnoseRamotPatientsNow never calls setValue/setValues/appendRow/deleteRow/insertRow/clear', () => {
  const src = stripComments(reachableFunctions().diagnoseRamotPatientsNow);
  [/\.setValues?\s*\(/, /\.appendRow\s*\(/, /\.deleteRows?\s*\(/, /\.insertRow\w*\s*\(/, /\.clear\w*\s*\(/].forEach((re) => {
    assert.ok(!re.test(src), 'diagnoseRamotPatientsNow must not match ' + re);
  });
});

test('...and neither does ANY Code.gs helper it reaches — nor any other mutator, lock, property or sheet-creating path', () => {
  const fns = reachableFunctions();
  const names = Object.keys(fns);
  // It really does lean on shared helpers, so the closure is meaningful.
  ['diagReadSheet_', 'diagRamotHouseMatch_', 'diagClientHouseId_', 'diagClientStatus_', 'hasCorruption_',
    'corruptionWildcardRegex_', 'normalizePhone_', 'asISODate_',
    'diagKnownHouseIds_', 'diagHouseLookalike_', 'diagTimeMs_'].forEach((n) => {
    assert.ok(names.includes(n), 'expected the diagnostic to reach ' + n);
  });
  const FORBIDDEN = [
    /\.setValues?\s*\(/, /\.appendRow\s*\(/, /\.deleteRows?\s*\(/, /\.insertRow\w*\s*\(/, /\.clear\w*\s*\(/,
    /\.set[A-Z]\w*\s*\(/, /\.insert\w*\s*\(/, /\.delete\w*\s*\(/, /\.hideSheet\s*\(/, /\.sort\s*\(/,
    /\.copyTo\s*\(/, /\.moveTo\s*\(/, /\.protect\s*\(/, /\bgetOrCreateSheet_\s*\(/, /\blogAudit_\s*\(/,
    /\bLockService\b/, /\bPropertiesService\b/, /\bUrlFetchApp\b/, /\bMailApp\b/, /\bDriveApp\b/,
  ];
  names.forEach((n) => {
    const src = stripComments(fns[n]);
    FORBIDDEN.forEach((re) => assert.ok(!re.test(src), n + ' (reached by the diagnostic) must not match ' + re));
  });
});

/* ===== 1b. READ-ONLY — runtime ===== */

test('runs end to end against a spreadsheet whose every mutator throws — ZERO write attempts', () => {
  const { attempts, logs, report } = run();
  assert.deepStrictEqual(attempts, [], 'no write / lock / property / uuid attempt of any kind');
  assert.ok(logs.length > 10, 'it logged its findings');
  assert.match(logs[0], /READ-ONLY/);
  assert.match(logs[logs.length - 1], /^\(d\) SUMMARY ramot/);
  assert.match(logs[logs.length - 1], /No writes performed\.$/);
  assert.ok(Array.isArray(report.lines) && report.lines.length === logs.length, 'the report returns the same lines');
});

test('an EMPTY spreadsheet (no tabs at all) is reported, not crashed on, and creates nothing', () => {
  const h = loadCode([]);
  const report = h.sandbox.diagnoseRamotPatientsNow();
  assert.deepStrictEqual(h.attempts, [], 'getOrCreateSheet_ would have inserted tabs here');
  assert.ok(h.logs.some((l) => /\(0\) Patients: no such tab/.test(l)));
  assert.ok(h.logs.some((l) => /\(0\) Clients: no such tab \(expected/.test(l)));
  assert.strictEqual(report.summary.dashboardVisible, 0);
});

/* ===== 2. not reachable over HTTP ===== */

test('not reachable over HTTP: handle_ never names it and answers unknown_action', () => {
  const handleSrc = GS_SRC.slice(GS_SRC.indexOf('function handle_('), GS_SRC.indexOf('function collectParams_('));
  assert.ok(!/diagnoseRamot|diagRamot/.test(handleSrc));
  const { sandbox } = loadCode([]);
  const out = sandbox.handle_({ action: 'diagnoseRamotPatientsNow' }).json;
  assert.deepStrictEqual(JSON.parse(JSON.stringify(out)), { ok: false, error: 'unknown_action', action: 'diagnoseRamotPatientsNow' });
  assert.ok(/\nfunction diagnoseRamotPatientsNow\(\)/.test(GS_SRC), 'public (no underscore) so it is in the editor Run dropdown');
});

/* ===== 3. what each section reports ===== */

const find = (report, sheet, row) => report.ramotRows.find((e) => e.sheet === sheet && e.row === row);

test('(a) every ramot house form is found and classified — id, label, padded, invisible mark, U+FFFD', () => {
  const { report } = run();
  assert.strictEqual(find(report, 'Patients', 2).house, 'id');
  assert.strictEqual(find(report, 'Patients', 3).house, 'label');
  assert.strictEqual(find(report, 'Patients', 4).house, 'variant');
  assert.strictEqual(find(report, 'Patients', 5).house, 'variant', 'an invisible RTL mark still reads as ramot here');
  assert.strictEqual(find(report, 'Patients', 11).house, 'corrupted');
  assert.strictEqual(find(report, 'Patients', 10), undefined, 'another house is not listed');
  assert.strictEqual(find(report, 'Leads', 2).house, 'label');
  assert.strictEqual(find(report, 'Leads', 3), undefined);
  assert.ok(find(report, 'לידים לא רלוונטיים', 2));
  assert.ok(find(report, 'Clients', 2), 'the Clients tab is read by its own header');
  assert.strictEqual(find(report, 'Clients', 3), undefined);
  assert.ok(find(report, 'Outpatients', 2), 'house_of_origin counts');
  assert.ok(find(report, 'PatientsTombstones', 2), 'a user-delete recovery copy is listed individually');
});

test('(a) every Patients line carries the Dashboard\'s real verdict', () => {
  const { report } = run();
  assert.match(find(report, 'Patients', 2).verdict, /^VISIBLE in the ramot tab \(active\)/);
  assert.match(find(report, 'Patients', 3).verdict, /^VISIBLE/, 'the app resolves the Hebrew label');
  assert.match(find(report, 'Patients', 4).verdict, /^VISIBLE/, 'the app trims');
  assert.match(find(report, 'Patients', 5).verdict, /^HIDDEN — the app resolves house/, 'the app does NOT strip invisible marks');
  assert.ok(find(report, 'Patients', 5).verdict.endsWith('to "ramot\\u200f", not the ramot tab'),
    'the resolved value is printed visibly too: ' + find(report, 'Patients', 5).verdict);
  assert.match(find(report, 'Patients', 6).verdict, /^HIDDEN — status "released"/);
  assert.match(find(report, 'Patients', 7).verdict, /the next load's heal will mark it released/,
    'an open discharge record on a live row is flagged BEFORE it disappears');
  assert.match(find(report, 'Patients', 7).verdict, /מטופלים משוחררים row 2/);
  assert.match(find(report, 'Patients', 8).verdict, /^VISIBLE/, 'a U+FFFD name is still shown');
  assert.match(find(report, 'Patients', 11).verdict, /^HIDDEN — the app resolves house/);
  const blank = report.blankHouseRows.find((e) => e.row === 9);
  assert.ok(blank, 'a Patients row with NO house is listed');
  assert.strictEqual(blank.verdict, 'DROPPED by getData_ (blank houseId) — invisible in every tab');
});

test('(a) discharge rows say whether they are open, and what the heal will do with them', () => {
  const { report } = run();
  assert.match(find(report, 'מטופלים משוחררים', 2).verdict, /^OPEN — matches Patients row 7; the heal acts on row 7 .*WILL BE MARKED RELEASED/);
  assert.match(find(report, 'מטופלים משוחררים', 3).verdict, /^closed \(restored\)/, 'a boolean TRUE restored flag counts');
  assert.match(find(report, 'מטופלים משוחררים', 4).verdict, /^closed \(restored\)/, "the 'TRUE' string counts");
});

test('(a) phones are normalized, and recovered through fromLead for Patients rows', () => {
  const { report } = run();
  assert.strictEqual(find(report, 'Leads', 2).phone, '0500000001');
  assert.strictEqual(find(report, 'Patients', 2).phone, '0500000001 (via fromLead lead-1)');
  assert.strictEqual(find(report, 'לידים שהוסרו', 2).phone, '0500000001', 'a number-typed 972… cell');
});

test('(a) merge-don\'t-drop audit copies are aggregated per name, not one line each', () => {
  const { logs } = run();
  const agg = logs.filter((l) => /saveAll-omitted-preserved ×2 for name "אלף בדיקה"/.test(l));
  assert.strictEqual(agg.length, 1);
  assert.match(agg[0], /last 2026-09-12T08:00:00.000Z/);
});

test('(a) the log shows invisible characters instead of hiding them', () => {
  const { logs } = run();
  const line = logs.find((l) => /^\(a\) Patients row 5 /.test(l));
  assert.ok(line.includes('"ramot\\u200f"'), 'the RTL mark is printed as \\u200f: ' + line);
  assert.ok(logs.find((l) => /^\(a\) Patients row 8 /.test(l)).includes('[U+FFFD]'));
});

test('(b) U+FFFD names are listed from EVERY tab, with sheet and row', () => {
  const { report } = run();
  const where = report.corruptedNames.map((c) => c.sheet + ':' + c.row).sort();
  assert.deepStrictEqual(where, ['AuditLog:2', 'Clients:2', 'Leads:3', 'Patients:8'].sort());
});

test('(c) duplicate ids and phones — within and across tabs — and ramot identity twins', () => {
  const { report } = run();
  const dup = (kind, v) => report.duplicates.find((d) => d.kind === kind && d.value === v);
  assert.deepStrictEqual(dup('id', 'id-p2').at, ['Patients row 2 [ramot]', 'מטופלים משוחררים row 4 [ramot]']);
  assert.deepStrictEqual(dup('phone', '0500000001').at, ['Leads row 2 [ramot]', 'לידים שהוסרו row 2 [ramot]'],
    'the same phone, once dashes and the 972 prefix are normalized');
  const key = report.twins.find((t) => t.kind === 'key');
  assert.ok(key && /אלף בדיקה::2026-06-01$/.test(key.value));
  assert.deepStrictEqual(key.at, ['row 2 ("active")', 'row 12 ("released")']);
  assert.deepStrictEqual(report.twins.find((t) => t.kind === 'fromLead').at, ['row 2 ("active")', 'row 12 ("released")']);
});

test('(0) a column inserted by hand shifts every field: DRIFT is reported, and the lines show the misread', () => {
  const C = loadCode([]).C;
  const header = arr(C.PATIENT_COLUMNS);
  header.splice(1, 0, 'הערה');                        // someone inserted a column B
  const row = rowOf(C.PATIENT_COLUMNS, { houseId: 'ramot', name: 'אלף בדיקה', date: '2026-06-01', status: 'active' });
  row.splice(1, 0, 'x');
  const h = loadCode([{ name: C.PATIENTS_SHEET, header, rows: [row] }]);
  const report = JSON.parse(JSON.stringify(h.sandbox.diagnoseRamotPatientsNow()));
  assert.deepStrictEqual(h.attempts, []);
  assert.ok(h.logs.some((l) => /^\(0\) Patients: .*DRIFT — col 2 expected "name" found "הערה"/.test(l)));
  assert.deepStrictEqual(report.summary.headerDrift, ['Patients']);
  const e = report.ramotRows.find((x) => x.sheet === 'Patients' && x.row === 2);
  assert.strictEqual(e.name, 'x', 'the app reads the inserted column as the name — the log shows exactly that');
});

test('(0) header drift is reported loudly with the exact columns', () => {
  const { logs, report } = run();
  const line = logs.find((l) => /^\(0\) לידים שהוסרו:/.test(l));
  assert.match(line, /DRIFT — col 2 expected "name" found "phone"; col 3 expected "phone" found "name"/);
  assert.deepStrictEqual(report.summary.headerDrift, ['לידים שהוסרו']);
  assert.ok(logs.some((l) => /^\(0\) Patients: 11 data row\(s\); header OK$/.test(l)));
});

test('(d) the summary line counts ramot rows per tab and per status, and the Dashboard outcome', () => {
  const { report, logs } = run();
  const s = report.summary;
  assert.deepStrictEqual(s.counts.Patients, { rows: 9, by: { active: 6, trial: 1, released: 2 } }, 'rows 2,3,5,7,8,11 · 4 · 6,12');
  assert.deepStrictEqual(s.counts['מטופלים משוחררים'], { rows: 3, by: { OPEN: 1, restored: 2 } });
  assert.deepStrictEqual(s.counts.Outpatients, { rows: 1, by: { 'n/a': 1 } }, 'a tab with no status column');
  assert.strictEqual(s.dashboardVisible, 5, 'rows 2, 3, 4, 7, 8');
  assert.strictEqual(s.hiddenReleased, 2, 'rows 6, 12');
  assert.strictEqual(s.hiddenHouse, 2, 'rows 5, 11');
  assert.strictEqual(s.healPending, 1, 'row 7');
  assert.strictEqual(s.blankHouse, 1);
  assert.strictEqual(s.corruptedNames, 4);
  const line = logs[logs.length - 1];
  assert.match(line, /Patients: 9 \(active 6 · trial 1 · released 2\)/);
  assert.match(line, /shows 5, hides 2 released, 2 with an unresolvable house; 1 will be released by the next load's heal/);
});

/* ===== 4. the verdicts mirror public/app.js ===== */

function loadApp() {
  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/' },
    document: { addEventListener: noop, getElementById: () => null, querySelectorAll: () => [] },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    setTimeout: noop, URLSearchParams, Math, Date, JSON, Number, String, Array, Object, RegExp, Promise,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(APP_SRC + `
    globalThis.__app = { resolveHouseId, normalizeStatus, STATUS_ALIASES, HOUSES };`, sandbox);
  return sandbox.__app;
}

test('diagClientStatus_ is app.js normalizeStatus, alias for alias', () => {
  const app = loadApp();
  const { sandbox } = loadCode([]);
  const inputs = Object.keys(app.STATUS_ALIASES)
    .concat(['', ' ', null, undefined, 'Released', ' שוחרר ', 'יצא', 'something else', 0, true]);
  inputs.forEach((v) => {
    assert.strictEqual(sandbox.diagClientStatus_(v), app.normalizeStatus(v), 'status ' + JSON.stringify(v));
  });
});

test('diagClientHouseId_ is app.js resolveHouseId, for every house and every variant', () => {
  const app = loadApp();
  const { sandbox } = loadCode([]);
  const inputs = [];
  arr(app.HOUSES).forEach((h) => { inputs.push(h.id, h.name, ' ' + h.id + ' ', h.id.toUpperCase(), h.name + ' ', h.id + RLM); });
  inputs.push('', ' ', null, undefined, 'unknown', 'רמ' + FFFD + 'ת השבים', 'רמות');
  inputs.forEach((v) => {
    assert.strictEqual(sandbox.diagClientHouseId_(v), app.resolveHouseId(v), 'house ' + JSON.stringify(v));
  });
});

test('diagRamotHouseMatch_: recall on every ramot form, nothing from the other houses', () => {
  const { sandbox } = loadCode([]);
  const m = (v) => sandbox.diagRamotHouseMatch_(v);
  assert.strictEqual(m('ramot'), 'id');
  assert.strictEqual(m(LABEL), 'label');
  ['RAMOT', ' ramot', 'ramot' + RLM, 'רמות  השבים', 'רמות-השבים', 'רמות', 'רמת השבים', LABEL + ' '].forEach((v) => {
    assert.strictEqual(m(v), 'variant', JSON.stringify(v));
  });
  assert.strictEqual(m('רמות ה' + FFFD + FFFD + 'בים'), 'corrupted');
  assert.strictEqual(m(FFFD + FFFD + 'mot'), 'corrupted');
  ['arfoni', 'rehab', 'asher', 'pardes', 'sde', 'קיסריה עפרוני', 'קיסריה ריהאב', 'רעננה אשר', 'רעננה הפרדס',
    'שדה אליעזר', '', null, undefined, FFFD].forEach((v) => {
    assert.strictEqual(m(v), '', JSON.stringify(v));
  });
});

test('diagPhoneKey_: dashes, +972 and a Sheets-dropped leading zero all collapse; junk never matches', () => {
  const { sandbox } = loadCode([]);
  const k = (v) => sandbox.diagPhoneKey_(v);
  assert.strictEqual(k('050-000-0001'), '0500000001');
  assert.strictEqual(k('+972 50 000 0001'), '0500000001');
  assert.strictEqual(k(972500000001), '0500000001');
  assert.strictEqual(k(500000001), '0500000001', 'a number-typed cell lost its leading 0');
  assert.strictEqual(k('03-0000000'), '030000000', 'a 9-digit landline');
  ['', null, undefined, '12', 'לא ידוע'].forEach((v) => assert.strictEqual(k(v), '', JSON.stringify(v)));
});

/* ===== 5. section (e) — ANY house ===== */

const NOW = '2026-09-29T12:00:00.000Z';
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (d) => new Date(new Date(NOW).getTime() - d * DAY).toISOString();

/* A dedicated spreadsheet for (e): other houses, known-but-oddly-written
 * houses (NOT listed), unresolvable ones (listed), and user-delete tombstones
 * inside, at the edge of, and outside the 60-day window. */
function worldE() {
  const { C } = loadCode([]);
  const P = (f) => rowOf(C.PATIENT_COLUMNS, f);
  const T = (f) => rowOf(C.PATIENT_TOMBSTONE_COLUMNS, f);
  const base = { date: '2026-05-01', pay: 9000, status: 'active', source: 'direct_admin' };
  return [
    { name: C.PATIENTS_SHEET, header: arr(C.PATIENT_COLUMNS), rows: [
      P({ ...base, id: 'id-e2', houseId: 'asher', name: 'אלף' }),                                   // row 2  known
      P({ ...base, id: 'id-e3', houseId: 'רעננה אשר', name: 'בית' }),                                // row 3  known (label)
      P({ ...base, id: 'id-e4', houseId: ' Pardes ', name: 'גימל' }),                                // row 4  known (trim + case)
      P({ ...base, id: 'id-e5', houseId: 'SDE', name: 'דלת' }),                                      // row 5  known (case)
      P({ ...base, id: 'id-e6', houseId: 'asherr', name: 'הא' }),                                    // row 6  UNRESOLVED, no lookalike
      P({ ...base, id: 'id-e7', houseId: 'רעננה  אשר', name: 'וו' }),                               // row 7  UNRESOLVED → asher
      P({ ...base, id: 'id-e8', houseId: 'arfoni' + RLM, name: 'זין', fromLead: 'lead-e8' }),       // row 8  UNRESOLVED → arfoni
      P({ ...base, id: 'id-e9', houseId: 'קיסריה ר' + FFFD + 'האב', name: 'חית' }),                  // row 9  UNRESOLVED → rehab
      P({ ...base, id: 'id-e10', houseId: FFFD, name: 'טית' }),                                      // row 10 UNRESOLVED, no lookalike
      P({ ...base, id: 'id-e11', houseId: '', name: 'יוד' }),                                        // row 11 NO HOUSE
      P({ ...base, id: 'id-back', houseId: 'ramot', name: 'שב לבית', date: '2026-04-01' }),          // row 12 re-added (same id)
      P({ ...base, id: 'id-new', houseId: 'arfoni', name: 'שב שוב', date: '2026-04-02' }),           // row 13 re-added (same stay)
    ] },
    { name: C.PATIENTS_TOMBSTONES_SHEET, header: arr(C.PATIENT_TOMBSTONE_COLUMNS), rows: [
      T({ ...base, houseId: 'ramot', name: 'נמחק לאחרונה', reason: 'user-delete', savedByAction: 'deletePatientRow',
        droppedAt: daysAgo(9), id: 'id-d2', updatedAt: daysAgo(9), updatedBy: 'ורד' }),             // row 2  listed (9 days)
      T({ ...base, houseId: 'asher', name: 'בקצה החלון', reason: 'user-delete', droppedAt: daysAgo(60), id: 'id-d3' }), // row 3 listed (exactly 60)
      T({ ...base, houseId: 'asher', name: 'ישן', reason: 'user-delete', droppedAt: daysAgo(61), id: 'id-d4' }), // row 4 older → counted only
      T({ ...base, houseId: 'rehab', name: 'תאריך חסר', reason: 'user-delete', droppedAt: '', id: 'id-d5' }), // row 5 UNREADABLE → listed
      T({ ...base, houseId: 'ramot', name: 'שב לבית', date: '2026-04-01', reason: 'user-delete',
        droppedAt: new Date(new Date(NOW).getTime() - 3 * DAY), id: 'id-back' }),                   // row 6 Date cell; back by id
      T({ ...base, houseId: 'arfoni', name: 'שב שוב', date: '2026-04-02', reason: 'user-delete',
        droppedAt: daysAgo(2), id: '' }),                                                             // row 7 back by stay (no id)
      T({ ...base, houseId: 'asherr', name: 'הא', reason: 'saveAll-omitted-preserved', droppedAt: daysAgo(1) }), // row 8  aggregated
      T({ ...base, houseId: 'asherr', name: 'הא', reason: 'saveAll-omitted-preserved', droppedAt: daysAgo(0) }), // row 9  aggregated
      T({ ...base, houseId: 'אשר ' + FFFD, name: 'כף', reason: 'dedupe-identical-key', droppedAt: daysAgo(5), id: 'id-d10' }), // row 10 UNRESOLVED
      T({ ...base, houseId: 'rehab', name: 'למד', reason: 'saveAll-omitted-preserved', droppedAt: daysAgo(1) }), // row 11 known, not user-delete
      T({ ...base, houseId: '', name: 'מם', reason: 'user-delete', droppedAt: daysAgo(4), id: 'id-d12' }), // row 12 NO HOUSE + recent delete
    ] },
  ];
}

function runE(tabs) {
  const h = loadCode(tabs || worldE(), NOW);
  const report = h.sandbox.diagnoseRamotPatientsNow();
  return Object.assign(h, { report: JSON.parse(JSON.stringify(report)) });
}

test('(e) lists every Patients and PatientsTombstones row, ANY house, whose house resolves to no known id — and nothing that resolves', () => {
  const { report, logs } = runE();
  const where = report.unresolvedHouseRows.map((e) => e.sheet + ':' + e.row);
  assert.deepStrictEqual(where, [
    'Patients:6', 'Patients:7', 'Patients:8', 'Patients:9', 'Patients:10', 'Patients:11',
    'PatientsTombstones:8', 'PatientsTombstones:9', 'PatientsTombstones:10', 'PatientsTombstones:12',
  ], 'id / label / padded / cased houses resolve (rows 2–5, 12, 13) and are NOT listed');
  const look = Object.fromEntries(report.unresolvedHouseRows.map((e) => [e.sheet + ':' + e.row, e.lookalike]));
  assert.strictEqual(look['Patients:6'], '', 'a typo that fits no house gets no guess');
  assert.strictEqual(look['Patients:7'], 'asher', 'a doubled inner space still reads as רעננה אשר');
  assert.strictEqual(look['Patients:8'], 'arfoni', 'an invisible RTL mark');
  assert.strictEqual(look['Patients:9'], 'rehab', 'U+FFFD damage the surviving letters pin to one house');
  assert.strictEqual(look['Patients:10'], '', 'a lone U+FFFD fits every house — no guess');
  assert.strictEqual(look['Patients:11'], '', 'a blank house');
  const line = (re) => logs.filter((l) => re.test(l));
  assert.strictEqual(line(/^\(e\) Patients row 8 /).length, 1);
  assert.ok(line(/^\(e\) Patients row 8 /)[0].includes('house "arfoni\\u200f" → "arfoni\\u200f" [no such house; looks like arfoni]'),
    'the invisible mark is printed visibly: ' + line(/^\(e\) Patients row 8 /)[0]);
  assert.match(line(/^\(e\) Patients row 8 /)[0], /\| fromLead "lead-e8" .*\|\| DASHBOARD: INVISIBLE — no house tab shows house/);
  assert.match(line(/^\(e\) Patients row 11 /)[0], /house "" \[NO HOUSE\] .*DASHBOARD: DROPPED by getData_ \(blank houseId\)/);
  assert.match(line(/^\(e\) PatientsTombstones row 10 /)[0], /\| reason "dedupe-identical-key" \| droppedAt "[^"]+" \| savedByAction ""/);
  const agg = line(/^\(e\) PatientsTombstones \| saveAll-omitted-preserved/);
  assert.strictEqual(agg.length, 1, 'merge-don\'t-drop audit copies are one line per house + name, every row number on it');
  assert.match(agg[0], /×2 for house "asherr" name "הא" \(rows 8, 9;/);
  assert.deepStrictEqual(report.summary.unresolvedHouse, { Patients: 6, PatientsTombstones: 4 });
});

test('(e) every user-delete tombstone from the last 60 days: who, when, and whether the patient is back — older ones counted, unreadable dates listed', () => {
  const { report, logs } = runE();
  assert.deepStrictEqual(report.recentUserDeletes.map((d) => d.row), [2, 3, 5, 6, 7, 12],
    'rows 2 (9 days), 3 (exactly 60 days), 5 (unreadable), 6 (Date cell), 7, 12 — not row 4 (61 days), not the non-delete rows');
  const byRow = Object.fromEntries(report.recentUserDeletes.map((d) => [d.row, d]));
  assert.strictEqual(byRow[2].deletedBy, 'ורד');
  assert.strictEqual(byRow[2].now, 'not on Patients');
  assert.strictEqual(byRow[5].readable, false);
  assert.strictEqual(byRow[6].now, 'BACK on Patients row 12 (same id)');
  assert.strictEqual(byRow[7].now, 'BACK on Patients row 13 (same house + name + entry date)');
  assert.strictEqual(byRow[12].resolved, '');
  const line = (row) => logs.find((l) => l.startsWith('(e) user-delete PatientsTombstones row ' + row + ' '));
  assert.match(line(2), /droppedAt "[^"]+" \(9 day\(s\) ago\) \| house "ramot" \[ramot\] \| id "id-d2" \| name "נמחק לאחרונה"/);
  assert.match(line(2), /\| deleted by "ורד" at "[^"]+" \|\| now: not on Patients$/);
  assert.match(line(3), /\(60 day\(s\) ago\)/, 'the window edge is inside');
  assert.match(line(5), /droppedAt "" \(UNREADABLE date — listed so nothing is hidden\)/);
  assert.match(line(5), /deleted by \(not recorded\)/, 'a legacy tombstone without the deleter says so');
  assert.match(line(6), /\(date cell\) \(3 day\(s\) ago\)/, 'a Sheets-coerced Date cell is read too');
  assert.match(line(12), /house "" \[NO KNOWN HOUSE\]/);
  assert.ok(logs.includes('(e) 1 older user-delete row(s) not listed (droppedAt before the window).'));
  assert.ok(logs.some((l) => l.startsWith('(e) PatientsTombstones user-delete rows from the last 60 days (droppedAt since ' + daysAgo(60) + ')')));
  assert.strictEqual(report.summary.recentUserDeletes, 6);
  assert.strictEqual(report.summary.olderUserDeletes, 1);
  assert.strictEqual(report.summary.userDeleteWindowDays, 60);
});

test('(e) is read-only too, and the SUMMARY stays the last line and carries the (e) counts', () => {
  const { attempts, logs } = runE();
  assert.deepStrictEqual(attempts, [], 'no write / lock / property / uuid attempt of any kind');
  const last = logs[logs.length - 1];
  assert.match(last, /^\(d\) SUMMARY ramot/);
  assert.match(last, / \|\| \(e\) any house resolving to no known id: Patients 6, PatientsTombstones 4; user-deletes in the last 60 days: 6\. No writes performed\.$/);
  const firstE = logs.findIndex((l) => l.startsWith('(e)'));
  const lastC = logs.map((l) => l.startsWith('(c)')).lastIndexOf(true);
  assert.ok(firstE > lastC, '(e) prints after (c)…');
  assert.ok(logs.slice(firstE, -1).every((l) => l.startsWith('(e)')), '…and right before the summary');
});

test('(e) says "none" when nothing matches, and missing tabs are reported, not crashed on', () => {
  const { C } = loadCode([]);
  const clean = runE([
    { name: C.PATIENTS_SHEET, header: arr(C.PATIENT_COLUMNS), rows: [rowOf(C.PATIENT_COLUMNS, { houseId: 'ramot', name: 'אלף', date: '2026-05-01' })] },
    { name: C.PATIENTS_TOMBSTONES_SHEET, header: arr(C.PATIENT_TOMBSTONE_COLUMNS), rows: [] },
  ]);
  assert.ok(clean.logs.includes('(e) Patients: none.'));
  assert.ok(clean.logs.includes('(e) PatientsTombstones: none.'));
  assert.ok(clean.logs.includes('(e) no user-delete in the last 60 days.'));
  const empty = runE([]);
  assert.deepStrictEqual(empty.attempts, [], 'getOrCreateSheet_ would have inserted the tabs');
  assert.ok(empty.logs.includes('(e) Patients: no such tab — skipped.'));
  assert.ok(empty.logs.includes('(e) PatientsTombstones: no such tab — no user-delete has ever been recorded.'));
  assert.match(empty.logs[empty.logs.length - 1], /\(e\) any house resolving to no known id: tabs missing; user-deletes in the last 60 days: 0\. No writes performed\.$/);
});

test('diagKnownHouseIds_ is exactly the app.js HOUSES ids — the houses a tab exists for', () => {
  const app = loadApp();
  const { sandbox } = loadCode([]);
  assert.deepStrictEqual(arr(sandbox.diagKnownHouseIds_()).slice().sort(), arr(app.HOUSES).map((h) => h.id).sort());
});

test('diagHouseLookalike_: exactly one house or none — a hint, never a guess', () => {
  const { sandbox } = loadCode([]);
  const l = (v) => sandbox.diagHouseLookalike_(v);
  assert.strictEqual(l('ASHER' + RLM), 'asher');
  assert.strictEqual(l('רמות-השבים'), 'ramot');
  assert.strictEqual(l('רעננה' + String.fromCharCode(0xa0) + 'הפרדס'), 'pardes', 'an NBSP inside the label');
  assert.strictEqual(l('ש' + FFFD + 'ה אליעזר'), 'sde');
  assert.strictEqual(l('רעננה ' + FFFD + FFFD), '', 'fits both Raanana houses — ambiguous, no guess');
  assert.strictEqual(l(FFFD + FFFD), '', 'nothing survived');
  ['', null, undefined, 'unknown', 'asherr', 'external'].forEach((v) => assert.strictEqual(l(v), '', JSON.stringify(v)));
});

test('diagTimeMs_: Date cells and ISO text; NaN for blank or anything else', () => {
  const { sandbox } = loadCode([]);
  assert.strictEqual(sandbox.diagTimeMs_('2026-09-10T08:00:00.000Z'), Date.parse('2026-09-10T08:00:00.000Z'));
  assert.strictEqual(sandbox.diagTimeMs_(new Date('2026-09-10T08:00:00.000Z')), Date.parse('2026-09-10T08:00:00.000Z'));
  ['', null, undefined, 'לא ידוע', 45000, 'yesterday'].forEach((v) => assert.ok(Number.isNaN(sandbox.diagTimeMs_(v)), JSON.stringify(v)));
});

/* ===== 6. additive only — the re-land cannot change what any other function does ===== */

const DIAG_START = GS_SRC.indexOf('/* ===== Missing-patient diagnostic (READ-ONLY');

test('the diagnostic section declares only functions (nothing runs at script load), each name new to Code.gs', () => {
  assert.ok(DIAG_START > 0, 'the diagnostic section is in Code.gs');
  const section = stripStrings(stripComments(GS_SRC.slice(DIAG_START)));
  // Top-level statements are the lines at column 0 that are not inside a function body.
  let depth = 0;
  const topLevel = [];
  section.split('\n').forEach((ln) => {
    if (depth === 0 && ln.trim()) topLevel.push(ln.trim());
    for (const ch of ln) { if (ch === '{') depth++; else if (ch === '}') depth--; }
  });
  topLevel.forEach((ln) => {
    assert.match(ln, /^(function [A-Za-z_$][\w$]*\s*\(|\}$)/, 'only function declarations at the top level: ' + ln);
  });
  const names = topLevel.map((ln) => (ln.match(/^function ([A-Za-z_$][\w$]*)/) || [])[1]).filter(Boolean);
  assert.ok(names.includes('diagnoseRamotPatientsNow') && names.length >= 10, names.join(', '));
  names.forEach((n) => {
    const decl = GS_SRC.match(new RegExp('(^|\\n)\\s*(function\\s+|(const|let|var)\\s+)' + n.replace(/\$/g, '\\$') + '\\b', 'g')) || [];
    assert.strictEqual(decl.length, 1, n + ' must be declared exactly once in Code.gs — a second declaration would silently replace the first in Apps Script');
  });
});
