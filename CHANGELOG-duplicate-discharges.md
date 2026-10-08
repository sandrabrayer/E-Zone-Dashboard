# Duplicate discharges: one open discharge row per stay, «מחק כפילות», a dry-run lister

Base: `claude/build-ezone-dashboard-QOg5s` (the deployed branch, at #192).
Service worker `CACHE_VERSION` **v42 → v43**. v42 was the highest on every
remote branch, and **v17 stays burned and is never reused.**
**`apps-script/Code.gs` changes**, in their own commit. The clasp CI deploys
them when this PR is merged into the deployed branch.

## The report

The «מטופלים משוחררים» tab showed the same discharge twice:

- the same patient, house (קיסריה ריהאב) and entry date (09/09/2026);
- discharge date 06/10/2026;
- «סיים טיפול» on both rows;
- «זיכויים (1)» on both rows.

## Root cause

**`dischargePatient` gave every confirm a new audit id, and the server's
`dischargePatient_` upserted by that id with no check on the stay.** So any
second send for the same stay *appended* a second row.

Evidence:

- `dischargeAuditRow()` set `id: cryptoId()`. `dischargePatient`'s `onConfirm`
  called it on every confirm (`public/app.js`, before this PR).
- `dischargePatient_` called `upsertRowById_(..., record)`. A new id means a new
  row (`apps-script/Code.gs`, before this PR).
- The modal stays open after an error, and its retry runs `onConfirm` again,
  which mints a new id.
- After the «נשמר חלקית» error or a lost answer (a 502 or timeout while Apps
  Script had already written), the rollback removed the optimistic row and set
  the patient back to active on screen. The user saw no discharge and pressed
  אישור or שחרר again.
- A stale second tab, where the patient still looked active, did the same.

Both rows read «סיים טיפול». The coordinators path never writes a disposition,
so both rows came from the Dashboard's own שחרר.

### Every path that appends to the discharged sheet

| Path | Can it write a second row for the same stay? |
|---|---|
| `dischargePatient` (two writes: audit row, then `saveAll`) | **YES — the root cause.** There was a new id per confirm and no stay check. It triggers on a retry in the same modal after an error, on a second שחרר after the rollback, or from a stale tab. |
| The closure modal (`showCloseLeadModal`) | A double tap was already blocked by `busyButton` (`aria-busy` + `disabled`). But a retry *after an error* re-ran `onConfirm`, which minted a new id. That is the case above. |
| Two buttons for the same stay (the house row's שחרר + the renewals row's שחרור) | **Yes, in theory.** Two modals, two ids, and nothing stopped them running at the same time. |
| `lock_busy` retry (`apiPost`) | **No.** It re-sends the *identical* body (same id), and the upsert updates that row in place. |
| `recordDischargeFromCoordinators_` | **Only when combined with the Dashboard.** Its id is deterministic, and a patient already released answers `alreadyDischarged`. But if the Patients row was clobbered back to active while the Dashboard's row was still open, it appended a second row. |
| Reactivation paths from #190 (`restorePatientToActive` on ✏️, add, admit, restore) | **No.** They only *close* rows (`restored='TRUE'`), keyed by the row's own id. |
| Restore → discharge again | **No duplicate.** The restored row is closed, so the new row is the only open one. That is a legitimate re-discharge. |

## Credits: one credit shown twice, not two credits

`renderDischargedPatients` counts `creditsForPatient(state.credits, '',
patientKey(p))`. That is **per stay** (house + name + entry date), not per
discharge row. A credit has no link to a discharge row: it carries
`patientId` + `patientKey`.

So two rows of one stay show the **same** credits. «(1)» on both rows means
**one** credit. Two credits would read «(2)» on each row.

A double refund was still *possible*. `buildCreditLines` dedupes only against
the tab's own `state.credits`, and `upsertCredit_` minted `seq + 1` for any
create. A stale tab, or a credit whose save answer was lost, could create a
second credit for the same rule. This PR closes that hole too (see below), and
`listDuplicateDischargesNow` shows any such pair that already exists.

## The fix

### Server (`Code.gs`, under the existing script lock)

- **The stay key.** `dischargeStayKey_` builds houseId + name + entry date:
  - the name is trimmed and inner spaces are collapsed;
  - the date goes through `asISODate_`, so a legacy Date-typed cell matches
    `'YYYY-MM-DD'` text.
- **Open rows.** `dischargeRowOpen_` means a row that is neither restored nor
  soft-deleted.
- **`dischargePatient_`**: if the stay already has an open row under **another**
  id, it answers `{ ok:true, duplicate:true, discharged:false, id:<existing>,
  exitDate }` and writes **nothing**, not even an AuditLog row. The *same* id
  is a plain retry and still upserts in place. A re-discharge after a restore
  is allowed.
- **`recordDischargeFromCoordinators_`**: the same check. It answers `{ ok:true,
  discharged:false, alreadyDischarged:true, duplicate:true, id:<patient id>,
  auditId, dischargeDate }` and writes nothing. `id` stays the patient id (the
  coordinators contract). The Dashboard's load-time heal completes the release
  from the open row.
- **`upsertCredit_` (create)**: if an open (not `cancelled`) credit already
  exists for the same stay (`patientKey`, normalized the same way) and the same
  rule (`creditType` + `allocationMonth`), it answers `{ ok:true,
  duplicate:true, id, credit:<existing row> }` and writes nothing.
  - A manual `other` credit counts as a duplicate only when its amount and
    reason also match (a retry). Two different manual credits in one month are
    still allowed.
- **The restore paths** (`restorePatient_`, `restorePatientToActive_`) carry the
  delete stamps from the stored row. A stale client copy can never un-delete a
  row.
- **Readers that skip a soft-deleted row:**
  - the refund payout forecast;
  - the promotion guard (`dischargedFromLeadIds_`);
  - the reconciliation report's discharge records.

### Client (`public/app.js`)

- **One audit id per modal.** A retry from the same modal re-sends the same row,
  so it is idempotent even without the server guard.
- **In-flight guard per stay** (`dischargesInFlight`). A second confirm for the
  same stay while one is saving writes nothing. This covers the two doors
  (house row and renewals row). `busyButton` still blocks a double tap on the
  button itself.
- **`duplicate:true`** → toast «השחרור כבר נרשם». The client then:
  - drops the optimistic row;
  - keeps the patient released on the recorded exit date and saves that;
  - skips the outpatient lead and the credits step, which the first discharge
    already owned.
- `saveCredit` treats a `duplicate:true` answer as the existing row, stored
  once.
- **Every "open discharge" filter** now uses `dischargeRowOpen` (not restored,
  not deleted):
  - the tab;
  - the heal;
  - the promotion guard;
  - the restore bridge;
  - the reactivation closer;
  - the coordinators panel.

## «מחק כפילות» — soft-delete one duplicate row

- **Where:** a button on a row of the «מטופלים משוחררים» tab. It appears only
  when the row has another *open* row of the same stay, and only for a deleter
  (Vered, Sandra): `canDelete()` and `data-role="deleter"`.
- **Server: `action=deleteDuplicateDischarge { id, reason }`.**
  - It is in `DELETE_ACTIONS`, mirrored in `lib/role-scope.js`. server.js and
    `handle_` both refuse a session without `deleter` (`forbidden_role`).
  - It is not in `OPEN_ACTIONS`.
  - Then, under the lock:
    - **reason**: required, 2–120 characters. It is cleaned: control
      characters, `< >` and a formula lead-in are removed.
    - **the row** must exist and be open. A row already deleted answers
      `alreadyDeleted` and writes nothing.
    - **the last open row of a stay is never deleted** (`last_discharge_row`).
    - **credits:** two open credits for one rule on the stay (a possible
      **double refund**) → `duplicate_credit`. A credit whose `basis.exitDate`
      matches only this row → `row_has_credit`. Both answer with Hebrew text
      saying that voiding a credit needs Sandra's approval, and list the credit
      ids. One credit shared by identical duplicates stays with the surviving
      row and does not block the delete.
    - **the write:** three **appended** cells on that one row (`deletedAt`,
      `deletedBy` = the verified actor, `deleteReason`), plus an AuditLog row
      `discharge_duplicate_deleted` with `at / by / reason / keptId / prev`
      (the full row before the delete).
    - The Patients, Payments and Credits sheets are never written.
- **Client:**
  - a modal with every value escaped;
  - the reason is checked before anything is sent (`required`, `minlength`,
    `maxlength`, plus a JS check);
  - `busyButton` blocks a double tap;
  - the row leaves the tab only after the server confirms;
  - a refusal shows the server's Hebrew message and keeps the row.

## Schema (append-only)

`DISCHARGED_PATIENT_COLUMNS` gets `deletedAt`, `deletedBy` and `deleteReason`
**appended last**. No column is reordered. `getOrCreateSheet_` extends the live
header on the first write after deploy, and the three columns are text-forced.

## Existing data — `listDuplicateDischargesNow()` (editor-run, DRY RUN)

It is read-only by construction: no lock, no `getOrCreateSheet_`, no
`setValue`, no AuditLog row. `handle_` never dispatches it.

For every stay with two or more open rows, it logs:

- each row's sheet row number, id, exit date, disposition, recorded-at, who,
  and source;
- the stay's credits (id, type, month, amount, status, basis exit date);
- which row, if any, owns each credit;
- any double-refund rule.

### Steps for Sandra (after merge, once the deploy workflow is green)

1. Open the Dashboard spreadsheet → **Extensions → Apps Script**.
2. In the function dropdown, choose **`listDuplicateDischargesNow`** → **Run**.
3. **View → Executions** → the latest run → read the `[dup-discharges]` lines.
   Every stay with duplicates is one JSON line. The last line says how many.
4. Read the line for the reported stay:
   - `doubleRefund` should be `[]`;
   - `credits` should hold one credit;
   - `ownCredits` should be `[]` on both rows.
   If `doubleRefund` lists a rule, stop: a credit has to be voided first, which
   needs Sandra's approval and is not part of this change.
5. In the Dashboard (as Sandra or Vered), open **מטופלים משוחררים**. The stay
   shows two rows, each with «מחק כפילות».
6. On the row to remove (the later `dischargedAt` from step 3), press
   **«מחק כפילות»**, type a reason (e.g. «שחרור נרשם פעמיים»), and confirm.
7. The tab now shows one row with «זיכויים (1)». Run
   `listDuplicateDischargesNow` again: that stay is gone from the list.

No production row is changed by code. The only change is the soft delete a
deleter performs from the tab.

## Shared Apps Script (ezone-managers / ezone-therapists)

All changes are additive:

- a new action;
- three appended columns;
- `duplicate:true` on an `ok:true` answer.

`getData` still returns every discharged row; deleted rows carry `deletedAt`,
and the Dashboard filters them. No consumer action is renamed or reshaped.

## Tests

- `test/duplicate-discharges.test.js` (24) covers:
  - the root-cause scenario end to end, through `app.js` into the real `Code.gs`:
    - a lost answer, then a second שחרר;
    - a retry in the same modal after «נשמר חלקית»;
  - the duplicate refused;
  - same id = retry;
  - re-discharge after a restore;
  - the coordinators guard;
  - the double tap and the two doors;
  - the credit dedupe;
  - the delete:
    - role-gated;
    - reason required;
    - last row protected;
    - own credit or double credit refused;
    - soft;
    - AuditLog;
    - Patients, Payments and Credits untouched;
    - idempotent;
    - stamps survive a restore;
  - the dry-run lister (read-only, flags a double refund);
  - the client filters;
  - escaping and wiring.
- `test/duplicate-discharges-browser.test.js` (3, real Chromium at 360px with
  the real `Code.gs`):
  - the reported pair:
    - «זיכויים (1)» shown twice;
    - the escaped name;
    - an empty reason sends nothing;
    - a double-click sends once;
    - the survivor has no button;
    - the stamps and the AuditLog row land;
  - Shiran sees no button;
  - a double-click on discharge writes once, and a stale tab gets «השחרור כבר נרשם».
- Updated pins:
  - `DELETE_ACTIONS` lists;
  - the discharged column layout (3 appended);
  - the lock-busy write-path registry;
  - two credits-ledger cases that created a second open credit for the same
    stay and rule (now the guard's case);
  - SW v43.
- **Mutation checks** (each one turned the named test red; sources restored
  after each run):
  1. server discharge guard off → the root-cause test, duplicate refused,
     re-discharge, delete idempotency, and the browser stale-tab test;
  2. per-confirm id (the old client) → the same-modal retry test;
  3. in-flight guard off → the double-tap test;
  4. credit dedupe off → the credit test;
  5. last-row protection off → the last-row test;
  6. `deleteDuplicateDischarge` removed from `DELETE_ACTIONS` → the role test
     and the wiring test;
  7. own-credit refusal off → the credit-refusal test;
  8. the client deleted-row filter off → the client filter test and the delete
     test;
  9. delete-stamp carry off → the restore-stamps test.
- Full suite: **2358 / 2358 pass, 0 skipped** (browser tests included). Before
  this change: 2329.

## Rollback

Revert the PR. The appended columns stay on the sheet (append-only, harmless).
Rows already soft-deleted keep their stamps. After a revert, the old client
would show them again, because it does not read `deletedAt`.
