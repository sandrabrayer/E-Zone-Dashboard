# Refund logic wiring — the live suggestion and payout date use the new rules (Phase 1b)

**What:** the refund suggestion in the credits modal and every stored payout
date now come from the server functions added in PR #156: `computeRefund_` and
`refundPayoutDate_` in `apps-script/Code.gs`. The old-rule calculation is gone
from `app.js`.

**User-facing.** Vered sees a different suggested amount where the rules
changed:
- in balance houses, the last 7 days count on the patient's own cycle, not on
  the calendar month;
- in rehab / dual-diagnosis houses, an exit on day 14 now gives no refund;
- the payout date follows the cutoff on the 10th, not the 15th.

She also sees the breakdown behind each suggestion.

**No role or override logic.** Sandra-only exceptions wait for personal PINs
(Phase 0b-3). The existing "amount ≠ calculated needs a reason" path is
unchanged.

## Live paths before → after

| Path | Before | After |
|---|---|---|
| Refund suggestion (credits modal, on discharge and from the discharged tab) | `suggestCredits()` in `app.js`. Old rules: calendar-month last 7 days, day 14 refunded, unknown house silently treated as rehab. | `action=suggestRefunds` → `suggestRefunds_` → `refundSuggestionsFor_` → `computeRefund_` (Code.gs). `suggestCredits`, `suggestCredit`, `applyCreditCap`, `daysInCalendarMonth` and the three rule constants are **removed** from `app.js`. |
| Stored `Credits.payoutDate` | `payoutDateFor_()`, cutoff on the 15th, re-derived on **every** save, including edits. | `creditPayoutDate_()` → `refundPayoutDate_()`, cutoff on the 10th. `payoutDateFor_` is **retired**. An edit that keeps the stored `decidedDate` keeps the stored `payoutDate`. |
| Payout date shown in the modal | `payoutDateFor()` in `app.js`, cutoff on the 15th. | `payoutDateFor()` is now a display echo with the cutoff on the 10th (`CREDIT_DECISION_CUTOFF_DAY`). A test checks it against `refundPayoutDate_` for every day of 2026–2028. A saved line shows its stored date unless its decision date is changed (`linePayoutDate`). |

These read stored values only and are unchanged: `pendingCreditsByPayout`,
הכנסות חודשיות (`creditRefundSpan`), reconciliation section J and the
`accountingCredits` feed.

## The new read action: `suggestRefunds`

- **Request:** POST `{ action: 'suggestRefunds', houseId, entryDate, exitDate, patientKey }`.
  It is a POST so the patient name, which is part of `patientKey`, never rides
  a URL.
- **Gate:** `PROXY_SECRET`, like every action outside `OPEN_ACTIONS`. In
  enforce mode a request without the secret is refused (`unauthorized`). The
  action is listed in `PROXY_KNOWN_ACTIONS` and is **not** in `OPEN_ACTIONS`.
- **Read-only:** it reads the Payments tab and never creates it, never
  backfills, takes no lock and writes no cell or audit row.
- **Success response:** `{ ok, decidedDate, payoutDate, facilityType, suggestions }`.
  `decidedDate` is today in Asia/Jerusalem.
- **Refusal:** `{ ok:false, error, field }`. The `error` codes are
  `unknown_house`, `bad_date`, `exit_before_entry`, `bad_amount`,
  `bad_coverage` and `missing_patientKey`. Messages name a field, never a
  patient.

### `refundSuggestionsFor_` (pure)

**Which payment rows count:** the patient's Payments rows, matched on the
`patientId` triple, or on the triple inside the `pay::…` id when that cell is
blank (the same rule as `normalizePayment`). Void rows are skipped. Rows are
taken in `dueDate` order.

**Each row's window:**
1. the recorded `coverageStart` / `coverageEnd` when both are usable;
2. otherwise, the entry-anchored cycle that starts on `dueDate`;
3. otherwise, for a `dueDate` that isn't a cycle start, `dueDate` … `dueDate` + 1 month − 1 day (`coverageWindowSource: 'due_date'`).

**What each row yields:** `computeRefund_` decides the figure and the rule.
- A window that ended before the exit yields nothing.
- A window that starts after the exit gives `prepaid_return` in full.
- The window that holds the exit applies the house rule.
- A day already credited by an earlier window is never credited twice. The
  row's `alreadyCreditedThrough` field records how far an earlier window
  already credited.

**Zero row:** when no row gives a `days_unused` line, one zero `days_unused`
line is still returned ("no refund owed" is a recorded decision). It comes from
the latest used row, or, when nothing was paid, from the cycle that holds the
exit (`coverageWindowSource: 'no_payment_row'`).

**`basis` (`basisVersion: 2`):** the full `computeRefund_` breakdown, plus
`paymentDueDate`, `billedAmount`, `coverageWindowSource`, `creditedFrom`,
`alreadyCreditedThrough`, `unusedDays` and `eligible`. It also keeps
`coverageStart` / `coverageEnd` / `creditedFrom`, which the revenue screen
allocates credits by.

## UI (credits modal)

**Breakdown under each server suggestion,** in Hebrew:
- the cycle dates, with the number of days;
- the days stayed in the cycle and the days not stayed;
- the daily rate (paid ÷ 30);
- the stay day at exit (rehab / dual-diagnosis);
- the last-7-days window (balance houses);
- "already credited until", when an earlier window overlapped;
- the rule applied;
- the payout date.

**Rule labels:**

| Rule | Label |
|---|---|
| `residential_prorata` | מגורים — זיכוי יחסי על הימים שלא שהה |
| `residential_last_days_zero` | 7 הימים האחרונים במחזור — ללא זיכוי |
| `detox_prorata` | גמילה/דואלי — יציאה עד יום 13 — זיכוי יחסי |
| `detox_tenure_cutoff_zero` | יום 14 ומעלה — ללא זיכוי |
| `prepaid_return` | מחזור ששולם מראש ולא התחיל — החזר מלא |
| `cycle_fully_used` | המחזור הסתיים לפני היציאה — ללא זיכוי |

**Errors are never a silent 0.** `unknown_house`, or any other refusal or a
network failure, puts a Hebrew error at the top of the modal (`.credit-error`)
and in the error banner, and no suggested line is offered. Existing lines and
"+ זיכוי ידני" stay usable. A busy lock shows «המערכת עסוקה, נסו שוב».

**Escaping:** every rendered value goes through `escapeHtml`.

**Saved credits are not recalculated or changed:**
- An existing row keeps its stored `calculatedAmount`, `basis`, `reason` and
  `payoutDate`.
- It is labelled with the rule it was decided under
  (`CREDIT_RULE_LABELS_LEGACY`, display only).
- On the server, an edit that keeps `decidedDate` keeps the stored
  `payoutDate`. This matters because the modal re-saves every line. Without it,
  a credit decided on the 11th–15th under the old cutoff would have moved a
  month later on the next save.

**`Credits.reason` stays ISO.** The audit trail written to it keeps ISO dates,
the same convention as before. The modal breakdown formats every date
DD/MM/YYYY.

**Service worker:** `CACHE_VERSION` v20 → v21, because `app.js` and
`style.css` changed. The live `/sw.js` could not be fetched from this session:
the network policy blocks `ezone-dashboard.up.railway.app`. The deploy
branch's `public/sw.js` read v20.

## Tests

- **New: `test/refund-logic-wiring.test.js`, 20 tests.** It runs the real
  `Code.gs` and the real `app.js`, with the app's `fetch` bridged into
  `handle_`. It covers:
  - the #156 boundary fixtures through `handle_` and through the modal, which
    must equal `computeRefund_`;
  - the Hebrew labels and breakdown;
  - the payout cutoff on the 10th vs the 11th (server, new saved credit,
    echo);
  - echo ↔ server parity on all 1096 days of 2026–2028;
  - a legacy credit keeping its `payoutDate`, `amount`, `basis` and `reason`
    on re-save;
  - `suggestRefunds` writing nothing;
  - the modal showing a saved credit as saved;
  - `unknown_house` and network failure shown as Hebrew errors;
  - escaping;
  - the enforce-mode gate;
  - the `getData` keys being unchanged;
  - the pre-wiring client invariants, ported to the server: recorded window,
    blank-coverage row, overlapping windows (35 days, never 61), recorded
    prepaid window, void skipped, rate from money received, the zero row,
    blank `patientId`, an off-cycle due date, a timestamp exit, and the
    revenue-allocation fields.
- **Updated: `credits-ledger`.** Payouts follow the 10th cutoff, and the
  client rule tests moved to the server file.
- **Updated: `payment-coverage-period`, `monthly-revenue`, `duplicate-payment-void`.**
  Their credit assertions were ported to the server file, and a pointer is
  left in place.
- **Updated: `refund-logic-foundation`.** The "not wired" test became
  "wired".
- **Updated: `lock-busy-frontend`.** Added `suggestRefunds` as a path, plus a
  default reply.
- **Updated: `discharge-persistence-fix`.** Added a default `suggestRefunds`
  reply.
- **Updated: `date-format-he`.** The allowlist follows the new persisted
  trail.

**Full suite:** `node --test` → 1694 / 1694.

## Deploy

- **Apps Script:** `Code.gs` changes (own commit), so clasp CI deploys it on
  merge.
- **Railway:** serves the new `app.js` and `style.css`. SW v21 evicts v20.
- **Order on merge:** if Railway serves the new `app.js` before the Apps Script
  deploy lands, `suggestRefunds` is unknown to the old backend. The modal then
  shows the Hebrew "cannot compute" error, never a 0, until clasp finishes.
