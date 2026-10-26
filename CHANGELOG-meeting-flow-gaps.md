# Meeting-flow gaps — admitted-lead reports, visits past month end, reporters from the Managers tab (October 26, 2026)

Three gaps in the flow «Vered schedules a meeting → the house manager sees it in
ezone-managers → the manager reports on `/meeting-report` → the report shows on
the «לוח פגישות» board». Code.gs + `server.js` + the meeting-report page. No new
route, no new action, no new secret or Script Property, no sheet column.

## Fix 1 — a report on an already-admitted lead

**Before:** `submitMeetingReport_` looked the lead up in `openLeads_()` only. When
Vered admitted the lead before the manager reported, the report failed with
`lead_not_found`, and the picker no longer listed the lead.

**Trace:** an admitted lead stays on the **Leads** sheet; only its `stage` flips to
`admitted` (admit modal, `promoteEnteredLeads`, the direct-add `dl-` leads). Closed
leads move to «לידים לא רלוונטיים» and removed ones to «לידים שהוסרו».

**Now** (`isReportableLead_` / `reportableLeads_`, one rule for the picker and the
write):
- an open lead — as before;
- an admitted lead (`admitted` / `נקלט` / `אושפז`) whose `visitDate` is within the
  last 14 days (`MEETING_REPORT_ADMITTED_DAYS`, today − 14 … today);
- anything else — closed, removed, an `irrelevant` stage left on Leads, an admitted
  lead with an old, missing or future visit (so a direct-add lead with no meeting is
  never offered) → `lead_not_found`, nothing written.

The report lands on the same Leads row, in the same five columns
(`meetingReportOutcome`, `meetingCompanion`, `meetingNote`, `meetingReporter`,
`meetingReportedAt`), and still clears `meetingSeen`. The Dashboard already shows
reports for admitted leads on the meetings board (the row is about the meeting) and
counts them in the tab badge. The bonus readers (`computeIntakeMeetingsByHouse_`,
`readLeadMeetingManagers_`) are untouched (test-asserted).

## Fix 2 — visits cut at the month boundary

**Before:** `managersWork` `houseData.visits` took `visitDate` inside the selected
month only. ezone-managers' «ביקורים קרובים» missed meetings early next month, and
«ביקורים השבוע» was cut at month end.

**Now:**
- For the **current** month (today's month in Israel) the window also includes
  today … today + 14 days (`MW_VISITS_AHEAD_DAYS`), across a month or year end.
- A past or future month keeps the month-only window.
- House filter and sort order are unchanged.
- One row per lead id (Leads first, then the irrelevant / removed tabs). Rows
  without an id are kept.
- Each item gets ONE additive key, `inSelectedMonth` (`true` for the selected
  month's own rows, `false` for the look-ahead rows). Existing keys
  (`date, time, name, meetingWith, outcome`) are unchanged.

### ezone-managers impact (read-only check of `main` @ `2f8ecd5`, `public/work.js`)

| Use | Line | After this PR |
|---|---|---|
| «ביקורים קרובים» (next 5 from today) | `work.js:658, 684-688` | **fixed** — now sees next-month meetings |
| «ביקורים השבוע» tile (filters by week) | `work.js:657, 670` | **fixed** — no longer cut at month end |
| «ביקורים החודש» tile — `visits.length` | `work.js:672` | **over-counts**: includes the look-ahead rows |
| «מטופלים» → «ביקורים וקליטות החודש» — `visits.length` + the list | `work.js:419-427` | **over-counts / lists** next-month rows |

So the two month counters **would** now wrongly include next-month rows (only in the
current month, only for meetings already booked in the next 14 days). That is why
`inSelectedMonth` exists. **Follow-up in ezone-managers (not in this PR):** filter
those two places with `v.inSelectedMonth !== false`. That keeps older payloads
(without the key) counting as before.

## Fix 3 — reporter list from the Managers tab

**Before:** `public/meeting-report.js` had a hardcoded `MEETING_REPORTERS` map
(asher = «שחר/אורן», pardes = «חן»). It disagreed with the Managers tab and with
`HOUSE_MANAGERS`, and the backend accepted any name.

**Now:**
- `meetingReportLeads_` adds `managers: [{ house, name }]` and `managersSource`
  (additive). The source is `meetingReportManagers_` → `currentManagers_` (Managers
  tab → bonusconfig → HOUSE_MANAGERS).
- When the Managers tab names nobody current, the list falls back to
  `HOUSE_MANAGERS` — the houseManagers source, never the old page list.
- `server.js` `/api/meeting-report/leads` passes `managers` through its own
  whitelist (`meetingReportManagersWhitelist`): `{ house, name }` strings only,
  ≤ 100 characters each, at most 50 entries.
- The page renders the מדווח/ת choices from that field (`mrReporterNames`,
  `mrReporterOptionsHtml`, every name escaped). A re-render keeps the picked name if
  it is still listed.
- If the field is missing (an older backend) or the fetch fails, the picker shows
  «רשימת המנהלים לא נטענה — רעננו את הדף» — never a hardcoded name.
- `submitMeetingReport_` refuses a reporter who is not on that same list:
  `reporter_not_manager`, «המדווח/ת אינו/ה ברשימת מנהלי הבתים הנוכחיים — נא לבחור שם
  מהרשימה». The name is never echoed back. The page maps the code to Hebrew text.
- The PIN model is unchanged.

## Security

- No new route, action, secret or Script Property; nothing secret in code or logs.
- Server-side validation:
  - `leadId` is refused (`bad_lead`) over 100 characters or with a control
    character;
  - outcome, companion, note and reporter limits are unchanged;
  - the reporter must be a current manager.
- Formula neutralization (the `leadCellText_` rule): `meetingCompanion` and
  `meetingNote` are stored without a leading `= + - @`. The companion is one line.
  The note keeps line breaks and tabs, and other control characters are flattened.
  Nothing is truncated (over the cap is still refused).
- `managers` names are cleaned server-side (`leadCellText_`, ≤ 100), whitelisted by
  `server.js`, and escaped on the page.

## Service worker

`meeting-report.js` changed → `CACHE_VERSION` **v89 → v90**. Live `/sw.js` read
v89 on 26/10/2026 (v17 never reused). Version pins updated in
`test/dashboard-perf-assets.test.js` and `test/ortal-billing-ui.test.js`.

## Tests

- New `test/meeting-flow-gaps.test.js` (15 tests, real Code.gs in the vm sandbox +
  the server whitelist):
  - **Fix 1:** an admitted lead with a recent meeting is accepted (5 columns,
    `meetingSeen` cleared, row kept); the day-14 / day-15 window; no visit and
    future visit refused; the Hebrew stage label accepted; closed and removed leads
    refused with no sheet changed; the picker list; the bonus readers untouched.
  - **Fix 2:** the look-ahead rows with `inSelectedMonth:false`; the exact item
    shape; a past month and the current month; the year end; de-duplication.
  - **Fix 3:** current managers from the tab (former / future excluded); the
    fallback for no tab and for nobody current; non-manager names refused in Hebrew
    and not echoed; a tab-only name accepted; leadId limits; formula lead-ins
    stripped.
- `test/meeting-report-form.test.js`: the hardcoded map is gone; name list
  extraction; options markup and escaping; the not-loaded state; wiring on success
  and failure; the new error text.
- Report fixtures in older tests now use real manager names (`יעל` / `שירן` / `דנה`
  → `אורן` / `חנן` / `רנטה`), because the backend now refuses other names.
- Mutation check: removing the look-ahead, the admitted rule, the reporter check or
  the de-duplication fails 3 / 3 / 2 / 1 tests.

## Deploy

Code.gs ships through the clasp CI on merge (`deploy-apps-script.yml`). Never paste
Code.gs manually and never create a new deployment. Railway auto-deploys
`server.js` + `public/`. No Railway variable, no Script Property.

Until both halves are live, a cached v89 page that sends a name outside the Managers
tab (e.g. «שחר/אורן») is refused with the Hebrew message. The v90 page reloads the
list on its next load.
