# Pro-bono — the fifth funder (פרו-בונו)

Branch `claude/lucid-mendel-v6qsbf` → base `claude/build-ezone-dashboard-QOg5s`.
Builds on `CHANGELOG-patient-funder-on-funders.md` (#178). Apps Script **and**
Railway: the `apps-script/Code.gs` changes deploy through the clasp CI on
merge. Do not paste Code.gs by hand. Service worker `CACHE_VERSION`
**v34 → v35**. v35 is above the live deploy branch (v34) and above every open
PR (the highest is #180 at v32).

## What Sandra decided (2026-10-05)

| | Decision |
|---|---|
| 1 | A fifth funder: label **'פרו-בונו'**, key **'probono'**. It is appended **last** in every list, because the lists are append-only. The four older entries do not move. |
| 2 | **A pro-bono patient owes nothing.** Any cycle whose funder on its start day is pro-bono is dropped from the debt report (`debtAging_`): from `byPatient`, `byHouse` and `totals`. This is the same day rule as `Funder.debtByFunder`. The client due list, «יתרות פתוחות», the renewal and overdue alerts, and Ortal's daily email all skip these rows. **Unchanged:** occupancy, the patient card and meetings. The strip always shows a פרו-בונו row (₪0). The cleanup workbook gets a «מטופלי פרו-בונו» tab. |
| 3 | You can report a payment for a pro-bono patient, but the report must name its funder. The no-default rule does not change. |

## What users see

**Vered and Sandra (finance):**

- **Every funder select** now offers «פרו-בונו» as its last option: admission, the card editor, the «השלמת גורם מממן» fill screen and the payment report form. The גבייה funder filter shows it between «מכבי» and «לא הוגדר».
- **«לגבייה בתאריך הנבחר»** leaves out any patient whose funder on the selected date is pro-bono. The KPI cards count only the rows that are listed.
- **«יתרות פתוחות»** leaves out any row whose funder on its due date is pro-bono. If a patient switched to pro-bono mid-stay, the older rows (from before the switch) still show.
- **The dashboard alerts:** a pro-bono patient never appears in «חידוש תשלום» or in «X מטופלים ממתינים לתשלום».
- **«חובות פתוחים»:** the strip always has a «פרו-בונו» row, and it is always ₪0. The blocks, the drill-down and the .xlsx no longer include pro-bono cycles. The column totals still equal the aging totals.
- **«ייצוא רשימת תיקונים»** has a new last tab, **«מטופלי פרו-בונו»**. It lists every patient whose funder is pro-bono today, or on the exit day for a patient who already left. Columns: house, name, entry, exit and «פרו-בונו מתאריך». The owner is ורד, who checks that each classification is right.
- **Payment report:** you can choose «פרו-בונו». A report on the old save path that names no funder for a pro-bono patient is refused with this message: «המטופל מוגדר פרו-בונו — יש לבחור גורם מממן במפורש בדיווח». Nothing is written.

**Ortal:** her daily email no longer lists payments of pro-bono patients. The «ממתינים לאימות» count and the «בקרת גבייה» tab are unchanged, so a pro-bono receipt still waits for her check there.

**Shiran and Yael (restricted):** no change. They see no funder UI and no billing UI.

## Rules, exactly

- **The funder on a day** is the `Funders` row with the latest `effectiveFrom` ≤ that day. On the same day, the later `setAt` wins, then the later row. This is `currentFunderFrom_`, the same rule as in `public/funder.js`.
- **Debt.** A recorded cycle is dropped only when it is still owed (balance > 0) and its funder on its **start** day (coverage start, else due date) is pro-bono. An unrecorded cycle is dropped when its funder on its due date is pro-bono. A settled cycle is counted as settled, as before. The dropped cycles are counted, apart, in `probonoExcluded: { recorded_debt: {count,total}, unrecorded_cycles: {count,total} }`. They are never added to a debt figure, and the two figures are never summed.
- **Mid-stay switch.** Only the cycles from the switch day on are dropped. A later switch back restores the cycles from that later day.
- **The client lists** check the patient's funder on the row's **due date**. This is the same read the funder filter already used (`billingRowFunderKey`). Without Funders rows, which is the case for any non-finance session, nothing is skipped.
- **The digest.** When a row carries its own `funder`, that decides: pro-bono is skipped and any other funder is kept. Otherwise the patient's `Funders` row on the payment day (`receivedDate`, else `dueDate`) is looked up by `patientUid`. A row with no uid is kept.

## Code

| File | Change |
|---|---|
| `apps-script/Code.gs` | `PAYMENT_FUNDERS` gets `'פרו-בונו'` appended. New `FUNDER_PROBONO`. `PAYMENT_REPORT_MESSAGES.funder_probono_implicit`. `upsertPayment_` refuses to fill a pro-bono funder for a report that names none. New `debtAgingProbonoOn_`. `debtAging_` reads an optional `funders` tab, drops pro-bono cycles and adds `probonoExcluded`. `debtAgingAction_` reads `Funders` (getSheetByName, read-only). New `cleanupProbono_`, and `CLEANUP_SECTION_KEYS` gets `'probono'` appended. New `digestRowIsProbono_`. `digestSelect_` takes an optional 5th argument (Funders rows), and `digestBuild_` passes `fundersRows_()`. |
| `lib/payment-report-rules.js` | Mirror: the fifth label, `FUNDER_PROBONO`, and the new message. |
| `public/funder.js` | `FUNDER_KEYS` gets `'probono'` appended. `LABEL_TO_KEY['פרו-בונו'] = 'probono'`. New `FUNDER_PROBONO`. |
| `public/app.js` | New `isProbonoOn(patient, dueISO)`. `renderBilling` (due list), `renderBillingOpenList`, `overduePatients` and `patientsNeedingRenewal` skip pro-bono rows. The selects, filter and strip pick up the fifth entry from the lists above, so no code change was needed for them. |
| `lib/cleanup-xlsx.js` | The «מטופלי פרו-בונו» tab (kind `probono`, owner ורד). It is optional in `isCleanupResponse`, so a Code.gs deployed before this PR still exports. |
| `public/sw.js` | v35. |

## Security

- No new action, route, env var, Script Property, scope, trigger or column.
- `Funders` is read with `getSheetByName`, the same read-only pattern the other report readers use. No tab is created, no lock is taken, nothing is written.
- Every new label reaches the page through the existing `escapeHtml` paths, and the workbook through ExcelJS text cells.
- No PII is logged.

## Tests

`node --test`: **2156 tests, all green** (2141 before this PR). The new file is
`test/funder-probono.test.js` (15 tests):

- **Guards:** the five labels and keys in order (append-only), on all three sides; the message parity; the SW bump.
- **`debtAging_`:** a pro-bono patient is absent from `byPatient`, `byHouse` and `totals`, and the difference equals `probonoExcluded`; a mid-stay switch drops only the cycles from that day on (and a switch back restores them); the action reads the `Funders` sheet.
- **The invariant:** five funders + unset sum exactly to the totals, per figure and per house, at three as-of dates, and the pro-bono bucket is ₪0.
- **Cleanup:** the «מטופלי פרו-בונו» rows, the tab, its owner, and an older response without the section.
- **Digest:** skips by the row's own funder or by Funders on the payment day.
- **Report:** the implicit pro-bono funder is refused with nothing written; an explicit «פרו-בונו» is stored; no funder is still `funder_missing`.
- **Client:** the due list, «יתרות פתוחות», the renewal and overdue alerts, the selects and filter, and the unchanged restricted view.

Updated pins: the label and key lists in `test/patient-funder-on-funders.test.js` and `test/payment-report-foundation.test.js`, and the tab list and fixture in `test/cleanup-workbook.test.js`.

**Mutation check.** Three deliberate breaks, each caught and then reverted:

1. The recorded-cycle skip in `debtAging_` is removed → 2 tests fail.
2. The digest skip is removed → 1 test fails.
3. `isProbonoOn` always returns false → 4 tests fail.

## Live test (Vered)

1. In a patient card, set the funder to «פרו-בונו» from today. The card shows it.
2. In גבייה, on that patient's next due date, the patient is not in «לגבייה בתאריך הנבחר», and an older unpaid row from before the switch is still in «יתרות פתוחות».
3. On the dashboard, the patient is in neither «חידוש תשלום» nor «ממתינים לתשלום».
4. In «חובות פתוחים», the strip shows a «פרו-בונו» row at ₪0, and the column totals still equal the block totals.
5. In «ייצוא רשימת תיקונים», the last tab «מטופלי פרו-בונו» lists the patient with the date.
