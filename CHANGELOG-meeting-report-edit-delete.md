# Meeting report — edit / delete for Vered + prominent report block (PR 4)

Follow-up to the meeting-report series (#90 foundation, #91 manager form, #92
Vered's read-only view, **#94 write-clobber guard**, #95 picker dates). Gives
Vered a way to correct or remove a manager's report — e.g. test/junk reports
or manager typos — from the expanded דיווח מנהל block on the meetings board
and the lead card, and makes that block visually unmissable.

**No longer frontend-only.** The first version of this PR predated #94's merge
guard and cleared the report client-side through `saveAll` — which the guard
now (correctly) treats as a stale echo and reverts. Delete is therefore a
dedicated Apps Script action, so this PR touches `apps-script/Code.gs` and
deploys via clasp CI on merge (like #94). `server.js` is untouched — the new
action rides the existing session-authed `/api/sheets` proxy.

## The guard-compatible delete (מחיקת דיווח)

`updateLead → saveAll` with the six fields cleared **cannot delete anymore**:
the merge guard sees the sheet's non-empty `meetingReportedAt` beat the
incoming empty one and resurrects the report — delete would silently no-op.

Instead:

- **`deleteMeetingReport`** (Code.gs) — a dashboard action dispatched like
  `saveAll`/`removeLead` (the session-authed proxy is the trust boundary; no
  manager-form secret). Validates `leadId`, clears the six report fields
  directly on the sheet row (read-merge-write via `upsertRowById_`, whole row
  preserved), verifies the write landed (mirroring `submitMeetingReport_`'s
  read-back), idempotent on a report-less lead.
- The frontend (`showConfirm` unchanged) calls the action, clears the **local**
  copy too — so this tab's next `saveAll` echoes the deletion (equal empty
  timestamps → guard inert) — and recomputes the unseen dot / tab badge
  optimistically; failure rolls the local fields and badge back.

### The guard is tightened so deletion STICKS

#94 shipped: sheet wins when its report timestamp is strictly newer. That
left one resurrection hole — a *different* stale tab still holding the old
report could rewrite it onto the now-empty row (empty sheet timestamp → guard
inert). Since reports are only ever created by `submitMeetingReport_` and
removed by `deleteMeetingReport_` (both bypass `mergeLeads_`), a `saveAll`
whose report timestamp **differs at all** from the sheet's is a stale echo by
definition. The guard now enforces exactly that: **the client's six report
fields are accepted only when its `meetingReportedAt` equals the sheet's**
(content edit / mark-seen); on any mismatch — older, newer, or empty on either
side — the sheet wins. (#94's untested "client restores lost sheet data"
branch is deliberately dropped.)

## Edit (עריכה) — verified guard-compatible + race handling

Edit rewrites content only (outcome / companion / note); `meetingReporter`,
`meetingReportedAt`, `meetingSeen` are untouched — and the unchanged timestamp
is exactly what lets the edit through the guard (equal timestamps → the
client's content wins). A regression test proves the round-trip through the
real `mergeLeads_` post-guard.

**The race:** a manager resubmits (or another tab deletes) after Vered opened
the modal → her save carries a timestamp that no longer matches the sheet's →
the guard keeps the sheet's state and her edit is discarded. That is no longer
silent: `mergeLeads_` reports every lead whose report fields the guard kept
from the sheet (`reportConflicts` in the `saveAll` response), and the edit
flow checks its own leadId there — on a conflict Vered sees a clear Hebrew
message (דיווח המנהל השתנה בזמן העריכה — העריכה לא נשמרה) and the data
refreshes via `loadAll` to show the newer report. Routine stale-echo flags for
*other* leads are ignored (that's the guard doing its job).

## Prominence — Sandra's live feedback

The דיווח מנהל block no longer reads as a footnote:

- The **outcome is the headline**: a large color-coded badge —
  `advancing` green (`--success`), `undecided` amber (`--warning`),
  `not_fit` red (`--danger`), `no_show` / unknown gray — 14px/800 in a pill.
- The container is a proper card: heavier accent border (5px purple
  inline-start), stronger background tint, more padding, 14px base type.
- The seen/unseen distinction is scaled up: unseen swaps the accent to amber,
  tints the whole card, adds an outer ring and a bigger glowing dot.
- Same block HTML serves the meetings board and the lead card; RTL and
  `escapeHtml` intact; the head row flex-wraps so nothing overflows on
  mobile; the edit/delete buttons stay on the upgraded block (edit-mode
  gating unchanged).

## Managers' correction path is unchanged

Managers still correct their own reports by resubmitting from
`/meeting-report` — resubmit remains overwrite (#91), which also resets
`meetingSeen` so the unseen cue returns. This PR adds no manager-side UI.

## Validation

Client-side mirror of #91's submit constraints (`submitMeetingReport_` caps in
Code.gs): outcome must be one of the 4 report keys, companion free text ≤ 100
chars, note ≤ 2000 chars. All rendered values are escaped via `escapeHtml`.

## Tests

- `test/meeting-report-edit-delete.test.js` (vm-sandbox on the real `app.js`):
  modal pre-fill, edit persistence + attribution/whole-row preservation, the
  new delete path (dedicated action called, **no** `saveAll`, local fields
  cleared, badge recompute, rollback on failure), the resubmit-during-edit
  conflict (message + refresh, other-lead flags ignored), the badge color
  mapping, validation caps, edit-mode-only gating.
- `test/meeting-report-guard-compat.test.js` (vm-sandbox on the real
  `Code.gs`): an edit round-trips through `mergeLeads_` post-guard; the
  dedicated delete clears exactly six fields and verifies the write; **a
  stale tab cannot resurrect a deleted report** (and the echo is flagged);
  the deleting tab's own echo is inert; a raced older-timestamp edit loses to
  the newer report AND is flagged in `reportConflicts`; manager submit
  end-to-end sanity.
