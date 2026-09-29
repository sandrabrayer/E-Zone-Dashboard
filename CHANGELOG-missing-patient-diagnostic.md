# CHANGELOG: a missing ramot patient, the fix, and a read-only diagnostic

## Symptom

A patient in house רמות השבים (`ramot`) disappeared from the Dashboard UI.

## What this PR does

1. **Traces every code path** that can hide or drop a patient between the
   sheet and the ramot house tab. The findings table, with `file:line`
   references, is in `docs/missing-patient-investigation.md`.
2. **Fixes the one real code bug** the trace found. A patient who was
   deliberately set back to live was silently released again on the next
   load (see below).
3. **Adds a read-only diagnostic**, `diagnoseRamotPatientsNow()`, to find out
   which data state this particular patient is in.

No production data is written by this PR. The fix changes only how the app
writes from now on. The diagnostic is read-only by construction and by test.
Sheets headers are untouched.

## The bug (fixed, `public/app.js` only)

`healClobberedDischarges()` runs on every load: on reload, and on every tab
refocus at least 60 seconds after the last load. It flips the **first**
patient whose house + name + entry date matches a discharge audit row that is
not restored (`restored` is not TRUE) back to `released`, and persists that
change. Released patients are hidden from the house tab by default. The heal
is meant to repair a discharge that a stale tab clobbered. But it reads only
the audit row's `restored` flag, so it cannot tell a clobber from a patient
someone put back to live on purpose.

Four deliberate paths left that flag unset, so the patient came back for one
load and then vanished again with no error:

- ✏️ **Edit patient**, status שוחרר → פעיל / הפסקה זמנית (the modal offers
  both to a released patient);
- **Direct re-add** with the original entry date. The new row is written
  first in the house, so it is the heal's first match;
- **Admission** (entry modal) with that same entry date;
- **שחזר → החזרה לסטטוס הקודם** when the stay had a **second** open audit
  row. Only the clicked row was flagged.

### Fix

- Every one of those writes now flags **all** open audit rows for the stay
  `restored='TRUE'`, right after its `saveAll`. It uses the existing
  `restorePatientToActive` action with the same payload the restore modal
  already sends. **No backend change.** The audit rows are kept as the trail.
  New pure helpers: `openDischargeAuditsFor`, `reopenedDischargeAudits`,
  `withAuditsRestored`, `persistAuditsRestored`.
- If the flag write fails, the UI rolls back and shows the error. The next
  load's heal then brings the sheet back in line with the rolled-back UI. This
  is the same failure behavior the restore modal already has.
- The heal is no longer silent. When it releases anyone on load, a toast
  names them: «סומנו כמשוחררים לפי רישום שחרור פתוח: …».
- A genuine clobber is still healed exactly as before. Saves that re-activate
  nothing send no extra writes.

The comment on `doRestorePatientToActive` called the restored flag "cosmetic".
It is not: an open audit row is exactly what the heal acts on. The comment is
corrected.

## The diagnostic: `diagnoseRamotPatientsNow()` (`apps-script/Code.gs`)

It runs from the Apps Script editor, is **read-only**, and writes nothing:

- tabs are opened with `getSheetByName` only. It never calls
  `getOrCreateSheet_`, which can insert a tab, extend a header row or
  re-format columns;
- cells are read with `getValues`;
- it takes no lock, writes no AuditLog row and sets no Script Property;
- it is not reachable over HTTP. `handle_`'s action allow-list never names it.

It logs to the Executions log:

| Section | What it lists |
|---|---|
| **(0)** | Each tab's header row compared with the columns the app reads it with. The app reads every tab **by position**, so a column inserted by hand misreads every field. Drift is reported with the exact column. |
| **(a)** | **Every row whose house is ramot in any form:** the id `ramot`, the label רמות השבים, and padded, cased, invisible-mark, NBSP, hyphenated, short or U+FFFD-damaged variants. It covers **Leads, Clients** (only if such a tab exists; `CLIENTS_HEADERS` is ezone-outpatient's sheet, not this app's, so it is read by its own header), **Patients, מטופלים משוחררים, לידים לא רלוונטיים, לידים שהוסרו**, plus **PatientsTombstones** (recovery copies of deleted or de-duplicated rows; the many "kept" audit copies are summarized per name) and **Outpatients** (`house_of_origin`). Each line gives: tab, row, id, name, normalized phone (Patients rows have no phone of their own, so it is recovered through `fromLead`), stage/status, disposition, dischargedAt, restored (with its type: boolean vs `'TRUE'`), removedAt, plus entry/exit dates, fromLead and who/when. Patients rows with **no house at all** are listed too, because `getData_` drops them. |
| **Verdict** | Every Patients line ends with what the Dashboard actually does with the row: `VISIBLE in the ramot tab`, `HIDDEN — status … reads as released`, `HIDDEN — the app resolves house … to …`, `DROPPED by getData_ (blank houseId)`, or `VISIBLE NOW, BUT the OPEN discharge record (…) matches it — the next load's heal will mark it released`. Every discharge line says whether it is open and which Patients row the heal would act on. The verdict logic is pinned by test to the app's own `resolveHouseId` and `normalizeStatus`. |
| **(b)** | Every row in **any** tab whose name holds U+FFFD, with tab, row and column (capped at 200 per tab, with the count). |
| **(c)** | Every id or normalized phone (dashes, `+972` and a leading 0 dropped by Sheets are all normalized) seen **more than once**, in one tab or across tabs. Also the ramot identity-key twins and `fromLead` twins in Patients, which the heal and the ✕ key-delete cannot tell apart. |
| **(d)** | One **SUMMARY** line: ramot counts per tab and per status/stage, and how many ramot rows the tab shows, hides as released, hides for an unresolvable house, or is about to release. |

Invisible characters are printed escaped (for example `"ramot\u200f"`) so
they can be seen in the log. The log contains patient names and phones
because that is its purpose. It stays inside the Apps Script project's
execution log.

## How to run it

1. Merge the PR into `claude/build-ezone-dashboard-QOg5s`.
2. Open GitHub → **Actions** → wait for the **"Deploy Apps Script"** run on
   that merge commit to go **green**. It pushes `apps-script/**` with clasp and
   republishes the existing deployment, so the `/exec` URL is unchanged.
3. Open the Apps Script project (the CI/live "ezone dashboard", the scriptId
   in `.clasp.json`). In the function dropdown, pick
   **`diagnoseRamotPatientsNow`** → **Run**. If Google asks for authorization,
   it is for the spreadsheet scope the project already uses.
4. **View → Executions log** (or the log panel under the editor). Copy
   everything from `diagnoseRamotPatientsNow — READ-ONLY` down to the
   `(d) SUMMARY ramot` line.

### Reading the result

- Look for the missing patient's name in **(a)**. The `DASHBOARD:` verdict on
  its Patients line says why it is not in the tab.
- `HIDDEN — status "released"` together with a `מטופלים משוחררים` line on the
  same stay: it was discharged, or it is this bug. Check `updatedAt` /
  `updatedBy` on the Patients line against `dischargedAt` on the audit line.
- A `PatientsTombstones` line with `reason "user-delete"`: it was deleted with
  ✕. The tombstone holds the full row.
- `[NO HOUSE]` / `HIDDEN — the app resolves house …`: the house cell was
  edited by hand. The escaped value shows the offending character.
- Name missing from (a) altogether: search (b) and (c) for the phone or the
  id, or look for `header DRIFT` in (0).

## Tests

- `test/missing-patient-reactivation.test.js` (15 tests). End to end: the real
  `app.js` runs against the real `Code.gs` over fake sheets, so "the next load"
  is a genuine `getData` round-trip. It covers all four paths, a U+FFFD name,
  repairing a damaged name in the same save, house-label and padded variants,
  no extra writes on ordinary saves, a genuine clobber still being healed (and
  now announced), and the rollback when the flag write is refused. Against the
  pre-fix `app.js` the end-to-end tests fail: the patient is gone after the
  next load.
- `test/missing-patient-diagnostic.test.js` (20 tests). It **source-scans**
  `diagnoseRamotPatientsNow` for `setValue`/`setValues`/`appendRow`/`deleteRow`/
  `insertRow`/`clear`, **and every Code.gs helper it reaches** for any mutator,
  lock, property or sheet-creating call. It also **runs** the function against
  a spreadsheet whose every non-read method throws: zero attempts. Further
  tests cover each section on synthetic Hebrew data, the HTTP non-exposure,
  and pins of its verdict logic to `app.js`.
- `test/date-format-he.test.js`: the exact `v16` service-worker pin is relaxed
  to `>= v16`, the same way `sw-install-fix.test.js` relaxed `v15`.

## Service worker

`public/app.js` changed, so `CACHE_VERSION` goes **v16 → v17**. The comment
line for the bump is in `public/sw.js`.

## Not changed (follow-ups; see the investigation doc)

- `resolveHouseId` does not strip invisible marks or NBSP. The server's save
  partition compares houses strictly, so the fix has to happen on both sides
  at once, and only after the diagnostic shows whether any such cells exist.
- The 24-hour delete suppression is by key. It could suppress only the
  deleted row's id.
- The collapse tool's keep rule ignores status.
- The legacy promote guard matches house + name without the entry date.
