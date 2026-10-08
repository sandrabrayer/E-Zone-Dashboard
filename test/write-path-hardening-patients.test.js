/* Write-path hardening, PR B — admit / discharge / patients
 * (CHANGELOG-write-path-hardening.md).
 *
 *   R1  every direct patient write is tracked in flight — the visibility
 *       resync never reloads under it;
 *   R2  a failed automatic save (promote / heal) is said in Hebrew;
 *   R3  «נשמר» only with server proof; one row id per form, so a retry
 *       never writes a duplicate; a retry of a landed delete / restore
 *       replays; on failure the form stays open.
 * Every test here FAILED on the parent commit (c5a5494). Names are SYNTHETIC.
 * app.js and Code.gs are the REAL files in a vm. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadPage, tick } = require('./helpers/app-sandbox');
const { richSheet, loadGs } = require('./helpers/gs-sandbox');
const { serverEcho } = require('./helpers/server-echo');

const plain = (v) => JSON.parse(JSON.stringify(v));
const arr = (v) => Array.from(v);

const P = { id: 'id-pat-1', houseId: 'ramot', name: 'דנה לוי', date: '2026-07-01', pay: 9000, adv: 0, status: 'active', fromLead: '' };
const AUDIT = {
  id: 'aud-1', houseId: 'ramot', name: 'דנה לוי', date: '2026-07-01', status: 'released', exitDate: '2026-09-01',
  dischargedAt: '2026-09-01T09:00:00.000Z', disposition: 'completed', restored: '', prior_status: 'active',
};
const LEAD = { id: 'L-1', name: 'יעל כהן', house: 'רמות השבים', stage: 'entry', advance: 0, entryDate: '2026-10-01' };
const DATA = { ok: true, leads: [], patients: {}, irrelevantLeads: [], removedLeads: [], dischargedPatients: [], billingOverrides: [] };

/* A page whose showModal / showCloseLeadModal hand their submit back. */
function page(answerPost) {
  const pg = loadPage({ answerPost: answerPost || ((b) => serverEcho(b, { ok: true })) });
  pg.run(`showModal = (m) => { globalThis.__modal = m; };
          showCloseLeadModal = (o) => { globalThis.__confirm = o.onConfirm; };
          createOutpatientLead = async () => {}; openCreditsModalForDischarge = () => {};
          saveAdmissionFunder = async () => {}; maybeOfferCredits = () => {};`);
  pg.set({ finance: false });
  return pg;
}

/* ================================ R1 ================================ */

test('R1: the visibility resync never reloads while a direct patient write is in flight', async () => {
  const writes = {
    dischargePatient: (pg) => { pg.run('dischargePatient(state.patients[0])'); return pg.run(`globalThis.__confirm({ disposition: 'completed', note: '', dischargeDate: '2026-10-01' })`); },
    restorePatient: (pg) => pg.run(`doRestorePatientAsNewLead(globalThis.__audit, 'id-newlead-1')`),
    restorePatientToActive: (pg) => pg.run(`persistAuditsRestored([globalThis.__audit])`),
    deletePatientRow: (pg) => pg.run('deletePatient(state.patients[0])'),
    deleteDuplicateDischarge: (pg) => pg.run(`deleteDuplicateDischarge(globalThis.__audit, 'כפילות')`),
  };
  for (const [action, start] of Object.entries(writes)) {
    let release;
    const gate = new Promise((r) => { release = r; });
    const pg = page((b) => (b.action === action ? gate : serverEcho(b, { ok: true })));
    pg.sandbox.confirm = () => true;
    pg.sandbox.__audit = AUDIT;
    pg.set({ deleter: true, patients: [pg.run('normalizePatient')(P)], dischargedPatients: [plain(AUDIT)], leads: [] });
    const sending = Promise.resolve(start(pg)).catch(() => {});
    await tick();
    pg.visible();
    assert.deepEqual(pg.gets.map((g) => g.action), [], action + ': no reload while the write is mid-air');
    release({ ok: false, error: 'test' });
    await sending;
  }
});

/* ================================ R2 ================================ */

test('R2: a failed automatic save after a load (promote / heal) is said in Hebrew, not only logged', async () => {
  const pg = page((b) => (b.action === 'saveAll' ? { ok: false, error: 'exception', message: 'quota' } : { ok: true }));
  const load = pg.run('loadAll()');
  await tick();
  pg.nextGet('getData').d.resolve(Object.assign({}, DATA, { leads: [LEAD] }));   // an 'entry' lead → auto-promote
  await load;
  await tick(30);
  assert.ok(pg.errors.some((m) => /לא נשמר/.test(m)), JSON.stringify(pg.errors));
});

/* ================================ R3 ================================ */

test('R3: an admission retried from the same form re-sends the SAME patient id (never a second patient)', async () => {
  let n = 0;
  const pg = page((b) => (b.action === 'saveAll' && ++n === 1 ? { ok: false, error: 'sheets_unreachable' } : serverEcho(b, { ok: true })));
  pg.set({ leads: [plain(LEAD)], patients: [] });
  pg.run('openEntryModal(state.leads[0])');
  const v = { houseId: 'ramot', date: '2026-10-01', pay: '9000', adv: '0', status: 'trial' };
  pg.sandbox.__v = v;
  assert.equal(await pg.run('globalThis.__modal.onSubmit(globalThis.__v)'), false, 'the lost answer keeps the form open');
  assert.equal(await pg.run('globalThis.__modal.onSubmit(globalThis.__v)'), true);
  const ids = pg.posts.filter((b) => b.action === 'saveAll').map((b) => b.patients.ramot.map((x) => x.id)).map((l) => l[0]);
  assert.equal(ids.length, 2);
  assert.equal(ids[0], ids[1], 'one patient id per form');
});

test('R3: an admission the server did not prove (promotion refused) keeps the form open and rolls back', async () => {
  const pg = page((b) => (b.action === 'saveAll'
    ? { ok: true, written: { ramot: 0 }, promoteSkipped: { ramot: [{ fromLead: 'L-1', name: 'יעל כהן', reason: 'existing_patient_row' }] }, proven: { leads: [], patients: [] } }
    : serverEcho(b, { ok: true })));
  pg.set({ leads: [plain(LEAD)], patients: [] });
  pg.run('openEntryModal(state.leads[0])');
  pg.sandbox.__v = { houseId: 'ramot', date: '2026-10-01', pay: '9000', adv: '0', status: 'trial' };
  assert.equal(await pg.run('globalThis.__modal.onSubmit(globalThis.__v)'), false);
  assert.equal(pg.state().patients.length, 0, 'the unproven patient is not left on screen');
  assert.equal(pg.state().leads[0].stage, 'entry');
});

test('R3: a ✏️ patient edit refused as stale keeps the form open', async () => {
  const pg = page((b) => (b.action === 'saveAll'
    ? { ok: true, proven: { leads: [], patients: [P.id] }, conflicts: [{ id: P.id, name: P.name, sheetUpdatedBy: 'ורד' }] }
    : serverEcho(b, { ok: true })));
  pg.set({ patients: [pg.run('normalizePatient')(P)], leads: [] });
  pg.run('openEditPatientModal(state.patients[0])');
  pg.sandbox.__v = { name: P.name, houseId: 'ramot', date: P.date, pay: '9500', status: 'active', notes: '' };
  assert.equal(await pg.run('globalThis.__modal.onSubmit(globalThis.__v)'), false, 'nothing was saved — the form stays open');
  assert.equal(pg.state().patients[0].pay, 9000, 'the screen does not claim the refused edit');
});

test('R3: a discharge answered ok:true without the stored row is not «saved» — rolled back, modal open', async () => {
  const pg = page((b) => (b.action === 'dischargePatient' ? { ok: true } : serverEcho(b, { ok: true })));
  pg.set({ patients: [pg.run('normalizePatient')(P)], leads: [], dischargedPatients: [] });
  pg.run('dischargePatient(state.patients[0])');
  await assert.rejects(pg.run(`globalThis.__confirm({ disposition: 'completed', note: '', dischargeDate: '2026-10-01' })`));
  assert.equal(pg.state().patients[0].status, 'active');
  assert.equal(pg.posts.filter((b) => b.action === 'saveAll').length, 0, 'no status flip on an unproven audit row');
});

test('R3: restore-as-lead uses the form\'s lead id and, on failure, keeps the choice modal open', async () => {
  const pg = page((b) => (b.action === 'restorePatient' ? { ok: false, error: 'sheets_unreachable' } : serverEcho(b, { ok: true })));
  pg.sandbox.__audit = AUDIT;
  pg.set({ dischargedPatients: [plain(AUDIT)], leads: [] });
  await assert.rejects(pg.run(`doRestorePatientAsNewLead(globalThis.__audit, 'id-newlead-7')`));
  assert.equal(pg.posts[0].patient.newLeadId, 'id-newlead-7', 'the id minted once per form');
  assert.equal(pg.state().leads.length, 0, 'rolled back');
});

test('R3: restore-to-active that fails keeps the choice modal open (the worker throws)', async () => {
  const pg = page((b) => (b.action === 'restorePatientToActive' ? { ok: false, error: 'boom' } : serverEcho(b, { ok: true })));
  pg.sandbox.__audit = AUDIT;
  pg.set({ patients: [pg.run('normalizePatient')(Object.assign({}, P, { status: 'released', exitDate: '2026-09-01' }))], dischargedPatients: [plain(AUDIT)], leads: [] });
  await assert.rejects(pg.run('doRestorePatientToActive(globalThis.__audit)'));
  assert.equal(pg.state().patients[0].status, 'released', 'rolled back');
});

test('R3: a delete answered ok:true without naming the row is not «deleted» — the row comes back', async () => {
  const pg = page((b) => (b.action === 'deletePatientRow' ? { ok: true } : serverEcho(b, { ok: true })));
  pg.sandbox.confirm = () => true;
  pg.set({ deleter: true, patients: [pg.run('normalizePatient')(P)] });
  await pg.run('deletePatient(state.patients[0])');
  assert.equal(pg.state().patients.length, 1);
  assert.ok(!pg.toasts.some((m) => /נמחק לצמיתות/.test(m)));
});

/* ============================ Code.gs (the real file) ============================ */

const PCOLS_EXPR = 'PATIENT_COLUMNS';
function gsWorld(patients) {
  const g = loadGs({});
  const S = g.sandbox.__sheets;
  const cols = arr(g.run(PCOLS_EXPR));
  S.Patients = richSheet('Patients', cols);
  (patients || []).forEach((f) => S.Patients.appendRow(cols.map((c) => (f[c] === undefined ? '' : f[c]))));
  const snapshot = () => JSON.stringify(Object.keys(S).sort().map((k) => [k, S[k].grid]));
  return { g, S, cols, snapshot, rows: () => g.sheetRows('Patients', PCOLS_EXPR) };
}

test('server R3: saveAll proves the rows asked about — a refused promotion is NOT proven; a malformed request writes nothing', () => {
  const w = gsWorld([{ id: 'id-a', houseId: 'arfoni', name: 'הדס', date: '2026-09-01', status: 'active', source: 'lead', fromLead: 'L-9' }]);
  const res = plain(w.g.sandbox.saveAll_(null, {
    ramot: [
      { id: 'id-new', houseId: 'ramot', name: 'שרה', date: '2026-10-01', status: 'trial', source: 'lead', fromLead: 'L-2' },
      { id: 'id-dup', houseId: 'ramot', name: 'הדס חלמיש', date: '2026-09-01', status: 'trial', source: 'lead', fromLead: 'L-9' },
    ],
  }, 'ורד', { patients: ['id-new', 'id-dup'] }));
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.proven.patients, ['id-new'], 'only the row the sheet holds is proven');
  const before = w.snapshot();
  const bad = plain(w.g.sandbox.saveAll_(null, { ramot: [] }, 'ורד', { patients: 'id-new' }));
  assert.equal(bad.error, 'bad_prove');
  assert.equal(w.snapshot(), before, 'nothing written');
});

test('server R3: a delete retried after its answer was lost replays (alreadyDeleted) — never «patient_not_found»', () => {
  const w = gsWorld([{ id: 'id-del', houseId: 'ramot', name: 'גיל', date: '2026-08-01', status: 'active' }]);
  const body = { id: 'id-del', houseId: 'ramot', name: 'גיל', date: '2026-08-01' };
  const first = plain(w.g.sandbox.deletePatientRow_(body, 'ורד'));
  assert.equal(first.ok, true, JSON.stringify(first));
  const before = w.snapshot();
  const retry = plain(w.g.sandbox.deletePatientRow_(body, 'ורד'));
  assert.deepEqual([retry.ok, retry.alreadyDeleted, retry.id], [true, true, 'id-del']);
  assert.equal(w.snapshot(), before, 'nothing written');
  // A different house's id is still not found.
  assert.equal(w.g.sandbox.deletePatientRow_(Object.assign({}, body, { houseId: 'asher' }), 'ורד').error, 'patient_not_found');
});

test('server R3: a restore-as-lead retry with the same lead id replays — one lead, never reset', () => {
  const w = gsWorld([]);
  const audit = Object.assign({}, AUDIT, { newLeadId: 'id-newlead-1' });
  const first = plain(w.g.sandbox.restorePatient_(audit, 'ורד'));
  assert.equal(first.ok, true, JSON.stringify(first));
  // Someone moves the new lead on before the retry arrives.
  const lcols = arr(w.g.run('LEAD_COLUMNS'));
  const leadsSh = w.S[w.g.run('LEADS_SHEET')];
  leadsSh.grid[1][lcols.indexOf('stage')] = 'visit';
  const retry = plain(w.g.sandbox.restorePatient_(audit, 'ורד'));
  assert.deepEqual([retry.ok, retry.replayed, retry.lead.id], [true, true, 'id-newlead-1']);
  const leads = w.g.sheetRows(w.g.run('LEADS_SHEET'), 'LEAD_COLUMNS');
  assert.equal(leads.length, 1, 'never a second lead');
  assert.equal(leads[0].stage, 'visit', 'the retry does not reset the lead');
  assert.equal(w.g.sandbox.restorePatient_(Object.assign({}, AUDIT, { newLeadId: 'bad id!' }), 'ורד').error, 'bad_new_lead_id');
});
