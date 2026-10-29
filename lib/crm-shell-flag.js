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
/* C12 (CHANGELOG-crm-default.md): the switch. With CRM_DEFAULT exactly 'true'
 * (AND CRM_ENABLED 'true'), `/` serves the CRM shell to a verified personal
 * session whose page view is 'full' (Vered, Sandra) or 'ops' (Dana — since
 * CHANGELOG-crm-default-ops.md: she works in the CRM like Vered) unless the
 * query says `view=classic`. The controller (Ortal) keeps the classic page by
 * default; `/?view=crm` still works for her. No session → the
 * PIN page as before (the login reloads `/`, which then lands on the CRM). */
const CRM_DEFAULT_VAR = 'CRM_DEFAULT';
const CLASSIC_VIEW_VALUE = 'classic';
const CRM_DEFAULT_VIEWS = Object.freeze(['full', 'ops']);
/* Where every «בדשבורד הרגיל» link of the shell points — works before and after
 * the switch (`view=classic` never serves the shell). */
const CLASSIC_PATH = '/?view=classic';

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

function crmDefaultEnabled(env) {
  const e = env || {};
  return crmShellEnabled(e) && e[CRM_DEFAULT_VAR] === 'true';
}
function wantsClassic(query) {
  const q = query && typeof query === 'object' ? query : {};
  const v = q[CRM_VIEW_PARAM];
  return (Array.isArray(v) ? v[0] : v) === CLASSIC_VIEW_VALUE;
}
/* The switch: CRM by default for this principal + page view? */
function crmByDefault(env, query, principal, view) {
  return crmDefaultEnabled(env) && crmShellAllowed(principal) && CRM_DEFAULT_VIEWS.indexOf(String(view || '')) >= 0 && !wantsClassic(query);
}

/* The one decision server.js makes on `/`. `view` is lib/users.js
 * principalView(principal) ('full' | 'restricted' | 'controller' | 'none'). */
function serveCrmShell(env, query, principal, view) {
  if (!crmShellEnabled(env) || !crmShellAllowed(principal)) return false;
  if (wantsClassic(query)) return false;
  return wantsCrmShell(query) || crmByDefault(env, query, principal, view);
}

module.exports = { CRM_ENABLED_VAR, CRM_VIEW_PARAM, CRM_VIEW_VALUE, CRM_DEFAULT_VAR, CLASSIC_VIEW_VALUE, CRM_DEFAULT_VIEWS, CLASSIC_PATH,
  crmShellEnabled, wantsCrmShell, crmShellAllowed, crmDefaultEnabled, wantsClassic, crmByDefault, serveCrmShell };
