# Patient identity foundation (PR 1 of 2) — persistent ids + who/when stamps

**Why:** Patients rows have no id — identity is `houseId::name::entryDate`
(`patientKey_`), so every name/date edit is delete+create, the root of the
duplicate-row bug family (PRs #103/#104/#110). The app is also moving from
one user (Vered) to three concurrent users, so writes need to say WHO and
WHEN. This PR is FOUNDATION ONLY: schema + backfill + plumbing, **zero
user-visible change, zero identity/matching change** — `patientKey_` remains
row identity. PR 2 flips identity to the id (see the plan at the bottom).

## Phase 1 findings

1. `PATIENT_COLUMNS` is a 10-column literal with a synced copy in
   `scripts/healthcheck.js` (enforced by `weekly-healthcheck.test.js` parsing
   Code.gs source) and a pinned-order guard in `nightly-integrity.test.js`.
2. `PATIENT_TOMBSTONE_COLUMNS` is a deliberate own-literal (not derived);
   `DISCHARGED_PATIENT_COLUMNS` was DERIVED via
   `['id'].concat(PATIENT_COLUMNS).concat([...metadata])` — deriving would
   have injected the three new columns MID-list (between `notes` and
   `dischargedAt`), misaligning every existing discharged sheet (reads and
   the header-extend in `getOrCreateSheet_` are positional). It is now a
   frozen literal with the three appended at the very end.
3. Lead id style: `'id-' + Utilities.getUuid()` (`backfillMissingIds_`) —
   reused for `patientId`.
4. Session tokens (`lib/session.js`) are `<expiry>.<HMAC>` with no payload
   field — extended backward-compatibly (below).
5. All Patients write paths run through: `replaceHousePatients_`
   (replace/rename/append), `dischargePatient_`, `restorePatient_`,
   `restorePatientToActive_`, `deletePatientRow_` — all now stamped.

## A. Schema (append-only)

- `PATIENT_COLUMNS` += `patientId`, `updatedAt`, `updatedBy` at the END.
- `PATIENT_TOMBSTONE_COLUMNS` and `DISCHARGED_PATIENT_COLUMNS`: same three at
  their ends (both are now own-literals — see finding 2).
- `getOrCreateSheet_` extends existing sheets' headers non-destructively (as
  always) and text-forces `patientId`/`updatedAt` on Patients, discharged and
  tombstones so ids and ISO timestamps are never Date-coerced.
- `scripts/healthcheck.js`'s synced `PATIENT_COLUMNS` copy updated.
- All three pinned-order guard tests updated
  (`nightly-integrity` / `restore-choice-modal` / new foundation suite).

## B. Ids

- **Append** in `replaceHousePatients_` (plain add, promotion, and
  rename-in-place when neither side has an id) assigns
  `'id-' + Utilities.getUuid()` when the incoming row has none; a row that
  carries an id never gets a new one.
- **Replace** (key match) inherits the SHEET row's `patientId` — a payload
  value is used only where the sheet has none, so a client can never
  overwrite an existing id. **Rename-in-place inherits the consumed row's
  id** — the whole point of the foundation: the identity that survives a
  rename in PR 2 already rides along today.
- **`backfillPatientIdsNow`** (public, Run dropdown, NOT HTTP-reachable —
  `handle_` never names it, guard-tested): assigns ids to every Patients row
  lacking one (per-row single-cell writes, text-forced, top-to-bottom),
  idempotent (second run = 0 writes), under `LockService`, audit-logged
  (`patient_id_backfilled` with per-sheet counts). Discharged + tombstone
  rows get the live row's id ONLY on an unambiguous `patientKey_` match —
  an ambiguous key (2+ live rows; run `collapseDuplicatePatientKeysNow`
  first) or an unmatched key is left blank and logged.
- **Round-trip**: server → `getData` → client `normalizePatient` (defensive
  `pickField`) → `serializePatients` → `saveAll` → server, unchanged. NOT
  used for matching in this PR.

## C. Who/when stamping

- **`lib/session.js`**: token format gains an optional user segment —
  `<expiry>.<base64url(user)>.<sig>`, signature covering both parts so the
  name is tamper-proof. Legacy `<expiry>.<sig>` cookies keep validating
  byte-for-byte (locked by test). New `readSessionUser()`.
- **`server.js`**: `POST /api/verify-pin` accepts an optional `user` (trimmed,
  control-chars/angle-brackets stripped, capped at 40 chars) and mints the
  user-bearing cookie; absent → the exact legacy cookie. New session-gated
  `GET /api/me` → `{ ok, user }`. **`POST /api/sheets` always overwrites
  `body.user` from the verified cookie** — a client-supplied value never
  reaches Apps Script.
- **Code.gs**: `handle_` passes `requestUser_(params)` (defensive re-trim/cap)
  into `saveAll_` → `replaceHousePatients_`, and into discharge / restore /
  restore-to-active / delete. Every write path stamps `updatedAt` (ISO) +
  `updatedBy`; on a key-matched replace the stamps are re-written ONLY when a
  non-meta column actually changed (`PATIENT_META_COLUMNS` excluded from the
  changed-diff), so echoes don't churn stamps and a forged payload
  `updatedBy` is discarded. All those paths' `logAudit_` details now include
  `updatedBy`. Blank `updatedBy` (old cookies) is allowed everywhere.
- **NO name picker UI** — the login form is visually unchanged (PR 2).

## Compatibility

- Additive only: Managers (the second consumer of this Apps Script) reads
  named fields and ignores the three new ones; getData payload gains three
  fields per patient and nothing else changes.
- Old session cookies keep working (blank `updatedBy`); old clients that
  don't echo the new fields lose nothing — replace inherits from the sheet.

## Sandra's run order (after the merge auto-deploys via clasp CI)

1. If `findDuplicatePatientKeysNow` reports groups — run
   `collapseDuplicatePatientKeysNow` first (ambiguous keys block the audit
   backfill).
2. Run **`backfillPatientIdsNow`** (Run dropdown). Read the log: assigned /
   matched / ambiguous / unmatched counts; AuditLog carries
   `patient_id_backfilled`.
3. That's all — everything else is automatic (appends self-assign ids).

## Tests

`test/patient-identity-foundation.test.js` — 21 tests: column pins; append
assigns id + stamps (through `handle_`, covering the user plumbing); replace
inherits id, ignores forged meta, re-stamps only on real edits; rename keeps
the id; server round-trip unchanged; backfill (assign/skip/ambiguous/
unmatched/idempotent/audit); discharge/restore/delete stamps + audit;
dispatch guard; session tokens (legacy validates, user-bearing reads back,
tamper fails, scope + expiry hold); `sanitizeSessionUser` cap/escape;
`/api/me` + proxy-injection source-scan; client normalize/serialize
round-trip incl. legacy blanks. Updated pins in `nightly-integrity` and
`restore-choice-modal`. Full suite: **814 passing**.

## PR 2 plan (so it isn't lost)

1. **Identity flip**: `replaceHousePatients_` (and delete/discharge) match by
   `patientId` first, `patientKey_` as legacy fallback for id-less rows —
   name/entry-date edits become in-place updates for ALL rows, not just
   lead-linked ones; the rename trade-off documented in merge-don't-drop
   disappears.
2. **Per-row saves**: a `savePatient` action carrying one row (by id) instead
   of the whole-house array, shrinking the write window that makes stale-tab
   merges necessary.
3. **Conflict refusal**: a per-row save carries the `updatedAt` it loaded; the
   server refuses (409-style response) when the sheet's `updatedAt` is newer —
   the client reloads and reapplies. The stamps this PR writes are the
   baseline that makes that comparison meaningful.
4. **Name picker**: login form gains the (optional) name selector feeding
   `/api/verify-pin`'s `user`; the UI shows "מי מעדכן" from `/api/me`.
