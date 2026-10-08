/* Write-path hardening, PR A — money (CHANGELOG-write-path-hardening.md).
 *
 * The three PR #201 rules on every money write that is not «דווח תשלום»:
 *   R1  a stale read never overwrites newer state; nothing reloads while a
 *       save is in flight;
 *   R2  a load error never clears data — keep it, say so in Hebrew;
 *   R3  «נשמר» only with server proof (ok:true + the persisted row id); a
 *       retry returns the existing row, never a duplicate; on failure the
 *       form stays open with its values.
 * Every test here FAILED on the code before this change (checked by running
 * the suite against the parent commit). Names are SYNTHETIC.
 *
 * app.js is the REAL file in a vm (test/helpers/app-sandbox.js); Code.gs is
 * the REAL file in a vm (test/helpers/gs-sandbox.js). */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadPage, tick } = require('./helpers/app-sandbox');
const { richSheet, loadGs } = require('./helpers/gs-sandbox');

const plain = (v) => JSON.parse(JSON.stringify(v));
const arr = (v) => Array.from(v);

const PID = 'arfoni::דנה כהן::2026-09-15';
const CYCLE_ID = 'pay::arfoni::דנה כהן::2026-09-15::2026-09-15';
const CYCLE = {
  id: CYCLE_ID, patientId: PID, patientName: 'דנה כהן', houseId: 'arfoni', dueDate: '2026-09-15',
  amount: 30000, coverageStart: '2026-09-15', coverageEnd: '2026-10-14', status: 'unpaid', amountPaid: 0, balance: 30000,
};
const RECEIPT = {
  id: 'rcpt-1', cycleId: CYCLE_ID, patientId: PID, patientName: 'דנה כהן', houseId: 'arfoni',
  dueDate: '2026-09-15', amount: 30000, amountPaid: 30000, status: 'paid', receivedDate: '2026-10-01', reference: 'A1',
};
const DATA = { ok: true, leads: [], patients: {}, irrelevantLeads: [], removedLeads: [], dischargedPatients: [], billingOverrides: [] };
const CREDIT = {
  id: 'credit::p1::2026-09::1', patientId: 'p1', patientKey: 'arfoni::דנה::2026-07-01', patientName: 'דנה', houseId: 'arfoni',
  creditType: 'other', allocationMonth: '2026-09', amount: 100, calculatedAmount: 100, status: 'pending', updatedAt: '2026-09-01T00:00:00Z',
};

/* Resolve the three loadAll reads with the given answers. */
function answerLoad(page, data, payments, credits) {
  const d = page.nextGet('getData'); if (d) d.d.resolve(data || DATA);
  const p = page.nextGet('getPayments'); if (p) p.d.resolve(payments || { ok: true, payments: [], receipts: [], funders: [] });
  const c = page.nextGet('getCredits'); if (c) c.d.resolve(credits || { ok: true, credits: [] });
}

/* ================================ R1 ================================ */

test('R1: a getData read that started BEFORE a ✏️ amount save cannot wipe the saved override', async () => {
  const page = loadPage({ answerPost: (b) => ({ ok: true, override: b.override, created: true }) });
  const load = page.run('loadAll()');                       // e.g. the visibility resync
  await tick();
  await page.run(`saveBillingOverride({ patientId: '${PID}', dueDate: '2026-09-15' }, 25000)`);
  assert.equal(page.state().billingOverrides.length, 1, 'the proven override is on screen');
  answerLoad(page, DATA);                                   // the sheet as it was BEFORE the write
  await load;
  assert.equal(page.state().billingOverrides.length, 1, 'the stale getData answer was discarded');
  assert.equal(page.state().billingOverrides[0].amount, 25000);
});

test('R1: the visibility resync never reloads while a money write is in flight', async () => {
  const writes = {
    savePayment: `savePayment(Object.assign({}, globalThis.__cycle, { coverageStart: '2026-09-15', coverageEnd: '2026-10-14' }))`,
    voidReceipt: `voidReceipt(globalThis.__receipt, 'כפול')`,
    editReceipt: `submitReceiptEdit(globalThis.__receipt, { reference: 'B2' }, '')`,
    upsertBillingOverride: `saveBillingOverride({ patientId: '${PID}', dueDate: '2026-09-15' }, 25000)`,
    deleteBillingOverride: `clearBillingOverride({ patientId: '${PID}', dueDate: '2026-09-15' })`,
    appendFunder: `saveFunder({ id: 'p1', houseId: 'arfoni', name: 'דנה כהן', date: '2026-09-15' }, 'מכבי', '2026-10-01')`,
    saveCredit: `saveCredit(Object.assign({}, globalThis.__credit))`,
    confirmPayment: `confirmReceipts(['rcpt-1'], 'confirmed')`,
  };
  for (const [action, expr] of Object.entries(writes)) {
    let release;
    const gate = new Promise((r) => { release = r; });
    const page = loadPage({ answerPost: () => gate });
    page.sandbox.__cycle = CYCLE; page.sandbox.__receipt = RECEIPT; page.sandbox.__credit = CREDIT;
    page.set({
      deleter: true, canConfirm: true, payments: [page.run('normalizePayment')(CYCLE)], receipts: [plain(RECEIPT)],
      billingOverrides: [{ id: page.run('billingOverrideId')(PID, '2026-09'), patientId: PID, month: '2026-09', amount: 9 }],
      credits: [plain(CREDIT)], bc: { data: { receipts: [{ id: 'rcpt-1', confirmStatus: 'reported' }] }, selected: {} },
    });
    const sending = page.run(expr);
    await tick();
    page.visible();
    assert.deepEqual(page.gets.map((g) => g.action), [], action + ': no getData / getPayments while the write is mid-air');
    release({ ok: false, error: 'test' });
    await Promise.resolve(sending).catch(() => {});
  }
});

test('R1: a getCredits read that started before a credit save cannot overwrite it', async () => {
  const saved = Object.assign({}, CREDIT, { amount: 250, calculatedAmount: 250, updatedAt: '2026-10-08T10:00:00Z' });
  const page = loadPage({ answerPost: () => ({ ok: true, credit: saved, updated: true }) });
  page.set({ credits: [plain(CREDIT)] });
  const load = page.run('loadAll()');
  await tick();
  await page.run(`saveCredit({ id: '${CREDIT.id}', amount: 250, updatedAt: '${CREDIT.updatedAt}' })`);
  answerLoad(page, DATA, null, { ok: true, credits: [CREDIT] });   // pre-write sheet
  await load;
  assert.equal(page.state().credits[0].amount, 250, 'the saved credit stays');
});

test('R1: a billingControlQueue read that started before Ortal\'s decision cannot undo it', async () => {
  const page = loadPage({ answerPost: () => ({ ok: true, changed: [{ id: 'rcpt-1', confirmStatus: 'confirmed' }], unchanged: 0 }) });
  page.set({ canConfirm: true, bc: { data: { receipts: [{ id: 'rcpt-1', confirmStatus: 'reported' }] }, selected: {}, loading: false, error: '' } });
  const load = page.run('loadBillingControl()');
  await tick();
  await page.run(`confirmReceipts(['rcpt-1'], 'confirmed')`);
  page.nextGet('billingControlQueue').d.resolve({ ok: true, receipts: [{ id: 'rcpt-1', confirmStatus: 'reported' }] });
  await load;
  assert.equal(page.state().bc.data.receipts[0].confirmStatus, 'confirmed', 'the stale queue was discarded');
});

/* ================================ R2 ================================ */

test('R2: a failed getCredits keeps the credits on screen and says so in Hebrew', async () => {
  const page = loadPage();
  page.set({ credits: [plain(CREDIT)] });
  const load = page.run('loadAll()');
  await tick();
  page.nextGet('getData').d.resolve(DATA);
  page.nextGet('getPayments').d.resolve({ ok: true, payments: [], receipts: [], funders: [] });
  page.nextGet('getCredits').d.reject(new Error('Apps Script HTTP 502'));
  await load;
  assert.equal(page.state().credits.length, 1, 'never wiped to []');
  assert.ok(page.errors.some((m) => /^טעינת הזיכויים נכשלה/.test(m)), JSON.stringify(page.errors));
});

/* ================================ R3 ================================ */

test('R3: a receipt void is «בוטלה» only with the server\'s void copy of THAT receipt', async () => {
  const page = loadPage({ answerPost: () => ({ ok: true }) });   // ok, but no row
  page.set({ deleter: true, receipts: [plain(RECEIPT)] });
  page.sandbox.__receipt = RECEIPT;
  await assert.rejects(page.run(`voidReceipt(globalThis.__receipt, 'כפול')`), /לא אושרה/);
  assert.equal(page.state().receipts[0].status, 'paid', 'not voided on screen without proof');
  assert.ok(!page.toasts.includes('הקבלה בוטלה'), 'no success toast');
});

test('R3: a receipt edit answered ok:true WITHOUT the receipt is not «saved» (the modal stays open)', async () => {
  const page = loadPage({ answerPost: () => ({ ok: true, changed: false }) });
  page.set({ receipts: [plain(RECEIPT)] });
  page.sandbox.__receipt = RECEIPT;
  await assert.rejects(page.run(`submitReceiptEdit(globalThis.__receipt, { reference: 'B2' }, '')`), /לא אושרה/);
});

test('R3: savePayment answered ok:true without the row is a failure — rolled back, never «saved»', async () => {
  const page = loadPage({ answerPost: () => ({ ok: true }) });
  page.set({ payments: [page.run('normalizePayment')(CYCLE)] });
  page.sandbox.__p = Object.assign({}, CYCLE, { coverageStart: '2026-09-20', coverageEnd: '2026-10-19' });
  const ok = await page.run('savePayment(globalThis.__p)');
  assert.equal(ok, false);
  assert.equal(page.state().payments[0].coverageStart, '2026-09-15', 'rolled back to the stored period');
  assert.equal(page.errors.length, 1);
});

test('R3: the ✏️ coverage editor stays open with the typed dates when the save fails', async () => {
  const page = loadPage({ answerPost: () => ({ ok: false, error: 'boom' }) });
  page.set({ payments: [page.run('normalizePayment')(CYCLE)] });
  page.sandbox.__p = page.run('state.payments[0]');
  const before = page.renders.billing;
  await page.run(`saveCoveragePeriod(globalThis.__p, '2026-09-20', '2026-10-19')`);
  assert.equal(page.renders.billing, before, 'the row (and its open editor) is not rebuilt');
  assert.equal(page.toasts.length, 0);
});

test('R3: the ✏️ amount is applied only with the server\'s override id; on failure the editor stays open', async () => {
  const page = loadPage({ answerPost: () => ({ ok: true }) });   // no override echoed
  const before = page.renders.billing;
  await page.run(`saveBillingOverride({ patientId: '${PID}', dueDate: '2026-09-15' }, 25000)`);
  assert.equal(page.state().billingOverrides.length, 0, 'nothing applied without proof');
  assert.equal(page.renders.billing, before, 'the open editor keeps the typed amount');
  assert.equal(page.toasts.length, 0);
  assert.ok(page.errors.some((m) => /עדכון הסכום נכשל/.test(m)));
});

test('R3: a funder save carries an idempotency key and needs the stored row back', async () => {
  const page = loadPage({ answerPost: (b) => ({ ok: true, row: { patientId: b.funder.patientId, funder: 'מכבי', effectiveFrom: '2026-10-01' } }) });
  page.set({ funders: [] });
  await assert.rejects(page.run(`saveFunder({ id: 'p1', houseId: 'arfoni', name: 'דנה כהן', date: '2026-09-15' }, 'מכבי', '2026-10-01', 'sub-0123456789abcdef')`), /לא אושרה/);
  assert.equal(page.posts[0].funder.submissionId, 'sub-0123456789abcdef');
  assert.equal(page.state().funders.length, 0, 'nothing applied without the stored key');
});

test('R3: a confirm whose answer does not name the sent receipt is not «saved» — the selection stays', async () => {
  const page = loadPage({ answerPost: () => ({ ok: true, changed: [], unchanged: 0 }) });
  page.set({ canConfirm: true, bc: { data: { receipts: [{ id: 'rcpt-1', confirmStatus: 'reported' }] }, selected: { 'rcpt-1': true } } });
  const res = await page.run(`confirmReceipts(['rcpt-1'], 'confirmed')`);
  assert.equal(res, null);
  assert.equal(page.state().bc.selected['rcpt-1'], true, 'the selection is kept for a retry');
  assert.equal(page.toasts.length, 0);
  assert.ok(page.errors.some((m) => /לא אושרה/.test(m)));
});

/* ============================ Code.gs (the real file) ============================ */

const PROXY_SECRET = 'proxy-secret-TEST-write-path-money-0123456789abcdef';
const israelDay = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date(ms));
const daysAgo = (n) => israelDay(Date.now() - n * 86400000);
const actor = (id, user, roles, caps) => ({
  proxySecret: PROXY_SECRET, proxyUser: user, user, proxyAuth: 'personal', proxyUserId: id, proxyRoles: roles, proxyCaps: caps,
});
const VERED = () => actor('vered', 'ורד', ['staff', 'reporter', 'deleter'], ['finance', 'billingControl']);
const ORTAL = () => actor('ortal', 'אורטל', ['controller'], ['billingControl']);
const GS_CYCLE = { id: CYCLE_ID, patientId: PID, patientName: 'דנה כהן', houseId: 'arfoni', dueDate: '2026-09-15', amount: 30000 };

function world() {
  const g = loadGs({ props: { PROXY_SECRET, PROXY_SECRET_MODE: 'enforce' } });
  const S = g.sandbox.__sheets;
  const pcols = arr(g.run('PATIENT_COLUMNS'));
  S.Patients = richSheet('Patients', pcols);
  S.Patients.appendRow(pcols.map((c) => ({ id: 'p1', houseId: 'arfoni', name: 'דנה כהן', date: '2026-09-15', pay: 30000, status: 'active' }[c] || '')));
  const call = (body, who) => plain(g.post(Object.assign({}, body, (who || VERED)())));
  const report = (amount, day) => call({ action: 'reportPayment', report: { cycle: GS_CYCLE, report: {
    receivedDate: day, amount, method: 'העברה בנקאית', payer: 'משפחת כהן', reference: 'TRX-' + day, funder: 'פרטי',
    invoiceWanted: 'no', coverageStart: '2026-09-15', coverageEnd: '2026-10-14' } } });
  const rows = () => g.sheetRows('Payments', 'PAYMENT_COLUMNS');
  const snapshot = () => JSON.stringify(Object.keys(S).sort().map((k) => [k, S[k].grid]));
  return { g, S, call, report, rows, snapshot };
}
const voidBody = (id, note) => ({ action: 'savePayment', payment: {
  id, patientId: PID, houseId: 'arfoni', dueDate: '2026-09-15', status: 'void', linkPatientUid: '', linkStatus: 'duplicate',
  linkNote: note, timestamp: new Date().toISOString() } });

test('server R3: a void retried after a lost answer replays the stored void — never «receipt_immutable»', () => {
  const w = world();
  const a = w.report(10000, daysAgo(3));
  w.report(12000, daysAgo(2));
  const first = w.call(voidBody(a.receipt.id, 'כפול'));
  assert.equal(first.ok, true, JSON.stringify(first));
  const before = w.snapshot();
  const retry = w.call(voidBody(a.receipt.id, 'כפול'));
  assert.equal(retry.ok, true, JSON.stringify(retry));
  assert.equal(retry.replayed, true);
  assert.equal(retry.payment.id, a.receipt.id);
  assert.equal(retry.payment.status, 'void');
  assert.equal(retry.cycle.id, CYCLE_ID);
  assert.equal(w.snapshot(), before, 'nothing written');
  // A different decision on the void receipt is still refused.
  assert.equal(w.call(voidBody(a.receipt.id, 'סיבה אחרת')).error, 'receipt_immutable');
});

test('server R3: an editReceipt retry (nothing left to change) still answers the stored receipt', () => {
  const w = world();
  const a = w.report(10000, daysAgo(3));
  const edit = { action: 'editReceipt', edit: { id: a.receipt.id, fields: { reference: 'NEW-1' } } };
  assert.equal(w.call(edit).changed, true);
  const retry = w.call(edit);
  assert.deepEqual([retry.ok, retry.changed, retry.receipt && retry.receipt.id, retry.receipt && retry.receipt.reference],
    [true, false, a.receipt.id, 'NEW-1']);
});

test('server R3: a confirmPayment retry names every id it was sent (unchangedRows)', () => {
  const w = world();
  const a = w.report(10000, daysAgo(3));
  const decide = { action: 'confirmPayment', confirm: { ids: [a.receipt.id], status: 'confirmed' } };
  assert.equal(w.call(decide, ORTAL).changed.length, 1);
  const retry = w.call(decide, ORTAL);
  assert.equal(retry.ok, true);
  assert.deepEqual(retry.unchangedRows.map((r) => [r.id, r.confirmStatus]), [[a.receipt.id, 'confirmed']]);
});

test('server R3: appendFunder with the same key twice → ONE row; the retry replays it; a bad key is refused', () => {
  const w = world();
  const body = (sid) => ({ action: 'appendFunder', funder: { patientId: 'p1', funder: 'מכבי', effectiveFrom: '2026-10-01', submissionId: sid } });
  const sid = 'sub-0123456789abcdef0123456789abcdef';
  const first = w.call(body(sid));
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.row.submissionId, sid);
  const retry = w.call(body(sid));
  assert.deepEqual([retry.ok, retry.replayed, retry.row.submissionId], [true, true, sid]);
  assert.equal(w.g.sheetRows('Funders', 'FUNDER_COLUMNS').length, 1, 'never a second Funders row');
  assert.equal(w.call(body('not-a-key')).error, 'bad_submission_id');
  assert.equal(w.g.sheetRows('Funders', 'FUNDER_COLUMNS').length, 1);
  const cols = arr(w.g.run('FUNDER_COLUMNS'));
  assert.equal(cols[cols.length - 1], 'submissionId', 'appended LAST');
});

test('server R3: a credit edit retried with the pre-save stamp replays for the same user; another user still conflicts', () => {
  const w = world();
  const base = {
    patientId: 'p1', patientKey: 'arfoni::דנה כהן::2026-09-15', patientName: 'דנה כהן', houseId: 'arfoni',
    creditType: 'other', allocationMonth: '2026-09', calculatedAmount: 100, amount: 100, reason: 'פיצוי', status: 'pending',
  };
  const created = w.call({ action: 'saveCredit', credit: base });
  assert.equal(created.ok, true, JSON.stringify(created));
  const edit = { id: created.credit.id, updatedAt: created.credit.updatedAt, notes: 'עודכן' };
  assert.equal(w.call({ action: 'saveCredit', credit: edit }).ok, true);
  const retry = w.call({ action: 'saveCredit', credit: edit });   // the stale stamp of the lost answer
  assert.deepEqual([retry.ok, retry.replayed, retry.credit.id, retry.credit.notes], [true, true, created.credit.id, 'עודכן']);
  const other = actor('sandra', 'סנדרה', ['staff', 'deleter', 'approver'], ['finance', 'billingControl']);
  assert.equal(w.call({ action: 'saveCredit', credit: edit }, () => other).error, 'conflict');
});
