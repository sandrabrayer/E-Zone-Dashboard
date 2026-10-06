# Pro-bono — the fifth funder (פרו-בונו); a pro-bono patient owes nothing

Branch `claude/intelligent-gates-roo3yc` → base
`claude/build-ezone-dashboard-QOg5s`. Builds on #178
(`CHANGELOG-patient-funder-on-funders.md`). `apps-script/Code.gs` deploys
through the clasp CI on merge — do not paste it by hand. Service worker
`CACHE_VERSION` **v34 → v37**: v35 and v36 are held by open PRs #181 / #182.
Whichever ships first, v37 evicts every older cache.

**Merging with the invoice PR (branch `claude/intelligent-gates-roo3yc-invoice`):** the code merges cleanly in either
order. Only `public/sw.js` (the version line: keep the higher, v38, and both
comment blocks) and `EZONE-ECOSYSTEM-STATUS.md` (keep both sections) need a
trivial hand-merge. The combined tree was tested: 2174 tests, all green.

> **Overlap note.** Open PR #181 (`claude/lucid-mendel-v6qsbf`) implements the
> same request from an earlier session. This PR was built independently from
> the current deploy branch. Sandra merges one of the two and closes the other.

## What Sandra decided (2026-10-05)

| | Decision |
|---|---|
| 1 | A **fifth funder**: label `פרו-בונו`, key `probono`. **Appended last** to every list (the lists are append-only): `PAYMENT_FUNDERS` (Code.gs + `lib/payment-report-rules.js`), `LABEL_TO_KEY` / `FUNDER_KEYS` (`public/funder.js`), and so every select, the filter and the strip. |
| 2 | **A pro-bono patient owes nothing.** A cycle whose start day falls on a pro-bono day (the funder in force that day, the same rule as `debtByFunder`) is not debt. |
| 3 | A **payment report** for a pro-bono patient is allowed, but must carry an **explicit funder**. The no-default rule is unchanged. |
| 4 | Occupancy, patient cards and meetings are **unchanged**. |

## What users see

**Vered and Sandra (finance):**

- «פרו-בונו» is the last option in every funder select: admission, the
  patient card editor, «השלמת גורם מממן», the payment report form and the
  גבייה funder filter.
- **«חובות פתוחים»**: a pro-bono patient's cycles are gone from the
  drill-down, the house table and both totals. A patient switched to
  pro-bono mid-stay keeps the cycles that started **before** the switch;
  cycles from that date on disappear.
- **The funder × house strip** always shows a «פרו-בונו» row, at ₪0.
- **«לגבייה בתאריך הנבחר»** and **«יתרות פתוחות»** skip a row whose patient is
  pro-bono on that row's due date.
- **The dashboard alerts** (renewal within 7 days, «ממתינים לתשלום») skip a
  patient who is pro-bono on the cycle date.
- **The payment report form** never prefills «פרו-בונו». Vered picks the
  funder herself (it starts on «בחרו…»).
- **«ייצוא רשימת תיקונים»** has a new last tab, **«מטופלי פרו-בונו»**: every
  patient who is pro-bono now (released: on the exit day), or who had cycles
  left out as pro-bono. Columns: entry, exit, «פרו-בונו מתאריך», «מחזורים שלא
  נספרו». Owner ורד: check the funder and the from-date.

**Ortal:** no change. Her daily email lists **every** payment received,
pro-bono or not: money received is always reported, whatever the funder
(Sandra, 2026-10-06). The digest never reads the Funders tab. The
«ממתינים לאימות» count and the «בקרת גבייה» queue are unchanged too.

Pro-bono exclusion applies in exactly four places: `debtAging_`
(«חובות פתוחים», and so the strip and «חובות מעל 60 יום»), «לגבייה בתאריך
הנבחר», «יתרות פתוחות», and the renewal / overdue alerts.

**Shiran and Yael (restricted):** no change. They have no funders in memory,
so nothing is skipped, and they see no funder UI.

## Code

| File | Change |
|---|---|
| `apps-script/Code.gs` | `PAYMENT_FUNDERS` + `'פרו-בונו'` (last). `FUNDER_PROBONO`. `debtAging_` reads `tabs.funders`; `debtAgingProbonoTest_` (pure, rows grouped per patient, `currentFunderFrom_`'s rule) drops a cycle whose start day is pro-bono — recorded and unrecorded alike — before it reaches `byPatient`, `byHouse` or `totals`. New report field `probonoExcluded {count, patients, rows}` (informational, never in a total). `debtAgingAction_` reads the Funders tab (so `billingControlQueue`'s «חובות מעל 60 יום» follows too). `digestSelect_` / `digestBuild_` are **unchanged** (no pro-bono skip in Ortal's email). `cleanupProbono_` + section key `probono` (last). The savePayment fill path refuses `funder_probono_explicit` instead of copying pro-bono onto a row. |
| `lib/payment-report-rules.js` | `PAYMENT_FUNDERS` + `'פרו-בונו'`, `FUNDER_PROBONO`, the `funder_probono_explicit` message (parity-tested against Code.gs). |
| `lib/cleanup-xlsx.js` | Tab «מטופלי פרו-בונו» (last), kind `probono`, optional section (an older Code.gs without it still renders). |
| `public/funder.js` | `FUNDER_KEYS` + `probono`, `LABEL_TO_KEY` + `'פרו-בונו': 'probono'`, `FUNDER_PROBONO`. `debtByFunder` now returns six buckets. |
| `public/app.js` | `FUNDER_PROBONO_KEY`, `isProbonoLabel`, `isProbonoOn` (finance view only). Used by `renderBilling` (due list), `renderBillingOpenList`, `overduePatients`, `patientsNeedingRenewal`, and the report form's funder prefill. No label literal in app.js. |
| `public/sw.js` | v37. |

## Security

- No new action, route, env var, Script Property, scope, column or trigger.
- Pro-bono skipping on the page runs only in the finance view
  (`funderView()`); a restricted session holds no funder rows.
- Every name and label is still escaped (`escapeHtml` on the page, the
  xlsx helper's formula guard in the workbook, `digestEsc_` in the mail).
- No PII is logged.

## Tests

`node --test`: **2159 tests, all green** (2141 before; +18). New file
`test/funder-probono.test.js` (18 tests):

- key / label guards: five funders, pro-bono last, Code.gs == rules ==
  funder.js; message parity; no label literal in app.js;
- `debtAging_`: a pro-bono patient's cycles are absent from byPatient,
  byHouse and totals; a mid-stay switch drops only the cycles from that date
  (and a switch back re-opens them); `debtAgingAction_` reads Funders;
- the invariant: 5 funders + unset = totals (three as-of dates, three
  histories); the pro-bono bucket is ₪0;
- Ortal's digest is unaffected: through the real `digestBuild_`, with a
  Funders tab where patients are pro-bono, every payment is still listed,
  and neither `digestSelect_` nor `digestBuild_` reads funders;
- the cleanup section and tab;
- the savePayment path refuses `funder_probono_explicit` with nothing
  written, and accepts an explicit funder; `reportPayment` accepts an
  explicit funder and refuses a missing one (`funder_missing`);
- the page: every select offers «פרו-בונו» last; the due list and «יתרות
  פתוחות» skip pro-bono rows; the renewal and overdue alerts skip them; the
  form never prefills pro-bono; the strip's ₪0 row;
- restricted (finance `false` and `null`): unchanged.

Updated guard tests (append-only lists): `test/patient-funder-on-funders.test.js`,
`test/payment-report-foundation.test.js`, `test/cleanup-workbook.test.js`
(its fixture now has one pro-bono patient, so the new tab has a row).

**Mutation check:** three breaks, each caught and reverted:

1. `debtAgingProbonoTest_` always false → 5 tests fail.
2. `isProbonoOn` always false → 2 tests fail.
3. The `funder_probono_explicit` refusal removed → 1 test fails.
4. A pro-bono skip put back into `digestSelect_` → 1 test fails.

## Live test (Vered)

1. On a patient card, «שינוי» → the list ends with «פרו-בונו». Set it from today.
2. «חובות פתוחים»: that patient's cycles from today on are gone; the strip shows a «פרו-בונו» row at ₪0; the totals still equal the strip.
3. גבייה on that patient's next due date: they are not in «לגבייה בתאריך הנבחר», and their rows from today on are not in «יתרות פתוחות».
4. «דווח תשלום» for them: the funder starts on «בחרו…»; with a funder chosen, the report is saved.
5. «ייצוא רשימת תיקונים»: the last tab, «מטופלי פרו-בונו», lists them.
