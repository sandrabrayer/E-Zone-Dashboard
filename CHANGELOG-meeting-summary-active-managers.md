# Current house managers for the meetings board

Branch `fix/meeting-summary-active-managers` → base
`claude/build-ezone-dashboard-QOg5s`. `public/` changed, so `CACHE_VERSION`
v19 → **v20**.

## Why

The meetings summary strip, the «נפגש עם» dropdowns and the per-house
meetingWith default all read `houseManagers`, which is a fixed list in
`Code.gs` (`HOUSE_MANAGERS`). When a house's manager changes, the dashboard
keeps showing the old one until someone edits the code. The source of truth
is the `Managers` tab (`house | manager_name | start_date | end_date`), which
Sandra keeps.

## What

### `apps-script/Code.gs` (separate commit; clasp CI deploys it on merge)

- `getData_` gains two keys (additive; the append-only contract holds):
  - `currentManagers: [{ house, name }]`
  - `currentManagersSource: 'managers' | 'bonusconfig' | 'default'`
- **`houseManagers` is unchanged.** It is still `HOUSE_MANAGERS`, so nothing
  Managers or Therapists read changes. The bonus logic (`readManagers_`,
  `readBonusConfig_`, `managersOverview_`, `managersHouse_`) is untouched.
- `currentManagers_()` takes the first source that has data:
  1. **Managers tab.** A row is current only when **`start_date` is blank or
     today or earlier** and **`end_date` is blank or today or later**. "Today"
     is computed in **Asia/Jerusalem**. This source is used whenever the tab
     has at least one row with a name, even if no row is current; in that case
     no house has a current manager.
  2. **bonusconfig `manager` column**, used only when the Managers tab is
     missing or has no named row. The live tab is the lowercase
     `bonusconfig`, with `manager` in column K.
  3. **`HOUSE_MANAGERS`**: exactly what `getData` has always sent as
     `houseManagers`. No new behavior.
- **Nothing is hardcoded.** Tabs are found by name case-insensitively
  (`bonusconfig` = `BonusConfig`), and columns by their header text, never by
  position. A bonusconfig without a `manager` header falls through to step 3.
- **House keys** come out as Patients ids. `raanana` → `asher` and `efroni` →
  `arfoni`; `ramot`, `rehab` and `pardes` keep their names. This uses the
  existing `MANAGER_HOUSE_TO_PATIENTS_HOUSE_ID`; an unknown house is skipped.
  Within a house, the newest `start_date` comes first, and that manager is the
  default.
- **Dates:** a real date cell, `YYYY-MM-DD`, or a hand-typed `DD/MM/YYYY` all
  work. A date cell is read in **Asia/Jerusalem**, the same zone as "today",
  not in the spreadsheet's own zone. Otherwise, under a UTC sheet, a date
  entered as 1 October (midnight in Israel) would read as 30 September. An
  unreadable `start_date` or `end_date` counts as blank.
- **Read-only.** It never calls `getOrCreateSheet_`, so a missing tab is not
  created. It writes no cell, header or format, and never throws: a read error
  falls through to the next source.

### `public/app.js`

- `loadAll`: when `currentManagers` is present, it becomes the roster
  (`state.houseManagers` = first current manager per house, and
  `state.currentManagers` = the full list). An older backend without the
  field keeps `houseManagers` as sent.
- **Summary strip:** shows **current managers only**. A former manager's row
  is hidden, and the «ללא מנהל» row is hidden. The counts themselves
  (`computeManagerConversion`) are unchanged.
- **«נפגש עם» dropdowns** (lead card, add/edit lead modal, meeting edit
  modal) list the current managers, including a second current manager in
  the same house. A **saved former manager is pinned as an extra option and
  stays selected.** Without that, the select would fall back to «— ללא —» and
  the next save of the edit modal would erase the stored name.
- **Per-house default** (new lead, card default, background autosave) is the
  house's current manager.

### Choices (decided in review)

| Case | Result |
|---|---|
| `start_date` blank, or today or earlier | may be current (then `end_date` decides) |
| `start_date` after today | **not current yet** |
| `end_date` blank, or today or later | may be current (then `start_date` decides) |
| `end_date` before today | not current |
| `start_date` and `end_date` both today | current (a one-day assignment) |
| Unreadable `start_date` or `end_date` | counts as blank, so a typo never hides a manager |
| The Managers tab has named rows but none is current | no house has a current manager; **no** fallback to bonusconfig (fallback only when the tab is missing or empty) |
| Two current managers in one house | both are offered in the dropdown; the newer `start_date` is the default |
| A date cell | read in Asia/Jerusalem, whatever the spreadsheet's zone |

### Tests

`test/current-managers.test.js` (31 tests).

The first 23 shipped with the PR: 21 fail against the previous code, and the
other 2 are guards that must hold before and after (no tab is created, the
bonus readers are unchanged).

The review follow-up added 8 more:
- future `start_date` → not current
- blank `start_date` → current
- `start_date` = today → current, as a string and as a Date cell
- unreadable `start_date` → current
- both bounds together
- `managerDateIso_` returns `2026-10-01` for a Date at 00:00 Asia/Jerusalem
  (`new Date('2026-10-01T00:00:00+03:00')`) under Asia/Jerusalem, UTC,
  New York and London sheet zones
- an `end_date` of today at Jerusalem midnight keeps the manager under a UTC
  sheet
- `rehab` / `'רנטה'` end to end: Managers tab → `getData` `currentManagers`
  → the summary-strip filter, exact string

The sandbox's `Utilities.formatDate` now honours the time zone, which is how
the midnight shift was caught. Against the previous code, 4 of the 8 fail.

The suite covers:
- empty or missing Managers → bonusconfig fallback
- no Managers rows and no bonusconfig → exactly `houseManagers`
- bonusconfig without a `manager` header → default
- case-insensitive tab and header lookup
- end date in the past → hidden; today, future or blank → current
- start date in the future → hidden; today, past or blank → current
- `DD/MM/YYYY` dates and real date cells
- all rows ended → no fallback
- house ids `asher` / `ramot` / `arfoni` / `rehab` / `pardes`
- the newest start date is the default
- Asia/Jerusalem "today"
- a read error falls through
- `getData` read-only, with `houseManagers` unchanged
- the strip hides former managers and «ללא מנהל»
- dropdowns keep a saved former manager
- the per-house default and autosave use the current manager

Full suite: 1659/1659.

## For Sandra

Nothing to do for this to deploy. Until the `Managers` tab has rows, the
dashboard uses the `manager` column of `bonusconfig`. Once you add rows to
`Managers`, it switches to them on the next load. To end an assignment, put
the last day in `end_date`: from the next day that manager disappears from
the strip and the dropdown. Leads already saved with that manager keep the
name. A new manager can be added ahead of time with a future `start_date`;
they appear on that day, not before.

## Follow-up — October 6, 2026 (tests and docs only)

The feature branch `fix/meeting-summary-active-managers` was merged as PR #154
on October 1. On October 6 it was re-checked against the deployed branch,
which now also carries #186 (page-load perf / hashed assets), #187 and #188
(Ortal billing):

- `currentManagers_` is still called by `getData_` after #186's read-path
  rework. It does its own read-only lookup. #186's script cache stores no
  responses, so the roster is read fresh on every load. It sits behind
  the same PROXY_SECRET gate as every other action (unchanged, still in its
  transition mode), and no shared action changed.
- No runtime file changed, so the SW `CACHE_VERSION` stays **v40**. Bumping
  it without an asset change would only make every client re-download.

Tests added to `test/current-managers.test.js` (31 → 33):

- **escaping:** a hostile `Managers` cell (`<img onerror=…>&'`) passes through
  `Code.gs` untouched. The summary strip, the meetingWith `<option>` (value
  and label) and the meetings row all HTML-escape it, and no raw tag
  survives.
- **saved former manager:** `אורן` ended yesterday and `דנה` starts today, and a
  meeting is saved with `אורן`.
  - The meetings row shows `אורן` and the dropdown keeps it selected, with
    `דנה` offered alongside.
  - The strip hides `אורן`'s row.
  - The default autosave neither rewrites `אורן` nor saves anything.

Mutation checks against the suite: 6 of 7 mutants were killed. The survivor
was an equivalent mutant: dropping only the explicit «ללא מנהל» filter leaves
it hidden, because «ללא מנהל» is never a current manager. Dropping the whole
filter is killed.

Full suite: 2280/2280, with the Chromium browser tests run (none skipped).

