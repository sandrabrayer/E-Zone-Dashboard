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
  1. **Managers tab.** A row is current when `end_date` is blank or today or
     later. "Today" is computed in **Asia/Jerusalem**. This source is used
     whenever the tab has at least one row with a name, even if every row has
     ended; in that case no house has a current manager.
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
  work. An unreadable `end_date` keeps the row current, so a typo never hides
  a manager.
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

### Tests

`test/current-managers.test.js` (23 tests). 21 of them fail against the
previous code; the other 2 are guards that must hold before and after (no tab
is created, the bonus readers are unchanged). They cover:
- empty or missing Managers → bonusconfig fallback
- no Managers rows and no bonusconfig → exactly `houseManagers`
- bonusconfig without a `manager` header → default
- case-insensitive tab and header lookup
- end date in the past → hidden; today, future or blank → current
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

Full suite: 1651/1651.

## For Sandra

Nothing to do for this to deploy. Until the `Managers` tab has rows, the
dashboard uses the `manager` column of `bonusconfig`. Once you add rows to
`Managers`, it switches to them on the next load. To end an assignment, put
the last day in `end_date`: from the next day that manager disappears from
the strip and the dropdown. Leads already saved with that manager keep the
name.
