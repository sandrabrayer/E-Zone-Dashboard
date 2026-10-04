'use strict';

/* What the `finance` capability guards (restricted view, Sandra 2026-10-03).
 * See CHANGELOG-restricted-view.md for the full tab → action map.
 *
 * Every Apps Script action whose data or write belongs to the four money tabs
 * (גבייה, הכנסות חודשיות, שיוך תשלומים, גרף צמיחה) or to a billing widget
 * elsewhere. A session without `finance` gets 403 from server.js for each of
 * them, and Code.gs refuses them too (FINANCE_ACTIONS there — a guard test
 * pins the two lists equal).
 *
 *   getPayments            — every money tab, the dashboard renewal/overdue widgets
 *   savePayment / updatePayment — גבייה rows, renewals, coverage period,
 *                            שיוך תשלומים linking / duplicate void / un-void
 *   upsertBillingOverride / deleteBillingOverride — גבייה «סכום חודשי»
 *   getCredits / saveCredit / suggestRefunds — the credits modal (discharge
 *                            flow, מטופלים משוחררים «זיכויים»), גבייה payouts,
 *                            הכנסות חודשיות
 *   refundPayoutForecast   — גבייה «זיכויים ממתינים לתשלום» + its .xlsx
 *   debtAging              — גבייה «חובות פתוחים» + its .xlsx
 *   cleanupReport          — גבייה «ייצוא רשימת תיקונים» (.xlsx only)
 *   accountingPayments / accountingCredits — the accounting feed (own secret;
 *                            no dashboard UI, blocked for completeness)
 *   reportPayment          — גבייה «דווח תשלום» (Phase 3 PR 2: one receipt row
 *                            per money received)
 *   appendFunder           — the patient card's funder editor (finance only)
 *
 * Append-only: a new billing action must be added here AND in Code.gs. */
const FINANCE_ACTIONS = Object.freeze([
  'getPayments',
  'savePayment',
  'updatePayment',
  'upsertBillingOverride',
  'deleteBillingOverride',
  'getCredits',
  'saveCredit',
  'suggestRefunds',
  'refundPayoutForecast',
  'debtAging',
  'cleanupReport',
  'accountingPayments',
  'accountingCredits',
  'reportPayment',
  'appendFunder',
]);

/* Express routes that serve billing data directly (not via /api/sheets). The
 * debug stores hold the last request/response previews — which can be a
 * getPayments answer loaded by Sandra — so they are finance-only too. */
const FINANCE_ROUTES = Object.freeze([
  '/api/export/refund-forecast.xlsx',
  '/api/export/debt-aging.xlsx',
  '/api/export/cleanup.xlsx',
  '/api/debug/last-save',
  '/api/debug/last-load',
]);

/* ===== «בקרת גבייה» (Phase 4, Sandra 2026-10-04) =====
 *
 * BILLING_CONTROL_ACTIONS need the `billingControl` capability (Vered, Sandra,
 * Ortal — lib/users.js); Shiran and Yael get 403. Neither is open: both are
 * PROXY_SECRET-gated in Code.gs like every non-OPEN action.
 *
 *   billingControlQueue — the tab's data (READ-ONLY): every receipt with its
 *                         confirm status, the counts, «חובות מעל 60 יום», and
 *                         (approver only) Sandra's «חריגים פתוחים»
 *   confirmPayment      — Ortal's decision per receipt (confirmed / flagged /
 *                         back to reported). Also needs the controller or
 *                         approver ROLE (Code.gs refuses Vered: forbidden_role)
 *
 * CONTROLLER_ACTIONS / CONTROLLER_ROUTES are the EXACT allow-list of the
 * controller view (Ortal): any other /api/sheets action and any other /api/
 * route → 403. debtAging rides along only because the «חובות פתוחים» export
 * the tab links to reads it. Code.gs holds the same lists (guard test). */
const BILLING_CONTROL_ACTIONS = Object.freeze(['billingControlQueue', 'confirmPayment']);
const CONTROLLER_ACTIONS = Object.freeze(['billingControlQueue', 'confirmPayment', 'debtAging']);
const BILLING_CONTROL_ROUTES = Object.freeze(['/api/export/billing-control.xlsx']);
/* Every /api/ path a controller session may reach. Session plumbing first,
 * then the two exports. /api/sheets is further limited to CONTROLLER_ACTIONS. */
const CONTROLLER_ROUTES = Object.freeze([
  '/api/me', '/api/logout', '/api/verify-pin', '/api/login-users', '/api/sheets',
  '/api/export/billing-control.xlsx', '/api/export/debt-aging.xlsx',
]);
const BILLING_CONTROL_FORBIDDEN_MESSAGE = 'אין הרשאה לפעולה זו';

function isBillingControlAction(action) {
  return typeof action === 'string' && BILLING_CONTROL_ACTIONS.indexOf(action) >= 0;
}

function isControllerAction(action) {
  return typeof action === 'string' && CONTROLLER_ACTIONS.indexOf(action) >= 0;
}

/* Whether a controller session may reach `path` (an Express req.path). The
 * meeting-report micro-app has its own cookie and its own lock, so its
 * routes are not this lock's business. */
function isControllerRoute(path) {
  const p = String(path || '');
  if (p.indexOf('/api/') !== 0) return true;
  if (p.indexOf('/api/meeting-report/') === 0) return true;
  return CONTROLLER_ROUTES.indexOf(p) >= 0;
}

/* getData keys that only billing uses. Omitted for a restricted session
 * (no visible tab reads them); always present for a full-view session. */
const GETDATA_FINANCE_KEYS = Object.freeze(['billingOverrides']);

const FINANCE_FORBIDDEN_MESSAGE = 'אין הרשאה לצפות בנתוני גבייה';

function isFinanceAction(action) {
  return typeof action === 'string' && FINANCE_ACTIONS.indexOf(action) >= 0;
}

/* A shallow copy of a getData response without the billing-only keys. */
function stripFinanceKeys(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const out = Object.assign({}, data);
  GETDATA_FINANCE_KEYS.forEach((k) => { delete out[k]; });
  return out;
}

module.exports = {
  BILLING_CONTROL_ACTIONS,
  CONTROLLER_ACTIONS,
  BILLING_CONTROL_ROUTES,
  CONTROLLER_ROUTES,
  BILLING_CONTROL_FORBIDDEN_MESSAGE,
  isBillingControlAction,
  isControllerAction,
  isControllerRoute,
  FINANCE_ACTIONS,
  FINANCE_ROUTES,
  GETDATA_FINANCE_KEYS,
  FINANCE_FORBIDDEN_MESSAGE,
  isFinanceAction,
  stripFinanceKeys,
};
