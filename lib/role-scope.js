'use strict';

/* Role enforcement — the server-side mirror of Code.gs (personal PINs PR C,
 * 2026-10-04; plan §11.5 decisions 3 and 4).
 *
 * Code.gs is the authority: handle_ refuses every DELETE_ACTIONS operation
 * without `deleter` and every APPROVER_ACTIONS operation without `approver`
 * (Sandra's personal session only). server.js makes the same decision FIRST,
 * before anything is proxied (defense in depth), from the signed session
 * cookie only. The lists below are pinned equal to Code.gs by a guard test
 * (test/personal-pins-cleanup.test.js).
 *
 * The one operation this side cannot see is the un-void (unvoidPayment): it
 * is a savePayment whose payload is not void while the STORED row is, so only
 * Code.gs (which reads the row) can decide it. */

const DELETE_ACTIONS = Object.freeze([
  'removeLead', 'deletePatientRow', 'deleteBillingOverride', 'deleteMeetingReport',
  'voidPayment', 'cancelCredit',
  // «מחק כפילות» on a duplicate discharge row (CHANGELOG-duplicate-discharges.md).
  'deleteDuplicateDischarge',
]);

const APPROVER_ACTIONS = Object.freeze([
  'unvoidPayment', 'approveRefundException', 'writeOffOpeningBalance', 'acceptOpeningBalance',
]);

/* «בקרת גבייה» (Phase 4): Ortal's decision on a receipt needs the
 * `controller` role OR Sandra's `approver`. Code.gs makes the same decision
 * in handle_ (confirmPayment) and refuses Vered there too. */
const CONFIRM_ACTIONS = Object.freeze(['confirmPayment']);

/* Ortal's billing fix (CHANGELOG-ortal-billing-discounts.md): the
 * `accountant` role OR Sandra's `approver`. Pinned equal to Code.gs
 * ACCOUNTANT_ACTIONS by a guard test.
 *   voidUnpaidClaim    — confirmPayment status 'not_received' («הסכום שדווח
 *                        שגוי - בטל»): soft-voids ONE unconfirmed receipt
 * Discounts are NOT here any more (CHANGELOG-discount-by-vered.md): Vered
 * decides them. */
const ACCOUNTANT_ACTIONS = Object.freeze(['voidUnpaidClaim']);

/* «הנחה» (CHANGELOG-discount-by-vered.md): a discount on one cycle
 * (BillingOverrides) is Vered's and Sandra's decision — the `finance`
 * capability, decided by STABLE USER ID (lib/users.js FINANCE_USER_IDS), so no
 * USER_PIN_HASHES record needs to change and a record can never grant it.
 * Ortal (controller view, never finance) is refused. Pinned equal to Code.gs
 * DISCOUNT_ACTIONS by a guard test. */
const DISCOUNT_ACTIONS = Object.freeze(['setBillingDiscount']);
const DISCOUNT_REQUIRED = 'finance';
/* A cycle's amount («שנה סכום», CHANGELOG-open-debts-cleanup.md): `finance`
 * (Vered, Sandra) OR the accountant (Ortal) OR Sandra's approver. Pinned equal
 * to Code.gs AMOUNT_ACTIONS by a guard test. */
const AMOUNT_ACTIONS = Object.freeze(['upsertBillingOverride']);
const AMOUNT_REQUIRED = 'finance|accountant|approver';
const NOT_RECEIVED_DECISION = 'not_received';

const APPROVER_ID = 'sandra';
const { FINANCE_USER_IDS } = require('./users');

const ROLE_FORBIDDEN_MESSAGE = 'אין הרשאה לפעולה זו';

function parseJson(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch (_) { return null; }
}

/* Same rule as Code.gs isVoidStatus_: 'void' (any case, trimmed). */
function isVoidStatus(s) {
  return String(s == null ? '' : s).trim().toLowerCase() === 'void';
}

/* The role-checked operation a request performs (a DELETE_ACTIONS /
 * APPROVER_ACTIONS name), or '' for an ordinary one. Mirrors Code.gs
 * roleOperationFor_. Pure. */
function roleOperationFor(action, params) {
  const act = String(action == null ? '' : action);
  if (DELETE_ACTIONS.indexOf(act) >= 0 || APPROVER_ACTIONS.indexOf(act) >= 0) return act;
  if (ACCOUNTANT_ACTIONS.indexOf(act) >= 0 || DISCOUNT_ACTIONS.indexOf(act) >= 0 || AMOUNT_ACTIONS.indexOf(act) >= 0) return act;
  const p = params && typeof params === 'object' ? params : {};
  if (act === 'confirmPayment') {
    const c = parseJson(p.confirm);
    if (c && String(c.status == null ? '' : c.status).trim() === NOT_RECEIVED_DECISION) return 'voidUnpaidClaim';
  }
  if (CONFIRM_ACTIONS.indexOf(act) >= 0) return act;
  if (act === 'savePayment' || act === 'updatePayment') {
    const pay = parseJson(p.payment);
    if (pay && isVoidStatus(pay.status)) return 'voidPayment';
  }
  if (act === 'saveCredit') {
    const credit = parseJson(p.credit);
    if (credit && String(credit.status || '').trim().toLowerCase() === 'cancelled') return 'cancelCredit';
    if (credit && creditCreateNeedsApprover(credit)) return 'approveRefundException';
  }
  return '';
}

/* A saveCredit CREATE (no id) of a MANUAL credit ('other') — Sandra only.
 * Every other create / amount edit needs the policy figure, which only
 * Code.gs (upsertCredit_) recalculates from the sheets: a policy-matching
 * amount needs no approval, anything else needs Sandra
 * (CHANGELOG-refunds-auto-policy.md). Mirrors Code.gs
 * creditCreateNeedsApprover_. Pure. */
function creditCreateNeedsApprover(credit) {
  return !!credit && typeof credit === 'object' && String(credit.id == null ? '' : credit.id).trim() === '' &&
    String(credit.creditType == null ? '' : credit.creditType).trim() === 'other';
}

/* 'deleter' | 'approver' | 'controller|approver' | 'accountant|approver' |
 * 'finance' | '' */
function requiredRoleFor(operation) {
  if (DELETE_ACTIONS.indexOf(operation) >= 0) return 'deleter';
  if (APPROVER_ACTIONS.indexOf(operation) >= 0) return 'approver';
  if (ACCOUNTANT_ACTIONS.indexOf(operation) >= 0) return 'accountant|approver';
  if (DISCOUNT_ACTIONS.indexOf(operation) >= 0) return DISCOUNT_REQUIRED;
  if (AMOUNT_ACTIONS.indexOf(operation) >= 0) return AMOUNT_REQUIRED;
  if (CONFIRM_ACTIONS.indexOf(operation) >= 0) return 'controller|approver';
  return '';
}

/* Whether a RESOLVED principal (lib/users.js resolvePrincipal) holds `role`.
 * Only a personal session holds any role; approver additionally requires
 * Sandra's id. Pure. */
function principalHasRole(principal, role) {
  if (!principal || principal.auth !== 'personal' || !Array.isArray(principal.roles)) return false;
  if (principal.roles.indexOf(role) < 0) return false;
  if (role === 'approver' && principal.id !== APPROVER_ID) return false;
  return true;
}

/* Whether a RESOLVED principal holds the `finance` capability (Vered, Sandra —
 * by stable id on a personal session, never by the record's roles). Pure. */
function principalHasFinance(principal) {
  return !!principal && principal.auth === 'personal' && FINANCE_USER_IDS.indexOf(principal.id) >= 0;
}

/* Whether `principal` may perform `operation`. Pure. */
function roleAllowed(principal, operation) {
  const need = requiredRoleFor(operation);
  if (need === '') return true;
  return need.split('|').some((r) => (r === 'finance' ? principalHasFinance(principal) : principalHasRole(principal, r)));
}

/* Expected discharges (Task F, CHANGELOG-dashboard-expected-discharges.md;
 * widened by CHANGELOG-expected-discharges-all-users.md): the read-only
 * action behind the dashboard card «שחרורים צפויים». CEO decision
 * (15 Oct 2026): EVERY user who can log in may read it — no per-person
 * allow-list and no role check. A resolved personal session is still
 * required (no session → 401 at requireSession; anything that is not a
 * personal session → 403 here). Code.gs (expectedDischargesRefused_) makes
 * the same decision again. Pure. */
const EXPECTED_DISCHARGES_ACTION = 'expectedDischarges';
function canViewExpectedDischarges(principal) {
  return !!principal && typeof principal === 'object' && principal.auth === 'personal'
    && typeof principal.id === 'string' && principal.id !== '';
}

/* Upcoming committees «ועדות קרובות» (CHANGELOG-dashboard-committees.md):
 * the same read-only rule — every user with a personal session. Code.gs
 * refuses the same again (expectedDischargesRefused_). */
const UPCOMING_COMMITTEES_ACTION = 'upcomingCommittees';
/* The read-only manager feeds every personal session may read. */
const ALL_USERS_READ_ACTIONS = Object.freeze([EXPECTED_DISCHARGES_ACTION, UPCOMING_COMMITTEES_ACTION]);

module.exports = {
  EXPECTED_DISCHARGES_ACTION,
  UPCOMING_COMMITTEES_ACTION,
  ALL_USERS_READ_ACTIONS,
  canViewExpectedDischarges,
  DELETE_ACTIONS,
  APPROVER_ACTIONS,
  CONFIRM_ACTIONS,
  ACCOUNTANT_ACTIONS,
  DISCOUNT_ACTIONS,
  DISCOUNT_REQUIRED,
  AMOUNT_ACTIONS,
  AMOUNT_REQUIRED,
  principalHasFinance,
  NOT_RECEIVED_DECISION,
  ROLE_FORBIDDEN_MESSAGE,
  roleOperationFor,
  creditCreateNeedsApprover,
  requiredRoleFor,
  principalHasRole,
  roleAllowed,
};
