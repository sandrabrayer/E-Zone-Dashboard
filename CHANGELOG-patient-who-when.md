# Who/when stamping on Patients writes

**Why:** PR #112 gave every Patients row a persisted `id` (identity
foundation). The app is moving from one user (Vered) to three concurrent
users — every write now records WHO made it and WHEN, so the follow-up PR
can refuse stale saves and the audit log can name people. **Zero
user-visible change; the #112 identity/matching logic is untouched.**

## Phase 1 findings

1. `PATIENT_COLUMNS` post-#112: 10 legacy columns + `id` LAST, with a synced
   copy in `scripts/healthcheck.js` and pinned-order guards in
   `nightly-integrity` / `patient-identity-foundation` /
   `restore-choice-modal` — all updated.
2. `DISCHARGED_PATIENT_COLUMNS` was derived
   (`['id'].concat(PATIENT_COLUMNS.filter(≠'id')).concat(metadata)`) —
   appending to `PATIENT_COLUMNS` would have injected the stamps MID-list
   (between `notes` and `dischargedAt`), misaligning every live discharged
   sheet (positional reads + header-extend). It is now a **frozen literal**
   whose pre-stamp prefix is byte-identical to the derived list it replaces,
   with `updatedAt`/`updatedBy` appended LAST. `PATIENT_TOMBSTONE_COLUMNS`
   was already a deliberate literal — same two appended after `id`.
3. `patientRowDiffCols_` already skipped `id`; it now skips all of
   `PATIENT_META_COLUMNS` (`id`, `updatedAt`, `updatedBy`) — echoed stale
   stamps never read as an edit, and the identical-key dedupe still treats
   rows differing only in meta as byte-identical.
4. Session tokens (`lib/session.js`) were `<expiry>.<HMAC>` with no payload
   field; `server.js` had no whoami path. Extended as below.
5. Write paths stamped: `replaceHousePatients_` id-match / key-match /
   rename-via-fromLead / append; `dischargePatient_`; `restorePatient_`;
   `restorePatientToActive_`; `deletePatientRow_` (tombstone).

## A. Schema (append-only)

- `updatedAt`, `updatedBy` appended at the END of `PATIENT_COLUMNS` (after
  `id`), of the tombstone literal, and of the discharged literal (finding 2).
- `getOrCreateSheet_` extends live headers non-destructively as always and
  text-forces the two new columns on Patients / tombstones / discharged so
  ISO stamps are never Date-coerced.
- Healthcheck's synced column copy and every pinned-order guard test updated.

## B. Who: user in the session cookie

- `lib/session.js`: token format gains an optional user segment —
  `<expiry>.<base64url(user)>.<sig>`, the signature covering both parts, so
  the name is **inside the signed payload** (tamper-proof, never a separate
  cookie). Legacy `<expiry>.<sig>` cookies keep validating byte-for-byte
  (locked by test). New `readSessionUser()`.
- `server.js`: `POST /api/verify-pin` accepts an optional `user` (trimmed,
  control-chars and angle brackets stripped, capped at 40 chars — Hebrew
  names with quotes like ד"ר survive); absent → the exact legacy cookie.
  New session-gated `GET /api/me` → `{ ok, user }` ('' when absent).
  **`POST /api/sheets` ALWAYS overwrites `body.user` from the verified
  cookie** — a client-supplied `user` never reaches Apps Script.
- No login-form change (the name picker is PR 2).

## C. When: stamping in Code.gs

- `handle_` passes `requestUser_(params)` (defensive re-trim/escape/cap)
  into `saveAll_` → `replaceHousePatients_` and into discharge / restore /
  restore-to-active / delete.
- `replaceHousePatients_`: stamps are SERVER-OWNED. On an id-match or
  key-match the payload's stamps are discarded (the sheet row's carry over)
  and `updatedAt`/`updatedBy` are re-written ONLY when a non-meta column
  actually changed — an unchanged echo re-stamps nothing. Rename-via-
  fromLead and every append always stamp (they are real edits by
  construction). **Preserved rows are never re-stamped** — even when the
  #112 convergence mints them an `id`.
- `deletePatientRow_` stamps the DELETER onto the tombstone row
  (`appendPatientTombstones_` gained an optional `deletedBy`: the user-delete
  path overwrites the snapshot's stamps with now + the deleting user, so the
  recovery copy answers "who deleted this and when"; preserve/dedupe
  snapshots keep the row's own last-edit stamps).
- Discharge / restore / restore-to-active stamp the discharged audit row
  server-side (client-sent stamps ignored).
- `updatedBy` added to every existing `logAudit_` details object on those
  paths (`patient_added`, `promote_created`, `patient_edited`,
  `patient_rekeyed_via_id`, `patient_renamed_via_fromLead`,
  `patient_deleted`, `patient_discharged`, `patient_restored_to_lead`,
  `patient_restored_active`). Blank `updatedBy` (old cookies) is allowed
  everywhere.

## Client

`normalizePatient` / `serializePatients` round-trip both fields defensively
(same `pickField` pattern as `prior_status`); the server ignores
client-supplied stamps and always overwrites on a real change. Zero UI
change.

## Compatibility

Additive only: Managers (the second Apps Script consumer) reads named
fields and never sees the two new ones; old session cookies keep working
and stamp blank; old clients that don't echo the fields lose nothing (the
matched replace carries the sheet's values).

## Nothing to run

No manual step: the columns land via sheet-ensure on the first
getData/saveAll after the clasp CI deploy, and stamps accrue as people
save. (Names appear once PR 2 adds the login name picker; until then
`updatedBy` is blank.)

## Tests

`test/patient-who-when.test.js` — 21 tests: schema tail pins; the meta-blind
diff; append/id-match/key-match/rename stamping through `handle_` and
`saveAll_`; unchanged echo not re-stamped + forged stamps never land;
preserved rows untouched (id minting included); delete stamps the tombstone
(and preserve-path tombstones keep row stamps); discharge/restore stamping;
legacy token validates, user-bearing token reads back + tamper rejected +
scope/expiry; sanitizer trim/cap/escape; proxy-overwrite +
`/api/me` source-scan; client round-trip incl. legacy blanks. Updated pins
in `patient-identity-foundation` (4), `nightly-integrity`,
`restore-choice-modal`, plus the healthcheck sync. Full suite: **839
passing**.

## PR 2 plan (so it isn't lost)

1. **Per-row saves**: a `savePatient` action carrying one row (by `id`)
   instead of the whole-house array — shrinking the write window that makes
   stale-tab merges necessary.
2. **`updatedAt` conflict refusal**: the per-row save carries the
   `updatedAt` it loaded; the server refuses (409-style response) when the
   sheet's is newer — the client reloads and reapplies. The stamps this PR
   writes are the baseline that makes that comparison meaningful.
3. **Name picker after PIN**: the login flow gains an optional name selector
   feeding `/api/verify-pin`'s `user`; the UI shows who is editing via
   `/api/me`. Until then `updatedBy` stays blank — by contract.
