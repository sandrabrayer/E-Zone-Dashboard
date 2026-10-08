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
 *   editReceipt            — גבייה ✏️ on a receipt: its non-money fields only
 *                            (CHANGELOG-receipt-duplicates-and-edit.md)
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
  'editReceipt',
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
 * the tab links to reads it. Code.gs holds the same lists (guard test).
 *
 * READ access to the full «גבייה» tab (Sandra 2026-10-06,
 * CHANGELOG-ortal-billing-access.md): CONTROLLER_BILLING_READ_ACTIONS are the
 * tab's READS — getData (answered with CONTROLLER_GETDATA_KEYS only: patients
 * and the monthly overrides, no lead and no discharge record), the payments,
 * the credits, the refund forecast, debt aging and the fix list — plus their
 * two exports. Every write of the tab (savePayment, updatePayment,
 * reportPayment, upsert/deleteBillingOverride, saveCredit, suggestRefunds,
 * appendFunder) is NOT on the list, so it stays 403 — no delete, no void,
 * no approval. */
const BILLING_CONTROL_ACTIONS = Object.freeze(['billingControlQueue', 'confirmPayment']);
const CONTROLLER_BILLING_READ_ACTIONS = Object.freeze([
  'getData', 'getPayments', 'getCredits', 'refundPayoutForecast', 'debtAging', 'cleanupReport',
]);
/* Append-only: the Phase 4 three first, then the «גבייה» reads. */
const CONTROLLER_ACTIONS = Object.freeze([
  'billingControlQueue', 'confirmPayment', 'debtAging',
  'getData', 'getPayments', 'getCredits', 'refundPayoutForecast', 'cleanupReport',
]);
const BILLING_CONTROL_ROUTES = Object.freeze(['/api/export/billing-control.xlsx']);
/* Every /api/ path a controller session may reach. Session plumbing first,
 * then the exports. /api/sheets is further limited to CONTROLLER_ACTIONS. */
const CONTROLLER_ROUTES = Object.freeze([
  '/api/me', '/api/logout', '/api/verify-pin', '/api/login-users', '/api/sheets',
  '/api/export/billing-control.xlsx', '/api/export/debt-aging.xlsx',
  '/api/export/refund-forecast.xlsx', '/api/export/cleanup.xlsx',
]);
/* getData keys the controller view receives (Code.gs CONTROLLER_GETDATA_KEYS,
 * pinned equal by a guard test). */
const CONTROLLER_GETDATA_KEYS = Object.freeze(['ok', 'patients', 'billingOverrides']);

/* ===== Field allow-lists for the controller view (privacy fix, Sandra
 * 2026-10-06; CHANGELOG-ortal-billing-access.md «Field allow-lists») =====
 * Cutting KEYS is not enough: every row must also carry only the FIELDS the
 * «גבייה» tab renders and computes with. Derived from what public/app.js
 * reads — renderBilling, buildBillingRow, patientDueOnDate,
 * patientStayCoversDate, patientExitISO, patientUid (the Funders join key),
 * matchPatientForPayment, paymentForPatientOnDate, billingRowMatchesQuery,
 * the occupancy / released filters (status). The funder itself rides
 * getPayments.funders, not the patient row. NOT sent: notes, source,
 * fromLead, phone, updatedAt / updatedBy, and anything else.
 *
 * The schemas below are applied by projectBySchema — an ALLOW-list: a key
 * that is not named is dropped, at every depth. Grammar:
 *   true              keep a primitive, or an array of primitives
 *   ['a', 'b']        an array of rows, each cut to these fields
 *   { $each: S }      an array, each element projected by S
 *   { '*': S }        an object map, every value projected by S
 *   { k: S, … }       an object, only these keys
 * Code.gs holds the SAME literals (CONTROLLER_*_SCHEMA); a guard test pins
 * them equal. */
const CONTROLLER_PATIENT_FIELDS = Object.freeze(['id', 'houseId', 'name', 'date', 'exitDate', 'status', 'pay', 'adv']);
const CONTROLLER_OVERRIDE_FIELDS = Object.freeze(['id', 'patientId', 'month', 'amount', 'created', 'updatedBy']);
const ERROR_FIELDS = { ok: true, error: true, message: true };
const CONTROLLER_GETDATA_SCHEMA = Object.freeze(Object.assign({}, ERROR_FIELDS, {
  patients: { '*': CONTROLLER_PATIENT_FIELDS },
  billingOverrides: CONTROLLER_OVERRIDE_FIELDS,
}));
/* cleanupReport («ייצוא רשימת תיקונים»): leads keep their name and the
 * billing gap — never phone or notes; names[].source (where a spelling was
 * found) is left out too. */
const CONTROLLER_CLEANUP_SCHEMA = Object.freeze(Object.assign({}, ERROR_FIELDS, {
  today: true, recordsCutoff: true, notAPatientExcluded: true, missingTabs: true, generatedAt: true,
  counts: { names: true, gaps: true, detached: true, outsideStay: true, releasedNoExit: true, noEntryDate: true,
    zeroAmount: true, leads: true, duplicates: true, credits: true, noFunder: true, probono: true,
    defaultedFunder: true },
  sections: {
    names: ['kind', 'houseId', 'name', 'recordedName', 'otherName', 'entryDate', 'otherEntryDate', 'proposal', 'confidence', 'via', 'why', 'refs'],
    gaps: ['kind', 'houseId', 'name', 'status', 'entryDate', 'exitDate', 'start', 'end', 'due', 'expected', 'charged', 'received', 'balance',
      'bucket', 'days', 'laterActivity', 'probablyEntryError'],
    detached: ['kind', 'houseId', 'name', 'dueDate', 'amount', 'receivedByAsOf', 'candidate', 'candidateReason', 'refs'],
    outsideStay: ['kind', 'houseId', 'name', 'status', 'start', 'entryDate', 'exitDate', 'amount', 'refs'],
    releasedNoExit: ['kind', 'houseId', 'name', 'entryDate'],
    noEntryDate: ['kind', 'houseId', 'name', 'status', 'paymentRows'],
    zeroAmount: ['kind', 'houseId', 'name', 'status', 'entryDate', 'exitDate', 'cycles'],
    leads: ['kind', 'houseId', 'name', 'stage', 'created', 'entryDate', 'advance', 'paymentName', 'dueDate', 'amount', 'reason', 'refs'],
    duplicates: ['kind', 'houseId', 'name', 'names', 'dueDate', 'otherDueDate', 'amount', 'rule', 'refs'],
    credits: ['kind', 'houseId', 'name', 'entryDate', 'exitDate', 'amount', 'payoutDate', 'rule', 'error'],
    noFunder: ['kind', 'houseId', 'name', 'status', 'entryDate', 'funder'],
    probono: ['kind', 'houseId', 'name', 'status', 'entryDate', 'exitDate', 'from', 'current', 'excludedCycles'],
    // CHANGELOG-defaulted-funder-report.md — no patientUid for the controller view.
    defaultedFunder: ['kind', 'houseId', 'name', 'paymentId', 'receipt', 'receivedDate', 'amount', 'fix'],
  },
}));
/* refundPayoutForecast («זיכויים ממתינים לתשלום»): Sandra's free-text
 * overrideReason and the fixed missing-data note are left out. */
const FORECAST_BY_HOUSE = ['houseId', 'count', 'total'];
const CONTROLLER_FORECAST_SCHEMA = Object.freeze(Object.assign({}, ERROR_FIELDS, {
  today: true, recordsCutoff: true, payoutDateIfDecidedToday: true, preCutoffExcludedCount: true, zeroByPolicyCount: true, generatedAt: true,
  awaiting_decision: { count: true, total: true, byHouse: FORECAST_BY_HOUSE,
    byPayoutDate: { $each: { payoutDate: true, count: true, total: true,
      rows: ['patientName', 'houseId', 'entryDate', 'exitDate', 'suggestedAmount', 'rule', 'payoutDate'] } } },
  decided: { count: true, total: true, byHouse: FORECAST_BY_HOUSE,
    byPayoutDate: { $each: { payoutDate: true, count: true, total: true,
      rows: ['creditId', 'creditType', 'patientName', 'houseId', 'amount', 'decidedDate', 'payoutDate', 'rule'] } } },
  missing_payment_data: { count: true, rows: ['patientName', 'houseId', 'entryDate', 'exitDate'] },
  unresolved: { count: true, rows: ['patientName', 'houseId', 'entryDate', 'exitDate', 'error'] },
}));

const isPrimitive = (v) => v === null || ['string', 'number', 'boolean'].indexOf(typeof v) >= 0;

/* `value` cut to `schema` (the grammar above). undefined = drop. Pure. */
function projectBySchema(value, schema) {
  if (schema === true) {
    if (isPrimitive(value)) return value;
    if (Array.isArray(value) && value.every(isPrimitive)) return value.slice();
    return undefined;
  }
  if (Array.isArray(schema)) {
    if (!Array.isArray(value)) return undefined;
    const row = {};
    schema.forEach((k) => { row[k] = true; });
    return value.map((v) => projectBySchema(v, row)).filter((v) => v !== undefined);
  }
  if (!schema || typeof schema !== 'object') return undefined;
  if (schema.$each) {
    if (!Array.isArray(value)) return undefined;
    return value.map((v) => projectBySchema(v, schema.$each)).filter((v) => v !== undefined);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out = {};
  Object.keys(value).forEach((k) => {
    const sub = Object.prototype.hasOwnProperty.call(schema, k) ? schema[k] : schema['*'];
    if (sub === undefined) return;
    const v = projectBySchema(value[k], sub);
    if (v !== undefined) out[k] = v;
  });
  return out;
}

/* The controller view's answer for a «גבייה» read, cut to its schema; every
 * other action unchanged. Pure. */
const CONTROLLER_RESPONSE_SCHEMAS = Object.freeze({
  getData: CONTROLLER_GETDATA_SCHEMA,
  cleanupReport: CONTROLLER_CLEANUP_SCHEMA,
  refundPayoutForecast: CONTROLLER_FORECAST_SCHEMA,
});
function controllerResponseView(action, data) {
  const schema = Object.prototype.hasOwnProperty.call(CONTROLLER_RESPONSE_SCHEMAS, action) ? CONTROLLER_RESPONSE_SCHEMAS[action] : null;
  if (!schema || !data || typeof data !== 'object' || Array.isArray(data)) return data;
  return projectBySchema(data, schema);
}
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

/* getData as the controller view receives it: CONTROLLER_GETDATA_KEYS only
 * (an allow-list — a key added to getData later never reaches her). Code.gs
 * controllerGetData_ makes the same cut. Pure. */
function controllerGetDataView(data) {
  // Keys AND fields: CONTROLLER_GETDATA_SCHEMA (patients cut to
  // CONTROLLER_PATIENT_FIELDS, overrides to CONTROLLER_OVERRIDE_FIELDS).
  return controllerResponseView('getData', data);
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
  CONTROLLER_BILLING_READ_ACTIONS,
  CONTROLLER_ACTIONS,
  CONTROLLER_GETDATA_KEYS,
  CONTROLLER_PATIENT_FIELDS,
  CONTROLLER_OVERRIDE_FIELDS,
  CONTROLLER_GETDATA_SCHEMA,
  CONTROLLER_CLEANUP_SCHEMA,
  CONTROLLER_FORECAST_SCHEMA,
  CONTROLLER_RESPONSE_SCHEMAS,
  projectBySchema,
  controllerResponseView,
  controllerGetDataView,
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
