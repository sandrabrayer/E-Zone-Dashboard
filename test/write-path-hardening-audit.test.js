/* Write-path hardening, PR D — a proven patient save is never hidden
 * (CHANGELOG-write-path-hardening.md).
 *
 * Re-admitting (or ✏️ re-activating) a patient whose stay still has an open
 * discharge row writes TWO things: the patient row (saveAll, proven), then
 * the discharge-row flags (restorePatientToActive). When only the second
 * write failed, the page rolled the PROVEN patient back off the screen — the
 * row was on the sheet, and a retry from the form re-sent it. Now the saved
 * patient stays, and the Hebrew error says what did not save.
 * Every test here FAILED on the parent commit (89135bc). Names are SYNTHETIC. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadPage } = require('./helpers/app-sandbox');
const { serverEcho } = require('./helpers/server-echo');

const plain = (v) => JSON.parse(JSON.stringify(v));
const OPEN_AUDIT = {
  id: 'aud-1', houseId: 'ramot', name: 'דנה לוי', date: '2026-07-01', status: 'released', exitDate: '2026-09-01',
  dischargedAt: '2026-09-01T09:00:00.000Z', disposition: 'completed', restored: '', prior_status: 'active', fromLead: 'L-1',
};

/* restorePatientToActive (the discharge-row flag) fails; everything else
 * answers like the server. */
function page() {
  const pg = loadPage({ answerPost: (b) => (b.action === 'restorePatientToActive'
    ? { ok: false, error: 'exception', message: 'flaky' } : serverEcho(b, { ok: true })) });
  pg.run('showModal = (m) => { globalThis.__modal = m; }; saveAdmissionFunder = async () => {};');
  pg.set({ finance: false, dischargedPatients: [pg.run('normalizeDischargedPatient')(plain(OPEN_AUDIT))] });
  return pg;
}

test('item 1: a re-admission whose flag write fails keeps the PROVEN patient on screen (no rollback, no retry duplicate)', async () => {
  const pg = page();
  pg.set({ patients: [], leads: [{ id: 'L-1', name: 'דנה לוי', house: 'רמות השבים', stage: 'entry', advance: 0, entryDate: '2026-07-01' }] });
  pg.run('openEntryModal(state.leads[0])');
  pg.sandbox.__v = { houseId: 'ramot', date: '2026-07-01', pay: '9000', adv: '0', status: 'active' };
  const ok = await pg.run('globalThis.__modal.onSubmit(globalThis.__v)');
  assert.equal(ok, true, 'the patient is saved — the form closes, no retry that could add a second row');
  assert.equal(pg.state().patients.length, 1, 'the saved patient stays');
  assert.equal(pg.state().leads[0].stage, 'admitted');
  assert.ok(pg.errors.some((m) => /רישום השחרור לא נסגר/.test(m)), JSON.stringify(pg.errors));
});

test('item 1: the same for a direct add / intake', async () => {
  const pg = page();
  pg.set({ patients: [], leads: [] });
  pg.run('openDirectAddPatientModal()');
  pg.sandbox.__v = { name: 'דנה לוי', houseId: 'ramot', date: '2026-07-01', pay: '9000', status: 'active', notes: '' };
  const ok = await pg.run('globalThis.__modal.onSubmit(globalThis.__v)');
  assert.equal(ok, true);
  assert.equal(pg.state().patients.length, 1);
  assert.ok(pg.errors.some((m) => /רישום השחרור לא נסגר/.test(m)));
});

test('item 2: a ✏️ re-activation whose flag write fails keeps the SAVED edit on screen', async () => {
  const pg = page();
  const p = Object.assign({}, OPEN_AUDIT, { id: 'id-pat-1', status: 'released', pay: 9000, adv: 0, source: 'lead' });
  pg.set({ patients: [pg.run('normalizePatient')(p)], leads: [] });
  pg.run('openEditPatientModal(state.patients[0])');
  pg.sandbox.__v = { name: 'דנה לוי', houseId: 'ramot', date: '2026-07-01', pay: '9500', status: 'active', notes: '' };
  const ok = await pg.run('globalThis.__modal.onSubmit(globalThis.__v)');
  assert.equal(ok, true);
  assert.equal(pg.state().patients[0].status, 'active', 'the edit on the sheet is shown');
  assert.equal(pg.state().patients[0].pay, 9500);
  assert.ok(pg.errors.some((m) => /רישום השחרור לא נסגר/.test(m)));
});
