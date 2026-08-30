# Patients merge-don't-drop — stale tabs can no longer delete patient rows

The Patients sheet was written by `saveAll`'s WHOLE-HOUSE REPLACE
(`replaceHousePatients_`): every save rewrote each house from the saving tab's
in-memory list, which is loaded ONCE per page life. A stale session (second
tab, PWA resumed from background) that saved anything — including the
automatic `autosaveMeetingWithDefaults` fired from `renderAll` — silently
dropped every patient admitted after that tab loaded. Leads were already safe
(`mergeLeads_` preserves rows absent from the payload); patients were not, and
a dropped row left no audit trace anywhere except Sheets version history (the
ActivePatients digest rebuilds right after the same save, so it propagated the
loss instead of preserving a copy). This is the Dashboard's variant of the
outpatient `_saveAll` clobber.

## What changed

### `apps-script/Code.gs`

- **`replaceHousePatients_` now MERGES instead of replacing** (merge-don't-
  drop), keyed on the identity triple `houseId::name::entryDate` (new
  `patientKey_` — the same triple `matchActivePatientIndex`, the discharge
  heal, and `digestPatientKey_` already treat as row identity; the Patients
  sheet has no id column):
  - payload row matches a sheet row → replaced (edits/status flips/exitDate
    behave exactly as before, per-row last-writer-wins);
  - payload row matches nothing → appended (admission);
  - **sheet row absent from the payload → KEPT.** Genuine deletion now goes
    through the dedicated `deletePatientRow` action (below) and discharge is a
    status flip, so a saveAll omission is never a legitimate deletion — it is
    a stale tab. Duplicate keys consume one payload row per sheet row, in
    sheet order.
  - Accepted trade-off (locked by test): renaming a patient or editing their
    entry date changes the identity key, so the old row is preserved and the
    edit lands as a new row — a visible, mergeable duplicate instead of a
    silent loss. An id column was deliberately NOT added in this PR;
    `PATIENT_COLUMNS` is untouched.
- **Permanent delete became a dedicated action** — the occupancy tab's ✕
  button used to delete by OMISSION (drop from the client list, let the
  whole-house replace lose the row), which the merge closes. New
  `deletePatientRow` action mirrors `removeLead_`'s safe sequence, keyed by
  `patientKey_`: peek (unknown key → refuse, touch nothing) → tombstone the
  matched row(s) with `reason: 'user-delete'` **before** the delete,
  FAIL-HARD (an audit failure aborts the delete; nothing is ever destroyed
  without its recovery copy) → rewrite kept rows, trim the tail. Under the
  script lock; duplicate identity keys delete all matching rows.
- **Anti-resurrection guard** — a stale tab still carrying a deleted patient
  would re-append them on its next save. The merge now DROPS an incoming
  payload row whose identity key has a `user-delete` tombstone younger than
  `USER_DELETE_SUPPRESS_MS` (24h) and no current sheet row; dropped keys are
  echoed under `deletedSuppressed` and excluded from `written` (so a
  sent-vs-written mismatch in the server diagnostics is explained by the
  recorded response). The Patients sheet has no per-row edit timestamp, so
  the requested "tombstone newer than the row's last edit" rule is
  approximated by this time bound: fresh tombstone → no resurrection; after
  24h (or with a different entry date, or once the key is deliberately back
  on the sheet) a re-add works again. The key scan is FAIL-OPEN — an
  unreadable tombstone sheet can never fail a save or permanently block a
  key.
- **New append-only `PatientsTombstones` audit sheet** — before the rewrite,
  every omitted-but-kept row is copied there (full row snapshot + `droppedAt`
  ISO timestamp, `reason: 'saveAll-omitted-preserved'`, `savedByAction`).
  Own literal header list (`PATIENT_TOMBSTONE_COLUMNS`), deliberately not
  derived from `PATIENT_COLUMNS` via concat, so a future column append can't
  shift the audit columns. `date`/`droppedAt` are whole-column text-forced at
  sheet-ensure time (same coercion guard as `waitlistedAt`). The write is
  FAIL-SOFT: an audit failure never blocks the save (the rows are kept on the
  Patients sheet either way). Runs inside `saveAll_`'s existing script lock —
  lock scope unchanged.
- **`saveAll_` response gains `preserved`** — `{houseId: [identityKeys]}` for
  every house where the merge kept rows the payload omitted (houses with
  nothing preserved are absent). The `written` per-house echo keeps its
  existing server-diagnostics contract (payload row counts).
- **Write-then-trim replaces clear-then-write** in `replaceHousePatients_`,
  `mergeLeads_`, and `deleteRowsById_`: the final row set is written first,
  then only the surplus tail rows are cleared. A crash between the two steps
  can leave duplicate tail rows (visible, fixable) but can no longer empty a
  sheet. `clearBody_` is removed; a source-scan test keeps it from returning.
  (Under the merge the Patients sheet never shrinks through saveAll, so its
  trim is a pure safety net.)
- Digest note: `refreshDigestBestEffort_` still runs after `saveAll_` and now
  reads the MERGED sheet, so preserved active residents stay in the
  ActivePatients digest instead of vanishing from it (locked by test). No
  digest consumer change.

### `public/app.js`

- **Preserved-rows resync** — `saveAll` hands the backend response to
  `maybeResyncPreservedPatients`: a non-empty `preserved` OR
  `deletedSuppressed` map means THIS tab's memory is stale by definition, so
  it shows a toast and reloads from the sheet (`loadAll`) instead of trusting
  memory. Guards: re-entry flag + 30s floor between resyncs. A pre-deploy
  backend response (neither field) is a no-op.
- **`deletePatient` (✕ מחק לצמיתות)** posts the dedicated `deletePatientRow`
  action and removes the row from local state WITHOUT a full `saveAll` — the
  action is the whole delete; failure rolls the optimistic removal back.
- **Visibility resync** — the app loads data once per page life, so a
  `visibilitychange`→visible listener now refreshes from the sheet when a tab
  or PWA comes back to the foreground. Guards: skipped while any save is in
  flight (new `_savesInFlight` counter around `saveAll`'s network call), and
  floored at 60s since the last load start. Every edit persists immediately
  via `saveAll`, so in-memory state is never legitimately ahead of the sheet
  outside an in-flight save — reloading loses nothing. This also naturally
  shrinks the window for the inverse (out-of-scope) bug where a stale tab's
  `mergeLeads_` payload resurrects a closed lead.

### Tests

- New `test/patients-merge-dont-drop.test.js` (vm-sandbox on the real shipped
  sources, per repo convention): merge keeps omitted rows / replaces matched /
  appends new; other houses and absent houses untouched; empty stale save
  can't wipe a house; rename-duplicate trade-off locked; tombstone snapshot +
  metadata + fail-soft; write-then-trim ops order for `deleteRowsById_` and
  `clearBody_` source-scan; digest reads the merged sheet; client resync
  predicate + source-scans for both C2 guards.
- `test/write-handoff-diagnostics.test.js` updated for
  `replaceHousePatients_`'s new `{written, preservedKeys}` return and the
  `preserved` echo (the `written` counts contract is unchanged).
- Delete coverage: delete → `user-delete` tombstone written BEFORE the row
  disappears (cross-sheet ops-order assert) + row gone; unknown key refused
  untouched; tombstone failure aborts the delete; a stale saveAll carrying
  the deleted key does NOT resurrect it (`deletedSuppressed` echo, honest
  `written`); an expired tombstone stops suppressing (deliberate re-add
  works); `deletePatient` source-scan (dedicated action, never saveAll).

## What did NOT change

- `PATIENT_COLUMNS`, the script-lock scope, and the explicit lead delete/move
  flows (`removeLead` / `moveLeadIrrelevant` / `restoreLead`) — all untouched.
- Server proxy contract: `written` still compares sent-vs-acknowledged counts.
- Out of scope, deliberate: a persisted patient id column (would remove the
  rename-duplicate trade-off; larger migration) and a dedicated fix for
  stale-tab lead resurrection beyond what the visibility resync gives.

## Recovery story after this change

A patient row omitted by a stale save is (1) still on the Patients sheet,
(2) echoed to the saving client, which resyncs, and (3) recorded on
`PatientsTombstones` with a timestamp — a durable, queryable trace that no
longer depends on Sheets version history.
