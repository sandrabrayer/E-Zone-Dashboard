# דוח פערים — a read-only reconciliation report

`reconciliationReportNow()` is a new **editor-run** Apps Script function. It
reads Leads, Patients, מטופלים משוחררים, PatientsTombstones, Payments, Credits
and BillingOverrides, cross-checks them, and writes everything that doesn't add
up into **one new private Google Doc**:

> **E-Zone דוח פערים YYYY-MM-DD HH:mm** (Israel time), right-to-left, URL
> printed in the Executions log.

It **writes nothing to the spreadsheet**. The only thing it creates is that
one document.

---

## What it guarantees

| Guarantee | How it is enforced |
| --- | --- |
| **Zero spreadsheet writes** | Tabs are opened with `getSheetByName` (a missing tab is listed, never created — no `getOrCreateSheet_`) and read with `getValues`. There is no lock, no AuditLog row and no Script Property. The tests scan the source of the function **and of every Code.gs helper it reaches**. A runtime test runs it against a spreadsheet where every non-read method throws and records the attempt: **0 attempts**. |
| **DocumentApp is the only write path** | `DocumentApp` appears only in the three document writers (`recWriteDoc_`, `recDocPara_`, `recDocTable_`), and those never touch a sheet. `DocumentApp.create` is called exactly once. |
| **Private** | The doc is not shared and not moved: no `addEditor`, `addViewer`, `setSharing`, `moveTo` or `makeCopy` anywhere in the call graph (asserted). It lands in My Drive of whoever runs it. |
| **Not reachable over HTTP** | `handle_`'s action allow-list never names it; `?action=reconciliationReportNow` returns `unknown_action` (asserted). |
| **Right-to-left** | Every paragraph and every table cell gets `setLeftToRight(false)` and right alignment. Docs lays table columns out left-to-right, so each row is reversed: the first column sits on the **right**. |

## Structure of the document

1. **Header**: today's date, the records cutoff, "amounts include VAT", how many rows each tab held, any missing tab, and any **header drift** (a column inserted by hand shifts every field, because the app reads by position).
2. **סיכום**: one row per section, with its item count and ₪ impact.
3. **Sections A–K**. Each is a table in which every item carries its **tab + row number**. Money sections are sorted **largest ₪ first**, and a table is capped at 300 rows with a note giving the full count.

| § | What | Sort |
| --- | --- | --- |
| **A** | Leads at stage **paid / admitted**, or `meetingOutcome` = `entered` (**נכנסים לטיפול**), that have **no Patients row**. A lead counts as having one when a row matches by `fromLead`, then by phone (the phone of the lead a patient came from), then by name + house. Shown: lead id, name, phone, house, stage, created, visit and entry dates, advance, and a note if the person appears in מטופלים משוחררים or PatientsTombstones | advance ₪, then newest |
| **B** | **Active** patients duplicated: the same house + name + entry date, the same `fromLead`, or the same phone | the duplicated monthly pay |
| **C** | **Open** discharge-audit rows (`restored` not true) whose stay matches an **active** patient (`fromLead`, house + name + date, or id) | monthly pay |
| **D** | Names containing **U+FFFD**, from every tab that holds a name. For each: a proposed clean name taken from the same id, `fromLead` or phone elsewhere, and a **confidence** level. **גבוהה**: one candidate, linked by id or `fromLead`, that fits the damaged pattern. **בינונית**: the same, but linked by phone. **נמוכה**: several candidates, a candidate that doesn't fit the pattern, or a pattern-only match within the same house. **אין הצעה**: nothing found. It never guesses | confidence |
| **E** | Payments attached to **no existing Patients row** (the app's four matching tiers find nothing), including rows whose uid or triple points at a **tombstoned / deleted** patient. Shown: row, date, amount, amount paid, status, name, phone and method (from a hand-added column if Payments has one; otherwise the phone is taken from the candidate's lead and marked "(מהליד)"), plus the **best candidate** patient or lead with its reason | ₪ |
| **F** | Detached payments that match a **lead that has no patient record** (by phone, the same name, or a look-alike name in the same house): **שולם אך לא נקלט** | ₪ |
| **G** | Active patients with **no payment at all** | the H gap |
| **H** | For every active patient: stay months (entry → today, or → exit), cycles **before the records cutoff**, covered / missing / partial cycles, expected monthly amount **incl. and ex-VAT**, total expected, total paid, **gap in months and ₪** (incl. and ex-VAT), and the due dates that are missing | gap ₪ |
| **I** | Suspected duplicate payments: same patient (or, for detached payments, the same house + name), same amount, due dates **≤ 7 days** apart. A separate table lists rows **already voided** (`void` / `מבוטל`, per PR #144) together with the twin each one voids | ₪ |
| **J** | Credits **not attached** to any patient, or whose total is **larger than that patient's total payments**. Cancelled credits are excluded, as the app excludes them | ₪ |
| **K** | Payments dated **after the patient's exit date**, and payment amounts **> 5 %** away from the patient's monthly pay (override-aware). An amount equal to the pay ÷ 1.18 is called out as **"נראה כסכום ללא מע״מ"** | ₪ |

## The same rules as the app, with parity tests

Nothing here is a new definition of "attached" or "owed". Each rule the report
needs was ported from `public/app.js` into a pure `rec*_` helper. A test runs
the port and the `app.js` original **side by side on the same fixtures**:

| app.js | Code.gs | Parity test covers |
| --- | --- | --- |
| `matchPatientForPayment` (uid → exact triple → normalized triple → house + name, ambiguity refused at every tier, a stale uid never falls through) | `recMatchPatient_` | all four tiers and every refusal |
| `reconnectCandidates` | `recCandidates_` | score, reasons and order |
| `normalizeNameForMatch`, `namesLookAlike` | `recNameKey_` (= `diagNormText_`), `recNamesLookAlike_` | NBSP, RLM, NFD/NFC, case, prefixes, shared words |
| the stay window (entry ≤ date ≤ exit; released with no exit date = gone) | `recStayCovers_` | a grid of patients × dates, including a UTC timestamp |
| the records cutoff `2026-07-01` | `recRecordsCutoff_`, `recBeforeCutoff_` | the constant pinned equal, and the boundary day |
| `VAT_RATE`, `revenueExVat` (per row, 2dp) | `recVatRate_`, `recExVat_` | |
| `paymentCoverage` (recorded period wins, else inferred) | `accountingCoverage_` (already in Code.gs) | recorded, half-filled, backwards, Feb 30, > 366 days, timestamp |
| `applyBillingOverride` (unpaid rows only, due-date month) | `recApplyOverride_` | unpaid / partial / paid, other months, zero override |
| `normalizeStage`, payment-status aliases | `recStage_`, `recPaymentStatus_` | every alias, junk, blank |
| entry-day cycles (`projectedCycleDueDates`) | `recCycleDueDates_` | day 31 and 29 Feb anchors, exit on and after an anchor, future entry |
| `isoDate` | `asISODate_` (already in Code.gs) | bare date, UTC timestamps, Date objects |

### Decisions, flagged

1. **Coverage in H.** A cycle counts as covered when a matched payment row has a due date **in the same month**. That is the app's own "billed cycle" rule, so a row whose date drifted a day or two is still that cycle. A cycle also counts as covered when a paid row's **recorded** coverage period contains the cycle's due date, for example two months paid at once. An inferred window is never used this way, because a drifted due date would then "cover" the next cycle.
2. **Owed amount per cycle.** If the cycle has a row, the owed amount is that row's amount with the override applied (unpaid rows only). If it has no row, it is the override for that month, otherwise `pay`. The debt is the amount minus what was paid, with partial payments counting what was actually paid. This is the same figure the גבייה screen shows.
3. **Credits don't reduce the H gap.** They are money going out, not a payment in. Section J covers them.
4. **`void` is recognized before PR #144 merges.** Today an unknown status reads as `unpaid`. The report reads `void` / `מבוטל` as void anyway, so rows voided by PR #144 are never counted as paid or owed, whenever it lands.
5. **Payments has no phone, payer or method column.** `payerUid` is always null by contract. The report reads such a column if someone has added one by hand. Otherwise the phone comes from the linked lead (marked), and method is left blank. Nothing is inferred.
6. **The cycle anchor is clamped** (day 31 → the 30th, or 28/29 in February), as in the revenue screen and the renewal alert.

## Files

| File | Change |
| --- | --- |
| `apps-script/Code.gs` | **Appended** section: `reconciliationReportNow` plus `rec*_` helpers. Function declarations only, each name declared once; no existing function changed. It reuses `diagReadSheet_`-style reading, `diagClientHouseId_`, `diagClientStatus_`, `diagPhoneKey_`, `diagHeaderDrift_`, `diagIsRestored_`, `hasCorruption_`, `corruptionWildcardRegex_`, `corruptionMatchOne_`, `accountingCoverage_`, `asISODate_` and `paymentStatus_` |
| `apps-script/appsscript.json` | adds the `https://www.googleapis.com/auth/documents` scope. Scopes are explicit in this project, so without it `DocumentApp.create` is refused |
| `test/reconciliation-report.test.js` | **new**, 30 tests: read-only source scan + runtime trap, doc-only write path, RTL, HTTP-unreachable, the scope, synthetic Hebrew fixtures for every section A–K, and 10 parity tests against `app.js` |
| `CHANGELOG-reconciliation-report.md` | this file |

No `public/`, `server.js` or `lib/` change.

## Tests

`node --test`: **1,522 passing, 0 failing** (9 skipped, as on the base branch).
The invisible-character guard (`test/code-gs-invisible-chars.test.js`) and the
existing ramot diagnostic's "only functions, each declared once" guard both
stay green.

## Deploy + run

The clasp CI deploys `Code.gs` and `appsscript.json` on merge. Because this adds
a scope, **the first run asks for authorization** to "see, edit, create and
delete your Google Docs documents". Approve it once.

1. Merge the PR and wait for the green **Deploy Apps Script** run.
2. Open the live "ezone dashboard" Apps Script project (scriptId `1cY1qkZoAExfkX2NZsB-UCQs7lnSy2RyWC_6UVAYjCnELWkEp9KQvVlOT`).
3. In the function dropdown pick **`reconciliationReportNow`** → **Run** → approve the Docs permission.
4. Open **Executions** (or the log panel). The line `Report: E-Zone דוח פערים … — https://docs.google.com/…` is the document. The next line is the per-section summary.
5. The doc is in **your** My Drive root and is shared with no one. Share it yourself if you want to.

It can be re-run at any time. Each run creates a new dated document and never
touches the spreadsheet.
