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
]);

const APPROVER_ACTIONS = Object.freeze([
  'unvoidPayment', 'approveRefundException', 'writeOffOpeningBalance', 'acceptOpeningBalance',
]);

/* «בקרת גבייה» (Phase 4): Ortal's decision on a receipt needs the
 * `controller` role OR Sandra's `approver`. Code.gs makes the same decision
 * in handle_ (confirmPayment) and refuses Vered there too. */
const CONFIRM_ACTIONS = Object.freeze(['confirmPayment']);

const APPROVER_ID = 'sandra';

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
  if (CONFIRM_ACTIONS.indexOf(act) >= 0) return act;
  const p = params && typeof params === 'object' ? params : {};
  if (act === 'savePayment' || act === 'updatePayment') {
    const pay = parseJson(p.payment);
    if (pay && isVoidStatus(pay.status)) return 'voidPayment';
  }
  if (act === 'saveCredit') {
    const credit = parseJson(p.credit);
    if (credit && String(credit.status || '').trim().toLowerCase() === 'cancelled') return 'cancelCredit';
  }
  return '';
}

/* 'deleter' | 'approver' | 'controller|approver' | '' */
function requiredRoleFor(operation) {
  if (DELETE_ACTIONS.indexOf(operation) >= 0) return 'deleter';
  if (APPROVER_ACTIONS.indexOf(operation) >= 0) return 'approver';
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

/* Whether `principal` may perform `operation`. Pure. */
function roleAllowed(principal, operation) {
  const need = requiredRoleFor(operation);
  if (need === '') return true;
  return need.split('|').some((r) => principalHasRole(principal, r));
}

module.exports = {
  DELETE_ACTIONS,
  APPROVER_ACTIONS,
  CONFIRM_ACTIONS,
  ROLE_FORBIDDEN_MESSAGE,
  roleOperationFor,
  requiredRoleFor,
  principalHasRole,
  roleAllowed,
};
