# Missing ramot patient — investigation (29/09/2026)

**Report:** a patient in house רמות השבים (`ramot`) disappeared from the
Dashboard UI.

**Scope:** every code path between the live spreadsheet and the ramot house
tab (תפוסה → רמות השבים) that can hide or drop a patient row. No production
data was read or written for this investigation. The data-level half of the
answer comes from the read-only diagnostic `diagnoseRamotPatientsNow()` that
ships in the same PR. See `CHANGELOG-missing-patient-diagnostic.md` for how to
run it.

No patient name, phone or id appears in this document. Every example is
synthetic.

---

## Result

One real code bug was found and fixed. It hides an **active** patient with no
error and no toast, and it undoes itself on every retry:

> **The load-time discharge heal re-released patients who had been deliberately
> set back to live.** `healClobberedDischarges()` (`public/app.js:1320`) runs on
> every load: every full reload, and every tab refocus at least 60 seconds
> after the last load (`public/app.js:970`). It flips the **first** patient
> whose house + name + entry date matches a discharge audit row that is not
> restored back to `released`, and `loadAll` then persists that change. Released
> rows are hidden from the house tab by default. The heal reads only the audit
> row's `restored` flag, so it cannot tell a clobbered discharge from a patient
> who was put back to live on purpose. Four deliberate paths left that flag
> unset:
>
> | Path | Where | What happened |
> |---|---|---|
> | ✏️ edit modal, status שוחרר → פעיל / הפסקה זמנית | `openEditPatientModal`, `public/app.js:5019` (status options at `:5020`, which offer פעיל/הפסקה זמנית to a released patient) | The status flip was saved and the discharge audit row stayed open. On the next load the heal released the patient again. |
> | Re-adding the patient with the original entry date | `openDirectAddPatientModal`, `public/app.js:4952` | The new row is written first in the house (`replaceHousePatients_` writes rows in payload order, and the new patient is `unshift`ed to the front). The heal's first match is therefore the new active row, and the heal released it. |
> | Admitting a lead with that entry date | `openEntryModal`, `public/app.js:4877` | Same mechanism as the re-add. |
> | Restore when the stay has a second open audit row | `doRestorePatientToActive`, `public/app.js:4356` | Only the clicked audit row was flagged, so the second open row released the patient again. |
>
> **Fix** (client only, no backend change). Every one of these writes now closes
> all open audit rows for the stay, using the existing `restorePatientToActive`
> action and the same payload the restore modal already sends. The rows are
> found by the new pure helpers `openDischargeAuditsFor` (`:4224`) and
> `reopenedDischargeAudits` (`:4236`), and flagged by `withAuditsRestored`
> (`:4253`) and `persistAuditsRestored` (`:4263`). The heal is also no longer
> silent: `loadAll` shows a toast naming every patient it moves to released
> (`public/app.js:1145`). A genuine clobber is still healed exactly as before.
>
> **Proof.** `test/missing-patient-reactivation.test.js` runs the real `app.js`
> against the real `Code.gs` over fake sheets, so "the next load" is a genuine
> `getData` round-trip. On the pre-fix `app.js`:
>
> ```
> edit   | visible after save: true | visible after NEXT load: false | sheet status: ["released"]
> readd  | visible after save: true | visible after NEXT load: false | sheet status: ["released","released"]
> ```
>
> With the fix:
>
> ```
> edit   | visible after save: true | visible after NEXT load: true | sheet status: ["active"]
> readd  | visible after save: true | visible after NEXT load: true | sheet status: ["active","released"]
> ```

The code alone cannot tell whether this bug is what happened to this
particular patient. The other candidates below are data states, not code bugs,
and the diagnostic reports every one of them.

---

## Root-cause candidates, most likely first

| # | Candidate | Code | Silent? | How the diagnostic shows it |
|---|---|---|---|---|
| 1 | **The heal re-releases a deliberately re-activated patient** (✏️ re-activation, a re-add or admission with the original entry date, a second open audit row). **Fixed in this PR.** | `public/app.js:1320-1336`, match at `:4111`. Triggers: `:5058`/`:5063`, `:4993`, `:4910`, `:4364` | Yes. Before this PR the only trace was `console.log`. | A (a) Patients line reading `HIDDEN — status "released"`, together with a `מטופלים משוחררים` line reading `OPEN — matches Patients row N`. A live row about to be flipped reads `VISIBLE NOW, BUT … the next load's heal will mark it released`. |
| 2 | Discharged on purpose by someone else, or the status was changed. Not a bug. | `dischargePatient`, `public/app.js:5234`; edit modal, `:5058` | No. It is a user action. | The Patients row's `status` / `exitDate` / `updatedAt` / `updatedBy`, plus the audit row's `dischargedAt` / `disposition`. |
| 3 | Permanently deleted with ✕, or re-added within 24 h of a delete with the same house + name + entry date: the re-add is dropped by the delete suppression. | `deletePatientRow_`, `Code.gs:2210`; suppression at `Code.gs:2020` | The delete asks for confirmation. A suppressed re-add only shows a generic "מרענן נתונים" toast. | A `PatientsTombstones` line with `reason "user-delete"`, `droppedAt` and the deleter in `updatedBy`. |
| 4 | The house cell is not a value the app resolves. A blank cell is dropped by `getData_`. An invisible mark (RLM/LRM/ZWSP), an NBSP, a double space or a short label like "רמות" stays unresolved and matches no tab. | `Code.gs:1282`; `resolveHouseId`, `public/app.js:1407-1416` | Yes | `[NO HOUSE]` → `DROPPED by getData_`, or `[variant]`/`[corrupted]` → `HIDDEN — the app resolves house …`. The raw value is printed with invisible characters escaped (`"ramot\u200f"`). |
| 5 | Same-key twins: two rows with the same house + name + entry date. The heal acts on the first one, ✕ by key removes all of them, and the editor-run collapse keeps the first row that has a `fromLead`, whatever its status. | `public/app.js:1325`; `Code.gs:2245`; `dedupeKeepIndex_`, `Code.gs:2896` | Yes | `(c) ramot IDENTITY-KEY twins … row 2 ("active"); row 12 ("released")`. |
| 6 | A write refused by the server's promotion guards: re-admitting a lead that is already on the sheet, a lead with an open discharge, or a house move of a lead-linked patient. The optimistic row stays in the tab until the next load, then disappears. | `Code.gs:2051`, `:2056` | A 6-second error toast is shown. | The lead's `stage` and the Patients rows sharing its `fromLead` (`(c) fromLead twins`). |
| 7 | Header drift: a column inserted or moved by hand in the sheet. The app reads every tab by position, so every field under the header is misread, including `status` and `houseId`. | `readSheet_`, `Code.gs:1059` | Yes | `(0) <tab>: header DRIFT — col N expected "…" found "…"`. |
| 8 | A U+FFFD-damaged name. The row still renders, but search and exact-name matches (restore, heal, payments) miss it. | Search at `public/app.js:5100`; match at `:4111` | Partly | Section (b) lists every such row in every tab. |
| 9 | A legacy `entry`-stage lead whose house + name, with no date, matches an open discharge is never auto-promoted. | `promoteEnteredLeads`, `public/app.js:1219` | Yes | The lead's `stage "entry"` next to an OPEN audit row with the same name. |

---

## The data path, step by step

`file:line` references are to this branch. For each step, the table lists
everything that can make a ramot patient disappear.

### 1. Backend read: `getData_` (`apps-script/Code.gs:1231`)

| Step | Code | What can drop or hide a patient |
|---|---|---|
| Open the six tabs | `getOrCreateSheet_`, `:953` | Nothing is dropped. It can extend a header row, which is one reason the diagnostic never calls it. |
| Backfill blank ids | `backfillMissingIds_`, `:2331`; `backfillPatientIdsLocked_` | Writes ids only. No row is dropped. |
| Read rows | `readSheet_`, `:1059` | Rows that are **fully empty** are skipped (correct). The read is **positional**: cell *j* becomes `columns[j]` whatever the header says, so a hand-inserted or moved column shifts every field (candidate 7). The read covers rows 2 to `getLastRow()`, so no data row is skipped by range. |
| Group patients by house | `:1279-1285` | **`if (!hid) continue;` (`:1282`) drops any Patients row with a blank `houseId`.** No tab can ever show it. The grouping key is the raw, untrimmed value, so `'ramot '` and `'רמות השבים'` become separate buckets. The client re-resolves those two, but not invisible characters (step 3). |
| Discharged, irrelevant and removed tabs | `:1264-1266` | Returned unfiltered. The `restored` flag is applied on the client (step 4). |
| "Clients" sheet | none | **Not a Dashboard tab.** `CLIENTS_HEADERS` belongs to ezone-outpatient, and `getData_` never reads a Clients tab. The diagnostic still reads one by its own header if a tab with that name exists. |

### 2. Proxy: `server.js`

| Step | Code | Finding |
|---|---|---|
| The one and only HTTPS reader | `followingRequest`, `server.js:221` | `res.setEncoding('utf8')` is at **`:233`**, before the `'data'` handler at `:235`. PR #102's fix is present. |
| Every caller goes through it | `sheetsGet` `:171`, `sheetsPost` `:186`, `outpatientPost` `:204` | All three are covered. A redirect body is drained with `res.resume()` (`:225`) and never decoded. There is no other `https`/`http` reader. `scripts/healthcheck.js` uses `fetch`, which decodes the whole body at once. |
| Guard | `test/utf8-chunk-fix.test.js:73` | Fails the build if any `res.on('data')` in `server.js` is not preceded by `setEncoding('utf8')`. |
| Pass-through | `GET /api/sheets`, `:578` → `res.json(data)`, `:598` | No filtering and no reshaping. |

**Conclusion:** the proxy cannot introduce new U+FFFD today. Names damaged
between 27/07/2026 and 31/08/2026 can still be in the sheets, and section (b)
of the diagnostic lists them.

### 3. Client ingest: `loadAll` → `parsePatients` → `normalizePatient` (`public/app.js`)

| Step | Code | What can drop or hide a patient |
|---|---|---|
| `parsePatients` | `:1340`, flatten at `:1350` | Drops only entries that are not objects. `houseId` is the row's own value, falling back to the bucket key. |
| `pickField` | `:1796` | Returns `''` when a field is missing, **never `null`**, and never drops a row. |
| `normalizePatient` | `:1928` | Never drops a row. The name is trimmed. The date goes through `isoDate`, which never returns empty for a value that is present. |
| `normalizeStatus` | `:1400`, fallback at `:1404` | An **unknown** status becomes `'active'`, so it can never hide a patient. Only `released`/`שוחרר`/`שחרור` (trimmed, any case) hide one. |
| `resolveHouseId` | `:1407`, fallback at `:1416` | It resolves: trimmed exact id → exact Hebrew label → case-insensitive id. **Anything else is kept as the raw string** and matches no house tab (candidate 4): invisible bidi or zero-width marks, NBSP, double inner spaces, "רמות", "רמות-השבים", a U+FFFD-damaged label. Deliberately not changed here. The server's save partition (`Code.gs:1816`) compares houses strictly, so resolving more variants only on the client would duplicate hand-entered rows on every save. See "Not changed" below. |
| `normalizePhone` | `:1985` | Used only for duplicate-lead warnings and WhatsApp. The Patients tab has no phone column, so nothing is filtered by phone. |
| `serializePatients` | `:377`, guard at `:394` | A patient with a blank or non-string `houseId` is **not sent** on save. The sheet row is untouched, so this is not a loss. An unknown house key is sent as it is (`:417`). |

### 4. Load-time self-heals (`public/app.js`)

| Step | Code | What can drop or hide a patient |
|---|---|---|
| `promoteEnteredLeads` | `:1177`; guards at `:1210` and `:1219` | Auto-promotes only legacy `entry`/`entered` leads. **A lead whose house + name matches an open discharge row is never promoted.** The guard ignores the date (candidate 9). |
| `retireAdmittedLeads` | after promote | Changes lead stages only. It never touches a patient. |
| **`healClobberedDischarges`** | **`:1320`**; restored check at `:1324`, match at `:1325` (`matchActivePatientIndex`, `:4111`), flip at `:1329` | **The fixed bug (candidate 1).** It also acts only on the first match in load order: with same-key twins, discharging one twin releases the other (candidate 5). The persist goes through `loadAll`'s `saveAll`, and the toast at `:1145` is new. |

### 5. Render: the ramot house tab (`public/app.js`)

| Step | Code | What can hide a patient |
|---|---|---|
| Tab count | `houseOccupancyCount`, `:5088` | Excludes `released` and rows whose `houseId` is not exactly `'ramot'`. |
| Rows shown | `visibleOccupancyRows`, `:5096` | `status !== 'released'` unless הצג משוחררים is on. That toggle is session-only and off on every load (`:267`). The `houseId` must be exactly `'ramot'`. The **search box** filters by a name substring (`:5100`): a leftover query hides everyone else, and a U+FFFD name never matches a typed name. The query resets on reload. |
| `renderPatients` | `:5120` | No further filtering. |
| Discharged tab | `renderDischargedPatients`, `:3960`; restored filter at `:3969` | Hides `restored` rows (`'TRUE'` or boolean `true`) from the **discharged** tab only. It never affects the house tab. The flag is checked the same way at `:1200`, `:1324`, `:4187`, `:4227` and `Code.gs:1685`. |

### 6. Writes that move a patient out of the tab

| Path | Code | Effect |
|---|---|---|
| Discharge (dual write) | `dischargePatient`, `public/app.js:5234` → `dischargePatient_`, `Code.gs:4390`, then `saveAll` | Audit row first, then the status flip. If the flip fails, the heal finishes it on the next load. Intended behavior. |
| Restore to active / to lead | `doRestorePatientToActive`, `:4356`; `restorePatient_`, `Code.gs:4420`; `restorePatientToActive_`, `Code.gs:4465` | Flags the audit row `restored='TRUE'`. **It now flags every open row for the stay.** |
| `saveAll` merge | `replaceHousePatients_`, `Code.gs:1786` | Rows left out of a payload are **kept** (merge-don't-drop). It **refuses** a stale edit (`:1969`), a promotion of a lead that is already on the sheet or has an open discharge (`:2051`, `:2056`), and a re-add within 24 h of a user delete (`:2020`). A **byte-identical** same-key leftover is dropped after a tombstone is written (`:2087`), so only true duplicates go. The partition by house is strict: `=== houseId` (`:1816`). |
| Permanent delete ✕ | `deletePatient`, `public/app.js:6370` → `deletePatientRow_`, `Code.gs:2210` | Tombstone first. The id path deletes every row that holds that id in the house (`:2236`). Duplicate ids can only come from rows copied by hand in the sheet. The key path deletes every row with the same key (`:2245`). |
| Soft delete / irrelevant (Phase 2a/2b) | `removeLead_` `Code.gs:4341`, `moveLeadIrrelevant_` `:4286`, `restoreLead_` `:4311` | Touch the Leads tabs only, **never Patients**. A lead in בטיפול פעיל that is closed disappears from the board, but that lead is not a house patient. |
| Editor-run repair tools | `collapseDuplicatePatientKeysNow` `Code.gs:2980` (keep rule `:2896`); `applyCorruptedRowRepairsNow` `:4176` | Run by hand only, and tombstoned first. The collapse keeps the first row that has a `fromLead` **whatever its status**, so it can keep a released twin and drop an active one. A corrupted-twin delete goes by the **corrupted** key (`:4272`), so it cannot remove the clean row. |

---

## The seven questions, answered

1. **`status='released'`, a discharge row, the restored flag.** Released rows
   are hidden by design. The discharge dual-write is ordered so that the audit
   row is durable. **Bug fixed:** a deliberate re-activation left the audit row
   open, and the load-time heal released the patient again. The Phase 2e-2
   restored filter applies only to the discharged tab, and `'TRUE'` and boolean
   `true` are handled the same everywhere.
2. **House value mismatch.** A blank house is dropped server-side
   (`Code.gs:1282`). Trim, the exact label and case are resolved on the client.
   Invisible marks, NBSP, inner double spaces, short or hyphenated labels and
   U+FFFD-damaged labels are **not** resolved, so the patient is hidden. This is
   a data-level problem and the diagnostic flags every such cell.
3. **Duplicate rows by phone or id.** No client-side de-duplication exists, and
   the Patients tab has no phone. The server drops only byte-identical same-key
   leftovers. The risk sits with same-key twins (the heal's first match, ✕ by
   key, the collapse keep rule) and with duplicate ids that can only come from
   hand-copied rows. The U+FFFD repair never deletes the clean twin.
   Diagnostic (c).
4. **A U+FFFD name failing a filter or match.** Not filtered anywhere, so the
   row still renders. Search and exact-name matching fail on it. Diagnostic (b).
5. **`pickField`/normalize returning null.** Never. `pickField` returns `''`,
   an unknown status becomes `'active'`, and only an unresolvable house hides a
   row (question 2).
6. **Dates, stages, transitions, soft-delete.** The house tab has no date
   filter. The legacy promote guard ignores the date. A server refusal leaves
   an optimistic row that vanishes on the next load. The 24-hour delete
   suppression can swallow a re-add. Soft delete never touches Patients.
7. **Rows skipped by `getData_`.** Fully empty rows (correct) and blank-house
   rows. The positional read turns header drift into wrong fields. The range
   covers every row.

---

## Not changed in this PR, and why

| Item | Why not now | Proposed follow-up |
|---|---|---|
| `resolveHouseId` does not strip invisible marks or NBSP (`public/app.js:1407`) | The server's save partition is strict (`Code.gs:1816`). A variant row that the client resolves to `ramot` is never matched by id on save: a lead-linked patient is refused on every save, and a hand-entered one is appended again on every save. Resolving more variants only on the client would spread that. | If the diagnostic finds variant house cells, canonicalize them **once**, with an approved, audited editor-run repair, and make the `getData_` grouping and the save partition agree with the client. |
| Delete suppression is by key, not by id (`Code.gs:2020`) | It is documented as intended: a re-add within 24 h is blocked. | A stale tab re-sends the deleted row's persisted id, while a deliberate re-add carries a fresh one. Suppressing only the tombstoned id would let a genuine re-add through. |
| The collapse keep rule ignores status (`Code.gs:2896`) | Editor-run only, it has a dry run (`findDuplicatePatientKeysNow`) that names the row it keeps, and every removal is tombstoned. | Prefer a live row over a released twin, or refuse groups whose statuses differ. |
| The promote guard matches house + name without the date (`public/app.js:1219`) | Affects the legacy `entry` stage only. | Add the entry date, as the heal does. |

---

## Running the diagnostic

See `CHANGELOG-missing-patient-diagnostic.md`, section "How to run it". In
short: after the merge, wait for the **Deploy Apps Script** Action to go
green, then in the Apps Script editor select `diagnoseRamotPatientsNow` →
**Run** → **View → Executions log**. The function is read-only.
