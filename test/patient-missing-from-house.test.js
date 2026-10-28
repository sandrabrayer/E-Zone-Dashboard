'use strict';

/* An active patient listed in «מטופלים» but in no תפוסה house tab
 * (CHANGELOG-patient-missing-from-house.md).
 *
 * The «מטופלים» list keeps every non-released row and filters the house
 * leniently; the תפוסה list compared the stored house string to the tab id
 * EXACTLY, and resolveHouseId knew no other app's id (hapardes) and no
 * invisible mark / NBSP / doubled space. A row stored that way was in the
 * list, in no house tab, and so could not be discharged.
 *
 * The REAL public/app.js and apps-script/Code.gs in vm sandboxes, an
 * in-memory spreadsheet — no network, no secret. Every name is SYNTHETIC. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadGs, richSheet } = require('./helpers/gs-sandbox');

const ROOT = path.join(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const GS_SRC = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');
const CSS_SRC = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
const SW_SRC = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');
const plain = (v) => JSON.parse(JSON.stringify(v));
const RLM = '‏';
const NBSP = ' ';
const NAME = 'ירדן בדיקה';   // synthetic

/* ---------- public/app.js ---------- */
function loadApp() {
  const epilogue = `
    globalThis.__test = {
      HOUSES, HOUSE_ID_ALIASES, OCCUPANCY_UNKNOWN_HOUSE, OCCUPANCY_UNKNOWN_HOUSE_LABEL,
      resolveHouseId, unadmittedHouseId, normalizePatient, visibleOccupancyRows, houseOccupancyCount,
      patientListRows, patientListRowHtml,
      setState(k, v) { state[k] = v; },
    };
  `;
  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/' },
    document: { addEventListener: noop, getElementById: () => null },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    URLSearchParams, Math, Date, JSON, Number, String, Array, Object, RegExp, Promise, Set, Map,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(APP_SRC + epilogue, sandbox);
  return sandbox.__test;
}
const app = loadApp();

/* Every way the live row's house could be stored and still mean רעננה הפרדס. */
const PARDES_FORMS = ['pardes', 'Pardes', ' pardes ', 'רעננה הפרדס', 'רעננה הפרדס ', 'hapardes', 'HaPardes', ' hapardes',
  'pardes' + RLM, RLM + 'רעננה הפרדס', 'רעננה' + NBSP + 'הפרדס', 'רעננה  הפרדס', 'רעננה הפרדס' + '​'];

test('resolveHouseId: every form of רעננה הפרדס is pardes — other apps\' ids, invisible marks, NBSP, doubled spaces', () => {
  PARDES_FORMS.forEach((v) => assert.equal(app.resolveHouseId(v), 'pardes', JSON.stringify(v)));
  assert.equal(app.resolveHouseId('raanana'), 'asher', 'the bonus / digest id of רעננה אשר');
  assert.equal(app.resolveHouseId('efroni'), 'arfoni');
  assert.equal(app.resolveHouseId('ofroni'), 'arfoni', 'the staffing id of קיסריה עפרוני');
  app.HOUSES.forEach((h) => assert.equal(app.resolveHouseId(h.id), h.id, 'an id is unchanged'));
  assert.equal(app.resolveHouseId(' בית לא קיים '), 'בית לא קיים', 'anything else is kept as written (trimmed)');
  assert.equal(app.resolveHouseId(''), '');
  assert.equal(app.resolveHouseId(null), '');
  assert.equal(app.resolveHouseId('toString'), 'toString', 'no prototype key is an alias');
});

test('root cause: the patient is in «מטופלים» AND in the רעננה הפרדס tab, whatever form the house was stored in', () => {
  PARDES_FORMS.forEach((form) => {
    const p = app.normalizePatient({ id: 'p-yk', houseId: form, name: NAME, date: '2026-09-22', status: 'active', fromLead: 'L-yk' });
    assert.equal(p.houseId, 'pardes', JSON.stringify(form));
    const s = { patients: [p], leads: [], irrelevantLeads: [], removedLeads: [], finance: false };
    assert.equal(app.patientListRows(s, { status: 'active', house: 'pardes' }, '2026-10-26').length, 1, '«מטופלים» ' + JSON.stringify(form));
    assert.equal(app.visibleOccupancyRows([p], 'pardes', '', false).length, 1, 'תפוסה ' + JSON.stringify(form));
    assert.equal(app.houseOccupancyCount([p], 'pardes'), 1);
    assert.equal(app.houseOccupancyCount([p], app.OCCUPANCY_UNKNOWN_HOUSE), 0);
  });
});

test('תפוסה matches the house through the rule even for a raw (un-normalized) row — no raw string compare is left', () => {
  const raw = { houseId: 'hapardes', name: NAME, status: 'active' };
  assert.equal(app.visibleOccupancyRows([raw], 'pardes', '', false).length, 1);
  assert.equal(app.houseOccupancyCount([raw], 'pardes'), 1);
  const fn = APP_SRC.slice(APP_SRC.indexOf('function visibleOccupancyRows'), APP_SRC.indexOf('function occupancyTabLabel'));
  assert.ok(!/p\.houseId === houseId/.test(fn));
});

test('a house no rule can resolve: in «מטופלים» (with a «בית לא מזוהה» chip) and in the «בית לא מזוהה» tab — never lost', () => {
  const p = app.normalizePatient({ id: 'p-x', houseId: 'פרדס חנה', name: NAME, date: '2026-09-22', status: 'active' });
  const released = app.normalizePatient({ id: 'p-r', houseId: 'פרדס חנה', name: 'משוחרר', date: '2026-01-01', status: 'released' });
  const s = { patients: [p, released], leads: [], irrelevantLeads: [], removedLeads: [], finance: false };
  const rows = app.patientListRows(s, { status: 'active' }, '2026-10-26');
  assert.equal(rows.length, 1);
  assert.ok(app.HOUSES.every((h) => app.visibleOccupancyRows([p], h.id, '', false).length === 0), 'no real house tab');
  assert.equal(app.visibleOccupancyRows([p, released], app.OCCUPANCY_UNKNOWN_HOUSE, '', false).length, 1);
  assert.equal(app.houseOccupancyCount([p, released], app.OCCUPANCY_UNKNOWN_HOUSE), 1, 'released never counts');
  const html = app.patientListRowHtml(rows[0], false, true);
  assert.match(html, /data-problem="unknown_house">בית לא מזוהה</);
  const known = app.patientListRows({ patients: [app.normalizePatient({ id: 'k', houseId: 'pardes', name: 'x', status: 'active' })],
    leads: [], irrelevantLeads: [], removedLeads: [], finance: false }, { status: 'active' }, '2026-10-26');
  assert.ok(!app.patientListRowHtml(known[0], false, true).includes('unknown_house'));
});

test('renderHouseTabs adds the «בית לא מזוהה» tab only while such a patient is active; real tabs unchanged', () => {
  const fn = APP_SRC.slice(APP_SRC.indexOf('function renderHouseTabs'), APP_SRC.indexOf('function renderPatients'));
  assert.match(fn, /if \(h\.closed && inHouse === 0\) return;/);
  assert.match(fn, /const unknown = houseOccupancyCount\(state\.patients, OCCUPANCY_UNKNOWN_HOUSE\);\n  if \(unknown > 0\) \{/);
  assert.match(fn, /state\.currentHouseTab = OCCUPANCY_UNKNOWN_HOUSE;/);
  assert.match(CSS_SRC, /\.house-tabs \.h-tab\.h-tab-unknown \{ color: var\(--danger\); \}/);
  // The intake form never defaults to the pseudo-house.
  assert.match(APP_SRC, /\(houseById\(state\.currentHouseTab\) \? state\.currentHouseTab : HOUSES\[0\]\.id\)/);
});

test('תפוסה search uses the «מטופלים» name match (invisible marks, doubled spaces, case)', () => {
  const p = { houseId: 'pardes', name: 'ירדן' + RLM + ' בדיקה', status: 'active' };
  assert.equal(app.visibleOccupancyRows([p], 'pardes', 'ירדן  בדיקה', false).length, 1);
  assert.equal(app.visibleOccupancyRows([p], 'pardes', 'ירדן בדיקה', false).length, 1);
  assert.equal(app.visibleOccupancyRows([p], 'pardes', 'אחר', false).length, 0);
});

test('unadmittedHouseId (the «מטופלים» house filter) is resolveHouseId — one house rule for both views', () => {
  PARDES_FORMS.concat(['raanana', 'בית לא קיים', '', null, undefined, ' ramot ']).forEach((v) => {
    assert.equal(app.unadmittedHouseId(v), app.resolveHouseId(v == null ? '' : String(v).trim()), JSON.stringify(v));
  });
});

/* ---------- «שחרר» on the «מטופלים» row ---------- */

test('«שחרר» on an ACTIVE «מטופלים» row, edit mode only — never on a released row or in view mode', () => {
  const s = { patients: [app.normalizePatient({ id: 'p1', houseId: 'pardes', name: NAME, date: '2026-09-22', status: 'active' }),
    app.normalizePatient({ id: 'p2', houseId: 'pardes', name: 'ב', date: '2026-01-01', status: 'released', exitDate: '2026-05-01' })],
  leads: [], irrelevantLeads: [], removedLeads: [], finance: false };
  const [active] = app.patientListRows(s, { status: 'active' }, '2026-10-26');
  const [rel] = app.patientListRows(s, { status: 'released' }, '2026-10-26');
  assert.match(app.patientListRowHtml(active, false, true), /<button type="button" class="btn small plist-discharge-btn" title="שחרור מטופל">שחרר<\/button>/);
  assert.ok(!app.patientListRowHtml(active, false, false).includes('plist-discharge-btn'), 'view mode');
  assert.ok(!app.patientListRowHtml(rel, false, true).includes('plist-discharge-btn'), 'released row');
});

test('«שחרר» opens the SAME dischargePatient flow under the busy-button guard — no new write, no new action', () => {
  const fn = APP_SRC.slice(APP_SRC.indexOf('function renderPatientsTab'), APP_SRC.indexOf('function initPatientsTabFilters'));
  assert.match(fn, /on\('\.plist-discharge-btn', e => busyButton\(e && e\.currentTarget, 'save', \(\) => dischargePatient\(p\)\)\);/);
  // dischargePatient itself refuses outside edit mode.
  const dp = APP_SRC.slice(APP_SRC.indexOf('function dischargePatient(p)'), APP_SRC.indexOf('async function runDischarge'));
  assert.match(dp, /if \(state\.mode !== 'edit'\) return;/);
});

/* ---------- apps-script/Code.gs ---------- */

function world(patients) {
  const g = loadGs();
  const s = g.sandbox;
  const cols = Array.from(g.run('PATIENT_COLUMNS'));
  const sh = richSheet(g.run('PATIENTS_SHEET'), cols);
  patients.forEach((r) => sh.grid.push(cols.map((c) => r[c] ?? '')));
  s.__sheets[g.run('PATIENTS_SHEET')] = sh;
  return { g, s, rows: () => plain(g.sheetRows(g.run('PATIENTS_SHEET'), 'PATIENT_COLUMNS')) };
}

test('PARITY: Code.gs diagClientHouseId_ is app.js resolveHouseId on every form; the alias tables are equal', () => {
  const { g, s } = world([]);
  const inputs = PARDES_FORMS.concat(['raanana', 'RAANANA', 'efroni', 'ofroni', 'בית לא קיים', '', ' ', null, undefined, 'toString']);
  app.HOUSES.forEach((h) => inputs.push(h.id, h.name, h.id.toUpperCase(), h.name + RLM, h.name.replace(' ', NBSP)));
  inputs.forEach((v) => assert.equal(s.diagClientHouseId_(v), app.resolveHouseId(v), JSON.stringify(v)));
  assert.deepEqual(plain(s.patientHouseIdAliases_()), plain(app.HOUSE_ID_ALIASES));
  assert.ok(g.run('typeof PATIENT_HOUSE_ID_ALIASES_') === 'undefined', 'a function, not a const');
});

test('root cause (server): a row stored as "hapardes" is pardes\'s row — the save updates it IN PLACE and heals the cell', () => {
  const w = world([{ id: 'p-yk', houseId: 'hapardes', name: NAME, date: '2026-09-22', status: 'active', fromLead: 'L-yk', source: 'lead' }]);
  const res = plain(w.s.saveAll_(undefined, { pardes: [
    { id: 'p-yk', houseId: 'pardes', name: NAME, date: '2026-09-22', status: 'released', exitDate: '2026-10-26', fromLead: 'L-yk', source: 'lead' },
  ] }, 'ורד'));
  assert.equal(res.ok, true);
  assert.deepEqual(res.promoteSkipped, {}, 'not refused as a duplicate promotion');
  const rows = w.rows();
  assert.equal(rows.length, 1, 'ONE row — never a second one');
  assert.equal(rows[0].id, 'p-yk', 'the id is kept (no re-mint)');
  assert.equal(rows[0].houseId, 'pardes', 'the cell is healed to the id');
  assert.equal(rows[0].status, 'released', 'the discharge landed');
});

test('server: the Hebrew label / an invisible mark in the cell is matched the same way', () => {
  ['רעננה הפרדס', 'pardes' + RLM, 'רעננה' + NBSP + 'הפרדס'].forEach((cell) => {
    const w = world([{ id: 'p1', houseId: cell, name: NAME, date: '2026-09-22', status: 'active', fromLead: '' }]);
    const res = plain(w.s.saveAll_(undefined, { pardes: [{ id: 'p1', houseId: 'pardes', name: NAME, date: '2026-09-22', status: 'active' }] }, 'ורד'));
    assert.equal(res.ok, true);
    assert.equal(w.rows().length, 1, JSON.stringify(cell));
    assert.equal(w.rows()[0].houseId, 'pardes');
  });
});

test('server: an alias payload KEY joins its house (one pass); an unknown key stays as written', () => {
  const { s } = world([]);
  const out = plain(s.canonicalPatientHouseKeys_({ pardes: [{ id: 'a' }], hapardes: [{ id: 'b' }], 'רעננה הפרדס': [{ id: 'c' }], xyz: [{ id: 'd' }], ramot: 'junk' }));
  assert.deepEqual(Object.keys(out).sort(), ['pardes', 'ramot', 'xyz']);
  assert.deepEqual(out.pardes.map((p) => p.id), ['a', 'b', 'c']);
  assert.equal(out.ramot, 'junk', 'a non-array value is left to the existing guard');
  const w = world([{ id: 'p1', houseId: 'pardes', name: NAME, date: '2026-09-22', status: 'active' }]);
  plain(w.s.saveAll_(undefined, { hapardes: [{ id: 'p1', houseId: 'hapardes', name: NAME, date: '2026-09-22', status: 'trial' }] }, 'ורד'));
  assert.deepEqual(w.rows().map((r) => [r.id, r.houseId, r.status]), [['p1', 'pardes', 'trial']]);
});

test('server: a house move FROM a row stored under an alias lands (same id, one row)', () => {
  const { s } = world([]);
  assert.deepEqual(plain(s.collectHouseMoves_({ ramot: [{ id: 'p1', movedFrom: 'hapardes' }] })), { p1: { from: 'pardes', to: 'ramot' } });
  const w = world([{ id: 'p1', houseId: 'hapardes', name: NAME, date: '2026-09-22', status: 'active', updatedAt: '' }]);
  const res = plain(w.s.saveAll_(undefined, { ramot: [{ id: 'p1', houseId: 'ramot', name: NAME, date: '2026-09-22', status: 'active', movedFrom: 'pardes', updatedAt: '' }] }, 'ורד'));
  assert.equal(res.ok, true);
  assert.equal((res.conflicts || []).length, 0, 'not refused as «moved elsewhere»');
  assert.deepEqual(w.rows().map((r) => [r.id, r.houseId]), [['p1', 'ramot']]);
});

test('server: deletePatientRow_ finds a row stored under an alias (by id and by key)', () => {
  const src = GS_SRC.slice(GS_SRC.indexOf('function deletePatientRow_('), GS_SRC.indexOf('function deletePatientRow_(') + 6000);
  assert.match(src, /const wantHouse = diagClientHouseId_\(/);
  assert.match(src, /diagClientHouseId_\(row\[houseColIdx\]\) === wantHouse/);
  assert.match(src, /patientKey_\(diagClientHouseId_\(row\[houseColIdx\]\), row\[nameColIdx\], row\[dateColIdx\]\) === wantKey/);
});

test('server: the coordinators digest maps an alias house too; patientKey_ is unchanged (stored keys never churn)', () => {
  const { s } = world([]);
  assert.equal(s.canonicalDigestHouse_('hapardes'), 'pardes');
  assert.equal(s.canonicalDigestHouse_('pardes' + RLM), 'pardes');
  assert.equal(s.canonicalDigestHouse_('sde'), '');
  assert.equal(s.canonicalDigestHouse_('בית לא קיים'), '');
  assert.equal(s.patientKey_(' hapardes ', ' א ', '2026-09-22'), 'hapardes::א::2026-09-22');
});

/* ---------- the report ---------- */

function reportWorld() {
  return world([
    { id: 'r2', houseId: 'pardes', name: 'תקין', date: '2026-09-01', status: 'active' },            // row 2 renders
    { id: 'r3', houseId: 'רעננה הפרדס', name: 'תווית', date: '2026-09-02', status: 'active' },       // row 3 label → renders
    { id: 'r4', houseId: 'hapardes', name: NAME, date: '2026-09-22', status: 'active' },             // row 4 variant
    { id: 'r5', houseId: 'pardes' + RLM, name: 'סימן', date: '2026-09-03', status: 'פעיל' },          // row 5 variant
    { id: 'r6', houseId: 'פרדס חנה', name: 'לא ידוע', date: '2026-09-04', status: 'trial' },          // row 6 unknown
    { id: 'r7', houseId: '', name: 'ריק', date: '2026-09-05', status: '' },                           // row 7 no house
    { id: 'r8', houseId: 'פרדס חנה', name: 'שוחרר', date: '2026-01-01', status: 'released' },        // row 8 released → not listed
    { id: 'r9', houseId: 'rehab' + '�', name: 'פגום', date: '2026-09-06', status: 'active' },    // row 9 unknown, looks like rehab?
  ]);
}

test('report rows: each active row no house tab showed, with its reason; released and rendering rows are not listed', () => {
  const w = reportWorld();
  const values = w.s.sheetValues_(w.s.__sheets[w.g.run('PATIENTS_SHEET')], w.g.run('PATIENT_COLUMNS'));
  const rows = plain(w.s.patientsMissingFromHousesRows_(values));
  assert.deepEqual(rows.map((r) => [r.row, r.reason, r.resolved]), [
    [4, 'house_variant', 'pardes'],
    [5, 'house_variant', 'pardes'],
    [6, 'unknown_house', ''],
    [7, 'no_house', ''],
    [9, 'unknown_house', ''],
  ]);
  assert.equal(rows[0].house, '"hapardes"');
  assert.equal(rows[1].house, '"pardes\\u200f"', 'the invisible mark is printed visibly');
  assert.equal(rows[1].status, 'active', 'a Hebrew status is the app\'s status');
  assert.equal(rows[2].status, 'trial');
  assert.equal(rows[0].date, '2026-09-22');
});

test('patientsMissingFromHousesReportNow: read-only, one Doc, no names in the log, not reachable over HTTP', () => {
  const w = reportWorld();
  const texts = [];
  w.s.recDocPara_ = (_b, t) => { texts.push(String(t)); };
  w.s.recDocTable_ = (_b, rows) => { texts.push(JSON.stringify(rows)); };
  let created = 0;
  w.s.DocumentApp = {
    ParagraphHeading: { TITLE: 'T', HEADING2: 'H2' },
    create: () => { created++; return { getBody: () => ({ getParagraphs: () => [] }), saveAndClose() {}, getUrl: () => 'https://docs.example/d/2' }; },
  };
  const before = JSON.stringify(w.s.__sheets[w.g.run('PATIENTS_SHEET')].grid);
  const res = plain(w.s.patientsMissingFromHousesReportNow());
  assert.equal(created, 1);
  assert.equal(res.rows.length, 5);
  assert.equal(res.url, 'https://docs.example/d/2');
  assert.equal(JSON.stringify(w.s.__sheets[w.g.run('PATIENTS_SHEET')].grid), before, 'the Patients tab is untouched');
  assert.equal(w.s.__sheets.AuditLog, undefined, 'nothing logged to AuditLog');
  assert.ok(texts.some((t) => t.includes(NAME) && t.includes('hapardes') && t.includes('יתוקן בשמירה הבאה')), 'the row and its reason are in the Doc');
  assert.ok(texts.some((t) => t.includes('בית ריק')));
  const log = w.g.logs.join('\n');
  assert.match(log, /READ-ONLY on the spreadsheet\. Rows: 5 \(no_house 1, unknown_house 2, house_variant 2\)/);
  ['ירדן', 'תקין', 'לא ידוע', 'ריק', 'פגום', 'סימן'].forEach((n) => assert.ok(!log.includes(n), 'no name in the log: ' + n));
  // Read-only by source too: no write call in the report or its row helper.
  const src = GS_SRC.slice(GS_SRC.indexOf('function patientsMissingFromHousesRows_'), GS_SRC.indexOf('/* Normalize a phone to canonical Israeli local form'));
  ['setValue', 'setValues', 'appendRow', 'deleteRow', 'insertSheet', 'getOrCreateSheet_', 'clear', 'logAudit_', 'LockService']
    .forEach((w2) => assert.ok(!src.includes(w2), w2));
  assert.ok(/\nfunction patientsMissingFromHousesReportNow\(\)/.test(GS_SRC), 'public, in the editor Run dropdown');
  assert.ok(!Array.from(w.g.run('PROXY_KNOWN_ACTIONS')).includes('patientsMissingFromHousesReportNow'));
  const out = plain(w.s.handle_({ action: 'patientsMissingFromHousesReportNow' }).json);
  assert.equal(out.error, 'unknown_action');
});

test('SW: v92 (live) → v93 with its comment; v17 never reused', () => {
  assert.ok(Number(/var CACHE_VERSION = 'v(\d+)';/.exec(SW_SRC)[1]) >= 93, 'v93 or later (monotonic)');
  assert.ok(SW_SRC.includes('v92 → v93:') && SW_SRC.includes('CHANGELOG-patient-missing-from-house.md'));
});
