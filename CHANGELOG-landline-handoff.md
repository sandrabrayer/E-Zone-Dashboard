# Landlines accepted on the server-to-server lead handoff (2026-10-19)

## Problem
#251 (`CHANGELOG-lead-name-phone-required.md`) made `createLeadFromTherapists_`
use the dashboard's mobile-only rule `/^0\d{9}$/`. Nine-digit Israeli landlines
(`02-6543210`) arriving from ezone-therapists were therefore refused, with
nothing logged on the Dashboard side.

## Fix (apps-script/Code.gs only)
- **`leadHandoffPhone_(raw)`**: `normalizePhone_`, then accept
  `/^0\d{9}$/` **or** `/^0[2-9]\d{7}$/` (`LEAD_HANDOFF_LANDLINE_RE`). Returns the
  normalized phone or `''`.
- **`createLeadFromTherapists_`** (the only non-UI caller that creates a lead)
  uses it. The stored phone is the normalized local form (`026543210`);
  idempotency by normalized phone is unchanged.
- **Refusals are never silent — `refuseLeadHandoff_`**: the caller gets the explicit
  code (`{ ok:false, error:'invalid_phone' }` / `'invalid_name'`, the codes
  ezone-therapists already shows) and the refusal is logged twice:
  `console.warn('[lead-handoff] refused …')` and a hidden AuditLog row
  `action: lead_handoff_refused`, `fn`, `actor` (`by`), `details: { error, phoneDigits }`.
  The name and the phone itself are **not** logged (PII); only the digit count.

## Unchanged (stays strict, mobile-only)
- Dashboard UI form (`leadLocalPhone` / `leadRequiredErrors` in `public/app.js`).
- The UI save path on the server (`saveAll` → `mergeLeads_` → `leadRequiredViolations_` → `leadPhoneOk_`).

## Security
- No new routes and no new actions. The handoff still checks its own fail-closed
  `CREATE_LEAD_SECRET` (constant-time) **before** any validation, read or write.
- Validation is server-side; stage / source / id / created stay server-set; formula
  neutralisation (`leadCellText_`) unchanged.
- Logs hold no secrets, names or phone numbers.

## Notes
- `/^0[2-9]\d{7}$/` follows the request literally; it also matches a 9-digit
  `05…` number.
- No `public/` change, so no service-worker bump.
- Code.gs ships through the Apps Script CI on merge (no paste, no new deployment).

## Tests
`test/landline-handoff.test.js` (8): the pure rule; landline accepted on the handoff
(normalized, idempotent); invalid numbers refused with `invalid_phone`, audited +
console-logged, no PII in logs, nothing written; invalid-name refusal logged; auth
still first; UI form refuses a landline inline; `saveAll` refuses a landline; an
invalid number refused on the UI form and `saveAll`.
`test/lead-name-phone-required.test.js`: the therapists-path case now expects a
landline to be accepted.
