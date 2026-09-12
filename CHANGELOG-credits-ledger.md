# Credits / refunds ledger (Credits sheet)

**Why:** a discharge recorded *that* a patient left, but nothing recorded
whether money is owed back — a short stay, a month paid in advance, or the
explicit decision that **no** refund is due. This adds an append-only
`Credits` sheet plus a Hebrew RTL flow that suggests the credit on discharge
per the facility's policy, lets Vered accept or override it (with a mandatory
reason), schedules the payout for the 15th, and keeps every decision —
including a zero — as an auditable row.

The Patients and Payments sheet structures are **not** modified. The
Outpatient repo is untouched. Apps Script must be redeployed (New version →
Deploy) for the two new actions to exist; until then the client fails soft
(empty ledger, everything else loads).

## Facility types — `FACILITY_TYPE_BY_HOUSE`

Keyed by the Patients-sheet `houseId` (the ids in `HOUSES`, app.js), **not**
by Hebrew display name. Identical map in `Code.gs` and `app.js`; the server
re-derives `facilityType` from `houseId` on every write and refuses an
unknown house (`bad_houseId`).

| houseId | house | facilityType |
|---------|-------|--------------|
| `asher` | רעננה אשר | `residential` |
| `ramot` | רמות השבים | `residential` |
| `rehab` | קיסריה ריהאב | `detox_dual` |
| `pardes` | רעננה הפרדס | `detox_dual` |
| `arfoni` | קיסריה עפרוני | `detox_dual` |
| `sde` | שדה אליעזר | `detox_dual` |

## Schema — `CREDIT_COLUMNS` (append-only; position is the contract)

| # | column | meaning |
|---|--------|---------|
| 1 | `id` | `credit::<patientId>::<allocationMonth>::<seq>` — **minted server-side** under the script lock; `seq` = 1-based count of rows already carrying that patientId+month. Clients never mint ids; an unknown id is refused. |
| 2 | `patientId` | the **persisted Patients `id`** (PATIENT_COLUMNS position 11). Joins to Patients; survives the identity migration. |
| 3 | `patientKey` | the legacy triple `houseId::name::entryDate` (`patientKey()` in app.js). Joins to **Payments** (whose `patientId` column *is* this triple). |
| 4 | `patientName` | display copy |
| 5 | `houseId` | display copy (validated against the facility map) |
| 6 | `facilityType` | `residential` \| `detox_dual` — **derived server-side** from `houseId` |
| 7 | `creditType` | `days_unused` \| `prepaid_return` \| `other` — validated against `CREDIT_TYPES` |
| 8 | `allocationMonth` | plain-text `YYYY-MM`; text-forced (`@`) at sheet-ensure time |
| 9 | `calculatedAmount` | what the rule computed (VAT-inclusive). **Immutable after creation.** |
| 10 | `amount` | the credit granted (VAT-inclusive). ≠ `calculatedAmount` ⇒ `overrideReason` required |
| 11 | `overrideReason` | why `amount` differs (`''` when equal) |
| 12 | `reason` | human-readable calculation trail at creation (rule, days, rate, the **uncapped** figure); for `other`, the free-text justification. Immutable. |
| 13 | `approvedBy` | free text |
| 14 | `decidedDate` | `YYYY-MM-DD` the credit was approved (defaults to the save day, spreadsheet tz); text-forced |
| 15 | `payoutDate` | **derived server-side**: the 15th of the next month on or after `decidedDate`; text-forced |
| 16 | `status` | `pending` \| `paid` \| `cancelled` (validated) |
| 17 | `paidDate` | `YYYY-MM-DD` actually paid; **required with `method` when `status = paid`**; cleared otherwise; text-forced |
| 18 | `method` | how it was paid (free text) |
| 19 | `notes` | free text (editable) |
| 20 | `basis` | compact JSON of the calculation inputs/outputs (`rule`, `facilityType`, tenure, days, `divisor`, `uncappedAmount`, cap). Immutable. |
| 21–22 | `createdAt`, `createdBy` | server clock + signed-cookie user (PR #113 stamping). Immutable. |
| 23–24 | `updatedAt`, `updatedBy` | server clock + signed-cookie user of the last write |

Both identity keys are **written on every row and never derived from each
other at read time** (`normalizeCredit` reads them as stored;
`creditsForPatient` joins on either).

**Amounts are stored VAT-inclusive**, matching `pay` and `Payments.amount`.
Every derived display divides by `VAT_RATE` (1.18): the modal shows
`₪ X (₪ Y ללא מע"מ)` for the computed figure and echoes the ex-VAT value under
the editable (VAT-inclusive) amount input; the payout view shows both.

## Calculation — `suggestCredits(patient, exitDate, payments)` (pure, app.js)

Returns an array of `{ creditType, calculatedAmount, allocationMonth, basis }`.

`exitDate` is normalized through the existing `isoDate()` **before any date
math** — legacy rows carry a full ISO timestamp, and a naive `slice(0,10)`
drifts −1 day in Israel. All arithmetic uses local
`getFullYear/getMonth/getDate` parts; day spans use `Math.round` so a DST
switch between two local midnights never shifts a day.

### The ÷30 constant

```js
/* >>> DIVISOR — the single named constant behind the daily rate. <<< */
const CREDIT_DAYS_DIVISOR = 30;
```

`dailyRate = amountPaid for the credited month / CREDIT_DAYS_DIVISOR` — for
**both** facility types, fixed 30, **never** the calendar day count of the
month. A 28-day February and a 31-day August produce the same daily rate for
the same money received.

### Coverage period

A payment row with `dueDate` D covers D through **D + 1 month − 1 day**
(local parts, day-of-month clamped: Jan 31 → Feb 27/28). We never look ahead
to a "next payment row" — it is usually absent at discharge. The **credited
month** is the billed month (`monthKey(dueDate)`) of the *latest* Payments
row for this `patientKey` with `dueDate ≤ exitDate`; when no such row exists
the fallback is the exit date's **full calendar month** with `amountPaid = 0`.

`daysNotStayed = daysPaidFor − daysStayed` inside that period (the exit day
counts as stayed). `uncapped = dailyRate × daysNotStayed`.

### The amountPaid cap

`calculatedAmount = min(uncapped, amountPaid for the credited month)`. Never
more than was actually received; `amountPaid = 0` ⇒ `0`. The uncapped figure
is always kept in `basis.uncappedAmount` (with `basis.capped`) and written
into `reason`, so the cap is visible, never silent. Because the rate itself
is built from `amountPaid`, the cap binds only when `daysNotStayed > 30`
(a 31-day coverage with no days stayed, i.e. bad data) — it is a safety net.

### Residential policy (אשר, רמות)

Pro-rata refund of unused days at **any tenure** — no tenure cutoff.
**Except:** an exit inside the **last 7 calendar days of its month**
(`dayOfMonth > daysInMonth − 7`: days 22–28 in February, 24–30 in a 30-day
month, 25–31 in a 31-day month) ⇒ `calculatedAmount = 0`. The row is still
emitted (`days_unused`) with `basis.rule = 'residential_last_days_zero'` and
the uncapped figure it would have been. The window is judged on the **exit
date's** month even when the credited (billed) month is earlier.

### Detox / dual policy (ריהאב, הפרדס, עפרוני, שדה אליעזר)

`tenureDays = exitDate − entryDate` (whole days). Under 14 days ⇒ pro-rata
as above. **14 days or more ⇒ `calculatedAmount = 0`.** This is a
**discretionary** cutoff (`basis.rule = 'detox_tenure_cutoff_zero'`,
`basis.discretionary = true`), not a hard block: Sandra approves exceptions
through the ordinary override path — the amount input is never disabled or
hidden for it, the modal shows the uncapped figure the override may
restore, and the override reason is required as always.

An unknown `houseId` falls back to the stricter detox policy in the
suggestion (`basis.facilityKnown = false`); the server refuses to store a
row for it (`bad_houseId`).

### prepaid_return — independent of both policies

Regardless of tenure, facility type or the last-7-days window: one credit
per **billed month later than the discharge month** among the patient's
Payments rows, `calculatedAmount = amountPaid` for that month — never the
billed `amount`, which is kept in `basis.uncappedAmount`. Unearned future
money always returns. (A same-month row due *after* the exit is not a later
billed month and is not emitted — see the PR notes.)

### `other`

Manual line (`+ זיכוי ידני`): `calculatedAmount` = the entered amount,
`reason` required, month picked by hand.

## Payout schedule

Credits **pay out on the 15th**, never at discharge.

- `decidedDate` — when approved (defaults to the save day).
- `payoutDate` — `payoutDateFor(decidedDate)`: the 15th of the next month on
  or after `decidedDate`. Decided on the 14th → the 15th of that month; on
  the 15th → that same day; on the 16th → the 15th of the following month.
  Derived server-side on every write (`payoutDateFor_`); the client mirror
  only previews it.
- **Marking paid is an explicit action**: `status = paid` requires
  `paidDate` **and** `method` (client validation and server
  `paid_requires_paidDate_method`). Nothing flips to paid when `payoutDate`
  passes. The payout view's `סמן כשולם` opens a small modal for method +
  date and saves through the same stale-save-guarded edit.
- **Payout view** (גבייה tab, "זיכויים ממתינים לתשלום"): pending credits
  grouped by `payoutDate` ascending with a total per date (incl. and
  ex-VAT) and a grand total pill, so the outgoing amount is visible before
  each 15th. Each row offers `סמן כשולם` and `ערוך` in edit mode.

## Flow

1. **Discharge** (`dischargePatient`): the existing two writes run unchanged
   (audit row → `saveAll`). Only after **both** succeed (and the optional
   Outpatient lead) does `showCreditsModal` open with the suggestions. A
   failed or cancelled credit write **never rolls the discharge back** — the
   banner reports it and the discharge stays.
2. **Recovery / edit** — `מטופלים משוחררים` tab, edit mode: a `זיכויים (n)`
   button per row opens the same modal for an already-discharged patient
   (`openCreditsForDischarged`); existing rows are editable, missing
   suggestions are proposed, nothing touches the discharge record. The
   persisted `patientId` comes from the live Patients row (matched by the
   houseId+name+entryDate key the restore flows use). The payout view's
   `ערוך` opens the modal keyed by the row's own stored identity.
3. **Modal** (Hebrew RTL, existing `.modal` styling): per line — month, the
   computed figure (incl. + ex-VAT), the policy rule that produced it, the
   pre-rule / pre-cap figure where relevant, editable amount, the
   override-reason field (revealed when the amount differs; **required**),
   approved-by, decided date with the derived payout date, status, the
   paid-date + method fields (revealed on `paid`), notes, and the trail.
   Save is guarded by `withBusyButton`; every line is validated
   (`validateCreditLine`) before the first write; lines are written one by
   one and the run stops on the first failure with the modal open
   (saved lines are marked, so a retry edits instead of duplicating).
4. **Stale-save refusal:** an edit echoes the `updatedAt` it loaded; a
   differing sheet stamp is refused server-side with the same `conflicts`
   shape the Patients merge returns; the client reloads the ledger, shows the
   existing Hebrew conflict banner (who saved first) and rebuilds the lines
   from the sheet's version.

## Security

- No new unauthenticated endpoint: `getCredits` / `saveCredit` are Apps
  Script actions reached only through the session-cookie-gated
  `/api/sheets` proxy (`requireSession`). `server.js` is unchanged.
- `updatedBy` / `createdBy` come from `requestUser_(params)` — the `user`
  the proxy overwrites from the **signed** cookie; payload copies are ignored.
- Server-side validation of everything the client sends: `creditType`,
  `status`, `houseId` against fixed lists (`facilityType` derived, never
  trusted), `allocationMonth` regex, dates via `asISODate_`, finite
  non-negative amounts, both identity keys present, `overrideReason` when
  `amount ≠ calculatedAmount`, `reason` for `other`, `paidDate` + `method`
  for `paid`; strings trimmed, angle brackets stripped, length-capped;
  `basis` capped at 4000 chars. On edit only `CREDIT_EDITABLE_COLUMNS` are
  taken from the payload; `payoutDate` is always re-derived.
- Backend refusals are never swallowed: `apiPost` throws on `{ok:false}`
  even on HTTP 200 and carries the parsed body (`err.data`) so the conflict
  details reach the banner; a 200 without the echoed credit is a failure.

## Tests — `test/credits-ledger.test.js` (30, vm-sandbox on the shipped files, TZ = Asia/Jerusalem)

Backend: pinned 24-column order + facility map; sheet auto-create with the
six text-forced columns; server-minted id + seq; stamps from `body.user`;
`facilityType` / `payoutDate` derived (forged payload values ignored); both
keys round-trip via `getCredits` with `basis` as JSON; bad creditType /
status / month / key / amount / houseId / decidedDate refused; `paid`
without paidDate or method refused; override without reason refused (and
stored with one, `calculatedAmount` untouched); zero credit written;
`payoutDateFor_` on the 14th / 15th / 16th and across a year end; explicit
mark-paid edit (nothing automatic, un-paying clears `paidDate`, a new
`decidedDate` re-derives `payoutDate`); edit immutability under a tampering
payload (basis, facilityType, payoutDate included); stale-edit conflict
(row byte-unchanged, `sheetUpdatedBy` reported); unknown id refused;
`server.js` has no credit route.

Rules: the **same discharge under both facility types** (20-day stay:
residential 2,700 vs detox 0 with the override figure on record); detox at
**13 / 14 / 15** days; residential **inside and outside the last-7 window in
28 / 30 / 31-day months** (and judged on the exit month when the credited
month differs); **divisor 30 regardless of month length**; prepaid_return at
tenure 40 **and** inside the last-7 window, partial future payment,
same-month row not emitted; raw-ISO exit at a **month boundary** (Aug 31
21:00Z is Sep 1, not inside the August window) and across the **March and
October DST** switches; coverage clamping; partial payment (rate from
`amountPaid`) and a cap-binding case with the figure in basis + trail;
**`amountPaid` 0**; **no payment row**; `payoutDateFor` client mirror +
`pendingCreditsByPayout` grouping/totals; `validateCreditLine` override and
paid rules; `normalizeCredit` / `creditsForPatient` / `buildCreditLines`.

Integration: credits offered only after both discharge writes succeed (with
`patientId`, `patientKey`, normalized `exitDate`); a failed discharge never
reaches credits; `saveCredit` surfaces `{ok:false}` on 200, a missing echo,
and a conflict (banner names who saved first) while the discharge stays
released; no network call outside edit mode.

A Chromium smoke run of the modal and payout view was performed during
development; it is not part of `npm test`.

## Files

- `apps-script/Code.gs` — `FACILITY_TYPE_BY_HOUSE`, `facilityTypeFor_`;
  `CREDITS_SHEET`, `CREDIT_COLUMNS`, `CREDIT_TYPES`, `CREDIT_STATUSES`,
  `CREDIT_PAYOUT_DAY`, `CREDIT_TEXT_COLUMNS`, `CREDIT_EDITABLE_COLUMNS`;
  `getOrCreateSheet_` Credits branch; `getCredits_`, `upsertCredit_`,
  `creditId_`, `payoutDateFor_`; `handle_` dispatch.
- `public/app.js` — `state.credits` + `getCredits` in `loadAll`; `apiPost`
  error body; facility map + labels; `CREDIT_DAYS_DIVISOR`,
  `CREDIT_DETOX_TENURE_CUTOFF_DAYS`, `CREDIT_RESIDENTIAL_LAST_DAYS`,
  `CREDIT_PAYOUT_DAY`; `suggestCredits` / `suggestCredit` + date helpers;
  `payoutDateFor`, `applyCreditCap`, `validateCreditLine`, `normalizeCredit`,
  `creditsForPatient`, `pendingCreditsByPayout`, `buildCreditLines`,
  `creditBasisText`; `saveCredit`, `reloadCredits`, `showCreditsModal`,
  `openCreditsForDischarged`, `openCreditsForCredit`,
  `showMarkCreditPaidModal`, `renderCreditsPayouts` (+ `renderAll` hook);
  discharge hook; discharged-tab button.
- `public/index.html` — "זיכויים ממתינים לתשלום" section on the גבייה screen.
- `public/style.css` — `.credits-modal` / `.credit-*` / payout view.
- `test/credits-ledger.test.js`, this file.
