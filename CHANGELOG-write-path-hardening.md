# Write-path hardening: the three PR #201 rules on every write

Branch series off `claude/build-ezone-dashboard-QOg5s`. Reference pattern:
PR #201 (`CHANGELOG-payment-report-persistence.md`).

| Rule | Meaning |
|---|---|
| **R1** | A stale read never overwrites newer state (read ticket / write sequence). No reload starts or lands while a save is in flight. |
| **R2** | A load error never clears data. What is on screen stays, and a Hebrew error is shown. |
| **R3** | «נשמר» only with server proof (`ok:true` + the persisted row id). Every submission carries a client id. A retry returns the existing row and never writes a duplicate. On failure the form stays open with its values. |

## Step 1: audit (before), head `e91f902`

Evidence is `file:line` on `e91f902`. `app.js` = `public/app.js`, `gs` =
`apps-script/Code.gs`. Shared facts that drive most rows:

- **S1 (R1).** `loadAll` applies `getData` with no read ticket:
  `state.leads = …` app.js:1839, `state.patients = …` 1840, overrides 1886.
  Only `getPayments` is ticketed (`beginPaymentsRead` 1790 →
  `applyPaymentsRead` 821). The visibility resync checks `_savesInFlight`
  only when it STARTS (1725). A `getData` started before a write and answered
  after it replaces the edited objects; a `saveAll` still waiting in
  `savePromise` then serializes the sheet's old values (it reads state at run
  time, 838/863) and resolves ok.
- **S2 (R1).** Only `saveAll` (887) and `submitPaymentReport` count in
  `_savesInFlight`. Every direct `apiPost` write does not. `saveAll` counts
  only while running, not while queued.
- **S3 (R1).** Two `loadAll` calls bypass every guard: the preserved-rows
  resync (773) and the meeting-report edit conflict (3394).
- **S4 (R3).** `saveAll_` (gs:2778) echoes no lead ids and patient ids only as
  `stamps` keys when a stamp changed. No `saveAll` caller can prove its row
  landed. Replays are idempotent by id (`mergeLeads_` gs:2886,
  `replaceHousePatients_` gs:3368), so no idempotency column is needed: the
  client id must simply be minted ONCE per form, not per submit.
- **S5 (R3).** `cryptoId()` (app.js:2912) is `Math.random`+`Date.now`, and
  create-lead / admit / restore mint it per submit, so a retry after a lost
  response writes a second row under a new id.
- **S6 (transport).** `server.js` POST `/api/sheets` (995) has no retry and
  answers 502 on any upstream failure, including after a committed write. A
  lost response is the normal trigger for the R3 retry case.

### Load paths

| Load | Where | R1 | R2 |
|---|---|---|---|
| `getData` in `loadAll` | app.js:1774/1839 | **FAIL** S1 | PASS: state kept, Hebrew error 2001 |
| `getPayments` in `loadAll` | 1790/1908 | PASS (PR #201) | PASS (PR #201) |
| `getCredits` in `loadAll` | 1918–1929 | **FAIL** unguarded 1924 | **FAIL** `state.credits = []`, no error (1928) |
| `loadBillingRead` | 1753 | payments PASS; credits/overrides **FAIL** (1761, 1768) | getData PASS (1769); credits **FAIL** silent (1768) |
| `loadBillingControl` | 14151 | **FAIL** `s.data` unticketed vs `confirmReceipts` | PASS |
| `reloadCredits` | 7758 | **FAIL** unguarded | PASS |
| visibility resync | 1723 | **FAIL** S1/S2 (only start-time check) | — |
| preserved resync / meeting-edit reload | 773 / 3394 | **FAIL** S3 | — |
| meeting-report page `loadLeads` | meeting-report.js:463 | n/a (no writes race it on that page) | PASS: keeps list, Hebrew error |

### Write paths

| # | Write | Client → server | R1 | R2 | R3 |
|---|---|---|---|---|---|
| 1 | **reportPayment** (verify only) | `submitPaymentReport` app.js:12945 → `reportPayment_` gs:8464 | PASS | n/a | PASS |
| 2 | **void receipt** | `voidReceipt` 12490 → `upsertPayment_` gs:7196 | **FAIL** S2, write noted only after the answer | n/a | **FAIL** no echo → optimistic void + success toast; retry after lost answer → `receipt_immutable` though the void landed |
| 3 | **savePayment** (cycle edit, cycle void/un-void, link) | `savePayment` 12079 → `upsertPayment_` | **FAIL** S2 | n/a | **FAIL** `ok:true` without `payment` keeps the local value; failure re-renders and drops the open editor |
| 4 | **✏️ coverage period** | `saveCoveragePeriod` 13044 → `savePayment` | **FAIL** S2 | n/a | **FAIL** toasts on local state, typed dates lost on failure |
| 5 | **✏️ monthly amount** | `saveBillingOverride` 13081 → `upsertBillingOverride_` gs:11487 | **FAIL** S1 (overrides ride `getData`) + S2 | n/a | **FAIL** id never checked; input re-rendered away before the await |
| 6 | ↩ clear amount | `clearBillingOverride` 13119 → `deleteBillingOverride_` gs:11550 | **FAIL** S1/S2 | n/a | **FAIL** answer not checked |
| 7 | **editReceipt** | `submitReceiptEdit` 12434 → `editReceipt_` gs:8926 | **FAIL** S2 | n/a | **FAIL** any `ok` closes; `changed:false` answer carries no receipt |
| 8 | appendFunder | `saveFunder` 12641 → `appendFunder_` gs:8195 | **FAIL** no payments write noted; funders ride `getPayments` | n/a | **FAIL** no row check; retry appends a 2nd identical row |
| 9 | saveCredit | `saveCredit` 7781 → `upsertCredit_` gs:11301 | **FAIL** credits unticketed | n/a | **FAIL** edit retry → `conflict` against the user's own write |
| 10 | confirmPayment (Ortal) | `confirmReceipts` 14178 → `confirmPayment_` gs:9543 / `confirmDuplicate_` gs:8815 | **FAIL** queue unticketed | n/a | **FAIL** sent ids never checked; «כפילות» retry → `receipt_void` |
| 11 | **admit lead → patient** | `openEntryModal` 6412 → `saveAll` → `replaceHousePatients_` | **FAIL** S1 | n/a | **FAIL** S4/S5; a `promoteSkipped` refusal still closes the modal |
| 12 | **edit patient / house move** | `openEditPatientModal` 6594 → `saveAll` | **FAIL** S1 (edit can be orphaned) | n/a | **FAIL** S4; stale-edit `conflicts` refusal still closes |
| 13 | **discharge** | `dischargePatient` 7116 → `dischargePatient_` gs:6158 + `saveAll` | **FAIL** S2 (7199) | n/a | **FAIL** `patient.id` never checked |
| 14 | restore → new lead | `doRestorePatientAsNewLead` 5578 → `restorePatient_` gs:6204 | **FAIL** S2 | n/a | **FAIL** modal closes on failure; retry mints a new lead → duplicate |
| 15 | restore → active | `doRestorePatientToActive` 5891 → `restorePatientToActive_` gs:6250 | **FAIL** S2 | n/a | **FAIL** modal closes on failure; no proof |
| 16 | delete patient row | `deletePatient` 9303 → `deletePatientRow_` gs:3881 | **FAIL** S2 | n/a | **FAIL** retry → `patient_not_found` → client restores a deleted row |
| 17 | delete duplicate discharge | app.js:5518 → `deleteDuplicateDischarge_` gs:6352 | **FAIL** S2 | n/a | PASS* (server replays `alreadyDeleted`; client invents `deletedAt`) |
| 18 | heal auto-save | `loadAll` 1989 | **FAIL** S1 | **FAIL** non-lock failures console-only | **FAIL** silent |
| 19 | **create lead** | `openAddLeadModal` 6236 → `saveAll` | **FAIL** S1 | n/a | **FAIL** S4/S5; modal closes on failure (6339) |
| 20 | edit lead | 6380 → `saveAll` | **FAIL** S1 | n/a | **FAIL** S4 |
| 21 | stage change / waitlist | `moveLead` 4879 | **FAIL** S1 | n/a | **FAIL** S4 |
| 22 | visit date/time, contact, billing phone, outcome, meetings-board edit | `updateLead` 4912 | **FAIL** S1 (edit orphaned in queue) | n/a | **FAIL** S4 |
| 23 | meetingWith autosave | 2447 (fire-and-forget) | **FAIL** S1 | n/a | **FAIL** S4 |
| 24 | close lead (dispositions) | 4974 → `moveLeadIrrelevant_` gs:5990 | **FAIL** S2 | n/a | **FAIL** echo ignored; lost answer → rollback re-adds the lead → next `saveAll` writes it back to Leads |
| 25 | restore lead | 5011 → `restoreLead_` gs:6017 | **FAIL** S2 | n/a | **FAIL** echo ignored |
| 26 | soft-delete «הסר» | 5217 → `removeLead_` gs:6048 | **FAIL** S2 | n/a | **FAIL** retry → `lead_id_not_found`; client invents the record when the echo is missing |
| 27 | delete meeting report | 3428 → `deleteMeetingReport_` gs:7002 | **FAIL** S2 | n/a | **FAIL** answer not checked |
| 28 | meeting report edit (Vered) | 3374 → `saveAll` | **FAIL** S3 | n/a | **FAIL** S4 |
| 29 | `submitMeetingReport` (manager page) | meeting-report.js:515 → `submitMeetingReport_` gs:6910 | **FAIL** no `tryLock` | PASS | **FAIL** `saved.leadId` unchecked; retry re-stamps and resets «נצפה» |

Out of scope (no dashboard UI): `recordDischargeFromCoordinators` (server to
server, own secret). Read-only POSTs: `suggestRefunds`, `refundPayoutForecast`,
`debtAging`, `cleanupReport`.

## Step 2: fixes

### Shared helpers (`public/app.js`, PR A)

The PR #201 helpers are extracted, not duplicated:

- `createReadGuard(opts)` — the PR #201 sequence guard as a factory:
  `begin()` / `noteWrite()` / `isCurrent(ticket)` / `applied(ticket)`.
  `beginPaymentsRead` / `notePaymentsWrite` / `applyPaymentsRead` keep their
  names and now delegate to `_paymentsGuard`. New guards: `_dataGuard`
  (getData; `quiescent` — never applied while any save is in flight),
  `_creditsGuard`, `_billingControlGuard`.
- `beginSave` / `endSave` / `trackedWrite(guards, work)` — every write is
  counted in `_savesInFlight` and noted on its guards before it is sent and
  when it answers. `whenSavesDrain(fn)` runs once the last save ends.
- `saveAll` is counted from the moment it is QUEUED (it used to count only
  while running), so a `getData` started before a queued edit is discarded.
  The preserved-rows resync waits for the saves to drain.
- `loadAll` tickets `getData` and `getCredits`. A stale `getData` answer is
  discarded (no promote / heal on it) and re-read once (`queueDataResync`).
- `requireSavedId(res, pick, want)` — throws `SAVE_UNPROVEN_HE` unless the
  answer carries the persisted row's id (and it is the one this write
  targeted).

### PR A — money

| # | Write | Fix |
|---|---|---|
| 2 | void receipt | `trackedWrite`; requires the server's void copy of THAT receipt. Server: a retry with the same reason replays (`receiptVoidReplay_`), nothing written. |
| 3 | savePayment | `trackedWrite`; requires `payment.id`; returns true/false. `keepEditor` re-renders only the summary on failure. |
| 4 | ✏️ coverage | `savePayment(…, { keepEditor: true })`: the editor stays open with the typed dates. |
| 5 | ✏️ amount | Not optimistic any more: applied after `override.id` proof; the editor stays open on failure. Noted on `_dataGuard` (overrides ride getData). |
| 6 | ↩ amount | `trackedWrite`; requires `deleted:true` + the id. |
| 7 | editReceipt | `trackedWrite`; requires `receipt.id`. Server: `changed:false` now carries the stored receipt. |
| 8 | appendFunder | One `submissionId` per form (modal, fill row; one-shot for admission). Server: new APPENDED `Funders.submissionId`; a key already stored replays that row. Malformed key → `bad_submission_id`. Header clash → old behaviour, no key. |
| 9 | saveCredit | `trackedWrite` on `_creditsGuard`. Server: an edit whose stale stamp is the same user's own landed write, with every sent field already stored, replays. |
| 10 | confirmPayment | `trackedWrite`; every sent id must come back in `changed` / `unchangedRows` / `voided`, else nothing is cleared. Server: `unchangedRows`; a «כפילות» retry replays. |
| — | loads | `getCredits` failure keeps the list + `CREDITS_LOAD_FAILED_HE` (loadAll, loadBillingRead). `reloadCredits`, `loadBillingControl`, `loadBillingRead` ticketed. |

Server-side, nothing double-handles: `reportPayment` (PR #201), cycle edits,
override upsert / delete and confirm status changes were already idempotent
by id and are left alone; only the four refusal-on-retry paths gained a
replay. Every Code.gs write still `tryLock`s first and returns `lock_busy`.
No secret, header or log line was added beyond the outcome.

Tests: `test/write-path-hardening-money.test.js` — 17 tests, all 17 FAILED
on the parent commit (`e91f902`) and pass now. Updated pins:
`FUNDER_COLUMNS` tail (payment-report-foundation, payment-report-form),
override / savePayment / funder stubs now answer like the server
(billing-override-ui, billing-override-id-heal, lock-busy-frontend,
renewal-alert, the three Chromium suites), optimistic-gap (the ✏️ amount is
no longer optimistic), dashboard-load-perf H (credits error), B2 (a
«כפילות» retry replays), SW pin v50. `npm test` 2583 / 2583.
`npm audit`: 0 high, 0 critical (1 moderate in `qs`, pre-existing).

SW `CACHE_VERSION` v49 → **v50** (live served v48, the deploy branch v49;
no open PRs; v17 burned).

### PR B — admit / discharge / patients

`saveAll` proof (no new column): the client names the rows it must see
persisted — `saveAll({ prove: { leads: [id], patients: [id] } })` — and
`saveAll_` answers `proven`, the ids the sheet holds after the write, read
under the save's own lock. The ids are the client-minted row ids the merge
already matches on, so they are the idempotency keys; the fix is to mint
them ONCE per form. A malformed `prove` → `bad_prove`, nothing written.
`cryptoId()` now uses `crypto.getRandomValues` (same `id-…` shape).

| # | Write | Fix |
|---|---|---|
| 11 | admit lead → patient | patient id minted per form; `requireProven`. A refused promotion (`promoteSkipped`) is not proven → rolled back, form open. |
| 11b | direct add / intake | same. |
| 12 | ✏️ edit / house move | `requireProven`; a stale-edit `conflicts` refusal of THIS patient keeps the form open with what was typed. Moves keep their own flow. |
| 13 | discharge | `trackedWrite`; the audit row (or the duplicate's id) must come back; the status flip is proven. |
| 14 | restore → new lead | lead id minted per choice-modal; `trackedWrite`; requires `lead.id`; throws so the modal stays open. Server: an existing lead with that id replays (never reset, never a 2nd lead); the id is validated. |
| 15 | restore → active | proven patient row + every audit flag (`persistAuditsRestored`, now tracked + proven); throws so the modal stays open. |
| 16 | delete patient row | `trackedWrite`; requires the deleted id / key. Server: a retry whose row is gone and held by a fresh `user-delete` tombstone of the same house replays `alreadyDeleted`. |
| 17 | delete duplicate discharge | `trackedWrite`; requires the id. |
| 18 | promote / heal auto-save | every failure shown in Hebrew (`AUTO_SAVE_FAILED_HE`), not only a lock. |

Already idempotent server-side, left alone: `dischargePatient_` (upsert by
id + open-stay duplicate guard), `restorePatientToActive_` (upsert by audit
id), `deleteDuplicateDischarge_` (`alreadyDeleted`), the patient merge.

Known edge (documented, not changed): an admission whose row the merge
folds into an EXISTING sheet row (same house + name + entry date under
another id) keeps the sheet's id, so the client's id is not proven and the
form says «לא אושרה»; the preserved-rows resync then shows the real row.

Tests: `test/write-path-hardening-patients.test.js` — 12 tests, all 12
FAILED on the parent (`c5a5494`). `test/helpers/server-echo.js` makes older
suites' bare `{ok:true}` stubs answer like the real handlers (discharge,
restore, delete, saveAll proof) instead of weakening the rule; pins updated
in reactivation-fix (proven order), lock-busy (every auto-save failure is
reported), rename-guard (`saveAll(`), restore-to-active (the worker throws).
SW `CACHE_VERSION` v50 → **v51** (live v50).
