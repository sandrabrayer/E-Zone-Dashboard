# Meetings board re-render — a visit change shows at once, tab entry always re-renders

October 9, 2026. Follow-up to `CHANGELOG-meetings-board-fixes.md` (PR #210),
which fixed how a visit DATE is read. On devices set to Israel time that fix
changes nothing, so the board's missing visits had to come from WHEN the board
renders, not from the date itself. **Railway only** (`public/app.js`,
`public/sw.js`). Code.gs not touched. No column, sheet, Script Property or
env var. SW `CACHE_VERSION` v54 → **v55** (live was v54, no open PR; v17
stays burned).

## Every path that changes a lead's visit, and whether the board followed

Line numbers are in `public/app.js` before this change (base 38247ce).

| Path | Board re-rendered? |
| --- | --- |
| Inline card date / time / «נפגש עם» (`:5038` → `updateLead` `:5169`) | **No.** Not on the optimistic write and not after the save was confirmed. Only a failed save re-rendered (`renderAll` in the rollback). |
| Inline field changed again while its save was in flight (`withFieldSaving` `:6326`) | **No, and the change was lost.** The busy guard dropped it. In a desktop date input every keystroke that completes a date fires `change` (11/10/0002 → …/0020 → …/2026). The first save carried an intermediate year, and the later values were never saved. The card showed 2026, but the lead, the sheet and the board kept 0002, so the visit never appeared in week 11/10–17/10. Reproduced on the old code. |
| Entering the «לוח פגישות» tab (`initTabs` `:1749`) | Only via `renderAll` (`:4096`), where `renderMeetings` is the 5th call (`:4107`), after `renderDashboard`, `renderCoordinatorDischarges`, `renderKanban` and `renderPatientsTab`. A throw in any of them left the board showing old data. |
| Visible week (`renderMeetings` `:3902`) | Set once, on the first render. A page or PWA left open across Saturday night kept showing last week on entry, even when the user had never navigated. |
| Lead ✏️ edit modal (`openEditLeadModal`) | Yes. `renderAll` runs on the optimistic write and on rollback. |
| Stage move to «ביקור נקבע» (`moveLead`) | Yes. `renderAll` runs on the optimistic write and on rollback. |
| Board ✏️ edit modal (`openMeetingEditModal`) | Yes. `renderMeetings` runs after the save, and rollback goes through `renderAll`. |
| Background `getData` refresh / resync (`loadAll`) | Yes. `renderAll` runs after every load; a discarded stale answer leaves state unchanged. |
| «נפגש עם» default autosave | Yes. `renderMeetings` runs on fill and on revert. |

## Fix (`public/app.js`)

- **`updateLead`** re-renders the board when the update touches a board field
  (`MEETINGS_BOARD_FIELDS`: visitDate, visitTime, meetingWith, name, house,
  stage):
  - at once, optimistically;
  - again after the sheet proves the save;
  - on failure, the existing `renderAll` rollback takes it off again.

  The re-render is board-only, so the card being edited is not rebuilt under
  the user. `refreshMeetingsBoard()` catches render errors, so a board problem
  can never turn a saved lead into a «failed» one or trigger a rollback.
- **`saveInlineLeadField`** replaces the inline `onchange`. When a save
  finishes and the field already holds a newer value, that value is saved too.
  One save runs at a time, the last value wins, and a failed save is not
  retried (it rolled back and re-rendered the card).
- **Tab entry:** `enterMeetingsTab()` runs before `renderAll`, so the board is
  rendered first and on its own. Unless the user navigated with «שבוע קודם» /
  «שבוע הבא» (`state.meetingsWeekPinned`; «השבוע» clears it), it re-anchors
  on today's week.
- **Tab badge:** `renderMeetingsUnseenBadge` already runs at the end of every
  board render, so every refresh above keeps the badge in step with the same
  `state.leads`.

## Tests

`test/meetings-board-rerender.test.js` has 14 tests. They run the real
`updateLead`, `initTabs`, `renderAll` and `renderMeetings`, with the network
and the other renderers stubbed:
- **A (inline fields):**
  - the visit shows before the save answers and stays after it;
  - a time / «נפגש עם» change re-renders the row;
  - moving the visit to another week moves it on the board;
  - a failed save takes it off again;
  - a non-board field does not re-render;
  - a board render error keeps the save.
- **B (tab entry):**
  - the board renders even when `renderKanban` throws;
  - it renders from the current leads.
- **C (week):**
  - a stale auto-chosen week re-anchors on today's week;
  - a navigated week is kept;
  - «השבוע» unpins it.
- **D (changes during a save):**
  - typing a date ends on the last value in the lead, the sheet payload and
    the board;
  - one change saves exactly once;
  - a failure is not retried.
- **E (badge):** the badge follows the board refresh.

On the pre-fix `app.js` the new file fails 14/14: all of its tests call
helpers this change adds. The two key behaviors (A: no board render, D: a lost
change) were also reproduced on the old code directly.

`test/dashboard-perf-assets.test.js`: SW version pin v54 → v55.

Full suite: 2635 / 2635. `npm audit`: 0 high / critical (1 moderate,
pre-existing).
