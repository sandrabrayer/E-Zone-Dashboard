'use strict';

/* Operational view (CRM spec §2, CHANGELOG-crm-tasks-contact-log.md). Dana's
 * personal session: every operational read and write, nothing financial.
 *
 * What this file does: the getData PROJECTION. The money actions are refused
 * by lib/finance-scope.js (she has no `finance`) and the delete / void actions
 * by lib/role-scope.js (no `deleter`); Activity and Tasks cut their money
 * kinds by caps in Code.gs; and Code.gs saveAll_ keeps the stored money
 * fields on her saves (preserveMoneyFields_), so a row she never saw with its
 * price cannot lose it. Pure: no I/O. */

const { stripFinanceKeys } = require('./finance-scope');

/* Money fields, per row kind. Patients: the monthly price and the advance.
 * Leads: the advance taken at signing. Discharges carry the patient's price
 * too. Append-only; Code.gs OPS_PATIENT_MONEY_KEYS / OPS_LEAD_MONEY_KEYS mirror them. */
const OPS_PATIENT_MONEY_KEYS = Object.freeze(['pay', 'adv', 'advance', 'price']);
const OPS_LEAD_MONEY_KEYS = Object.freeze(['advance', 'price', 'pay']);
/* getData keys that hold lead rows / patient rows. */
const LEAD_LIST_KEYS = Object.freeze(['leads', 'irrelevantLeads', 'removedLeads']);
const PATIENT_LIST_KEYS = Object.freeze(['dischargedPatients']);

function stripKeys(row, keys) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
  const out = Object.assign({}, row);
  keys.forEach((k) => { delete out[k]; });
  return out;
}

/* The getData answer for an operational session. Patients arrive keyed by house
 * (or, defensively, as an array); the lists are projected row by row. Any
 * other key is passed through unchanged (append-only contract). */
function opsGetDataView(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const out = stripFinanceKeys(data);
  const p = out.patients;
  if (Array.isArray(p)) out.patients = p.map((r) => stripKeys(r, OPS_PATIENT_MONEY_KEYS));
  else if (p && typeof p === 'object') {
    const byHouse = {};
    Object.keys(p).forEach((h) => { byHouse[h] = Array.isArray(p[h]) ? p[h].map((r) => stripKeys(r, OPS_PATIENT_MONEY_KEYS)) : p[h]; });
    out.patients = byHouse;
  }
  PATIENT_LIST_KEYS.forEach((k) => { if (Array.isArray(out[k])) out[k] = out[k].map((r) => stripKeys(r, OPS_PATIENT_MONEY_KEYS)); });
  LEAD_LIST_KEYS.forEach((k) => { if (Array.isArray(out[k])) out[k] = out[k].map((r) => stripKeys(r, OPS_LEAD_MONEY_KEYS)); });
  return out;
}

module.exports = { OPS_PATIENT_MONEY_KEYS, OPS_LEAD_MONEY_KEYS, opsGetDataView };
