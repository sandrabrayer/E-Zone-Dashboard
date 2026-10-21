/* migrateDirectPatientLeadsNow — the one-time backfill (CHANGELOG-direct-lead-backfill.md).
 *
 * Every already-saved patient without a lead (source 'direct_admin', no valid
 * fromLead) gets the SAME 'dl-<patient id>' lead saveAll_ builds for a new
 * direct add. Dry run by default (zero writes); writes only with false; a
 * second run writes nothing. The REAL apps-script/Code.gs in a vm with an
 * in-memory spreadsheet; every name is SYNTHETIC. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGs, GS_SRC } = require('./helpers/gs-sandbox');

const plain = (v) => JSON.parse(JSON.stringify(v));

function world() {
  const g = loadGs();
  const s = g.sandbox;
  const K = {};
  ['LEADS_SHEET', 'LEAD_COLUMNS', 'PATIENTS_SHEET', 'PATIENT_COLUMNS', 'IRRELEVANT_LEADS_SHEET', 'IRRELEVANT_LEAD_COLUMNS',
    'AUDIT_LOG_SHEET', 'PATIENT_PHONES_SHEET', 'PATIENT_PHONES_COLUMNS']
    .forEach((k) => { const v = g.run(k); K[k] = Array.isArray(v) ? Array.from(v) : v; });
  g.run("todayISODate_ = function () { return '2026-10-21'; }");
  const up = (name, cols, o) => s.upsertRowById_(s.getOrCreateSheet_(name, cols), cols, o);
  // Seed: four direct patients without a lead, plus rows that must be left alone.
  up(K.LEADS_SHEET, K.LEAD_COLUMNS, { id: 'L-board', name: 'נועה ברק', phone: '0501234567', source: 'פייסבוק', stage: 'admitted', created: '2026-01-01' });
  up(K.LEADS_SHEET, K.LEAD_COLUMNS, { id: 'L-ph', name: 'רון אבן', phone: '052-999-8888', source: 'פייסבוק', stage: 'new', created: '2026-01-01' });
  up(K.IRRELEVANT_LEADS_SHEET, K.IRRELEVANT_LEAD_COLUMNS, { id: 'L-closed', name: 'סגור סגור', stage: 'new' });
  const P = (o) => up(K.PATIENTS_SHEET, K.PATIENT_COLUMNS, Object.assign({ status: 'active', source: 'direct_admin', fromLead: '' }, o));
  P({ id: 'id-a', houseId: 'ramot', name: 'דנה לוי', date: '2025-03-04' });                              // no phone anywhere
  P({ id: 'id-b', houseId: 'arfoni', name: 'רון אבן', date: '2026-02-01' });                             // phone by name (L-ph)
  P({ id: 'id-c', houseId: 'sde', name: 'שי טל', date: '2026-05-05', fromLead: 'L-vanished', personId: 'id-a' }); // dangling link, returning
  P({ id: 'id-n', houseId: 'ramot', name: 'נועה ברק', date: '2026-01-10', fromLead: 'L-board', source: 'lead' }); // has a lead
  P({ id: 'id-k', houseId: 'ramot', name: 'סגור סגור', date: '2026-01-10', fromLead: 'L-closed' });     // closed lead = valid link
  P({ id: '', houseId: 'ramot', name: 'בלי מזהה', date: '2026-01-10' });                                // no id: skipped
  return {
    g, s, K,
    leads: () => g.sheetRows(K.LEADS_SHEET, 'LEAD_COLUMNS'),
    patients: () => g.sheetRows(K.PATIENTS_SHEET, 'PATIENT_COLUMNS'),
    snapshot: () => JSON.stringify(Object.keys(s.__sheets).sort().map((n) => [n, s.__sheets[n].grid])),
  };
}

test('dry run is the DEFAULT: logs every patient without a lead (entry date, house, phone) and writes NOTHING', () => {
  const w = world();
  const before = w.snapshot();
  const res = plain(w.s.migrateDirectPatientLeadsNow());
  assert.equal(w.snapshot(), before, 'zero writes, no sheet created');
  assert.equal(res.dryRun, true);
  assert.equal(res.candidates, 3);
  assert.equal(res.skippedNoId, 1);
  assert.deepEqual(res.rows.map((r) => [r.patientId, r.entryDate, r.house, r.phone, r.leadId]), [
    ['id-a', '2025-03-04', 'רמות השבים', '', 'dl-id-a'],
    ['id-b', '2026-02-01', 'קיסריה עפרוני', '0529998888', 'dl-id-b'],
    ['id-c', '2026-05-05', 'שדה אליעזר', '', 'dl-id-c'],
  ]);
  const logged = w.g.logs.filter((l) => l.startsWith('[direct-lead-backfill] DRY RUN {'));
  assert.equal(logged.length, 3);
  for (const part of ['"entryDate":"2026-02-01"', '"house":"קיסריה עפרוני"', '"phone":"0529998888"']) assert.ok(logged[1].includes(part), part);
  assert.equal(plain(w.s.migrateDirectPatientLeadsNow(true)).dryRun, true, 'true is a dry run too');
  assert.equal(w.snapshot(), before);
});

test('the real run writes one lead per patient (same builder as saveAll_), created = entry date, and links it', () => {
  const w = world();
  const res = plain(w.s.migrateDirectPatientLeadsNow(false));
  assert.deepEqual([res.created, res.linked, res.failed], [3, 3, 0]);
  const leads = w.leads();
  const a = leads.find((l) => l.id === 'dl-id-a');
  assert.deepEqual(
    { stage: a.stage, source: a.source, phone: a.phone, house: a.house, entryDate: a.entryDate, created: a.created, note: a.note, name: a.name },
    { stage: 'admitted', source: 'direct_approach', phone: '', house: 'רמות השבים', entryDate: '2025-03-04', created: '2025-03-04',
      note: 'פנייה ישירה (נוסף בתפוסה)', name: 'דנה לוי' }, 'a missing phone still gets a lead');
  const c = leads.find((l) => l.id === 'dl-id-c');
  assert.equal(c.note, 'פנייה ישירה — מטופל חוזר (נוסף בתפוסה)');
  // Same builder as saveAll_: the backfilled row equals buildDirectApproachLead_ for it.
  const built = plain(w.s.buildDirectApproachLead_('dl-id-b', { houseId: 'arfoni', name: 'רון אבן', date: '2026-02-01' }, '0529998888', '2026-02-01'));
  const b = leads.find((l) => l.id === 'dl-id-b');
  Object.keys(built).forEach((k) => assert.equal(String(b[k]), String(built[k]), k));
  const byId = Object.fromEntries(w.patients().map((p) => [p.id, p.fromLead]));
  assert.deepEqual([byId['id-a'], byId['id-b'], byId['id-c'], byId['id-n'], byId['id-k']],
    ['dl-id-a', 'dl-id-b', 'dl-id-c', 'L-board', 'L-closed'], 'only the leadless rows are linked');
  assert.equal(w.patients().find((p) => p.id === 'id-c').personId, 'id-a', 'personId untouched');
  assert.equal(leads.find((l) => l.id === 'L-board').stage, 'admitted', 'other leads untouched');
});

test('idempotent: a second run finds nothing and writes nothing; a lead already there is linked, not duplicated', () => {
  const w = world();
  w.s.migrateDirectPatientLeadsNow(false);
  const before = w.snapshot();
  const res = plain(w.s.migrateDirectPatientLeadsNow(false));
  assert.equal(res.candidates, 0);
  assert.equal(w.snapshot(), before, 'second run: zero writes');

  const w2 = world();
  w2.s.upsertRowById_(w2.s.getOrCreateSheet_(w2.K.LEADS_SHEET, w2.K.LEAD_COLUMNS), w2.K.LEAD_COLUMNS,
    { id: 'dl-id-a', name: 'דנה לוי', source: 'direct_approach', stage: 'admitted', created: '2025-03-04' });
  const r2 = plain(w2.s.migrateDirectPatientLeadsNow(false));
  assert.deepEqual([r2.created, r2.linked], [2, 3]);
  assert.equal(w2.leads().filter((l) => l.id === 'dl-id-a').length, 1);
});

test('per row: one failed lead write is logged and skipped; the others still land; nothing linked to a missing lead', () => {
  const w = world();
  const real = w.s.upsertRowById_;
  w.s.upsertRowById_ = function (sh, cols, o) {
    if (o && o.id === 'dl-id-b') throw new Error('Service Spreadsheets timed out');
    return real(sh, cols, o);
  };
  const res = plain(w.s.migrateDirectPatientLeadsNow(false));
  assert.deepEqual([res.created, res.linked, res.failed], [2, 2, 1]);
  assert.equal(w.patients().find((p) => p.id === 'id-b').fromLead, '');
  assert.ok(w.g.sheetRows(w.K.AUDIT_LOG_SHEET, 'AUDIT_LOG_COLUMNS').some((r) => r.action === 'direct_lead_backfill_failed'));
});

test('runs under the script lock; a busy lock does nothing; no request can reach it', () => {
  const w = world();
  const before = w.snapshot();
  w.s.LockService = { getScriptLock: () => ({ tryLock: () => false, releaseLock: () => {} }) };
  assert.equal(plain(w.s.migrateDirectPatientLeadsNow(false)).error, 'lock_busy');
  assert.equal(w.snapshot(), before);
  assert.ok(!/case\s+'migrateDirectPatientLeadsNow'|action\s*===\s*'migrateDirectPatientLeadsNow'/.test(GS_SRC), 'not dispatched by handle_');
});

test('migrateDirectPatientLeadsApplyNow is the dropdown name of the real run (no argument in the editor)', () => {
  const w = world();
  const res = plain(w.s.migrateDirectPatientLeadsApplyNow());
  assert.equal(res.dryRun, false);
  assert.equal(res.created, 3);
});
