# Meeting Report — Foundation (PR 1)

**Foundation only. ZERO behavior change. A user loading the app after this
merge sees nothing different.** No UI, no rendering, no new endpoints — schema,
constants, normalizers, label maps, and tests only. The UI ships in **PR 2**
(house-manager report form) and **PR 3** (Vered's view + mark-seen).

House managers will report what happened in a lead meeting (today reported only
in a WhatsApp group). This PR lays the data foundation.

## ⚠️ Naming deviation from the original spec

The spec called the outcome column `meetingOutcome`, but that column **already
exists** in `LEAD_COLUMNS` (meetings-board feature: keys
`entered|thinking|postponed|cancelled|not_relevant`, live UI — outcome selector,
admission auto-set, conversion stats). Appending a duplicate header would
corrupt `readSheet_`'s position-based mapping, and redefining
`MEETING_OUTCOME_LABELS` would break the live board and orphan stored values.
Per explicit user decision, the new feature uses the distinct column
**`meetingReportOutcome`** and label map **`MEETING_REPORT_OUTCOME_LABELS`**.
The existing meetings-board feature is untouched.

## What changed

### Backend — `apps-script/Code.gs`
- Appended six columns to the **END** of `LEAD_COLUMNS` (append-only — nothing
  above them reordered or inserted), in this exact order:
  `meetingReportOutcome, meetingCompanion, meetingNote, meetingReporter,
  meetingReportedAt, meetingSeen`.
- `IRRELEVANT_LEAD_COLUMNS` and `REMOVED_LEAD_COLUMNS` are **derivations**
  (`LEAD_COLUMNS.concat([...extras])`), not hardcoded copies — they inherit the
  new columns automatically with their sheet-specific extras still at the end.
  No change needed there; tests lock this in.
- **Date-coercion guard:** `meetingReportedAt` (ISO timestamp) and
  `meetingSeen` (`''`/`'1'`) added to the leads-sheet `forceColumnsText_`
  plain-text (`@`) list at sheet-ensure time, alongside
  `visitDate`/`visitTime`/`waitlistedAt` — Sheets can never coerce the ISO
  string into a Date cell or `'1'` into the number `1`. Timestamps are written
  as ISO strings and read back as strings.
- No new column-handling code needed: `getOrCreateSheet_` extends the header
  row non-destructively when the schema grows. Pre-existing rows stay blank —
  `objectToRow_` defaults missing keys to `''`; no backfill runs.

### Frontend — `public/app.js`
- Added two **frozen** label maps (defined, not yet consumed):
  `MEETING_REPORT_OUTCOME_LABELS` and `MEETING_COMPANION_LABELS`.
- Companion display rule (documented as a comment; used in later PRs): if
  `meetingCompanion` matches a key in `MEETING_COMPANION_LABELS`, show the
  label; otherwise show the raw value (free text from אחר, stored as-is —
  no `other:` prefix).
- Extended `normalizeLead` with the six fields via the existing `pickField`
  defensive pattern, defaulting to `''` — prevents silent-drop on round-trip
  writes via `upsertRowById_`. `normalizeIrrelevantLead` /
  `normalizeRemovedLead` build on `normalizeLead`'s output, so they inherit
  the fields automatically.

## Field semantics

| Column                 | Meaning                                                                                                                                         |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `meetingReportOutcome` | Stable key: `advancing` \| `undecided` \| `not_fit` \| `no_show`. Empty = no report yet.                                                         |
| `meetingCompanion`     | Stable key: `mother` \| `father` \| `parents` \| `partner` \| `sibling` \| `friend` \| `alone` \| `other`. When the value doesn't match a preset key, it holds the raw free text (from אחר) as-is. |
| `meetingNote`          | Free text — what was discussed.                                                                                                                  |
| `meetingReporter`      | House manager name (from dropdown).                                                                                                              |
| `meetingReportedAt`    | ISO timestamp **string** (plain text, NOT a Sheets date — column text-forced `@`).                                                               |
| `meetingSeen`          | `''` or `'1'` — Vered's mark-seen flag, used in PR 3. Text-forced so `'1'` stays a string.                                                       |

### Outcome labels (he)

| key         | label                    |
| ----------- | ------------------------ |
| `advancing` | התקיימה — מתקדם לכניסה |
| `undecided` | התקיימה — מתלבט         |
| `not_fit`   | התקיימה — לא מתאים      |
| `no_show`   | לא הגיע / בוטל           |

## Tests — `test/meeting-report-foundation.test.js`
`node --test`, vm-sandbox pattern (matches the existing suite, not Jest):
- `LEAD_COLUMNS` ends with the six new columns in the exact order above; each
  appears exactly once; the pre-existing `meetingOutcome` is untouched.
- `IRRELEVANT_LEAD_COLUMNS` / `REMOVED_LEAD_COLUMNS` start with the full
  `LEAD_COLUMNS` and retain their extras at the end.
- `normalizeLead` round-trips a lead containing all six fields without dropping
  any, and defaults missing meeting fields to present-but-blank `''`.
- Both label maps contain exactly the expected keys/labels.
- `meetingReportedAt` + `meetingSeen` are in the leads-sheet plain-text force
  list (source assertion — the ensure path needs `SpreadsheetApp`).

Full suite: `node --test` — all pass, zero regressions.

## Deploy
- `Code.gs` deploys via the clasp CI on merge to
  `claude/build-ezone-dashboard-QOg5s`; frontend via Railway auto-deploy on the
  same branch. No manual steps.
- Post-merge verification: live app → DevTools → Network →
  `sheets?action=getData` → lead objects should contain the six new fields
  (blank on all pre-existing leads).
