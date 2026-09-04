/* Who/when stamping on Patients writes (apps-script/Code.gs, lib/session.js,
 * server.js, public/app.js).
 *
 * Context under test: PR #112 gave Patients rows a persisted `id` (identity
 * foundation). This change adds WHO and WHEN to every Patients write —
 * `updatedAt` (ISO, server clock) + `updatedBy` (the user name the proxy
 * injects from the SIGNED session cookie) — so the follow-up PR can refuse
 * stale saves and the audit log can name people. Zero user-visible change;
 * the #112 identity/matching logic is untouched.
 *
 * Locked contracts:
 *   - updatedAt/updatedBy are LAST in all three column lists, after `id`
 *     (pinned in detail by the updated schema tests in
 *     patient-identity-foundation / nightly-integrity / restore-choice-modal;
 *     re-pinned compactly here);
 *   - patientRowDiffCols_ ignores the meta columns (id + stamps): rows
 *     differing only in them are byte-identical, and echoed stale stamps
 *     never read as an edit;
 *   - every write path stamps: replaceHousePatients_ id-match / key-match /
 *     rename-via-fromLead / append, discharge, restore, restore-to-active,
 *     and delete (the deleter is stamped onto the tombstone row);
 *   - a matched replace with NO content change is NOT re-stamped, and forged
 *     payload stamps can never land (the sheet's values win); preserved rows
 *     are never re-stamped;
 *   - every logAudit_ details object on those paths carries updatedBy;
 *   - session tokens: a legacy user-less cookie validates exactly as today; a
 *     user-bearing cookie is tamper-proof and read back via /api/me; the
 *     name is trimmed/escaped/capped at 40; the /api/sheets proxy ALWAYS
 *     overwrites body.user from the verified cookie;
 *   - client normalizePatient/serializePatients round-trip both fields.
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

const GS_SRC = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
function loadCode() {
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
    PATIENTS_SHEET: PATIENTS_SHEET,
    PATIENT_TOMBSTONE_COLUMNS: PATIENT_TOMBSTONE_COLUMNS,
    PATIENTS_TOMBSTONES_SHEET: PATIENTS_TOMBSTONES_SHEET,
    DISCHARGED_PATIENT_COLUMNS: DISCHARGED_PATIENT_COLUMNS,
    DISCHARGED_PATIENTS_SHEET: DISCHARGED_PATIENTS_SHEET,
    AUDIT_LOG_COLUMNS: AUDIT_LOG_COLUMNS,
    AUDIT_LOG_SHEET: AUDIT_LOG_SHEET,
    readSheet: (sh, cols) => readSheet_(sh, cols),
    handle: (params) => handle_(params).json,
    saveAll: (l, p, u) => saveAll_(l, p, u),
    diffCols: (a, b) => patientRowDiffCols_(a, b),
    discharge: (p, u) => dischargePatient_(p, u),
    restoreLead: (p, u) => restorePatient_(p, u),
    restoreActive: (p, u) => restorePatientToActive_(p, u),
    del: (p, u) => deletePatientRow_(p, u),
  };`;
  vm.createContext(sandbox);
  vm.runInContext(GS_SRC + epilogue, sandbox);
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

const T0 = '2026-09-01T08:00:00.000Z';
const SARA = { houseId: 'ramot', name: 'שרה כהן', date: '2026-07-01',
               pay: 9000, adv: 0, status: 'active', source: 'lead',
               id: 'id-sara', updatedAt: T0, updatedBy: 'ורד' };

/* ===== A. schema pin (detail pins live in the updated sibling suites) ===== */

test('all three column lists end with updatedAt, updatedBy — after `id` where the list carries one', () => {
  const { code } = loadCode();
  assert.deepStrictEqual(arr(code.PATIENT_COLUMNS).slice(-3), ['id', 'updatedAt', 'updatedBy']);
  assert.deepStrictEqual(arr(code.PATIENT_TOMBSTONE_COLUMNS).slice(-3), ['id', 'updatedAt', 'updatedBy']);
  assert.deepStrictEqual(arr(code.DISCHARGED_PATIENT_COLUMNS).slice(-2), ['updatedAt', 'updatedBy']);
});

test('patientRowDiffCols_ ignores id + stamps: rows differing only in meta are byte-identical; a real change still shows', () => {
  const { code } = loadCode();
  const PC = arr(code.PATIENT_COLUMNS);
  const a = rowOf(PC, SARA);
  const b = rowOf(PC, Object.assign({}, SARA, { id: 'id-other', updatedAt: '2027-01-01T00:00:00.000Z', updatedBy: 'דנה' }));
  assert.deepStrictEqual(plain(code.diffCols(a, b)), [], 'meta-only differences are not an edit');
  const c = rowOf(PC, Object.assign({}, SARA, { pay: 9500, updatedBy: 'דנה' }));
  assert.deepStrictEqual(plain(code.diffCols(a, c)), ['pay'], 'content change reported without the meta noise');
});

/* ===== B. replaceHousePatients_ stamping ===== */

test('APPEND via handle_ stamps updatedAt/updatedBy from the proxy-injected user; audit carries updatedBy', () => {
  const { code, sandbox } = loadCode();
  seedSheet(code, sandbox, code.PATIENTS_SHEET, arr(code.PATIENT_COLUMNS), []);
  const res = code.handle({ action: 'saveAll', user: 'ורד',
    patients: { ramot: [{ houseId: 'ramot', name: 'נועה', date: '2026-09-01', pay: 8000, status: 'active' }] } });
  assert.strictEqual(res.ok, true);
  const after = patientsOf(code, sandbox);
  assert.ok(isIso(after[0].updatedAt), 'updatedAt is a server-clock ISO stamp');
  assert.strictEqual(after[0].updatedBy, 'ורד');
  const added = auditOf(code, sandbox).find((a) => a.action === 'patient_added');
  assert.strictEqual(JSON.parse(added.details).updatedBy, 'ורד');
});

test('ID MATCH with a content change re-stamps from the user; forged payload stamps never land', () => {
  const { code, sandbox } = loadCode();
  seedSheet(code, sandbox, code.PATIENTS_SHEET, arr(code.PATIENT_COLUMNS), [SARA]);
  code.saveAll(null, { ramot: [
    Object.assign({}, SARA, { pay: 9500, updatedAt: '1999-01-01T00:00:00.000Z', updatedBy: 'האקר' }),
  ] }, 'דנה');
  const after = patientsOf(code, sandbox)[0];
  assert.strictEqual(after.pay, 9500);
  assert.strictEqual(after.updatedBy, 'דנה', 'stamped from the cookie user, never the payload');
  assert.ok(isIso(after.updatedAt) && after.updatedAt !== T0 && after.updatedAt !== '1999-01-01T00:00:00.000Z');
  const edited = auditOf(code, sandbox).find((a) => a.action === 'patient_edited');
  const d = JSON.parse(edited.details);
  assert.strictEqual(d.updatedBy, 'דנה');
  assert.deepStrictEqual(plain(d.changed), ['pay'], 'meta columns never in `changed`');
});

test('ID MATCH with NO content change is not re-stamped — even when the payload echoes stale/forged stamps', () => {
  const { code, sandbox } = loadCode();
  seedSheet(code, sandbox, code.PATIENTS_SHEET, arr(code.PATIENT_COLUMNS), [SARA]);
  code.saveAll(null, { ramot: [
    Object.assign({}, SARA, { updatedAt: '1999-01-01T00:00:00.000Z', updatedBy: 'האקר' }),
  ] }, 'דנה');
  const after = patientsOf(code, sandbox)[0];
  assert.deepStrictEqual(
    { updatedAt: after.updatedAt, updatedBy: after.updatedBy },
    { updatedAt: T0, updatedBy: 'ורד' },
    'unchanged echo: the sheet stamps survive byte-for-byte');
  assert.ok(!auditOf(code, sandbox).some((a) => a.action === 'patient_edited'), 'no phantom edit event');
});

test('ID MATCH rename (rekey) stamps and the patient_rekeyed_via_id audit carries updatedBy', () => {
  const { code, sandbox } = loadCode();
  seedSheet(code, sandbox, code.PATIENTS_SHEET, arr(code.PATIENT_COLUMNS), [SARA]);
  code.saveAll(null, { ramot: [Object.assign({}, SARA, { name: 'שרה לוי-כהן' })] }, 'דנה');
  const after = patientsOf(code, sandbox);
  assert.strictEqual(after.length, 1, 'in-place rekey, no duplicate');
  assert.deepStrictEqual({ name: after[0].name, id: after[0].id, updatedBy: after[0].updatedBy },
    { name: 'שרה לוי-כהן', id: 'id-sara', updatedBy: 'דנה' });
  assert.ok(isIso(after[0].updatedAt) && after[0].updatedAt !== T0);
  const rekeyed = auditOf(code, sandbox).find((a) => a.action === 'patient_rekeyed_via_id');
  assert.strictEqual(JSON.parse(rekeyed.details).updatedBy, 'דנה');
});

test('KEY MATCH (id-less legacy row): change → stamped + audited; unchanged echo → untouched', () => {
  const { code, sandbox } = loadCode();
  const legacy = { houseId: 'ramot', name: 'רות', date: '2026-05-01', pay: 7000, status: 'active', updatedAt: T0, updatedBy: 'ורד' };
  seedSheet(code, sandbox, code.PATIENTS_SHEET, arr(code.PATIENT_COLUMNS), [legacy]);
  code.saveAll(null, { ramot: [Object.assign({}, legacy, { updatedBy: 'האקר' })] }, 'דנה');
  let after = patientsOf(code, sandbox)[0];
  assert.deepStrictEqual({ updatedAt: after.updatedAt, updatedBy: after.updatedBy },
    { updatedAt: T0, updatedBy: 'ורד' }, 'unchanged key-match untouched');

  code.saveAll(null, { ramot: [Object.assign({}, legacy, { pay: 7500 })] }, 'דנה');
  after = patientsOf(code, sandbox)[0];
  assert.strictEqual(after.pay, 7500);
  assert.strictEqual(after.updatedBy, 'דנה');
  assert.ok(isIso(after.updatedAt) && after.updatedAt !== T0);
  const edited = auditOf(code, sandbox).find((a) => a.action === 'patient_edited');
  assert.strictEqual(JSON.parse(edited.details).updatedBy, 'דנה');
});

test('rename-via-fromLead stamps the rewritten row; audit carries updatedBy', () => {
  const { code, sandbox } = loadCode();
  seedSheet(code, sandbox, code.PATIENTS_SHEET, arr(code.PATIENT_COLUMNS), [
    { houseId: 'ramot', name: 'הדס', date: '2026-06-01', pay: 9000, status: 'active', fromLead: 'L1', updatedAt: T0, updatedBy: 'ורד' },
  ]);
  // No id in the payload (stale tab) → the fromLead rename branch fires.
  code.saveAll(null, { ramot: [
    { houseId: 'ramot', name: 'הדס חלמיש', date: '2026-06-01', pay: 9000, status: 'active', fromLead: 'L1' },
  ] }, 'דנה');
  const after = patientsOf(code, sandbox);
  assert.strictEqual(after.length, 1);
  assert.deepStrictEqual({ name: after[0].name, updatedBy: after[0].updatedBy }, { name: 'הדס חלמיש', updatedBy: 'דנה' });
  assert.ok(isIso(after[0].updatedAt) && after[0].updatedAt !== T0);
  const renamed = auditOf(code, sandbox).find((a) => a.action === 'patient_renamed_via_fromLead');
  assert.strictEqual(JSON.parse(renamed.details).updatedBy, 'דנה');
});

test('preserved (payload-omitted) rows are never re-stamped — even when the merge mints them an id', () => {
  const { code, sandbox } = loadCode();
  const other = { houseId: 'ramot', name: 'תמר', date: '2026-04-01', pay: 6000, status: 'active', updatedAt: T0, updatedBy: 'ורד' }; // no id
  seedSheet(code, sandbox, code.PATIENTS_SHEET, arr(code.PATIENT_COLUMNS), [SARA, other]);
  // Payload carries only שרה — תמר is preserved (merge-don't-drop) and gets an
  // id minted, but her who/when stamps must ride through untouched.
  code.saveAll(null, { ramot: [Object.assign({}, SARA)] }, 'דנה');
  const tamar = patientsOf(code, sandbox).find((p) => p.name === 'תמר');
  assert.ok(/^id-/.test(tamar.id), 'preserved row converged to an id (the #112 contract)');
  assert.deepStrictEqual({ updatedAt: tamar.updatedAt, updatedBy: tamar.updatedBy },
    { updatedAt: T0, updatedBy: 'ורד' }, 'stamps untouched');
});

/* ===== C. delete / discharge / restore stamping ===== */

test('delete stamps the DELETER onto the tombstone row (overriding the row\'s last-edit stamps); audit carries updatedBy', () => {
  const { code, sandbox } = loadCode();
  seedSheet(code, sandbox, code.PATIENTS_SHEET, arr(code.PATIENT_COLUMNS), [SARA]);
  const res = code.del({ houseId: SARA.houseId, name: SARA.name, date: SARA.date, id: 'id-sara' }, 'דנה');
  assert.strictEqual(res.ok, true);
  const tombs = code.readSheet(sandbox.__sheets[code.PATIENTS_TOMBSTONES_SHEET], arr(code.PATIENT_TOMBSTONE_COLUMNS));
  assert.strictEqual(tombs.length, 1);
  assert.strictEqual(tombs[0].reason, 'user-delete');
  assert.strictEqual(tombs[0].updatedBy, 'דנה', 'the tombstone answers WHO deleted');
  assert.ok(isIso(tombs[0].updatedAt) && tombs[0].updatedAt !== T0, '…and WHEN');
  assert.strictEqual(tombs[0].updatedAt, tombs[0].droppedAt, 'delete stamp = droppedAt moment');
  const a = auditOf(code, sandbox).find((x) => x.action === 'patient_deleted');
  assert.strictEqual(JSON.parse(a.details).updatedBy, 'דנה');
});

test('preserve-path tombstones (saveAll-omitted) keep the row\'s OWN stamps — only user deletes override', () => {
  const { code, sandbox } = loadCode();
  seedSheet(code, sandbox, code.PATIENTS_SHEET, arr(code.PATIENT_COLUMNS), [SARA]);
  code.saveAll(null, { ramot: [] }, 'דנה'); // omits שרה → preserved + tombstone-audited
  const tombs = code.readSheet(sandbox.__sheets[code.PATIENTS_TOMBSTONES_SHEET], arr(code.PATIENT_TOMBSTONE_COLUMNS));
  assert.strictEqual(tombs[0].reason, 'saveAll-omitted-preserved');
  assert.deepStrictEqual({ updatedAt: tombs[0].updatedAt, updatedBy: tombs[0].updatedBy },
    { updatedAt: T0, updatedBy: 'ורד' }, 'snapshot carries the row\'s own last-edit stamps');
});

test('dischargePatient_ stamps server-side (forged client stamps ignored) and audits updatedBy', () => {
  const { code, sandbox } = loadCode();
  code.discharge(Object.assign({ id: 'aud-1' }, SARA, { status: 'released', updatedAt: '1999-01-01T00:00:00.000Z', updatedBy: 'האקר' }), 'ורד');
  const rows = code.readSheet(sandbox.__sheets[code.DISCHARGED_PATIENTS_SHEET], arr(code.DISCHARGED_PATIENT_COLUMNS));
  assert.strictEqual(rows[0].updatedBy, 'ורד');
  assert.ok(isIso(rows[0].updatedAt) && rows[0].updatedAt !== '1999-01-01T00:00:00.000Z');
  const a = auditOf(code, sandbox).find((x) => x.action === 'patient_discharged');
  assert.strictEqual(JSON.parse(a.details).updatedBy, 'ורד');
});

test('restorePatient_ (to lead) and restorePatientToActive_ stamp the flagged audit row and audit updatedBy', () => {
  const { code, sandbox } = loadCode();
  seedSheet(code, sandbox, code.DISCHARGED_PATIENTS_SHEET, arr(code.DISCHARGED_PATIENT_COLUMNS), [
    Object.assign({ id: 'aud-1' }, SARA, { status: 'released' }),
    Object.assign({ id: 'aud-2' }, SARA, { name: 'תמר גל', status: 'released' }),
  ]);
  code.restoreLead({ id: 'aud-1', name: SARA.name, house: 'רמות' }, 'דנה');
  code.restoreActive({ id: 'aud-2', name: 'תמר גל' }, 'ורד');
  const rows = code.readSheet(sandbox.__sheets[code.DISCHARGED_PATIENTS_SHEET], arr(code.DISCHARGED_PATIENT_COLUMNS));
  const r1 = rows.find((r) => r.id === 'aud-1');
  const r2 = rows.find((r) => r.id === 'aud-2');
  assert.deepStrictEqual({ restored: r1.restored, updatedBy: r1.updatedBy }, { restored: 'TRUE', updatedBy: 'דנה' });
  assert.deepStrictEqual({ restored: r2.restored, updatedBy: r2.updatedBy }, { restored: 'TRUE', updatedBy: 'ורד' });
  assert.ok(isIso(r1.updatedAt) && isIso(r2.updatedAt));
  const byAction = {};
  auditOf(code, sandbox).forEach((x) => { byAction[x.action] = JSON.parse(x.details); });
  assert.strictEqual(byAction.patient_restored_to_lead.updatedBy, 'דנה');
  assert.strictEqual(byAction.patient_restored_active.updatedBy, 'ורד');
});

/* ================= lib/session.js + server.js ================= */

const SECRET = 'test-session-secret-0123456789abcdef0123456789';
process.env.SESSION_SECRET = SECRET; // must be set before server.js is required
const { createSessionToken, verifySessionToken, readSessionUser } = require('../lib/session');
const server = require('../server');

test('legacy user-less token still validates (2-part format byte-for-byte) and reads back an empty user', () => {
  const token = createSessionToken(SECRET);
  assert.strictEqual(token.split('.').length, 2);
  assert.strictEqual(verifySessionToken(token, SECRET), true);
  assert.strictEqual(readSessionUser(token, SECRET), '');
});

test('user-bearing token validates and returns the Hebrew name; a tampered name segment is rejected', () => {
  const token = createSessionToken(SECRET, undefined, undefined, 'ורד לוי');
  assert.strictEqual(token.split('.').length, 3, 'expiry.userB64.sig — inside the signed payload, never a separate cookie');
  assert.strictEqual(verifySessionToken(token, SECRET), true);
  assert.strictEqual(readSessionUser(token, SECRET), 'ורד לוי');

  const [expiry, , sig] = token.split('.');
  const forged = expiry + '.' + Buffer.from('האקר', 'utf8').toString('base64url') + '.' + sig;
  assert.strictEqual(verifySessionToken(forged, SECRET), false, 'the signature covers the name');
  assert.strictEqual(readSessionUser(forged, SECRET), '');
});

test('user-bearing tokens respect scope separation and expiry', () => {
  const scoped = createSessionToken(SECRET, undefined, 'meeting-report', 'ורד');
  assert.strictEqual(verifySessionToken(scoped, SECRET, 'meeting-report'), true);
  assert.strictEqual(verifySessionToken(scoped, SECRET), false);
  assert.strictEqual(verifySessionToken(createSessionToken(SECRET, -10, undefined, 'ורד'), SECRET), false);
});

test('sanitizeSessionUser trims, caps at 40, strips angle brackets + control chars; Hebrew quotes survive', () => {
  assert.strictEqual(server.sanitizeSessionUser('  ורד לוי  '), 'ורד לוי');
  assert.strictEqual(server.sanitizeSessionUser('א'.repeat(60)).length, 40);
  assert.strictEqual(server.sanitizeSessionUser('<script>ורד</script>'), 'scriptורד/script');
  assert.strictEqual(server.sanitizeSessionUser('ורד\u0000\u001f'), 'ורד');
  assert.strictEqual(server.sanitizeSessionUser('ד"ר ורד'), 'ד"ר ורד');
  assert.strictEqual(server.sanitizeSessionUser(undefined), '');
  assert.strictEqual(server.sanitizeSessionUser(12345), '');
});

test('sessionUserFromRequest reads only a VERIFIED cookie; legacy cookie → blank; old cookies still pass requireSession', () => {
  const mk = (token) => ({ headers: { cookie: 'ezone_session=' + token }, originalUrl: '/api/sheets' });
  assert.strictEqual(server.sessionUserFromRequest(mk(createSessionToken(SECRET, undefined, undefined, 'ורד'))), 'ורד');
  assert.strictEqual(server.sessionUserFromRequest(mk(createSessionToken(SECRET))), '');
  assert.strictEqual(server.sessionUserFromRequest(mk('123.deadbeef')), '');

  let called = false;
  server.requireSession(mk(createSessionToken(SECRET)), { status: () => ({ json: () => {} }) }, () => { called = true; });
  assert.strictEqual(called, true, 'a user-less cookie authorizes exactly as today');
});

test('source-scan: verify-pin stores the sanitized user in the signed cookie; /api/me is session-gated; the proxy ALWAYS overwrites body.user', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(/sanitizeSessionUser\(req\.body && req\.body\.user\)/.test(src));
  assert.ok(/createSessionToken\(SESSION_SECRET, undefined, undefined, user\)/.test(src));
  assert.ok(/app\.get\('\/api\/me', requireSession/.test(src));
  assert.ok(/body\.user = sessionUserFromRequest\(req\)/.test(src),
    'a client-supplied user can never reach Apps Script');
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

test('client round-trip: normalizePatient keeps updatedAt/updatedBy defensively and serializePatients echoes them', () => {
  const app = loadApp();
  const p = app.normalizePatient({ houseId: 'ramot', name: 'שרה', date: '2026-07-01', id: 'id-x',
    updatedAt: T0, updatedBy: 'ורד' });
  assert.deepStrictEqual({ updatedAt: p.updatedAt, updatedBy: p.updatedBy }, { updatedAt: T0, updatedBy: 'ורד' });

  app.setState({ patients: [p] });
  const rec = app.serializePatients().ramot[0];
  assert.deepStrictEqual({ updatedAt: rec.updatedAt, updatedBy: rec.updatedBy }, { updatedAt: T0, updatedBy: 'ורד' },
    'the saveAll payload carries both stamps back (the server overwrite wins on any real edit)');
});

test('client round-trip: legacy rows without the fields normalize to blanks — nothing undefined in the payload', () => {
  const app = loadApp();
  const p = app.normalizePatient({ houseId: 'ramot', name: 'שרה', date: '2026-07-01' });
  assert.deepStrictEqual([p.updatedAt, p.updatedBy], ['', '']);
  app.setState({ patients: [p] });
  const rec = app.serializePatients().ramot[0];
  assert.deepStrictEqual([rec.updatedAt, rec.updatedBy], ['', '']);
});
