# Patient identity — Foundation

**Foundation only. ZERO user-facing change. No new UI, no new HTTP action.**
The follow-up ("patient-identity-ui") can build on this: id-based house
moves, discharge ↔ patient linkage by id, and eventually payment/override
keys migrated off the name triple.

> **Note on the source prompt.** The task arrived as the file name
> `claude-code-prompt-patient-identity-foundation.md`, but that file was not
> in the repository, in Google Drive, or in email (only the three earlier
> `claude-code-prompt-*.md` docs exist in Drive). The scope below was derived
> from the branch name and from the root cause every recent patient-data
> changelog names — "the Patients sheet has no id column" (#103, #104, #110,
> merge-don't-drop, billing-override-id-heal). If the original prompt asked
> for something narrower or different, this PR is additive and append-only,
> so it can be adjusted without a rollback.

## The problem this closes (root cause, confirmed by code reading)

1. The Patients sheet had **no id column**. Row identity was the triple
   `houseId::name::entryDate` (`patientKey_`).
2. The client minted a fresh session `id` (`cryptoId()`) for every patient on
   **every load** and it was never persisted.
3. Consequences the changelog history keeps circling back to:
   - editing a patient's **name or entry date changed their identity**, so the
     edit landed as a NEW row and the old row was preserved (a "mergeable
     duplicate" was the documented trade-off; PR #104 fixed it only for
     lead-linked patients via `fromLead`);
   - **identical-key duplicates were indistinguishable** (the אלה פליישר ×3
     case) — the ✕ button deleted ALL rows sharing the key at once;
   - the discharge-audit row was keyed by the session id, so a second
     discharge in the same session could overwrite the first one's audit row,
     while across sessions it could not — inconsistent by accident.

## What changed

### Backend — `apps-script/Code.gs`

**Schema (append-only; a live sheet's header is extended non-destructively by
`getOrCreateSheet_`, nothing is moved):**

- `PATIENT_COLUMNS` gains **`id`** as the LAST column. Opaque `id-…` text —
  no Sheets coercion risk, so no whole-column format is needed.
- `PATIENT_TOMBSTONE_COLUMNS` (own literal list, per the merge-don't-drop
  contract) gains `id` LAST, after the metadata, so the live tombstone sheet's
  layout is untouched. Every tombstone written from now on carries the
  row's id (`appendPatientTombstones_` maps by name).
- `DISCHARGED_PATIENT_COLUMNS` is now built from `PATIENT_COLUMNS` **minus
  `id`**, so the discharged sheet's positional layout is **byte-identical** to
  before (readSheet_ maps by position — inserting a column mid-list would
  have shifted `dischargedAt…prior_status` on the live sheet). Its leading
  `id` remains the audit row's own key.

**Identity rules (all locked by tests):**

- **Minted server-side** for any row that lacks one:
  - `getData_` → new `backfillPatientIdsLocked_`: on the first read after the
    column lands, every content row with a blank id gets `id-<uuid>` via the
    existing `backfillMissingIds_` (the Leads precedent). It takes the script
    lock **only when there is something to fill**, so it can't race a saveAll
    rewrite; in the steady state it performs ZERO writes and takes no lock.
    Ids returned to the client are the ones now on the sheet.
  - `replaceHousePatients_`: every row it writes gets an id (adopted or
    minted); preserved (omitted) rows that still lack one are minted too, so
    the sheet converges through ordinary saves. The tombstone carries it.
- **Adopted from the client** for a genuinely new row that carries one
  (the client already stamps `cryptoId()` on every admission/promotion), so
  the tab and the sheet agree immediately, no reload needed.
- **Immutable** once on a row: a payload row that matches an existing sheet
  row keeps the SHEET's id whatever the payload carried — a stale tab's
  session id never overwrites a persisted one, and an id-only difference is
  not an edit (`patientRowDiffCols_` skips `id`, so it never shows up in
  `patient_edited.changed`).
- **Unique** across the whole sheet: an incoming id already held by another
  row (a **house move** — the old house's row is kept by merge-don't-drop and
  keeps the id; a duplicated client object; an id whose row this save already
  consumed) is **re-minted** for the incoming row and audited
  `patient_id_reminted` (`incomingId`, `newId`, `via`).

**`replaceHousePatients_` match order (was: key only):**

1. **ID MATCH** — the payload's id names an unconsumed row of THIS house →
   that row is replaced in place **whatever its name / entry date say**. A
   rename or an entry-date edit is now an in-place update for EVERY patient,
   hand-entered included. Audited `patient_rekeyed_via_id` (`id`, `oldKey`,
   `newKey`, `changed`) when the key changed, `patient_edited` otherwise.
2. **KEY MATCH** — unchanged fallback (`patientKey_`), with two refinements:
   the queue skips rows already consumed by an id match, and skips rows whose
   id **another** payload row claims (they are *reserved* for that id match —
   so a stale copy under the old key and the renamed row under the new key
   both land, nothing is silently swallowed).
3. **Append paths** (suppressed-delete, `fromLead` rename-in-place, the
   promotion dedupe guard, plain append) — unchanged logic; the `fromLead`
   rename branch also honours reservations; every path assigns an id and the
   audit details now carry it.

The identical-key dedupe (`findDuplicatePatientKeysNow`,
`collapseDuplicatePatientKeysNow`, the save-time twin drop) still treats rows
that differ **only in id** as byte-identical — backfilling distinct ids onto
the repaired-twin duplicates does not resurrect them.

**`deletePatientRow_` (action unchanged, payload gains optional `id`):**

- `patient.id` given and held by a row **of the given house** → EXACTLY that
  row is deleted (`matchedBy: 'id'`). One of several identical-key duplicates
  can now be removed on its own — the ✕ no longer takes all three.
- An id seen only in ANOTHER house, or not on the sheet (stale tab,
  pre-foundation row) → the legacy key path, unchanged. **Never a cross-house
  delete.** No key match either → `patient_not_found`, nothing touched.
- Tombstone-first / fail-hard / write-then-trim / lock contract unchanged.
  Response gains `id` + `matchedBy`; the `patient_deleted` audit carries both.

**Surface:** `handle_`'s action allow-list is untouched (guard-tested). The
backfill is internal to `getData`. No `server.js` change — `id` rides the
existing session-gated `/api/sheets` proxy inside the same payloads.

### Frontend — `public/app.js` (state plumbing only)

- `normalizePatient` already picked `id` from the row → the persisted id now
  round-trips through `parsePatients` on load; `serializePatients` already
  sent it → saveAll carries it. **No code change needed there** (locked by
  test so it can't regress).
- `deletePatient` sends `id` alongside the identity key.
- `dischargeAuditRow` mints a **fresh audit id** per discharge (`cryptoId()`)
  instead of spreading the patient's id. Now that the patient id survives
  reloads, reusing it would make a second discharge after a restore upsert
  over the first discharge's audit row (`upsertRowById_`) and erase that
  history. The audit ↔ patient link stays the houseId+name+date key the
  restore flows already use (`matchActivePatientIndex`); linking by id is
  the follow-up.
- `patientKey(p)` (payments / billing overrides) is **deliberately unchanged**:
  every existing payment and override row is keyed on the name triple; moving
  them to the id is a keyed migration for a later PR. Comments updated.

### Weekly healthcheck — `scripts/healthcheck.js`

- `PATIENT_COLUMNS` mirror gains `id` (the sync test enforces it).
- `warnBlankIds` now also warns on a blank **patient** id, by house +
  position (never by name). A warning only — never a critical.

## Accepted trade-offs (documented, locked by test)

- A payload row **without** an id (legacy tab, cross-app writer) whose name or
  entry date was edited still lands as an appended row with the old row
  preserved — exactly today's behavior. Only id-carrying payloads get the
  in-place update.
- A **house move** still yields the old row preserved in the old house (with
  its id) and a new row in the new house (re-minted id). Same as today, now
  audited. An id-based cross-house move is the follow-up.
- A tab loaded **before** the first post-deploy `getData` holds session ids;
  its saves key-match and keep the sheet ids; it converges on the next load
  (the visibilitychange reload covers refocused tabs). Its ✕ falls back to
  the key path (legacy semantics) until then.

## Tests — `test/patient-identity-foundation.test.js` (25 new)

vm-sandbox on the real shipped `Code.gs` / `app.js`, per repo convention:
schema prefixes byte-for-byte + `id` last + discharged layout unchanged +
non-destructive header extension; getData backfill (unique, persisted ==
returned, lock taken only when needed, zero writes afterwards, empty rows
skipped); id-match rename / entry-date edit in place with audit; edit vs
id-only difference; key-match keeps the sheet id; adopt vs mint; house-move
re-mint + audit; duplicate id in one payload; reservation; preserved-row
minting into the tombstone; dedupe still byte-identical across ids; legacy
(no-id) payload unchanged; delete by id / by key / unknown id / cross-house
refusal; no new action; client round-trip, serialize, fresh audit id,
delete payload; healthcheck warning.

Three existing tests updated for the new semantics (the audit row now carries
its own id; healthy healthcheck fixtures carry a patient id; the nightly
integrity column pin gains `id`). **Full suite: 818 passing, 0 failing**
(793 + 25).

## Security

- No new endpoint, no new parameter reaches a sheet unvalidated: `id` is
  string-coerced and trimmed, used only for equality matching, and a delete
  by id is scoped to the requested house.
- Backfill writes happen under the script lock; audit writes stay fail-soft;
  tombstones stay fail-hard before any destructive step.
- No secrets, no PII in logs beyond what the existing audit trail already
  carries (patient name), and ids are opaque UUIDs.

## Deploy / run order (Sandra)

Nothing manual. `Code.gs` deploys via the clasp CI on merge; the frontend via
Railway. On the **first `getData` after deploy** the Patients sheet's header
gains `id` and every row is backfilled (one-time, under lock). Verify on the
live app: DevTools → Network → `sheets?action=getData` → every patient has an
`id-…` id, and the Patients sheet shows the new last column. Both consumers
of the shared backend (Dashboard + ezone-managers) see the same ids.

Recommended (not required): run `findDuplicatePatientKeysNow` →
`collapseDuplicatePatientKeysNow` from the Run dropdown (PR #110) before or
after — order doesn't matter; the dedupe ignores ids.
