# «ייצוא רשימת תיקונים» — one Excel with every known gap, and who fixes it

Plan: `docs/billing-control-plan.md` §14.1 (new row). Branch
`feat/cleanup-workbook` → base `claude/build-ezone-dashboard-QOg5s`.
`apps-script/Code.gs` changes in its own commit (clasp CI deploys it on
merge). Service worker `CACHE_VERSION` v27 → **v28**.

**What:** a button «ייצוא רשימת תיקונים» on the גבייה tab, next to «ייצוא
זיכויים לאקסל», downloads `רשימת-תיקונים-YYYY-MM-DD.xlsx`. It has a count-only
«סיכום» tab, then one tab per kind of problem. Every row says who fixes it,
how, and has a «טופל» box (☐) to tick by hand.

## Step 1 — what already existed (read-only investigation)

| Existing check | Where | Used for | Reused? |
|---|---|---|---|
| `reconciliationReportNow` → `recBuildReport_` §A | Code.gs (#151) | leads at paid / admitted / «נכנסים לטיפול» with no Patients row | ✅ «לידים ששולמו ולא נקלטו» |
| §D (U+FFFD names, the "names to fix" work of 30/09) | Code.gs (#151) | damaged names in every tab, with a proposal and a confidence level | ✅ «שמות לא תואמים» |
| §E (detached payments + best candidate) | Code.gs (#151) | the «הצעת שיוך» column | ✅ «תשלומים לא משויכים» |
| §F (a detached payment that matches a lead with no patient) | Code.gs (#151) | «שולם ולא נקלט» | ✅ «לידים ששולמו ולא נקלטו» |
| §I (duplicates ≤ 7 days) | Code.gs (#151) | its ≤ 7-day rule and its owner key idea | ✅ rule kept inside «כפילויות חשודות» |
| §J's credit → patient lookup | Code.gs (#151) | joining a credit to its patient | ✅ extracted to `recCreditPatient_` (behaviour unchanged; §J calls it) |
| `recMatchPatient_`, `recCandidates_`, `recNameKey_`, `recNamesLookAlike_` | Code.gs (ports of app.js) | payment → patient, reconnect candidates, name normalizing | ✅ |
| `debtAging_` | Code.gs (#161) | recorded debt + unrecorded cycles as of today; `detachedPayments`, `outsideStay`, `releasedWithoutExit`, `noEntryDate` | ✅ «פערי גבייה לבדיקה» + four list tabs |
| «מטופלים בסכום אפס» (`debtAgingView`) | lib/debt-aging-xlsx.js (#163) | a patient whose every cycle is 0 | ✅ same rule, applied to `debtAging_` output |
| `refundPayoutForecastFor_` | Code.gs (#159) | `awaiting_decision`, `unresolved` | ✅ «זיכויים לבדיקה» |
| `nightlyIntegrityJob` | Code.gs | disappeared Patients rows (needs the stored key set in Script Properties) and orphan Payments / BillingOverrides keys | ❌ not reused: its disappearance check depends on yesterday's stored keys, and its orphan Payments sweep is the same set `debtAging_`'s detached list already covers. Orphan BillingOverrides are **not** in the workbook (see "Not included"). |
| `orphanPaymentsPlan_` / `reconcileOrphanPaymentsNow` | Code.gs | a write-path repair for orphan payments | ❌ it is a repair, not a check; the detached list covers what it finds |
| Duplicate void (#144) | app.js / Code.gs | marks a row `void` | ✅ void rows never count as duplicates |

**New** (nothing checked these before): one patient spelled differently across
tabs; near-duplicate names in one house; "same patient + amount + month".

## Server — `action=cleanupReport` (`apps-script/Code.gs`, own commit)

- **Read-only.** It reads with `recCollect_` (`getSheetByName` + `getValues`; a
  missing tab is listed in `missingTabs`, never created). No write, no lock, no
  audit row, no property, no `Logger.log`. A runtime test runs it against a
  spreadsheet whose every non-read method throws: **0 attempts**.
- **Gate:** `PROXY_SECRET`. Not in `OPEN_ACTIONS`; added to `PROXY_KNOWN_ACTIONS`
  and to `FINANCE_ACTIONS` (Code.gs and `lib/finance-scope.js`, pinned equal),
  so a verified Shiran or Yael is refused too.
- **Pure core:** `cleanupReport_(todayIso, tabs)`. Today is Asia/Jerusalem.
- **Returns** `{ ok, today, recordsCutoff, sections, counts, notAPatientExcluded, missingTabs, generatedAt }`.
  Every row carries a `kind`; Node turns it into words.

New helpers: `cleanupProbablyEntryError_`, `cleanupOneEdit_`,
`cleanupNearDuplicateWhy_`, `cleanupNames_`, `cleanupGaps_`,
`cleanupDuplicates_`, `cleanupCredits_`, `cleanupReport_`,
`cleanupReportAction_`, and `recCreditPatient_` (extracted from §J).

## The tabs and what feeds each

| Tab | Rows | Source | מי מתקן |
|---|---|---|---|
| «סיכום» | one row per tab: rows, and how many per ורד / אורטל / סנדרה. **Counts only**, no money, no total row | the sections below | — |
| «שמות לא תואמים» | (1) U+FFFD names with §D's proposal and confidence; (2) one patient spelled differently where an existing link joins two tabs: Payments (matched by the app's four tiers), Credits (`recCreditPatient_`), Leads (`fromLead`), one row per tab + patient + spelling; (3) near-duplicate names in one house. Column **הצעת תיקון** | §D + new | ורד |
| «פערי גבייה לבדיקה» | every owed cycle as of today, both kinds, **oldest first**, with **כנראה טעות רישום** | `debtAging_` | ורד (אורטל confirms against the bank) |
| «תשלומים לא משויכים» | detached rows, with §E's best candidate | `debtAging_.detachedPayments` + §E | אורטל |
| «תשלומים אחרי יציאה» | a recorded cycle after the exit (or before the entry) | `debtAging_.outsideStay` | אורטל |
| «משוחררים ללא תאריך יציאה» | released, no exit date | `debtAging_.releasedWithoutExit` | ורד |
| «ללא תאריך כניסה» | payment rows but no entry date | `debtAging_.noEntryDate` | ורד |
| «מטופלים בסכום אפס» | every cycle 0 | `debtAging_.byPatient` (the view's rule) | ורד |
| «לידים ששולמו ולא נקלטו» | leads paid / admitted with no patient (§A), and detached payments matching such a lead (§F) | §A + §F | ורד (§A), אורטל (§F) |
| «כפילויות חשודות» | same patient + same amount + same cycle month, **or** due dates ≤ 7 days apart (§I's rule). Void rows never count | new rule, §I's window | אורטל |
| «זיכויים לבדיקה» | discharges awaiting a refund decision, and those that cannot be calculated | `refundPayoutForecastFor_` | אורטל (awaiting), ורד (uncalculable) |

Every kind tab has the columns **בית, מטופל**, the tab's own columns, then
**פרטים, הבעיה, מי מתקן, איך מתקנים, טופל** (☐).

### «כנראה טעות רישום» — the exact rule

`true` when **either**:
1. the cycle starts before **2026-07-01**; or
2. the patient has **no later activity** — no non-void Payments row of theirs
   whose due date is after the cycle start, and none reported paid
   (`chargedAt`) after it — **and** the cycle is **more than 30 days** old.

Rule 1 can never fire on `debtAging_` output today (it already drops cycles
before the cutoff); it is kept so the rule is literally the one asked for. The
30-day guard in rule 2 stops this month's fresh cycle — which naturally has
nothing after it yet — from being flagged.

### "Who fixes it" — the rules used (`docs/billing-control-plan.md`)

- §9: A, B, C, D (patient data) → ורד; E, F, I, K (payments) → אורטל; G, H
  (debt) → ורד reports, אורטל confirms; J (credits) → אורטל.
- §7.4: a credit awaiting a decision → אורטל.
- §7.3 / §8.5: סנדרה approves exceptions only. **No row kind is hers today** —
  her three approver actions are decisions, not data gaps. The «סנדרה» column
  is in «סיכום» for when one is.

## Route — `GET /api/export/cleanup.xlsx` (`server.js`)

- `requireSession` → `requireFinance` → `requireProxySecret` → handler.
  No session → 401; Shiran / Yael → **403** `forbidden` (nothing is proxied);
  no `PROXY_SECRET` → 503.
- Reads `cleanupReport` through `sheetsPost` (secret attached there; `user` =
  the session user).
- Headers: xlsx `Content-Type`, `Content-Disposition: attachment;
  filename="cleanup-YYYY-MM-DD.xlsx"; filename*=UTF-8''<רשימת-תיקונים-YYYY-MM-DD.xlsx>`
  (the day is re-validated), **`Cache-Control: no-store`**, `nosniff`,
  `Content-Length`.
- Failures: JSON with `no-store` — `lock_busy` 503, `forbidden` 403, a bad shape
  502 `bad_response`, network 502 `sheets_unreachable`, build 500.
- **Logs:** an error code, or `ok, bytes=N`. Never a name, an amount or a body
  (a test checks the log).
- `cleanupXlsxHandler({ fetchCleanup, now })` is exported for tests.

## Workbook — `lib/cleanup-xlsx.js` (new)

Built with `lib/xlsx-report.js`, so it has the same look as the other exports:
RTL, a coloured title row per tab (`lib/report-colors.js`), a frozen header
with a filter, computed widths, `"₪"#,##0`, real dates, formula-guarded
text, no formulas, and no product or company name in the file. No "איזון" or
"E-ZONE" anywhere (cells, sheet names, raw XML, file names, and the library
source — tested). No tab has a total row: the gaps tab mixes «חוב רשום» and
«מחזורים ללא רישום», which are never summed.

## UI

- `public/index.html`: the button `#cleanup-export`, beside
  `#credits-forecast-export`, inside `<section id="screen-billing" data-finance>`.
  A restricted session never gets it, because `applyView(false)` removes that
  whole screen. No new `data-finance` node (still 10).
- `public/app.js`: `exportCleanupXlsx()` (refuses itself when `!financeView()`,
  GETs with `cache: 'no-store'`, downloads the dated file), wired through
  `busyButton`; `cleanupXlsxErrorText` (403 → «אין הרשאה לייצוא זה», the rest as
  the refund export).
- `public/sw.js`: v27 → v28. `/api/export/*` is already network-only.

## Tests

**New: `test/cleanup-workbook.test.js`, 28 tests** (vm sandbox on the real
`Code.gs` and `app.js`, the real Express app with `https` stubbed, synthetic
names):
- each tab's rows from one fixture (names: U+FFFD, three spellings, a near-
  duplicate; gaps; detached; after-exit; released without exit; no entry
  date; zero amount; lead + paid-not-admitted; a same-month duplicate, a
  renamed detached twin, a voided row ignored, the ≤ 7-day rule across a month
  line; awaiting + uncalculable credits);
- gaps equal `debtAging_`'s owed cycles; credits equal `refundPayoutForecastFor_`;
- the «כנראה טעות רישום» rule (boundaries 30/31 days, cutoff, later activity)
  and through the engine;
- the near-duplicate rule (same name, spacing, partial, word order, one letter;
  a shared family name and too-short names are not);
- no second engine and no writer in the block (source scan);
- the action: read-only (0 attempts), an empty spreadsheet, refused without
  `PROXY_SECRET` in enforce mode (and a secret in the URL does not count), not
  open, known, a finance action, refused for a verified Shiran;
- `getData` keeps its keys;
- the workbook: tab order, RTL / frozen / filter / colour / widths, the five
  closing columns and ☐ on every row, owners from the plan, «סיכום» counts
  only, an empty report, the formula guard, no "איזון"/"E-ZONE";
- the route: 401, 403 for Shiran and Yael (nothing proxied), 503, headers,
  the session user forwarded, no patient data logged, failure codes;
- the button (placement, finance-only), the download, Hebrew errors, SW v28.

**Updated:** `test/restricted-view.test.js` — `FINANCE_ROUTES` now includes the
new route (exact pin), and the SW check reads "v27 or later".

**Full suite: `npm test` → 1942 / 1942** (1914 on the base + 28).

## Not included (on purpose)

- Reconciliation §B (active patients twice), §C (open discharge row of an
  active patient), §G/§H (their debt is already in «פערי גבייה לבדיקה» via
  `debtAging_`), §J (credits larger than payments), §K's amount-off rows, and
  orphan BillingOverrides from the nightly job. They were not in the requested
  tab list; each is one more tab when wanted.
- Rows already marked «לא מטופל» (with a note) and already-voided duplicates:
  they are decisions, not gaps. «סיכום» states how many «לא מטופל» rows were
  left out.
- `missing_payment_data` discharges: their exit cycle is already an unrecorded
  cycle in «פערי גבייה לבדיקה».

## Choices I made (ambiguous points — the safest reasonable option)

1. **Branch name.** The task asked for `feat/cleanup-workbook`, so the work is
   on that branch, cut from the deploy branch at `86fa7e3`.
2. **«כנראה טעות רישום»** uses the rule above, with a 30-day guard so this
   month's cycle is not flagged just because nothing came after it yet.
3. **Duplicates:** same month **or** ≤ 7 days apart. "Same month" is the app's
   own "same cycle" rule (שיוך תשלומים); ≤ 7 days is §I's. A missed duplicate
   costs more than an extra row to check.
4. **A detached duplicate** is paired with a patient only when that patient is
   the single best reconnect candidate, in the same house, sharing the name or
   the entry date. That is the renamed-patient shape PR #144 voided.
5. **Near-duplicates** are only within Patients, and only when at least one row
   is still active. An identical name counts only when both are active;
   otherwise it is a readmission. The proposal is the row with more payments,
   then the fuller name, then the earlier entry.
6. **Spellings** are grouped: one row per tab + patient + spelling, with the
   row references listed. The Patients name is the proposal.
7. **Credits tab** has awaiting + uncalculable only, as asked.
   `missing_payment_data` would double-list the gaps tab.
8. **«לא מטופל» rows** are left out of «תשלומים לא משויכים» and §F, and are
   counted in «סיכום».
9. **«טופל»** is a ☐ text cell, not a drop-down, so the shared xlsx helper is
   unchanged.
10. **The lead's phone** is in «לידים ששולמו ולא נקלטו». The file is finance-only
    and the phone is needed to make the call. It is never logged.
11. **סנדרה** has no rows today (see "Who fixes it").
12. **Ortal** is assigned per the plan even though her login is inactive until
    Phase 4. Until then, Sandra or Vered can filter by «מי מתקן».

## Deploy

- **Apps Script:** `Code.gs` changes (own commit), so clasp CI deploys on merge.
  `appsscript.json` is unchanged; no new scope.
- **Railway:** serves the new `server.js`, `lib/cleanup-xlsx.js`, `app.js` and
  `index.html`. SW v28 evicts v27.
- **Order on merge:** if Railway lands first, the button answers 502
  `unknown_action` («השרת החזיר שגיאה 502») until clasp finishes. Nothing else
  is affected.
- **Not verified live:** the live site is unreachable from this environment.
  The file was re-read with exceljs, not opened in Excel.

## For Sandra

Nothing to set. After the merge, Vered and you get the button on the גבייה tab.
Shiran and Yael don't see it, and the server refuses them (403) anyway.
