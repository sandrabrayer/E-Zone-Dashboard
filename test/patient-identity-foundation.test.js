/* Patient identity foundation (PR 1 of 2): persistent patientId + who/when
 * stamping — schema, backfill and plumbing only; ZERO user-visible change and
 * ZERO identity/matching change (patientKey_ remains row identity; the flip
 * to patientId, per-row saves, updatedAt conflict refusal and the login name
 * picker are the follow-up PR).
 *
 * Locked contracts:
 *   - PATIENT_COLUMNS / PATIENT_TOMBSTONE_COLUMNS / DISCHARGED_PATIENT_COLUMNS
 *     pin patientId, updatedAt, updatedBy at the very END (append-only);
 *   - an APPEND assigns patientId ('id-' + uuid, the Leads style) only when
 *     the incoming row has none, and stamps updatedAt/updatedBy;
 *   - a key-matched REPLACE inherits the SHEET row's patientId and stamps —
 *     server-owned: a client can neither overwrite an existing id nor forge
 *     updatedBy (an unchanged row is not re-stamped; a real edit re-stamps
 *     from the proxy-injected user, never from the payload);
 *   - rename-in-place keeps the row's patientId;
 *   - patientId round-trips server → getData → client normalize/serialize →
 *     saveAll → server unchanged;
 *   - backfillPatientIdsNow is idempotent, never touches existing ids, copies
 *     ids to discharged/tombstone rows only on an unambiguous patientKey_
 *     match, audit-logs patient_id_backfilled, and is NOT dispatchable via
 *     handle_ (PR #105 precedent);
 *   - discharge / restore / delete stamp updatedAt/updatedBy and carry
 *     updatedBy in their audit details;
 *   - session tokens: a legacy user-less cookie still validates; a
 *     user-bearing cookie returns its (tamper-proof) name; the name is
 *     length-capped and escaped; the sheets proxy takes `user` ONLY from the
 *     signed cookie.
 *
 * vm-sandbox on the REAL shipped Code.gs / app.js, plus direct requires of
 * lib/session.js and server.js — per repo convention. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const arr = (x) => Array.from(x);
const plain = (x) => JSON.parse(JSON.stringify(x));

/* ================= Code.gs harness (as sibling suites) ================= */

let opSeq = 0;
function fakeSheet(headerRow, dataRows) {
  const grid = [headerRow.slice()].concat((dataRows || []).map((r) => r.slice()));
  const ops = [];
  let hidden = false;
  return {
    grid, ops,
    getLastRow() { return grid.length; },
    getLastColumn() { return grid[0] ? grid[0].length : 0; },
    getMaxRows() { return Math.max(grid.length, 1000); },
    setFrozenRows() {},
    hideSheet() { hidden = true; },
    isSheetHidden() { return hidden; },
    appendRow(row) { grid.push(row.slice()); },
    getRange(r, c, nr, nc) {
      nr = nr || 1; nc = nc || 1;
      return {
        setNumberFormat(fmt) { ops.push({ op: 'fmt', seq: ++opSeq, r, c, nr, nc, fmt }); },
        getValue() { const g = grid[r - 1]; return g ? (g[c - 1] === undefined ? '' : g[c - 1]) : ''; },
        setValue(v) {
          ops.push({ op: 'setcell', seq: ++opSeq, r, c });
          if (!grid[r - 1]) grid[r - 1] = [];
          grid[r - 1][c - 1] = v;
        },
        getValues() {
          const out = [];
          for (let i = 0; i < nr; i++) {
            const row = [];
            for (let j = 0; j < nc; j++) { const g = grid[r - 1 + i]; row.push(g ? (g[c - 1 + j] === undefined ? '' : g[c - 1 + j]) : ''); }
            out.push(row);
          }
          return out;
        },
        setValues(vals) {
          ops.push({ op: 'set', seq: ++opSeq, r, c, nr, nc });
          for (let i = 0; i < vals.length; i++) {
            if (!grid[r - 1 + i]) grid[r - 1 + i] = [];
            for (let j = 0; j < vals[i].length; j++) grid[r - 1 + i][c - 1 + j] = vals[i][j];
          }
        },
        clearContent() {
          ops.push({ op: 'clear', seq: ++opSeq, r, c, nr, nc });
          for (let i = 0; i < nr; i++) {
            if (!grid[r - 1 + i]) continue;
            for (let j = 0; j < nc; j++) grid[r - 1 + i][c - 1 + j] = '';
          }
        },
      };
    },
  };
}

function loadCode() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
  const noop = () => {};
  let uuid = 0;
  const logs = [];
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    JSON, Math, Date, Number, String, Array, Object, RegExp,
    Logger: { log: (m) => logs.push(String(m)) },
    __sheets: {},
    __digestSheets: {},
    __props: {},
    __logs: logs,
  };
  sandbox.SpreadsheetApp = {
    getActiveSpreadsheet: () => ({
      getSheetByName: (name) => sandbox.__sheets[name] || null,
      insertSheet: (name) => (sandbox.__sheets[name] = fakeSheet([], [])),
      getSpreadsheetTimeZone: () => 'Asia/Jerusalem',
    }),
    openById: () => ({
      getSheetByName: (name) => sandbox.__digestSheets[name] || null,
      insertSheet: (name) => (sandbox.__digestSheets[name] = fakeSheet([], [])),
    }),
  };
  sandbox.PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (k) => (k in sandbox.__props ? sandbox.__props[k] : null),
      setProperty(k, v) { sandbox.__props[k] = v; return this; },
    }),
  };
  sandbox.ContentService = {
    createTextOutput: (s) => ({ setMimeType: () => ({ json: JSON.parse(s) }) }),
    MimeType: { JSON: 'json' },
  };
  sandbox.Utilities = {
    getUuid: () => 'uuid-' + (++uuid),
    formatDate: (d) => d.toISOString().slice(0, 10),
  };
  sandbox.LockService = { getScriptLock: () => ({ tryLock: noop, releaseLock: noop }) };
  sandbox.globalThis = sandbox;
  const epilogue = `globalThis.__test = {
    PATIENT_COLUMNS: PATIENT_COLUMNS,
    PATIENT_TOMBSTONE_COLUMNS: PATIENT_TOMBSTONE_COLUMNS,
    DISCHARGED_PATIENT_COLUMNS: DISCHARGED_PATIENT_COLUMNS,
    PATIENTS_SHEET: PATIENTS_SHEET,
    PATIENTS_TOMBSTONES_SHEET: PATIENTS_TOMBSTONES_SHEET,
    DISCHARGED_PATIENTS_SHEET: DISCHARGED_PATIENTS_SHEET,
    LEAD_COLUMNS: LEAD_COLUMNS,
    LEADS_SHEET: LEADS_SHEET,
    AUDIT_LOG_COLUMNS: AUDIT_LOG_COLUMNS,
    AUDIT_LOG_SHEET: AUDIT_LOG_SHEET,
    readSheet: (sh, cols) => readSheet_(sh, cols),
    handle: (params) => handle_(params).json,
    saveAll: (l, p, u) => saveAll_(l, p, u),
    getData: () => getData_(),
    backfill: () => backfillPatientIdsNow(),
    discharge: (p, u) => dischargePatient_(p, u),
    restoreActive: (p, u) => restorePatientToActive_(p, u),
    del: (p, u) => deletePatientRow_(p, u),
    patientKey: (h, n, d) => patientKey_(h, n, d),
  };`;
  vm.createContext(sandbox);
  vm.runInContext(src + epilogue, sandbox);
  return { code: sandbox.__test, sandbox };
}

function rowOf(cols, fields) {
  const row = cols.map(() => '');
  Object.keys(fields).forEach((k) => { row[cols.indexOf(k)] = fields[k]; });
  return row;
}
function seedSheet(code, sandbox, sheetName, cols, rows) {
  sandbox.__sheets[sheetName] = fakeSheet(arr(cols), (rows || []).map((f) => rowOf(arr(cols), f)));
  return sandbox.__sheets[sheetName];
}
function patientsOf(code, sandbox) {
  return code.readSheet(sandbox.__sheets[code.PATIENTS_SHEET], arr(code.PATIENT_COLUMNS));
}
function auditOf(code, sandbox) {
  const sh = sandbox.__sheets[code.AUDIT_LOG_SHEET];
  return sh ? code.readSheet(sh, arr(code.AUDIT_LOG_COLUMNS)) : [];
}
function isIso(v) {
  return typeof v === 'string' && v !== '' && Number.isFinite(Date.parse(v));
}

const BASE = { houseId: 'ramot', name: 'שרה כהן', date: '2026-07-01',
               pay: 9000, adv: 0, status: 'active', source: 'lead' };

/* ===== A. column pins (append-only, identity columns at the END) ===== */

test('the three column lists pin patientId/updatedAt/updatedBy at the very END', () => {
  const { code } = loadCode();
  assert.deepStrictEqual(arr(code.PATIENT_COLUMNS), [
    'houseId', 'name', 'date', 'pay', 'adv',
    'status', 'fromLead', 'exitDate', 'source', 'notes',
    'patientId', 'updatedAt', 'updatedBy',
  ], 'PATIENT_COLUMNS: never insert/delete/reorder — the next append goes after updatedBy');
  assert.deepStrictEqual(arr(code.PATIENT_TOMBSTONE_COLUMNS), [
    'houseId', 'name', 'date', 'pay', 'adv',
    'status', 'fromLead', 'exitDate', 'source', 'notes',
    'droppedAt', 'reason', 'savedByAction',
    'patientId', 'updatedAt', 'updatedBy',
  ], 'tombstones: audit metadata keeps its positions; identity columns appended after it');
  assert.deepStrictEqual(arr(code.DISCHARGED_PATIENT_COLUMNS), [
    'id',
    'houseId', 'name', 'date', 'pay', 'adv',
    'status', 'fromLead', 'exitDate', 'source', 'notes',
    'dischargedAt', 'disposition', 'discharge_note', 'restored', 'prior_status',
    'patientId', 'updatedAt', 'updatedBy',
  ], 'discharged: NOW A LITERAL (deriving from PATIENT_COLUMNS would inject mid-list); identity columns at the END');
});

/* ===== B. append assigns id + stamps (through handle_, covering the user plumbing) ===== */

test('APPEND via handle_ assigns an id- patientId and stamps updatedAt/updatedBy from the injected user', () => {
  const { code, sandbox } = loadCode();
  seedSheet(code, sandbox, code.PATIENTS_SHEET, arr(code.PATIENT_COLUMNS), []);
  const res = code.handle({ action: 'saveAll', user: 'ורד',
    patients: { ramot: [Object.assign({}, BASE)] } });
  assert.strictEqual(res.ok, true);

  const after = patientsOf(code, sandbox);
  assert.strictEqual(after.length, 1);
  assert.ok(/^id-/.test(after[0].patientId), 'server-assigned id, Leads style: ' + after[0].patientId);
  assert.ok(isIso(after[0].updatedAt), 'updatedAt is an ISO timestamp');
  assert.strictEqual(after[0].updatedBy, 'ורד');

  const added = auditOf(code, sandbox).find((a) => a.action === 'patient_added');
  assert.strictEqual(JSON.parse(added.details).updatedBy, 'ורד', 'audit details carry updatedBy');
});

test('APPEND keeps an incoming patientId — a row with an id never gets a new one', () => {
  const { code, sandbox } = loadCode();
  seedSheet(code, sandbox, code.PATIENTS_SHEET, arr(code.PATIENT_COLUMNS), []);
  code.saveAll(null, { ramot: [Object.assign({}, BASE, { patientId: 'id-precious' })] }, 'ורד');
  assert.strictEqual(patientsOf(code, sandbox)[0].patientId, 'id-precious');
});

/* ===== C. replace: server-owned id + stamps ===== */

test('unchanged echo: nothing re-stamped, and a forged patientId/updatedBy cannot overwrite the sheet', () => {
  const { code, sandbox } = loadCode();
  seedSheet(code, sandbox, code.PATIENTS_SHEET, arr(code.PATIENT_COLUMNS), [
    Object.assign({}, BASE, { patientId: 'id-keep', updatedAt: '2026-09-01T08:00:00.000Z', updatedBy: 'ורד' }),
  ]);
  const res = code.saveAll(null, { ramot: [
    Object.assign({}, BASE, { patientId: 'id-EVIL', updatedAt: '1999-01-01T00:00:00.000Z', updatedBy: 'האקר' }),
  ] }, 'דנה');
  assert.strictEqual(res.ok, true);

  const after = patientsOf(code, sandbox)[0];
  assert.deepStrictEqual(
    { patientId: after.patientId, updatedAt: after.updatedAt, updatedBy: after.updatedBy },
    { patientId: 'id-keep', updatedAt: '2026-09-01T08:00:00.000Z', updatedBy: 'ורד' },
    'sheet values win — the payload meta fields are never data');
  assert.ok(!auditOf(code, sandbox).some((a) => a.action === 'patient_edited'),
    'no real edit → no patient_edited event, no re-stamp');
});

test('a real edit re-stamps updatedAt/updatedBy from the injected user and keeps the sheet patientId', () => {
  const { code, sandbox } = loadCode();
  seedSheet(code, sandbox, code.PATIENTS_SHEET, arr(code.PATIENT_COLUMNS), [
    Object.assign({}, BASE, { patientId: 'id-keep', updatedAt: '2026-09-01T08:00:00.000Z', updatedBy: 'ורד' }),
  ]);
  code.saveAll(null, { ramot: [Object.assign({}, BASE, { pay: 9500 })] }, 'דנה');

  const after = patientsOf(code, sandbox)[0];
  assert.strictEqual(after.pay, 9500, 'the edit landed');
  assert.strictEqual(after.patientId, 'id-keep', 'persistent id survives the edit');
  assert.strictEqual(after.updatedBy, 'דנה', 're-stamped from the proxy-injected user');
  assert.ok(isIso(after.updatedAt) && after.updatedAt !== '2026-09-01T08:00:00.000Z', 'updatedAt refreshed');

  const edited = auditOf(code, sandbox).find((a) => a.action === 'patient_edited');
  const d = JSON.parse(edited.details);
  assert.strictEqual(d.updatedBy, 'דנה');
  assert.deepStrictEqual(plain(d.changed), ['pay'], 'meta columns never count as "changed"');
});

test('rename-in-place (fromLead match) keeps the row\'s patientId and stamps the write', () => {
  const { code, sandbox } = loadCode();
  seedSheet(code, sandbox, code.PATIENTS_SHEET, arr(code.PATIENT_COLUMNS), [
    Object.assign({}, BASE, { fromLead: 'L1', patientId: 'id-keep' }),
  ]);
  // New name → new identity key → append-shaped write resolved by rule 1
  // (rename-in-place). The persistent id must ride along.
  code.saveAll(null, { ramot: [
    Object.assign({}, BASE, { name: 'שרה לוי-כהן', fromLead: 'L1' }),
  ] }, 'ורד');

  const after = patientsOf(code, sandbox);
  assert.strictEqual(after.length, 1, 'updated in place, not duplicated');
  assert.deepStrictEqual(
    { name: after[0].name, patientId: after[0].patientId, updatedBy: after[0].updatedBy },
    { name: 'שרה לוי-כהן', patientId: 'id-keep', updatedBy: 'ורד' });
  assert.ok(isIso(after[0].updatedAt));
  const renamed = auditOf(code, sandbox).find((a) => a.action === 'patient_renamed_via_fromLead');
  assert.strictEqual(JSON.parse(renamed.details).updatedBy, 'ורד');
});

/* ===== D. round-trip: server → getData → saveAll → server, unchanged ===== */

test('a patient with patientId survives getData → saveAll echo byte-for-byte (no re-stamp, id intact)', () => {
  const { code, sandbox } = loadCode();
  seedSheet(code, sandbox, code.PATIENTS_SHEET, arr(code.PATIENT_COLUMNS), [
    Object.assign({}, BASE, { patientId: 'id-rt', updatedAt: '2026-09-01T08:00:00.000Z', updatedBy: 'ורד' }),
  ]);
  const data = code.getData();
  const echoed = plain(data.patients.ramot[0]);
  assert.deepStrictEqual(
    { patientId: echoed.patientId, updatedAt: echoed.updatedAt, updatedBy: echoed.updatedBy },
    { patientId: 'id-rt', updatedAt: '2026-09-01T08:00:00.000Z', updatedBy: 'ורד' },
    'getData carries the three fields to the client');

  const before = plain(patientsOf(code, sandbox));
  code.saveAll(null, { ramot: [echoed] }, 'דנה');
  assert.deepStrictEqual(plain(patientsOf(code, sandbox)), before,
    'echoing the loaded row back changes nothing on the sheet');
});

/* ===== E. backfillPatientIdsNow ===== */

test('backfill: fills blank Patients ids only, copies to discharged/tombstones on an UNAMBIGUOUS key, idempotent, audited', () => {
  const { code, sandbox } = loadCode();
  const PC = arr(code.PATIENT_COLUMNS);
  const patientsSh = seedSheet(code, sandbox, code.PATIENTS_SHEET, PC, [
    BASE,                                                                       // row 2 — blank id → assigned
    Object.assign({}, BASE, { name: 'דנה לוי', patientId: 'id-has' }),          // row 3 — existing id → untouched
    { houseId: 'arfoni', name: 'רון', date: '2026-06-10', pay: 8000, status: 'active' }, // rows 4+5 —
    { houseId: 'arfoni', name: 'רון', date: '2026-06-10', pay: 8000, status: 'active' }, //   duplicate key
  ]);
  seedSheet(code, sandbox, code.DISCHARGED_PATIENTS_SHEET, arr(code.DISCHARGED_PATIENT_COLUMNS), [
    Object.assign({ id: 'd1' }, BASE, { status: 'released' }),                  // unique key → gets שרה's id
    { id: 'd2', houseId: 'arfoni', name: 'רון', date: '2026-06-10', status: 'released' }, // ambiguous → blank
    { id: 'd3', houseId: 'sde', name: 'אין כזה', date: '2026-01-01', status: 'released' }, // no match → blank
  ]);
  seedSheet(code, sandbox, code.PATIENTS_TOMBSTONES_SHEET, arr(code.PATIENT_TOMBSTONE_COLUMNS), [
    Object.assign({}, BASE, { droppedAt: '2026-08-01T00:00:00.000Z', reason: 'saveAll-omitted-preserved', savedByAction: 'saveAll' }),
  ]);

  const res = code.backfill();
  assert.deepStrictEqual(plain(res), { patients: 3, discharged: 1, tombstones: 1, ambiguous: 1, unmatched: 1 });

  const after = patientsOf(code, sandbox);
  const sara = after.find((p) => p.name === 'שרה כהן');
  assert.ok(/^id-/.test(sara.patientId), 'blank id assigned');
  assert.strictEqual(after.find((p) => p.name === 'דנה לוי').patientId, 'id-has', 'existing id NEVER replaced');
  const rons = after.filter((p) => p.name === 'רון');
  assert.ok(rons.every((p) => /^id-/.test(p.patientId)) && rons[0].patientId !== rons[1].patientId,
    'duplicate-key rows each get their own id');

  const discharged = code.readSheet(sandbox.__sheets[code.DISCHARGED_PATIENTS_SHEET], arr(code.DISCHARGED_PATIENT_COLUMNS));
  assert.strictEqual(discharged.find((d) => d.id === 'd1').patientId, sara.patientId, 'unambiguous key → live row id copied');
  assert.strictEqual(discharged.find((d) => d.id === 'd2').patientId, '', 'ambiguous key → left blank');
  assert.strictEqual(discharged.find((d) => d.id === 'd3').patientId, '', 'no live match → left blank');
  assert.ok(sandbox.__logs.some((m) => /AMBIGUOUS/.test(m)), 'ambiguity logged');

  const tombs = code.readSheet(sandbox.__sheets[code.PATIENTS_TOMBSTONES_SHEET], arr(code.PATIENT_TOMBSTONE_COLUMNS));
  assert.strictEqual(tombs[0].patientId, sara.patientId, 'tombstone matched by key gets the id too');

  const audit = auditOf(code, sandbox).find((a) => a.action === 'patient_id_backfilled');
  assert.deepStrictEqual(JSON.parse(audit.details),
    { patients: 3, discharged: 1, tombstones: 1, ambiguous: 1, unmatched: 1 });

  // Idempotent: run 2 writes nothing and changes nothing.
  const snapshot = plain(patientsOf(code, sandbox));
  patientsSh.ops.length = 0;
  // The still-blank audit rows are re-reported (d2 ambiguous, d3 unmatched)
  // but NOTHING is written for them — blank is their correct final state.
  const res2 = code.backfill();
  assert.deepStrictEqual(plain(res2), { patients: 0, discharged: 0, tombstones: 0, ambiguous: 1, unmatched: 1 });
  assert.deepStrictEqual(plain(patientsOf(code, sandbox)), snapshot);
  assert.deepStrictEqual(patientsSh.ops.filter((o) => o.op === 'set' || o.op === 'setcell'), [],
    'second run: zero Patients writes');
});

/* ===== F. discharge / restore / delete stamping ===== */

test('dischargePatient_ stamps updatedAt/updatedBy server-side (forged client stamps ignored) and audits updatedBy', () => {
  const { code, sandbox } = loadCode();
  code.discharge(Object.assign({ id: 'd1' }, BASE, { status: 'released', updatedBy: 'האקר', updatedAt: '1999-01-01T00:00:00.000Z' }), 'ורד');
  const rows = code.readSheet(sandbox.__sheets[code.DISCHARGED_PATIENTS_SHEET], arr(code.DISCHARGED_PATIENT_COLUMNS));
  assert.strictEqual(rows[0].updatedBy, 'ורד', 'stamped from the injected user, not the payload');
  assert.ok(isIso(rows[0].updatedAt) && rows[0].updatedAt !== '1999-01-01T00:00:00.000Z');
  const a = auditOf(code, sandbox).find((x) => x.action === 'patient_discharged');
  assert.strictEqual(JSON.parse(a.details).updatedBy, 'ורד');
});

test('restorePatientToActive_ stamps the flagged discharged row and audits updatedBy', () => {
  const { code, sandbox } = loadCode();
  seedSheet(code, sandbox, code.DISCHARGED_PATIENTS_SHEET, arr(code.DISCHARGED_PATIENT_COLUMNS), [
    Object.assign({ id: 'd1' }, BASE, { status: 'released' }),
  ]);
  code.restoreActive(Object.assign({ id: 'd1' }, BASE, { status: 'released' }), 'דנה');
  const rows = code.readSheet(sandbox.__sheets[code.DISCHARGED_PATIENTS_SHEET], arr(code.DISCHARGED_PATIENT_COLUMNS));
  assert.strictEqual(rows[0].restored, 'TRUE');
  assert.strictEqual(rows[0].updatedBy, 'דנה');
  assert.ok(isIso(rows[0].updatedAt));
  const a = auditOf(code, sandbox).find((x) => x.action === 'patient_restored_active');
  assert.strictEqual(JSON.parse(a.details).updatedBy, 'דנה');
});

test('deletePatientRow_ audits who deleted (updatedBy in details)', () => {
  const { code, sandbox } = loadCode();
  seedSheet(code, sandbox, code.PATIENTS_SHEET, arr(code.PATIENT_COLUMNS), [BASE]);
  const res = code.del({ houseId: BASE.houseId, name: BASE.name, date: BASE.date }, 'ורד');
  assert.strictEqual(res.ok, true);
  const a = auditOf(code, sandbox).find((x) => x.action === 'patient_deleted');
  assert.strictEqual(JSON.parse(a.details).updatedBy, 'ורד');
});

/* ===== dispatch guard (PR #105 precedent) ===== */

test('source-scan: backfillPatientIdsNow is public but never dispatchable via handle_', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
  assert.ok(/function backfillPatientIdsNow\(\)/.test(src), 'public (Run dropdown)');
  const handleStart = src.indexOf('function handle_');
  const handleEnd = src.indexOf('\nfunction ', handleStart + 1);
  assert.ok(!src.slice(handleStart, handleEnd).includes('backfillPatientIdsNow'),
    'handle_ must never route to backfillPatientIdsNow');
});

/* ================= lib/session.js: user-bearing tokens ================= */

const SECRET = 'test-session-secret-0123456789abcdef0123456789';
process.env.SESSION_SECRET = SECRET; // must be set before server.js is required
const { createSessionToken, verifySessionToken, readSessionUser } = require('../lib/session');
const server = require('../server');

test('legacy user-less token still validates and reads back an empty user', () => {
  const token = createSessionToken(SECRET);
  assert.strictEqual(token.split('.').length, 2, 'legacy format byte-for-byte');
  assert.strictEqual(verifySessionToken(token, SECRET), true);
  assert.strictEqual(readSessionUser(token, SECRET), '');
});

test('user-bearing token validates and returns the Hebrew name; tampering the name breaks the HMAC', () => {
  const token = createSessionToken(SECRET, undefined, undefined, 'ורד לוי');
  assert.strictEqual(token.split('.').length, 3, 'expiry.userB64.sig');
  assert.strictEqual(verifySessionToken(token, SECRET), true);
  assert.strictEqual(readSessionUser(token, SECRET), 'ורד לוי');

  const [expiry, , sig] = token.split('.');
  const forgedName = Buffer.from('האקר', 'utf8').toString('base64url');
  const forged = expiry + '.' + forgedName + '.' + sig;
  assert.strictEqual(verifySessionToken(forged, SECRET), false, 'signature covers the name');
  assert.strictEqual(readSessionUser(forged, SECRET), '');
});

test('user-bearing token respects scope separation and expiry', () => {
  const scoped = createSessionToken(SECRET, undefined, 'meeting-report', 'ורד');
  assert.strictEqual(verifySessionToken(scoped, SECRET, 'meeting-report'), true);
  assert.strictEqual(verifySessionToken(scoped, SECRET), false, 'wrong scope never validates');
  assert.strictEqual(verifySessionToken(createSessionToken(SECRET, -10, undefined, 'ורד'), SECRET), false, 'expired');
});

/* ================= server.js: sanitizer, cookie, /api/me, proxy ================= */

test('sanitizeSessionUser trims, caps at 40 chars, strips angle brackets and control chars', () => {
  assert.strictEqual(server.sanitizeSessionUser('  ורד לוי  '), 'ורד לוי');
  assert.strictEqual(server.sanitizeSessionUser('א'.repeat(60)).length, 40, 'length-capped');
  assert.strictEqual(server.sanitizeSessionUser('<script>ורד</script>'), 'scriptורד/script', 'escaped: no angle brackets survive');
  assert.strictEqual(server.sanitizeSessionUser('ורד\u0007\u0000'), 'ורד', 'control chars stripped');
  assert.strictEqual(server.sanitizeSessionUser(undefined), '');
  assert.strictEqual(server.sanitizeSessionUser(12345), '');
  assert.strictEqual(server.sanitizeSessionUser('ד"ר ורד'), 'ד"ר ורד', 'Hebrew names with quotes survive');
});

test('sessionUserFromRequest reads the name only from a VERIFIED cookie; legacy cookie → blank', () => {
  const withUser = { headers: { cookie: 'ezone_session=' + createSessionToken(SECRET, undefined, undefined, 'ורד') } };
  assert.strictEqual(server.sessionUserFromRequest(withUser), 'ורד');
  const legacy = { headers: { cookie: 'ezone_session=' + createSessionToken(SECRET) } };
  assert.strictEqual(server.sessionUserFromRequest(legacy), '', 'old cookies keep working with a blank user');
  const tampered = { headers: { cookie: 'ezone_session=123.deadbeef' } };
  assert.strictEqual(server.sessionUserFromRequest(tampered), '', 'invalid cookie never yields a name');
});

test('old cookies still authorize data routes (requireSession) — the user field is optional', () => {
  const req = { headers: { cookie: 'ezone_session=' + createSessionToken(SECRET) }, originalUrl: '/api/sheets' };
  let called = false;
  server.requireSession(req, { status: () => ({ json: () => {} }) }, () => { called = true; });
  assert.strictEqual(called, true);
});

test('source-scan: login accepts user into the signed cookie, /api/me is session-gated, the proxy overwrites body.user from the cookie', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(/sanitizeSessionUser\(req\.body && req\.body\.user\)/.test(src),
    'verify-pin reads the optional user from the login POST');
  assert.ok(/createSessionToken\(SESSION_SECRET, undefined, undefined, user\)/.test(src),
    'the user rides inside the signed token');
  assert.ok(/app\.get\('\/api\/me', requireSession/.test(src), '/api/me exists and is session-gated');
  assert.ok(/body\.user = sessionUserFromRequest\(req\)/.test(src),
    'POST /api/sheets ALWAYS overwrites body.user from the cookie — a client-supplied value never reaches Apps Script');
});

/* ================= public/app.js: client round-trip ================= */

function loadApp() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const noop = () => {};
  const doc = {
    addEventListener: noop,
    getElementById: () => null,
    createElement: () => ({ addEventListener: noop, appendChild: noop, querySelector: () => null, querySelectorAll: () => [] }),
    querySelectorAll: () => [],
  };
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/' },
    document: doc,
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    setTimeout: noop,
    URLSearchParams,
    Math, Date, JSON, Number, String, Array, Object, RegExp, Promise,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  const epilogue = `globalThis.__test = {
    normalizePatient,
    serializePatients,
    setState(s) { Object.assign(state, s); },
  };`;
  vm.createContext(sandbox);
  vm.runInContext(src + epilogue, sandbox);
  return sandbox.__test;
}

test('client round-trip: normalizePatient keeps patientId/updatedAt/updatedBy (defensively) and serializePatients echoes them', () => {
  const app = loadApp();
  const p = app.normalizePatient({ houseId: 'ramot', name: 'שרה', date: '2026-07-01',
    patientId: 'id-rt', updatedAt: '2026-09-01T08:00:00.000Z', updatedBy: 'ורד' });
  assert.deepStrictEqual(
    { patientId: p.patientId, updatedAt: p.updatedAt, updatedBy: p.updatedBy },
    { patientId: 'id-rt', updatedAt: '2026-09-01T08:00:00.000Z', updatedBy: 'ורד' });

  app.setState({ patients: [p] });
  const payload = app.serializePatients();
  assert.deepStrictEqual(
    { patientId: payload.ramot[0].patientId, updatedAt: payload.ramot[0].updatedAt, updatedBy: payload.ramot[0].updatedBy },
    { patientId: 'id-rt', updatedAt: '2026-09-01T08:00:00.000Z', updatedBy: 'ורד' },
    'the saveAll payload carries all three fields back to the server');
});

test('client round-trip: legacy rows without the fields normalize to blanks (no undefined leaks into the payload)', () => {
  const app = loadApp();
  const p = app.normalizePatient({ houseId: 'ramot', name: 'שרה', date: '2026-07-01' });
  assert.deepStrictEqual(
    { patientId: p.patientId, updatedAt: p.updatedAt, updatedBy: p.updatedBy },
    { patientId: '', updatedAt: '', updatedBy: '' });
  app.setState({ patients: [p] });
  const rec = app.serializePatients().ramot[0];
  assert.deepStrictEqual([rec.patientId, rec.updatedAt, rec.updatedBy], ['', '', '']);
});
