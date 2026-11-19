# Intake-meeting reports inside the managers app + «למה לא התקיימה?» (November 19, 2026)

**Branch:** `claude/meeting-report-in-managers` → PR base `claude/build-ezone-dashboard-QOg5s`.
The ezone-managers side ships in its own PR in that repo.

## Why

A manager reported a meeting through the `/meeting-report` link instead of the app. Sandra
(19 Nov 2026): the meetings Vered schedules must also appear in the managers app, whatever
WhatsApp message the manager got; the manager reports there whether the meeting happened,
and if not, why (לא הגיעו / נדחתה / בוטלה…); if it did, its result. The report must still
reach the WhatsApp group and land in the Dashboard exactly as today.

## Plan (read-only investigation first)

- The link report lives on the lead row (`meetingReport*` columns, `submitMeetingReport_`),
  unseen for Vered (`meetingSeen` = ''), and drives the CRM follow-ups (`no_show` →
  «לברר היעדרות / ביטול»). That stays the ONE store: the app writes the same row.
- The managers app reaches the Dashboard only through `managersWork` (server to server,
  `MANAGERS_WORK_SECRET`, the caller's house decided by the managers server). New ops go there.
- `no_show` («לא הגיע / בוטל») stays the outcome key so the CRM logic is untouched; the
  reason is a NEW column next to it.

## What changed

### Apps Script — `apps-script/Code.gs`
- `LEAD_COLUMNS` appends, LAST: `meetingNotHeldReason`, `meetingProposedDate`,
  `meetingReportVia`. `meetingProposedDate` is text-forced. All three join
  `MEETING_REPORT_LEAD_FIELDS` (so `deleteMeetingReport_` clears them and a differing-timestamp
  saveAll keeps the sheet's), and `MEETING_REPORT_MANAGER_ONLY_FIELDS`: on a same-report
  saveAll the sheet's value always wins — no dashboard tab can blank a reason.
- `MEETING_NOT_HELD_KEYS` = `no_show | postponed | cancelled_family | cancelled_us | other`;
  like the companion, a value off the list is the אחר free text (≤ 100 chars, formula-guarded).
- `meetingReportNotHeldCheck_` (pure): `no_show` REQUIRES a reason; any other outcome must
  carry none; `proposedDate` only with `postponed`, a real `YYYY-MM-DD`, today or later.
  Informational only — `visitDate` is never touched; Vered reschedules.
- `submitMeetingReport_` → `submitMeetingReportVia_(report, { via, scope })`, the ONE core for
  both paths (lock, idempotency replay, read-back verify, `meetingSeen` reset, note cap):
  - `link` — unchanged reporter rule (a current house manager);
  - `app` — reporter = the authenticated caller; `scope(lead)` must accept the lead, else
    `lead_not_found` (the same answer as a missing lead — nothing about another house leaks).
  `saved` now also returns `notHeldReason`, `proposedDate`, `via` (never the note).
- `managersWork` op **`meetings`** `{ from, to }` (default today −30 … +14, max 62 days,
  `bad_range` otherwise): reportable leads with a visit in range that belong to the caller's
  house — the lead's house, OR its `meetingWith` is that house's manager on the visit date
  (`managerHouseByName_`, the intake-bonus rule). Each item:
  `{ id, name, house, houseLabel, visitDate, visitTime, meetingWith, officeNote,
  report: { outcome, notHeldReason, proposedDate, companion, note, reporter, reportedAt, via } | null }`.
  No phone, contact, billing or ID field.
- `managersWork` op **`meetingReport`** `{ leadId, outcome, notHeldReason, proposedDate,
  companion, note, submissionId }` → `submitMeetingReportVia_(…, { via: 'app' })`. One log line
  with the house + outcome/error only (never text or names).
- `capabilities` adds `'meetings'` (the managers app shows «לא מחובר» until it is there).

### Railway — `server.js`, `public/`
- `/api/meeting-report/submit` forwards `notHeldReason` and `proposedDate` (length-capped;
  Code.gs validates).
- `/meeting-report`: picking «לא הגיע / בוטל» opens «למה הפגישה לא התקיימה?» (chips +
  אחר text; «נדחתה» shows an optional «מועד חדש מוצע» date). Refused at the form without a
  reason. The confirmation and the WhatsApp group message carry
  `סיבה: <reason>[ · מועד חדש מוצע: DD/MM/YYYY]` right after «תוצאה» — a held meeting's
  message is byte-identical to before; the note-only cut and the footer rule are unchanged.
- Vered: the report block (lead card + meetings board) and the CRM «פגישות ושירותים» show
  «סיבה»; the CRM Today/follow-up rows name it. All escaped.
- SW cache v147 → v148. `scripts/healthcheck.js` column list updated.

## Security
- No new secret or Script Property; both ops sit behind the existing fail-closed
  `MANAGERS_WORK_SECRET` + POST-only gate and `mwCaller_` (house/role/actor from the managers
  server). Scope is enforced server-side inside the write lock.
- Report text is never logged or echoed in an error; responses whitelist fields.
- Free text is formula-guarded before it reaches the sheet; every render escapes.

## Tests
`test/meeting-report-in-managers.test.js` (26, incl. one real-Chromium run of the form):
schema order, capabilities, scope (lead house / own meeting elsewhere / another manager),
whitelist, bad range, fail-closed auth, the app write (reporter, via, unseen), out of scope →
nothing written, admin, every reason rule, the proposed date (past / not real / wrong reason /
optional / never moves visitDate), idempotent replay, link vs app rows identical except `via`,
the handle_ path, the saveAll guard, the delete, the label maps in sync, the WhatsApp line +
5,000-char footer, the browser flow.
Updated on purpose: the SW version pins (v148), `capabilities`, the LEAD_COLUMNS terminal
assertions (later appends now follow), the link happy path (a `no_show` now names a reason),
the payload-keys privacy pin (two new keys, '' for a held meeting).
Full suite: 4115 → 4141, all green.

## Deploy
Apps Script deploys automatically on merge (`.github/workflows/deploy-apps-script.yml`).
No Railway variable, no Script Property. Rollback: revert this PR — the new columns stay
(append-only) and are simply ignored.
