# The manager report follows the patient on admission

When a lead with a דיווח מנהל is admitted, the report is now visible on the
patient's row in תפוסה — not lost with the retired lead.

## Design (no schema change)

A reliable lead→patient link already exists: `patient.fromLead` carries the
originating lead id, written by BOTH admit paths (`openEntryModal` and
`promoteEnteredLeads`) and stored in `PATIENT_COLUMNS`. Retiring an admitted
lead only flips its stage to `'admitted'`, so the lead row — including all
six `meetingReport*` fields — stays readable in `state.leads`.

- `patientMeetingReportLead(patient, leads)` (pure): resolves `fromLead` to
  the source lead, returns it only when a report exists. Hand-entered
  patients (`fromLead` empty) and dangling links → `null`.
- `patientReportBlockHTML(patient, leads)` (pure): renders the SAME shared
  `meetingReportBlockHTML`, read-only, wrapped in a full-width `.pt-report`
  grid cell so the `.patient-row` grid keeps its columns.
- `meetingReportBlockHTML(lead, opts)` gains `opts.readOnly`: no unseen
  dot/amber tint (the cue belongs to the lead surface), no edit/delete
  regardless of mode, and an empty `data-mrv-toggle` id — the shared toggle
  wiring still expands/collapses but bails before mark-seen, so viewing a
  report from a patient row never writes.
- `renderPatients()` appends the block and wires the toggle.

Frontend-only (`public/app.js`, `public/style.css`); no `Code.gs`,
`server.js`, or sheet-schema change; read paths only — no new writes.

## Tests

`test/meeting-report-on-patient-card.test.js`: the block renders for an
admitted lead with a report; no block without a report/link; edit/delete and
the unseen cue absent on the patient card; empty toggle id; and a regression
guard that the lead-surface rendering is unchanged.
