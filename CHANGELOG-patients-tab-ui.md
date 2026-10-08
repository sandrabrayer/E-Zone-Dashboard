# «מטופלים» — the patient list, PR 2: the tab

The app gets the patient list it lacked. Until now there was only **תפוסה**.
**«מטופלים»** sits right after **«לידים»**. It is built on the PR 1 helpers
(`CHANGELOG-patients-tab-foundation.md`).

**Railway only.** The change is `public/app.js`, `public/index.html`,
`public/style.css` and `public/sw.js`. `apps-script/Code.gs` and `server.js`
are not touched. There is no new action, column, sheet, Script Property, env
var or trigger, and no new data is written. «מטופלים משוחררים» stays as it is.

## What is on the tab

1. **The summary line:** «N מטופלים פעילים עם בעיות פתוחות», plus one red
   chip per problem type with its count. With nothing open, it reads «אין
   בעיות פתוחות במטופלים הפעילים».
2. **«ממתינים לקליטה (N)»:** leads that are paid or «נכנסים לטיפול» and have
   no patient record. This is the #192 rule, with the same matching, and an
   ambiguous match is never listed.
   - Each row shows the name, house, entry date, days since entry, phone,
     source and advance.
   - **«קלוט כמטופל»** (edit mode) opens the existing «כניסה לבית» admission
     modal (`openEntryModal`).
   - From day 3, a row carries the #192 chip «לא נקלט כמטופל · N ימים».
   - The section follows the house and name filters and hides when it is
     empty.
3. **The list:** one row per patient.
   - **Filters:** name search, house, a status select (פעילים by default,
     משוחררים, הכל) and «בעיות בלבד». They live only for the session.
   - **Columns:** name, house, entry date, days in the house (entry → exit
     for a released patient), **גורם מממן**, **תשלום** (the current cycle's
     status and due date), and the problem chips.
   - **Problem chips:** ללא גורם מממן · לא דווח תשלום · בית שונה מהליד · ללא
     ליד.
   - **«פרטי הליד»:** a closed `<details>` on each row. It shows the phone,
     source, visit date, advance, the lead's house, who handled it (משוייך ל
     / נפגש עם) and the lead's notes, with line breaks kept.
     - Without a lead it reads «ללא ליד».
     - A `fromLead` whose lead is gone reads «הליד המקושר לא נמצא».
     - An ambiguous match reads «נמצאו כמה לידים תואמים, לא קושר».
     - It is a display join. Nothing is copied into Patients.
4. **The badge on the tab:** the number of active patients with at least one
   open problem. It is red (`.tab-badge-danger`) and hidden at zero.

## Actions — existing flows only

| Button | Flow |
|---|---|
| ✏️ | `openEditPatientModal` |
| «הגדר גורם מממן» | `openFunderModal` (finance + edit) |
| «דווח תשלום» | `openPaymentReportModal` on the current cycle, only when it is unpaid or partial (finance + edit) |
| «קלוט כמטופל» | `openEntryModal` («כניסה לבית»), in the pending section |
| «שחזר» | `showRestorePatientChoiceModal` on a released row, the same bridge as in תפוסה |

The only other app.js touch: after a successful «דווח תשלום»,
`submitPaymentReport` also calls `renderPatientsTab()`, so the row's payment
column updates. That is display only.

## Who sees what

| Session | Tab | Payment column, funder cell and chip, «דווח תשלום», «לא דווח תשלום» |
|---|---|---|
| Vered, Sandra | yes | yes |
| Shiran, Yael (restricted) | yes | **no**. They see the rest, including advance and lead details, which are on the leads board too |
| Ortal (controller) | **no**. `applyControllerView` removes every tab outside `allowedScreens`, and `renderAll` returns before it | — |

- **Enforced by the existing view flags.** `state.finance === true` gates the
  money cells. The PR 1 helpers never read payments or funders without it,
  even when an array is in memory, and a test covers that case.
- **The server already withholds the data.** `getPayments` (payments,
  funders, receipts), `reportPayment` and `appendFunder` are in
  `FINANCE_ACTIONS` (403). I verified this; it is not duplicated.

## Escaping, RTL, 360 px

- Every value goes through `escapeHtml`: patient names, lead names, lead
  notes, source, phone. A scan test checks that every `${}` in the UI block is
  escaped.
- Rows are a column of wrapping bands. Long text breaks
  (`overflow-wrap: anywhere`). Controls are at least 44 px tall. Below 480 px
  the filters stack and the cells go two per line.
- The browser test checks there is no horizontal scroll with the lead
  details open, in both the finance and the restricted view.

## Tab order

The tab order is now לידים → **מטופלים** → לוח פגישות. Three tests that
pinned the old order were updated:

- `meetings-tab-shell.test.js`: לוח פגישות now follows מטופלים.
- `restricted-view.test.js` and `restricted-view-browser.test.js`: 8 tabs for
  Shiran / Yael, 13 for Vered / Sandra.

## Service worker

`CACHE_VERSION` v44 → **v45**. I checked all 159 remote branches, and the
highest version on any of them is v44. v17 stays burned. The exact pin
(`dashboard-perf-assets` D) now expects v45. The receipts PR's own pin reads
"v44 or later".

## Tests

`test/patients-tab-ui.test.js` (15 tests, CI):

- **Placement:** the tab is after לידים, with no `data-finance`; the badge,
  the screen and the filter ids exist; «מטופלים משוחררים» is unchanged.
- **Router:** restricted sessions keep the tab; the controller view never
  has it.
- **Finance row:** the funder cell and «הגדר גורם מממן»; the payment status;
  «דווח תשלום» only on an unpaid cycle and only in edit mode; «לא הוגדר»
  plus the red chips.
- **Restricted** (`finance` false or null, with money data in memory): no
  money cell, button or chip.
- **Row cells:** days in the house; «שחזר» only on released rows.
- **«פרטי הליד»:** every field shown, the note escaped; the three
  no-lead wordings.
- **Pending row:** its fields, the #192 chip, «קלוט כמטופל» in edit mode only.
- **`renderPatientsTab`:** badge, count, summary, the pending heading, the
  filters; the zero state; the controller view renders nothing.
- **Scope:** no fetch, save or action; the five existing flows by name;
  Code.gs untouched; `renderAll` and `initTabs` wiring; every interpolation
  escaped; the CSS rules; SW v45.

`test/patients-tab-ui-browser.test.js` (Chromium, **360 px**):

- the tab order and the red badge;
- the pending row with its chip;
- the chips, buttons and values inside each row;
- «פרטי הליד» opening, with a hostile `<img onerror>` note shown as text;
- no sideways scroll;
- the filters («בעיות בלבד», house, status);
- the restricted view with no money cell and only «ללא ליד»;
- «קלוט כמטופל» opening «כניסה לבית»;
- no `/api/` POST from rendering or filtering, and no page errors.

The browser test also caught a bug before release: the filter handlers held
the filters object from wiring time. They now read the live one.
