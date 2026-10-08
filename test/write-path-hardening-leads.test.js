/* Write-path hardening, PR C — leads, meeting reports and the rest
 * (CHANGELOG-write-path-hardening.md).
 *
 *   R1  every direct lead write is tracked in flight; a reload never starts
 *       under a save; a stale saveAll can no longer put a closed / removed
 *       lead back on Leads;
 *   R3  «נשמר» only with server proof; one lead id per form; a retry of a
 *       landed remove / meeting report replays; on failure the form stays
 *       open with its values.
 * Every test here FAILED on the parent commit (ec5a8a1). Names are SYNTHETIC.
 * app.js, meeting-report.js and Code.gs are the REAL files. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadPage, tick } = require('./helpers/app-sandbox');
const { richSheet, loadGs } = require('./helpers/gs-sandbox');
const { serverEcho } = require('./helpers/server-echo');

const plain = (v) => JSON.parse(JSON.stringify(v));
const arr = (v) => Array.from(v);

const LEAD = { id: 'L-1', name: 'נועה ברק', phone: '050-1234567', house: 'רמות השבים', stage: 'new', assignedTo: 'ורד', meetingWith: '' };
const REPORTED = Object.assign({}, LEAD, { id: 'L-2', stage: 'visit', meetingReportedAt: '2026-10-01T09:00:00.000Z', meetingReportOutcome: 'undecided', meetingReporter: 'דנה' });

function page(answerPost) {
  const pg = loadPage({ answerPost: answerPost || ((b) => serverEcho(b, { ok: true })) });
  pg.run(`showModal = (m) => { globalThis.__modal = m; };
          showCloseLeadModal = (o) => { globalThis.__confirm = o.onConfirm; };
          showConfirm = (o) => { globalThis.__confirmDialog = o; };`);
  return pg;
}
const NEW_LEAD = { name: 'נועה ברק', phone: '', contactName: '', contactPhone: '', contactRelation: '', billingMode: 'patient', house: '', source: '', assignedTo: 'ורד', meetingWith: '', note: '' };

/* ================================ R1 ================================ */

test('R1: the visibility resync never reloads while a direct lead write is in flight', async () => {
  const writes = {
    moveLeadIrrelevant: (pg) => { pg.run('closeLead(state.leads[0])'); return pg.run(`globalThis.__confirm({ disposition: 'not_relevant', note: '' })`); },
    restoreLead: (pg) => { pg.run('restoreIrrelevantLead(state.irrelevantLeads[0])'); return pg.run('globalThis.__confirmDialog.onConfirm()'); },
    removeLead: (pg) => pg.run('removeLead(state.leads[0])'),
    deleteMeetingReport: (pg) => pg.run(`deleteMeetingReport('L-2')`),
  };
  for (const [action, start] of Object.entries(writes)) {
    let release;
    const gate = new Promise((r) => { release = r; });
    const pg = page((b) => (b.action === action ? gate : serverEcho(b, { ok: true })));
    pg.set({ deleter: true, leads: [plain(LEAD), plain(REPORTED)], irrelevantLeads: [Object.assign({}, LEAD, { id: 'L-9', stage: 'irrelevant' })] });
    const sending = Promise.resolve(start(pg)).catch(() => {});
    await tick();
    pg.visible();
    assert.deepEqual(pg.gets.map((g) => g.action), [], action + ': no reload while the write is mid-air');
    release({ ok: false, error: 'test' });
    await sending;
  }
});

test('R1: a meeting-report edit conflict never starts a reload while another save is in flight', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const pg = page((b) => (b.action === 'removeLead' ? gate
    : b.action === 'saveAll' ? { ok: true, reportConflicts: ['L-2'], proven: b.prove || {} } : serverEcho(b, { ok: true })));
  pg.set({ deleter: true, leads: [plain(LEAD), plain(REPORTED)] });
  const removing = pg.run('removeLead(state.leads[0])').catch(() => {});     // still in flight
  await tick();
  const editing = pg.run(`saveMeetingReportEdit('L-2', { outcome: 'advancing', companion: '', note: 'x' })`);
  await tick(40);
  const asked = pg.gets.map((g) => g.action);
  // Let everything settle before asserting, so a failure never hangs the run.
  release({ ok: false, error: 'test' });
  await removing;
  await tick(20);
  pg.deferGets(false, () => ({ ok: true, leads: [], patients: {} }));
  pg.gets.forEach((g) => { if (!g.taken) { g.taken = true; g.d.resolve({ ok: true, leads: [], patients: {}, payments: [], receipts: [], credits: [] }); } });
  assert.equal(await editing, 'conflict');
  assert.deepEqual(asked, [], 'the refresh waits for the save in flight');
});

/* ================================ R3 ================================ */

test('R3: a new lead retried from the same form re-sends the SAME lead id, and a failure keeps the form open', async () => {
  let n = 0;
  const pg = page((b) => (b.action === 'saveAll' && ++n === 1 ? { ok: false, error: 'sheets_unreachable' } : serverEcho(b, { ok: true })));
  pg.set({ leads: [] });
  pg.run('openAddLeadModal()');
  pg.sandbox.__v = NEW_LEAD;
  assert.equal(await pg.run('globalThis.__modal.onSubmit(globalThis.__v)'), false, 'the failed save keeps the form open');
  assert.equal(pg.state().leads.length, 0);
  assert.notEqual(await pg.run('globalThis.__modal.onSubmit(globalThis.__v)'), false);
  const ids = pg.posts.filter((b) => b.action === 'saveAll').map((b) => b.leads[0].id);
  assert.equal(ids.length, 2);
  assert.equal(ids[0], ids[1], 'one lead id per form');
  assert.equal(pg.state().leads.length, 1);
});

test('R3: «cancel» on the duplicate-phone question keeps the new-lead form open with its values', async () => {
  const pg = page();
  pg.set({ leads: [Object.assign({}, LEAD, { id: 'L-old' })] });
  pg.run('openAddLeadModal()');
  pg.sandbox.__v = Object.assign({}, NEW_LEAD, { phone: '050-1234567' });
  const submitting = pg.run('globalThis.__modal.onSubmit(globalThis.__v)');
  await tick();
  pg.run('globalThis.__confirmDialog.onCancel()');
  assert.equal(await submitting, false, 'the form stays open');
  assert.equal(pg.posts.length, 0);
});

test('R3: a lead edit the server did not prove is rolled back and reported', async () => {
  const pg = page((b) => (b.action === 'saveAll' ? { ok: true, proven: { leads: [] } } : serverEcho(b, { ok: true })));
  pg.set({ leads: [pg.run('normalizeLead')(plain(LEAD))] });
  const ok = await pg.run(`updateLead('L-1', { visitDate: '2026-10-20' })`);
  assert.equal(ok, false);
  assert.equal(pg.state().leads[0].visitDate, '', 'rolled back');
  assert.ok(pg.errors.some((m) => /עדכון ליד נכשל/.test(m)));
});

test('R3: «הסר» without the server\'s record is not «removed» — no invented record, the lead comes back', async () => {
  const pg = page((b) => (b.action === 'removeLead' ? { ok: true } : serverEcho(b, { ok: true })));
  pg.set({ deleter: true, leads: [plain(LEAD)], removedLeads: [] });
  await pg.run('removeLead(state.leads[0])');
  assert.equal(pg.state().leads.length, 1);
  assert.equal(pg.state().removedLeads.length, 0);
});

test('R3: closing a lead without the server\'s copy keeps the dialog open and rolls back', async () => {
  const pg = page((b) => (b.action === 'moveLeadIrrelevant' ? { ok: true } : serverEcho(b, { ok: true })));
  pg.set({ leads: [plain(LEAD)], irrelevantLeads: [] });
  pg.run('closeLead(state.leads[0])');
  await assert.rejects(pg.run(`globalThis.__confirm({ disposition: 'not_relevant', note: '' })`));
  assert.equal(pg.state().leads.length, 1);
  assert.equal(pg.state().irrelevantLeads.length, 0);
});

test('R3: deleting a meeting report without the server naming the lead is rolled back', async () => {
  const pg = page((b) => (b.action === 'deleteMeetingReport' ? { ok: true } : serverEcho(b, { ok: true })));
  pg.set({ leads: [plain(REPORTED)] });
  assert.equal(await pg.run(`deleteMeetingReport('L-2')`), false);
  assert.equal(pg.state().leads[0].meetingReportedAt, REPORTED.meetingReportedAt);
});

test('R3 (manager page): one key per form, carried on submit; the confirmation needs the saved lead', () => {
  const mr = require(path.join(__dirname, '..', 'public', 'meeting-report.js'));
  assert.equal(typeof mr.mrNewSubmissionId, 'function');
  const id = mr.mrNewSubmissionId();
  assert.match(id, /^sub-[0-9a-f]{32}$/);
  assert.notEqual(mr.mrNewSubmissionId(), id);
  assert.equal(mr.mrSavedProven({ ok: true, saved: { leadId: 'L-2' } }, 'L-2'), true);
  assert.equal(mr.mrSavedProven({ ok: true }, 'L-2'), false, 'ok:true alone is not proof');
  assert.equal(mr.mrSavedProven({ ok: true, saved: { leadId: 'L-3' } }, 'L-2'), false);
  const src = require('node:fs').readFileSync(path.join(__dirname, '..', 'public', 'meeting-report.js'), 'utf8');
  assert.match(src, /submissionId: state\.submissionId/, 'every send carries the form\'s key');
});

/* ============================ Code.gs (the real file) ============================ */

function gsWorld() {
  const g = loadGs({});
  const S = g.sandbox.__sheets;
  const lcols = arr(g.run('LEAD_COLUMNS'));
  const LEADS = g.run('LEADS_SHEET');
  S[LEADS] = richSheet(LEADS, lcols);
  const addLead = (f) => S[LEADS].appendRow(lcols.map((c) => (f[c] === undefined ? '' : f[c])));
  const leads = () => g.sheetRows(LEADS, 'LEAD_COLUMNS');
  const snapshot = () => JSON.stringify(Object.keys(S).sort().map((k) => [k, S[k].grid]));
  return { g, S, addLead, leads, snapshot };
}

test('server R1: a stale saveAll still carrying a CLOSED lead does not put it back on Leads (closedSuppressed)', () => {
  const w = gsWorld();
  w.addLead({ id: 'L-1', name: 'נועה ברק', stage: 'new' });
  w.addLead({ id: 'L-5', name: 'אחר', stage: 'new' });
  assert.equal(plain(w.g.sandbox.moveLeadIrrelevant_({ id: 'L-1', name: 'נועה ברק', stage: 'new', disposition: 'not_relevant' }, 'ורד')).ok, true);
  // A tab that never saw the close saves its whole lead list.
  const res = plain(w.g.sandbox.saveAll_([{ id: 'L-1', name: 'נועה ברק', stage: 'visit' }, { id: 'L-5', name: 'אחר', stage: 'visit' }], null, 'ורד'));
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.closedSuppressed, ['L-1']);
  assert.deepEqual(w.leads().map((l) => l.id), ['L-5'], 'never in two sheets');
  assert.equal(w.leads()[0].stage, 'visit', 'the other lead still saves');
});

test('server R3: «הסר» retried after its answer was lost replays the stored row — never «lead_id_not_found»', () => {
  const w = gsWorld();
  w.addLead({ id: 'L-1', name: 'נועה ברק', stage: 'new' });
  const first = plain(w.g.sandbox.removeLead_({ id: 'L-1', name: 'נועה ברק', stage: 'new' }, 'ורד'));
  assert.equal(first.ok, true);
  const before = w.snapshot();
  const retry = plain(w.g.sandbox.removeLead_({ id: 'L-1', name: 'נועה ברק', stage: 'new' }, 'ורד'));
  assert.deepEqual([retry.ok, retry.replayed, retry.lead.id], [true, true, 'L-1']);
  assert.equal(w.snapshot(), before, 'nothing written');
});

test('server R3: a meeting report retried with the same key replays — no second stamp, «נצפה» not reset; a bad key is refused', () => {
  const w = gsWorld();
  w.addLead({ id: 'L-2', name: 'נועה', stage: 'visit', house: 'רמות השבים' });
  const report = { leadId: 'L-2', outcome: 'undecided', companion: '', note: 'סיכום', reporter: 'דנה', submissionId: 'sub-0123456789abcdef0123456789abcdef' };
  const first = plain(w.g.sandbox.submitMeetingReport_(report));
  assert.equal(first.ok, true, JSON.stringify(first));
  // Vered marks it seen before the manager's phone retries.
  const lcols = arr(w.g.run('LEAD_COLUMNS'));
  w.S[w.g.run('LEADS_SHEET')].grid[1][lcols.indexOf('meetingSeen')] = '1';
  const retry = plain(w.g.sandbox.submitMeetingReport_(report));
  assert.deepEqual([retry.ok, retry.replayed, retry.saved.reportedAt], [true, true, first.saved.reportedAt]);
  assert.equal(w.leads()[0].meetingSeen, '1', 'the retry does not reset «נצפה»');
  assert.equal(w.g.sandbox.submitMeetingReport_(Object.assign({}, report, { submissionId: 'bad' })).error, 'bad_submission_id');
});

test('server R1: submitMeetingReport takes the script lock — busy → lock_busy, nothing written', () => {
  const w = gsWorld();
  w.addLead({ id: 'L-2', name: 'נועה', stage: 'visit' });
  w.g.sandbox.LockService = { getScriptLock: () => ({ tryLock: () => false, releaseLock: () => {} }) };
  const before = w.snapshot();
  const res = plain(w.g.sandbox.submitMeetingReport_({ leadId: 'L-2', outcome: 'undecided', companion: '', note: '', reporter: 'דנה' }));
  assert.equal(res.error, 'lock_busy');
  assert.equal(w.snapshot(), before);
});
