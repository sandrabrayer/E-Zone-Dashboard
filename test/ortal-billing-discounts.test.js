/* Ortal billing — accountant role + discount schema (foundation, PR 1).
 * CHANGELOG-ortal-billing-discounts.md.
 *
 * Code.gs (the REAL file in a vm, test/helpers/gs-sandbox.js):
 *   - roles: Ortal WITH `accountant` may void a never-paid claim; Ortal
 *     WITHOUT it (her live record before Sandra adds it) is refused —
 *     fail-closed; Vered, Shiran, Yael refused; Sandra allowed.
 *     «הנחה» is Vered's and Sandra's (`finance`, by stable id): Ortal — with
 *     or without `accountant` — Shiran and Yael are refused
 *     (CHANGELOG-discount-by-vered.md)
 *   - void rules: unconfirmed receipts only (confirmed / partial refused for
 *     every caller), reason 2–120, ONE receipt, row kept, who / when, audit,
 *     the cycle owed again, a retry replays, Sandra-only undo
 *   - Ortal can never hard-delete a row or touch settings
 *   - discount: validation, server stamps, audit, kept by the amount editor
 *     and by the amount delete
 *   - math: lib/cycle-balance.js = Code.gs cycleBalanceState_ with a
 *     discount; floor at 0; settled cycles untouched; debt reduced, revenue
 *     (RECEIVED, «מאומת») unchanged
 *   - append-only column guard
 * server.js (real Express app, https stubbed): 403 before proxying; the void
 * for Vered and an Ortal record without `accountant`, the discount for Ortal
 * and Shiran; the void for Ortal with it and Sandra and the discount for
 * Vered and Sandra are proxied; the role refusal log holds the id + operation
 * only.
 * All names are SYNTHETIC. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { richSheet, loadGs } = require('./helpers/gs-sandbox');

const SERVER_PATH = require.resolve('../server');
const pinHash = require('../lib/pin-hash');
const users = require('../lib/users');
const roleScope = require('../lib/role-scope');
const scope = require('../lib/finance-scope');
const CB = require('../lib/cycle-balance');
const { createSessionToken } = require('../lib/session');

const plain = (v) => JSON.parse(JSON.stringify(v));
const arr = (v) => Array.from(v);
const PROXY_SECRET = 'proxy-secret-TEST-ortal-discounts-0123456789abcdef';
const SESSION_SECRET = 'session-secret-TEST-ortal-discounts-0123456789abc';
const SHEETS_URL = 'https://script.google.com/macros/s/TEST/exec';
const PEPPER = 'pepper-TEST-ortal-discounts-a1b2c3d4e5f60718293a4b5c6d';
const FORBIDDEN = { ok: false, error: 'forbidden', message: 'אין הרשאה לפעולה זו' };
const ROLE_FORBIDDEN = { ok: false, error: 'forbidden_role', message: 'אין הרשאה לפעולה זו' };

const israelDay = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date(ms));
const TODAY = israelDay(Date.now());
const daysAgo = (n) => israelDay(Date.now() - n * 86400000);

/* ======================================================================
 * Code.gs world
 * ==================================================================== */

const gsActor = (id, user, roles, caps) => ({
  proxySecret: PROXY_SECRET, proxyUser: user, user, proxyAuth: 'personal', proxyUserId: id, proxyRoles: roles, proxyCaps: caps,
});
const VERED = () => gsActor('vered', 'ורד', ['staff', 'reporter', 'deleter'], ['finance', 'billingControl']);
const SANDRA = () => gsActor('sandra', 'סנדרה', ['staff', 'deleter', 'approver', 'viewer'], ['finance', 'billingControl']);
const ORTAL = () => gsActor('ortal', 'אורטל', ['controller', 'accountant'], ['billingControl']);
// Her LIVE record before Sandra adds the role: controller only.
const ORTAL_NO_ACCT = () => gsActor('ortal', 'אורטל', ['controller'], ['billingControl']);
const SHIRAN = () => gsActor('shiran', 'שירן', ['staff', 'reporter'], []);
const YAEL = () => gsActor('yael', 'יעל', ['staff', 'reporter'], []);

const PKEY = 'arfoni::דנה כהן::2026-09-15';
const CYCLE = {
  id: 'pay::arfoni::דנה כהן::2026-09-15::2026-09-15', patientId: PKEY,
  patientName: 'דנה כהן', houseId: 'arfoni', dueDate: '2026-09-15', amount: 30000,
};
const COV = { coverageStart: '2026-09-15', coverageEnd: '2026-10-14' };

function world() {
  const g = loadGs({ props: { PROXY_SECRET, PROXY_SECRET_MODE: 'enforce' } });
  const S = g.sandbox.__sheets;
  const pcols = arr(g.run('PATIENT_COLUMNS'));
  S.Patients = richSheet('Patients', pcols);
  S.Patients.appendRow(pcols.map((c) => ({ id: 'p1', houseId: 'arfoni', name: 'דנה כהן', date: '2026-09-15', pay: 30000, status: 'active' }[c] || '')));
  const lcols = arr(g.run('LEAD_COLUMNS'));
  S.Leads = richSheet('Leads', lcols);
  const call = (body, who) => plain(g.post(Object.assign({}, body, (who || VERED)())));
  const reportPay = (amount, receivedDate) => call({ action: 'reportPayment', report: { cycle: CYCLE, report: Object.assign({
    receivedDate, amount, method: 'העברה בנקאית', payer: 'משפחת כהן', reference: 'TRX-' + amount, funder: 'פרטי', invoiceWanted: 'no',
  }, COV) } });
  const queue = (who) => call({ action: 'billingControlQueue' }, who || ORTAL);
  const decide = (confirm, who) => call({ action: 'confirmPayment', confirm }, who || ORTAL);
  const discount = (d, who) => call({ action: 'setBillingDiscount', discount: d }, who || VERED);
  const payRows = () => g.sheetRows('Payments', 'PAYMENT_COLUMNS');
  const row = (id) => payRows().find((r) => r.id === id);
  const ovrRows = () => g.sheetRows('BillingOverrides', 'BILLING_OVERRIDE_COLUMNS');
  const audits = (prefix) => g.sheetRows('AuditLog', 'AUDIT_LOG_COLUMNS').filter((r) => !prefix || String(r.action).indexOf(prefix) === 0);
  const details = (r) => JSON.parse(String(r.details));
  const snapshot = () => JSON.stringify(Object.keys(S).sort().map((k) => [k, S[k].grid]));
  const aging = () => call({ action: 'debtAging', asOf: TODAY }, SANDRA);
  return { g, S, call, reportPay, queue, decide, discount, payRows, row, ovrRows, audits, details, snapshot, aging };
}

/* One receipt of 10,000 reported by Vered on the 2026-09-15 cycle. */
function withReceipt() {
  const w = world();
  assert.equal(w.reportPay(10000, daysAgo(2)).ok, true);
  const id = w.queue().receipts[0].id;
  return Object.assign(w, { id });
}

const NOTE = 'הכסף לא הגיע לבנק';

/* =========================== 1. roles =========================== */

test('roles: ACCOUNTANT_ACTIONS and DISCOUNT_ACTIONS are pinned equal in lib/role-scope.js and Code.gs; the void needs accountant OR approver, the discount needs finance', () => {
  const { g } = world();
  assert.deepEqual([...roleScope.ACCOUNTANT_ACTIONS], ['voidUnpaidClaim']);
  assert.deepEqual(arr(g.run('ACCOUNTANT_ACTIONS')), [...roleScope.ACCOUNTANT_ACTIONS]);
  for (const op of roleScope.ACCOUNTANT_ACTIONS) {
    assert.equal(roleScope.requiredRoleFor(op), 'accountant|approver');
    assert.equal(g.sandbox.requiredRoleFor_(op), 'accountant|approver');
  }
  assert.deepEqual([...roleScope.DISCOUNT_ACTIONS], ['setBillingDiscount']);
  assert.deepEqual(arr(g.run('DISCOUNT_ACTIONS')), [...roleScope.DISCOUNT_ACTIONS]);
  for (const op of roleScope.DISCOUNT_ACTIONS) {
    assert.equal(roleScope.requiredRoleFor(op), 'finance');
    assert.equal(g.sandbox.requiredRoleFor_(op), 'finance');
  }
  // `finance` is by stable id — the same two ids on both sides.
  assert.deepEqual(arr(g.run('FINANCE_USER_IDS')), [...users.FINANCE_USER_IDS]);
  assert.equal(g.run('NOT_RECEIVED_DECISION'), roleScope.NOT_RECEIVED_DECISION);
  // Classification is identical on both sides.
  const cases = [
    ['confirmPayment', { confirm: { ids: ['rcpt-1'], status: 'not_received', flagNote: 'x' } }],
    ['confirmPayment', { confirm: JSON.stringify({ ids: ['rcpt-1'], status: ' not_received ' }) }],
    ['setBillingDiscount', { discount: {} }],
    ['savePayment', { payment: { status: 'void' } }],
  ];
  for (const [a, p] of cases) assert.equal(roleScope.roleOperationFor(a, p), g.sandbox.roleOperationFor_(a, p), a + ' ' + JSON.stringify(p));
  assert.equal(roleScope.roleOperationFor('confirmPayment', { confirm: { status: 'confirmed' } }), 'confirmPayment', 'an ordinary confirm is unchanged');
  // The model: Ortal alone may hold accountant; she never holds deleter / approver.
  const holders = users.USER_MODEL.filter((u) => u.roles.includes('accountant')).map((u) => u.id);
  assert.deepEqual(holders, ['ortal']);
  assert.ok(!users.modelById('ortal').roles.includes('deleter') && !users.modelById('ortal').roles.includes('approver'));
  assert.deepEqual(arr(g.run('KNOWN_ROLES')), [...users.ROLES], 'Code.gs knows the same roles');
});

test('roles: the validator refuses accountant on any record but Ortal\'s, and accepts her record with or without it', () => {
  const HASH = 'scrypt$16384$8$1$' + 'A'.repeat(22) + '$' + 'B'.repeat(43);
  const rec = (id, roles) => Object.assign(JSON.parse(users.recordLine(id, HASH, 1)), roles ? { roles } : {});
  assert.throws(() => users.validateUserPinHashes(JSON.stringify([rec('vered', ['staff', 'accountant'])])), /not allowed/);
  assert.throws(() => users.validateUserPinHashes(JSON.stringify([rec('sandra', ['staff', 'accountant'])])), /not allowed/);
  const withRole = users.validateUserPinHashes(JSON.stringify([rec('ortal')]));
  assert.deepEqual([...withRole.byId.ortal.roles], ['controller', 'accountant']);
  const narrowed = users.validateUserPinHashes(JSON.stringify([rec('ortal', ['controller'])]));
  assert.deepEqual([...narrowed.byId.ortal.roles], ['controller']);
  const P = (roles) => users.resolvePrincipal({ id: 'ortal', pinVersion: 1 }, users.validateUserPinHashes(JSON.stringify([rec('ortal', roles)])));
  assert.equal(roleScope.roleAllowed(P(['controller', 'accountant']), 'voidUnpaidClaim'), true);
  assert.equal(roleScope.roleAllowed(P(['controller']), 'voidUnpaidClaim'), false, 'fail-closed without the role');
  assert.equal(roleScope.roleAllowed(null, 'voidUnpaidClaim'), false);
  assert.equal(roleScope.roleAllowed({ auth: 'personal', id: 'sandra', roles: ['approver'] }, 'voidUnpaidClaim'), true);
  assert.equal(roleScope.roleAllowed({ auth: 'personal', id: 'vered', roles: ['staff', 'deleter', 'approver'] }, 'voidUnpaidClaim'), false,
    'approver counts only for Sandra');
  // «הנחה»: Vered and Sandra (finance, by id) — never Ortal, even WITH accountant; never Shiran / Yael.
  const who = (id) => ({ auth: 'personal', id, roles: ['staff'] });
  assert.deepEqual(['vered', 'sandra', 'ortal', 'shiran', 'yael'].map((id) => roleScope.roleAllowed(who(id), 'setBillingDiscount')),
    [true, true, false, false, false]);
  assert.equal(roleScope.roleAllowed(P(['controller', 'accountant']), 'setBillingDiscount'), false, 'Ortal with accountant: no discount');
  assert.equal(roleScope.roleAllowed(P(['controller']), 'setBillingDiscount'), false);
  assert.equal(roleScope.roleAllowed(null, 'setBillingDiscount'), false);
  assert.equal(roleScope.roleAllowed({ auth: 'shared', id: 'vered', roles: ['staff'] }, 'setBillingDiscount'), false, 'a non-personal session holds nothing');
});

test('roles (Code.gs): «הסכום שדווח שגוי - בטל» — Ortal WITH accountant and Sandra allowed; Ortal without it, Vered, Shiran, Yael refused with nothing written', () => {
  for (const [who, expect] of [[ORTAL_NO_ACCT, ROLE_FORBIDDEN], [VERED, ROLE_FORBIDDEN], [SHIRAN, null], [YAEL, null]]) {
    const w = withReceipt();
    const before = w.snapshot();
    const r = w.decide({ ids: [w.id], status: 'not_received', flagNote: NOTE }, who);
    if (expect) assert.deepEqual(r, expect);
    else assert.deepEqual([r.ok, r.error], [false, 'forbidden']);
    assert.equal(w.snapshot(), before, 'nothing written');
  }
  for (const who of [ORTAL, SANDRA]) {
    const w = withReceipt();
    assert.equal(w.decide({ ids: [w.id], status: 'not_received', flagNote: NOTE }, who).ok, true);
  }
});

test('roles (Code.gs): «הנחה» — Vered and Sandra allowed; Ortal (with or without accountant, even with a forged finance cap), Shiran, Yael refused with nothing written', () => {
  const d = { patientId: PKEY, month: '2026-09', discountAmount: 5000, discountReason: 'הסדר מיוחד' };
  const ORTAL_FORGED = () => gsActor('ortal', 'אורטל', ['controller', 'accountant'], ['finance', 'billingControl']);
  for (const who of [ORTAL, ORTAL_NO_ACCT, ORTAL_FORGED, SHIRAN, YAEL]) {
    const w = world();
    const before = w.snapshot();
    const r = w.discount(d, who);
    assert.deepEqual([r.ok, r.error], [false, 'forbidden'], who().proxyUserId);
    assert.equal(w.snapshot(), before, 'nothing written');
  }
  for (const who of [VERED, SANDRA]) {
    const w = world();
    const r = w.discount(d, who);
    assert.equal(r.ok, true, who().proxyUserId);
    assert.equal(w.ovrRows().length, 1);
  }
  // Defense in depth: handle_'s own role gate (roleAllowed_) holds the same rule, apart from the view gates.
  const { g } = world();
  const params = (a) => ({ [g.run('ACTOR_FIELD')]: a });
  const actor = (id, caps) => ({ verified: true, user: id, id, auth: 'personal', roles: [], caps });
  assert.equal(g.sandbox.roleAllowed_(params(actor('vered', ['finance', 'billingControl'])), 'setBillingDiscount'), true);
  assert.equal(g.sandbox.roleAllowed_(params(actor('ortal', ['billingControl'])), 'setBillingDiscount'), false);
  assert.equal(g.sandbox.roleAllowed_({}, 'setBillingDiscount'), false, 'no verified actor, no discount');
});

test('roles (Code.gs): Ortal can never hard-delete a row, void through savePayment, or touch settings — even with a forged deleter / finance', () => {
  const w = withReceipt();
  assert.equal(w.discount({ patientId: PKEY, month: '2026-09', discountAmount: 100, discountReason: 'בדיקה' }).ok, true);
  const ovrId = 'ovr::' + PKEY + '::2026-09';
  const before = w.snapshot();
  const forged = () => gsActor('ortal', 'אורטל', ['controller', 'accountant', 'deleter'], ['finance', 'billingControl']);
  for (const who of [ORTAL, forged]) {
    for (const [action, body] of [
      ['deleteBillingOverride', { override: { id: ovrId } }],
      ['upsertBillingOverride', { override: { patientId: PKEY, month: '2026-09', amount: 1 } }],
      ['removeLead', { lead: { id: 'L1' } }],
      ['deletePatientRow', { patient: { id: 'p1' } }],
      ['deleteDuplicateDischarge', { id: 'd1', reason: 'x' }],
      ['appendFunder', { funder: { patientId: 'p1', funder: 'פרטי', effectiveFrom: TODAY } }],
      ['saveAll', {}],
      ['savePayment', { payment: Object.assign({}, w.row(w.id), { status: 'void', linkStatus: 'not_received', linkNote: NOTE }) }],
    ]) {
      assert.deepEqual(w.call(Object.assign({ action }, body), who), FORBIDDEN, action);
    }
  }
  assert.equal(w.snapshot(), before, 'nothing written');
});

/* =========================== 2. void rules =========================== */

test('void: a never-paid claim is SOFT-deleted — row kept, void + not_received + reason, who / when stamped, audit, the cycle owed again', () => {
  const w = withReceipt();
  const cycleBefore = w.payRows().find((r) => r.id === CYCLE.id);
  assert.equal(Number(cycleBefore.amountPaid), 10000);
  const rowsBefore = w.payRows().length;
  const r = w.decide({ ids: [w.id], status: 'not_received', flagNote: '  =' + NOTE + '\n' });
  assert.equal(r.ok, true);
  assert.deepEqual(plain(r.voided), [{ id: w.id, status: 'void', linkStatus: 'not_received', linkNote: NOTE }]);
  assert.equal(w.payRows().length, rowsBefore, 'no row removed');
  const rc = w.row(w.id);
  assert.deepEqual([rc.status, rc.linkStatus, rc.linkNote, rc.linkedBy], ['void', 'not_received', NOTE, 'אורטל']);
  assert.ok(String(rc.linkedAt).length >= 10, 'when');
  assert.equal(Number(rc.amountPaid), 10000, 'the reported amount stays as evidence');
  const cyc = w.payRows().find((x) => x.id === CYCLE.id);
  assert.deepEqual([Number(cyc.amountPaid), cyc.status], [0, 'unpaid'], 'the claim no longer pays the cycle');
  const a = w.audits('payment_link_not_received');
  assert.equal(a.length, 1);
  assert.deepEqual([w.details(a[0]).note, w.details(a[0]).by, w.details(a[0]).paymentId], [NOTE, 'אורטל', w.id]);
  // It leaves Ortal's queue (void receipts are not listed).
  assert.ok(!w.queue().receipts.some((x) => x.id === w.id));
  // A retry with the same reason replays — nothing written twice.
  const snap = w.snapshot();
  const again = w.decide({ ids: [w.id], status: 'not_received', flagNote: NOTE });
  assert.equal(again.ok, true);
  assert.equal(again.replayed, true);
  assert.equal(w.snapshot(), snap);
  // A different reason on the voided row → receipt_void, nothing written.
  assert.equal(w.decide({ ids: [w.id], status: 'not_received', flagNote: 'סיבה אחרת' }).error, 'receipt_void');
  assert.equal(w.snapshot(), snap);
});

test('void: «לא שולם» (flagged) may be voided; a CONFIRMED or PARTIAL receipt never — for Ortal, Sandra, and on the savePayment path', () => {
  // flagged → allowed
  let w = withReceipt();
  assert.equal(w.decide({ ids: [w.id], status: 'flagged', flagNote: 'לא הגיע' }).ok, true);
  assert.equal(w.decide({ ids: [w.id], status: 'not_received', flagNote: NOTE }).ok, true);
  // confirmed / partial → refused for everyone, nothing written
  for (const decision of [{ status: 'confirmed' }, { status: 'partial', confirmedAmount: 4000 }]) {
    w = withReceipt();
    assert.equal(w.decide(Object.assign({ ids: [w.id] }, decision)).ok, true);
    const before = w.snapshot();
    for (const who of [ORTAL, SANDRA]) {
      const r = w.decide({ ids: [w.id], status: 'not_received', flagNote: NOTE }, who);
      assert.deepEqual([r.ok, r.error], [false, 'receipt_confirmed'], decision.status);
      assert.match(r.message, /כבר אושר/);
    }
    // Vered (deleter) through savePayment — the same rule, in upsertPayment_.
    const sp = w.call({ action: 'savePayment', payment: Object.assign({}, w.row(w.id), { status: 'void', linkStatus: 'not_received', linkNote: NOTE }) }, VERED);
    assert.deepEqual([sp.ok, sp.error], [false, 'receipt_confirmed']);
    assert.equal(w.snapshot(), before, 'nothing written');
  }
});

test('void: reason 2–120 after cleaning (refused, never cut), ONE receipt, a cycle row is no claim — every refusal writes nothing', () => {
  const w = withReceipt();
  assert.equal(w.reportPay(4000, daysAgo(1)).ok, true);
  const ids = w.queue().receipts.map((r) => r.id);
  const before = w.snapshot();
  for (const note of ['', ' ', 'א', '==', 'א'.repeat(121), null, undefined]) {
    const r = w.decide({ ids: [ids[0]], status: 'not_received', flagNote: note });
    assert.deepEqual([r.ok, r.error], [false, 'not_received_note_invalid'], JSON.stringify(note));
  }
  assert.equal(w.decide({ ids, status: 'not_received', flagNote: NOTE }).error, 'not_received_single');
  // The edges that ARE legal: 2 and 120.
  assert.equal(w.snapshot(), before);
  assert.equal(w.decide({ ids: [ids[0]], status: 'not_received', flagNote: 'אב' }).ok, true);
  assert.equal(w.decide({ ids: [ids[1]], status: 'not_received', flagNote: 'ב'.repeat(120) }).ok, true);
  // A cycle row cannot be voided as a claim (Sandra, savePayment).
  const cyc = w.payRows().find((r) => r.id === CYCLE.id);
  const snap = w.snapshot();
  const r = w.call({ action: 'savePayment', payment: Object.assign({}, cyc, { status: 'void', linkStatus: 'not_received', linkNote: NOTE }) }, SANDRA);
  assert.equal(r.ok, false);
  assert.equal(w.snapshot(), snap);
});

test('void: undo is Sandra\'s alone — Vered and Ortal refused, Sandra un-voids and the claim counts again', () => {
  const w = withReceipt();
  assert.equal(w.decide({ ids: [w.id], status: 'not_received', flagNote: NOTE }).ok, true);
  const undo = () => Object.assign({}, w.row(w.id), { status: 'paid', linkStatus: '', linkNote: '' });
  const before = w.snapshot();
  assert.deepEqual(w.call({ action: 'savePayment', payment: undo() }, ORTAL), FORBIDDEN);
  const v = w.call({ action: 'savePayment', payment: undo() }, VERED);
  assert.deepEqual([v.ok, v.error], [false, 'forbidden_role']);
  assert.equal(w.snapshot(), before);
  const s = w.call({ action: 'savePayment', payment: undo() }, SANDRA);
  assert.equal(s.ok, true, JSON.stringify(s).slice(0, 200));
  assert.notEqual(w.row(w.id).status, 'void');
  assert.equal(Number(w.payRows().find((r) => r.id === CYCLE.id).amountPaid), 10000);
});

/* =========================== 3. discount =========================== */

test('discount: Vered sets it — a BLANK-amount row with the four cells, server-stamped who / when, one audit row with prev / next', () => {
  const w = world();
  const r = w.discount({ patientId: PKEY, month: '2026-09', discountAmount: '5000.50', discountReason: '  הנחת משפחה  ' });
  assert.equal(r.ok, true);
  assert.equal(r.changed, true);
  const rows = w.ovrRows();
  assert.equal(rows.length, 1);
  const o = rows[0];
  assert.deepEqual([o.id, o.patientId, o.month, o.amount, Number(o.discountAmount), o.discountReason, o.discountBy],
    ['ovr::' + PKEY + '::2026-09', PKEY, '2026-09', '', 5000.5, 'הנחת משפחה', 'ורד']);
  assert.ok(String(o.discountAt).length >= 10, 'when (israelTimestamp_)');
  const a = w.audits('billing_discount_set');
  assert.equal(a.length, 1);
  const d = w.details(a[0]);
  assert.deepEqual([d.prev.discountAmount, d.next.discountAmount, d.next.discountReason, d.by], [0, 5000.5, 'הנחת משפחה', 'ורד']);
  // The same value again → no write, no audit.
  const snap = w.snapshot();
  assert.equal(w.discount({ patientId: PKEY, month: '2026-09', discountAmount: 5000.5, discountReason: 'הנחת משפחה' }).changed, false);
  assert.equal(w.snapshot(), snap);
  // 0 clears it (the reason is still required and audited); the row stays.
  assert.equal(w.discount({ patientId: PKEY, month: '2026-09', discountAmount: 0, discountReason: 'בוטלה ההנחה' }).ok, true);
  assert.equal(w.ovrRows().length, 1);
  assert.equal(w.ovrRows()[0].discountAmount, '');
  assert.equal(w.audits('billing_discount_set').length, 2);
});

test('discount: validation — amount, reason, month, patient; formula lead-ins never reach a cell; every refusal writes nothing', () => {
  const w = world();
  const base = { patientId: PKEY, month: '2026-09', discountAmount: 100, discountReason: 'סיבה' };
  const before = w.snapshot();
  const bad = [
    [{ discountAmount: -1 }, 'bad_discount_amount'], [{ discountAmount: 'abc' }, 'bad_discount_amount'],
    [{ discountAmount: 1000000.01 }, 'bad_discount_amount'], [{ discountAmount: 1.234 }, 'bad_discount_amount'],
    [{ discountAmount: '1e3' }, 'bad_discount_amount'], [{ discountAmount: NaN }, 'bad_discount_amount'], [{ discountAmount: null }, 'bad_discount_amount'],
    [{ discountReason: '' }, 'bad_discount_reason'], [{ discountReason: 'א' }, 'bad_discount_reason'],
    [{ discountReason: '=+-@' }, 'bad_discount_reason'], [{ discountReason: 'א'.repeat(121) }, 'bad_discount_reason'], [{ discountReason: 7 }, 'bad_discount_reason'],
    [{ month: '2026-13' }, 'bad_month'], [{ month: '2026-9' }, 'bad_month'], [{ month: '' }, 'bad_month'],
    [{ patientId: '' }, 'bad_discount_patient'], [{ patientId: '=HYPERLINK("x")' }, 'bad_discount_patient'],
    [{ patientId: 'arfoni::דנה כהן' }, 'bad_discount_patient'], [{ patientId: 'arfoni::דנה\nכהן::2026-09-15' }, 'bad_discount_patient'],
    [{ patientId: 'arfoni::אין כזה::2026-09-15' }, 'discount_patient_not_found'],
  ];
  for (const [patch, code] of bad) {
    const r = w.discount(Object.assign({}, base, patch));
    assert.deepEqual([r.ok, r.error], [false, code], JSON.stringify(patch));
    assert.ok(r.message && /[֐-׿]/.test(r.message), 'a Hebrew message');
  }
  assert.equal(w.snapshot(), before, 'nothing written');
  // A formula lead-in is dropped; control characters become spaces.
  assert.equal(w.discount(Object.assign({}, base, { discountReason: '=SUM(A1)\tהנחה' })).ok, true);
  assert.equal(w.ovrRows()[0].discountReason, 'SUM(A1) הנחה');
  // Edges that ARE legal.
  assert.equal(w.discount(Object.assign({}, base, { discountAmount: 1000000, discountReason: 'א'.repeat(120) })).ok, true);
});

test('discount: the amount editor keeps it, and deleting the amount override keeps the row and the discount (never hard-deleted)', () => {
  const w = world();
  assert.equal(w.discount({ patientId: PKEY, month: '2026-09', discountAmount: 3000, discountReason: 'הנחה' }).ok, true);
  const up = w.call({ action: 'upsertBillingOverride', override: { patientId: PKEY, month: '2026-09', amount: 28000 } }, SANDRA);
  assert.equal(up.ok, true);
  let o = w.ovrRows()[0];
  assert.deepEqual([Number(o.amount), Number(o.discountAmount), o.discountReason, o.discountBy], [28000, 3000, 'הנחה', 'ורד']);
  assert.equal(Number(up.override.discountAmount), 3000, 'the answer carries the kept discount');
  const del = w.call({ action: 'deleteBillingOverride', override: { id: 'ovr::' + PKEY + '::2026-09', patientId: PKEY } }, SANDRA);
  assert.equal(del.ok, true);
  assert.equal(del.kept.discountReason, 'הנחה');
  assert.equal(w.ovrRows().length, 1, 'row kept');
  o = w.ovrRows()[0];
  assert.deepEqual([o.amount, Number(o.discountAmount)], ['', 3000]);
  // A row with no discount is still deleted as before.
  w.call({ action: 'upsertBillingOverride', override: { patientId: PKEY, month: '2026-10', amount: 1 } }, SANDRA);
  assert.equal(w.ovrRows().length, 2);
  w.call({ action: 'deleteBillingOverride', override: { id: 'ovr::' + PKEY + '::2026-10', patientId: PKEY } }, SANDRA);
  assert.equal(w.ovrRows().length, 1);
});

/* =========================== 4. math =========================== */

test('math: effective expected = base − discount, never below 0; a settled cycle is untouched; lib = Code.gs on a grid', () => {
  const { g } = world();
  // The rule, by hand.
  assert.deepEqual(CB.cycleState({ agreedPrice: 30000, amountPaid: 0, status: 'unpaid', discountAmount: 5000 }),
    { expected: 25000, source: 'agreed', paid: 0, balance: 25000, status: 'unpaid', discount: 5000 });
  assert.deepEqual(CB.cycleState({ agreedPrice: 30000, overrideAmount: 28000, amountPaid: 20000, stampedAmount: 30000, status: 'partial', discountAmount: 8000 }),
    { expected: 20000, source: 'override', paid: 20000, balance: 0, status: 'paid', discount: 8000 });
  const full = CB.cycleState({ agreedPrice: 30000, amountPaid: 0, status: 'unpaid', discountAmount: 45000 });
  assert.deepEqual([full.expected, full.balance, full.status, full.discount], [0, 0, 'paid', 30000], 'never below 0; never debt');
  const settled = CB.cycleState({ stampedAmount: 30000, amountPaid: 30000, agreedPrice: 30000, status: 'paid', discountAmount: 5000 });
  assert.deepEqual([settled.expected, settled.balance, settled.status, settled.discount, settled.underStamped], [30000, 0, 'paid', undefined, undefined]);
  // Under-stamped is judged net of the discount.
  const stampedAtDiscount = CB.cycleState({ stampedAmount: 25000, amountPaid: 25000, agreedPrice: 30000, status: 'paid', discountAmount: 5000 });
  assert.equal(stampedAtDiscount.underStamped, undefined);
  assert.equal(CB.cycleState({ stampedAmount: 25000, amountPaid: 25000, agreedPrice: 30000, status: 'paid' }).underStamped, true);
  // Parity with Code.gs over a grid.
  for (const stamped of [null, 0, 25000, 30000])
    for (const paid of [0, 10000, 25000, 30000])
      for (const override of [null, 28000])
        for (const disc of [null, '', 0, 5000, 40000])
          for (const status of ['unpaid', 'partial', 'paid', 'void']) {
            const o = { stampedAmount: stamped, amountPaid: paid, overrideAmount: override, agreedPrice: 30000, status, discountAmount: disc };
            assert.deepEqual(plain(g.sandbox.cycleBalanceState_(o)), plain(CB.cycleState(o)), JSON.stringify(o));
          }
});

test('debt: a discount reduces the recorded and the unrecorded debt; a fully discounted cycle is never debt', () => {
  const w = withReceipt();
  const cyc = (a, start) => (a.byPatient[0] ? a.byPatient[0].cycles : []).find((c) => c.start === start);
  let a = w.aging();
  assert.equal(cyc(a, '2026-09-15').balance, 20000);
  assert.equal(cyc(a, '2026-10-15').balance, 30000);
  assert.equal(cyc(a, '2026-09-15').month, '2026-09');
  assert.equal(a.byPatient[0].patientKey, PKEY, 'the key the discount is set on');
  const totalBefore = a.totals.recorded_debt.total + a.totals.unrecorded_cycles.total;
  assert.equal(w.discount({ patientId: PKEY, month: '2026-09', discountAmount: 5000, discountReason: 'הנחה' }).ok, true);
  assert.equal(w.discount({ patientId: PKEY, month: '2026-10', discountAmount: 30000, discountReason: 'פטור' }).ok, true);
  a = w.aging();
  assert.deepEqual([cyc(a, '2026-09-15').expected, cyc(a, '2026-09-15').balance, cyc(a, '2026-09-15').discount], [25000, 15000, 5000]);
  assert.equal(cyc(a, '2026-10-15'), undefined, 'fully discounted: not debt');
  assert.equal(a.totals.recorded_debt.total + a.totals.unrecorded_cycles.total, totalBefore - 5000 - 30000);
});

/* The real app.js in a vm (the billing-control-tab.test.js pattern). */
const ROOT = path.join(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const LIB_SRCS = ['payment-report-rules.js', 'billing-control-rules.js', 'cycle-balance.js']
  .map((f) => fs.readFileSync(path.join(ROOT, 'lib', f), 'utf8'));
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
  for (const src of LIB_SRCS) vm.runInContext(src, sandbox);
  vm.runInContext(APP_SRC + `
    globalThis.__test = {
      normalizePayment, normalizeReceipt, normalizeBillingOverride, buildMonthlyRevenue,
      billingOverrideFor, billingDiscountFor, applyBillingOverride, cycleView,
    };`, sandbox);
  return sandbox.__test;
}

test('revenue: a discount moves no money — «נגבה» and «מאומת» are identical with and without it (real Code.gs → app.js)', () => {
  const w = withReceipt();
  assert.equal(w.decide({ ids: [w.id], status: 'confirmed' }).ok, true);
  const app = loadApp();
  const model = (month) => {
    const pr = w.call({ action: 'getPayments' }, SANDRA);
    const d = w.call({ action: 'getData' }, SANDRA);
    return app.buildMonthlyRevenue({
      month, patients: [], payments: pr.payments.map(app.normalizePayment), credits: [],
      overrides: (d.billingOverrides || []).map(app.normalizeBillingOverride),
      receipts: pr.receipts.map(app.normalizeReceipt), today: TODAY,
    });
  };
  const before = { sep: model('2026-09'), oct: model('2026-10') };
  const paymentsBefore = JSON.stringify(w.call({ action: 'getPayments' }, SANDRA).payments);
  assert.equal(w.discount({ patientId: PKEY, month: '2026-09', discountAmount: 5000, discountReason: 'הנחה' }).ok, true);
  const after = { sep: model('2026-09'), oct: model('2026-10') };
  for (const m of ['sep', 'oct']) {
    assert.equal(after[m].received.inclVat, before[m].received.inclVat, m + ' «נגבה»');
    assert.equal(after[m].verified.inclVat, before[m].verified.inclVat, m + ' «מאומת»');
  }
  assert.ok(before.sep.received.inclVat > 0);
  assert.equal(JSON.stringify(w.call({ action: 'getPayments' }, SANDRA).payments), paymentsBefore, 'no Payments cell moved');
});

test('app.js: a blank-amount row is no override; the discount applies on top of the base, never below 0; cycleView carries it', () => {
  const app = loadApp();
  const ovrs = [
    app.normalizeBillingOverride({ id: 'o1', patientId: 'k', month: '2026-09', amount: '', discountAmount: '5000', discountReason: 'r', discountBy: 'אורטל', discountAt: 't' }),
    app.normalizeBillingOverride({ id: 'o2', patientId: 'k', month: '2026-10', amount: '28000', discountAmount: '' }),
  ];
  assert.equal(app.billingOverrideFor(ovrs, 'k', '2026-09'), null, 'discount-only row: no override');
  assert.equal(app.billingOverrideFor(ovrs, 'k', '2026-10').amount, 28000);
  assert.deepEqual(plain(app.billingDiscountFor(ovrs, 'k', '2026-09')), { amount: 5000, reason: 'r', by: 'אורטל', at: 't' });
  assert.equal(app.billingDiscountFor(ovrs, 'k', '2026-10'), null);
  const unpaid = { patientId: 'k', dueDate: '2026-09-15', amount: 30000, amountPaid: 0, status: 'unpaid' };
  assert.deepEqual([app.applyBillingOverride(unpaid, ovrs).amount, app.applyBillingOverride(unpaid, ovrs).discount], [25000, 5000]);
  const big = [app.normalizeBillingOverride({ patientId: 'k', month: '2026-09', amount: '', discountAmount: '99999' })];
  assert.equal(app.applyBillingOverride(unpaid, big).amount, 0);
  const paid = { ...unpaid, amountPaid: 30000, status: 'paid' };
  assert.equal(app.applyBillingOverride(paid, ovrs), paid, 'history untouched');
  const v = app.cycleView({ ...unpaid, amountPaid: 25000, status: 'partial' }, { pay: 30000 }, ovrs);
  assert.deepEqual([v.amount, v.balance, v.status, v.discount], [25000, 0, 'paid', 5000]);
});

/* ======================= 5. append-only guard ======================= */

test('append-only: BillingOverrides keeps its first six columns and appends the four discount columns; link statuses and roles only append', () => {
  const { g } = world();
  const cols = arr(g.run('BILLING_OVERRIDE_COLUMNS'));
  assert.deepEqual(cols.slice(0, 6), ['id', 'patientId', 'month', 'amount', 'created', 'updatedBy']);
  assert.deepEqual(cols.slice(6), ['discountAmount', 'discountReason', 'discountBy', 'discountAt']);
  assert.deepEqual(arr(g.run('BILLING_DISCOUNT_COLUMNS')), cols.slice(6));
  assert.deepEqual(arr(g.run('PAYMENT_LINK_STATUSES')), ['linked', 'not_a_patient', 'duplicate', 'not_received']);
  assert.deepEqual([...users.ROLES], ['staff', 'reporter', 'deleter', 'approver', 'viewer', 'controller', 'accountant']);
  assert.deepEqual([...scope.CONTROLLER_OVERRIDE_FIELDS].slice(-4), cols.slice(6));
  assert.deepEqual(arr(g.run('CONTROLLER_OVERRIDE_FIELDS')), [...scope.CONTROLLER_OVERRIDE_FIELDS]);
  assert.ok(scope.FINANCE_ACTIONS.includes('setBillingDiscount'));
  assert.ok(!scope.CONTROLLER_ACTIONS.includes('setBillingDiscount'), 'Ortal\'s view no longer reaches the discount');
  assert.ok(!arr(g.run('CONTROLLER_ACTIONS')).includes('setBillingDiscount'), 'nor does Code.gs');
  assert.ok(arr(g.run('PROXY_KNOWN_ACTIONS')).includes('setBillingDiscount'));
  // An existing 6-column sheet: the header is extended, existing rows untouched.
  g.sandbox.__sheets.BillingOverrides = richSheet('BillingOverrides', cols.slice(0, 6));
  g.sandbox.__sheets.BillingOverrides.appendRow(['ovr::x::2026-01', 'x', '2026-01', '100', '2026-01-01', 'ורד']);
  const pcols = arr(g.run('PATIENT_COLUMNS'));
  g.sandbox.__sheets.Patients = richSheet('Patients', pcols);
  g.sandbox.__sheets.Patients.appendRow(pcols.map((c) => ({ id: 'p1', houseId: 'arfoni', name: 'דנה כהן', date: '2026-09-15', pay: 30000, status: 'active' }[c] || '')));
  const r = plain(g.post(Object.assign({ action: 'setBillingDiscount', discount: { patientId: PKEY, month: '2026-09', discountAmount: 10, discountReason: 'בדיקה' } }, VERED())));
  assert.equal(r.ok, true);
  const grid = g.sandbox.__sheets.BillingOverrides.grid;
  assert.deepEqual(grid[0], cols);
  assert.deepEqual(grid[1].slice(0, 6), ['ovr::x::2026-01', 'x', '2026-01', '100', '2026-01-01', 'ורד']);
  // A hand-added column where a discount column belongs → refused, nothing written.
  grid[0][6] = 'עמודה ידנית';
  const snap = JSON.stringify(grid);
  assert.equal(plain(g.post(Object.assign({ action: 'setBillingDiscount', discount: { patientId: PKEY, month: '2026-10', discountAmount: 10, discountReason: 'בדיקה' } }, VERED()))).error, 'sheet_header_clash');
  assert.equal(JSON.stringify(grid), snap);
});

/* ======================================================================
 * server.js
 * ==================================================================== */

const ENV_KEYS = ['PROXY_SECRET', 'SESSION_SECRET', 'SHEETS_URL', 'APP_PIN', 'USER_PIN_HASHES', 'PIN_PEPPER',
  'BOOTSTRAP_TOKEN', 'TRUST_PROXY_HOPS', 'MEETING_REPORT_PIN', 'MEETING_REPORT_SECRET', 'APP_PIN_UNTIL', 'HEALTHCHECK_TOKEN'];
const NAMES = { vered: 'ורד', sandra: 'סנדרה', shiran: 'שירן', yael: 'יעל', ortal: 'אורטל' };
const personal = (id) => 'ezone_session=' + createSessionToken(SESSION_SECRET, undefined, undefined, NAMES[id], { id, pinVersion: 1 });

let _hash;
async function records(ortalRoles) {
  if (!_hash) _hash = await pinHash.hashPin('583920', PEPPER);
  return ['vered', 'sandra', 'shiran', 'yael', 'ortal'].map((id) =>
    JSON.parse(users.recordLine(id, _hash, 1, id === 'ortal' && ortalRoles ? ortalRoles : undefined)));
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

function stubHttps() {
  const calls = [];
  const original = https.request;
  https.request = (url, opts, cb) => {
    const req = new EventEmitter();
    let body = '';
    req.write = (c) => { body += c; };
    req.end = () => {
      calls.push(JSON.parse(body || '{}'));
      const res = new EventEmitter();
      res.statusCode = 200; res.headers = {}; res.setEncoding = () => {}; res.resume = () => {};
      setImmediate(() => { cb(res); res.emit('data', JSON.stringify({ ok: true })); res.emit('end'); });
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
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_) { json = null; }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function withServer(ortalRoles, fn) {
  const mod = freshServer({ PROXY_SECRET, SESSION_SECRET, SHEETS_URL, PIN_PEPPER: PEPPER, USER_PIN_HASHES: JSON.stringify(await records(ortalRoles)) });
  const logs = [];
  const orig = console.warn;
  console.warn = (...a) => logs.push(a.map(String).join(' '));
  const srv = await new Promise((resolve) => { const s = mod.app.listen(0, '127.0.0.1', () => resolve(s)); });
  try { return await fn(srv.address().port, logs); } finally { srv.close(); console.warn = orig; }
}

const DISCOUNT_BODY = { action: 'setBillingDiscount', discount: { patientId: PKEY, month: '2026-09', discountAmount: 100, discountReason: 'סיבה' } };
const VOID_BODY = { action: 'confirmPayment', confirm: { ids: ['rcpt-1'], status: 'not_received', flagNote: NOTE } };

test('server: the void — Vered and an Ortal record WITHOUT accountant get 403 forbidden_role; the discount — Ortal (with or without accountant) and Shiran get 403; nothing is proxied; logged with id + operation only', async () => {
  for (const [ortalRoles, voidIds, discountIds] of [[undefined, ['vered'], ['ortal', 'shiran']], [['controller'], ['ortal', 'vered'], ['ortal', 'shiran']]]) {
    const stub = stubHttps();
    try {
      await withServer(ortalRoles, async (port, logs) => {
        for (const id of voidIds) {
          const r = await request(port, 'POST', '/api/sheets', { cookie: personal(id), body: VOID_BODY });
          assert.equal(r.status, 403, id + ' void');
          assert.deepEqual(r.json, ROLE_FORBIDDEN);
        }
        for (const id of discountIds) {
          const r = await request(port, 'POST', '/api/sheets', { cookie: personal(id), body: DISCOUNT_BODY });
          assert.equal(r.status, 403, id + ' discount');
          assert.equal(r.json.ok, false);
        }
        assert.equal(stub.calls.length, 0, 'nothing proxied');
        const roleLogs = logs.filter((l) => l.includes('[role] 403'));
        assert.ok(roleLogs.length >= voidIds.length);
        for (const l of roleLogs) {
          assert.match(l, /op=voidUnpaidClaim needs=accountant\|approver/);
          assert.ok(!l.includes('סיבה') && !l.includes('דנה') && !l.includes(NOTE), l);
        }
      });
    } finally { stub.restore(); }
  }
});

test('server: the void — Ortal WITH accountant and Sandra; the discount — Vered and Sandra — are proxied, roles from the session only; /api/me canAccount / canDiscount', async () => {
  const stub = stubHttps();
  try {
    await withServer(undefined, async (port) => {
      const plan = [['ortal', VOID_BODY], ['sandra', VOID_BODY], ['vered', DISCOUNT_BODY], ['sandra', DISCOUNT_BODY]];
      for (const [id, body] of plan) {
        const forged = Object.assign({}, body, { proxyRoles: ['approver'], proxyUserId: 'sandra' });
        const r = await request(port, 'POST', '/api/sheets', { cookie: personal(id), body: forged });
        assert.equal(r.status, 200, id + ' ' + body.action);
      }
      assert.equal(stub.calls.length, 4);
      assert.deepEqual(stub.calls.map((c) => c.proxyUserId), ['ortal', 'sandra', 'vered', 'sandra'], 'never the forged id');
      assert.deepEqual(stub.calls[0].proxyRoles, ['controller', 'accountant']);
      const me = async (id) => (await request(port, 'GET', '/api/me', { cookie: personal(id) })).json;
      const flags = async (id) => { const j = await me(id); return [j.canAccount, j.canDiscount]; };
      assert.deepEqual(await flags('ortal'), [true, false], 'Ortal: cancel yes, discount no');
      assert.deepEqual(await flags('sandra'), [true, true]);
      assert.deepEqual(await flags('vered'), [false, true], 'Vered: discount yes, cancel no');
      assert.deepEqual(await flags('shiran'), [false, false]);
    });
    await withServer(['controller'], async (port) => {
      const j = (await request(port, 'GET', '/api/me', { cookie: personal('ortal') })).json;
      assert.deepEqual([j.canAccount, j.canDiscount], [false, false], 'fail-closed');
    });
  } finally { stub.restore(); }
});
