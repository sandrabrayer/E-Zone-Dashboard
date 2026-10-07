# Grace period for institutional funders (Sandra, 07/10/2026)

**The rule.** A billing cycle whose funder **on its due date** is **ביטוח
לאומי**, **מכבי** or **משרד הביטחון** does not count as a collection problem
until **`FUNDER_GRACE_DAYS = 30`** days after its due date:

| days since the due date | marking |
|---|---|
| 0–30 (and a cycle not yet due) | **«ממתין לגורם מממן»**, neutral grey. A partly paid cycle reads **«שולם חלקית · ממתין לגורם מממן»**. |
| 31 or more | the normal red / overdue marking |

- The funder is resolved per patient, with history (`effectiveFrom`), exactly
  as today. A funder change takes effect from its date. It does not change
  cycles that were already due.
- **Private:** unchanged. **Pro-bono:** unchanged, and still excluded (owes
  nothing). **Unset / unknown funder:** unchanged.
- **The amount always stays outstanding**: in the debt-aging totals and
  buckets, «חובות פתוחים», «יתרות פתוחות», the funder × house strip and
  Ortal's open debt. Only the **problem marking** is deferred.
- No Apps Script data change. No new action, column, Script Property, env var
  or trigger.

## The shared helper: `lib/funder-grace.js` ⇄ `Code.gs`

- **`lib/funder-grace.js`** (new UMD module, served at `/funder-grace.js`,
  `window.FunderGrace`). It exposes:
  - `FUNDER_GRACE_DAYS`, `FUNDER_GRACE_KEYS` (`btl`, `maccabi`, `mod`),
    `FUNDER_GRACE_SHEET_LABELS`, `FUNDER_GRACE_LABEL` («ממתין לגורם מממן»)
    and `FUNDER_GRACE_COLUMN_LABEL` («בתוך תקופת גורם מממן»);
  - `graceFunderKey(funder)`;
  - `isWithinFunderGrace(cycle, funder, todayIso)`, where `cycle` is a due
    ISO, `{ dueDate }` or `{ start }`, and `funder` is a key or a sheet
    label;
  - `funderGraceUntil(cycle)`, which returns due + 30.
- **`apps-script/Code.gs`**: the same rule as `isWithinFunderGrace_`,
  `graceFunderKey_` and `funderGraceUntil_`, with the constants
  `FUNDER_GRACE_DAYS`, `FUNDER_GRACE_FUNDERS` and
  `FUNDER_GRACE_KEY_BY_LABEL`. There is also `debtAgingFunderOf_`, a funder
  lookup per patient and day built on `currentFunderFrom_`.
- An unreadable date never passes silently. It returns `false`, so the
  normal marking applies.
- **Parity test:** 13 funder spellings × 5 due dates × 44 days, in both the
  Node build and the browser build.

## Call sites changed

**Server, `Code.gs`, in its own commit:**

- `debtAging_`: every owed cycle gains `funderGrace` (bool) and
  `funderGraceUntil`, judged at the **as-of date** with the funder on the
  cycle's **due date**. The report gains `funderGrace: { count, amount }`.
  **Totals, `byHouse`, `byPatient`, buckets and balances are unchanged**: a
  test compares them against the same data with every funder set to private.
- Nothing else on the server marks overdue cycles:
  - Ortal's digest lists money received.
  - `billingControlDebt60_` covers 61+ days only, which is past the grace
    window.
  - `billingControlOpenDebt_` covers partial receipts.
  - The «מגיע ולא דווח» queue from plan §7.1 is not built yet.

**Page, `public/app.js`:**

- **New helpers:**
  - `funderGraceLib()`;
  - `patientCycleInFunderGrace(patient, funders, dueISO, todayIso)`, pure;
  - `isInFunderGraceOn(patient, dueISO)`, the live state, gated like
    `isProbonoOn`.
- **מטופלים, `patientProblems`:** the «לא דווח תשלום» chip, and so the
  problem count and the tab badge, waits while the first cycle (due on the
  entry day) is inside the window.
- **New `funderGraceStatusLabel(owedKey)`:** «ממתין לגורם מממן», or
  «שולם חלקית · ממתין לגורם מממן» for a partly paid cycle, so the partial
  payment is never hidden.
- **מטופלים, `patientPaymentState` / `patientListRowHtml`:** an unpaid or
  partial current cycle inside the window shows that label (grey). `owed`
  keeps the real state, so «דווח תשלום» is still offered.
- **גבייה, `buildBillingRow`:** an unpaid or partial cycle that is due and
  inside the window gets the `funder-grace` class (a grey border) and that
  status label. It is not `overdue`, and the amber carry marking is replaced
  by grey. Amounts are unchanged.
- **Dashboard alert, `overduePatients`** («X מטופלים ממתינים לתשלום»): skips
  a cycle inside the window.

  > Note: this alert only looks at the **current** cycle, and a current
  > cycle is at most 30 days old. So an institutional-funder patient will
  > not appear in it. Their older unpaid cycles still turn red after day 30
  > in «יתרות פתוחות» and in debt aging.

  The renewal alert («חידושים») looks at upcoming cycles, not overdue ones,
  so it is unchanged.
- **«חובות פתוחים», `debtAgingHtml`:**
  - a new column «בתוך תקופת גורם מממן» in the cycle table («ממתין לגורם
    מממן · עד DD/MM/YYYY»; with money received and a balance left, «שולם
    חלקית · ממתין לגורם מממן · עד DD/MM/YYYY»; or «—»), with the row greyed;
  - a summary line «N מחזורים (₪X) בתוך תקופת גורם מממן — נכללים בחוב, לא
    מסומנים כבעיה»;
  - the rows are not removed, and the buckets are unchanged.

**Elsewhere:**

- `lib/debt-aging-xlsx.js`: the same column, with the same partial wording,
  at the end of both cycle sheets. The totals rows are unchanged.
- `public/style.css`: `.pay-state-funder_grace`, `.billing-row.funder-grace`,
  `.debt-cycle.funder-grace`, `.debt-grace-line`.
- `server.js` (ASSETS + route), `public/index.html` (the script loads before
  `app.js`) and `public/sw.js`:
  - `BUNDLE_PATHS` gains `/funder-grace.js`;
  - `CACHE_VERSION` v46 → **v47**. v46 is PR A's; v17 stays burned.

## How many current cycles flip to «ממתין לגורם מממן»?

**This cannot be told from the repository.** The live Patients, Payments and
Funders data is in the spreadsheet, not in the code or the fixtures. To
count: open «חובות פתוחים» with today's date after deploy. The new summary
line gives the number and the amount directly
(`debtAging_(today).funderGrace`).

## Tests

`test/funder-grace.test.js`, 25 tests:

- the guard (30 days, the three funders, labels ⇄ keys ⇄ `PAYMENT_FUNDERS`);
- day 29 / 30 / 31 for each funder, as a key and as a label, in both
  runtimes;
- private / pro-bono / unset / junk and bad dates;
- lib ⇄ Code.gs parity;
- `debtAging_`:
  - flags only; totals, byHouse, cycles and buckets are unchanged against an
    all-private run;
  - pro-bono is still excluded;
  - judged at the as-of date;
  - the funder is read on the due date;
- the «לא דווח תשלום» chip (day 29 / 30 / 31, private, unset, pro-bono, no
  rules file);
- the payment cell;
- גבייה rows, current and carry;
- the overdue strip;
- the debt-aging column, line and block totals;
- the .xlsx column and totals;
- a partly paid cycle inside the window: «שולם חלקית · ממתין לגורם מממן» in
  the patient cell, the גבייה row, debt aging and the .xlsx; private keeps
  «שולם חלקית»;
- the asset wiring and SW v47;
- **10 mutation checks**:
  - six on Code.gs: 30→29, `<=`→`<`, מכבי dropped, every funder treated as
    institutional, grace cycles dropped from totals, the flag never set;
  - three on `app.js`: the chip, the strip, and the partial label;
  - one on the lib (parity).

**Existing tests updated:**

- `debt-aging-ui-browser.test.js`: the cycle row has the new last cell «—».
- `debt-aging-ui.test.js`: the xlsx header has the new last column.
- `duplicate-payment-void.test.js`: the `stateLabel` source pin includes
  `funderGraceStatusLabel`.
- `dashboard-perf-assets.test.js`: SW v47 and the new hashed file.
- `refund-rule-v2.test.js`: the `BUNDLE_PATHS` regex no longer assumes
  `/refund-rules.js` is last.

Full suite: `npm test`, 2491 / 2491 pass, browser tests included.

## Deploy

Code.gs changes, so clasp CI deploys on merge. Railway deploys `public/`,
`lib/` and `server.js`. There is nothing to set.
