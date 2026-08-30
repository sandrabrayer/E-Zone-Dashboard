# Meeting Report — Vered's View (PR 3)

Vered now sees the house managers' meeting reports **where she already works** —
on the meetings board and the lead card — with an unseen cue and a tab badge so
new reports can't slip past her. Completes the series: PR 1 (#90 schema),
PR 2 (#91 manager form). **The manager form (`/meeting-report`) and its
endpoints are unchanged**, and no schema changed (`scripts/healthcheck.js`
untouched).

## What Vered sees

- **דיווח מנהל block** — wherever a lead renders on the meetings board (its
  weekly row) and on the kanban lead card, a lead with `meetingReportedAt` set
  shows a collapsed report block: the outcome label
  (`MEETING_REPORT_OUTCOME_LABELS`) in the header; expanding reveals
  **הגיע/ה עם** (preset key → `MEETING_COMPANION_LABELS` label, otherwise the
  manager's raw free text, escaped), the report note (escaped), the reporter's
  name, and the report timestamp (`DD/MM/YYYY HH:MM`, local).
- **Visually distinct on purpose**: the block uses a purple accent (amber while
  unseen) and is read-only — Vered's own `meetingOutcome` selector (primary
  blue) stays the authoritative outcome; the manager report is upstream
  context, never her outcome.
- **Unseen cue**: a lead is *unseen* when `meetingReportedAt` is non-empty AND
  `meetingSeen !== '1'` — amber dot + tint on the block.
- **Tab badge**: the לוח פגישות tab shows the count of unseen reports (hidden
  at zero), refreshed on every render and on every mark-seen.

## Unseen / mark-seen lifecycle

1. A manager submits a report → PR 2's `submitMeetingReport` stamps the report
   fields and sets `meetingSeen=''` → the lead is **unseen** (dot + badge).
2. Vered expands the block (edit mode) → **optimistic mark-seen**: the cue and
   badge clear immediately, `meetingSeen='1'` is written through the existing
   authenticated main-app path (`updateLead → saveAll` — the same
   optimistic-save + rollback pattern as every lead-card inline field; **not**
   the `MEETING_REPORT_SECRET` endpoints, which are the managers' surface). A
   failed save rolls the lead back and re-renders, restoring the cue.
3. **A manager resubmission resets `meetingSeen` to `''`** (shipped in #91) —
   the cue and badge **reappear** for the updated report. By design: an updated
   report is news again.

Viewers (non-edit mode) can expand and read a report but never write —
`saveAll` no-ops for them, so mark-seen is edit-gated like the outcome
selector.

## Why no backend change

`state.leads` carries every lead field (PR 1's `normalizeLead` pass-through)
and `mergeLeads_` writes the full client row, so `updateLead(id,
{meetingSeen:'1'})` **preserves the whole row** — no field drop, no new Apps
Script action needed. `Code.gs` is untouched by this PR.

## What changed

- **`public/app.js`** — pure helpers `meetingReportUnseen`,
  `countUnseenMeetingReports`, `meetingReportCompanionDisplay`,
  `meetingReportWhenText`, `meetingReportBlockHTML`; `markMeetingReportSeen`
  (optimistic, edit-gated, unseen-gated); `renderMeetingsUnseenBadge`;
  `wireMeetingReportToggle` (expand/collapse + mark-seen on first open,
  cue cleared in place so the opened detail never collapses).
  `meetingsForWeek` meeting objects now carry the six report fields;
  `meetingRowHTML` appends the block under its row; `buildLeadCard` renders it
  after the note line and wires the toggle; `renderMeetings` wires board
  toggles and refreshes the badge.
- **`public/index.html`** — `#meetings-unseen-badge` span inside the לוח
  פגישות tab.
- **`public/style.css`** — `.mrv-report` block styles (purple accent, amber
  unseen state, collapsed detail, chevron) + `.tab-badge`.

## Tests — `test/meeting-report-vered-view.test.js`

`node --test`, vm-sandbox, driving the real shipped functions with `saveAll`
stubbed to capture the persisted snapshot:
- unseen predicate (no report / unseen / seen / resubmission-reset);
- count + tab badge (0 hidden, N shown);
- companion display rule + HTML escaping of free text and notes;
- block renders only with `meetingReportedAt`; unseen dot only while unseen;
- board bucketing carries the report fields;
- mark-seen: one save, `meetingSeen='1'`, **whole row preserved** in the
  persisted payload; optimistic (badge clears before the save resolves);
  rollback on failure; no-ops for viewers / seen reports / unknown leads.

Full suite green, zero regressions.
