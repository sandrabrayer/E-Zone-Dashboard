/* «בקרת גבייה» — Phase 4 (decided by Sandra, 2026-10-04).
 * CHANGELOG-billing-control-tab.md; docs/billing-control-plan.md Phase 4 / §7.
 *
 * Code.gs (the REAL file in a vm, test/helpers/gs-sandbox.js):
 *   - confirm / flag / unflag transitions, append-only stamps, one AuditLog
 *     row per change (old / new / actor); flagged needs a 2–300 char note;
 *     bulk confirm is atomic; only controller / approver may decide
 *   - the queue: newest first, counts, voids out, «חובות מעל 60 יום», and
 *     Sandra's read-only «חריגים פתוחים» (approver only)
 *   - the controller view reaches ONLY its actions (scan over
 *     PROXY_KNOWN_ACTIONS); Shiran / Yael never reach the tab's actions
 *   - item H: the HTTP save path refuses a direct money write
 *   - the digest's «ממתינים לאימות» line
 * server.js (real Express app, https stubbed):
 *   - Ortal: 403 on every /api/sheets action outside CONTROLLER_ACTIONS and on
 *     every Express /api/ route outside CONTROLLER_ROUTES (scan), nothing
 *     proxied; the allowed ones go through with her principal
 *   - Shiran / Yael: 403 on the tab's actions and its export; Vered 403
 *     forbidden_role on confirmPayment; /api/me's capability set
 *   - «ייצוא אימות» .xlsx (sheets, totals) and the debt-aging export for Ortal
 * lib/billing-control-rules.js + public/app.js (vm):
 *   - «מאומת» = the confirmed receipts allocated by coverage; agrees with
 *     buildMonthlyRevenue's «נגבה» when every receipt is confirmed
 *   - the controller view's screens, the «קוד אישי חדש» picker, Sandra's
 *     section has no write control
 * All names are SYNTHETIC. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const ExcelJS = require('exceljs');
const { richSheet, loadGs } = require('./helpers/gs-sandbox');

const ROOT = path.join(__dirname, '..');
const SERVER_PATH = require.resolve('../server');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const RULES_SRC = fs.readFileSync(path.join(ROOT, 'lib', 'billing-control-rules.js'), 'utf8');
const PR_RULES_SRC = fs.readFileSync(path.join(ROOT, 'lib', 'payment-report-rules.js'), 'utf8');
const HTML_SRC = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const SW_SRC = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');
const CSS_SRC = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
const SERVER_SRC = fs.readFileSync(SERVER_PATH, 'utf8');

const pinHash = require('../lib/pin-hash');
const users = require('../lib/users');
const scope = require('../lib/finance-scope');
const roleScope = require('../lib/role-scope');
const rules = require('../lib/billing-control-rules');
const bcx = require('../lib/billing-control-xlsx');
const report = require('../lib/xlsx-report');
const { createSessionToken } = require('../lib/session');

const plain = (v) => JSON.parse(JSON.stringify(v));
const arr = (v) => Array.from(v);
const PROXY_SECRET = 'proxy-secret-TEST-billing-control-0123456789abcdef';
const SESSION_SECRET = 'session-secret-TEST-billing-control-0123456789ab';
const SHEETS_URL = 'https://script.google.com/macros/s/TEST/exec';
const PEPPER = 'pepper-TEST-billing-control-a1b2c3d4e5f60718293a4b5c';
const FORBIDDEN = { ok: false, error: 'forbidden', message: 'אין הרשאה לפעולה זו' };
const ROLE_FORBIDDEN = { ok: false, error: 'forbidden_role', message: 'אין הרשאה לפעולה זו' };

const israelDay = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date(ms));
const TODAY = israelDay(Date.now());
const daysAgo = (n) => israelDay(Date.now() - n * 86400000);

/* ======================================================================
 * Code.gs world
 * ==================================================================== */

const gsActor = (id, user, roles, caps) => ({
  proxySecret: PROXY_SECRET, proxyUser: user, user, proxyAuth: 'personal', proxyUserId: id, proxyRoles: roles,
  proxyCaps: caps,
});
const VERED = () => gsActor('vered', 'ורד', ['staff', 'reporter', 'deleter'], ['finance', 'billingControl']);
const SANDRA = () => gsActor('sandra', 'סנדרה', ['staff', 'deleter', 'approver', 'viewer'], ['finance', 'billingControl']);
const ORTAL = () => gsActor('ortal', 'אורטל', ['controller'], ['billingControl']);
const SHIRAN = () => gsActor('shiran', 'שירן', ['staff', 'reporter'], []);

const ENTRY = '2026-09-15';
const CYCLE = {
  id: 'pay::arfoni::דנה כהן::2026-09-15::2026-09-15', patientId: 'arfoni::דנה כהן::2026-09-15',
  patientName: 'דנה כהן', houseId: 'arfoni', dueDate: '2026-09-15', amount: 30000,
};
const COV = { coverageStart: '2026-09-15', coverageEnd: '2026-10-14' };

function world() {
  const g = loadGs({ props: { PROXY_SECRET, PROXY_SECRET_MODE: 'enforce' } });
  const S = g.sandbox.__sheets;
  const pcols = arr(g.run('PATIENT_COLUMNS'));
  S.Patients = richSheet('Patients', pcols);
  S.Patients.appendRow(pcols.map((c) => ({ id: 'p1', houseId: 'arfoni', name: 'דנה כהן', date: ENTRY, pay: 30000, status: 'active' }[c] || '')));
  const call = (body, who) => plain(g.post(Object.assign({}, body, (who || VERED)())));
  const reportPay = (amount, receivedDate, extra) => call({ action: 'reportPayment', report: { cycle: CYCLE, report: Object.assign({
    receivedDate, amount, method: 'העברה בנקאית', payer: 'משפחת כהן', reference: 'TRX-' + amount, funder: 'פרטי',
    invoiceWanted: 'no',   // CHANGELOG-payment-invoice.md: a report must carry the choice
  }, COV, extra || {}) } });
  const queue = (who) => call({ action: 'billingControlQueue' }, who || ORTAL);
  const confirm = (ids, status, flagNote, who) => call({ action: 'confirmPayment', confirm: { ids, status, flagNote } }, who || ORTAL);
  const payRows = () => g.sheetRows('Payments', 'PAYMENT_COLUMNS');
  const audits = (prefix) => g.sheetRows('AuditLog', 'AUDIT_LOG_COLUMNS').filter((r) => !prefix || String(r.action).indexOf(prefix) === 0);
  const snapshot = () => JSON.stringify(Object.keys(S).sort().map((k) => [k, S[k].grid]));
  return { g, S, call, reportPay, queue, confirm, payRows, audits, snapshot };
}

/* Two receipts on the same cycle, reported by Vered: 10,000 (older) then 5,000. */
function withTwoReceipts() {
  const w = world();
  assert.equal(w.reportPay(10000, daysAgo(3)).ok, true);
  assert.equal(w.reportPay(5000, daysAgo(1)).ok, true);
  const q = w.queue();
  return Object.assign(w, { ids: q.receipts.map((r) => r.id), q });
}

/* ---------------------------- lists ---------------------------- */

test('lists: Code.gs and lib/ hold the same billing-control lists; nothing new is open; the role list is unchanged', () => {
  const { g } = world();
  assert.deepEqual(arr(g.run('BILLING_CONTROL_ACTIONS')), [...scope.BILLING_CONTROL_ACTIONS]);
  assert.deepEqual(arr(g.run('CONTROLLER_ACTIONS')), [...scope.CONTROLLER_ACTIONS]);
  assert.deepEqual(arr(g.run('CONTROLLER_USER_IDS')), [...users.CONTROLLER_USER_IDS]);
  assert.deepEqual([...scope.CONTROLLER_ACTIONS], ['billingControlQueue', 'confirmPayment', 'debtAging']);
  const known = arr(g.run('PROXY_KNOWN_ACTIONS'));
  for (const a of scope.BILLING_CONTROL_ACTIONS) assert.ok(known.includes(a), a + ' is a known action');
  const open = arr(g.run('OPEN_ACTIONS'));
  for (const a of scope.BILLING_CONTROL_ACTIONS) assert.ok(!open.includes(a), a + ' is NOT open — PROXY_SECRET-gated');
  // + the two own-secret coordinators-roster actions (PR #177); nothing billing.
  assert.deepEqual(open, ['managersOverview', 'managersHouse', 'occupancySnapshots', 'getAdmittedRoster',
    'getPatientsForCoordinators', 'recordDischargeFromCoordinators']);
  assert.ok(!arr(g.run('DELETE_ACTIONS')).includes('confirmPayment'));
  assert.ok(!arr(g.run('APPROVER_ACTIONS')).includes('confirmPayment'));
  assert.deepEqual([...roleScope.CONFIRM_ACTIONS], ['confirmPayment']);
  // Not in FINANCE_ACTIONS: Ortal has no finance, the tab has its own gate.
  for (const a of scope.BILLING_CONTROL_ACTIONS) assert.ok(!scope.FINANCE_ACTIONS.includes(a), a);
});

test('without PROXY_SECRET (enforce mode) both actions are refused at the gate — nothing written', () => {
  const w = withTwoReceipts();
  const before = w.snapshot();
  for (const action of ['billingControlQueue', 'confirmPayment']) {
    const r = plain(w.g.post({ action, confirm: { ids: w.ids, status: 'confirmed' }, user: 'אורטל' }));
    assert.deepEqual(r, { ok: false, error: 'unauthorized' }, action);
  }
  assert.equal(w.snapshot(), before);
});

/* ------------------------ transitions + audit ------------------------ */

test('confirm: reported → confirmed by Ortal; confirmedBy / confirmedAt stamped; one AuditLog row with old, new and the actor; the amount never moves', () => {
  const w = withTwoReceipts();
  const before = w.payRows().find((r) => r.id === w.ids[0]);
  const r = w.confirm([w.ids[0]], 'confirmed');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.changed.length, 1);
  assert.equal(r.changed[0].confirmStatus, 'confirmed');
  assert.equal(r.changed[0].confirmedBy, 'אורטל');
  const row = w.payRows().find((x) => x.id === w.ids[0]);
  assert.equal(row.confirmStatus, 'confirmed');
  assert.equal(row.confirmedBy, 'אורטל', 'from the signed session');
  assert.ok(row.confirmedAt, 'server-stamped');
  for (const k of ['amount', 'amountPaid', 'receivedDate', 'method', 'payer', 'reference', 'status', 'recordedBy', 'recordedAt', 'coverageStart', 'coverageEnd']) {
    assert.equal(row[k], before[k], k + ' untouched');
  }
  const a = w.audits('payment_confirm_');
  assert.equal(a.length, 1);
  assert.equal(a[0].action, 'payment_confirm_confirmed');
  assert.equal(a[0].actor, 'אורטל');
  const d = JSON.parse(a[0].details);
  assert.deepEqual([d.paymentId, d.from, d.to, d.by], [w.ids[0], 'reported', 'confirmed', 'אורטל']);
});

test('confirm: re-confirming is a no-op (no audit row); confirmedBy / confirmedAt are stamped ONCE, never re-stamped by a later change', () => {
  const w = withTwoReceipts();
  w.confirm([w.ids[0]], 'confirmed');
  const first = w.payRows().find((x) => x.id === w.ids[0]);
  const again = w.confirm([w.ids[0]], 'confirmed', '', SANDRA);
  assert.equal(again.ok, true);
  assert.deepEqual([again.changed.length, again.unchanged], [0, 1]);
  assert.equal(w.audits('payment_confirm_').length, 1, 'no second row for nothing');
  // A later change (Sandra un-confirms, then confirms again) is audited but
  // never re-stamps the first confirmation.
  assert.equal(w.confirm([w.ids[0]], 'reported', '', SANDRA).ok, true);
  assert.equal(w.confirm([w.ids[0]], 'confirmed', '', SANDRA).ok, true);
  const after = w.payRows().find((x) => x.id === w.ids[0]);
  assert.equal(after.confirmedBy, first.confirmedBy, 'still Ortal');
  assert.equal(after.confirmedAt, first.confirmedAt);
  const a = w.audits('payment_confirm_');
  assert.deepEqual(a.map((x) => x.action), ['payment_confirm_confirmed', 'payment_confirm_reported', 'payment_confirm_confirmed']);
  assert.deepEqual(a.map((x) => x.actor), ['אורטל', 'סנדרה', 'סנדרה']);
  const d = JSON.parse(a[1].details);
  assert.deepEqual([d.from, d.to], ['confirmed', 'reported']);
});

test('flag: requires a note of 2–300 characters (missing, 1 char, blank, 301 chars, formula-only refused) — nothing written', () => {
  const w = withTwoReceipts();
  const before = w.snapshot();
  for (const note of [undefined, '', ' ', 'x', '  y  ', '=', 'א'.repeat(301)]) {
    const r = w.confirm([w.ids[0]], 'flagged', note);
    assert.equal(r.ok, false, JSON.stringify(note));
    assert.equal(r.error, 'flag_note_invalid');
    assert.match(r.message, /2 עד 300/);
  }
  assert.equal(w.snapshot(), before, 'byte-identical');
  assert.equal(w.confirm([w.ids[0]], 'flagged', 'א'.repeat(300)).ok, true, 'exactly 300 is fine');
});

test('flag → «הסר דגל» back to reported; the note is cleared on the row and kept in the AuditLog; flagged → confirmed allowed too', () => {
  const w = withTwoReceipts();
  const f = w.confirm([w.ids[1]], 'flagged', 'הגיע 29,500 ולא 30,000');
  assert.equal(f.ok, true);
  assert.equal(f.changed[0].flagNote, 'הגיע 29,500 ולא 30,000');
  assert.ok(f.changed[0].flaggedAt);
  let row = w.payRows().find((x) => x.id === w.ids[1]);
  assert.deepEqual([row.confirmStatus, row.flagNote, row.confirmedBy], ['flagged', 'הגיע 29,500 ולא 30,000', ''], 'flagging is not confirming');
  const u = w.confirm([w.ids[1]], 'reported');
  assert.equal(u.ok, true);
  row = w.payRows().find((x) => x.id === w.ids[1]);
  assert.deepEqual([row.confirmStatus, row.flagNote], ['reported', '']);
  const a = w.audits('payment_confirm_');
  assert.deepEqual(a.map((x) => x.action), ['payment_confirm_flagged', 'payment_confirm_reported']);
  const d = JSON.parse(a[1].details);
  assert.deepEqual([d.from, d.to, d.oldFlagNote, d.flagNote], ['flagged', 'reported', 'הגיע 29,500 ולא 30,000', '']);
  // flagged → confirmed directly.
  w.confirm([w.ids[1]], 'flagged', 'לא נמצא בבנק');
  assert.equal(w.confirm([w.ids[1]], 'confirmed').ok, true);
  assert.equal(w.payRows().find((x) => x.id === w.ids[1]).confirmStatus, 'confirmed');
});

test('bulk confirm: several ids in one call; ATOMIC — one unknown / void / non-receipt id refuses all, nothing written', () => {
  const w = withTwoReceipts();
  assert.equal(w.reportPay(2000, daysAgo(2)).ok, true);
  const q = w.queue();
  const all = q.receipts.map((r) => r.id);
  // Void the 2,000 receipt (Vered, deleter — the existing flow).
  const v = q.receipts.find((r) => r.amount === 2000);
  const pay = w.payRows().find((r) => r.id === v.id);
  assert.equal(w.call({ action: 'savePayment', payment: Object.assign({}, pay, { status: 'void', linkStatus: 'duplicate', linkNote: 'כפילות' }) }).ok, true);
  const live = all.filter((id) => id !== v.id);
  const before = w.snapshot();
  for (const [ids, err] of [
    [live.concat(['rcpt-missing']), 'not_found'],
    [live.concat([v.id]), 'receipt_void'],
    [live.concat([CYCLE.id]), 'bad_ids'],
    [[], 'bad_ids'],
    [Array.from({ length: 201 }, (_, i) => 'rcpt-' + i), 'bad_ids'],
  ]) {
    const r = w.confirm(ids, 'confirmed');
    assert.equal(r.ok, false, err);
    assert.equal(r.error, err);
  }
  assert.equal(w.snapshot(), before, 'nothing written by any refused batch');
  const ok = w.confirm(live, 'confirmed');
  assert.equal(ok.ok, true);
  assert.equal(ok.changed.length, 2);
  assert.equal(w.audits('payment_confirm_').length, 2, 'one row per receipt');
  assert.equal(w.queue().counts.confirmed.count, 2);
  assert.equal(w.confirm(live, 'bogus').error, 'confirm_status_invalid');
});

test('who may decide: Ortal (controller) and Sandra (approver) yes; Vered and Shiran → forbidden_role / forbidden, nothing written', () => {
  const w = withTwoReceipts();
  const before = w.snapshot();
  assert.deepEqual(w.confirm([w.ids[0]], 'confirmed', '', VERED), ROLE_FORBIDDEN);
  assert.deepEqual(w.confirm([w.ids[0]], 'confirmed', '', SHIRAN), FORBIDDEN, 'no billingControl at all');
  // A forged role in the body never helps: the role comes from the verified proxy fields.
  assert.deepEqual(w.call({ action: 'confirmPayment', confirm: { ids: [w.ids[0]], status: 'confirmed' }, roles: ['controller'] }, VERED), ROLE_FORBIDDEN);
  // Ortal with her controller role narrowed away: the view stays, the decision goes.
  const narrowed = () => gsActor('ortal', 'אורטל', [], ['billingControl']);
  assert.deepEqual(w.confirm([w.ids[0]], 'confirmed', '', narrowed), ROLE_FORBIDDEN);
  assert.equal(w.snapshot(), before);
  assert.equal(w.confirm([w.ids[0]], 'confirmed', '', SANDRA).ok, true);
  assert.equal(w.confirm([w.ids[1]], 'flagged', 'לא נמצא', ORTAL).ok, true);
});

test('the savePayment path still refuses a confirm write to Vered (the #173 guard), and a stale copy cannot undo Ortal', () => {
  const w = withTwoReceipts();
  w.confirm([w.ids[0]], 'confirmed');
  const row = w.payRows().find((x) => x.id === w.ids[0]);
  // A receipt is immutable through savePayment anyway (PR #176).
  const r = w.call({ action: 'savePayment', payment: Object.assign({}, row, { confirmStatus: 'reported' }) });
  assert.equal(r.ok, false);
  assert.equal(w.payRows().find((x) => x.id === w.ids[0]).confirmStatus, 'confirmed');
});

/* ----------------------------- the queue ----------------------------- */

test('queue: newest first; counts and ₪ per status; voids left out; the allow-listed fields only', () => {
  const w = withTwoReceipts();
  assert.equal(w.reportPay(3000, daysAgo(2)).ok, true);
  let q = w.queue();
  assert.deepEqual(q.receipts.map((r) => r.receivedDate), [daysAgo(1), daysAgo(2), daysAgo(3)], 'newest first');
  assert.deepEqual(plain(q.counts), { reported: { count: 3, amount: 18000 }, flagged: { count: 0, amount: 0 }, confirmed: { count: 0, amount: 0 } });
  const keys = Object.keys(q.receipts[0]).sort();
  assert.deepEqual(keys, ['amount', 'confirmStatus', 'confirmedAt', 'confirmedBy', 'coverageEnd', 'coverageStart', 'cycleId', 'flagNote', 'flaggedAt',
    'funder', 'houseId', 'id', 'method', 'patientName', 'payer', 'receivedDate', 'recordedAt', 'recordedBy', 'reference',
    'invoiceWanted', 'invoiceTo'].sort());   // CHANGELOG-payment-invoice.md
  assert.equal(q.receipts[0].cycleId, CYCLE.id, 'linked to its cycle');
  assert.ok(!JSON.stringify(q).includes('patientUid'), 'no uid leaves');
  // Same date: the later recordedAt first.
  const ids = q.receipts.map((r) => r.id);
  w.confirm([ids[0]], 'confirmed');
  w.confirm([ids[1]], 'flagged', 'לא נמצא');
  // Void the third.
  const third = w.payRows().find((r) => r.id === ids[2]);
  w.call({ action: 'savePayment', payment: Object.assign({}, third, { status: 'void', linkStatus: 'duplicate', linkNote: 'כפילות' }) });
  q = w.queue();
  assert.equal(q.receipts.length, 2, 'the void receipt is not in the queue');
  assert.deepEqual(plain(q.counts), { reported: { count: 0, amount: 0 }, flagged: { count: 1, amount: 3000 }, confirmed: { count: 1, amount: 5000 } });
  assert.equal(q.today, TODAY);
  assert.ok(q.debt60 && q.debt60.recorded && q.debt60.unrecorded, 'debt over 60 days rides along');
  assert.equal(q.exceptions, undefined, 'Ortal: no «חריגים פתוחים»');
  assert.equal(w.queue(VERED).exceptions, undefined, 'Vered: none either');
  assert.ok(w.queue(SANDRA).exceptions, 'Sandra (approver): yes');
});

test('queue is READ-ONLY: no sheet created, nothing written, no lock taken', () => {
  const w = world();
  let locked = 0;
  w.g.sandbox.LockService = { getScriptLock: () => ({ tryLock: () => { locked++; return true; }, waitLock() {}, releaseLock() {} }) };
  const before = w.snapshot();
  const q = w.queue();
  assert.equal(q.ok, true);
  assert.deepEqual(q.receipts, []);
  assert.equal(w.snapshot(), before);
  assert.equal(locked, 0);
});

test('«חובות מעל 60 יום»: from debtAging_ as of today — only the 61+ bucket, recorded and unrecorded kept apart', () => {
  const pure = (byPatient) => plain(world().g.sandbox.billingControlDebt60_({ ok: true, asOf: '2026-10-04', byPatient }));
  const r = pure([
    { name: 'א', houseId: 'arfoni', cycles: [
      { bucket: 'd61_plus', kind: 'recorded', balance: 1000, days: 70, start: '2026-07-20' },
      { bucket: 'd31_60', kind: 'recorded', balance: 9999, days: 40, start: '2026-08-20' },
    ] },
    { name: 'ב', houseId: 'ramot', cycles: [{ bucket: 'd61_plus', kind: 'unrecorded', balance: 9000, days: 91, start: '2026-07-05' }] },
  ]);
  assert.deepEqual(r.recorded, { count: 1, amount: 1000 });
  assert.deepEqual(r.unrecorded, { count: 1, amount: 9000 });
  assert.deepEqual(r.rows.map((x) => [x.patientName, x.days, x.kind]), [['ב', 91, 'unrecorded'], ['א', 70, 'recorded']], 'oldest first');
  assert.equal(world().g.sandbox.billingControlDebt60_({ ok: false }), null);
});

/* ------------------- Sandra's «חריגים פתוחים» (read-only) ------------------- */

test('«חריגים פתוחים»: flagged receipts older than 7 days (by the flag time in AuditLog), debts > 60 days, refund exceptions; approver only', () => {
  const w = withTwoReceipts();
  w.confirm([w.ids[0]], 'flagged', 'לא נמצא בבנק');
  w.confirm([w.ids[1]], 'flagged', 'סכום שונה');
  // Age the first flag: its AuditLog row says it was flagged 10 days ago, the second 3.
  const log = w.S.AuditLog.grid;
  const tsCol = 0;
  const detailsCol = 5;
  for (let i = 1; i < log.length; i++) {
    const d = JSON.parse(log[i][detailsCol] || '{}');
    if (d.paymentId === w.ids[0]) log[i][tsCol] = new Date(Date.now() - 10 * 86400000).toISOString();
    if (d.paymentId === w.ids[1]) log[i][tsCol] = new Date(Date.now() - 3 * 86400000).toISOString();
  }
  // A pending credit above its policy figure.
  const ccols = arr(w.g.run('CREDIT_COLUMNS'));
  w.S.Credits = richSheet('Credits', ccols);
  w.S.Credits.appendRow(ccols.map((c) => ({ id: 'c1', patientName: 'יוסי לוי', houseId: 'ramot', calculatedAmount: 3000, amount: 5000, status: 'pending', overrideReason: 'בקשת המשפחה', payoutDate: '2026-10-15' }[c] || '')));
  w.S.Credits.appendRow(ccols.map((c) => ({ id: 'c2', patientName: 'רגיל', houseId: 'ramot', calculatedAmount: 3000, amount: 3000, status: 'pending' }[c] || '')));
  w.S.Credits.appendRow(ccols.map((c) => ({ id: 'c3', patientName: 'שולם', houseId: 'ramot', calculatedAmount: 0, amount: 4000, status: 'paid' }[c] || '')));
  const q = w.queue(SANDRA);
  const ex = q.exceptions;
  assert.deepEqual(ex.flaggedOld.map((r) => [r.id, r.flagNote, r.ageDays]), [[w.ids[0], 'לא נמצא בבנק', 10]], 'only the one flagged 10 days ago');
  assert.deepEqual(ex.refundExceptions.map((r) => [r.kind, r.patientName, r.amount, r.policyAmount]), [['over_policy', 'יוסי לוי', 5000, 3000]]);
  assert.ok(Array.isArray(ex.debtsOver60));
  // The pure rule with a forecast that has an awaiting decision.
  const rx = plain(w.g.sandbox.billingControlRefundExceptions_({
    awaiting_decision: { byPayoutDate: [{ rows: [{ patientName: 'מיכל', houseId: 'asher', exitDate: '2026-09-28', suggestedAmount: 7000, payoutDate: '2026-10-15' }] }] },
  }, []));
  assert.deepEqual(rx.map((r) => [r.kind, r.patientName, r.amount]), [['awaiting_decision', 'מיכל', 7000]]);
  // 7 days exactly is not «older than 7».
  assert.equal(w.g.sandbox.billingControlAgeDays_(new Date(Date.now() - 7 * 86400000).toISOString(), TODAY) > 7, false);
});

/* ------------------ the controller view (Code.gs side) ------------------ */

test('Code.gs: Ortal reaches ONLY billingControlQueue, confirmPayment and debtAging — every other known action is refused before any read or write', () => {
  const w = withTwoReceipts();
  const known = arr(w.g.run('PROXY_KNOWN_ACTIONS'));
  const allowed = [...scope.CONTROLLER_ACTIONS];
  const before = w.snapshot();
  for (const action of known) {
    if (allowed.includes(action)) continue;
    const r = w.call({ action, lead: { id: 'L1' }, patient: { id: 'p1' }, payment: { id: 'x' } }, ORTAL);
    assert.deepEqual(r, FORBIDDEN, action);
  }
  // An unknown action is refused too (never "unknown_action" with a read behind it).
  assert.deepEqual(w.call({ action: 'getDataPlus' }, ORTAL), FORBIDDEN);
  assert.equal(w.snapshot(), before, 'nothing written by any refused call');
  assert.equal(w.call({ action: 'billingControlQueue' }, ORTAL).ok, true);
  assert.equal(w.call({ action: 'debtAging', asOf: TODAY }, ORTAL).ok, true, 'the debt export she links to');
  // getData: no patients, no leads for her — refused outright.
  assert.deepEqual(w.call({ action: 'getData' }, ORTAL), FORBIDDEN);
  // A forged proxyCaps cannot widen her: finance is never derived for her id.
  assert.deepEqual(w.call({ action: 'getPayments' }, () => gsActor('ortal', 'אורטל', ['controller'], ['finance', 'billingControl'])), FORBIDDEN);
  // And a narrowed proxyCaps (no billingControl) leaves her nothing.
  assert.deepEqual(w.call({ action: 'billingControlQueue' }, () => gsActor('ortal', 'אורטל', ['controller'], [])), FORBIDDEN);
});

test('Code.gs: Shiran / Yael get forbidden on both tab actions; Vered may read the queue', () => {
  const w = withTwoReceipts();
  const YAEL = () => gsActor('yael', 'יעל', ['staff', 'reporter'], []);
  for (const who of [SHIRAN, YAEL]) {
    assert.deepEqual(w.call({ action: 'billingControlQueue' }, who), FORBIDDEN);
    assert.deepEqual(w.call({ action: 'confirmPayment', confirm: { ids: w.ids, status: 'confirmed' } }, who), FORBIDDEN);
  }
  assert.equal(w.call({ action: 'billingControlQueue' }, VERED).ok, true);
  // Vered and Sandra keep everything else (live-shaped actors).
  assert.equal(w.call({ action: 'getPayments' }, VERED).ok, true);
  assert.equal(w.call({ action: 'getData' }, SANDRA).ok, true);
});

/* ------------------------------ item H ------------------------------ */

test('item H: the old direct amountPaid / status write is refused for a cycle WITHOUT receipts too — «יש לדווח תשלום דרך ״דווח תשלום״», nothing written', () => {
  const w = world();
  const base = { id: 'pay::arfoni::דנה כהן::2026-09-15::2026-10-15', patientId: CYCLE.patientId, patientName: 'דנה כהן', houseId: 'arfoni',
    dueDate: '2026-10-15', amount: 30000, amountPaid: 0, balance: 30000, status: 'unpaid' };
  w.g.run('getOrCreateSheet_(PAYMENTS_SHEET, PAYMENT_COLUMNS)');   // the empty tab, as on a live sheet
  const before = w.snapshot();
  const H = { ok: false, error: 'use_report_payment', message: 'יש לדווח תשלום דרך ״דווח תשלום״' };
  // A brand-new row born paid (the cached phone's old dropdown).
  assert.deepEqual(w.call({ action: 'savePayment', payment: Object.assign({}, base, { status: 'paid', amountPaid: 30000, balance: 0 }) }), H);
  assert.deepEqual(w.call({ action: 'updatePayment', payment: Object.assign({}, base, { status: 'partial', amountPaid: 1000 }) }), H, 'the alias too');
  assert.equal(w.snapshot(), before);
  // An unpaid placeholder is fine (the coverage editor / linking create one).
  assert.equal(w.call({ action: 'savePayment', payment: base }).ok, true);
  const after = w.snapshot();
  // Moving its money, or only its status, is refused.
  assert.deepEqual(w.call({ action: 'savePayment', payment: Object.assign({}, base, { amountPaid: 5000 }) }), H);
  assert.deepEqual(w.call({ action: 'savePayment', payment: Object.assign({}, base, { status: 'paid' }) }), H);
  assert.equal(w.snapshot(), after);
  // Linking and the coverage period (same money) still work.
  assert.equal(w.call({ action: 'savePayment', payment: Object.assign({}, base, { coverageStart: '2026-10-15', coverageEnd: '2026-11-14' }) }).ok, true);
  // A LEGACY paid row (already on the sheet) can still be linked, voided, and un-voided by Sandra.
  const legacy = Object.assign({}, base, { id: 'pay-legacy', dueDate: '2026-09-15', status: 'paid', amountPaid: 30000, balance: 0 });
  assert.equal(w.g.sandbox.upsertPayment_(JSON.parse(JSON.stringify(legacy)), 'ורד').ok, true, 'legacy data, as it sits on the sheet');
  assert.equal(w.call({ action: 'savePayment', payment: Object.assign({}, legacy, { linkStatus: 'not_a_patient', linkNote: 'תרומה' }) }).ok, true);
  assert.equal(w.call({ action: 'savePayment', payment: Object.assign({}, legacy, { status: 'void', linkStatus: 'duplicate', linkNote: 'כפילות' }) }).ok, true);
  assert.equal(w.call({ action: 'savePayment', payment: Object.assign({}, legacy, { status: 'paid', linkStatus: '', linkNote: '' }) }, SANDRA).ok, true, "Sandra's un-void is not a money write");
  // Money arrives through «דווח תשלום».
  assert.equal(w.reportPay(30000, daysAgo(1)).ok, true);
});

test('item H: the pure rule', () => {
  const { g } = world();
  const f = (p, prev) => plain(g.sandbox.legacyMoneyWriteRefused_(p, prev));
  assert.equal(f({ status: 'unpaid', amountPaid: 0 }, null), null);
  assert.equal(f({ status: 'unpaid' }, null), null);
  assert.equal(f({ amountPaid: '' }, null), null, 'blank = not sent');
  assert.equal(f({ status: 'paid', amountPaid: 100 }, { status: 'paid', amountPaid: '100' }), null, 'an echo of the stored figures');
  assert.equal(f({ status: 'שולם' }, { status: 'paid' }), null, 'a Hebrew alias of the same status');
  assert.equal(f({ status: 'void' }, { status: 'paid', amountPaid: 100 }), null, 'a void move');
  assert.equal(f({ status: 'paid', amountPaid: 100 }, { status: 'void', amountPaid: 100 }), null, 'an un-void (approver-checked elsewhere)');
  assert.equal(f({ amountPaid: 1 }, null).error, 'use_report_payment');
  assert.equal(f({ amountPaid: 50 }, { amountPaid: 100 }).error, 'use_report_payment');
  assert.equal(f({ status: 'unpaid' }, { status: 'paid', amountPaid: 100 }).error, 'use_report_payment');
});

/* --------------------------- the digest line --------------------------- */

test('digest: «ממתינים לאימות: N» with a link to the tab — live reported receipts only; HTML-escaped; in both the HTML and the text part', () => {
  const w = withTwoReceipts();
  w.reportPay(1000, daysAgo(2));
  const q = w.queue();
  w.confirm([q.receipts[0].id], 'confirmed');
  const rows = w.payRows();
  assert.equal(w.g.sandbox.digestPendingCount_(rows), 2, 'three receipts, one confirmed; the cycle row never counts');
  const voidMe = rows.find((r) => r.id === q.receipts[1].id);
  w.call({ action: 'savePayment', payment: Object.assign({}, voidMe, { status: 'void', linkStatus: 'duplicate', linkNote: 'כפילות' }) });
  assert.equal(w.g.sandbox.digestPendingCount_(w.payRows()), 1, 'a void receipt is not waiting');
  const url = w.g.run('DIGEST_BILLING_CONTROL_URL');
  assert.equal(url, 'https://ezone-dashboard.up.railway.app/#billing-control');
  for (const rowsIn of [[], [{ key: 'k', instant: 0, patientName: 'א', houseLabel: 'ב', amount: 1, paymentDate: '', method: '', reference: '', recordedBy: '', recordedAt: '', updated: false, previousAmount: null }]]) {
    const m = plain(w.g.sandbox.digestCompose_(rowsIn, { todayDmy: '04/10/2026', sinceText: 'a', untilText: 'b', firstRun: false, test: false, pendingCount: 4 }));
    assert.ok(m.htmlBody.includes('ממתינים לאימות: 4'), 'html');
    assert.ok(m.htmlBody.includes('href="' + url + '"'), 'links to the tab');
    assert.ok(m.body.includes('ממתינים לאימות: 4 — ' + url), 'text');
    assert.equal(m.pending, 4);
  }
  const none = plain(w.g.sandbox.digestCompose_([], { todayDmy: '04/10/2026', sinceText: 'a', untilText: 'b' }));
  assert.ok(!none.htmlBody.includes('ממתינים לאימות'), 'no count known → no line');
  // The real run (preview: builds, sends nothing) carries the live count.
  const p = plain(w.g.sandbox.paymentsDigestRun_('preview', new Date()));
  assert.ok(p.body.includes('ממתינים לאימות: 1'), p.body.slice(0, 200));
});

/* ======================================================================
 * «מאומת» — lib + app.js, agreeing with buildMonthlyRevenue
 * ==================================================================== */

function loadApp() {
  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/', hash: '', reload: noop },
    document: {
      addEventListener: noop,
      body: { classList: { toggle: noop, add: noop, remove: noop, contains: () => false } },
      getElementById: () => null, createElement: () => ({}), querySelectorAll: () => [],
    },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    setTimeout: noop, clearTimeout: noop,
    fetch: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) }),
    URL, URLSearchParams, Intl, Math, Date, JSON, Number, String, Array, Object, RegExp, Promise,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(PR_RULES_SRC, sandbox);
  vm.runInContext(RULES_SRC, sandbox);
  vm.runInContext(APP_SRC + `
    globalThis.__test = {
      get state() { return state; },
      normalizePayment, normalizeReceipt, buildMonthlyRevenue, revenueAllocate, paymentCoverage, revenueMonthBounds,
      allowedScreens, resolveScreen, SCREENS, bcReceiptHtml, bcExceptionsHtml, bcCardsHtml, pinAdminOptionLabel,
    };`, sandbox);
  return { app: sandbox.__test, sandbox };
}

test('lib: allocation by coverage = app.js revenueAllocate, day for day, on a window that straddles two months', () => {
  const { app } = loadApp();
  for (const [amount, start, end] of [[3000, '2026-01-20', '2026-02-19'], [30000, '2026-09-15', '2026-10-14'], [12345.67, '2026-02-01', '2026-03-31'], [999, '2026-05-05', '2026-05-05']]) {
    const win = app.paymentCoverage({ dueDate: start, coverageStart: start, coverageEnd: end });
    for (const key of rules.monthsOfWindow({ start, end })) {
      const a = app.revenueAllocate(amount, win, app.revenueMonthBounds(key));
      const b = rules.allocateToMonth(amount, { start, end }, key);
      assert.deepEqual([b.amount, b.daysInMonth, b.windowDays], [a.amount, a.daysInMonth, a.windowDays], `${amount} ${start}..${end} in ${key}`);
    }
  }
  assert.deepEqual(rules.monthsOfWindow({ start: '2026-11-20', end: '2027-02-01' }), ['2026-11', '2026-12', '2027-01', '2027-02']);
});

test('«מאומת» = the CONFIRMED receipts allocated by coverage; equals «נגבה» on the same fixture once every receipt is confirmed (real Code.gs → app.js)', () => {
  const w = withTwoReceipts();
  const getP = () => w.call({ action: 'getPayments' }, VERED);
  const model = (month) => {
    const { app } = loadApp();
    const pr = getP();
    return app.buildMonthlyRevenue({
      month, patients: [], payments: pr.payments.map(app.normalizePayment), credits: [], overrides: [],
      receipts: pr.receipts.map(app.normalizeReceipt), today: TODAY,
    });
  };
  // Nothing confirmed yet: «מאומת» 0, «נגבה» counts the money.
  let sep = model('2026-09');
  assert.equal(sep.verified.inclVat, 0);
  assert.ok(sep.received.inclVat > 0);
  // One confirmed: exactly its slice of the month.
  w.confirm([w.ids[0]], 'confirmed');
  const amt0 = w.queue().receipts.find((r) => r.id === w.ids[0]).amount;
  sep = model('2026-09');
  assert.equal(sep.verified.inclVat, rules.allocateToMonth(amt0, COV_WIN, '2026-09').amount);
  // Both confirmed: «מאומת» equals «נגבה» in BOTH months the coverage touches,
  // and the lib's own figure (the tab's «הכנסה מאומתת») agrees.
  w.confirm([w.ids[1]], 'confirmed');
  const q = w.queue();
  for (const month of ['2026-09', '2026-10']) {
    const m = model(month);
    assert.equal(m.verified.inclVat, m.received.inclVat, month + ' incl. VAT');
    /* Ex-VAT is taken PER ROW at 2dp on this screen («נגבה» has one row per
     * cycle, «מאומת» one per receipt), so the two may differ by agorot — never
     * by a shekel (the card prints whole shekels). */
    assert.ok(Math.abs(m.verified.exVat - m.received.exVat) <= 0.01 * m.verified.count, month + ' ex. VAT');
    assert.equal(rules.verifiedForMonth(q.receipts, month, 'all').total, m.verified.inclVat, month + ' — the tab agrees');
  }
  // «מאומת» is in no other figure: NET is unchanged by it.
  const m = model('2026-09');
  assert.equal(m.net.inclVat, Math.round((m.received.inclVat + m.expected.inclVat - m.credits.inclVat) * 100) / 100);
  // Without the receipts (an old caller), the field is null and nothing else moves.
  const { app } = loadApp();
  const pr = getP();
  const noR = app.buildMonthlyRevenue({ month: '2026-09', patients: [], payments: pr.payments.map(app.normalizePayment), credits: [], overrides: [], today: TODAY });
  assert.equal(noR.verified, null);
  assert.equal(noR.received.inclVat, m.received.inclVat);
});
const COV_WIN = { start: COV.coverageStart, end: COV.coverageEnd };

test('lib: views — receiptsByStatus newest first with a house filter; voids never counted; summary cards; flag note check', () => {
  const R = [
    { id: 'rcpt-a', houseId: 'arfoni', amount: 100, receivedDate: '2026-09-01', recordedAt: '1', confirmStatus: 'reported', coverageStart: '2026-09-01', coverageEnd: '2026-09-30' },
    { id: 'rcpt-b', houseId: 'ramot', amount: 200, receivedDate: '2026-09-03', recordedAt: '1', confirmStatus: '', coverageStart: '2026-09-01', coverageEnd: '2026-09-30' },
    { id: 'rcpt-c', houseId: 'ramot', amount: 400, receivedDate: '2026-09-02', recordedAt: '1', confirmStatus: 'confirmed', coverageStart: '2026-09-16', coverageEnd: '2026-10-15' },
    { id: 'rcpt-d', houseId: 'ramot', amount: 800, receivedDate: '2026-09-02', recordedAt: '1', confirmStatus: 'confirmed', status: 'void', coverageStart: '2026-09-01', coverageEnd: '2026-09-30' },
    { id: 'rcpt-e', houseId: 'arfoni', amount: 50, receivedDate: '2026-09-04', recordedAt: '1', confirmStatus: 'flagged', flagNote: 'x' },
  ];
  assert.deepEqual(rules.receiptsByStatus(R, 'reported').map((r) => r.id), ['rcpt-b', 'rcpt-a'], 'blank status reads reported');
  assert.deepEqual(rules.receiptsByStatus(R, 'reported', 'arfoni').map((r) => r.id), ['rcpt-a']);
  assert.deepEqual(rules.receiptsByStatus(R, 'confirmed').map((r) => r.id), ['rcpt-c'], 'void never counted');
  const v = rules.verifiedForMonth(R, '2026-09', 'all');
  assert.equal(v.total, rules.allocateToMonth(400, { start: '2026-09-16', end: '2026-10-15' }, '2026-09').amount);
  assert.equal(rules.verifiedForMonth(R, '2026-09', 'arfoni').total, 0, 'house filter');
  const c = rules.summaryCards({ receipts: R, debt60: { recorded: { count: 1, amount: 9 }, unrecorded: { count: 0, amount: 0 } } }, '2026-09');
  assert.deepEqual(c.reported, { count: 2, amount: 300 });
  assert.deepEqual(c.flagged, { count: 1, amount: 50 });
  assert.equal(c.confirmedThisMonth.amount, v.total);
  assert.equal(c.debt60.recorded.amount, 9);
  assert.equal(rules.flagNoteCheck('x').error !== '', true);
  assert.equal(rules.flagNoteCheck('  לא נמצא  ').note, 'לא נמצא');
  assert.equal(rules.flagNoteCheck('א'.repeat(301)).error !== '', true);
  assert.deepEqual(rules.verifiedMonths(R), ['2026-10', '2026-09']);
});

/* ======================================================================
 * The page (app.js in a vm)
 * ==================================================================== */

test('page: the controller view opens ONLY «בקרת גבייה»; restricted sessions never get it; full view gets it after גבייה', () => {
  const { app } = loadApp();
  assert.deepEqual(plain(app.allowedScreens(false, 'controller')), ['billing-control']);
  assert.equal(app.resolveScreen('dashboard', false, 'controller'), 'billing-control');
  assert.equal(app.resolveScreen('billing', false, 'controller'), 'billing-control');
  assert.ok(!app.allowedScreens(false, 'restricted').includes('billing-control'));
  const full = plain(app.allowedScreens(true, 'full'));
  assert.equal(full[full.indexOf('billing') + 1], 'billing-control');
  assert.equal(app.resolveScreen('billing-control', true, 'full'), 'billing-control', 'the digest deep link opens it');
});

test('page: a queue card has ✓ / ⚑ / סמן only for a session that may decide; Vered sees the same card read-only; every value escaped', () => {
  const { app } = loadApp();
  const r = { id: 'rcpt-1', patientName: '<img src=x>', houseId: 'arfoni', amount: 30000, receivedDate: '2026-10-01',
    method: 'העברה בנקאית', reference: 'TRX-1', payer: 'משפחת "כהן"', funder: 'פרטי', recordedBy: 'ורד', confirmStatus: 'reported' };
  app.state.canConfirm = true;
  const ortal = app.bcReceiptHtml(r, 'queue');
  for (const s of ['data-bc-confirm="rcpt-1"', 'data-bc-flag="rcpt-1"', 'data-bc-pick="rcpt-1"', '✓ אושר בבנק', '⚑ לא נמצא / בעיה']) assert.ok(ortal.includes(s), s);
  for (const label of ['התקבל', 'אמצעי', 'אסמכתא', 'משלם', 'גורם מממן', 'נרשם ע״י', 'TRX-1', 'קיסריה עפרוני', '01/10/2026']) assert.ok(ortal.includes(label), label);
  assert.ok(!ortal.includes('<img'), 'escaped');
  assert.ok(ortal.includes('&quot;כהן&quot;'));
  app.state.canConfirm = false;
  const vered = app.bcReceiptHtml(r, 'queue');
  assert.ok(!/<button|<input/.test(vered), 'no control for Vered');
  app.state.canConfirm = true;
  const flagged = app.bcReceiptHtml(Object.assign({}, r, { confirmStatus: 'flagged', flagNote: 'לא נמצא' }), 'flagged');
  assert.ok(flagged.includes('data-bc-unflag="rcpt-1"') && flagged.includes('הסר דגל') && flagged.includes('לא נמצא'));
  assert.ok(!/<button|<input/.test(app.bcReceiptHtml(r, 'confirmed', { inMonth: 1000 })), 'the confirmed list is read-only');
});

test("page: Sandra's «חריגים פתוחים» has NO write control — no button, no input, no checkbox", () => {
  const { app } = loadApp();
  app.state.canConfirm = true;   // even for a session that may decide elsewhere
  const html = app.bcExceptionsHtml({
    flaggedOld: [{ id: 'rcpt-9', patientName: 'א', houseId: 'ramot', amount: 100, receivedDate: '2026-09-01', confirmStatus: 'flagged', flagNote: 'לא נמצא', flaggedAt: '2026-09-20', ageDays: 14 }],
    debtsOver60: [{ patientName: 'ב', houseId: 'asher', start: '2026-07-05', balance: 9000, days: 91, kind: 'unrecorded' }],
    refundExceptions: [{ kind: 'over_policy', patientName: 'ג', houseId: 'sde', amount: 5000, policyAmount: 3000, payoutDate: '2026-10-15', reason: 'בקשה' }],
  });
  assert.ok(!/<button|<input|<textarea|<select|data-bc-(confirm|flag|unflag|pick)/.test(html), html.slice(0, 200));
  for (const s of ['סומנו כבעיה לפני יותר מ־7 ימים', 'חובות מעל 60 יום', 'החזרים שממתינים לאישור', 'זיכוי מעל המדיניות', '14 ימים', 'לא נמצא']) assert.ok(html.includes(s), s);
});

test('page: the four summary cards', () => {
  const { app } = loadApp();
  const html = app.bcCardsHtml({ reported: { count: 3, amount: 18000 }, flagged: { count: 1, amount: 3000 },
    confirmedThisMonth: { month: '2026-10', amount: 5000, count: 1 }, debt60: { recorded: { count: 2, amount: 7000 }, unrecorded: { count: 1, amount: 9000 } } });
  for (const s of ['ממתין לאימות', 'סומנו כבעיה', 'אומת החודש', 'חובות מעל 60 יום', 'id="bc-debt-export"', 'ללא רישום: 1']) assert.ok(html.includes(s), s);
});

test('page wiring: index.html, the rules route, the SW bump (v33), CSS — and «קוד אישי חדש» offers אורטל as new', () => {
  assert.match(HTML_SRC, /data-screen="billing-control" data-billing-control>בקרת גבייה/);
  assert.ok(HTML_SRC.includes('id="screen-billing-control"'));
  assert.ok(HTML_SRC.includes('id="rev-verified"'), 'the «מאומת» card');
  assert.ok(HTML_SRC.indexOf('billing-control-rules.js') < HTML_SRC.indexOf('src="app.js'), 'the rules load before app.js');
  assert.match(SERVER_SRC, /app\.get\('\/billing-control-rules\.js'/);
  // v33 shipped this tab; later PRs bump it again (v34: coordinators roster).
  const swVer = Number((SW_SRC.match(/var CACHE_VERSION = 'v(\d+)';/) || [])[1]);
  assert.ok(swVer >= 33, 'SW v33 or later');
  assert.match(SW_SRC, /v32 → v33:/);
  assert.match(SW_SRC, /'\/funder\.js'\) return 'network-first'/, "#178's funder.js route is kept");
  assert.match(SW_SRC, /'\/billing-control-rules\.js'\) return 'network-first'/);
  assert.match(CSS_SRC, /body\.view-restricted \[data-billing-control\] \{ display: none !important; \}/);
  assert.match(CSS_SRC, /body\.view-controller section\.screen:not\(#screen-billing-control\)/);
  const { app } = loadApp();
  assert.equal(app.pinAdminOptionLabel({ id: 'ortal', name: 'אורטל', hasRecord: false }), 'אורטל (חדש)');
  assert.equal(users.modelById('ortal').status, 'active');
  assert.deepEqual([...users.modelById('ortal').roles], ['controller']);
});

/* ======================================================================
 * server.js
 * ==================================================================== */

const ENV_KEYS = ['PROXY_SECRET', 'SESSION_SECRET', 'SHEETS_URL', 'APP_PIN', 'USER_PIN_HASHES', 'PIN_PEPPER',
  'BOOTSTRAP_TOKEN', 'TRUST_PROXY_HOPS', 'MEETING_REPORT_PIN', 'MEETING_REPORT_SECRET', 'APP_PIN_UNTIL', 'HEALTHCHECK_TOKEN'];
const NAMES = { vered: 'ורד', sandra: 'סנדרה', shiran: 'שירן', yael: 'יעל', ortal: 'אורטל' };
const personal = (id) => 'ezone_session=' + createSessionToken(SESSION_SECRET, undefined, undefined, NAMES[id], { id, pinVersion: 1 });

let _hash;
async function records(over) {
  if (!_hash) _hash = await pinHash.hashPin('583920', PEPPER);
  const o = over || {};
  return ['vered', 'sandra', 'shiran', 'yael', 'ortal'].map((id) => Object.assign(JSON.parse(users.recordLine(id, _hash, 1)), o[id] || {}));
}

function freshServer(env) {
  const saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  const orig = { error: console.error, warn: console.warn, log: console.log };
  console.error = () => {}; console.warn = () => {}; console.log = () => {};
  delete require.cache[SERVER_PATH];
  let mod;
  try { mod = require('../server'); } finally {
    Object.assign(console, orig);
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
  return mod;
}

function stubHttps(respond) {
  const calls = [];
  const original = https.request;
  https.request = (url, opts, cb) => {
    const req = new EventEmitter();
    let body = '';
    req.write = (c) => { body += c; };
    req.end = () => {
      calls.push(JSON.parse(body || '{}'));
      const answer = respond(JSON.parse(body || '{}'));
      const res = new EventEmitter();
      res.statusCode = 200; res.headers = {}; res.setEncoding = () => {}; res.resume = () => {};
      setImmediate(() => { cb(res); res.emit('data', JSON.stringify(answer)); res.emit('end'); });
    };
    return req;
  };
  return { calls, restore: () => { https.request = original; } };
}

function request(port, method, urlPath, { cookie, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const h = {};
    if (cookie) h.Cookie = cookie;
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString('utf8')); } catch (_) { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, buf, json, text: buf.toString('utf8') });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function withServer(fn, over) {
  const mod = freshServer({ PROXY_SECRET, SESSION_SECRET, SHEETS_URL, PIN_PEPPER: PEPPER, USER_PIN_HASHES: JSON.stringify(await records(over)) });
  const srv = await new Promise((resolve) => { const s = mod.app.listen(0, '127.0.0.1', () => resolve(s)); });
  try { return await fn(srv.address().port, mod); } finally { srv.close(); }
}

/* A queue answer as Code.gs gives it (built by the real billingControlQueueFor_). */
function queueAnswer() {
  const w = withTwoReceipts();
  w.confirm([w.ids[0]], 'confirmed');
  w.confirm([w.ids[1]], 'flagged', 'לא נמצא בבנק');
  w.reportPay(2500, daysAgo(2));
  return w.queue(SANDRA);
}

test('server: Ortal gets 403 on EVERY /api/sheets action outside CONTROLLER_ACTIONS (GET and POST, scan over PROXY_KNOWN_ACTIONS) — nothing proxied', async () => {
  const known = arr(world().g.run('PROXY_KNOWN_ACTIONS')).concat(['notAnAction', '']);
  const stub = stubHttps(() => ({ ok: true }));
  try {
    await withServer(async (port) => {
      for (const action of known) {
        if (scope.CONTROLLER_ACTIONS.includes(action)) continue;
        const g = await request(port, 'GET', '/api/sheets?action=' + encodeURIComponent(action), { cookie: personal('ortal') });
        assert.equal(g.status, 403, 'GET ' + action);
        assert.deepEqual(g.json, FORBIDDEN, 'GET ' + action);
        const p = await request(port, 'POST', '/api/sheets', { cookie: personal('ortal'), body: { action } });
        assert.equal(p.status, 403, 'POST ' + action);
      }
      assert.equal(stub.calls.length, 0, 'nothing reached Apps Script');
      // Her own actions go through, with her principal (never finance).
      for (const action of scope.CONTROLLER_ACTIONS) {
        const r = await request(port, 'POST', '/api/sheets', { cookie: personal('ortal'), body: { action, asOf: TODAY, confirm: { ids: ['rcpt-1'], status: 'confirmed' } } });
        assert.equal(r.status, 200, action);
      }
      assert.deepEqual(stub.calls.map((c) => c.action), [...scope.CONTROLLER_ACTIONS]);
      for (const c of stub.calls) {
        assert.deepEqual([c.proxyUserId, c.proxyAuth, c.proxyCaps, c.proxyRoles], ['ortal', 'personal', ['billingControl'], ['controller']]);
      }
    });
  } finally { stub.restore(); }
});

test('server: Ortal gets 403 on EVERY Express /api/ route outside CONTROLLER_ROUTES (scan over the router) — and the page is served with body.view-controller', async () => {
  const stub = stubHttps(() => queueAnswer());
  try {
    await withServer(async (port, mod) => {
      const routes = [];
      mod.app._router.stack.forEach((l) => {
        if (!l.route) return;
        Object.keys(l.route.methods).forEach((m) => routes.push([m.toUpperCase(), l.route.path]));
      });
      const api = routes.filter(([, p]) => typeof p === 'string' && p.indexOf('/api/') === 0);
      assert.ok(api.length >= 15, 'the scan sees the router: ' + api.length);
      let refused = 0;
      for (const [method, p] of api) {
        if (scope.CONTROLLER_ROUTES.includes(p) || p.indexOf('/api/meeting-report/') === 0) continue;
        const r = await request(port, method, p, { cookie: personal('ortal'), body: method === 'POST' ? {} : undefined });
        assert.equal(r.status, 403, method + ' ' + p);
        assert.deepEqual(r.json, FORBIDDEN, method + ' ' + p);
        refused++;
      }
      assert.ok(refused >= 8, 'refused ' + refused);
      assert.equal(stub.calls.length, 0, 'no refused route reached Apps Script');
      // The allowed ones.
      const me = await request(port, 'GET', '/api/me', { cookie: personal('ortal') });
      assert.deepEqual(me.json, { ok: true, user: 'אורטל', auth: 'personal', approver: false, deleter: false, finance: false,
        capabilities: ['billingControl'], billingControl: true, view: 'controller', canConfirm: true });
      const x = await request(port, 'GET', '/api/export/billing-control.xlsx', { cookie: personal('ortal') });
      assert.equal(x.status, 200);
      assert.equal(x.headers['content-type'], report.XLSX_MIME);
      assert.equal(x.headers['cache-control'], 'no-store');
      const page = await request(port, 'GET', '/', { cookie: personal('ortal') });
      assert.match(page.text, /<body class="view-controller">/);
      // Static assets are not data — they load.
      assert.equal((await request(port, 'GET', '/billing-control-rules.js', { cookie: personal('ortal') })).status, 200);
    });
  } finally { stub.restore(); }
});

test('server: Ortal\'s debt-aging export (the «חובות מעל 60 יום» link) works; Shiran / Yael get 403 on both tab actions and the export; Vered: queue yes, decide no', async () => {
  const aging = world().g.sandbox.debtAging_(TODAY, {});
  const stub = stubHttps((b) => (b.action === 'debtAging' ? Object.assign(plain(aging), { asOf: b.asOf }) : b.action === 'billingControlQueue' ? queueAnswer() : { ok: true, changed: [], unchanged: 0 }));
  try {
    await withServer(async (port) => {
      const d = await request(port, 'GET', `/api/export/debt-aging.xlsx?asOf=${TODAY}&house=all&status=all`, { cookie: personal('ortal') });
      assert.equal(d.status, 200, d.text.slice(0, 100));
      const n = stub.calls.length;
      for (const id of ['shiran', 'yael']) {
        for (const action of scope.BILLING_CONTROL_ACTIONS) {
          assert.equal((await request(port, 'GET', '/api/sheets?action=' + action, { cookie: personal(id) })).status, 403, id + ' GET ' + action);
          const p = await request(port, 'POST', '/api/sheets', { cookie: personal(id), body: { action, confirm: { ids: ['rcpt-1'], status: 'confirmed' } } });
          assert.deepEqual([p.status, p.json], [403, FORBIDDEN], id + ' POST ' + action);
        }
        assert.equal((await request(port, 'GET', '/api/export/billing-control.xlsx', { cookie: personal(id) })).status, 403, id);
        const me = await request(port, 'GET', '/api/me', { cookie: personal(id) });
        assert.deepEqual([me.json.view, me.json.billingControl, me.json.canConfirm, me.json.capabilities], ['restricted', false, false, []]);
      }
      assert.equal(stub.calls.length, n, 'nothing proxied for Shiran / Yael');
      // Vered: reads the queue, may not decide (the server says so before Apps Script).
      assert.equal((await request(port, 'GET', '/api/sheets?action=billingControlQueue', { cookie: personal('vered') })).status, 200);
      const v = await request(port, 'POST', '/api/sheets', { cookie: personal('vered'), body: { action: 'confirmPayment', confirm: { ids: ['rcpt-1'], status: 'confirmed' } } });
      assert.deepEqual([v.status, v.json], [403, ROLE_FORBIDDEN]);
      // Sandra may decide; Vered and Sandra keep every route (live-shaped records).
      assert.equal((await request(port, 'POST', '/api/sheets', { cookie: personal('sandra'), body: { action: 'confirmPayment', confirm: { ids: ['rcpt-1'], status: 'confirmed' } } })).status, 200);
      for (const id of ['vered', 'sandra']) {
        const me = await request(port, 'GET', '/api/me', { cookie: personal(id) });
        assert.deepEqual([me.json.view, me.json.billingControl, me.json.finance, me.json.canConfirm], ['full', true, true, id === 'sandra'], id);
        assert.equal((await request(port, 'GET', '/api/sheets?action=getPayments', { cookie: personal(id) })).status, 200, id);
        assert.equal((await request(port, 'GET', '/api/export/billing-control.xlsx', { cookie: personal(id) })).status, 200, id);
        assert.match((await request(port, 'GET', '/', { cookie: personal(id) })).text, /\n<body>\n/, id + ': the page is unchanged');
      }
    });
  } finally { stub.restore(); }
});

test('server: an Ortal record narrowed to no roles keeps the controller VIEW (no other tab) but cannot decide; a revoked one is 401', async () => {
  const stub = stubHttps(() => ({ ok: true }));
  try {
    await withServer(async (port) => {
      const me = await request(port, 'GET', '/api/me', { cookie: personal('ortal') });
      assert.deepEqual([me.json.view, me.json.canConfirm], ['controller', false]);
      assert.equal((await request(port, 'GET', '/api/sheets?action=getData', { cookie: personal('ortal') })).status, 403);
      assert.equal((await request(port, 'POST', '/api/sheets', { cookie: personal('ortal'), body: { action: 'confirmPayment' } })).status, 403);
    }, { ortal: { roles: [] } });
    await withServer(async (port) => {
      assert.equal((await request(port, 'GET', '/api/me', { cookie: personal('ortal') })).status, 401);
    }, { ortal: { status: 'revoked' } });
  } finally { stub.restore(); }
});

/* ------------------------------ the workbook ------------------------------ */

test('«ייצוא אימות» workbook: four sheets — סיכום, ממתין לאימות, סומנו כבעיה, אומתו by month with the month total; RTL; formula-guarded', async () => {
  const q = queueAnswer();
  q.receipts.push({ id: 'rcpt-evil', patientName: '=HYPERLINK("x")', houseId: 'arfoni', amount: 10, receivedDate: TODAY, confirmStatus: 'reported', recordedAt: '' });
  const buf = await report.buildXlsxReport(bcx.buildBillingControlSpec(q, new Date()));
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  assert.deepEqual(wb.worksheets.map((s) => s.name), ['סיכום', 'ממתין לאימות', 'סומנו כבעיה', 'אומתו']);
  for (const s of wb.worksheets) assert.equal(s.views[0].rightToLeft, true, s.name);
  const text = (s) => { const out = []; s.eachRow((r) => out.push(r.values.slice(1).map((v) => (v && v.richText ? v.richText.map((t) => t.text).join('') : v instanceof Date ? v.toISOString().slice(0, 10) : String(v == null ? '' : v))).join('|'))); return out.join('\n'); };
  const pending = text(wb.getWorksheet('ממתין לאימות'));
  assert.ok(pending.includes('תאריך קבלה|מטופל|בית|סכום|אמצעי|אסמכתא|משלם|גורם מממן|נרשם ע״י'), pending.slice(0, 300));
  assert.ok(pending.includes(`'=HYPERLINK("x")`), 'formula-guarded');
  const flagged = text(wb.getWorksheet('סומנו כבעיה'));
  assert.ok(flagged.includes('לא נמצא בבנק'));
  const ok = text(wb.getWorksheet('אומתו'));
  assert.ok(ok.includes('09/2026 — הכנסה מאומתת') && ok.includes('10/2026 — הכנסה מאומתת'), 'one section per month the coverage touches');
  const sep = rules.verifiedForMonth(q.receipts, '2026-09', 'all').total;
  assert.ok(ok.includes('הכנסה מאומתת 09/2026|') || ok.includes(String(sep)), ok);
  const summary = text(wb.getWorksheet('סיכום'));
  for (const s of ['ממתין לאימות', 'סומן כבעיה', 'חוב רשום', 'מחזורים ללא רישום']) assert.ok(summary.includes(s), s);
  assert.equal(bcx.billingControlContentDisposition('2026-10-04'),
    "attachment; filename=\"billing-control-2026-10-04.xlsx\"; filename*=UTF-8''%D7%90%D7%99%D7%9E%D7%95%D7%AA-2026-10-04.xlsx");
  assert.match(bcx.billingControlContentDisposition('../etc'), /unknown-date/);
  assert.equal(bcx.isBillingControlResponse({ ok: false }), false);
});

test('the export route: a bad Apps Script answer → 502, a refusal → 403, never a half file', async () => {
  for (const [answer, status] of [[{ ok: false, error: 'forbidden' }, 403], [{ ok: true }, 502], [{ ok: false, error: 'lock_busy' }, 503]]) {
    const stub = stubHttps(() => answer);
    try {
      await withServer(async (port) => {
        const r = await request(port, 'GET', '/api/export/billing-control.xlsx', { cookie: personal('ortal') });
        assert.equal(r.status, status, JSON.stringify(answer));
        assert.equal(r.headers['cache-control'], 'no-store');
      });
    } finally { stub.restore(); }
  }
});
