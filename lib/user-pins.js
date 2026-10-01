'use strict';

/* USER_PIN_HASHES — the Railway variable that holds every personal-PIN record
 * (Phase 0b-3, docs/billing-control-plan.md §11.2).
 *
 * The value is ONE line of JSON, an array of records:
 *
 *   [{"id":"sandra","name":"סנדרה","roles":["staff","deleter","approver","viewer"],
 *     "status":"active","pinVersion":1,"hash":"scrypt$v1$32768$8$1$…$…"}, …]
 *
 *   id         — stable ASCII id (lib/users.js); rides in the signed cookie
 *   name       — the Hebrew name every stamp uses; for a known id it must be
 *                exactly the lib/users.js name
 *   roles      — a non-empty subset of lib/users.js ROLES; `approver` ONLY on
 *                APPROVER_USER_ID (Sandra)
 *   status     — active | inactive | revoked (revoke = set "revoked")
 *   pinVersion — a positive integer; a reset bumps it, which invalidates
 *                that user's existing cookies (wired in PR B)
 *   hash       — lib/pin-hash.js format. Never a plaintext PIN.
 *
 * validateUserPinConfig is the STARTUP VALIDATOR: unset/empty is valid (no
 * personal PINs yet); anything else that is malformed fails startup. Error
 * messages name the record index and id only — never a hash or a PIN. */

const { ROLES, APPROVER_USER_ID, USER_STATUSES, userById } = require('./users');
const { hashPin, parsePinHash, pinWeakness, isValidPepper, USER_ID_PATTERN } = require('./pin-hash');

const RECORD_KEYS = ['id', 'name', 'roles', 'status', 'pinVersion', 'hash'];
const MAX_RECORDS = 50;
const MAX_PIN_VERSION = 999999;

function cleanName(raw) {
  // eslint-disable-next-line no-control-regex
  return typeof raw === 'string' && !/[\u0000-\u001f<>]/.test(raw) && raw.trim() === raw
    && raw.length > 0 && raw.length <= 40;
}

/* Validate one record. Returns an array of error strings (empty = valid). */
function recordErrors(rec, index) {
  const where = 'USER_PIN_HASHES[' + index + ']';
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return [where + ': not an object'];
  const errs = [];
  const idOk = typeof rec.id === 'string' && USER_ID_PATTERN.test(rec.id);
  const label = idOk ? where + ' (' + rec.id + ')' : where;
  Object.keys(rec).forEach((k) => {
    if (RECORD_KEYS.indexOf(k) < 0) errs.push(label + ': unknown field');
  });
  if (!idOk) errs.push(label + ': id must match ' + USER_ID_PATTERN);
  if (!cleanName(rec.name)) {
    errs.push(label + ': name must be 1–40 characters, no control characters or < >');
  } else if (idOk) {
    const known = userById(rec.id);
    if (known && known.name !== rec.name) errs.push(label + ': name does not match lib/users.js for this id');
  }
  if (!Array.isArray(rec.roles) || rec.roles.length === 0) {
    errs.push(label + ': roles must be a non-empty array');
  } else {
    const seen = new Set();
    rec.roles.forEach((r) => {
      if (typeof r !== 'string' || ROLES.indexOf(r) < 0) errs.push(label + ': unknown role');
      else if (seen.has(r)) errs.push(label + ': duplicate role');
      seen.add(r);
    });
    if (rec.roles.indexOf('approver') >= 0 && rec.id !== APPROVER_USER_ID) {
      errs.push(label + ': the approver role is pinned to "' + APPROVER_USER_ID + '"');
    }
  }
  if (USER_STATUSES.indexOf(rec.status) < 0) errs.push(label + ': status must be one of ' + USER_STATUSES.join(' / '));
  if (!Number.isInteger(rec.pinVersion) || rec.pinVersion < 1 || rec.pinVersion > MAX_PIN_VERSION) {
    errs.push(label + ': pinVersion must be a positive integer');
  }
  if (!parsePinHash(rec.hash)) errs.push(label + ': hash is not a valid scrypt v1 PIN hash');
  return errs;
}

/* The startup validator.
 *   raw    — process.env.USER_PIN_HASHES (may be unset / empty)
 *   pepper — process.env.PIN_PEPPER
 * → { ok, records, errors }. `records` is [] whenever ok is false. */
function validateUserPinConfig(raw, pepper) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { ok: true, records: [], errors: [] };
  }
  let parsed;
  try {
    parsed = JSON.parse(String(raw));
  } catch (_) {
    // Never echo the value or the parser message (it can quote the input).
    return { ok: false, records: [], errors: ['USER_PIN_HASHES is not valid JSON'] };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, records: [], errors: ['USER_PIN_HASHES must be a JSON array of records'] };
  }
  if (parsed.length > MAX_RECORDS) {
    return { ok: false, records: [], errors: ['USER_PIN_HASHES has more than ' + MAX_RECORDS + ' records'] };
  }
  const errors = [];
  parsed.forEach((rec, i) => { errors.push(...recordErrors(rec, i)); });
  const ids = new Set();
  const names = new Set();
  parsed.forEach((rec, i) => {
    if (!rec || typeof rec !== 'object') return;
    if (ids.has(rec.id)) errors.push('USER_PIN_HASHES[' + i + ']: duplicate id');
    if (names.has(rec.name)) errors.push('USER_PIN_HASHES[' + i + ']: duplicate name');
    ids.add(rec.id);
    names.add(rec.name);
  });
  if (parsed.length > 0 && !isValidPepper(pepper)) {
    errors.push('PIN_PEPPER is not set (or is shorter than 32 characters) — no PIN hash can be checked');
  }
  if (errors.length) return { ok: false, records: [], errors };
  return { ok: true, records: parsed, errors: [] };
}

/* True when any record (whatever its status) holds the approver role. Once
 * one exists the bootstrap endpoint is permanently disabled. */
function hasApprover(records) {
  return (records || []).some((r) => r && Array.isArray(r.roles) && r.roles.indexOf('approver') >= 0);
}

/* Build a NEW record for a lib/users.js user from a PIN. Throws on an unknown
 * id, a weak PIN or a bad pepper. The PIN is hashed and dropped — it is never
 * part of the returned value. */
function buildUserRecord(id, pin, pepper, pinVersion) {
  const user = userById(id);
  if (!user) throw new Error('buildUserRecord: unknown user id');
  const weak = pinWeakness(pin);
  if (weak) throw new Error('buildUserRecord: weak PIN (' + weak + ')');
  return {
    id: user.id,
    name: user.name,
    roles: user.roles.slice(),
    status: user.status,
    pinVersion: Number.isInteger(pinVersion) && pinVersion > 0 ? pinVersion : 1,
    hash: hashPin(user.id, pin, pepper),
  };
}

/* The full USER_PIN_HASHES value with `record` added (or replacing the record
 * with the same id), as the ONE line Sandra pastes into Railway. */
function withRecord(records, record) {
  const next = (records || []).filter((r) => r.id !== record.id);
  next.push(record);
  return JSON.stringify(next);
}

module.exports = {
  validateUserPinConfig,
  hasApprover,
  buildUserRecord,
  withRecord,
  RECORD_KEYS,
};
