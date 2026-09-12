# Credits / refunds ledger (Credits sheet)

**Why:** a discharge today records *that* a patient left, but nothing records
whether money is owed back — a short stay, a month paid in advance, or the
explicit decision that **no** refund is due. This adds an append-only
`Credits` sheet plus a Hebrew RTL flow that suggests the credit on discharge,
lets Vered accept or override it (with a mandatory reason), and keeps every
decision — including a zero — as an auditable row.

The Patients and Payments sheet structures are **not** modified. The
Outpatient repo is untouched. Apps Script must be redeployed (New version →
Deploy) for the two new actions to exist; until then the client fails soft
(empty ledger, everything else loads).

## Schema — `CREDIT_COLUMNS` (append-only; position is the contract)

| # | column | meaning |
|---|--------|---------|
| 1 | `id` | `credit::<patientId>::<allocationMonth>::<seq>` — **minted server-side** under the script lock; `seq` = 1-based count of rows already carrying that patientId+month. Clients never mint ids; an unknown id is refused. |
| 2 | `patientId` | the **persisted Patients `id`** (PATIENT_COLUMNS position 11). Joins to Patients; survives the identity migration. |
| 3 | `patientKey` | the legacy triple `houseId::name::entryDate` (`patientKey()` in app.js). Joins to **Payments** (whose `patientId` column *is* this triple). |
| 4 | `patientName` | display copy |
| 5 | `houseId` | display copy |
| 6 | `creditType` | `days_unused` \| `prepaid_return` \| `other` — validated server-side against `CREDIT_TYPES` |
| 7 | `allocationMonth` | plain-text `YYYY-MM`; column text-forced (`@`) at sheet-ensure time |
| 8 | `calculatedAmount` | what the rule computed (VAT-inclusive). **Immutable after creation.** |
| 9 | `amount` | the credit granted (VAT-inclusive). ≠ `calculatedAmount` ⇒ `overrideReason` required |
| 10 | `overrideReason` | why `amount` differs (`''` when equal) |
| 11 | `reason` | the calculation trail at creation (rate, days, the **uncapped** figure, the cap); for `other`, the free-text justification. Immutable. |
| 12 | `approvedBy` | free text |
| 13 | `status` | `pending` \| `paid` \| `cancelled` (validated) |
| 14 | `paymentDate` | `YYYY-MM-DD` of the payout, text-forced |
| 15 | `method` | free text |
| 16 | `notes` | free text (editable) |
| 17–18 | `createdAt`, `createdBy` | server clock + signed-cookie user (PR #113 stamping). Immutable. |
| 19–20 | `updatedAt`, `updatedBy` | server clock + signed-cookie user of the last write |

Both identity keys are **written on every row and never derived from each
other at read time** (`normalizeCredit` reads them as stored;
`creditsForPatient` joins on either).

**Amounts are stored VAT-inclusive**, matching `pay` and `Payments.amount`.
Every derived display divides by `VAT_RATE` (1.18) — the modal shows
`₪ X (₪ Y ללא מע"מ)` for the computed figure and echoes the ex-VAT value under
the editable (VAT-inclusive) amount input.

## The two calculated credit types — `suggestCredits(patient, exitDate, payments)` (pure, app.js)

`exitDate` is normalized through the existing `isoDate()` **before any date
math** — it can arrive as a raw ISO timestamp, and a naive `slice(0,10)`
drifts −1 day in Israel. All arithmetic then uses local
`getFullYear/getMonth/getDate` parts; day spans use `Math.round` so a DST
switch between two local midnights never shifts a day.

### `days_unused` — always emitted (a zero is still a decision)

- `tenureDays = exitDate − entryDate` in whole days.
- **Credited month** = billed month (`monthKey(dueDate)`) of the *latest*
  Payments row for this `patientKey` with `dueDate ≤ exitDate` — the row
  covering the end of the stay. No such row ⇒ the exit date's calendar month.
- **Coverage period** of a payment row: `dueDate` through
  `dueDate + 1 month − 1 day`, local parts, day-of-month clamped
  (Jan 31 → Feb 27/28). No row ⇒ the full calendar month. We never look
  ahead to a "next payment row" — it is usually absent at discharge.
- **Divisor constant** — inside `suggestCredits`, one named constant:
  ```js
  /* >>> DIVISOR BASIS — the single place to change the daily-rate rule. <<< */
  const DAYS_IN_MONTH = daysInCalendarMonth(ay, am);   // 28 / 29 / 30 / 31
  ```
  `dailyRate = monthlyRate / DAYS_IN_MONTH`, where `monthlyRate` is the
  covering row's `amount` (fallback `patient.pay`).
- `unusedDays = daysPaidFor − daysStayed` inside the coverage period (the
  exit day counts as stayed).
- `tenureDays ≥ CREDIT_MIN_TENURE_DAYS` (14) ⇒ `calculatedAmount = 0`.
- **Cap:** `calculatedAmount = min(dailyRate × unusedDays, amountPaid for the
  credited month)`. Never more than was received; `amountPaid = 0` ⇒ `0`.
  The uncapped figure is kept in `basis.uncappedAmount` (+ `basis.capped`)
  and written into `reason`, so the cap is visible, not silent.

### `prepaid_return` — independent of the 14-day rule

One suggestion per billed month of the payment rows whose **`dueDate` is
after `exitDate`** (coverage never began). This is the "billed month later
than the discharge month" rule, and it also catches a same-month row that
falls due after the exit. `calculatedAmount = amountPaid` for that month —
never the billed `amount`, which is kept in `basis.uncappedAmount`. A
patient at 40 days still gets any prepaid future month back.

### `other`

Manual line (`+ זיכוי ידני` in the modal): `calculatedAmount` = the entered
amount, `reason` required, month picked by hand.

## Flow

1. **Discharge** (`dischargePatient`): the existing two writes run unchanged
   (audit row → `saveAll`). Only after **both** succeed (and the optional
   Outpatient lead) does `showCreditsModal` open with the suggestions. A
   failed or cancelled credit write **never rolls the discharge back** — the
   banner reports it and the discharge stays.
2. **Recovery / edit** — `מטופלים משוחררים` tab, edit mode: a `זיכויים (n)`
   button per row opens the same modal for an already-discharged patient
   (`openCreditsForDischarged`): existing rows are editable, missing
   suggestions are proposed, nothing touches the discharge record. The
   persisted `patientId` comes from the live Patients row (matched by the
   houseId+name+entryDate key the restore flows use).
3. **Modal** (Hebrew RTL, existing `.modal` styling): per line — month,
   computed figure (incl. + ex-VAT, cap notice), editable amount, the
   override-reason field (revealed when the amount differs; **required**),
   status, notes, and the calculation trail. Save is guarded by
   `withBusyButton`; every line is validated (`validateCreditLine`) before
   the first write; lines are written one by one and the run stops on the
   first failure with the modal open (saved lines are marked, so a retry
   edits instead of duplicating).
4. **Stale-save refusal:** an edit echoes the `updatedAt` it loaded; a
   differing sheet stamp is refused server-side with the same `conflicts`
   shape the Patients merge returns, the client shows the existing Hebrew
   conflict banner (who saved first), reloads the ledger and rebuilds the
   lines from the sheet's version.

## Security

- No new unauthenticated endpoint: `getCredits` / `saveCredit` are Apps
  Script actions reached only through the session-cookie-gated
  `/api/sheets` proxy (`requireSession`). `server.js` is unchanged.
- `updatedBy` / `createdBy` come from `requestUser_(params)` — the `user`
  the proxy overwrites from the **signed** cookie; payload copies are ignored.
- Server-side validation of everything the client sends: `creditType` and
  `status` against fixed lists, `allocationMonth` regex, finite non-negative
  amounts, both identity keys present, `overrideReason` when
  `amount ≠ calculatedAmount`, `reason` for `other`; strings trimmed,
  angle brackets stripped, length-capped. On edit only
  `CREDIT_EDITABLE_COLUMNS` are taken from the payload.
- Backend refusals are never swallowed: `apiPost` throws on `{ok:false}`
  even on HTTP 200, and now carries the parsed body (`err.data`) so the
  conflict details reach the banner; a 200 without the echoed credit is
  treated as a failure.

## Tests — `test/credits-ledger.test.js` (24, vm-sandbox on the shipped files, TZ = Asia/Jerusalem)

Backend: pinned column order; sheet auto-create + text-forced columns;
server-minted id + seq; stamps from `body.user`; both keys round-trip via
`getCredits`; bad `creditType` / status / month / key / amount refused;
override without reason refused (and stored with one, `calculatedAmount`
untouched); zero credit written; edit immutability under a tampering payload;
stale-edit conflict (row byte-unchanged, `sheetUpdatedBy` reported); unknown
id refused; `server.js` has no credit route.

Rule: tenure **13 / 14 / 15**; months of **28 / 30 / 31** days;
`prepaid_return` at tenure 40 (later months + same-month row, partial
future payment); raw-ISO exit at a **month boundary** and across the
**March and October DST** switches with no day drift; coverage clamping;
**partial payment** where the uncapped figure exceeds `amountPaid`;
**`amountPaid` 0**; **no payment row** at all; `validateCreditLine` override
path; `normalizeCredit` / `creditsForPatient` / `buildCreditLines`.

Integration: credits offered only after both discharge writes succeed (with
`patientId`, `patientKey`, normalized `exitDate`); a failed discharge never
reaches credits; `saveCredit` surfaces `{ok:false}` on 200, a missing echo,
and a conflict (banner names who saved first) while the discharge stays
released.

A Chromium smoke run of the modal (render, override gating, refusal with no
network call, conflict banner, success path) was also performed during
development; it is not part of `npm test`.

## Files

- `apps-script/Code.gs` — `CREDITS_SHEET`, `CREDIT_COLUMNS`, `CREDIT_TYPES`,
  `CREDIT_STATUSES`, `CREDIT_EDITABLE_COLUMNS`; `getOrCreateSheet_` Credits
  branch; `getCredits_`, `upsertCredit_`, `creditId_`; `handle_` dispatch.
- `public/app.js` — `state.credits` + `getCredits` in `loadAll`; `apiPost`
  error body; `suggestCredits` / `suggestCredit` + date helpers;
  `validateCreditLine`, `normalizeCredit`, `creditsForPatient`,
  `buildCreditLines`, `creditBasisText`; `saveCredit`, `reloadCredits`,
  `showCreditsModal`, `openCreditsForDischarged`; discharge hook; discharged
  tab button.
- `public/style.css` — `.credits-modal` / `.credit-*`.
- `test/credits-ledger.test.js`, this file.
