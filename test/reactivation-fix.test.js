/* Regression tests: a re-activated patient must not vanish from the house tab.
 * PR #145's fix, re-landed (CHANGELOG-reactivation-fix.md). #145 shipped it,
 * #146 reverted it (phones on a stale SW v17 cache stopped loading), #147
 * re-landed only the read-only diagnostic. These are #145's tests, adapted to
 * today's app.js (house-move intent on ✏️, intake mode on direct-add), plus
 * the cases the current code adds.
 *
 * The bug:
 *   healClobberedDischarges() runs on EVERY load and flips the first patient
 *   whose houseId + name + entry date matches a NON-restored discharge audit
 *   row back to 'released' — then loadAll persists it. Released rows are
 *   hidden from the תפוסה house tab by default. The heal only reads the audit
 *   row's `restored` flag, so it cannot tell a clobbered discharge from a
 *   patient someone deliberately set back to live. Four deliberate paths left
 *   the stay's audit row(s) open:
 *     1. ✏️ openEditPatientModal — status שוחרר → פעיל / הפסקה זמנית;
 *     2. openDirectAddPatientModal — re-adding with the ORIGINAL entry date
 *        (the new row is written FIRST in the house, so it is the heal's
 *        first match);
 *     3. openEntryModal — admitting with that same entry date;
 *     4. doRestorePatientToActive — a stay with a SECOND open audit row
 *        (only the clicked one was flagged).
 *   On the next load (a reload, or any tab refocus ≥ 60s later) the patient
 *   silently flipped back to released and disappeared from the house.
 *
 * The fix under test: every one of those writes closes ALL the stay's open
 * audit rows (restored='TRUE', via the existing restorePatientToActive
 * action), and the heal announces itself with a toast instead of acting
 * silently.
 *
 * The end-to-end tests run the REAL public/app.js against the REAL
 * apps-script/Code.gs (vm sandboxes, fake sheets): the client's fetch is wired
 * straight into handle_, so "the next load" is a genuine getData round-trip.
 * All names, ids and dates below are SYNTHETIC. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const GS_SRC = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');
const SW_SRC = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');
const INDEX_SRC = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const arr = (x) => Array.from(x);
const FFFD = String.fromCharCode(0xfffd); // U+FFFD REPLACEMENT CHARACTER

/* ---------- synthetic fixtures (no real patient data) ---------- */
const NAME = 'ישראלה ישראלי';                 // Hebrew placeholder ("Jane Doe")
const OTHER = 'פלוני אלמוני';                  // a second, unrelated resident
const CORRUPT_NAME = 'ישראלה ישר' + FFFD + FFFD + 'לי'; // U+FFFD-damaged name
const ENTRY = '2026-06-01';

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
      PATIENT_COLUMNS, DISCHARGED_PATIENT_COLUMNS, LEAD_COLUMNS,
      PATIENTS_SHEET, DISCHARGED_PATIENTS_SHEET, LEADS_SHEET,
    };`, sandbox);
  const gs = sandbox.__gs;
  const rowOf = (cols, f) => arr(cols).map((c) => (f[c] === undefined ? '' : f[c]));
  return {
    gs,
    handle: (p) => JSON.parse(JSON.stringify(gs.handle(JSON.parse(JSON.stringify(p))))),
    seed(sheetName, cols, rows) {
      sandbox.__sheets[sheetName] = fakeSheet(arr(cols), rows.map((f) => rowOf(cols, f)));
    },
    rows(sheetName, cols) {
      const sh = sandbox.__sheets[sheetName];
      return sh ? arr(gs.readSheet(sh, cols)).map((r) => JSON.parse(JSON.stringify(r))) : [];
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
      if (opts && opts.body) body.user = user || 'ורד';
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
    showError = (m) => { globalThis.__errors.push(String(m)); };
    showToast = (m) => { globalThis.__toasts.push(String(m)); };
    showModal = (opts) => { globalThis.__modal = opts; };
    globalThis.__errors = [];
    globalThis.__toasts = [];
    globalThis.__app = {
      state,
      loadAll: () => loadAll(),
      settle: () => savePromise,
      normalizePatient: (p) => normalizePatient(p),
      normalizeDischargedPatient: (d) => normalizeDischargedPatient(d),
      healClobberedDischarges: () => healClobberedDischarges(),
      healedToastMessage: (h) => healedToastMessage(h),
      doRestorePatientAsNewLead: (p) => doRestorePatientAsNewLead(p),
      houseMoveVerdict: (p) => houseMoveVerdict(p),
      get REOPEN_NOT_CLOSED_MESSAGE() { return REOPEN_NOT_CLOSED_MESSAGE; },
      visibleOccupancyRows: (p, h, q, s) => visibleOccupancyRows(p, h, q, s),
      resolveHouseId: (h) => resolveHouseId(h),
      openDischargeAuditsFor: (p, d) => openDischargeAuditsFor(p, d),
      reopenedDischargeAudits: (b, a, d) => reopenedDischargeAudits(b, a, d),
      withAuditsRestored: (d, r) => withAuditsRestored(d, r),
      openEditPatientModal: (p) => openEditPatientModal(p),
      openDirectAddPatientModal: (o) => openDirectAddPatientModal(o),
      openEntryModal: (l) => openEntryModal(l),
      doRestorePatientToActive: (p) => doRestorePatientToActive(p),
      submitModal: (v) => globalThis.__modal.onSubmit(v),
      errors: () => globalThis.__errors,
      toasts: () => globalThis.__toasts,
    };`, sandbox);
  return { app: sandbox.__app, calls };
}

/* One "session": a fresh client, logged in (edit mode), after its first load
 * (loadAll + the fire-and-forget heal persist it may trigger). */
async function openSession(backend) {
  const client = loadClient((body) => backend.handle(body));
  client.app.state.mode = 'edit';
  await client.app.loadAll();
  await client.app.settle();
  return client;
}

/* Names the ramot house tab shows (released rows hidden — the default view). */
function ramotTab(app) {
  return arr(app.visibleOccupancyRows(app.state.patients, 'ramot', '', false)).map((p) => p.name);
}
function flagCalls(calls) {
  return calls.filter((c) => c && c.action === 'restorePatientToActive');
}

function patientRow(over) {
  return Object.assign({
    id: 'id-syn-1', houseId: 'ramot', name: NAME, date: ENTRY, pay: 9000, adv: 0,
    status: 'released', fromLead: '', exitDate: '2026-09-20', source: 'direct_admin', notes: '',
  }, over || {});
}
function auditRow(over) {
  return Object.assign({
    id: 'aud-syn-1', houseId: 'ramot', name: NAME, date: ENTRY, pay: 9000, adv: 0,
    status: 'released', fromLead: '', exitDate: '2026-09-20', source: 'direct_admin', notes: '',
    dischargedAt: '2026-09-20T08:00:00.000Z', disposition: 'completed', discharge_note: '',
    restored: '', prior_status: 'active',
  }, over || {});
}

/* A backend holding one released ramot patient with an OPEN discharge audit
 * row, plus an unrelated active resident. */
function releasedWorld(patientOver, auditOver, extraAudits) {
  const backend = loadBackend();
  const g = backend.gs;
  backend.seed(g.PATIENTS_SHEET, g.PATIENT_COLUMNS, [
    patientRow({ id: 'id-syn-0', name: OTHER, status: 'active', exitDate: '' }),
    patientRow(patientOver),
  ]);
  backend.seed(g.DISCHARGED_PATIENTS_SHEET, g.DISCHARGED_PATIENT_COLUMNS,
    [auditRow(auditOver)].concat(extraAudits || []));
  return backend;
}

/* ===== A. the pure helpers ===== */

test('openDischargeAuditsFor: open rows of the SAME stay only (house + name + entry date)', () => {
  const { app } = loadClient(() => ({ ok: true }));
  const p = app.normalizePatient(patientRow());
  const audits = [
    auditRow(),
    auditRow({ id: 'aud-restored-str', restored: 'TRUE' }),
    auditRow({ id: 'aud-restored-bool', restored: true }),
    auditRow({ id: 'aud-other-date', date: '2026-01-01' }),
    auditRow({ id: 'aud-other-house', houseId: 'arfoni' }),
    auditRow({ id: 'aud-other-name', name: OTHER }),
  ].map(app.normalizeDischargedPatient);
  assert.deepStrictEqual(arr(app.openDischargeAuditsFor(p, audits)).map((d) => d.id), ['aud-syn-1']);
  assert.deepStrictEqual(arr(app.openDischargeAuditsFor(null, audits)), []);
  assert.deepStrictEqual(arr(app.openDischargeAuditsFor(p, null)), []);
});

test('reopenedDischargeAudits: only a LIVE result re-opens; both identities count; deduped by id', () => {
  const { app } = loadClient(() => ({ ok: true }));
  const audits = [
    auditRow(),
    auditRow({ id: 'aud-corrupt', name: CORRUPT_NAME }),
  ].map(app.normalizeDischargedPatient);
  const before = app.normalizePatient(patientRow({ name: CORRUPT_NAME }));
  const after = app.normalizePatient(patientRow({ status: 'active' }));
  assert.deepStrictEqual(arr(app.reopenedDischargeAudits(before, after, audits)).map((d) => d.id),
    ['aud-syn-1', 'aud-corrupt'], 'an edit that also repairs the damaged name closes BOTH identities\' rows');
  assert.deepStrictEqual(arr(app.reopenedDischargeAudits(after, after, audits)).map((d) => d.id),
    ['aud-syn-1'], 'the same row is never listed twice');
  const stillReleased = app.normalizePatient(patientRow());
  assert.deepStrictEqual(arr(app.reopenedDischargeAudits(before, stillReleased, audits)), [],
    'a patient that stays released re-opens nothing');
  assert.deepStrictEqual(arr(app.reopenedDischargeAudits(null, null, audits)), []);
});

test('withAuditsRestored returns a NEW array and never mutates its input (rollback by reference)', () => {
  const { app } = loadClient(() => ({ ok: true }));
  const audits = [auditRow(), auditRow({ id: 'aud-2' })].map(app.normalizeDischargedPatient);
  const snapshot = JSON.parse(JSON.stringify(audits));
  const out = app.withAuditsRestored(audits, [audits[1]]);
  assert.notStrictEqual(out, audits);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(audits)), snapshot, 'input untouched');
  assert.deepStrictEqual(arr(out).map((d) => d.restored), ['', 'TRUE']);
});

/* ===== B. ✏️ re-activation (the reported symptom) — end to end ===== */

test('THE BUG (outcome only): a patient set back to פעיל via ✏️ is still in the house tab after a reload, and on the sheet as active', async () => {
  const backend = releasedWorld();
  const s1 = await openSession(backend);
  const p = s1.app.state.patients.find((x) => x.name === NAME);
  s1.app.openEditPatientModal(p);
  await s1.app.submitModal({ name: NAME, houseId: 'ramot', date: ENTRY, pay: '9000', status: 'active', notes: '' });
  assert.ok(ramotTab(s1.app).includes(NAME), 'visible right after the save (true before the fix too)');
  const s2 = await openSession(backend); // the reload
  assert.ok(ramotTab(s2.app).includes(NAME), 'before the fix the load-time heal released her again here');
  const onSheet = backend.rows(backend.gs.PATIENTS_SHEET, backend.gs.PATIENT_COLUMNS).find((r) => r.name === NAME);
  assert.strictEqual(onSheet.status, 'active');
});

test('✏️ released → פעיל survives the NEXT load: the patient stays in the ramot tab', async () => {
  const backend = releasedWorld();

  // Session 1 — the patient is released; ✏️, status → פעיל, save.
  const s1 = await openSession(backend);
  assert.deepStrictEqual(ramotTab(s1.app), [OTHER], 'released: hidden before the edit (default view)');
  const p = s1.app.state.patients.find((x) => x.name === NAME);
  s1.app.openEditPatientModal(p);
  const ok = await s1.app.submitModal({ name: NAME, houseId: 'ramot', date: ENTRY, pay: '9000', status: 'active', notes: '' });
  assert.strictEqual(ok, true);
  assert.deepStrictEqual(ramotTab(s1.app).sort(), [NAME, OTHER].sort(), 'visible right after the save');
  assert.deepStrictEqual(flagCalls(s1.calls).map((c) => c.patient.id), ['aud-syn-1'],
    'the stay\'s open discharge row is closed with the same restorePatientToActive action the restore modal uses');
  assert.deepStrictEqual(arr(s1.app.errors()), []);

  // Session 2 — the next load (reload / tab refocus). Before the fix the heal
  // flipped her back to released here and persisted it.
  const s2 = await openSession(backend);
  assert.deepStrictEqual(ramotTab(s2.app).sort(), [NAME, OTHER].sort(),
    'the re-activated patient must still be in the ramot tab after the next load');
  assert.deepStrictEqual(arr(s2.app.toasts()), [], 'nothing was healed');
  const onSheet = backend.rows(backend.gs.PATIENTS_SHEET, backend.gs.PATIENT_COLUMNS).find((r) => r.name === NAME);
  assert.strictEqual(onSheet.status, 'active', 'and the sheet agrees');
  const audit = backend.rows(backend.gs.DISCHARGED_PATIENTS_SHEET, backend.gs.DISCHARGED_PATIENT_COLUMNS)[0];
  assert.strictEqual(audit.restored, 'TRUE', 'the discharge record is kept, flagged restored (audit trail intact)');
});

test('U+FFFD-damaged name: the ✏️ re-activation still closes the stay and the patient stays visible', async () => {
  // The audit row copies the patient's name at discharge time, so a name
  // damaged by the 2026-07/08 chunk-split bug is damaged identically on both.
  const backend = releasedWorld({ name: CORRUPT_NAME }, { name: CORRUPT_NAME });
  const s1 = await openSession(backend);
  const p = s1.app.state.patients.find((x) => x.name === CORRUPT_NAME);
  assert.ok(p, 'a U+FFFD name is loaded, not dropped');
  s1.app.openEditPatientModal(p);
  await s1.app.submitModal({ name: CORRUPT_NAME, houseId: 'ramot', date: ENTRY, pay: '9000', status: 'active', notes: '' });
  assert.strictEqual(flagCalls(s1.calls).length, 1);

  const s2 = await openSession(backend);
  assert.ok(ramotTab(s2.app).includes(CORRUPT_NAME), 'still visible after the next load');
});

test('U+FFFD: repairing the damaged name in the SAME ✏️ save also closes the old identity\'s open row', async () => {
  const backend = releasedWorld({ name: CORRUPT_NAME }, { name: CORRUPT_NAME });
  const s1 = await openSession(backend);
  const p = s1.app.state.patients.find((x) => x.name === CORRUPT_NAME);
  s1.app.openEditPatientModal(p);
  await s1.app.submitModal({ name: NAME, houseId: 'ramot', date: ENTRY, pay: '9000', status: 'active', notes: '' });
  assert.deepStrictEqual(flagCalls(s1.calls).map((c) => c.patient.id), ['aud-syn-1']);
  const s2 = await openSession(backend);
  assert.ok(ramotTab(s2.app).includes(NAME));
  assert.deepStrictEqual(
    arr(s2.app.state.dischargedPatients).filter((d) => d.restored !== 'TRUE' && d.restored !== true), [],
    'no discharge record is left open for a patient who is active again');
});

test('house-label variant: a Hebrew-label / padded houseId still matches its discharge row', () => {
  const { app, calls } = loadClient(() => ({ ok: true }));
  // What the client does with the variants a hand-edited cell can hold —
  // the resolution this fix relies on.
  assert.strictEqual(app.resolveHouseId('רמות השבים'), 'ramot');
  assert.strictEqual(app.resolveHouseId(' ramot '), 'ramot');
  assert.strictEqual(app.resolveHouseId('RAMOT'), 'ramot');

  app.state.mode = 'edit';
  // Patient row stored under the Hebrew LABEL; its audit row under the id
  // with a padded name — both normalize to the same stay.
  const p = app.normalizePatient(patientRow({ houseId: 'רמות השבים' }));
  app.state.patients = [p];
  app.state.leads = [];
  app.state.dischargedPatients = [app.normalizeDischargedPatient(auditRow({ houseId: ' ramot', name: NAME + ' ' }))];
  assert.strictEqual(p.houseId, 'ramot');

  app.openEditPatientModal(p);
  return app.submitModal({ name: NAME, houseId: 'ramot', date: ENTRY, pay: '9000', status: 'active', notes: '' })
    .then(() => {
      assert.deepStrictEqual(flagCalls(calls).map((c) => c.patient.id), ['aud-syn-1']);
      // The next load's heal, run on the same (now flagged) state: no-op.
      assert.strictEqual(app.healClobberedDischarges().length, 0);
      assert.deepStrictEqual(ramotTab(app), [NAME]);
    });
});

/* ===== C. the other deliberate paths ===== */

test('restore with a SECOND open row for the stay: both are closed and the patient stays visible', async () => {
  const backend = releasedWorld({}, {}, [auditRow({ id: 'aud-syn-2', dischargedAt: '2026-09-21T08:00:00.000Z' })]);
  const s1 = await openSession(backend);
  const clicked = s1.app.state.dischargedPatients.find((d) => d.id === 'aud-syn-1');
  await s1.app.doRestorePatientToActive(clicked);
  assert.deepStrictEqual(flagCalls(s1.calls).map((c) => c.patient.id).sort(), ['aud-syn-1', 'aud-syn-2']);
  assert.deepStrictEqual(arr(s1.app.errors()), []);

  const s2 = await openSession(backend);
  assert.ok(ramotTab(s2.app).includes(NAME),
    'before the fix the second open row re-released her on this load');
});

test('direct re-add with the ORIGINAL entry date: the new row is not released by the next load', async () => {
  const backend = releasedWorld();
  const s1 = await openSession(backend);
  s1.app.openDirectAddPatientModal();
  const ok = await s1.app.submitModal({ name: NAME, houseId: 'ramot', date: ENTRY, pay: '9000', status: 'active', notes: '' });
  assert.strictEqual(ok, true);
  assert.deepStrictEqual(flagCalls(s1.calls).map((c) => c.patient.id), ['aud-syn-1']);

  const s2 = await openSession(backend);
  assert.ok(ramotTab(s2.app).includes(NAME), 'the re-added patient is in the ramot tab after the next load');
});

test('admission (entry modal) with the entry date of an open discharged stay: not released by the next load', async () => {
  const backend = releasedWorld();
  const g = backend.gs;
  backend.seed(g.LEADS_SHEET, g.LEAD_COLUMNS, [{
    id: 'lead-syn-9', name: NAME, phone: '', house: 'רמות השבים', stage: 'paid', entryDate: ENTRY, created: '2026-05-01',
  }]);
  const s1 = await openSession(backend);
  const lead = s1.app.state.leads.find((l) => l.id === 'lead-syn-9');
  s1.app.openEntryModal(lead);
  const ok = await s1.app.submitModal({ houseId: 'ramot', date: ENTRY, pay: '9000', adv: '0', status: 'trial' });
  assert.strictEqual(ok, true);
  assert.deepStrictEqual(flagCalls(s1.calls).map((c) => c.patient.id), ['aud-syn-1']);

  const s2 = await openSession(backend);
  assert.ok(ramotTab(s2.app).includes(NAME), 'the admitted patient is in the ramot tab after the next load');
});

/* ===== D. no collateral writes, and the heal still does its job ===== */

test('ordinary saves send NO extra writes: active edit, released-stays-released edit, brand-new add', async () => {
  const backend = releasedWorld();
  const s1 = await openSession(backend);

  const other = s1.app.state.patients.find((x) => x.name === OTHER);
  s1.app.openEditPatientModal(other);
  await s1.app.submitModal({ name: OTHER, houseId: 'ramot', date: ENTRY, pay: '9500', status: 'active', notes: 'הערה' });

  const released = s1.app.state.patients.find((x) => x.name === NAME);
  s1.app.openEditPatientModal(released);
  await s1.app.submitModal({ name: NAME, houseId: 'ramot', date: ENTRY, pay: '9000', status: 'released', notes: 'תיקון' });

  s1.app.openDirectAddPatientModal();
  await s1.app.submitModal({ name: 'מטופל חדש לדוגמה', houseId: 'ramot', date: '2026-09-28', pay: '9000', status: 'active', notes: '' });

  assert.deepStrictEqual(flagCalls(s1.calls), [], 'no discharge record is touched by an unrelated save');
  const s2 = await openSession(backend);
  assert.ok(!ramotTab(s2.app).includes(NAME), 'a patient left released stays released');
});

test('a GENUINE clobber is still healed on load — and now announced, never silent', async () => {
  // Sheet after a clobber: the patient is active again while her discharge
  // record is open (nobody re-activated her on purpose).
  const backend = releasedWorld({ status: 'active', exitDate: '' });
  const s1 = await openSession(backend);
  assert.ok(!ramotTab(s1.app).includes(NAME), 'healed back to released (the heal\'s purpose is unchanged)');
  assert.strictEqual(s1.app.toasts().length, 1, 'the heal tells the user');
  assert.match(s1.app.toasts()[0], /רישום שחרור פתוח/);
  assert.ok(s1.app.toasts()[0].includes(NAME), 'and names who moved out of the house tab');
  const onSheet = backend.rows(backend.gs.PATIENTS_SHEET, backend.gs.PATIENT_COLUMNS).find((r) => r.name === NAME);
  assert.strictEqual(onSheet.status, 'released', 'persisted, exactly as before');
});

test('flag write refused after the save: UI rolls back, error shown, next load converges to released', async () => {
  const backend = releasedWorld();
  const client = loadClient((body) => (body.action === 'restorePatientToActive'
    ? { ok: false, error: 'exception', message: 'flaky' }
    : backend.handle(body)));
  client.app.state.mode = 'edit';
  await client.app.loadAll();
  const p = client.app.state.patients.find((x) => x.name === NAME);
  client.app.openEditPatientModal(p);
  const ok = await client.app.submitModal({ name: NAME, houseId: 'ramot', date: ENTRY, pay: '9000', status: 'active', notes: '' });
  assert.strictEqual(ok, false, 'the modal stays open');
  assert.strictEqual(p.status, 'released', 'local rollback');
  assert.strictEqual(client.app.state.dischargedPatients[0].restored, '', 'the audit row is open again locally');
  assert.strictEqual(client.app.errors().length, 1);

  const s2 = await openSession(backend);
  assert.ok(!ramotTab(s2.app).includes(NAME),
    'the heal re-releases the half-saved row, so the sheet matches what the rolled-back UI showed');
});

/* ===== E. wiring guards (source level) ===== */

function fnBody(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'function not found: ' + name);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error('unbalanced braces in ' + name);
}

test('every deliberate re-activation path closes the stay\'s open discharge rows AFTER its save', () => {
  ['openDirectAddPatientModal', 'openEntryModal'].forEach((fn) => {
    const body = fnBody(APP_SRC, fn);
    assert.match(body, /reopenedDischargeAudits\(/, fn + ' must look for re-opened discharge rows');
    assert.match(body, /await saveAll\(\);\s*await persistAuditsRestored\(reopened\);/,
      fn + ' must persist the flags right after its saveAll (the restore modal\'s order)');
  });
  // ✏️: after the save, and only once a house move (if any) has landed.
  const edit = fnBody(APP_SRC, 'openEditPatientModal');
  assert.match(edit, /reopenedDischargeAudits\(prev, p, state\.dischargedPatients\)/);
  assert.match(edit, /await saveAll\(\);\s*saved = true;[\s\S]*?if \(!houseChanged \|\| houseMoveVerdict\(p\) === 'moved'\) \{\s*await persistAuditsRestored\(reopened\);/);
  const restore = fnBody(APP_SRC, 'doRestorePatientToActive');
  assert.match(restore, /openDischargeAuditsFor\(p, prevDischarged\)/);
  assert.match(restore, /await persistAuditsRestored\(siblings\);/);
});

test('loadAll announces a heal instead of moving patients out of the house silently', () => {
  const body = APP_SRC.slice(APP_SRC.indexOf('async function loadAll()'), APP_SRC.indexOf('function admissionMeetingOutcome'));
  assert.match(body, /if \(healed\.length > 0\) showToast\(/);
});

/* ===== F. today's code paths (added since #145) ===== */

test('intake («🟢 קליטת מטופל חדש») with the ORIGINAL entry date: the stay is closed and the patient stays visible', async () => {
  const backend = releasedWorld();
  const s1 = await openSession(backend);
  s1.app.openDirectAddPatientModal({ intake: true });
  const ok = await s1.app.submitModal({ name: NAME, houseId: 'ramot', date: ENTRY, pay: '', notes: '' });
  assert.strictEqual(ok, true);
  assert.deepStrictEqual(flagCalls(s1.calls).map((c) => c.patient.id), ['aud-syn-1']);
  const s2 = await openSession(backend);
  assert.ok(ramotTab(s2.app).includes(NAME), 'the intake row is in the ramot tab after the next load');
});

test('✏️ released → פעיל WITH a house move that lands: both identities\' rows closed, visible in the new house after the next load', async () => {
  const backend = releasedWorld();
  const s1 = await openSession(backend);
  const p = s1.app.state.patients.find((x) => x.name === NAME);
  s1.app.openEditPatientModal(p);
  const ok = await s1.app.submitModal({ name: NAME, houseId: 'arfoni', date: ENTRY, pay: '9000', status: 'active', notes: '' });
  await s1.app.settle();
  assert.strictEqual(ok, true);
  assert.strictEqual(s1.app.houseMoveVerdict(p), 'moved', 'the backend confirmed the move');
  assert.deepStrictEqual(flagCalls(s1.calls).map((c) => c.patient.id), ['aud-syn-1']);
  const s2 = await openSession(backend);
  const arfoni = arr(s2.app.visibleOccupancyRows(s2.app.state.patients, 'arfoni', '', false)).map((x) => x.name);
  assert.deepStrictEqual(arfoni, [NAME]);
  assert.deepStrictEqual(arr(s2.app.toasts()), [], 'nothing was healed');
});

test('✏️ re-activation whose house move is REFUSED: no flag is written and the open row stays open locally', async () => {
  const backend = releasedWorld();
  // The backend answers the save with a refused move (a stale tab, say).
  const client = loadClient((body) => {
    const res = backend.handle(body);
    if (body.action !== 'saveAll') return res;
    return Object.assign({}, res, { moved: [], conflicts: [{ id: 'id-syn-1', move: { from: 'ramot', to: 'arfoni', currentHouseId: 'ramot', reason: 'stale' } }] });
  });
  client.app.state.mode = 'edit';
  await client.app.loadAll();
  await client.app.settle();
  const p = client.app.state.patients.find((x) => x.name === NAME);
  client.app.openEditPatientModal(p);
  await client.app.submitModal({ name: NAME, houseId: 'arfoni', date: ENTRY, pay: '9000', status: 'active', notes: '' });
  assert.deepStrictEqual(flagCalls(client.calls), [], 'a refused edit closes nothing');
  assert.strictEqual(client.app.state.dischargedPatients.find((d) => d.id === 'aud-syn-1').restored, '',
    'the discharge row is open again on screen');
});

test('✏️ re-activation + landed move, flag write refused: the edit is kept (no move without intent), the row reopened, the user told', async () => {
  const backend = releasedWorld();
  const client = loadClient((body) => (body.action === 'restorePatientToActive'
    ? { ok: false, error: 'exception', message: 'flaky' }
    : backend.handle(body)));
  client.app.state.mode = 'edit';
  await client.app.loadAll();
  await client.app.settle();
  const p = client.app.state.patients.find((x) => x.name === NAME);
  client.app.openEditPatientModal(p);
  const ok = await client.app.submitModal({ name: NAME, houseId: 'arfoni', date: ENTRY, pay: '9000', status: 'active', notes: '' });
  assert.strictEqual(ok, true, 'the save itself went through');
  assert.strictEqual(p.houseId, 'arfoni', 'never put back in the old house without a move intent');
  assert.strictEqual(p.movedFrom, undefined);
  assert.strictEqual(client.app.state.dischargedPatients[0].restored, '', 'reopened locally');
  assert.deepStrictEqual(arr(client.app.errors()), [client.app.REOPEN_NOT_CLOSED_MESSAGE + 'flaky']);
});

test('no regression — restored and released: a restored audit row is ignored; a released patient stays released after the next load', async () => {
  // A patient restored earlier (audit restored='TRUE') and active: the heal and
  // every save leave her alone.
  const backend = releasedWorld({ status: 'active', exitDate: '' }, { restored: 'TRUE' });
  const s1 = await openSession(backend);
  assert.ok(ramotTab(s1.app).includes(NAME));
  assert.deepStrictEqual(arr(s1.app.toasts()), []);
  const p = s1.app.state.patients.find((x) => x.name === NAME);
  s1.app.openEditPatientModal(p);
  await s1.app.submitModal({ name: NAME, houseId: 'ramot', date: ENTRY, pay: '9100', status: 'wait', notes: '' });
  assert.deepStrictEqual(flagCalls(s1.calls), [], 'nothing to close');
  const s2 = await openSession(backend);
  assert.ok(ramotTab(s2.app).includes(NAME));
  // A plain released patient, never touched: hidden, no toast, no write.
  const released = await openSession(releasedWorld());
  assert.ok(!ramotTab(released.app).includes(NAME));
  assert.deepStrictEqual(arr(released.app.toasts()), []);
  assert.deepStrictEqual(flagCalls(released.calls), []);
});

test('no regression — leads: a re-admission with a NEW entry date leaves the old stay\'s row open; restore-as-new-lead is unchanged', async () => {
  const backend = releasedWorld();
  const g = backend.gs;
  backend.seed(g.LEADS_SHEET, g.LEAD_COLUMNS, [{
    id: 'lead-syn-7', name: NAME, phone: '', house: 'רמות השבים', stage: 'paid', entryDate: '', created: '2026-09-25',
  }]);
  const s1 = await openSession(backend);
  const lead = s1.app.state.leads.find((l) => l.id === 'lead-syn-7');
  s1.app.openEntryModal(lead);
  const ok = await s1.app.submitModal({ houseId: 'ramot', date: '2026-10-01', pay: '9000', adv: '0', status: 'trial' });
  assert.strictEqual(ok, true);
  assert.deepStrictEqual(flagCalls(s1.calls), [], 'a NEW stay does not touch the old discharge record');
  const s2 = await openSession(backend);
  const rows = arr(s2.app.visibleOccupancyRows(s2.app.state.patients, 'ramot', '', true)).filter((x) => x.name === NAME);
  assert.deepStrictEqual(rows.map((x) => [x.date, x.status]).sort(), [['2026-06-01', 'released'], ['2026-10-01', 'trial']],
    'the new stay is live, the old one stays released');
  assert.strictEqual(s2.app.state.dischargedPatients[0].restored, '', 'the old discharge record is still open (audit trail)');

  // Restore-as-new-lead: the same single restorePatient write as before.
  const s3 = await openSession(releasedWorld());
  const audit = s3.app.state.dischargedPatients[0];
  await s3.app.doRestorePatientAsNewLead(audit);
  assert.deepStrictEqual(s3.calls.filter((c) => /^restore/.test(c.action)).map((c) => c.action), ['restorePatient']);
});

test('escaping: the heal toast is plain text built from the name, and showToast renders it with textContent', () => {
  const { app } = loadClient(() => ({ ok: true }));
  const evil = '<img src=x onerror="window.__xss=1">';
  assert.strictEqual(app.healedToastMessage([{ name: evil }, { name: NAME }]),
    'סומנו כמשוחררים לפי רישום שחרור פתוח: ' + evil + ', ' + NAME, 'passed through verbatim, never decoded');
  assert.strictEqual(app.healedToastMessage([{}, null]), 'סומנו כמשוחררים לפי רישום שחרור פתוח: , ');
  const showToast = fnBody(APP_SRC, 'showToast');
  assert.match(showToast, /el\.textContent = msg;/);
  assert.doesNotMatch(showToast, /innerHTML/);
  const showError = fnBody(APP_SRC, 'showError');
  assert.match(showError, /el\.textContent = /);
  assert.doesNotMatch(showError, /innerHTML/);
});

test('a view-mode session writes no flag (persistAuditsRestored follows saveAll\'s edit-mode gate)', async () => {
  const backend = releasedWorld();
  const client = loadClient((body) => backend.handle(body));
  client.app.state.mode = 'view';
  await client.app.loadAll();
  const p = client.app.state.patients.find((x) => x.name === NAME);
  client.app.openEditPatientModal(p);
  await client.app.submitModal({ name: NAME, houseId: 'ramot', date: ENTRY, pay: '9000', status: 'active', notes: '' });
  assert.deepStrictEqual(client.calls.filter((c) => c.action === 'saveAll' || c.action === 'restorePatientToActive'), [],
    'neither the save nor a flag left the browser');
});

/* ===== G. phones pick up the new app.js (#186's hashed assets + SW) ===== */

function loadSw(cacheNames) {
  const caches = new Map(cacheNames.map((n) => [n, new Map()]));
  const deleted = [];
  const fetched = [];
  const handlers = {};
  const urlOf = (r) => (typeof r === 'string' ? r : r.url);
  const cacheApi = (name) => {
    if (!caches.has(name)) caches.set(name, new Map());
    const m = caches.get(name);
    return {
      match: (r, o) => {
        const u = new URL(urlOf(r));
        if (m.has(u.href)) return Promise.resolve(m.get(u.href));
        if (o && o.ignoreSearch) {
          for (const [k, v] of m) if (new URL(k).pathname === u.pathname) return Promise.resolve(v);
        }
        return Promise.resolve(undefined);
      },
      put: (r, res) => { m.set(new URL(urlOf(r)).href, res); return Promise.resolve(); },
      keys: () => Promise.resolve(Array.from(m.keys()).map((url) => ({ url }))),
      delete: (k) => Promise.resolve(m.delete(urlOf(k))),
      addAll: () => Promise.resolve(),
    };
  };
  const sandbox = {
    self: { addEventListener: (n, fn) => { handlers[n] = fn; }, skipWaiting: () => Promise.resolve(), clients: { claim: () => Promise.resolve() } },
    caches: {
      open: (n) => Promise.resolve(cacheApi(n)),
      keys: () => Promise.resolve(Array.from(caches.keys())),
      delete: (n) => { deleted.push(n); return Promise.resolve(caches.delete(n)); },
    },
    fetch: (r) => { fetched.push(urlOf(r)); return Promise.resolve({ status: 200, tag: 'network', clone() { return this; } }); },
    Response: { error: () => ({ tag: 'error' }) },
    Promise, URL, TypeError, Array, String,
    console: { log() {}, warn() {}, error() {} },
    module: { exports: {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(SW_SRC, sandbox);
  return { handlers, caches, deleted, fetched, cacheApi, exports: sandbox.module.exports };
}

test('SW v41+: a phone still holding the v40 cache, the burned v17 one and the OLD app.js hash gets the new app.js', async () => {
  const SA = require('../lib/static-assets');
  const sw = loadSw(['ezone-dashboard-v40', 'ezone-dashboard-v17']);
  // v41 shipped this fix; later public/ changes bump past it (v42: the
  // unadmitted-lead warning). v17 must never come back.
  assert.ok(Number(sw.exports.CACHE_VERSION.slice(1)) >= 41, 'got ' + sw.exports.CACHE_VERSION);
  assert.notStrictEqual(sw.exports.CACHE_VERSION, 'v17');

  // The index.html the server sends links app.js at the CURRENT bytes' hash.
  const store = SA.createAssetStore({ '/app.js': { file: path.join(ROOT, 'public', 'app.js'), mime: 'application/javascript' } });
  const html = SA.versionAssetRefs(INDEX_SRC, store);
  const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'public', 'app.js'))).digest('hex').slice(0, 12);
  assert.ok(html.includes('src="app.js?v=' + hash + '"'), 'index.html links the new app.js by its content hash');

  // Activate: every cache that is not the current one goes — v40 and the orphaned v17.
  let done;
  sw.handlers.activate({ waitUntil: (p) => { done = p; } });
  await done;
  assert.deepStrictEqual(sw.deleted.sort(), ['ezone-dashboard-v17', 'ezone-dashboard-v40']);

  // An old hash cached under the current version (a deploy within it) is never served
  // for the new URL: the exact-URL lookup misses and the network answers.
  const current = sw.cacheApi('ezone-dashboard-' + sw.exports.CACHE_VERSION);
  await current.put('https://x/app.js?v=000000000000', { tag: 'OLD BUNDLE' });
  let resp;
  sw.handlers.fetch({ request: { method: 'GET', url: 'https://x/app.js?v=' + hash }, respondWith: (p) => { resp = p; } });
  assert.strictEqual((await resp).tag, 'network', 'the new app.js, never the old bundle');
  assert.deepStrictEqual(sw.fetched, ['https://x/app.js?v=' + hash]);
  // The shell itself is network-first, so the new index.html (new hash) is what a phone reads.
  assert.strictEqual(sw.exports.cacheStrategy('https://x/'), 'network-first');
});
