# Meeting Outcome — Foundation

**Foundation only. ZERO user-facing change. No UI in this PR — the UI arrives in the next PR.**

This change adds the schema plumbing for a new `meetingOutcome` lead field so a
later PR can render and edit it. The field flows through save/load untouched;
nothing new is displayed, selected, or persisted by user action yet.

## What changed

### Backend — `apps-script/Code.gs`
- Appended `meetingOutcome` to the **end** of `LEAD_COLUMNS` (append-only —
  nothing above it reordered or inserted). `readSheet_` maps cells to keys by
  position, so the append-last contract keeps existing reads correct.
- No new column-handling code was needed: `getOrCreateSheet_` already extends
  the header row non-destructively when the schema grows (`lastCol < headers.length`),
  exactly as it did when `meetingWith` was added. Pre-existing rows have no
  value and stay blank — `objectToRow_` defaults missing keys to `''`, and no
  backfill runs.
- No new endpoints, no behavior change.

### Frontend — `public/app.js`
- Added `meetingOutcome` to `normalizeLead` via the same `pickField` defensive
  pattern as the other fields (aliases: `meetingOutcome`, `meeting_outcome`,
  `תוצאת פגישה`; default `''`). This prevents the field from being silently
  dropped on a getData round-trip.
- Added `MEETING_OUTCOME_LABELS` — a render-time label map with stable keys
  (mirrors the `DISPOSITION_LABELS` precedent). Stable keys persist; Hebrew
  labels are display-only so a future label rename never invalidates stored rows:

  | key            | label (he)      |
  | -------------- | --------------- |
  | `not_relevant` | לא רלוונטי       |
  | `thinking`     | חושבים על זה     |
  | `entered`      | נכנסים לטיפול    |
  | `postponed`    | נדחה            |
  | `cancelled`    | התבטל           |

- **No UI.** No rendering changes, no selectors, no board changes. The map is
  defined but not yet consumed.

## Tests — `test/meeting-outcome-foundation.test.js`
Uses the existing `node:test` + vm-sandbox pattern (not Jest):
- `LEAD_COLUMNS` appends `meetingOutcome` last, immediately after `meetingWith`.
- `normalizeLead` preserves `meetingOutcome` when present and defaults it to
  present-but-blank `''` when absent (legacy rows, no backfill).
- `normalizeLead` does not silently drop `meetingOutcome` on a round-trip.
- `MEETING_OUTCOME_LABELS` contains exactly the five keys above.

The existing `test/lead-meetingwith-schema.test.js` asserted `meetingWith` was
the *terminal* column; that snapshot assertion is inherent to an append-only
schema and was updated to assert `meetingWith`'s position *relative to*
`assignedTo` instead. Its real contract (append-only, order-through-assignedTo
unchanged) is unchanged.

Full suite: `npm test` — all pass, zero regressions.

## Deploy
- `Code.gs` changes deploy via the clasp CI on merge
  (deployment ID `AKfycbx85qRq2lA_tenySLTLc6JoZHQA1zQYEdj4cesniPHcPQfY4SQ27-F-G_6bf08gsHw`).
  No manual Apps Script steps.
- Post-merge verification: live app → DevTools → Network →
  `sheets?action=getData` → the response should contain `meetingOutcome` on
  lead objects (blank on pre-existing leads).
