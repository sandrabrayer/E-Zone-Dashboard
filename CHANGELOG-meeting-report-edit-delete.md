# Meeting report — edit / delete for Vered (PR 4)

Frontend-only follow-up to the meeting-report series (#90 foundation, #91
manager form, #92 Vered's read-only view). Gives Vered a way to correct or
remove a manager's report — e.g. test/junk reports or manager typos — from the
expanded דיווח מנהל block on the meetings board and the lead card.
`apps-script/Code.gs` and `server.js` are untouched; everything writes through
the existing authenticated `updateLead → saveAll` path (full row preserved,
optimistic UI + rollback), so this deploys via Railway alone.

## The two actions

Both appear inside the expanded דיווח מנהל block, and only in **edit mode** —
the exact same gating as #92's mark-seen (viewers never see them and never
write).

- **עריכה** — opens a modal pre-filled with the current report:
  - תוצאה — the 4 options from `MEETING_REPORT_OUTCOME_LABELS`, current one
    selected;
  - מי הגיע איתו — the preset chips from `MEETING_COMPANION_LABELS` incl.
    אחר with a free-text input. A stored value that isn't a preset key opens
    with אחר selected and the raw text populated;
  - פירוט — textarea with the current note.

  Save is optimistic with rollback, updates the displayed block in place, and
  is guarded against double-fire (the modal's submitting-flag discipline, the
  in-form equivalent of `withBusyButton`).

- **מחיקת דיווח** — `showConfirm` first (danger styling, clear Hebrew warning
  that the manager's report will be removed from the lead). On confirm all six
  report fields (`meetingReportOutcome`, `meetingCompanion`, `meetingNote`,
  `meetingReporter`, `meetingReportedAt`, `meetingSeen`) are cleared to `''`
  in one optimistic write. The block disappears and the unseen dot / tab badge
  recompute immediately — a deleted report can never count as unseen.

## Attribution is preserved on edit

Editing rewrites **content only** (outcome / companion / note).
`meetingReporter`, `meetingReportedAt` and `meetingSeen` are never touched by
an edit — the report keeps its original attribution and timestamp. Vered is
correcting what was reported, not re-reporting.

## Managers' correction path is unchanged

Managers still correct their own reports by resubmitting from
`/meeting-report` — resubmit remains overwrite (#91), which also resets
`meetingSeen` so the unseen cue returns. This PR adds no manager-side UI.

## Validation

Client-side mirror of #91's submit constraints (`submitMeetingReport_` caps in
Code.gs): outcome must be one of the 4 report keys, companion free text ≤ 100
chars, note ≤ 2000 chars. All rendered values are escaped via `escapeHtml`,
exactly as the existing block does.

## Tests

`test/meeting-report-edit-delete.test.js` (node --test, vm-sandbox on the real
`public/app.js`, same harness as #92): modal pre-fill for preset and free-text
companions, edit persistence + attribution/whole-row preservation, delete
clearing exactly the six fields with badge recompute, rollback on failed save
for both actions, the validation caps, and edit-mode-only rendering of the
action buttons.
