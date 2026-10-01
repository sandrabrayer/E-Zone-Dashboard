# Refund payout forecast — what goes out on each 15th, and what is still open

**What:** the existing «זיכויים ממתינים לתשלום» section on the גבייה tab
(PR #124) now also shows two more groups, read from a new server action:
- discharges that still need a refund **decision**;
- discharges that have **no payment data** to decide from.

A «ייצוא להנהלת חשבונות» button exports all three groups as CSV.

**This is not a second view.** The existing pending list (`renderCreditsPayouts`
→ `pendingCreditsByPayout`, stored `payoutDate`) is unchanged. The new block
sits under it, inside the same section.

Plan: `docs/billing-control-plan.md` §14.1. Base: `claude/build-ezone-dashboard-QOg5s`.

## Server — `action=refundPayoutForecast` (`apps-script/Code.gs`, own commit)

- **Read-only.** It reads `Credits`, `מטופלים משוחררים` and `Payments` with
  `getSheetByName`. It never creates a tab, never backfills, takes no lock and
  writes no cell or audit row. A missing tab reads as empty.
- **Gate:** `PROXY_SECRET`, like every action outside `OPEN_ACTIONS`. It is
  listed in `PROXY_KNOWN_ACTIONS` and is **not** in `OPEN_ACTIONS`. In enforce
  mode a request without the secret gets `{ok:false,error:'unauthorized'}`.
- **Pure core:** `refundPayoutForecastFor_(discharged, credits, payments, todayIso)`.
  The wrapper `refundPayoutForecast_()` adds `generatedAt`.

### The three sections (never summed together)

| Section | Rows | Row fields |
|---|---|---|
| `decided` | Saved credits with `status = 'pending'` and `amount > 0`. Grouped by the **stored** `payoutDate`, which is never recomputed. A credit decided under the old 15th cutoff keeps its date. | `patientName`, `houseId`, `amount`, `decidedDate`, `payoutDate`, `rule` (from the stored `basis`, else `creditType`), `overrideReason`, `creditId` |
| `awaiting_decision` | Discharges with an exit on or after the records cutoff (`2026-07-01`, `recRecordsCutoff_`) and **no saved credit for that stay**, where `refundSuggestionsFor_` → `computeRefund_` totals **> 0** | `patientName`, `houseId`, `entryDate`, `exitDate`, `suggestedAmount`, `rule`, `payoutDate` (the date if decided today, from `refundPayoutDate_`: 10th vs 11th) |
| `missing_payment_data` | Same cutoff, no saved credit, and **no recorded payment covering the exit cycle**, so the suggestion would be 0 only for lack of data | `patientName`, `houseId`, `entryDate`, `exitDate`, `note: «אין תשלום רשום — לבדוק»`. It has **no amount field at all**, so it can never read as 0. |

`decided` and `awaiting_decision` each carry `count`, `total`,
`byPayoutDate[]` (with rows) and `byHouse[]`. There is no grand total across
sections.

**Also returned:**
- `unresolved`: a discharge the rules refused, for example `unknown_house`, or
  a missing entry or exit date (`bad_date`). It carries the error code, never a
  0.
- `zeroByPolicyCount`: discharges whose suggestion is a real 0 backed by data,
  for example an exit in the last 7 days of the cycle. They are counted, not
  listed.
- `today`, `recordsCutoff`, `payoutDateIfDecidedToday`, `generatedAt`.

### Definitions

- **A stay** is the triple `houseId::trimmed name::entry day (Asia/Jerusalem)`,
  the same triple as `patientKey_`. A credit belongs to the stay when its
  stored `patientKey`, reduced the same way, is equal.
  - Any saved row counts as a decision: pending, paid, cancelled or zero.
  - A restored discharge is not a discharge.
  - Two discharge rows for the same stay count once, using the later exit.
- **"Covering the exit cycle"** means the suggestion's own line for the cycle
  that holds the exit comes from a real Payments row with `amountPaid > 0`.
  - A void row, an unpaid row (`amountPaid = 0`) or an earlier fully-used
    cycle does not count.
  - The test uses the same window rules as `suggestRefunds`, so the two can't
    disagree.
- **Precedence:** a suggestion > 0 goes to `awaiting_decision`, for example a
  prepaid future cycle. Only a 0 with no payment goes to `missing_payment_data`.

## UI (`public/app.js`, `index.html`, `style.css`)

**Under the existing pending list:**
- «רענון» and «ייצוא להנהלת חשבונות» buttons (`busyButton`);
- `#credits-forecast`, which shows:
  - **«ממתין להחלטה — לא לתשלום»**: muted, dashed edge. Each row shows name,
    house, exit, suggested amount, rule label and «תשלום אם יוחלט היום».
    Totals per house.
  - **«חסרים נתוני תשלום — לבדוק»**: amber. Each row reads «אין תשלום רשום —
    לבדוק», with no amount.
  - **«לא ניתן לחשב — לבדוק»**: shown only when there are `unresolved` rows,
    each with its Hebrew reason.

**Loading and errors:**
- While loading it shows «טוען תחזית החזרים…».
- A failure, a bad response or a busy lock shows «טעינת תחזית ההחזרים נכשלה —
  … אין להסיק שהן ריקות» in the box and in the error banner.
- An empty section says so in words. A list is never silently empty.

**When it fetches:**
- only while the גבייה screen is shown, or on «רענון»;
- a credit save marks it stale, so the next render re-fetches.
- It is a POST, so no URL carries anything.

**Escaping:** every value goes through `escapeHtml`, and every date through
`formatDateHe`.

### CSV — `buildPayoutForecastCsv(data, generatedAt)` (pure)

- **Encoding:** a UTF-8 BOM, `\r\n` line endings, every text cell quoted with
  `"` doubled.
- **Formula guard:** a text cell starting with `=` `+` `-` `@`, a tab or a CR
  gets a leading `'`. Numbers are written as numbers.
- **Header lines:** title, `הופק` (generated at, DD/MM/YYYY HH:MM) and
  «הסעיפים אינם מסתכמים יחד».
- **Sections:** «סעיף א׳ — הוחלט — ממתין לתשלום», «סעיף ב׳ — ממתין להחלטה —
  לא לתשלום», «סעיף ג׳ — חסרים נתוני תשלום — לבדוק», plus «סעיף ד׳» when
  there are `unresolved` rows.
  - Each section has Hebrew headers.
  - Sections A and B list totals per payout date, per house, and a section
    total. There is no cross-section total.
- **File name:** `refund-payout-forecast-YYYY-MM-DD.csv`.

## Service worker

`CACHE_VERSION` v21 → v22, because `app.js`, `index.html` and `style.css`
changed. **I could not read the live `/sw.js`:** the network policy refuses
`ezone-dashboard.up.railway.app` (CONNECT 403). The bump is from the deploy
branch's `public/sw.js`, which reads v21.

## Tests

**New: `test/refund-payout-forecast.test.js`, 17 tests.** They run the real
`Code.gs` and `app.js`. Coverage:
- **decided:**
  - uses the stored `payoutDate` as-is, including an old-cutoff date and one
    nothing would compute today;
  - excludes paid, cancelled and zero credits;
  - totals per date and per house.
- **awaiting_decision:**
  - excludes a stay with a saved credit, including a zero credit stored with
    stray spaces in its key;
  - excludes a 0 suggestion, which is counted in `zeroByPolicyCount` and is
    not "missing";
  - includes a prepaid return.
- **missing_payment_data:**
  - catches no payment, only an earlier cycle paid, and only a void row;
  - a missing row has no amount and no field equal to 0.
- **unresolved:** an unknown house or a missing entry date, never 0.
- **records cutoff:** an exit on 2026-06-30 is excluded; one on 2026-07-01 is
  included.
- **restored discharges** are excluded.
- **sections:** no grand total.
- **payout date if decided today:** the 10th gives 2026-10-15; the 11th gives
  2026-11-15; and across the year end.
- **read-only:** nothing is written, and no tab is created even when every tab
  is missing.
- **gate:** refused without `PROXY_SECRET` in enforce mode, refused with a
  wrong secret, served with the right one; not in `OPEN_ACTIONS`; in
  `PROXY_KNOWN_ACTIONS`.
- **`getData`** keeps its keys.
- **CSV:** BOM, generated-at line, Hebrew headers, section labels, the formula
  guard on `=`, `+`, `-` and `@` names, and no 0 on a missing row.
- **UI:**
  - both labels present, `<img onerror>` escaped, no ₪0 in the missing
    section;
  - the loading state, then the rendered sections;
  - the error state, in the box and the banner;
  - no fetch off the גבייה screen;
  - a credit save marks it stale;
  - `index.html` holds one payout list, with the forecast under it.

**Also updated:**
- `test/lock-busy-frontend.test.js`: `refundPayoutForecast` is added as a
  busy-lock path, because its guard requires every `apiPost` action to have
  one.

**Full suite:** `node --test` → 1713 / 1713.

A Chromium smoke run of the section was **not** performed in this session.

## Deploy

- **Apps Script:** `Code.gs` changes in its own commit, so clasp CI deploys it
  on merge.
- **Railway:** serves the new `app.js`, `index.html` and `style.css`. SW v22
  evicts v21.
- **Order on merge:** if Railway lands before the Apps Script deploy, the
  action is unknown to the old backend. The box then shows the explicit Hebrew
  load error, never an empty list, until clasp finishes. The existing pending
  list is unaffected.
