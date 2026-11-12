# CHANGELOG — «גבייה» as a secondary menu of single sections, with slices and «חתך לפי»

Date: 2026-11-12 · Branch `claude/billing-sections` → base `claude/build-ezone-dashboard-QOg5s`
Sandra: «צריך לאפשר לעשות גם חתך לפי גורם מממן, בנוסף בשביל לא לגולל למטה לחפש זיכויים / חובות פתוחים
לפי מטופל צריך שבגבייה יפתח תפריט משני מצד ימין ואפשר יהיה לנתח ולראות כל סעיף גבייה לבדו. ממש כמו
CRM. תחפש שאין סעיף שמגיעים אליו פעמיים לאותו מידע, ככל שיש כזה תעשה פחות סעיפים ותאפשר יותר חתכים
לרבות חיפוש מטופל או חיפוש גורם מממן.»

## What changes on the screen
«גבייה» was one long page. It is now a **secondary menu on the right** (chips across the top on
a phone); each item opens ONE section, alone, with a count badge:

| Section | What it is |
| --- | --- |
| סקירה | the headline numbers + debt aging; every card opens its section. No lists. |
| לגבייה בתאריך | who pays on a chosen day (+ a «גורם מממן» column) |
| צפי תזרים | expected receipts between two dates, net of refunds; ONE list under the cards |
| חובות פתוחים | the ONE list of past debts |
| תקבולים | money received, in a period |
| זיכויים לתשלום | the ONE list of refunds to pay |
| שיוך תשלומים | payments with no patient |
| חריגים לבדיקה | records that cannot both be true |
| ניקוי חובות היסטוריים | Vered / Sandra only (not Ortal) |

Leaving «גבייה» and coming back returns to the section you were on.

## Duplicates removed (one place per piece of information)
| Was shown in | Now only in |
| --- | --- |
| «רשימת חייבים לגבייה» + «חובות פתוחים לפי מטופל/ת» + the search-results debts table | **חובות פתוחים** |
| «זיכויים לתשלום» table + the forecast's «זיכויים בטווח» list + the list behind the forecast's refunds card | **זיכויים לתשלום** (the forecast card opens it) |
| the forecast's «פירוט לפי מטופל/ת» + the list behind each forecast card | one list in **צפי תזרים**; a kind card narrows it |
| the debt KPIs + «גיול חוב» tiles as filters in the middle of the page | **סקירה** cards that open the section with the filter set |
| «חוב לפי בית» table | «חתך לפי → בית» in **חובות פתוחים** |
| the search-results receipts table | **תקבולים**, narrowed by the search |

## Slices («חתכים») — one bar, shared by every section
- **חיפוש מטופל/ת** — words over the patient, the house and the funder (so typing «ביטוח» finds
  the funder). The same search as the box at the top of the screen; either one works.
- **גורם מממן** — in לגבייה בתאריך, צפי תזרים, חובות פתוחים, תקבולים. (A refund and an unlinked
  payment have no funder — the selector is not offered there.)
- **בית** — everywhere.
- «ניקוי סינון ✕» clears them. A slice set in one section stays when moving to another.
- In «צפי תזרים» the cards, the weekly table and the per-house table are **recomputed for the
  slice**, and the screen says so.

## «חתך לפי» — a summary table above the list
- **חובות פתוחים:** by גורם מממן (on by default), בית, גיל החוב, בבית / משוחררים.
- **תקבולים:** by גורם מממן, בית, אמצעי תשלום, אימות.
- Each row: rows, amount, share. Clicking a funder / house / aging / status row narrows the
  list to it; clicking it again widens it back. The calculator works on these tables too.

## Section filters
- **חובות פתוחים:** billing-day period (from / to, «החודש», «החודש הקודם»), aging bucket,
  in-house / released. A searched patient with no open debt is still listed below, one tap from
  their «חשבון».
- **תקבולים:** received-date period — the last 30 days by default, «החודש», «החודש הקודם»,
  «הכל» — and «ממתינים לאימות». The list is no longer cut at 25 receipts.

## Behaviour that changed — read this
- **«זיכויים לתשלום» now also lists refunds the policy computed** for discharges nobody decided
  yet («מחושב — טרם הוחלט») — the rows «צפי תזרים» already subtracted. Saved credits keep their
  payout actions. A saved pending credit is never dropped, even if the forecast read omits it.
- **«תקבולים» shows 30 days by default** (it showed the latest 25 of any date).
- The receipts table gained a «גורם מממן» column: the receipt's own funder, else the patient's
  funder on the day it was received.
- The aging tiles in «סקירה» sum cycles; the aging filter in «חובות פתוחים» is by each patient's
  oldest cycle (as before) — the overview says so.
- Ortal lands on «סקירה» of «גבייה» (it was the long page); «צפי תזרים» is one tap away.

## Rules / data
- No amount is recomputed: every section filters and re-sums the SAME rows as before
  (`collectionDebtors` → `billingOverview`, `cashForecast`, `forecastRefunds`, `receiptsOf`).
  Tests pin: no slice → the previous figures exactly; every «חתך» sums to its list.
- UI only: no request, no action, no server / Code.gs / Railway change. Same four reads, once.
- Inputs are validated (`isoDateOk`, `houseId`, known keys only); every rendered value goes
  through `esc()`; a card can only open a section the session has. `npm audit`: 0 high / critical.

## Files
- `public/crm/crm.js`: `BILLING_TABS`, `billingTabsFor`, `billSlice`, `sliceHit`, `groupRows`,
  `debtsView` / `debtGroups`, `receiptsView` / `receiptGroups`, `refundsView`, `sliceForecast`,
  `sliceRefunds` (pure); `renderBilling` (menu + dispatcher), `billSliceBar`, `groupTable`,
  `renderDebts`, `renderReceipts`, `renderRefunds`, `renderUnlinked`; `renderCashForecast` and
  `renderDueOnDate` reshaped; `renderCollectionDebtors`, `renderForecastOpen`,
  `forecastOpenList` and the `data-billing-filter` tiles removed. `CALC_TABLES` follows.
- `public/crm/crm.css`: the layout, the menu, group tables. `public/sw.js`: v131 → **v132**.
- Tests: `test/billing-sections.test.js` (new, 13); `test/forecast-cards-open.test.js`
  (rewritten for the single list); `test/crm-shell-browser.test.js` (every «גבייה» scenario
  goes through the menu; the main one covers sections, slices, cuts, calculator at 1366 / 390 px);
  pins updated in eight unit files.
