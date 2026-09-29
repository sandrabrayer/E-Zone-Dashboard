/* A deliberate house move from the ✏ edit modal must PERSIST — and a stale
 * tab must still never clobber.
 *
 * The bug (live, September 2026): a patient admitted from a lead (fromLead
 * set), living in pardes, was edited to asher in the ✏ modal. The UI moved
 * them, then the next load put them back in pardes. Root cause, traced here
 * end to end:
 *   1. the client sends every house; the patient now sits in asher's array;
 *   2. asher's pass: the persisted id is not an asher row, so the row takes
 *      the APPEND path, and the fromLead guard (Code.gs, `fl in
 *      fromLeadOnSheet`) sees the lead still on the pardes row → REFUSED
 *      ('promote_skipped_duplicate' / existing_patient_row);
 *   3. pardes' pass: the patient is omitted → merge-don't-drop KEEPS the
 *      pardes row (tombstoned 'saveAll-omitted-preserved', echoed in
 *      `preserved`);
 *   4. the client closed the modal as a success, flashed "שורה לא נשמרה —
 *      כפילות זוהתה" for 6 s, and the `preserved` resync put the patient back.
 * A second bug made moves unusable even once fixed: the client never adopted
 * the updatedAt the backend wrote, so the SAME user's next edit of the same
 * patient was refused as "someone else updated first".
 *
 * The fix under test: the ✏ modal sends an explicit `movedFrom` intent; one
 * saveAll_ moves the row (same id, same fromLead, one row) or REFUSES with a
 * reason — stale stamp, moved elsewhere, deleted — leaving the sheet
 * untouched; the backend echoes fresh stamps; the client applies the outcome
 * and never leaves the screen claiming a move that did not happen.
 *
 * End to end: the REAL public/app.js runs against the REAL apps-script/Code.gs
 * (vm sandboxes, fake sheets). The client's fetch is wired straight into
 * handle_, so "the next load" is a genuine getData round-trip.
 * All names, ids and dates are SYNTHETIC. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const GS_SRC = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');
const arr = (x) => Array.from(x);
const plain = (x) => JSON.parse(JSON.stringify(x));

/* ---------- synthetic fixtures ---------- */
const NAME = 'ישראלה ישראלי';        // the lead-linked patient who moves
const OTHER = 'פלוני אלמוני';         // an unrelated pardes resident
const HAND = 'אלמונית ידנית';         // a hand-entered pardes patient (no lead)
const ASHER_RES = 'תושב אשר';         // an asher resident
const ENTRY = '2026-06-01';
const T0 = '2026-09-20T08:00:00.000Z';
const PARDES = 'רעננה הפרדס';
const ASHER = 'רעננה אשר';
const RAMOT = 'רמות השבים';

/* ---------- backend: the REAL Code.gs over fake sheets ---------- */
function fakeSheet(headerRow, dataRows) {
  const grid = [headerRow.slice()].concat((dataRows || []).map((r) => r.slice()));
  let hidden = false;
  return {
    grid,
    getLastRow() { return grid.length; },
    getLastColumn() { return grid[0] ? grid[0].length : 0; },
    getMaxRows() { return Math.max(grid.length, 1000); },
    setFrozenRows() {},
    hideSheet() { hidden = true; },
    isSheetHidden() { return hidden; },
    getRange(r, c, nr, nc) {
      nr = nr || 1; nc = nc || 1;
      return {
        setNumberFormat() {},
        getValue() { const g = grid[r - 1]; return g && g[c - 1] !== undefined ? g[c - 1] : ''; },
        setValue(v) { if (!grid[r - 1]) grid[r - 1] = []; grid[r - 1][c - 1] = v; },
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
        setValues(vals) {
          for (let i = 0; i < vals.length; i++) {
            if (!grid[r - 1 + i]) grid[r - 1 + i] = [];
            for (let j = 0; j < vals[i].length; j++) grid[r - 1 + i][c - 1 + j] = vals[i][j];
          }
        },
        clearContent() {
          for (let i = 0; i < nr; i++) {
            if (!grid[r - 1 + i]) continue;
            for (let j = 0; j < nc; j++) grid[r - 1 + i][c - 1 + j] = '';
          }
        },
      };
    },
  };
}

function loadBackend() {
  const noop = () => {};
  let uuid = 0;
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    JSON, Math, Date, Number, String, Array, Object, RegExp, isFinite,
    Logger: { log: noop },
    __sheets: {},
  };
  sandbox.SpreadsheetApp = {
    getActiveSpreadsheet: () => ({
      getSheetByName: (name) => sandbox.__sheets[name] || null,
      insertSheet: (name) => (sandbox.__sheets[name] = fakeSheet([], [])),
      getSpreadsheetTimeZone: () => 'Asia/Jerusalem',
    }),
  };
  sandbox.PropertiesService = { getScriptProperties: () => ({ getProperty: () => null, setProperty() { return this; } }) };
  sandbox.ContentService = {
    createTextOutput: (s) => ({ setMimeType: () => ({ json: JSON.parse(s) }) }),
    MimeType: { JSON: 'json' },
  };
  sandbox.Utilities = { getUuid: () => 'uuid-' + (++uuid), formatDate: (d) => d.toISOString().slice(0, 10) };
  sandbox.LockService = { getScriptLock: () => ({ tryLock: () => true, waitLock: noop, releaseLock: noop }) };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(GS_SRC + `
    globalThis.__gs = {
      handle: (p) => handle_(p).json,
      readSheet: (sh, cols) => readSheet_(sh, cols),
      PATIENT_COLUMNS, LEAD_COLUMNS, PATIENT_TOMBSTONE_COLUMNS, AUDIT_LOG_COLUMNS,
      PATIENTS_SHEET, LEADS_SHEET, PATIENTS_TOMBSTONES_SHEET, AUDIT_LOG_SHEET,
    };`, sandbox);
  const gs = sandbox.__gs;
  const rowOf = (cols, f) => arr(cols).map((c) => (f[c] === undefined ? '' : f[c]));
  return {
    gs,
    sandbox,
    handle: (p) => JSON.parse(JSON.stringify(gs.handle(JSON.parse(JSON.stringify(p))))),
    seed(sheetName, cols, rows) {
      sandbox.__sheets[sheetName] = fakeSheet(arr(cols), rows.map((f) => rowOf(cols, f)));
    },
    grid(sheetName) { return JSON.parse(JSON.stringify(sandbox.__sheets[sheetName].grid)); },
    rows(sheetName, cols) {
      const sh = sandbox.__sheets[sheetName];
      return sh ? arr(gs.readSheet(sh, cols)).map((r) => JSON.parse(JSON.stringify(r))) : [];
    },
    patients() { return this.rows(gs.PATIENTS_SHEET, gs.PATIENT_COLUMNS); },
    tombstones() { return this.rows(gs.PATIENTS_TOMBSTONES_SHEET, gs.PATIENT_TOMBSTONE_COLUMNS); },
    audit() {
      return this.rows(gs.AUDIT_LOG_SHEET, gs.AUDIT_LOG_COLUMNS)
        .map((a) => Object.assign({}, a, { details: a.details ? JSON.parse(a.details) : {} }));
    },
  };
}

/* ---------- client: the REAL app.js; fetch → the backend's handle_ ---------- */
function fakeEl() {
  return {
    className: '', dataset: {}, style: {}, textContent: '', children: [],
    set innerHTML(_v) {}, get innerHTML() { return ''; },
    appendChild(c) { this.children.push(c); }, addEventListener() {}, remove() {},
    querySelector() { return fakeEl(); }, querySelectorAll() { return []; },
    classList: { add() {}, remove() {}, toggle() {} },
  };
}

function loadClient(route, user) {
  const calls = [];
  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/' },
    document: {
      getElementById: () => fakeEl(), createElement: () => fakeEl(),
      querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, body: fakeEl(),
    },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    setTimeout: () => 0, clearTimeout: noop,
    URL, URLSearchParams, Math, Date, JSON, Number, String, Array, Object, RegExp, Promise, Map, Set,
    fetch: (url, opts) => {
      const body = opts && opts.body
        ? JSON.parse(opts.body)
        : Object.fromEntries(new URL(url, 'http://test').searchParams);
      // The proxy stamps `user` from the signed session cookie (server.js).
      if (opts && opts.body) body.user = user || '';
      calls.push(body);
      let out;
      try { out = route(body); } catch (e) { out = { ok: false, error: 'exception', message: e.message }; }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(out) });
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(APP_SRC + `
    renderAll = () => {};
    showError = (m, ms) => { globalThis.__errors.push(String(m)); globalThis.__errorMs.push(ms); };
    showToast = (m) => { globalThis.__toasts.push(String(m)); };
    showModal = (opts) => { globalThis.__modal = opts; };
    globalThis.__errors = [];
    globalThis.__errorMs = [];
    globalThis.__toasts = [];
    globalThis.__app = {
      state,
      loadAll: () => loadAll(),
      saveAll: () => saveAll(),
      settle: () => savePromise,
      openEditPatientModal: (p) => openEditPatientModal(p),
      submitModal: (v) => globalThis.__modal.onSubmit(v),
      errors: () => globalThis.__errors,
      errorMs: () => globalThis.__errorMs,
      toasts: () => globalThis.__toasts,
    };`, sandbox);
  return { app: sandbox.__app, calls };
}

/* Let every queued microtask run — the resync reload is fire-and-forget. */
const flush = () => new Promise((r) => setImmediate(r));

/* One "session": a fresh client, logged in (edit mode), after its first load. */
async function openSession(backend, user, route) {
  const client = loadClient(route || ((body) => backend.handle(body)), user);
  client.app.state.mode = 'edit';
  await client.app.loadAll();
  await client.app.settle();
  return client;
}

const byId = (app, id) => app.state.patients.find((p) => p.id === id);

/* The ✏ modal's submit, exactly as a person fills it: every field as the
 * modal renders it, with `over` applied. Resolves to onSubmit's verdict,
 * after the save and any resync it triggered have settled. */
async function editPatient(client, id, over) {
  const p = byId(client.app, id);
  client.app.openEditPatientModal(p);
  const v = Object.assign({
    name: p.name, houseId: p.houseId, date: p.date, pay: String(p.pay), status: p.status, notes: p.notes || '',
  }, over || {});
  const verdict = await client.app.submitModal(v);
  await client.app.settle();
  await flush();
  return verdict;
}

function patientRow(over) {
  return Object.assign({
    id: 'id-x', houseId: 'pardes', name: NAME, date: ENTRY, pay: 9000, adv: 0,
    status: 'active', fromLead: 'lead-x', exitDate: '', source: 'lead', notes: '',
    updatedAt: T0, updatedBy: 'ורד',
  }, over || {});
}

/* A backend holding the lead-linked pardes patient, an unrelated pardes
 * resident, an asher resident, a hand-entered pardes patient, and the
 * admitted lead itself. */
function world(over) {
  const backend = loadBackend();
  const g = backend.gs;
  backend.seed(g.PATIENTS_SHEET, g.PATIENT_COLUMNS, [
    patientRow(over),
    patientRow({ id: 'id-o', name: OTHER, fromLead: '', source: 'direct_admin' }),
    patientRow({ id: 'id-a', houseId: 'asher', name: ASHER_RES, fromLead: '', source: 'direct_admin' }),
    patientRow({ id: 'id-h', name: HAND, fromLead: '', source: 'direct_admin' }),
  ]);
  backend.seed(g.LEADS_SHEET, g.LEAD_COLUMNS, [
    { id: 'lead-x', name: NAME, phone: '0500000001', house: PARDES, stage: 'admitted', created: '2026-05-20' },
  ]);
  return backend;
}

const rowsFor = (backend, name) => backend.patients().filter((r) => r.name === name);

/* ===== A. the bug, end to end ===== */

test('BUG: a lead-linked patient moved pardes → asher in the ✏ modal is in asher on the NEXT load (same id, same fromLead, one row)', async () => {
  const backend = world();
  const vered = await openSession(backend, 'ורד');
  const verdict = await editPatient(vered, 'id-x', { houseId: 'asher' });
  assert.strictEqual(verdict, true, 'the modal closes on success');

  const rows = backend.patients().filter((r) => r.id === 'id-x' || r.fromLead === 'lead-x' || r.name === NAME);
  assert.strictEqual(rows.length, 1, 'exactly ONE row for the patient — no pardes leftover, no duplicate: ' + JSON.stringify(rows));
  assert.strictEqual(rows[0].houseId, 'asher', 'the row now lives in asher');
  assert.strictEqual(rows[0].id, 'id-x', 'same persisted id (payments follow the patient by it)');
  assert.strictEqual(rows[0].fromLead, 'lead-x', 'still linked to the lead');

  const next = await openSession(backend, 'שירן');   // "the next load": a fresh getData round-trip
  const p = byId(next.app, 'id-x');
  assert.ok(p, 'the patient is loaded');
  assert.strictEqual(p.houseId, 'asher', 'the next load shows asher, not pardes');
  assert.deepStrictEqual(plain(vered.app.errors()), [], 'no error for a clean move');
});
