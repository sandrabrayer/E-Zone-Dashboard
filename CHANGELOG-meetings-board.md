# Meetings board (לוח פגישות) + meetingWith dropdown

Fills the previously-empty לוח פגישות tab with a weekly, read-only meetings
board, and adds a **נפגש עם** (meetingWith) dropdown to the lead add/edit form.
Both build on already-merged groundwork: the `#meetings-board` shell (PR #50)
and the `meetingWith` column + `HOUSE_MANAGERS` roster (PR #51).

## What changed

### `public/app.js`

**House-manager roster into state**
- `state.houseManagers` (new) is populated in `loadAll` from `getData`'s
  `houseManagers` field (exported from `HOUSE_MANAGERS` in `Code.gs`). Keyed by
  house id. Missing/invalid on older deploys → `{}`, so the UI degrades to a
  blank default rather than breaking.

**meetingWith dropdown (Change 1)**
- New helpers, all reading `state.houseManagers` — **no names hardcoded in
  app.js**:
  - `managerForHouse(house, managers)` — resolves a house (Hebrew label *or*
    internal id, via `resolveHouseId`) to its manager. Returns `''` for houses
    with no manager (`pardes`/`sde`), an unknown/external house, or no house.
  - `managerOptions(managers)` — the distinct manager names for the dropdown, in
    a stable order.
  - `meetingWithField(preselect)` — builds the shared modal `<select>` field
    (blank `— ללא —` placeholder + the four managers).
- **Add lead:** field added; no house is chosen yet at add time so the default
  resolves to blank; Vered can pick any of the four. Persists through the
  existing `normalizeLead({...vals})` path (`meetingWith` is already in
  `LEAD_COLUMNS`).
- **Edit lead:** field added, pre-selecting an existing `meetingWith` if set,
  otherwise the manager of the lead's house. `onSubmit` now writes
  `lead.meetingWith`.

**Meetings board (Change 2)**
- `meetingsForWeek(leads, weekAnchorISO)` — pure bucketing (reuses
  `weekStartSunday`/`addDaysISO`/`isoDate`/`isoTime`). Source is leads with a
  non-empty `visitDate`. Returns the Sunday–Saturday week's meetings grouped by
  day (empty days omitted); within a day, timed meetings sort by `visitTime`
  ascending (name tiebreak) and date-but-no-time leads are bucketed separately
  (`noTime`) so the renderer places them last under a **ללא שעה** grouping.
- `renderMeetings()` — renders into `#meetings-board`: a nav row (prev week /
  השבוע / next week + the week range), then a **list** grouped by day (not a
  grid), each day a Hebrew heading + date and rows of
  `time · lead name · house label · meetingWith`. RTL throughout. A week with no
  meetings renders an empty-state message (`אין פגישות מתוזמנות לשבוע זה`), not a
  blank container. Read-only — no editing from this tab. Wired into `renderAll`;
  the week defaults to the current week and the nav buttons re-render in place.

### `public/style.css`
- Replaced the placeholder dashed `.meetings-board` with real board styles:
  `.mtg-nav`, `.mtg-range`, `.mtg-empty`, `.mtg-list`, `.mtg-day` /
  `.mtg-day-head`, `.mtg-row` (4-column grid), `.mtg-notime-head`. Theme-var
  based, direction-neutral (RTL intact).

### Tests — `test/meetings-board.test.js`
- **Week-boundary bucketing** — Sunday (week start) and Saturday (week end) both
  land in the week; the day before/after are excluded; a mid-week anchor
  resolves to the same Sunday-start week.
- **Sort order within a day** — timed meetings ascending by time; date-but-no-
  time leads bucketed last and sorted by name; no-`visitDate` leads are not
  meetings.
- **Empty week** — zero days / total 0 with boundaries still computed (the
  empty-state trigger).
- **Dropdown default** — `managerForHouse` resolves all four house keys (by id
  and by Hebrew label), returns blank for `pardes`/`sde`/external/no-house, and
  is empty under an empty roster; `managerOptions` lists exactly the four.
- Same `node --test` + vm-sandbox load pattern as `growth-graph.test.js`.

## Not included
- **No Apps Script / backend change** — `meetingWith` and `HOUSE_MANAGERS`
  already shipped in the schema PR; this is frontend only.
- **No editing from the meetings tab** — it's a read-only view; lead edits still
  go through the leads board.
- **No Apps Script deploy** — dual deploy is handled manually after merge.
