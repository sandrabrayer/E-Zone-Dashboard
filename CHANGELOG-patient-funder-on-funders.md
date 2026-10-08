# Patient funder (גורם מממן) on the Funders sheet — no default

Branch `claude/patient-funder-on-funders` → base
`claude/build-ezone-dashboard-QOg5s`. Builds on #173
(`CHANGELOG-payment-report-foundation.md`) and #176
(`CHANGELOG-payment-report-form.md`). **Supersedes #174 and #175**; Sandra
closes them. `apps-script/Code.gs` changes deploy through the clasp CI on
merge. Do not paste Code.gs by hand. Service worker `CACHE_VERSION`
**v30 → v32**: v31 is held by open PR #177. If #177 ships first, v32 still
evicts v31.

## What Sandra decided (2026-10-04)

| | Decision |
|---|---|
| 1 | **The existing `Funders` sheet is the single source of truth** (`patientId`, `funder`, `effectiveFrom`, `setBy`, `setAt`, append-only; writes through #176's `appendFunder`). `FunderHistory` and `setPatientFunder` (#174) are **never shipped**. |
| 2 | **No default funder.** If a patient has no `Funders` row, or the effective row carries an unrecognized label, the funder is **unset** («לא הוגדר»). It is never read as «פרטי». |
| 3 | **No data migration.** Stored values stay the Hebrew labels from `PAYMENT_FUNDERS`. Keys (`private` / `btl` / `mod` / `maccabi`) exist only in the UI and are derived from the labels by exact string match. |
| 4 | Finance-only. Shiran, Yael and healthcheck see **zero** funder DOM, never call `appendFunder`, and can still admit patients. |

## What users see

**Vered and Sandra (finance):**

- **Patient card «גורם מממן»** (#176's existing field and editor; nothing new
  was added): an unset patient shows an amber **«לא הוגדר»** chip. The editor
  opens on «בחרו…» and will not save without a choice.
- **Admission** (direct add and «קליטה» from a lead): a **required «גורם
  מממן»** field. The row is appended with `effectiveFrom` = the entry date.
  `appendFunder` has no future-date limit, so no clamp is applied. If the
  funder write fails, the patient is still saved and a Hebrew error says so:
  «המטופל נשמר, אך שמירת הגורם המממן נכשלה — …».
- **גבייה → «השלמת גורם מממן — X נותרו»**: every patient whose funder is
  unset, in these groups:
  - every non-released patient;
  - released patients with **open debt**: owed cycles in the loaded «חובות
    פתוחים» report, or an open balance in «יתרות פתוחות». These are tagged
    **«שוחרר/ה · יתרה פתוחה»**.
  
  The default «מתאריך» is the entry date. Each row saves on its own through
  `appendFunder`. The panel is hidden when nothing remains. No new endpoint.
- **Funder filter** (הכל / פרטי / ביטוח לאומי / משרד הביטחון / מכבי / לא
  הוגדר) on the גבייה lists and on «חובות פתוחים». The filter uses the
  funder on the row's **due date**; for debt, the funder on the cycle's start
  day.
- **Funder × house strip** on «חובות פתוחים»: two tables, «חוב רשום» and
  «מחזורים שלא נרשמו», **never summed**. The strip is computed by
  `Funder.debtByFunder` over the same report and `asOf` the screen shows, and
  follows the house and status filters. Its totals equal the aging totals.

**Shiran and Yael (restricted):** no change. They see no funder chip, field,
filter, strip or fill screen. Admission works without a funder, and
`appendFunder` is never called.

## Payment reports (#176) without a funder

`reportPayment` used to fill a missing funder from the default («פרטי»). Now:

- If the report names no funder and the patient's funder is unset on the
  received date, the server **refuses** with `funder_unset`: «לא הוגדר גורם
  מממן למטופל — יש לבחור גורם מממן בדיווח או להגדיר אותו בכרטיס המטופל».
  Nothing is written.
- The report form's funder select now starts on «בחרו…». Before, it silently
  pre-selected the first option («פרטי»). **This was a bug fix.**

## Code

| File | Change |
|---|---|
| `apps-script/Code.gs` | `DEFAULT_FUNDER` → `FUNDER_UNSET = 'unset'`. `currentFunderFrom_` / `currentFunder_` return unset when there is no row, when every row is after the date, when the effective label is unrecognized, or on a read error. `upsertPayment_` refuses `funder_unset`. `fundersForClient_` also sends rows with unrecognized labels, so the client resolves them the same way. The cleanup workbook's «חסר גורם מממן» writes `unset`. |
| `lib/payment-report-rules.js` | Same change, mirrored (`FUNDER_UNSET`, `funder_unset` message; parity-tested against Code.gs). |
| `lib/cleanup-xlsx.js` | «חסר גורם מממן» text: «נחשב כעת: לא הוגדר», with the fix path through «השלמת גורם מממן». |
| `public/funder.js` (new, pure, UMD) | `FUNDER_KEYS`, `FUNDER_UNSET`, `LABEL_TO_KEY` (exact labels → keys), `KEY_TO_LABEL`, `UNSET_LABEL`, `keyFromLabel` (unknown → `unset`), `labelFor`, `isoDay`. `funderAt(rows, patientId, date)` returns the row with the latest `effectiveFrom` ≤ date; ties go to the later `setAt`, then the later row (same rule as Code.gs). `debtByFunder(report, rows, asOf)` returns five buckets × {`recorded_debt`, `unrecorded_cycles`, `byHouse`}. |
| `public/app.js` | No default in `currentFunderFor`. Amber «לא הוגדר» chip. Required funder at admission (`admissionFunderFields` / `admissionFunderError` / `saveAdmissionFunder`). Fill screen (`openDebtPatientIds`, `funderFillRows`, `renderFunderFill`). Filter (`billingRowFunderKey`, `filterDebtReportByFunder`). Strip (`debtFunderStrip`). Everything sits behind `funderView()` = `state.finance === true` and is escaped with `escapeHtml`. |
| `public/index.html` | `#billing-funder` select, `#funder-fill` panel, and `funder.js` loaded before `app.js`. |
| `public/style.css` | Chip, amber unset, fill panel, released tag, strip. 44px targets; wraps at 360px. |
| `public/sw.js` | v32. `/funder.js` is precached and network-first. |
| `server.js` | `GET /funder.js` static route. |

## Security

- The server refuses `appendFunder` for anyone outside finance (#176, unchanged). The client also never builds funder DOM or calls `appendFunder` for restricted or unknown viewers (`state.finance !== true`), and `applyView(false)` clears the funder rows from memory.
- Every patient name and label is escaped before it is rendered. Select values are the escaped labels, because `showModal` prints them raw.
- No PII in logs. No new action, env var, Script Property, scope or trigger.

## Tests

`node --test`: **2068 tests, all green.** The new file is
`test/patient-funder-on-funders.test.js` (20 tests):

- unset default in Code.gs, plus a guard: the literal «פרטי» appears in Code.gs only inside `PAYMENT_FUNDERS`, and never in `app.js`;
- a guard that `PAYMENT_FUNDERS` equals `Object.keys(LABEL_TO_KEY)`;
- `keyFromLabel` and `funderAt`, with parity against `currentFunderFrom_` on every day of a mixed history;
- the `debtByFunder` invariant on a **real `debtAging_` report**;
- restricted users (finance false and null) get zero DOM and no `appendFunder` call;
- admission is blocked without a funder, allowed with one, and a failed funder write keeps the patient;
- fill-screen scope, including released patients with debt;
- the filter, and strip totals equal to the aging totals under house and status filters;
- SW and server wiring, CSS, and escaping.

Existing tests were updated for "no default": explicit `Funders` fixtures and
a new `funder_unset` refusal test.

**Mutation check:** four deliberate breaks, each caught and then reverted:

1. `funderView` ungated → the 3 restricted tests fail.
2. Admission check disabled → the admission test fails.
3. Strip ignores the house filter → the strip test fails.
4. `currentFunderFrom_` falls back to «פרטי» again → 6 tests fail.

## Live test

**As Vered:**
1. The card of a patient with no funder shows amber «לא הוגדר».
2. Admitting a patient without a funder is blocked with «יש לבחור גורם מממן». With a funder, the patient is admitted and the card shows that funder.
3. In גבייה, «השלמת גורם מממן — X נותרו» lists the unset patients. Saving one lowers X by one.
4. Set the filter to «מכבי»: only Maccabi rows remain, in both the lists and «חובות פתוחים».
5. In the strip, the column totals equal the aging totals.
6. Report a payment for an unset patient without choosing a funder: the report is refused in Hebrew and nothing is written.

**As Shiran:**
1. No funder field on admission, and admission still works.
2. No funder anywhere on the card.
3. No גבייה tab.
