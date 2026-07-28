# Persist the meetingWith house default (autosave)

Fixes a gap in the inline meetingWith select (PR #56): the lead card renders a
house-derived default, but it only persisted on user **change**. A visit-stage
lead whose default was already correct never saved — `meetingWith` stayed `''`
and the meetings board showed **—**. This backfills those once.

## The bug

`meetingWithSelectHTML` pre-selects `lead.meetingWith || managerForHouse(lead.house)`,
but `lead.meetingWith` in state stays `''` until the `[data-field]` `onchange`
fires. `meetingsForWeek` reads `lead.meetingWith`, so the board (and the WhatsApp
button) fell back to `—` / disabled for leads that never got touched.

## The fix — `public/app.js`

- **`leadsNeedingMeetingWithDefault(leads, roster)`** (new, pure) — the
  visit-stage leads with empty `meetingWith` whose house resolves to a manager.
  Excludes leads that already have a value, blank-resolving houses
  (pardes/sde/external/none), and non-visit stages (where the select isn't
  rendered).
- **`autosaveMeetingWithDefaults()`** (new) — assigns the house default to every
  qualifying lead in one pass and persists with a **single `saveAll`** (the same
  persistence `updateLead` relies on), so many cards rendering at once is one
  save, not a storm. Guards:
  - **Edit mode only** — `saveAll` no-ops for viewers, and we skip the in-memory
    churn too, so viewers never write.
  - **Re-entry** — a module-level `_autosaveMeetingWithBusy` flag. `renderAll`
    calls this, and `updateLead`'s failure path re-renders (`renderAll`), which
    would otherwise re-enter; while a save is in flight, further calls are
    no-ops.
  - **Idempotent** — once a lead's `meetingWith` is set it no longer qualifies,
    so a successful save never re-triggers and a later re-render doesn't re-save.
  - **Failure rollback** — resets the in-memory assignments to `''` (no phantom
    values, nothing persisted) and refreshes **only** the board
    (`renderMeetings`), never `renderKanban` / `renderAll` — so a failed save
    can't loop.
  Returns the save promise so callers/tests can await; `renderAll` fires it and
  forgets.
- **`renderAll`** calls `autosaveMeetingWithDefaults()` as its last step.

Because the assignment lands in `state.leads` before the batched `saveAll`, the
board updates immediately (— → manager name); the write persists it so the value
survives reload.

## Tests — `test/meetingwith-autosave.test.js`

- Empty + resolving house backfills and saves **once**; many qualifying leads are
  **one** batched save, not a storm; the default resolves by id and Hebrew label.
- An existing `meetingWith` is left untouched and triggers **no** save.
- Blank-resolving houses (pardes/sde/external/none) and non-visit stages save
  **nothing**.
- A second autosave after a successful backfill does **not** save again
  (idempotent) — the "re-render after save" case.
- On save failure the value **rolls back** to empty.
- Viewer mode neither backfills nor saves.
- The pure selector picks only qualifying visit-stage leads.
- Same `node --test` + vm-sandbox pattern as `lead-card-meetingwith.test.js`.

## Not included
- **No backend / Apps Script change** — `meetingWith` already persists through
  the existing `saveAll` path.
