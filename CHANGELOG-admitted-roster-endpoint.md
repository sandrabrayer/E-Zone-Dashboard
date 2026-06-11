# Cross-app `getAdmittedRoster` endpoint (Apps Script)

## Why

The E-Zone Therapists app needs to populate its inpatient tab with currently-
admitted patients and their phone numbers. The Dashboard owns that data, so it
exposes a read-only cross-app endpoint the therapists service can call. The
patch shape is documented in the therapists repo
(`docs/dashboard-getAdmittedRoster.patch.md`); this change lands it in the
Dashboard's Apps Script, adapted to this repo's conventions.

## What

### Added (apps-script/Code.gs)

- **`getAdmittedRoster_()`** — returns currently-admitted patients with a
  recovered, normalized phone. The Patients sheet has no phone column, so each
  phone is recovered by joining `Patients.fromLead` → `Leads.id` and reading
  that lead's phone.
- **`normalizePhone_(raw)`** — strips non-digits and collapses a leading `972`
  country code to a single leading `0` (e.g. `+972-52-765-4321` → `0527654321`).
- **`admittedRosterAuthOk_(params)`** — **fail-closed** shared-secret gate
  backed by the `ADMITTED_ROSTER_SECRET` Script Property. The roster is served
  only when the property is set AND the request's `?secret=` matches it; an
  unset/empty property or a mismatched secret refuses.
- **`handle_` dispatch** for `action === 'getAdmittedRoster'`, behind the auth
  check, returning `{ ok:false, error:'unauthorized' }` on mismatch.

### Added (test/admitted-roster.test.js)

- Loads the real `Code.gs` in a `vm` sandbox (same technique as
  `breakeven-revenue.test.js`), stubs `getOrCreateSheet_` / `readSheet_` to
  serve in-memory fixtures, and exercises the shipped `getAdmittedRoster_`.
- **No-leak contract test**: asserts every returned row has EXACTLY
  `{ sourceApp, name, phone, house }` and that none of the sensitive
  Leads/Patients fields (`note`, `notes`, `stage`, `pay`, `adv`, `source`,
  `fromLead`, `exitDate`, `status`, `id`, …) appear — even when those fields are
  present on the source rows.
- Covers phone recovery + normalization, `+972` collapsing, exclusion of
  released patients, and the `direct_admin` (no `fromLead`) → `phone:''` case.
- **Fail-closed auth tests** drive the real `handle_` dispatch (with stubbed
  `PropertiesService` / `ContentService`) and assert that an unset secret, an
  empty-string secret, a mismatched secret, and a missing secret each return
  `{ ok:false, error:'unauthorized' }` with **no `patients` payload** — and that
  a matching secret authorizes and returns the roster.

## Design decisions

- **Minimal projection.** Returns only `{ sourceApp, name, phone, house }`. No
  lead note, stage, advance, pricing, payment, or other field is exposed.
  `sourceApp:'ezone-dashboard'` is a constant identifier (per the documented
  patch shape), not a Leads field — the no-leak test locks the exact key set.
- **Admitted = not released, mirroring occupancy.** The patch keyed admission
  on a blank `exitDate`. This repo's canonical "released" test is
  `status === 'released'` (the occupancy tab filters `p.status !== 'released'`,
  and release sets *both* `status` and `exitDate`). To stay consistent with
  occupancy — and to never leak a released patient's phone if only one field
  was hand-edited — the endpoint excludes a row when `status === 'released'`
  **or** `exitDate` is non-blank.
- **`direct_admin` patients keep their place but get no phone.** Rows with
  `fromLead:''` have no recoverable phone, so they are returned with `phone:''`.
  The therapists side falls back to free-text rather than fabricating a match.
- **Separate secret.** `ADMITTED_ROSTER_SECRET` is its own Script Property,
  distinct from the other apps' secrets, matching the sibling pattern.
- **First auth in this repo, fail-closed.** No Dashboard endpoint was
  authenticated before this. It borrows the sibling cross-app endpoints'
  shared-secret *shape* but deliberately diverges from their fail-open-when-unset
  behavior: because the payload is patient names + phones (PII), an unconfigured
  or mismatched secret must never serve data. If `ADMITTED_ROSTER_SECRET` is
  unset/empty, or the request's `?secret=` does not match, the endpoint refuses
  with `{ ok:false, error:'unauthorized' }` and returns no roster. The secret
  MUST be set as a Script Property before the endpoint will return anything.

## Conventions reused

- `getOrCreateSheet_`, `readSheet_`, `jsonOut_`, `PATIENT_COLUMNS`,
  `LEAD_COLUMNS`, and the trailing-underscore helper naming — all existing.
- `PropertiesService.getScriptProperties()` for the secret.

## Follow-up (manual, not in this PR)

1. Redeploy the Dashboard Apps Script as a **new version / new deployment** so
   the new code goes live (the `/exec` URL stays the same).
2. Set the `ADMITTED_ROSTER_SECRET` Script Property
   (Project Settings → Script properties). **Required** — until it is set the
   fail-closed gate refuses every request and the endpoint returns no roster.
3. Carry the `/exec` URL + secret to the therapists Railway service and the
   therapists Apps Script.
