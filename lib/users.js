'use strict';

/* The fixed set of dashboard users — the SAME three names as the leads
 * `assignedTo` dropdown (public/app.js ASSIGNEE_OPTIONS). Single source of
 * truth for the server: /api/verify-pin accepts a session `user` ONLY from
 * this list (anything else mints the legacy user-less cookie), so updatedBy
 * can never carry an arbitrary string, however the request was crafted.
 *
 * The client's picker uses its own SESSION_USERS literal in public/app.js
 * (a plain browser script cannot require() this file); a guard test in
 * test/name-picker-conflicts.test.js pins the two lists equal, so they can
 * never drift silently. Add/rename users HERE and THERE together.
 *
 * This list belongs to the SHARED-PIN login (APP_PIN + name picker). It stays
 * until the APP_PIN dual-accept window closes (Phase 0b-3, PR C). */
const SESSION_USERS = ['ורד', 'שירן', 'יעל'];

/* ===== Personal PINs: users and roles (Phase 0b-3, decided 01/10/2026) =====
 *
 * docs/billing-control-plan.md §11.2–11.3. Each user has a stable ASCII `id`
 * (it rides inside the signed cookie and keys the PIN hash) and the Hebrew
 * `name` every existing stamp already uses (updatedBy, chargedBy, …).
 *
 * Roles:
 *   staff      — today's everyday dashboard editing
 *   reporter   — reports payments (billing phase 3)
 *   deleter    — every delete / void action (Code.gs DELETE_ACTIONS)
 *   approver   — Sandra-only money decisions (Code.gs APPROVER_ACTIONS).
 *                PINNED to APPROVER_USER_ID: any other approver is a
 *                startup failure (lib/user-pins.js validateUserPinConfig).
 *   viewer     — Sandra's read-only "open exceptions" view (phase 4)
 *   controller — Ortal's verify / flag queue (phase 4)
 *
 * Sandra logs in with her own code only for approvals, which keeps the
 * control "Vered cannot approve her own exceptions or un-void her own
 * payments". Ortal is in the model as `inactive`: no login until phase 4,
 * and then controller only (no staff).
 *
 * These are the DEFAULTS the PIN-record generators fill in. The live record
 * for each user is in the Railway variable USER_PIN_HASHES (see
 * lib/user-pins.js), so Sandra can add, reset or revoke a user without a code
 * deploy. Code.gs KNOWN_ROLES and APPROVER_USER_NAME mirror ROLES and the
 * approver's name; test/personal-pins-foundation.test.js pins them equal. */
const ROLES = Object.freeze(['staff', 'reporter', 'deleter', 'approver', 'viewer', 'controller']);

const APPROVER_USER_ID = 'sandra';

const USER_STATUSES = Object.freeze(['active', 'inactive', 'revoked']);

const USERS = Object.freeze([
  Object.freeze({ id: 'sandra', name: 'סנדרה', roles: Object.freeze(['staff', 'deleter', 'approver', 'viewer']), status: 'active' }),
  Object.freeze({ id: 'vered',  name: 'ורד',   roles: Object.freeze(['staff', 'reporter', 'deleter']),         status: 'active' }),
  Object.freeze({ id: 'shiran', name: 'שירן',  roles: Object.freeze(['staff', 'reporter']),                    status: 'active' }),
  Object.freeze({ id: 'yael',   name: 'יעל',   roles: Object.freeze(['staff', 'reporter']),                    status: 'active' }),
  Object.freeze({ id: 'ortal',  name: 'אורטל', roles: Object.freeze(['controller']),                           status: 'inactive' }),
]);

/* Roles of a session minted by the SHARED APP_PIN (legacy cookies and the
 * 7-day dual-accept window): everyday editing only. Never deleter, never
 * approver — those need the person's own code. */
const SHARED_SESSION_ROLES = Object.freeze(['staff']);

function userById(id) {
  return USERS.find((u) => u.id === id) || null;
}

module.exports = {
  SESSION_USERS,
  ROLES,
  APPROVER_USER_ID,
  USER_STATUSES,
  USERS,
  SHARED_SESSION_ROLES,
  userById,
};
