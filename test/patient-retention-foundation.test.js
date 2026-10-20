/* «המשך טיפול» foundation (CHANGELOG-patient-retention-foundation.md), on the
 * REAL shipped Code.gs and app.js (vm sandboxes):
 *   1. the appended `continuity` column (append-only) + key parity
 *      (lib ↔ Code.gs ↔ app.js);
 *   2. dischargePatient_: default 'unknown', a real key kept, an unknown key
 *      refused with NOTHING written;
 *   3. setDischargeContinuity: validation, not found / deleted refused, ONE
 *      row's cells written (never a rewrite), audit row, idempotent;
 *   4. restore paths never blank or downgrade a recorded key; the
 *      coordinators path writes 'unknown';
 *   5. app.js normalizeDischargedPatient carries the key defensively;
 *   6. SW CACHE_VERSION bump.
 * All names and ids are synthetic. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadGs, richSheet } = require('./helpers/gs-sandbox');
const { loadPage } = require('./helpers/app-sandbox');
const R = require('../lib/patient-retention');

const ROOT = path.join(__dirname, '..');
const GS_SRC = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');
const SW_SRC = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');
const PROXY_SECRET = 'proxy-secret-TEST-patient-retention-0123456789';
const DSHEET = 'מטופלים משוחררים';
const arr = (x) => Array.from(x);
const VERED = () => ({ proxySecret: PROXY_SECRET, proxyUser: 'ורד', user: 'ורד', proxyAuth: 'personal', proxyUserId: 'vered', proxyRoles: ['staff', 'reporter', 'deleter'] });

function audit(over) {
  return Object.assign({
    id: 'aud-1', houseId: 'ramot', name: 'מטופל בדיקה', date: '2026-09-01', pay: 1000, adv: 0, status: 'released',
    fromLead: '', exitDate: '2026-10-01', source: 'direct_admin', notes: '',
    dischargedAt: '2026-10-01T09:00:00.000Z', disposition: 'completed', discharge_note: '', restored: '', prior_status: 'active',
  }, over || {});
}

function seeded(discharged) {
  const g = loadGs({ props: { PROXY_SECRET } });
  const S = g.sandbox.__sheets;
  const put = (name, colsExpr, rows) => {
    const cols = arr(g.run(colsExpr));
    S[name] = richSheet(name, cols);
    (rows || []).forEach((r) => S[name].appendRow(cols.map((c) => (r[c] === undefined ? '' : r[c]))));
  };
  put('Patients', 'PATIENT_COLUMNS', []);
  put(DSHEET, 'DISCHARGED_PATIENT_COLUMNS', discharged || []);
  put('Credits', 'CREDIT_COLUMNS', []);
  put('Payments', 'PAYMENT_COLUMNS', []);
  return {
    g, S,
    rows: () => g.sheetRows(DSHEET, 'DISCHARGED_PATIENT_COLUMNS'),
    audits: () => g.sheetRows('AuditLog', 'AUDIT_LOG_COLUMNS'),
    post: (body) => g.post(Object.assign(body, VERED())),
  };
}

/* ---------- 1. schema + parity ---------- */

test('`continuity` is appended LAST to DISCHARGED_PATIENT_COLUMNS (append-only)', () => {
  const g = loadGs({});
  const cols = arr(g.run('DISCHARGED_PATIENT_COLUMNS'));
  assert.equal(cols[cols.length - 1], 'continuity');
  assert.deepEqual(cols.slice(-4), ['deletedAt', 'deletedBy', 'deleteReason', 'continuity']);
  assert.equal(cols.filter((c) => c === 'continuity').length, 1);
});

test('a live sheet without the column gets it appended; existing cells untouched', () => {
  const g = loadGs({});
  const cols = arr(g.run('DISCHARGED_PATIENT_COLUMNS'));
  const old = cols.slice(0, -1);
  const sh = richSheet(DSHEET, old);
  const legacy = old.map((c, i) => (c === 'id' ? 'd-old' : 'v' + i));
  sh.grid.push(legacy.slice());
  g.sandbox.__sheets[DSHEET] = sh;
  g.run('getOrCreateSheet_(DISCHARGED_PATIENTS_SHEET, DISCHARGED_PATIENT_COLUMNS)');
  assert.deepEqual(sh.grid[0], cols);
  assert.deepEqual(sh.grid[1].slice(0, old.length), legacy);
});

test('continuity keys: lib/patient-retention.js = Code.gs = app.js', () => {
  const g = loadGs({});
  assert.deepEqual(arr(g.run('CONTINUITY_KEYS')), [...R.CONTINUITY_KEYS]);
  assert.deepEqual(arr(g.run('CONTINUITY_CHOICES')), [...R.CONTINUITY_CHOICES]);
  assert.equal(g.run('CONTINUITY_DEFAULT'), R.CONTINUITY_DEFAULT);
  const pg = loadPage({});
  assert.deepEqual(arr(pg.run('DISCHARGE_CONTINUITY_KEYS')), [...R.CONTINUITY_KEYS]);
});

test('setDischargeContinuity is a known proxy action and not a Patients write', () => {
  const g = loadGs({});
  assert.ok(arr(g.run('PROXY_KNOWN_ACTIONS')).includes('setDischargeContinuity'));
  assert.ok(!arr(g.run('PATIENTS_WRITE_ACTIONS')).includes('setDischargeContinuity'));
  assert.ok(!arr(g.run('DELETE_ACTIONS')).includes('setDischargeContinuity'));
});

/* ---------- 2. dischargePatient_ ---------- */

test('dischargePatient: no continuity → stored "unknown"', () => {
  const s = seeded();
  const res = s.post({ action: 'dischargePatient', patient: audit() });
  assert.equal(res.ok, true);
  assert.equal(s.rows()[0].continuity, 'unknown');
  assert.equal(res.patient.continuity, 'unknown');
});

test('dischargePatient: a real key is stored', () => {
  for (const k of ['continued_outpatient', 'continued_other', 'none']) {
    const s = seeded();
    assert.equal(s.post({ action: 'dischargePatient', patient: audit({ continuity: k }) }).ok, true);
    assert.equal(s.rows()[0].continuity, k);
  }
});

test('dischargePatient: an unknown key is refused and NOTHING is written', () => {
  for (const bad of ['maybe', '=HYPERLINK("x")', 'NONE', 'לא המשיך', 5, { k: 1 }]) {
    const s = seeded();
    const res = s.post({ action: 'dischargePatient', patient: audit({ continuity: bad }) });
    assert.equal(res.ok, false, String(bad));
    assert.equal(res.error, 'bad_continuity');
    assert.equal(typeof res.message, 'string');
    assert.equal(s.rows().length, 0, 'no discharged row');
    assert.equal(s.audits().length, 0, 'no audit row');
  }
});

/* ---------- 3. setDischargeContinuity ---------- */

test('setDischargeContinuity: sets the key on that ONE row, stamps it, logs the previous value', () => {
  const s = seeded([audit({ id: 'aud-1' }), audit({ id: 'aud-2', name: 'אחר', continuity: 'none' })]);
  const before2 = JSON.stringify(s.S[DSHEET].grid[2]);
  const res = s.post({ action: 'setDischargeContinuity', id: 'aud-1', continuity: 'continued_other' });
  assert.equal(res.ok, true);
  assert.equal(res.continuity, 'continued_other');
  assert.equal(res.prev, 'unknown');
  const [r1] = s.rows();
  assert.equal(r1.continuity, 'continued_other');
  assert.ok(String(r1.updatedAt).length > 10);
  assert.equal(r1.updatedBy, res.updatedBy);
  assert.equal(r1.name, 'מטופל בדיקה', 'other cells of the row untouched');
  assert.equal(r1.exitDate, '2026-10-01');
  assert.equal(JSON.stringify(s.S[DSHEET].grid[2]), before2, 'the other row is byte-identical');
  const log = s.audits().filter((a) => a.action === 'discharge_continuity_set');
  assert.equal(log.length, 1);
  const details = JSON.parse(log[0].details);
  assert.equal(details.prev, 'unknown');
  assert.equal(details.continuity, 'continued_other');
});

test('setDischargeContinuity writes single cells, never the whole sheet', () => {
  const s = seeded([audit({ id: 'aud-1' }), audit({ id: 'aud-2', name: 'אחר' })]);
  const sh = s.S[DSHEET];
  const writes = [];
  const orig = sh.getRange.bind(sh);
  sh.getRange = (r, c, nr, nc) => {
    const rg = orig(r, c, nr, nc);
    const sv = rg.setValues.bind(rg), v = rg.setValue.bind(rg);
    rg.setValues = (vals) => { writes.push({ r, c, nr: nr || 1, nc: nc || 1 }); return sv(vals); };
    rg.setValue = (x) => { writes.push({ r, c, nr: 1, nc: 1 }); return v(x); };
    return rg;
  };
  assert.equal(s.post({ action: 'setDischargeContinuity', id: 'aud-2', continuity: 'none' }).ok, true);
  assert.ok(writes.length > 0);
  for (const w of writes) {
    assert.equal(w.r, 3, 'only the target row (sheet row 3) is written');
    assert.equal(w.nr, 1);
    assert.ok(w.nc <= 2);
  }
});

test('setDischargeContinuity validation: id, key ("unknown" is not a choice)', () => {
  const s = seeded([audit({ id: 'aud-1' })]);
  const before = JSON.stringify(s.S[DSHEET].grid);
  const cases = [
    [{ continuity: 'none' }, 'missing_id'],
    [{ id: '', continuity: 'none' }, 'missing_id'],
    [{ id: 'x'.repeat(201), continuity: 'none' }, 'missing_id'],
    [{ id: { $ne: 1 }, continuity: 'none' }, 'missing_id'],
    [{ id: 'aud-1' }, 'bad_continuity'],
    [{ id: 'aud-1', continuity: 'unknown' }, 'bad_continuity'],
    [{ id: 'aud-1', continuity: '=1+1' }, 'bad_continuity'],
    [{ id: 'aud-1', continuity: ['none'] }, 'bad_continuity'],
    [{ id: 'nope', continuity: 'none' }, 'not_found'],
  ];
  for (const [body, err] of cases) {
    const res = s.post(Object.assign({ action: 'setDischargeContinuity' }, body));
    assert.equal(res.ok, false, JSON.stringify(body));
    assert.equal(res.error, err, JSON.stringify(body));
  }
  assert.equal(JSON.stringify(s.S[DSHEET].grid), before, 'nothing written');
});

test('setDischargeContinuity refuses a soft-deleted row', () => {
  const s = seeded([audit({ id: 'aud-1', deletedAt: '2026-10-02T00:00:00Z', deletedBy: 'ורד', deleteReason: 'כפילות' })]);
  const res = s.post({ action: 'setDischargeContinuity', id: 'aud-1', continuity: 'none' });
  assert.equal(res.error, 'row_deleted');
  assert.equal(s.rows()[0].continuity, '');
});

test('setDischargeContinuity: the same value again writes nothing (idempotent retry)', () => {
  const s = seeded([audit({ id: 'aud-1', continuity: 'none' })]);
  const before = JSON.stringify(s.S[DSHEET].grid);
  const res = s.post({ action: 'setDischargeContinuity', id: 'aud-1', continuity: 'none' });
  assert.equal(res.ok, true);
  assert.equal(res.unchanged, true);
  assert.equal(JSON.stringify(s.S[DSHEET].grid), before);
});

test('setDischargeContinuity runs under the script lock; a busy lock writes nothing', () => {
  const s = seeded([audit({ id: 'aud-1' })]);
  s.g.sandbox.LockService = { getScriptLock: () => ({ tryLock: () => false, releaseLock() {} }) };
  const before = JSON.stringify(s.S[DSHEET].grid);
  const res = s.post({ action: 'setDischargeContinuity', id: 'aud-1', continuity: 'none' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'lock_busy');
  assert.equal(JSON.stringify(s.S[DSHEET].grid), before);
  assert.match(GS_SRC, /function setDischargeContinuity_[\s\S]*?LockService\.getScriptLock\(\)[\s\S]*?releaseLock/);
});

/* ---------- 4. restore paths + coordinators ---------- */

test('restorePatientToActive with an older client copy (no continuity) keeps the recorded key', () => {
  const s = seeded([audit({ id: 'aud-1', continuity: 'continued_outpatient' })]);
  const copy = audit({ id: 'aud-1' });   // no continuity field — an old cached bundle
  assert.equal(s.post({ action: 'restorePatientToActive', patient: copy }).ok, true);
  assert.equal(s.rows()[0].continuity, 'continued_outpatient');
  assert.equal(s.rows()[0].restored, 'TRUE');
});

test('restorePatientToActive with "unknown" or junk never downgrades a key; a real key from the client is kept', () => {
  for (const sent of ['unknown', '', 'junk']) {
    const s = seeded([audit({ id: 'aud-1', continuity: 'none' })]);
    s.post({ action: 'restorePatientToActive', patient: audit({ id: 'aud-1', continuity: sent }) });
    assert.equal(s.rows()[0].continuity, 'none', sent);
  }
  const s = seeded([audit({ id: 'aud-1', continuity: '' })]);
  s.post({ action: 'restorePatientToActive', patient: audit({ id: 'aud-1', continuity: 'continued_other' }) });
  assert.equal(s.rows()[0].continuity, 'continued_other');
});

test('the coordinators discharge writes continuity "unknown"', () => {
  assert.match(GS_SRC, /audit\.continuity\s*=\s*CONTINUITY_DEFAULT;/);
});

/* ---------- 5. app.js ---------- */

test('normalizeDischargedPatient carries continuity; legacy / unknown values read "unknown"', () => {
  const pg = loadPage({});
  const n = (v) => pg.run(`normalizeDischargedPatient(${JSON.stringify(v)}).continuity`);
  assert.equal(n({ id: 'a', continuity: 'none' }), 'none');
  assert.equal(n({ id: 'a', continuity: ' continued_other ' }), 'continued_other');
  assert.equal(n({ id: 'a', 'המשך טיפול': 'continued_outpatient' }), 'continued_outpatient');
  assert.equal(n({ id: 'a' }), 'unknown');
  assert.equal(n({ id: 'a', continuity: '=evil()' }), 'unknown');
  assert.equal(n({ id: 'a', continuity: 'unknown' }), 'unknown');
});

test('dischargeAuditRow sends a real choice, and never junk (PR 2 wires the modal)', () => {
  const pg = loadPage({});
  const c = (v) => pg.run(`dischargeAuditRow({ id: 'p', status: 'active' }, { disposition: 'completed', note: '', dischargeDate: '', continuity: ${JSON.stringify(v)} }, '2026-10-20').continuity`);
  assert.equal(c('none'), 'none');
  assert.equal(c('continued_outpatient'), 'continued_outpatient');
  for (const bad of [undefined, '', 'unknown', '=x', 'NONE']) assert.equal(c(bad), 'unknown', String(bad));
});

/* ---------- 6. service worker ---------- */

test('SW CACHE_VERSION is v77 or later for this public/ change (v17 never reused)', () => {
  const v = Number(/var CACHE_VERSION = 'v(\d+)';/.exec(SW_SRC)[1]);
  assert.ok(v >= 77, 'v' + v);
  assert.notEqual(v, 17);
});
