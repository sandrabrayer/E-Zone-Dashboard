# Lead card — inline meetingWith select

Adds an inline **נפגש עם** (meetingWith) `<select>` to the lead card, next to the
`visitDate`/`visitTime` inputs (visit stage). Vered can set the manager straight
from the board without opening the edit modal. Builds on the merged
`meetingWith` / `HOUSE_MANAGERS` groundwork.

## What changed

### `public/app.js`
- **`meetingWithSelectHTML(lead, managers)`** (new) — renders the inline
  `<select>`:
  - Options come from the roster (`state.houseManagers` by default; injectable
    for tests) — **no hardcoded names**: a blank `— ללא —` option plus every
    manager from `managerOptions`.
  - Carries **`data-field="meetingWith"`**, so `buildLeadCard`'s existing generic
    `[data-field]` handler wires its `onchange` to
    `updateLead(lead.id, { meetingWith: value })` — the **same single-field save
    path** (optimistic update → `saveAll` → rollback on failure) the
    `visitDate`/`visitTime` inputs already use. No new save code.
  - Pre-selects the lead's existing `meetingWith`, or — when empty — the manager
    of the lead's house (blank for pardes/sde/external). Rendering it selected
    does **not** save; the value only persists when the user changes the select,
    matching the other inline fields.
- **`buildLeadCard`** — the visit-stage `.lc-fields` block now renders the select
  after the date/time inputs.

### `public/style.css`
- `.lead-card .lc-fields .lc-meeting-with` — matches the inline inputs' box and
  takes the full row width so the manager name isn't cramped.

### Tests — `test/lead-card-meetingwith.test.js`
- The select renders the blank option plus every manager from the roster (and
  falls back to `state.houseManagers` when no roster is passed).
- It carries `data-field="meetingWith"` (rides the single-field save path).
- The house→manager default resolves for all four keys (by id and Hebrew label)
  and is blank for pardes/sde/external/none; an existing `meetingWith` is
  preselected over the house default.
- A `meetingWith` change persists through the real `updateLead → saveAll`
  (stubbed `saveAll`), applied optimistically and leaving other lead fields
  untouched — the same path a date/time change uses.
- Same `node --test` + vm-sandbox pattern as `meetings-board.test.js`.

## Not included
- **No reactive house→manager sync** — the card has no house selector (house is
  fixed per lead), so the add-modal's dirty-flag autofill isn't needed; the card
  just defaults at render time and saves on change.
- **No backend / Apps Script change** — `meetingWith` already in `LEAD_COLUMNS`
  and persisted by the existing lead save path.
