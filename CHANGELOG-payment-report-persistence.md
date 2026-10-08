# «דוח תשלום» persistence: a saved report no longer flips back to «לא שולם»

Branch `fix/payment-report-persistence` off `claude/build-ezone-dashboard-QOg5s`.
**Railway + Code.gs.** The clasp CI deploys Code.gs on merge. There is no manual
step: one APPENDED `Payments` column writes its own header.

## Symptom

Vered saves «דווח תשלום» in «גבייה». Sometimes the row then flips back to
«לא שולם», or its paid amount drops back. This happens intermittently. A later
refresh usually shows the correct state again: **the receipt was always in the
sheet**, and only the screen lost it.

## Investigation: the full path

`openPaymentReportModal` → `submitPaymentReport` (`public/app.js`) →
`apiPost` (`lock_busy` retry once) → `POST /api/sheets` (`server.js`, which
attaches PROXY_SECRET and has no server cache) → `reportPayment_`
(`apps-script/Code.gs`: validate, `tryLock(10000)`, cycle in place + one
receipt appended, cycle re-derived) → on every read, `getPayments_` →
`paymentRowsDerived_` → `recomputeCycleFromReceipts_`, which derives
שולם / שולם חלקית / לא שולם from the live receipts.

### Confirmed causes

1. **A stale read overwrites the confirmed echo (hypothesis b). CONFIRMED.**
   - `loadAll` assigned `state.payments` / `state.receipts` from whatever
     `getPayments` answered, with no check that the answer was still current.
     The pre-fix code was at `app.js` loadAll, at "Payments live on their own
     sheet…".
   - `submitPaymentReport` never counted as a save in flight, so the
     visibilitychange resync (`app.js` around 1668: `if (_savesInFlight > 0)
     return;`) still started `loadAll` while the report was mid-air.
   - The typical sequence: Vered checks the bank app, returns to the PWA, and
     the resync starts. She saves. The echo is applied (שולם). Then the
     resync's `getPayments`, read from the sheet before the write landed,
     arrives and replaces state, and the row reads «לא שולם». Apps Script
     reads take no lock, so this happens whenever the read executes before
     the write commits.
   - A second receipt makes the amount "drop back" the same way.
   - Reproduced: `test/payment-report-persistence.test.js` R1 (actual
     `'unpaid'`) and R2.
2. **A failed `getPayments` silently wiped the money state. CONFIRMED.**
   - `loadAll` caught any `getPayments` failure (Apps Script timeout, 502,
     quota) and set `state.payments = state.receipts = state.funders = []`
     with **no error on screen** ("assuming empty"). Every row then read
     «לא שולם».
   - This is the same symptom as `CHANGELOG-getpayments-502-fix.md`. That
     change fixed one cause of the 502 but left the silent wipe in place.
     `loadBillingRead` behaved the same way.
   - Reproduced: R3.
3. **No idempotency (hypotheses a-reverse and f). CONFIRMED (reverse
   direction).**
   - When the write commits but the response is lost (proxy 502, dropped
     connection; `followingRequest` has no timeout or retry), the modal says
     "not saved". Vered retries, and the server either refuses with
     `possible_duplicate` or, after «כן, קבלה נוספת», writes a **second**
     receipt.
   - Reproduced: R5 (server). The retry answered `possible_duplicate`
     instead of the stored receipt.
4. **"Saved" without proof. CONFIRMED (latent).**
   - `submitPaymentReport` closed the modal and toasted success for any
     `ok:true` answer, even one without a persisted receipt id.
   - Reproduced: R6.

### Ruled out (with evidence)

- **(a) lock_busy path.**
  - `reportPayment_` returns `lockBusy_()` before writing anything.
  - `apiPost` (`app.js` 486–511) retries once, then throws a `lockBusy`
    error. Any `ok:false` throws.
  - The report UI is NOT optimistic, so there is nothing to roll back. The
    modal stays open with the error.
- **(b) HTTP / SW cache.**
  - `server.js` `noCache` sends `no-store` on every response.
  - `sw.js` `cacheStrategy` returns `network-only` for any URL containing
    `sheets` or `/api/`.
  - There is no server-side response cache, only the debug `lastLoad`.
- **(c) Matching.**
  - The billing row finds its cycle by the exact id `pay::<house>::<name>::
    <entry>::<due>`. The report echoes and writes that same id. `isoDate`
    normalizes the entry date and `resolveHouseId` resolves house aliases
    deterministically on every load.
  - A receipt links to its cycle at read time by `patientUid` (both rows
    carry it) or `patientId`, and by its `coverageStart` inside the cycle
    window.
  - `reportPayment_` refuses a `coverageStart` outside the window
    (`coverage_outside_cycle`), so a written receipt always links.
  - A cycle with no linked receipts keeps its stored (derived) status. It
    never falls to «לא שולם».
- **(d) Voids.**
  - `recomputeCycleFromReceipts_` skips only void receipts.
  - `receiptPossibleDuplicate_` ignores void receipts.
  - Worked example, נועם שני (one live ₪28,000, one void ₪28,000): the
    amount paid is ₪28,000.
- **(e) Partial / misplaced write.**
  - Reads and writes are positional over `PAYMENT_COLUMNS` on both sides,
    with header-clash guards.
  - The row index comes from a grid read under the same lock.
  - A crash between the cycle write and the receipt append leaves the cycle
    with its derived status, so it still never reads «לא שולם».
- **Payments columns.** Append-only. The new `submissionId` is the LAST
  column.

## Fix

**`public/app.js`**

- **Request-sequence guard.**
  - Every payment write calls `notePaymentsWrite()`: report, `savePayment`,
    void, `editReceipt`.
  - Every `getPayments` read takes a ticket when it starts
    (`beginPaymentsRead`).
  - `applyPaymentsRead` applies an answer only if no write happened since its
    ticket and no newer read was already applied. Otherwise it discards the
    answer.
  - Used by `loadAll`, `loadBillingRead` and the reconcile.
- **A report counts in `_savesInFlight`**, so the visibility resync waits for
  it.
- **A failed `getPayments` keeps the money state** and shows
  `PAYMENTS_LOAD_FAILED_HE`. A malformed answer is parsed fully before
  anything is assigned.
- **Proof before "saved".** The report succeeds only with `ok:true` AND
  `receipt.id`. Otherwise it throws «התשלום לא נשמר — נסי שוב», and the modal
  stays open with every value. There is never a silent rollback.
- **Reconcile.** After a confirmed report, `reconcilePaymentsAfterWrite`
  re-reads `getPayments` and adopts the answer if it is current and carries
  the confirmed receipt id.
- `apiGet` uses `fetch(…, { cache: 'no-store' })`.
- **Idempotency key.**
  - `newSubmissionId()` returns `'sub-' + 32 hex` (crypto). There is one per
    opened form.
  - Every send of that form carries it, including the «כן, קבלה נוספת»
    re-send.

**`apps-script/Code.gs`**

- `PAYMENT_COLUMNS` appends `submissionId`. It is server-owned
  (`PAYMENT_SERVER_COLUMNS`), so `savePayment` can never set it, and
  text-forced. `receiptHeaderClash_` guards its position.
- `reportPayment_`:
  - Validates the key: `^sub-[A-Za-z0-9-]{8,64}$`, otherwise
    `bad_submission_id` and nothing is written. A missing key is the old
    behavior.
  - Under the lock, a key already stored on a receipt is a retry.
    `receiptReplayFor_` answers `{ ok:true, receipt, cycle, replayed:true }`
    from the sheet and writes nothing.
  - Otherwise it stores the key on the new receipt row.
- Unchanged: every write path still `tryLock`s and returns `lock_busy`.
  PROXY_SECRET handling, server-side validation and `escapeHtml` on render
  are untouched. No secrets are added and nothing new is logged beyond the
  action outcome.

**`server.js`**: unchanged.

## Tests

`test/payment-report-persistence.test.js` has 12 tests. Each of R1–R6 failed
before the fix.

| Test | What it checks |
|---|---|
| R1 | A stale in-flight `getPayments` cannot overwrite the confirmed echo. |
| R2 | No visibility resync while a report is in flight. |
| R3 | A failed `getPayments` keeps state and shows a Hebrew error. |
| R4 | A reconcile runs after the save and is sequence-guarded. `apiGet` uses `no-store`. |
| R5 client | The same key on every send. |
| R5 server | Replay returns ONE receipt (also with `confirmDuplicate`). A different key still hits `possible_duplicate`. A malformed key is refused. The column is appended last, server-owned and text-forced. |
| R6 | `ok:true` with no receipt id is a failure. |
| SW | The SW version is ≥ v48. |

Updated tests:

- `dashboard-load-perf` H: a `getPayments` failure now shows the Hebrew
  error instead of wiping silently.
- The `PAYMENT_COLUMNS` tail pins now include `submissionId`.
- The SW pin is now v48.

Full suite: `npm test` passed **2507 / 2507**. `npm audit` reports 0 high and
0 critical (1 moderate, in `qs`, which was already there before this change).

## SW version

`CACHE_VERSION` v47 → **v48**. Live production served v47, and the deploy
branch also held v47. The open PRs hold v14, v17, v24 and v32. v17 stays
burned.

## Handoff

`claude/handoff-2026-10-01.md` does not exist on the deploy branch, so its
"Done" section could not be updated. The entry went into
`EZONE-ECOSYSTEM-STATUS.md` and `DEPLOY.md` instead.

## Manual verification (https://ezone-dashboard.up.railway.app)

1. Hard refresh. In DevTools → Application → Service Workers / Cache Storage,
   confirm `ezone-dashboard-v48`.
2. Report a payment on a test row. Refresh twice. Confirm the row stays
   שולם / שולם חלקית.
3. In DevTools → Network → `getPayments` → Response, search for the new
   receipt id (`rcpt-…`). Its `cycleId` is the row's `pay::…` id.
