'use strict';

const { isWellFormedHash } = require('./pin-hash');

/* The fixed set of dashboard users — the SAME three names as the leads
 * `assignedTo` dropdown (public/app.js ASSIGNEE_OPTIONS). Single source of
 * truth for the server: /api/verify-pin accepts a session `user` ONLY from
 * this list (anything else mints the legacy user-less cookie), so updatedBy
 * can never carry an arbitrary string, however the request was crafted.
 *
 * The client's picker uses its own SESSION_USERS literal in public/app.js
 * (a plain browser script cannot require() this file); a guard test in
 * test/name-picker-conflicts.test.js pins the two lists equal, so they can
 * never drift silently. Add/rename users HERE and THERE together. */
const SESSION_USERS = ['ורד', 'שירן', 'יעל'];

/* ===== Personal-PIN user / role model (plan §11.2–11.3, PR A) =====
 *
 * Decisions locked by Sandra on 2026-10-01 (docs/billing-control-plan.md
 * §11.5). Each user has a STABLE ASCII id — the id, never the Hebrew name, is
 * what a personal session cookie and USER_PIN_HASHES key on, so a display-name
 * change can never re-map a credential.
 *
 *   staff      — ordinary dashboard work (leads, patients, payments)
 *   reporter   — reports payments (Phase 3)
 *   deleter    — every delete / void action (Code.gs DELETE_ACTIONS)
 *   approver   — un-void, refund exceptions, opening-balance write-off /
 *                accept (Code.gs APPROVER_ACTIONS). PINNED to Sandra.
 *   viewer     — read-only «חריגים פתוחים» view (Phase 4)
 *   controller — Ortal's verification queue (Phase 4)
 *
 * `roles` below is the MAXIMUM a user may hold. USER_PIN_HASHES may narrow it
 * (e.g. revoke deleter) but can never widen it: the startup validator fails
 * on any role outside this set. Nothing here is enforced on a route yet. */
const ROLES = Object.freeze(['staff', 'reporter', 'deleter', 'approver', 'viewer', 'controller']);

const APPROVER_ID = 'sandra';

const USER_MODEL = Object.freeze([
  { id: 'vered',  name: 'ורד',    roles: ['staff', 'reporter', 'deleter'],             status: 'active' },
  { id: 'sandra', name: 'סנדרה',  roles: ['staff', 'deleter', 'approver', 'viewer'],   status: 'active' },
  { id: 'shiran', name: 'שירן',   roles: ['staff', 'reporter'],                        status: 'active' },
  { id: 'yael',   name: 'יעל',    roles: ['staff', 'reporter'],                        status: 'active' },
  // In the model, no login until Phase 4 (then controller only — no staff).
  { id: 'ortal',  name: 'אורטל',  roles: ['controller'],                               status: 'inactive' },
].map((u) => Object.freeze(Object.assign({}, u, { roles: Object.freeze(u.roles) }))));

/* A session minted by the shared APP_PIN (today's login, and the 7-day
 * dual-accept window after personal PINs go live): staff only — NEVER deleter
 * or approver, whatever name the picker sent. */
const SHARED_SESSION_ROLES = Object.freeze(['staff']);

/* ===== View capabilities (restricted view, decided by Sandra 2026-10-03) =====
 *
 * `finance` = may SEE and use the billing data behind the four money tabs
 * (גבייה, הכנסות חודשיות, שיוך תשלומים, גרף צמיחה) and every billing widget
 * elsewhere. Held by Vered and Sandra. Shiran and Yael see everything else and
 * edit as staff, but never billing.
 *
 * A capability is derived from the STABLE USER ID, never from the record's
 * roles, so it needs no change to USER_PIN_HASHES: the live Sandra / Vered
 * lines keep full access exactly as pasted, and a record cannot grant finance
 * to anyone else (USER_PIN_HASHES has no field for it). Ortal (inactive until
 * Phase 4) has none yet — Phase 4 decides her view. */
const CAPABILITIES = Object.freeze(['finance']);
const FINANCE_USER_IDS = Object.freeze(['vered', 'sandra']);

/* A shared APP_PIN session keeps the FULL view during the dual window
 * (Sandra: nobody is cut off before they have a code; it ends with the
 * window). Its ROLES stay staff only — this is about what it may see. */
const SHARED_SESSION_CAPABILITIES = Object.freeze(['finance']);

const RECORD_STATUSES = ['active', 'inactive', 'revoked'];
const RECORD_KEYS = ['id', 'name', 'roles', 'hash', 'pinVersion', 'status'];

function modelById(id) {
  for (const u of USER_MODEL) if (u.id === id) return u;
  return null;
}

/* Validate USER_PIN_HASHES (a JSON array of records
 * {id, name, roles, hash, pinVersion, status}). Returns a frozen registry
 * { users, byId, approverId } — empty when the variable is unset/blank.
 * THROWS (→ startup failure) on: bad JSON, a non-array, an unknown/duplicate
 * id, a name that doesn't match the id, an unknown role, a role outside the
 * user's model, ANY approver other than Sandra, a malformed hash, a bad
 * pinVersion or status, or Ortal set active before Phase 4.
 * Error messages name the record index/id and the rule — never a hash. */
function validateUserPinHashes(raw) {
  const empty = { users: [], byId: {}, approverId: '' };
  if (raw === undefined || raw === null) return Object.freeze(empty);
  if (typeof raw !== 'string') throw new Error('USER_PIN_HASHES must be a JSON string');
  if (raw.trim() === '') return Object.freeze(empty);

  let parsed;
  try { parsed = JSON.parse(raw); } catch (_) {
    throw new Error('USER_PIN_HASHES is not valid JSON');
  }
  if (!Array.isArray(parsed)) throw new Error('USER_PIN_HASHES must be a JSON array of user records');

  const users = [];
  const byId = {};
  let approverId = '';
  parsed.forEach((rec, i) => {
    const where = `USER_PIN_HASHES[${i}]`;
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) throw new Error(`${where} is not an object`);
    const keys = Object.keys(rec).sort();
    if (keys.join(',') !== RECORD_KEYS.slice().sort().join(',')) {
      throw new Error(`${where} must have exactly the keys ${RECORD_KEYS.join(', ')}`);
    }
    const model = typeof rec.id === 'string' ? modelById(rec.id) : null;
    if (!model) throw new Error(`${where}: unknown user id`);
    const w = `${where} (${model.id})`;
    if (byId[model.id]) throw new Error(`${w}: duplicate id`);
    if (rec.name !== model.name) throw new Error(`${w}: name does not match the id`);
    if (!Array.isArray(rec.roles)) throw new Error(`${w}: roles must be an array`);
    const seen = {};
    rec.roles.forEach((role) => {
      if (ROLES.indexOf(role) < 0) throw new Error(`${w}: unknown role`);
      if (seen[role]) throw new Error(`${w}: duplicate role ${role}`);
      seen[role] = true;
      if (role === 'approver' && model.id !== APPROVER_ID) {
        throw new Error(`${w}: the approver role is pinned to ${APPROVER_ID}`);
      }
      if (model.roles.indexOf(role) < 0) throw new Error(`${w}: role ${role} is not allowed for this user`);
    });
    if (!isWellFormedHash(rec.hash)) throw new Error(`${w}: hash is malformed`);
    if (!Number.isInteger(rec.pinVersion) || rec.pinVersion < 1 || rec.pinVersion > 999999999) {
      throw new Error(`${w}: pinVersion must be a positive integer`);
    }
    if (RECORD_STATUSES.indexOf(rec.status) < 0) throw new Error(`${w}: status must be one of ${RECORD_STATUSES.join(', ')}`);
    if (model.status === 'inactive' && rec.status === 'active') {
      throw new Error(`${w}: this user has no login until Phase 4 — status must not be active`);
    }
    if (rec.roles.indexOf('approver') >= 0) approverId = model.id;
    const user = Object.freeze({
      id: model.id,
      name: model.name,
      roles: Object.freeze(rec.roles.slice()),
      hash: rec.hash,
      pinVersion: rec.pinVersion,
      status: rec.status,
    });
    users.push(user);
    byId[model.id] = user;
  });
  return Object.freeze({ users: Object.freeze(users), byId: Object.freeze(byId), approverId });
}

/* Whether the registry already holds an approver (Sandra's record) —
 * whatever its status: a revoked approver still disables the bootstrap. */
function hasApprover(registry) {
  return !!(registry && registry.approverId);
}

/* The principal behind a VERIFIED session (lib/session.js readSession):
 *   - shared (APP_PIN) session  → { auth:'shared', id:'', user, roles:['staff'] }
 *   - personal session          → that user's CURRENT roles, only while the
 *     record exists, is active and its pinVersion equals the cookie's
 *     (reset = pinVersion++ and revoke = status both kill old cookies)
 *   - anything else             → null (treat as unauthenticated)
 * Pure. */
function resolvePrincipal(session, registry) {
  if (!session || typeof session !== 'object') return null;
  if (!session.id) {
    return { auth: 'shared', id: '', user: typeof session.user === 'string' ? session.user : '', roles: SHARED_SESSION_ROLES.slice() };
  }
  const rec = registry && registry.byId ? registry.byId[session.id] : null;
  if (!rec || rec.status !== 'active' || rec.pinVersion !== session.pinVersion) return null;
  return { auth: 'personal', id: rec.id, user: rec.name, roles: rec.roles.slice() };
}

/* The capabilities of a RESOLVED principal (resolvePrincipal's output):
 *   shared   → SHARED_SESSION_CAPABILITIES (full view, dual window only)
 *   personal → by stable id (FINANCE_USER_IDS); the record's roles are
 *              irrelevant, so no live line needs regenerating
 *   anything else (no session, the meeting-report proxy) → none.
 * Pure; always a fresh array. */
function principalCapabilities(principal) {
  if (!principal || typeof principal !== 'object') return [];
  if (principal.auth === 'shared') return SHARED_SESSION_CAPABILITIES.slice();
  if (principal.auth === 'personal' && FINANCE_USER_IDS.indexOf(principal.id) >= 0) return ['finance'];
  return [];
}

/* true iff the principal may see billing data. */
function hasFinance(principal) {
  return principalCapabilities(principal).indexOf('finance') >= 0;
}

/* The single record line the bootstrap / «קוד אישי חדש» page shows for Sandra
 * to paste into USER_PIN_HASHES. JSON, one line. Roles default to the model's;
 * `roles` (optional) keeps an existing record's narrowed roles on a reset —
 * filtered to the model, so it can never widen. */
function recordLine(id, hash, pinVersion, roles) {
  const model = modelById(id);
  if (!model) throw new Error('recordLine: unknown user id');
  const keep = Array.isArray(roles)
    ? model.roles.filter((r) => roles.indexOf(r) >= 0)
    : model.roles.slice();
  return JSON.stringify({
    id: model.id,
    name: model.name,
    roles: keep,
    hash,
    pinVersion,
    status: model.status === 'inactive' ? 'inactive' : 'active',
  });
}

/* The login screen's name list: users whose record in USER_PIN_HASHES is
 * ACTIVE (and whose model allows a login), in model order. Only { id, name } —
 * never a role, a hash or a pinVersion. Ortal (inactive model) never appears. */
function loginUsers(registry) {
  const byId = registry && registry.byId ? registry.byId : {};
  return USER_MODEL
    .filter((m) => m.status === 'active' && byId[m.id] && byId[m.id].status === 'active')
    .map((m) => ({ id: m.id, name: m.name }));
}

module.exports = {
  loginUsers,
  CAPABILITIES,
  FINANCE_USER_IDS,
  SHARED_SESSION_CAPABILITIES,
  principalCapabilities,
  hasFinance,
  SESSION_USERS,
  ROLES,
  APPROVER_ID,
  USER_MODEL,
  SHARED_SESSION_ROLES,
  RECORD_STATUSES,
  modelById,
  validateUserPinHashes,
  hasApprover,
  resolvePrincipal,
  recordLine,
};
