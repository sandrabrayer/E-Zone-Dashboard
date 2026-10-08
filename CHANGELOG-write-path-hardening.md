# Write-path hardening: PR #201's three rules on EVERY write path

Base: `claude/build-ezone-dashboard-QOg5s` at `e91f902` (live `/api/version`
= `e91f902`, live `/sw.js` = **v49**). Reference pattern: PR #201,
`CHANGELOG-payment-report-persistence.md`.

The three rules:

- **R1 — fresh state.** A stale response never overwrites newer state
  (request-sequence guard), and no reload starts while a save is in flight.
- **R2 — a load error never clears data.** What is on screen stays, and a
  Hebrew error says the data may be stale.
- **R3 — "saved" only with server proof.** The answer must be `ok:true` AND
  carry the persisted row's id. A retry after a lost answer returns the
  existing row and never writes twice. On failure the form stays open with
  its values.

The work ships as small PRs, highest risk first. This file is the audit and
the record of every PR.

| PR | Scope | SW |
|---|---|---|
| A | Money: void receipt, receipt edit, savePayment (link / coverage / renew), monthly-amount override, credits, funder, «בקרת גבייה» decisions | v50 |
| B | Admit / discharge / patients and the getData guard | — (next) |
| C | Leads and the rest (meetings) | — (next) |

## Shared helpers (PR A, `public/app.js`)

PR #201's `beginPaymentsRead` / `notePaymentsWrite` / `applyPaymentsRead` were
specific to `getPayments`. They are now one keyed mechanism, and the payment
functions are thin wrappers over it (no behaviour change for payments):

- `beginRead(resource)` / `noteWrite(resource)` / `readIsCurrent(ticket)` /
  `applyIfCurrent(ticket, fn)` — one sequence slot per resource:
  `payments`, `billingOverrides`, `credits`, `billingControl`.
- `trackedWrite(resources, fn)` — the write counts in `_savesInFlight` (the
  visibility resync waits), and bumps each resource's write counter before
  it is sent and when it settles, so a read that started earlier is discarded.
- `requireSaved(res, idOf, expectId)` — `ok:true` and the echoed id (equal to
  the one written, when known) or it throws `WRITE_NOT_CONFIRMED_HE`
  («השמירה לא אושרה בשרת — נסו שוב»), so the caller's existing failure path
  runs (modal stays open / optimistic change rolls back).

Server side (`apps-script/Code.gs`), existing locks and dedupe were checked
first: every writer already `tryLock`s and answers `lock_busy` before writing,
except `submitMeetingReport_` (see "Not fixed"). Upserts by a stable id were
already retry-safe. PR A only adds *replay answers* where a retry used to get
a false failure, and one dedupe where a retry appended. No new columns.

## Audit matrix (before → after)

Evidence is `file:line` on the base commit `e91f902`. ✅ pass · ❌ fail ·
◐ partial · n/a not applicable. "After" names the PR that fixed it.

### Load paths

| Path | R1 stale guard | R2 on failure | After |
|---|---|---|---|
| `loadAll` → getData (`app.js:1789`, assigns leads / patients / irrelevant / removed / discharged / billingOverrides at 1839-1889) | ❌ no ticket; the visibility guard (`1725`) checks `_savesInFlight` only at the START, so a write that starts after the load began is overwritten | ✅ throws before assigning; «טעינת נתונים מהגיליון נכשלה —» (`2001`) | billingOverrides ✅ (A); leads / patients / discharged → B |
| `loadAll` → getPayments (`1908`) | ✅ #201 ticket | ✅ #201 `PAYMENTS_LOAD_FAILED_HE` | — |
| `loadAll` → getCredits (`1918`) | ❌ none | ❌ `state.credits = []` (`1928`), console only | ✅ ✅ (A) |
| `loadBillingRead` (`1753`) | payments ✅; patients / overrides / credits ❌ | getData ✅; payments ✅; credits ❌ silent | overrides + credits ✅ (A); patients → B |
| `loadBillingControl` (`14151`) | ❌ a queue read that started before a decision overwrote it | ✅ `s.data` kept, error in the tab | ✅ (A) |
| `reloadCredits` (`7756`) | ❌ | ◐ kept, but silent | ✅ ✅ (A) |
| `reconcilePaymentsAfterWrite` (`12981`) | ✅ | ✅ | — |
| Visibility resync (`1723`) | ◐ blind to every write that bypasses `saveAll` / the report | n/a | money writes counted (A); the rest → B / C |
| `maybeResyncPreservedPatients` (`762`) | ◐ throttled; calls `loadAll` | n/a | follows `loadAll` → B |
| `loadPayoutForecast` (`8255`), `loadDebtAging` (`~8790`) | ✅ own supersession guards | debt aging sets `s.data = null` with a Hebrew error that says not to infer "no debt" (deliberate; read-only report) | unchanged |
| Periodic refresh / focus / online | none exist (only `visibilitychange`) | — | — |

### Money writes (PR A)

| Write | R1 before | R2 | R3 before (proof / retry / form) | After (A) |
|---|---|---|---|---|
| **Report payment** `submitPaymentReport` (`12945`) | ✅ #201 | n/a | ✅ #201 (`receipt.id`, `submissionId`) | verified only — unchanged |
| **Void receipt** `voidReceipt` (`12490`) | ❌ not in `_savesInFlight`; seq bumped only after the answer | n/a | ❌ any `ok` → «הקבלה בוטלה» even with no echo (`12497-12503`); ❌ server: a re-sent void answered `receipt_immutable` (`Code.gs:7335`); ✅ modal stays open on error | ✅ `trackedWrite`; `requireSaved(payment.id)`; server answers the stored row + cycle, `replayed:true`, writes nothing |
| **Receipt edit** `submitReceiptEdit` (`12434`) | ❌ not counted | n/a | ❌ any `ok`; ❌ server replay answered `{changed:false}` with no receipt (`Code.gs:9010`); ✅ form stays open | ✅ counted; `requireSaved(receipt.id)`; server replay echoes the stored receipt |
| **savePayment** (link / un-link / cycle void / coverage period / renew) `savePayment` (`12079`) | ◐ seq bumped, not counted | n/a | ❌ any `ok` (the echo was adopted only if present); ✅ rollback + error; ✅ upsert by id is retry-safe | ✅ counted; `requireSaved(payment.id)` |
| **Monthly-amount override** `saveBillingOverride` / `clearBillingOverride` (`13081` / `13119`) | ❌ not counted; ❌ a getData that started earlier wiped the override | n/a | ❌ any `ok` → toast; ✅ deterministic id, retry-safe; ◐ inline editor re-renders on rollback | ✅ counted; `billingOverrides` ticket on getData; `requireSaved(override.id / id)` |
| **Coverage period** `saveCoveragePeriod` (`13044`) | via savePayment | n/a | ✅ toasts only if the period survived in state | ✅ via savePayment |
| **Credits** `saveCredit` (`7781`) | ❌ not counted; ❌ a getCredits that started earlier undid it | ❌ (see getCredits) | ✅ requires `credit.id`; ✅ create retry deduped per stay+rule (`Code.gs:11437`); ❌ an EDIT retry answered `conflict` (stamp moved, `Code.gs:11334`) | ✅ counted; `credits` ticket; server: an edit that changes nothing answers the stored row, `replayed:true` (`creditEditIsReplay_`) — a real stale edit is still a conflict |
| **Funder** `saveFunder` → `appendFunder` (`12641`) | ❌ not counted; no payments seq bump although funders ride getPayments | n/a | ❌ any `ok` → toast, even with no row; ❌ server: every send appended a row (`Code.gs:8208`) | ✅ counted; `requireSaved(row.patientId)`; server: when the patient's LATEST row already holds the same funder + date, answers it, appends nothing (`funderLatestRowIfSame_`; A → B → A still lands) |
| **«בקרת גבייה» decision** `confirmReceipts` (`14178`) | ❌ not counted; ❌ stale queue read overwrote it | n/a | ❌ any `ok` → toast even with `changed:[]`; ❌ server: a re-sent «כפילות» answered `receipt_void` (`Code.gs:8824`); ✅ drafts kept on error | ✅ counted; `billingControl` ticket; "saved" only when every id is in `changed` / `voided` / `unchanged`; server answers a re-sent «כפילות» with the stored decision |

### Patients / admissions (PR B — audit only in this file so far)

| Write | R1 | R3 | Notes |
|---|---|---|---|
| Admit lead → patient `openEntryModal` (`6412`) | ◐ `saveAll` counted; `persistAuditsRestored` (`5789`) not | ❌ if `saveAll` lands but the audit write fails, the patient is rolled back on screen (`6470-6474`) although the sheet has it; a retry mints a new `cryptoId` patient | B |
| Direct add / intake `openDirectAddPatientModal` (`6490`) | same | same | B |
| Edit patient incl. house move `openEditPatientModal` (`6594`) | ◐ | ❌ an audit failure after a landed `saveAll` rolls back an edit that is on the sheet (`6674`); ✅ move verdicts | B |
| Discharge `dischargePatient` (`7116`) | ❌ the `dischargePatient` POST (`7199`) is not counted | ✅ `auditId` per modal; ✅ server dedupe per stay (`Code.gs:6171`) | B |
| Restore patient as lead (`5578`) | ❌ not counted | ◐ `newLeadId` makes it retry-safe; ❌ the choice modal closes on failure (`5870`) | B |
| Restore to active (`5891`) | ◐ | ◐ whole-array rollback even after `saveAll` landed | B |
| Delete duplicate discharge (`5518`) | ❌ not counted | ✅ not optimistic; ✅ server `alreadyDeleted` | B |
| Delete patient permanently `deletePatient` (`9303`) | ❌ not counted | ❌ a retry answered `patient_not_found` (`Code.gs:3920`) | B |
| `saveAll` itself (`835`) | ✅ counted (from when its turn starts); ✅ server stale-save stamps | ◐ resolves (not rejects) on a partial refusal — callers show the banner | B |

### Leads / meetings (PR C — audit only in this file so far)

| Write | R1 | R3 | Notes |
|---|---|---|---|
| Create lead `doCreateLead` (`6289`) | ✅ via saveAll | ❌ the modal closes and the typed values are lost on failure (`6315`, `6339`) | C |
| Edit lead `openEditLeadModal` (`6348`) | ✅ | ✅ stays open on failure | — |
| Inline fields incl. visit date/time (`4780-4818`), meeting edit modal (`3755`), outcome (`3733`), mark seen (`3158`) | ✅ via `updateLead` | ✅ rollback + error | — |
| Stage change `moveLead` (`4879`) | ✅ | ✅ | — |
| Close lead `closeLead` → `moveLeadIrrelevant` (`4954`) | ❌ not counted | ✅ stays open; ◐ rollback can duplicate the lead after a reload | C |
| Restore lead `restoreIrrelevantLead` (`4987`) | ❌ | ◐ confirm closes on failure | C |
| Soft-delete lead `removeLead` (`5208`) | ❌ | ❌ a retry answered `lead_id_not_found` (`Code.gs:6074`); whole-array rollback | C |
| Meeting report edit (`3373`) | ✅ | ✅ | — |
| Meeting report delete (`3416`) | ❌ not counted | ✅ rollback + error | C |
| meetingWith autosave (`2435`) | ✅ | ◐ silent failure unless `lock_busy` | C |

## Fixes in PR A

`public/app.js`

- The keyed freshness helpers and `trackedWrite` / `requireSaved` (above).
- `voidReceipt`, `submitReceiptEdit`, `savePayment`, `saveFunder`,
  `saveBillingOverride`, `clearBillingOverride`, `saveCredit`,
  `confirmReceipts` run inside `trackedWrite` and claim success only with
  the persisted id.
- `loadAll` / `loadBillingRead` apply `billingOverrides` and `credits` only
  under a current ticket. `loadBillingControl` the same for the queue.
- A failed `getCredits` (in `loadAll`, `loadBillingRead`, `reloadCredits`)
  keeps the credits on screen and shows `CREDITS_LOAD_FAILED_HE`
  («טעינת הזיכויים נכשלה — …»). It used to set `state.credits = []`.

`apps-script/Code.gs` (replay answers; no column, no sheet, no property)

- `upsertPayment_`: a void sent for a receipt that is already void answers
  `{ok:true, payment, cycle, updated:false, replayed:true}` and writes
  nothing. Shared helper `receiptDerivedAt_` (also used by
  `receiptReplayFor_`, #201).
- `confirmDuplicate_`: a «כפילות» re-sent for a receipt already marked
  duplicate answers the stored decision, `replayed:true`.
- `editReceipt_`: the no-change replay also echoes `receipt`.
- `upsertCredit_`: an edit whose fields already equal the sheet's
  (`creditEditIsReplay_`) answers the stored row, `replayed:true`, instead of
  `conflict`. A real stale edit is still refused.
- `appendFunder_`: `funderLatestRowIfSame_` — no second row when the
  patient's latest row already says the same funder from the same date.

Security: no new endpoint, no secret, nothing new logged; every write still
goes through `tryLock` / `lock_busy`, the role and finance gates are
untouched, and the replays read under the same lock as the writes.

## Tests (PR A)

`test/write-path-hardening-money.test.js` — 20 tests. **19 FAILED on the
base code** (the 20th, "the echoed row is what lands on screen", is a
positive control). Client: R3 proof for void / savePayment / editReceipt /
override / funder / confirmPayment; R1 void + decision in flight (no
resync), stale getData vs override, stale getCredits vs credit, stale queue
vs decision; R2 getCredits and reloadCredits failures. Server: re-void,
re-«כפילות», editReceipt replay echo, appendFunder replay (and A → B → A),
credit-edit replay vs real conflict. SW ≥ v50.

Updated tests: stubs that answered a bare `{ok:true}` for a write now answer
what Code.gs really answers (`test/helpers/write-echo.js`); the getCredits
failure in `dashboard-load-perf` H now expects the Hebrew error; a re-sent
«כפילות» in `receipt-duplicates-and-edit` B2 now expects the replay; the SW
pin is v50.

## SW

`CACHE_VERSION` v49 → **v50** (live served v49; v17 stays burned).

## Not fixed (one line each)

- `submitMeetingReport_` (open action used by the Managers app) takes no lock; a replay re-stamps `meetingReportedAt` — cross-repo, left for its own change.
- The monthly-amount inline editor still loses the typed amount when a save fails (it re-renders on rollback; the error says so).
