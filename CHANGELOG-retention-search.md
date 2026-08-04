# Retention (שימור לידים) Tab — Search

Adds a search box to the שימור לידים (closed-leads) tab, matching the leads-tab
search. **Frontend-only** — Railway auto-deploys on merge; no Apps Script steps.

## What changed

### `public/index.html`
- Added a search input to the retention tab's header, same markup/placeholder as
  the leads tab (`חיפוש שם / טלפון / בית`). It reuses the shared
  `.actions input[type=search]` styling, so look and responsive width match the
  leads tab exactly.

### `public/app.js`
- New `state.retentionSearch` (mirrors `leadSearch`).
- **`irrelevantLeadMatchesQuery(lead, q)`** — a thin per-tab wrapper over the
  shared `leadMatchesQuery` (name / phone / house / contact fields / billing
  phone). It does **not** modify `leadMatchesQuery`; it only widens matching for
  this tab so a closed lead also matches on its **origin sheet** — the stage it
  was closed from, shown in each row's meta — by both the stable stage id and its
  Hebrew label (via the pure `stageLabelById`).
- **`filterIrrelevantGroups(rows, q)`** — pure: groups closed leads into the
  three disposition sections in spec order (`not_relevant`, `completed`,
  `stopped_early`; unknown/blank → `not_relevant`, unchanged from before) and
  applies the query inside each group. Returns `[{ key, rows }]` for non-empty
  groups only, so a group with zero matches is dropped while a query is active.
  Empty query → every row matches → the exact current grouping.
- `renderIrrelevantLeads` now filters through `filterIrrelevantGroups`:
  - each group heading's count reflects the **filtered** rows (e.g. `לא רלוונטי (12)`
    while searching);
  - the top count pill (`סגורים`) shows the filtered total, so **clearing the box
    restores the full list and counts exactly**;
  - a non-empty collection with no matches shows a "no results for this search"
    message; the original empty-collection message (`אין לידים סגורים`) is
    unchanged.
- Live filtering on `input` — same immediate behavior as the leads tab — re-runs
  `renderIrrelevantLeads` only (no full re-render). The separate
  לידים שהוסרו (removed) list is intentionally left unfiltered.

## Tests — `test/retention-search.test.js`
Existing `node:test` + vm-sandbox pattern (not Jest):
- `irrelevantLeadMatchesQuery` — empty query matches all; matches base lead
  fields via `leadMatchesQuery` (name, normalized phone, contact name/phone);
  also matches origin-sheet id + Hebrew label.
- `filterIrrelevantGroups` — empty query returns every group in spec order with
  all rows; unknown/blank disposition → `not_relevant`; filtering returns the
  right subset with per-group counts; zero-match group excluded while querying;
  no matches anywhere → empty; nullish rows → empty (no throw).

Full suite: `npm test` → **325 passed, 0 failed** (316 prior + 9 new), zero
regressions.

## Deploy
- Frontend-only; Railway auto-deploys on merge — no Apps Script steps.
- **Post-merge verification:** שימור לידים shows a search box; typing a name
  filters rows and updates the group counts; clearing restores the full list.
