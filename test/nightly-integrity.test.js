'use strict';

/**
 * Coverage for the nightly data-integrity job (apps-script/Code.gs):
 * nightlyIntegrityJob + setupIntegrityTrigger — the Dashboard-side mirror of
 * the outpatient app's job, adapted to this app's data model (no id column;
 * identity is the triple key houseId::name::entryDate via patientKey_,
 * recorded removals live in PatientsTombstones).
 *
 * Two styles, matching the passing tests in this suite:
 *
 * 1. REAL-CODE extraction (the patients-merge-dont-drop pattern, distilled):
 *    the pure helpers (integrityNormalizeKey_, integrityDiffMissingKeys_,
 *    integrityParsePaymentPatientId_, integrityParseOverridePatientId_,
 *    integrityOrphanKeys_, integritySnapshotName_,
 *    integrityIsExpiredSnapshot_, integritySplitChunks_,
 *    integrityStoreKeys_, integrityLoadKeys_, integrityKeyDisplay_,
 *    integrityAlertBody_) use no GAS services, so their source is extracted
 *    from Code.gs (balanced braces) and eval'd — the tests run the ACTUAL
 *    deployed logic, no drift-prone mirrors.
 *
 * 2. SOURCE-SCAN guards locking the job's contract:
 *    - READ-ONLY vs the live Patients/Leads/Payments/BillingOverrides
 *      sheets: no write primitive, no getOrCreateSheet_ (not even a header
 *      backfill), no upsert/delete helper inside the job body; clearBody_
 *      stays gone from the whole file (removed in the merge-don't-drop PR).
 *    - Check ORDERING: the sentinel (check 1) runs BEFORE the snapshot
 *      overwrite (check 3) — yesterday's backup must still hold any row the
 *      sentinel flags; state persists only AFTER the alert.
 *    - Backup spreadsheet: lookup (stored id, then DriveApp BY NAME) before
 *      any SpreadsheetApp.create — EZONE-Backups is shared with the
 *      outpatient job and must never be forked.
 *    - Trigger installer idempotency (delete-then-create, daily, 02:xx).
 *    - Fail-open alerting (missing ALERT_EMAIL → Logger.log, never throw).
 *    - PATIENT_COLUMNS untouched; no new doGet/doPost routing; project
 *      timezone pinned to Asia/Jerusalem (atHour + snapshot date rolls
 *      depend on it).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const GS = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');

// --- extract a whole `function name(...) {...}` out of Code.gs (balanced) ----
function gsFunction(name) {
  const sig = 'function ' + name + '(';
  const start = GS.indexOf(sig);
  assert.notEqual(start, -1, name + ' not found in Code.gs');
  const open = GS.indexOf('{', start);
  let depth = 0, end = -1;
  for (let j = open; j < GS.length; j++) {
    if (GS[j] === '{') depth++;
    else if (GS[j] === '}') { depth--; if (depth === 0) { end = j; break; } }
  }
  assert.notEqual(end, -1, name + ' has unbalanced braces');
  return GS.slice(start, end + 1);
}

// --- extract a single-line `const NAME = <literal>;` declaration -------------
function gsConstDecl(name) {
  const m = GS.match(new RegExp('const ' + name + '\\s*=\\s*[^\\n]*;'));
  assert.ok(m, name + ' not found in Code.gs');
  return m[0];
}

/* Eval the real helpers in one scope. integrityNormalizeKey_ goes through
 * patientKey_ → asISODate_ (whose Date branch touches GAS services but is
 * never hit for the string inputs these tests use). */
const HELPERS = [
  gsConstDecl('INTEGRITY_PROP_KEY_CHUNK_COUNT'),
  gsConstDecl('INTEGRITY_PROP_KEY_CHUNK_PREFIX'),
  gsConstDecl('INTEGRITY_KEY_CHUNK_CHARS'),
  gsConstDecl('INTEGRITY_PROP_BACKUP_SSID'),
  gsConstDecl('INTEGRITY_PROP_ALERT_EMAIL'),
  gsConstDecl('INTEGRITY_BACKUP_NAME'),
  gsConstDecl('INTEGRITY_RETENTION_DAYS'),
  gsConstDecl('INTEGRITY_ALERT_SUBJECT'),
  gsConstDecl('INTEGRITY_PATIENTS_SNAPSHOT_PREFIX'),
  gsConstDecl('INTEGRITY_LEADS_SNAPSHOT_PREFIX'),
  gsConstDecl('INTEGRITY_SNAPSHOT_RE'),
  gsFunction('asISODate_'),
  gsFunction('patientKey_'),
  gsFunction('integrityNormalizeKey_'),
  gsFunction('integrityDiffMissingKeys_'),
  gsFunction('integrityParsePaymentPatientId_'),
  gsFunction('integrityParseOverridePatientId_'),
  gsFunction('integrityOrphanKeys_'),
  gsFunction('integritySnapshotName_'),
  gsFunction('integrityIsExpiredSnapshot_'),
  gsFunction('integritySplitChunks_'),
  gsFunction('integrityKeyDisplay_'),
  gsFunction('integrityAlertBody_'),
  gsFunction('integrityStoreKeys_'),
  gsFunction('integrityLoadKeys_'),
].join('\n');

const api = new Function(HELPERS + `
  return {
    normalizeKey: integrityNormalizeKey_,
    diffMissingKeys: integrityDiffMissingKeys_,
    parsePaymentPatientId: integrityParsePaymentPatientId_,
    parseOverridePatientId: integrityParseOverridePatientId_,
    orphanKeys: integrityOrphanKeys_,
    snapshotName: integritySnapshotName_,
    isExpiredSnapshot: integrityIsExpiredSnapshot_,
    splitChunks: integritySplitChunks_,
    keyDisplay: integrityKeyDisplay_,
    alertBody: integrityAlertBody_,
    storeKeys: integrityStoreKeys_,
    loadKeys: integrityLoadKeys_,
    PATIENTS_PREFIX: INTEGRITY_PATIENTS_SNAPSHOT_PREFIX,
    LEADS_PREFIX: INTEGRITY_LEADS_SNAPSHOT_PREFIX,
    SNAPSHOT_RE: INTEGRITY_SNAPSHOT_RE,
    RETENTION_DAYS: INTEGRITY_RETENTION_DAYS,
    ALERT_SUBJECT: INTEGRITY_ALERT_SUBJECT,
    CHUNK_COUNT_PROP: INTEGRITY_PROP_KEY_CHUNK_COUNT,
    CHUNK_PREFIX: INTEGRITY_PROP_KEY_CHUNK_PREFIX,
    CHUNK_CHARS: INTEGRITY_KEY_CHUNK_CHARS,
  };
`)();

/* Minimal in-memory Script Properties (get/set/delete — what the chunk store
 * uses). getProperty returns null for absent keys, like the real service. */
function fakeProps(initial) {
  const store = Object.assign({}, initial || {});
  return {
    store,
    getProperty: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setProperty(k, v) { store[k] = String(v); return this; },
    deleteProperty(k) { delete store[k]; return this; },
  };
}

/* ===== key normalization + sentinel diff ===== */

test('normalizeKey: trims segments and normalizes the date through asISODate_', () => {
  assert.equal(api.normalizeKey(' ramot :: שרה ::2026-07-01'), 'ramot::שרה::2026-07-01');
  assert.equal(api.normalizeKey('ramot::שרה::2026-07-01T00:00:00'), 'ramot::שרה::2026-07-01');
});

test('normalizeKey: a name containing :: keeps the date as the LAST segment', () => {
  assert.equal(api.normalizeKey('ramot::a::b::2026-07-01'), 'ramot::a::b::2026-07-01');
});

test('normalizeKey: fewer than 3 segments passes through trimmed (never matches a live key)', () => {
  assert.equal(api.normalizeKey('  garbage  '), 'garbage');
  assert.equal(api.normalizeKey(null), '');
});

test('diffMissingKeys: keys gone since the previous run', () => {
  const prev = ['ramot::שרה::2026-07-01', 'arfoni::רון::2026-06-10', 'rehab::דנה::2026-08-15'];
  const cur = ['ramot::שרה::2026-07-01', 'rehab::דנה::2026-08-15'];
  assert.deepEqual(api.diffMissingKeys(prev, cur), ['arfoni::רון::2026-06-10']);
});

test('diffMissingKeys: no drop / additions only -> empty', () => {
  const prev = ['ramot::שרה::2026-07-01'];
  const cur = ['ramot::שרה::2026-07-01', 'pardes::דן::2026-08-23'];
  assert.deepEqual(api.diffMissingKeys(prev, cur), []);
});

test('diffMissingKeys: normalization bridges raw vs normalized sides; blanks ignored; dedupes', () => {
  const prev = [' ramot ::שרה::2026-07-01', '', null, 'ramot::שרה::2026-07-01'];
  assert.deepEqual(api.diffMissingKeys(prev, ['ramot::שרה::2026-07-01']), []);
  assert.deepEqual(api.diffMissingKeys(prev, []), ['ramot::שרה::2026-07-01']);
});

/* ===== orphan sweep ===== */

test('parsePaymentPatientId: pay::<house>::<name>::<date>::<dueDate> -> triple (app.js heal mirror)', () => {
  assert.equal(
    api.parsePaymentPatientId('pay::ramot::שרה::2026-07-01::2026-08-01'),
    'ramot::שרה::2026-07-01'
  );
});

test('parsePaymentPatientId: non-conforming -> ""', () => {
  assert.equal(api.parsePaymentPatientId('ovr::ramot::שרה::2026-07-01::2026-08'), '');
  assert.equal(api.parsePaymentPatientId('pay::only::three'), '');
  assert.equal(api.parsePaymentPatientId(''), '');
  assert.equal(api.parsePaymentPatientId(null), '');
});

test('parseOverridePatientId: ovr::<house>::<name>::<date>::<YYYY-MM> -> triple', () => {
  assert.equal(
    api.parseOverridePatientId('ovr::ramot::שרה::2026-07-01::2026-08'),
    'ramot::שרה::2026-07-01'
  );
});

test('parseOverridePatientId: non-conforming -> ""', () => {
  assert.equal(api.parseOverridePatientId('pay::ramot::שרה::2026-07-01::2026-08-01'), '');
  assert.equal(api.parseOverridePatientId('ovr::x::2026-08'), '');
  assert.equal(api.parseOverridePatientId(null), '');
});

test('orphanKeys: live row or tombstone clears a row; neither -> orphan', () => {
  const live = { 'ramot::שרה::2026-07-01': true };
  const tomb = { 'arfoni::רון::2026-06-10': true };
  const rows = [
    { id: 'pay::ramot::שרה::2026-07-01::2026-08-01', patientId: 'ramot::שרה::2026-07-01' },
    { id: 'pay::arfoni::רון::2026-06-10::2026-07-10', patientId: 'arfoni::רון::2026-06-10' },
    { id: 'pay::rehab::דנה::2026-08-15::2026-09-15', patientId: 'rehab::דנה::2026-08-15' },
  ];
  assert.deepEqual(
    api.orphanKeys(rows, api.parsePaymentPatientId, live, tomb),
    ['rehab::דנה::2026-08-15']
  );
});

test('orphanKeys: many rows per patient -> one orphan entry', () => {
  const rows = [
    { id: 'pay::rehab::דנה::2026-08-15::2026-09-15', patientId: 'rehab::דנה::2026-08-15' },
    { id: 'pay::rehab::דנה::2026-08-15::2026-10-15', patientId: 'rehab::דנה::2026-08-15' },
  ];
  assert.deepEqual(api.orphanKeys(rows, api.parsePaymentPatientId, {}, {}), ['rehab::דנה::2026-08-15']);
});

test('orphanKeys: patientId column wins; blank cell healed from the row id (app.js order)', () => {
  const live = { 'ramot::שרה::2026-07-01': true };
  const rows = [
    // blank patientId -> parsed from id -> matches live -> not an orphan
    { id: 'pay::ramot::שרה::2026-07-01::2026-08-01', patientId: '' },
    // column present -> it wins even though the id parses to a live key
    { id: 'pay::ramot::שרה::2026-07-01::2026-09-01', patientId: 'rehab::אחר::2026-01-01' },
  ];
  assert.deepEqual(api.orphanKeys(rows, api.parsePaymentPatientId, live, {}), ['rehab::אחר::2026-01-01']);
});

test('orphanKeys: no patientId and an unparseable id -> skipped (nothing to attribute)', () => {
  const rows = [{ id: 'not-a-payment-id', patientId: '' }, { id: '', patientId: null }];
  assert.deepEqual(api.orphanKeys(rows, api.parsePaymentPatientId, {}, {}), []);
});

test('orphanKeys: normalization bridges a raw column value to a normalized live key', () => {
  const live = { 'ramot::שרה::2026-07-01': true };
  const rows = [{ id: '', patientId: ' ramot ::שרה::2026-07-01T00:00:00' }];
  assert.deepEqual(api.orphanKeys(rows, api.parsePaymentPatientId, live, {}), []);
});

/* ===== chunked Script Properties key store ===== */

test('splitChunks: fixed-size slices, "" -> no chunks, join round-trips', () => {
  assert.deepEqual(api.splitChunks('', 4), []);
  assert.deepEqual(api.splitChunks('abcdefgh', 3), ['abc', 'def', 'gh']);
  const s = 'x'.repeat(10007);
  assert.equal(api.splitChunks(s, 3000).join(''), s);
});

test('storeKeys/loadKeys: round-trips a Hebrew key list across multiple chunks', () => {
  const props = fakeProps();
  const keys = [];
  for (let i = 0; i < 200; i++) keys.push('ramot::מטופל מספר ' + i + '::2026-07-0' + (i % 9 + 1));
  api.storeKeys(props, keys);
  assert.ok(Number(props.store[api.CHUNK_COUNT_PROP]) > 1, 'a 200-key Hebrew list must span >1 chunk');
  for (const k of Object.keys(props.store)) {
    if (k.startsWith(api.CHUNK_PREFIX) && k !== api.CHUNK_COUNT_PROP) {
      assert.ok(props.store[k].length <= api.CHUNK_CHARS, k + ' exceeds the chunk size');
    }
  }
  assert.deepEqual(api.loadKeys(props), keys);
});

test('storeKeys: a shorter list deletes the stale higher-numbered chunks', () => {
  const props = fakeProps();
  api.storeKeys(props, ['k'.repeat(4000)].map((s, i) => s + i)); // forces >= 2 chunks
  const before = Object.keys(props.store).filter((k) => /_\d+$/.test(k)).length;
  assert.ok(before >= 2);
  api.storeKeys(props, ['ramot::שרה::2026-07-01']);
  assert.equal(props.store[api.CHUNK_COUNT_PROP], '1');
  const stale = Object.keys(props.store).filter((k) => /_[1-9]\d*$/.test(k) && k.startsWith(api.CHUNK_PREFIX));
  assert.deepEqual(stale, [], 'stale chunks must be deleted');
  assert.deepEqual(api.loadKeys(props), ['ramot::שרה::2026-07-01']);
});

test('loadKeys: no baseline / missing chunk / corrupt JSON -> null (sentinel SKIPS, never false-alerts)', () => {
  assert.equal(api.loadKeys(fakeProps()), null);
  const missingChunk = fakeProps();
  missingChunk.setProperty(api.CHUNK_COUNT_PROP, '2');
  missingChunk.setProperty(api.CHUNK_PREFIX + '0', '["a"');
  assert.equal(api.loadKeys(missingChunk), null);
  const corrupt = fakeProps();
  corrupt.setProperty(api.CHUNK_COUNT_PROP, '1');
  corrupt.setProperty(api.CHUNK_PREFIX + '0', '{not json');
  assert.equal(api.loadKeys(corrupt), null);
});

test('storeKeys/loadKeys: an EMPTY roster round-trips as [] (distinct from the null no-baseline)', () => {
  const props = fakeProps();
  api.storeKeys(props, []);
  assert.deepEqual(api.loadKeys(props), []);
});

/* ===== snapshot naming + retention ===== */

test('snapshotName: prefixed, zero-padded, from local date parts, both prefixes', () => {
  const d = new Date(2026, 2, 5); // March 5 local
  assert.equal(api.snapshotName(api.PATIENTS_PREFIX, d), 'dashboard-patients-2026-03-05');
  assert.equal(api.snapshotName(api.LEADS_PREFIX, d), 'dashboard-leads-2026-03-05');
});

test('retention: strictly older than 30 days expires; 30 or newer survives', () => {
  const today = 'dashboard-patients-2026-08-30';
  assert.equal(api.isExpiredSnapshot('dashboard-patients-2026-07-30', today, 30), true);
  assert.equal(api.isExpiredSnapshot('dashboard-patients-2026-07-31', today, 30), false);
  assert.equal(api.isExpiredSnapshot('dashboard-leads-2026-07-01', today, 30), true);
  assert.equal(api.isExpiredSnapshot('dashboard-leads-2026-08-30', today, 30), false);
});

test('retention: month and year boundaries', () => {
  assert.equal(api.isExpiredSnapshot('dashboard-patients-2025-12-31', 'dashboard-patients-2026-01-31', 30), true);
  assert.equal(api.isExpiredSnapshot('dashboard-patients-2026-01-01', 'dashboard-patients-2026-01-31', 30), false);
});

test('retention: STRICT matcher — outpatient-*, unprefixed, and malformed names never expire', () => {
  const today = 'dashboard-patients-2026-08-30';
  // the outpatient app's snapshots share EZONE-Backups and are untouchable
  assert.equal(api.isExpiredSnapshot('outpatient-2020-01-01', today, 30), false);
  // unprefixed / foreign / malformed
  assert.equal(api.isExpiredSnapshot('2020-01-01', today, 30), false);
  assert.equal(api.isExpiredSnapshot('Patients', today, 30), false);
  assert.equal(api.isExpiredSnapshot('גיליון1', today, 30), false);
  assert.equal(api.isExpiredSnapshot('dashboard-patients-2020-1-1', today, 30), false);
  assert.equal(api.isExpiredSnapshot('dashboard-patients-2020-01-01-extra', today, 30), false);
  assert.equal(api.isExpiredSnapshot('Xdashboard-patients-2020-01-01', today, 30), false);
  assert.equal(api.isExpiredSnapshot('dashboard-other-2020-01-01', today, 30), false);
  // a malformed TODAY name disables expiry entirely rather than misfiring
  assert.equal(api.isExpiredSnapshot('dashboard-patients-2020-01-01', 'garbage', 30), false);
});

test('retention round-trip: snapshotName output feeds isExpiredSnapshot (prefixes + RE stay in sync)', () => {
  const old = api.snapshotName(api.PATIENTS_PREFIX, new Date(2026, 0, 1));
  const today = api.snapshotName(api.PATIENTS_PREFIX, new Date(2026, 7, 30));
  assert.ok(api.SNAPSHOT_RE.test(old) && api.SNAPSHOT_RE.test(today));
  assert.ok(api.SNAPSHOT_RE.test(api.snapshotName(api.LEADS_PREFIX, new Date(2026, 7, 30))));
  assert.equal(api.isExpiredSnapshot(old, today, api.RETENTION_DAYS), true);
  assert.equal(api.isExpiredSnapshot(today, today, api.RETENTION_DAYS), false);
});

/* ===== alert body ===== */

test('alertBody: missing patients formatted as house — name — entry date (disambiguates duplicates)', () => {
  const body = api.alertBody({
    missing: ['ramot::שרה::2026-07-01', 'ramot::שרה::2026-08-15'],
    orphanPayments: [], orphanOverrides: [], errors: [],
    prevCount: '144', currentCount: '142',
  });
  assert.match(body, /Patients/);
  assert.match(body, /PatientsTombstones/);
  assert.ok(body.includes('  • ramot — שרה — 2026-07-01'));
  assert.ok(body.includes('  • ramot — שרה — 2026-08-15'));
  assert.ok(body.includes('144'));
  assert.ok(body.includes('142'));
});

test('alertBody: orphan payments and overrides get their own sections; errors listed', () => {
  const body = api.alertBody({
    missing: [],
    orphanPayments: ['rehab::דנה::2026-08-15'],
    orphanOverrides: ['asher::טל::2026-05-17'],
    errors: ['קריאת Payments נכשלה: boom'],
    prevCount: '?', currentCount: '0',
  });
  assert.match(body, /Payments/);
  assert.match(body, /BillingOverrides/);
  assert.ok(body.includes('rehab — דנה — 2026-08-15'));
  assert.ok(body.includes('asher — טל — 2026-05-17'));
  assert.match(body, /שגיאות פנימיות/);
  assert.ok(body.includes('boom'));
});

test('alertBody: sections are omitted when empty', () => {
  const body = api.alertBody({
    missing: ['ramot::שרה::2026-07-01'],
    orphanPayments: [], orphanOverrides: [], errors: [],
    prevCount: '1', currentCount: '0',
  });
  assert.doesNotMatch(body, /Payments\)/);
  assert.doesNotMatch(body, /BillingOverrides/);
  assert.doesNotMatch(body, /שגיאות פנימיות/);
});

test('alert subject is the Hebrew Dashboard mismatch subject', () => {
  assert.equal(api.ALERT_SUBJECT, '⚠️ E-ZONE Dashboard: אי-התאמה בנתוני מטופלים');
});

/* ===== source-scan guards ===== */

const JOB = gsFunction('nightlyIntegrityJob');

test('job is read-only vs live sheets: no write primitives, no sheet-ensure, no upsert/delete helpers', () => {
  // call-forms (trailing paren) so the job's own contract COMMENT naming
  // getOrCreateSheet_ doesn't trip the scan
  for (const forbidden of [
    'getOrCreateSheet_(', 'setValues(', 'appendRow(', 'clearContent(', 'setValue(',
    'insertSheet(', 'deleteSheet(', 'upsertRowById_(', 'deleteRowsById_(',
    'replaceHousePatients_(', 'mergeLeads_(', 'appendPatientTombstones_(',
  ]) {
    assert.ok(!JOB.includes(forbidden), 'job body must not contain ' + forbidden);
  }
  // live reads go through getSheetByName only
  assert.ok(JOB.includes('getSheetByName(PATIENTS_SHEET)'));
  assert.ok(JOB.includes('getSheetByName(LEADS_SHEET)'));
  assert.ok(JOB.includes('getSheetByName(PAYMENTS_SHEET)'));
  assert.ok(JOB.includes('getSheetByName(BILLING_OVERRIDES_SHEET)'));
  assert.ok(JOB.includes('getSheetByName(PATIENTS_TOMBSTONES_SHEET)'));
});

test('clearBody_ stays gone from Code.gs (removed in the merge-don\'t-drop PR)', () => {
  assert.ok(!GS.includes('clearBody_'), 'clearBody_ must not reappear');
});

test('snapshot/retention/backup-open helpers never touch the live spreadsheet', () => {
  for (const name of ['integrityWriteSnapshot_', 'integrityApplyRetention_', 'integrityOpenBackupSpreadsheet_']) {
    const src = gsFunction(name);
    assert.ok(!src.includes('getActiveSpreadsheet'), name + ' must not open the live spreadsheet');
    assert.ok(!src.includes('getOrCreateSheet_'), name + ' must not ensure live sheets');
  }
});

test('backup spreadsheet: lookup by stored id then Drive BY NAME runs before any create', () => {
  const opener = gsFunction('integrityOpenBackupSpreadsheet_');
  assert.ok(opener.includes('getFilesByName(INTEGRITY_BACKUP_NAME)'), 'must search Drive by name');
  assert.ok(opener.includes('INTEGRITY_PROP_BACKUP_SSID'), 'must try the stored id');
  assert.ok(!opener.includes('SpreadsheetApp.create'), 'the opener never creates');
  const lookupIdx = JOB.indexOf('integrityOpenBackupSpreadsheet_(');
  const createIdx = JOB.indexOf('SpreadsheetApp.create(');
  assert.ok(lookupIdx !== -1 && createIdx !== -1 && lookupIdx < createIdx,
    'job must look the backup up before creating it');
  // create is guarded on the lookup having failed
  assert.match(JOB, /if\s*\(!backupSs\)\s*\{\s*\n?\s*backupSs = SpreadsheetApp\.create\(INTEGRITY_BACKUP_NAME\)/);
});

test('check ordering: sentinel (check 1) runs BEFORE the snapshot overwrite (check 3); persist AFTER the alert', () => {
  const sentinelIdx = JOB.indexOf('integrityLoadKeys_(');
  const snapshotIdx = JOB.indexOf('integrityWriteSnapshot_(');
  const alertIdx = JOB.indexOf('integritySendAlert_(');
  const persistIdx = JOB.indexOf('integrityStoreKeys_(');
  assert.ok(sentinelIdx !== -1 && snapshotIdx !== -1 && sentinelIdx < snapshotIdx,
    'sentinel must run before the snapshot overwrite');
  assert.ok(alertIdx !== -1 && persistIdx !== -1 && alertIdx < persistIdx,
    'sentinel state must persist after the alert');
});

test('sentinel state: persisted only off a successful Patients read', () => {
  assert.match(JOB, /if\s*\(patientsReadOk\)\s*\{[\s\S]*integrityStoreKeys_\(props,\s*currentKeys\)/);
});

test('sentinel: a tombstone with ANY reason clears a missing key (no reason filtering)', () => {
  const tombBlock = JOB.slice(JOB.indexOf('tombstoneKeySet'), JOB.indexOf('CHECK 1'));
  assert.ok(!tombBlock.includes(".reason"), 'tombstone matching must not filter by reason');
});

test('alerting: fail-open — missing ALERT_EMAIL logs and returns, send failure is caught', () => {
  const src = gsFunction('integritySendAlert_');
  assert.match(src, /if\s*\(!email\)\s*\{\s*\n?\s*Logger\.log/);
  assert.match(src, /catch\s*\(err\)\s*\{\s*\n?\s*Logger\.log/);
  assert.ok(!src.includes('throw'), 'alerting must never throw');
});

test('setupIntegrityTrigger: idempotent (delete same-handler triggers first), daily at 02:xx', () => {
  const src = gsFunction('setupIntegrityTrigger');
  const delIdx = src.indexOf('deleteTrigger');
  const newIdx = src.indexOf('newTrigger');
  assert.ok(delIdx !== -1 && newIdx !== -1 && delIdx < newIdx, 'delete existing triggers before creating');
  assert.ok(src.includes("getHandlerFunction() === 'nightlyIntegrityJob'"));
  assert.ok(src.includes('everyDays(1).atHour(2)'));
  assert.ok(src.includes('nearMinute(30)'), 'staggered ~02:30 attempt (offset from the outpatient 02:00 job)');
});

test('Script Property keys are pinned', () => {
  assert.equal(api.CHUNK_COUNT_PROP, 'INTEGRITY_LAST_PATIENT_KEYS_CHUNKS');
  assert.equal(api.CHUNK_PREFIX, 'INTEGRITY_LAST_PATIENT_KEYS_');
  assert.ok(GS.includes("const INTEGRITY_PROP_BACKUP_SSID = 'INTEGRITY_BACKUP_SSID';"));
  assert.ok(GS.includes("const INTEGRITY_PROP_ALERT_EMAIL = 'ALERT_EMAIL';"));
  assert.ok(GS.includes("const INTEGRITY_BACKUP_NAME      = 'EZONE-Backups';"));
});

test('PATIENT_COLUMNS untouched (legacy prefix; `id` appended last by the identity foundation)', () => {
  const m = GS.match(/const PATIENT_COLUMNS = \[([\s\S]*?)\];/);
  assert.ok(m, 'PATIENT_COLUMNS not found');
  const cols = m[1].match(/'[^']+'/g).map((s) => s.slice(1, -1));
  assert.deepEqual(cols, [
    'houseId', 'name', 'date', 'pay', 'adv',
    'status', 'fromLead', 'exitDate', 'source', 'notes',
    'id',
  ]);
});

test('no new doGet/doPost routing: handle_ never mentions the integrity job', () => {
  const src = gsFunction('handle_');
  assert.ok(!/integrity/i.test(src), 'the job is trigger-driven only — no HTTP action');
});

test('project timezone is Asia/Jerusalem (atHour + snapshot date rolls depend on it)', () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'appsscript.json'), 'utf8')
  );
  assert.equal(manifest.timeZone, 'Asia/Jerusalem');
});
