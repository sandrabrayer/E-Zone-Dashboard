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
const SW_SRC = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');
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
      collectHouseMoves: (p) => collectHouseMoves_(p),
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
      serializePatients: () => serializePatients(),
      sentPatientsById: (l) => sentPatientsById(l),
      applySaveOutcome: (s, r) => applySaveOutcome(s, r),
      conflictsMessage: (r) => conflictsMessage(r),
      moveRefusalMessage: (c) => moveRefusalMessage(c),
      moveNotSavedMessage: (n, f, t) => moveNotSavedMessage(n, f, t),
      houseMoveVerdict: (p) => houseMoveVerdict(p),
      REFUSAL_BANNER_MS,
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

test('the move leaves no trace of a stale save: no omission tombstone, no promote refusal, no re-mint; audited once; confirmed on screen', async () => {
  const backend = world();
  const vered = await openSession(backend, 'ורד');
  const before = vered.calls.length;
  await editPatient(vered, 'id-x', { houseId: 'asher' });

  assert.deepStrictEqual(backend.tombstones(), [], 'the pardes row was MOVED, not preserved as a stale omission');
  const actions = backend.audit().map((a) => a.action);
  assert.ok(!actions.includes('promote_skipped_duplicate'), 'the fromLead guard never saw it as an admission');
  assert.ok(!actions.includes('patient_id_reminted'), 'the id was kept, not re-minted');
  const moves = backend.audit().filter((a) => a.action === 'patient_moved_house');
  assert.strictEqual(moves.length, 1);
  assert.deepStrictEqual(
    { id: moves[0].details.id, from: moves[0].details.fromHouseId, to: moves[0].details.toHouseId, by: moves[0].details.updatedBy },
    { id: 'id-x', from: 'pardes', to: 'asher', by: 'ורד' });
  assert.ok(moves[0].details.changed.includes('houseId'));

  const save = vered.calls.slice(before).find((c) => c.action === 'saveAll');
  assert.strictEqual(save.patients.asher.find((r) => r.id === 'id-x').movedFrom, 'pardes', 'the intent rode the payload');
  assert.ok(!save.patients.pardes.some((r) => r.id === 'id-x'));
  assert.ok(vered.app.toasts().includes(NAME + ' הועבר/ה ל' + ASHER), 'a confirmation toast: ' + vered.app.toasts());
  assert.ok(!vered.app.toasts().some((t) => /מידע לא מעודכן/.test(t)), 'no stale-data resync');
  assert.strictEqual(byId(vered.app, 'id-x').movedFrom, undefined, 'the intent is cleared once the move landed');
});

test('a hand-entered patient (no lead) moves the same way — one row, same id (the old path appended a re-minted duplicate)', async () => {
  const backend = world();
  const vered = await openSession(backend, 'ורד');
  await editPatient(vered, 'id-h', { houseId: 'ramot' });
  const rows = rowsFor(backend, HAND);
  assert.deepStrictEqual(rows.map((r) => r.houseId + ':' + r.id), ['ramot:id-h']);
  assert.deepStrictEqual(plain(vered.app.errors()), []);
});

test('a move together with other edits in the same submit keeps all of them', async () => {
  const backend = world();
  const vered = await openSession(backend, 'ורד');
  await editPatient(vered, 'id-x', { houseId: 'ramot', pay: '11000', notes: 'הערה חדשה' });
  const [row] = rowsFor(backend, NAME);
  assert.deepStrictEqual({ house: row.houseId, pay: Number(row.pay), notes: row.notes, id: row.id, fromLead: row.fromLead },
    { house: 'ramot', pay: 11000, notes: 'הערה חדשה', id: 'id-x', fromLead: 'lead-x' });
  assert.strictEqual(rowsFor(backend, NAME).length, 1);
});

test('order does not matter: a move to a house saved AFTER the one it leaves (asher → pardes) lands the same way', async () => {
  const backend = world();
  const vered = await openSession(backend, 'ורד');
  await editPatient(vered, 'id-a', { houseId: 'pardes' });
  assert.deepStrictEqual(rowsFor(backend, ASHER_RES).map((r) => r.houseId + ':' + r.id), ['pardes:id-a']);
  assert.deepStrictEqual(backend.tombstones(), [], 'the leaving row was not treated as a stale omission');
  assert.deepStrictEqual(plain(vered.app.errors()), []);
});

test('two patients swap houses in ONE save — both land, nothing duplicated or lost', async () => {
  const backend = world();
  const vered = await openSession(backend, 'ורד');
  const x = byId(vered.app, 'id-x');
  const a = byId(vered.app, 'id-a');
  x.movedFrom = 'pardes'; x.houseId = 'asher';
  a.movedFrom = 'asher'; a.houseId = 'pardes';
  const res = plain(await vered.app.saveAll());
  assert.deepStrictEqual(res.moved.map((m) => m.id).sort(), ['id-a', 'id-x']);
  assert.deepStrictEqual(rowsFor(backend, NAME).map((r) => r.houseId + ':' + r.id), ['asher:id-x']);
  assert.deepStrictEqual(rowsFor(backend, ASHER_RES).map((r) => r.houseId + ':' + r.id), ['pardes:id-a']);
  assert.strictEqual(backend.patients().length, 4, 'four patients before, four after');
});

test('a move still pending when the house is edited again: the origin is kept (pardes → ramot lands); moving back cancels it', async () => {
  const backend = world();
  const vered = await openSession(backend, 'ורד');
  const x = byId(vered.app, 'id-x');
  x.movedFrom = 'pardes'; x.houseId = 'asher';               // pending, never saved
  await editPatient(vered, 'id-x', { houseId: 'ramot' });
  assert.deepStrictEqual(rowsFor(backend, NAME).map((r) => r.houseId + ':' + r.id), ['ramot:id-x']);
  assert.deepStrictEqual(plain(vered.app.errors()), []);

  const backend2 = world();
  const shirin = await openSession(backend2, 'שירן');
  const y = byId(shirin.app, 'id-x');
  y.movedFrom = 'pardes'; y.houseId = 'asher';
  const before = shirin.calls.length;
  await editPatient(shirin, 'id-x', { houseId: 'pardes' });
  const save = shirin.calls.slice(before).find((c) => c.action === 'saveAll');
  assert.strictEqual(save.patients.pardes.find((r) => r.id === 'id-x').movedFrom, undefined, 'no move is sent');
  assert.deepStrictEqual(rowsFor(backend2, NAME).map((r) => r.houseId + ':' + r.id), ['pardes:id-x']);
  assert.deepStrictEqual(plain(shirin.app.errors()), []);
});

/* ===== B. your OWN next edit is not "someone else's" ===== */

test('after a move, your OWN next edit of the moved patient is saved — not refused as stale', async () => {
  const backend = world();
  const vered = await openSession(backend, 'ורד');
  await editPatient(vered, 'id-x', { houseId: 'asher' });
  await editPatient(vered, 'id-x', { pay: '9900' });
  const [row] = rowsFor(backend, NAME);
  assert.strictEqual(Number(row.pay), 9900, 'the follow-up edit landed');
  assert.strictEqual(row.houseId, 'asher');
  assert.deepStrictEqual(plain(vered.app.errors()), [], 'no "ורד עדכן/ה קודם" refusal of her own edit');
  assert.ok(!backend.audit().some((a) => a.action === 'patient_save_conflict'));
});

test('the pre-existing false alarm is gone: a second edit of the same patient in the same tab is saved', async () => {
  const backend = world();
  const vered = await openSession(backend, 'ורד');
  await editPatient(vered, 'id-o', { pay: '9500' });
  await editPatient(vered, 'id-o', { pay: '9600' });
  assert.strictEqual(Number(rowsFor(backend, OTHER)[0].pay), 9600);
  assert.deepStrictEqual(plain(vered.app.errors()), []);
  assert.strictEqual(byId(vered.app, 'id-o').updatedAt, rowsFor(backend, OTHER)[0].updatedAt,
    'the tab holds the stamp the sheet holds');
});

/* ===== C. stale-tab protection is kept ===== */

test('STALE TAB without move intent: a tab that still holds the patient in pardes cannot drag them back or duplicate them', async () => {
  const backend = world();
  const stale = await openSession(backend, 'שירן');            // loaded BEFORE the move
  const vered = await openSession(backend, 'ורד');
  await editPatient(vered, 'id-x', { houseId: 'asher' });
  await editPatient(stale, 'id-x', { pay: '9100' });           // still thinks pardes
  assert.deepStrictEqual(rowsFor(backend, NAME).map((r) => r.houseId + ':' + r.id + ':' + Number(r.pay)), ['asher:id-x:9000'],
    'the stale pardes copy was refused: one row, still in asher, content untouched');
  assert.ok(stale.app.errors().some((e) => /לא נשמרה/.test(e)), 'the stale tab is told: ' + stale.app.errors());
});

test('STALE MOVE: someone saved the patient after this tab loaded → the move is REFUSED, the other edit survives, and the tab says so in Hebrew', async () => {
  const backend = world();
  const stale = await openSession(backend, 'שירן');
  const vered = await openSession(backend, 'ורד');
  await editPatient(vered, 'id-x', { pay: '12000' });           // restamps the row
  const gridBefore = backend.grid(backend.gs.PATIENTS_SHEET);
  const verdict = await editPatient(stale, 'id-x', { houseId: 'ramot' });
  assert.strictEqual(verdict, true, 'the modal closes; the banner explains');
  assert.deepStrictEqual(backend.grid(backend.gs.PATIENTS_SHEET), gridBefore, 'the sheet is byte-for-byte unchanged');
  const errs = stale.app.errors();
  assert.strictEqual(errs.length, 1, errs);
  assert.ok(errs[0].startsWith('המעבר של ' + NAME + ' ל' + RAMOT + ' לא נשמר'), errs[0]);
  assert.ok(errs[0].includes('ורד עדכן/ה את הרשומה בינתיים'), 'names who saved first');
  assert.ok(errs[0].includes('נשאר/ה ב' + PARDES), 'says where the patient still is');
  assert.strictEqual(stale.app.errorMs()[0], stale.app.REFUSAL_BANNER_MS, 'a refusal stays up long enough to read');
  assert.strictEqual(byId(stale.app, 'id-x').houseId, 'pardes', 'the tab shows the patient where they really are');
  const refused = backend.audit().filter((a) => a.action === 'patient_move_refused');
  assert.deepStrictEqual(refused.map((a) => a.details.move.reason), ['stale']);
});

test('MOVED ELSEWHERE: another tab moved the patient first → this move is refused and names the house the patient is really in', async () => {
  const backend = world();
  const stale = await openSession(backend, 'שירן');
  const vered = await openSession(backend, 'ורד');
  await editPatient(vered, 'id-x', { houseId: 'asher' });
  await editPatient(stale, 'id-x', { houseId: 'ramot' });
  assert.deepStrictEqual(rowsFor(backend, NAME).map((r) => r.houseId), ['asher']);
  const err = stale.app.errors().find((e) => e.startsWith('המעבר של'));
  assert.ok(err && err.includes('כבר נמצא/ת ב' + ASHER), stale.app.errors());
  assert.strictEqual(byId(stale.app, 'id-x').houseId, 'asher', 'the tab now shows asher');
});

test('DELETED meanwhile: moving a patient someone permanently deleted is refused — never resurrected', async () => {
  const backend = world();
  const stale = await openSession(backend, 'שירן');
  const del = backend.handle({ action: 'deletePatientRow', user: 'ורד',
    patient: { id: 'id-x', houseId: 'pardes', name: NAME, date: ENTRY } });
  assert.strictEqual(del.ok, true);
  await editPatient(stale, 'id-x', { houseId: 'asher' });
  assert.deepStrictEqual(rowsFor(backend, NAME), [], 'still deleted');
  assert.ok(stale.app.errors().some((e) => e.includes('הרשומה כבר לא קיימת בגיליון')), stale.app.errors());
});

test('the id-match stale-edit refusal is intact — and one tab\'s fresh stamps never leak into another tab', async () => {
  const backend = world();
  const stale = await openSession(backend, 'שירן');
  const vered = await openSession(backend, 'ורד');
  await editPatient(vered, 'id-o', { pay: '9500' });
  await editPatient(stale, 'id-o', { pay: '7000' });
  assert.strictEqual(Number(rowsFor(backend, OTHER)[0].pay), 9500, 'ורד\'s edit survives');
  assert.ok(stale.app.errors().some((e) => e.includes('ורד עדכן/ה קודם')), stale.app.errors());
});

/* ===== D. an older backend never leaves a silent revert ===== */

test('OLDER BACKEND (ignores movedFrom): the modal undoes the move on screen and says so', async () => {
  const backend = world();
  const oldBackend = (body) => {
    if (body.action === 'saveAll' && body.patients) {
      Object.keys(body.patients).forEach((h) => body.patients[h].forEach((r) => { delete r.movedFrom; }));
    }
    const res = backend.handle(body);
    delete res.moved;
    delete res.stamps;
    return res;
  };
  const vered = await openSession(backend, 'ורד', oldBackend);
  await editPatient(vered, 'id-x', { houseId: 'asher' });
  assert.deepStrictEqual(rowsFor(backend, NAME).map((r) => r.houseId), ['pardes'], 'the old backend refused it');
  const errs = vered.app.errors();
  assert.strictEqual(errs[errs.length - 1], 'המעבר של ' + NAME + ' ל' + ASHER + ' לא נשמר — ' + NAME + ' נשאר/ה ב' + PARDES + '.');
  assert.strictEqual(byId(vered.app, 'id-x').houseId, 'pardes', 'the screen is back to the truth');
  assert.strictEqual(byId(vered.app, 'id-x').movedFrom, undefined);
});

/* ===== E. the backend, directly ===== */

test('collectHouseMoves_: only an id arriving under a DIFFERENT house than its movedFrom; an id claimed twice is not a move', () => {
  const { gs } = loadBackend();
  assert.deepStrictEqual(plain(gs.collectHouseMoves({
    asher: [{ id: 'a', movedFrom: 'pardes' }, { id: 'b' }, { id: '', movedFrom: 'pardes' }, { id: 'c', movedFrom: 'asher' }],
    ramot: [{ id: 'd', movedFrom: ' pardes ' }],
    pardes: 'not-an-array',
  })), { a: { from: 'pardes', to: 'asher' }, d: { from: 'pardes', to: 'ramot' } });
  assert.deepStrictEqual(plain(gs.collectHouseMoves({
    asher: [{ id: 'dup', movedFrom: 'pardes' }], ramot: [{ id: 'dup', movedFrom: 'pardes' }],
  })), {}, 'ambiguous: neither is treated as a move');
  assert.deepStrictEqual(plain(gs.collectHouseMoves(null)), {});
});

function savePayload(backend, over) {
  // Every house, as the client sends it, from the sheet's current rows.
  const out = { arfoni: [], rehab: [], asher: [], pardes: [], ramot: [], sde: [] };
  backend.patients().forEach((r) => { out[r.houseId].push(Object.assign({}, r)); });
  (over || []).forEach((f) => f(out));
  return out;
}
const moveIn = (id, from, to, extra) => (out) => {
  const i = out[from].findIndex((r) => r.id === id);
  const [r] = out[from].splice(i, 1);
  out[to].push(Object.assign(r, { houseId: to, movedFrom: from }, extra || {}));
};

test('saveAll_: `moved` and `stamps` are additive — absent when a save has nothing to report', () => {
  const backend = world();
  const res = backend.handle({ action: 'saveAll', user: 'ורד', patients: savePayload(backend) });
  assert.strictEqual(res.ok, true);
  assert.ok(!('moved' in res) && !('stamps' in res) && !('conflicts' in res), JSON.stringify(Object.keys(res)));
  const res2 = backend.handle({ action: 'saveAll', user: 'ורד', patients: savePayload(backend, [moveIn('id-x', 'pardes', 'asher')]) });
  assert.deepStrictEqual(res2.moved, [{ id: 'id-x', name: NAME, fromHouseId: 'pardes', toHouseId: 'asher' }]);
  assert.deepStrictEqual(Object.keys(res2.stamps), ['id-x']);
  assert.strictEqual(res2.stamps['id-x'].updatedBy, 'ורד');
  assert.deepStrictEqual(res2.written, { arfoni: 0, rehab: 0, asher: 2, pardes: 2, ramot: 0, sde: 0 }, 'honest written counts');
});

test('stamps must MATCH exactly — blank equals blank, but a tab without the current stamp cannot move the row', () => {
  const unstamped = world({ updatedAt: '', updatedBy: '' });
  const ok = unstamped.handle({ action: 'saveAll', user: 'ורד',
    patients: savePayload(unstamped, [moveIn('id-x', 'pardes', 'asher', { updatedAt: '' })]) });
  assert.strictEqual(ok.moved.length, 1, 'never stamped, seen unstamped: the tab saw the current version');

  const stamped = world();
  const refused = stamped.handle({ action: 'saveAll', user: 'שירן',
    patients: savePayload(stamped, [moveIn('id-x', 'pardes', 'asher', { updatedAt: '' })]) });
  assert.ok(!refused.moved);
  assert.deepStrictEqual(refused.conflicts.map((c) => [c.id, c.move.reason, c.move.from, c.move.to]), [['id-x', 'stale', 'pardes', 'asher']]);
  assert.deepStrictEqual(rowsFor(stamped, NAME).map((r) => r.houseId), ['pardes']);
  assert.deepStrictEqual(stamped.tombstones(), [], 'a refused move is not a stale omission either');
});

test('the row leaving a house is RESERVED: a new namesake admitted there in the same save cannot take it over', () => {
  // asher is saved BEFORE pardes, so the leaving house's pass runs first.
  const backend = world();
  const res = backend.handle({ action: 'saveAll', user: 'ורד', patients: savePayload(backend, [
    moveIn('id-a', 'asher', 'pardes'),
    (out) => out.asher.push({ id: 'id-namesake', houseId: 'asher', name: ASHER_RES, date: ENTRY, pay: 5000, status: 'active', source: 'direct_admin' }),
  ]) });
  assert.ok(!res.conflicts, JSON.stringify(res.conflicts));
  assert.deepStrictEqual(rowsFor(backend, ASHER_RES).map((r) => r.houseId + ':' + r.id + ':' + Number(r.pay)).sort(),
    ['asher:id-namesake:5000', 'pardes:id-a:9000'], 'the patient moved intact; the namesake got its own row and id');
});

test('without the intent nothing changed: a cross-house lead-linked row is still refused by the fromLead guard', () => {
  const backend = world();
  const res = backend.handle({ action: 'saveAll', user: 'ורד',
    patients: savePayload(backend, [(out) => { moveIn('id-x', 'pardes', 'asher')(out); delete out.asher[out.asher.length - 1].movedFrom; }]) });
  assert.deepStrictEqual(res.promoteSkipped.asher.map((s) => s.reason), ['existing_patient_row']);
  assert.deepStrictEqual(rowsFor(backend, NAME).map((r) => r.houseId), ['pardes']);
});

/* ===== F. the client helpers ===== */

test('serializePatients carries movedFrom only while a move is pending', async () => {
  const backend = world();
  const vered = await openSession(backend, 'ורד');
  const plainOut = plain(vered.app.serializePatients());
  assert.ok(Object.values(plainOut).every((rows) => rows.every((r) => !('movedFrom' in r))), 'no key at all normally');
  const x = byId(vered.app, 'id-x');
  x.movedFrom = 'pardes'; x.houseId = 'asher';
  const out = plain(vered.app.serializePatients());
  assert.strictEqual(out.asher.find((r) => r.id === 'id-x').movedFrom, 'pardes');
});

test('applySaveOutcome: adopts only stamps whose object still holds what was sent; clears landed moves; reverts refused ones', async () => {
  const { app } = await openSession(world(), 'ורד');
  const a = { id: 'a', houseId: 'asher', updatedAt: 'T0' };
  const b = { id: 'b', houseId: 'asher', updatedAt: 'T0' };
  const m = { id: 'm', houseId: 'ramot', movedFrom: 'pardes', updatedAt: 'T0' };
  const r = { id: 'r', houseId: 'ramot', movedFrom: 'pardes', updatedAt: 'T0' };
  const sent = app.sentPatientsById([a, b, m, r]);
  b.updatedAt = 'T-other';   // restamped by something else after the send
  const out = plain(app.applySaveOutcome(sent, {
    stamps: { a: { updatedAt: 'T1', updatedBy: 'ורד' }, b: { updatedAt: 'T1', updatedBy: 'ורד' }, zz: { updatedAt: 'T9' } },
    moved: [{ id: 'm', fromHouseId: 'pardes', toHouseId: 'ramot' }],
    conflicts: [{ id: 'r', move: { from: 'pardes', to: 'ramot', reason: 'moved_elsewhere', currentHouseId: 'asher' } }],
  }));
  assert.deepStrictEqual(out, { stamped: ['a'], moved: ['m'], refused: ['r'] });
  assert.deepStrictEqual([a.updatedAt, a.updatedBy, b.updatedAt], ['T1', 'ורד', 'T-other']);
  assert.strictEqual(m.movedFrom, undefined);
  assert.deepStrictEqual([r.houseId, r.movedFrom, r._moveRefused.move.reason], ['asher', undefined, 'moved_elsewhere']);
  assert.deepStrictEqual(plain(app.applySaveOutcome(sent, { ok: true })), { stamped: [], moved: [], refused: [] }, 'an old backend: no fields, no-op');
  assert.deepStrictEqual(plain(app.applySaveOutcome(null, null)), { stamped: [], moved: [], refused: [] });
  const dup = app.sentPatientsById([{ id: 'd', updatedAt: '1' }, { id: 'd', updatedAt: '2' }, { id: '' }, null]);
  assert.strictEqual(dup.size, 0, 'an id held by two objects is ambiguous and left out');
});

test('conflictsMessage: a refused move gets its own sentence per reason; other refusals read exactly as before', async () => {
  const { app } = await openSession(world(), 'ורד');
  const mv = (reason, extra) => Object.assign({ id: 'x', name: NAME, sheetUpdatedBy: 'ורד',
    move: Object.assign({ from: 'pardes', to: 'ramot', reason, currentHouseId: 'pardes' }, extra || {}) });
  assert.strictEqual(app.conflictsMessage({ conflicts: [mv('stale')] }),
    'המעבר של ' + NAME + ' ל' + RAMOT + ' לא נשמר — ורד עדכן/ה את הרשומה בינתיים, ו' + NAME + ' נשאר/ה ב' + PARDES + '. הנתונים רועננו — אפשר לנסות שוב.');
  assert.strictEqual(app.conflictsMessage({ conflicts: [mv('moved_elsewhere', { currentHouseId: 'asher' })] }),
    'המעבר של ' + NAME + ' ל' + RAMOT + ' לא נשמר — ' + NAME + ' כבר נמצא/ת ב' + ASHER + ' (ורד העביר/ה קודם). הנתונים רועננו.');
  assert.strictEqual(app.conflictsMessage({ conflicts: [mv('source_missing', { currentHouseId: '' })] }),
    'המעבר של ' + NAME + ' ל' + RAMOT + ' לא נשמר — הרשומה כבר לא קיימת בגיליון. הנתונים רועננו.');
  const edit = { id: 'o', name: OTHER, sheetUpdatedBy: 'שירן' };
  assert.strictEqual(app.conflictsMessage({ conflicts: [edit] }), 'השינוי ל־' + OTHER + ' לא נשמר — שירן עדכן/ה קודם. הנתונים רועננו.',
    'the non-move sentence is unchanged');
  const both = app.conflictsMessage({ conflicts: [mv('stale'), edit] });
  assert.ok(both.startsWith('המעבר של') && both.endsWith('שירן עדכן/ה קודם. הנתונים רועננו.') && !both.includes(OTHER + ', '), both);
  assert.strictEqual(app.conflictsMessage({ conflicts: [] }), null);
});

test('houseMoveVerdict / moveNotSavedMessage', async () => {
  const { app } = await openSession(world(), 'ורד');
  assert.strictEqual(app.houseMoveVerdict({ id: 'x' }), 'moved');
  assert.strictEqual(app.houseMoveVerdict({ id: 'x', movedFrom: 'pardes' }), 'pending');
  assert.strictEqual(app.houseMoveVerdict({ id: 'x', _moveRefused: {} }), 'refused');
  assert.strictEqual(app.houseMoveVerdict(null), 'pending');
  assert.strictEqual(app.moveNotSavedMessage(NAME, 'pardes', 'sde'), 'המעבר של ' + NAME + ' לשדה אליעזר לא נשמר — ' + NAME + ' נשאר/ה ב' + PARDES + '.');
});

test('showError: one timer — a newer message is never hidden by an older banner\'s timeout; a duration can be given', () => {
  const timers = [];
  const cleared = [];
  const el = { textContent: '', classList: { hidden: true, add(c) { if (c === 'hidden') this.hidden = true; }, remove(c) { if (c === 'hidden') this.hidden = false; }, toggle() {} } };
  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/' },
    document: { getElementById: () => el, createElement: () => ({}), querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: (t) => { cleared.push(t); },
    URL, URLSearchParams, Math, Date, JSON, Number, String, Array, Object, RegExp, Promise, Map, Set,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(APP_SRC + '\nglobalThis.__showError = showError; globalThis.__REFUSAL_BANNER_MS = REFUSAL_BANNER_MS;', sandbox);
  sandbox.__showError('ראשון');
  sandbox.__showError('שני', sandbox.__REFUSAL_BANNER_MS);
  assert.strictEqual(el.textContent, 'שגיאה: שני');
  assert.deepStrictEqual(timers.map((t) => t.ms), [6000, 15000]);
  assert.ok(cleared.includes(1), 'the first banner\'s timer was cleared');
  assert.strictEqual(el.classList.hidden, false);
});

/* ===== G. the service worker ===== */

test('sw.js: CACHE_VERSION is v18 — never v17, which the reverted #145 used and phones still cache', () => {
  const v = /var CACHE_VERSION = '(v\d+)';/.exec(SW_SRC)[1];
  assert.notStrictEqual(v, 'v17', 'v17 is burned: #145 shipped it and #146 reverted it');
  assert.ok(Number(v.slice(1)) >= 18, 'found ' + v);
  assert.ok(SW_SRC.includes('v17 → v18: v17 is SKIPPED on purpose'), 'the bump comment explains the skip');
});
