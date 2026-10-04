# Patient funder (גורם מממן) — UI (PR 2 of 2)

Branch `claude/patient-funder-ui`, built from `claude/peaceful-meitner-43w32h`
(PR 1, #174), → base `claude/build-ezone-dashboard-QOg5s`.

**Merge PR 1 (#174) first.** Until it merges, this PR's diff also shows PR 1's
commit. This PR has **no `Code.gs` change**: it uses PR 1's `FunderHistory`,
`getData.funderHistory` and `setPatientFunder` as they are.

SW `CACHE_VERSION` **v29 → v30**. Nothing to set in Railway or in Script
Properties.

## Who sees what

| | Sandra, Vered (`finance`) | Shiran, Yael, healthcheck (restricted) |
|---|---|---|
| Chip on the patient card | yes | **no** |
| Funder field in the ✏ modal + history | yes | **no** |
| Funder field at admission | **required** | hidden; admission allowed |
| «השלמת גורם מממן» on גבייה | yes (when X > 0) | **no** (no גבייה tab) |
| Funder filter + funder × house strip | yes | **no** |
| `setPatientFunder` request | yes | **never sent** |

`funderView()` is true only when `/api/me` said `finance` **and** `funder.js`
loaded. A session not known to be finance yet, or one where `funder.js` did not
load, shows no funder UI and blocks no admission. Every funder element is
inside the finance-only גבייה screen or carries `data-finance`, so
`applyView(false)` removes it. `applyView(false)` also clears
`state.funderHistory`. The server refuses the data and the write as well
(PR 1).

## What changed

### Wiring

- `index.html` loads `funder.js?v=__BUILD__` **before** `app.js`. The module
  becomes the global `Funder`.
- `server.js` has a static route `GET /funder.js` (same headers as
  `app.js`).
- `sw.js`:
  - `/funder.js` is precached and served **network-first** (like `app.js`);
  - `CACHE_VERSION` v30, the next free version. The deploy branch and open PR
    #173 are on v29, and the other open PRs are lower. v17 is not reused.

### `public/app.js`

- **State.** `state.funderHistory` comes from `getData.funderHistory` (finance
  only). `state.billingFunder` is the גבייה filter.
- **Patient card.** A chip with `Funder.currentFunder` for today, or the exit
  day for a patient who left. `unset` shows as an amber «לא הוגדר» badge.
- **✏ edit modal.**
  - A «גורם מממן» section: a select preselected with the current funder, and
    «החל מ» defaulting to today.
  - Below it, a read-only history list (date · label · recordedBy), newest
    first.
  - After the patient saves, a row is appended **only** when the pick
    differs from the current funder, or when it keeps the same funder from
    another day (a correction).
  - `showModal` gains a read-only `html` field type for the list. The caller
    escapes the content.
- **Admission** (admit-from-lead and direct add):
  - For a finance session the funder is **required**. Without one the modal
    stays open with «יש לבחור גורם מממן» and nothing is saved.
  - After the patient saves, `setPatientFunder` runs with `effectiveFrom` =
    the entry date. An entry date more than one day ahead becomes today,
    because the server refuses dates further ahead.
  - If the funder write fails, the patient is **kept**, the error is shown,
    and the patient keeps the «לא הוגדר» badge and appears on the fill screen.
- **Writes** go through `savePatientFunder`, which follows the closeLead
  pattern:
  - optimistic append, then `renderAll`;
  - on failure, rollback and the Hebrew error «שמירת גורם מממן נכשלה — …»;
  - `lock_busy` gets the shared single retry, then «המערכת עסוקה, נסו שוב».
- **«השלמת גורם מממן — X נותרו»** at the top of גבייה:
  - It lists every patient who is not released and whose funder today is
    `unset`: name, house, entry date, a select, and «החל מ» defaulting to the
    **entry date**, so debt already accrued is attributed.
  - Rows are saved one at a time, and a saved row disappears.
  - The section is hidden when X = 0.
- **Funder filter** (הכל / each funder / לא הוגדר), in the גבייה header.
  - On «לגבייה בתאריך הנבחר» and «יתרות פתוחות», a row's funder is the
    patient's funder **on that cycle's due date**. The KPI cards follow the
    filtered list, the same rule as search.
  - On «חובות פתוחים», only the cycles of the chosen funder are kept, so the
    blocks and the drill-down show that funder's debt.
- **Funder × house strip** at the top of «חובות פתוחים»:
  - It is `Funder.debtByFunder` over the **same** `debtAging` report and
    as-of date the view uses. It follows the house and status filters, and
    always shows all five funder rows.
  - «חוב רשום» and «מחזורים ללא רישום» are two tables, **never summed**.
  - Its totals equal the view's block totals.
- Every rendered value goes through `escapeHtml`. Option values are the
  stable keys only, never a Hebrew label.

### `public/style.css`

- `.funder-chip`, and `.funder-unset`: amber, the `.badge.trial` palette.
- The fill-screen panel.
- At least 44px for the filter, the selects, the date inputs and the
  buttons.
- Rows wrap to full width under 480px, which covers 360px screens. RTL comes
  from the page.

## Tests

New file `test/patient-funder-ui.test.js` (24 tests). It runs in vm sandboxes
on the real `app.js`, `funder.js` and `Code.gs`, with TZ = Israel and
synthetic names. It covers:

- **Restricted** (finance false, and finance not yet known):
  - zero funder DOM on the card, in the edit and admission modals, on the fill
    screen and in the debt view;
  - admission is allowed without a funder;
  - `setPatientFunder` is **never** sent, even on a direct call;
  - `applyView(false)` drops the history.
- **Finance**:
  - the chip, and the amber unset badge;
  - a released patient's funder is read on the exit day;
  - admission is **blocked** without a funder, or with a label, case variant
    or unknown value. This is checked on both admission paths;
  - with a funder, `setPatientFunder` runs with the entry date;
  - when the funder write fails, the patient is kept, the error is shown, the
    patient is rolled back to unset and listed on the fill screen;
  - when the patient save fails, no funder is sent.
- **Edit modal**:
  - the preselected funder, «החל מ» = today, the history newest first;
  - escaping (`recordedBy` `<img …>`);
  - the write rule.
- **Fill screen**:
  - the count and who is listed;
  - the default effectiveFrom = the entry date, or today when the entry is
    more than a day ahead;
  - escaping, and hidden at 0;
  - an optimistic save disappears and comes back on `lock_busy`.
- **Strip = aging totals.** On a **real** `debtAging_` report from `Code.gs`,
  at two as-of dates, with no filter, a house filter and a status filter: the
  totals match per figure and per house. With no filter they equal
  `report.totals`.
- **Filter**:
  - each funder's filtered blocks equal that funder's strip row;
  - the five filtered views add up to the whole;
  - a patient with no matching cycle is dropped;
  - billing rows use their due date.
- **Wiring**:
  - `funder.js` loads before `app.js`, inside the finance-only screen;
  - SW v30 (from v29), `/funder.js` precached and network-first;
  - the CSS for 44px controls and the 360px wrap;
  - an escaping guard over the whole funder block.

Updated existing tests:

- `test/lock-busy-frontend.test.js`: the `setPatientFunder` write path has its
  busy-lock retry tests, as every write must.
- `test/personal-pins-cleanup.test.js`: the SW check is now "v29 or later",
  the same pattern as earlier version checks.
- `test/patient-funder-foundation.test.js`: PR 1's "funder.js is not loaded
  yet" test now checks that it **is** served and loaded before `app.js`.

I also broke the code four ways to check that the tests catch it: an ungated
chip, no admission check, a strip not following the house filter, and an
ungated write. Each one failed the tests.

**Full suite: 2024 / 2024.**

## ⚠ Open PR #173 has a second funder model

`feat/payment-report-foundation` (#173, open) adds a separate `Funders` sheet:
- its columns are `patientId, funder, effectiveFrom, setBy, setAt`;
- it stores **Hebrew labels** as values (`PAYMENT_FUNDERS = ['פרטי', …]`);
- a missing funder **defaults to `'פרטי'`**.

That conflicts with the decisions locked for this feature: stable keys, and a
missing funder reads as `unset` («לא הוגדר»). Merging both gives two sources
of truth for the same fact. This should be decided before #173 merges. One
option is for #173 to read `FunderHistory` (with `funderAt`) and map the keys
to labels only when it displays them.

## Live test (after #174 and this PR are merged and Railway has deployed)

1. **As Vered**, on any house in תפוסה: each card shows «גורם מממן» with a
   chip. A patient with no funder shows the amber «לא הוגדר».
2. **As Vered**, on גבייה:
   - «השלמת גורם מממן — X נותרו» lists those patients, and «החל מ» shows each
     one's entry date;
   - choose a funder and press «שמירה": the row disappears, X drops by one,
     and the card chip changes.
3. **As Vered**, ✏ on a patient: under «גורם מממן», change the funder, set
   «החל מ» and save. The history list (reopen ✏) shows the new row on top with
   your name.
4. **As Vered**, «הוספת מטופל ישירות», or admitting a lead:
   - saving without a funder is refused with «יש לבחור גורם מממן»;
   - with a funder, it saves, and the chip appears.
5. **As Vered**, on גבייה → «חובות פתוחים»:
   - the strip shows two tables (חוב רשום / מחזורים ללא רישום) by funder ×
     house;
   - each table's total equals the block total below it with the filter on
     «כל הגורמים המממנים»;
   - choosing a funder narrows the lists and blocks to that funder.
6. **As Shiran**: there is no גבייה tab, no chip on any card, and no funder
   field in ✏ or in the admission modals. Admitting a patient works without a
   funder. Vered then sees that patient with the amber badge and on the fill
   screen.
