'use strict';

/* CRM shell flag (C1, CHANGELOG-crm-shell-flag.md; docs/crm/ROLLOUT.md §C1).
 *
 * The CRM shell page is served for `/?view=crm` ONLY when all three hold:
 *   1. the Railway variable CRM_ENABLED is exactly the string 'true' (default
 *      off; Sandra sets it — Claude never does);
 *   2. the request asks for it (`view=crm` in the query);
 *   3. the request carries a VERIFIED personal Dashboard session (lib/users.js
 *      resolvePrincipal: auth 'personal' with an id). No session → the PIN
 *      page exactly as today; a shared or sibling session → the normal page.
 * Anything else → the normal page, byte-for-byte (a test pins it).
 *
 * Names are deliberately distinct from PR #220's CRM_READS / /crm-work. Pure. */

const CRM_ENABLED_VAR = 'CRM_ENABLED';
const CRM_VIEW_PARAM = 'view';
const CRM_VIEW_VALUE = 'crm';

function crmShellEnabled(env) {
  const e = env || {};
  return e[CRM_ENABLED_VAR] === 'true';
}

function wantsCrmShell(query) {
  const q = query && typeof query === 'object' ? query : {};
  const v = q[CRM_VIEW_PARAM];
  return (Array.isArray(v) ? v[0] : v) === CRM_VIEW_VALUE;
}

function crmShellAllowed(principal) {
  return !!principal && typeof principal === 'object' && principal.auth === 'personal'
    && typeof principal.id === 'string' && principal.id !== '';
}

/* The one decision server.js makes on `/`. */
function serveCrmShell(env, query, principal) {
  return crmShellEnabled(env) && wantsCrmShell(query) && crmShellAllowed(principal);
}

module.exports = { CRM_ENABLED_VAR, CRM_VIEW_PARAM, CRM_VIEW_VALUE, crmShellEnabled, wantsCrmShell, crmShellAllowed, serveCrmShell };
