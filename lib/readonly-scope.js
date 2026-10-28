'use strict';

/* Read-only view (Phase 2, CHANGELOG-readonly-role-dana.md; docs/crm/
 * PERMISSIONS-MATRIX.md D5 / D16). Dana's personal session.
 *
 * The rule, enforced in server.js BEFORE anything is proxied:
 *   - every request to /api/* that is not a GET is refused (403
 *     forbidden_readonly) — except POST /api/logout, which clears a credential;
 *   - a GET /api/sheets action outside READONLY_GET_ACTIONS is refused;
 *   - the getData answer is projected: the finance-only keys go (as for the
 *     restricted view), and every lead / patient / discharge row loses its
 *     money fields (READONLY_*_MONEY_KEYS) — on the server, so the page and the
 *     CRM never receive them.
 * Pure: no I/O. The restricted view's lib/finance-scope.js rules still apply
 * on top (she has no `finance`, so every billing action is already 403). */

const { ALL_USERS_READ_ACTIONS } = require('./role-scope');
const { stripFinanceKeys } = require('./finance-scope');

/* The GET actions a read-only session may call: the page's one data read and
 * the per-user feeds every logged-in user may see. Append-only. */
const READONLY_GET_ACTIONS = Object.freeze(['getData'].concat(ALL_USERS_READ_ACTIONS));
const READONLY_WRITE_ALLOWED_PATHS = Object.freeze(['/api/logout']);
const READONLY_FORBIDDEN_MESSAGE = 'הרשאת צפייה בלבד — אין אפשרות לשנות';

/* Money fields, per row kind. Patients: the monthly price and the advance.
 * Leads: the advance taken at signing. Discharges carry the patient's price
 * too. Append-only. */
const READONLY_PATIENT_MONEY_KEYS = Object.freeze(['pay', 'adv', 'advance', 'price']);
const READONLY_LEAD_MONEY_KEYS = Object.freeze(['advance', 'price', 'pay']);
/* getData keys that hold lead rows / patient rows. */
const LEAD_LIST_KEYS = Object.freeze(['leads', 'irrelevantLeads', 'removedLeads']);
const PATIENT_LIST_KEYS = Object.freeze(['dischargedPatients']);

function isReadonlyGetAction(action) {
  return READONLY_GET_ACTIONS.indexOf(String(action == null ? '' : action)) >= 0;
}

/* Is this request allowed for a read-only session? `method`, `path` and the
 * action (query or body). Pure. */
function readonlyRequestAllowed(method, path, action) {
  const m = String(method || '').toUpperCase();
  if (m !== 'GET') return READONLY_WRITE_ALLOWED_PATHS.indexOf(String(path || '')) >= 0;
  if (String(path || '') !== '/api/sheets') return true;
  return isReadonlyGetAction(action);
}

function stripKeys(row, keys) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
  const out = Object.assign({}, row);
  keys.forEach((k) => { delete out[k]; });
  return out;
}

/* The getData answer for a read-only session. Patients arrive keyed by house
 * (or, defensively, as an array); the lists are projected row by row. Any
 * other key is passed through unchanged (append-only contract). */
function readonlyGetDataView(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const out = stripFinanceKeys(data);
  const p = out.patients;
  if (Array.isArray(p)) out.patients = p.map((r) => stripKeys(r, READONLY_PATIENT_MONEY_KEYS));
  else if (p && typeof p === 'object') {
    const byHouse = {};
    Object.keys(p).forEach((h) => { byHouse[h] = Array.isArray(p[h]) ? p[h].map((r) => stripKeys(r, READONLY_PATIENT_MONEY_KEYS)) : p[h]; });
    out.patients = byHouse;
  }
  PATIENT_LIST_KEYS.forEach((k) => { if (Array.isArray(out[k])) out[k] = out[k].map((r) => stripKeys(r, READONLY_PATIENT_MONEY_KEYS)); });
  LEAD_LIST_KEYS.forEach((k) => { if (Array.isArray(out[k])) out[k] = out[k].map((r) => stripKeys(r, READONLY_LEAD_MONEY_KEYS)); });
  return out;
}

module.exports = {
  READONLY_GET_ACTIONS,
  READONLY_WRITE_ALLOWED_PATHS,
  READONLY_FORBIDDEN_MESSAGE,
  READONLY_PATIENT_MONEY_KEYS,
  READONLY_LEAD_MONEY_KEYS,
  isReadonlyGetAction,
  readonlyRequestAllowed,
  readonlyGetDataView,
};
