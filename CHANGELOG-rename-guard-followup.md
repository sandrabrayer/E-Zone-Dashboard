# Rename handling for lead-linked patients — follow-up to PR #103

## Phase 1 findings (read-only verification)

The concern was real: **PR #103's dedupe guard silently dropped legitimate
renames of lead-linked patients.**

1. **`promoteSkipped` was not read anywhere in `public/app.js`.** The only
   save-response handling was `maybeResyncPreservedPatients(res)`, which
   inspects `preserved` and `deletedSuppressed` only. No toast, no error —
   a refusal was invisible.
2. **The edit-modal rename DID trip the guard.** `openEditPatientModal`
   mutates `p.name` in memory; `saveAll` serializes the whole house, so the
   payload carries the renamed row under a NEW identity key
   (`houseId::name::entryDate`) — an append from the server's point of view,
   carrying the patient's existing `fromLead` — and OMITS the old-name row.
   The guard refused the append (`existing_patient_row`; its fromLead index
   spans the whole sheet, same house included). What Vered experienced: the
   modal reported success; the omitted old row came back in `preserved`,
   which fired only the generic stale-data resync toast
   ("זוהה מידע לא מעודכן") and a reload — the name snapped back. The rename
   was lost with no honest signal.
3. **entryDate edits — identical mechanism** (the date is part of the
   identity key), identical silent loss.
4. Extra finding: a **house-move** via the edit modal also changes the key
   (houseId is in it) and also carries the existing `fromLead`, so it was
   refused the same way — and remains refused by design (see below), now
   with an explicit error message instead of silence.

Conclusion: Phase 2 behavior changes required.

## Phase 2 — the fix

### Server (`replaceHousePatients_`): rename vs duplicate

A fromLead-carrying append is now resolved in order:

1. **Same-house match → UPDATE IN PLACE.** An unconsumed sheet row in the
   SAME house carries that `fromLead` (and its own key is not claimed by
   another payload row — a guard against double-consuming when a payload
   carries both rows of a pre-existing duplicate): the existing row is
   overwritten with the incoming row (name, entryDate, all fields) and
   audit-logged as **`patient_renamed_via_fromLead`** with
   `oldName`/`newName`/`oldKey`/`newKey`. The old row is *consumed*, so it
   is neither preserved nor tombstoned and no resync fires — the rename
   just lands. **Ambiguity** (two pre-existing rows with the same
   `fromLead`, the הדס state): the FIRST match in sheet order is updated —
   deterministic, never both — and the audit details carry
   `matches: N, ambiguous: true`.
2. **Cross-house match (or a row appended earlier in the same save) →
   still refused** (`promote_skipped_duplicate`, `existing_patient_row`) —
   the true duplicate-promotion signature. This intentionally covers the
   edit-modal house-move of a lead-linked patient too; it now surfaces as
   an error message client-side rather than silently reverting.
3. **Discharged-non-restored → still refused**
   (`discharged_not_restored`); `restored='TRUE'` still re-promotes.

Documented residual trade-off: the server cannot distinguish a same-house
rename from a same-house *stale re-promotion* (the original הדס mechanism)
— both arrive as the same payload shape. Rule 1 means such a stale
re-promotion now lands as an in-place update (possibly overwriting
pay/status with fresh-trial values) instead of being refused. It still
cannot create a duplicate row, and the `patient_renamed_via_fromLead`
audit row records old→new for recovery. This is the trade chosen: Vered's
edits always land; the sheet never grows a second row per lead.

### Client (`public/app.js`): refusals are never silent

New pure helper `promoteSkippedMessage(res)` — returns
`שורה לא נשמרה — כפילות זוהתה: <names>` when the saveAll response carries a
non-empty `promoteSkipped`, `null` otherwise (tolerant of old backends
without the field). `saveAll` routes every response through it and calls
the existing `showError` banner when non-null. No other UI changes.

## Tests

`test/rename-guard-followup.test.js` — 8 tests (vm-sandbox on the shipped
sources): rename-in-place with full edit-modal-shaped payload (nothing
preserved, all fields overwritten, audit row), entry-date edit in place,
cross-house refusal, discharged refusal + restored=TRUE re-promotion,
ambiguity targets first match only, key-claimed rows never double-consumed,
`promoteSkippedMessage` pure cases, source-scan that `saveAll` surfaces
refusals via `showError`.

`test/audit-log-dedupe.test.js` — the same-house skip test from PR #103 is
rewritten to pin the new in-place-update behavior; every other #103 test
(cross-house, discharged, within-payload dedupe, fail-soft logging, pinned
column order, read-only scanner) passes unchanged.

Full suite: **743/743 pass** (`node --test`).

## Deploy

Based on PR #103's branch (`claude/ezone-audit-dedupe-guard-tink2q` — #103
was not yet merged when this was written). `apps-script/Code.gs` deploys
automatically via clasp CI on merge to `claude/build-ezone-dashboard-QOg5s`;
`public/app.js` ships with the Railway deploy. No manual steps.
