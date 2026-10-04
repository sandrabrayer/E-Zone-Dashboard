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
 *   setPatientFunder       — the patient funder (גורם מממן) write; FunderHistory
 *                            feeds debt-by-funder on גבייה
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
  'setPatientFunder',
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

/* getData keys that only billing uses. Omitted for a restricted session
 * (no visible tab reads them); always present for a full-view session. */
const GETDATA_FINANCE_KEYS = Object.freeze(['billingOverrides', 'funderHistory']);

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
  FINANCE_ACTIONS,
  FINANCE_ROUTES,
  GETDATA_FINANCE_KEYS,
  FINANCE_FORBIDDEN_MESSAGE,
  isFinanceAction,
  stripFinanceKeys,
};
