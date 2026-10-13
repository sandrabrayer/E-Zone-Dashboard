# Intake-meeting bonus — Managers feed (October 13, 2026)

**What**: `managersOverview_` and `managersHouse_` now carry, per Managers
house and per month of **admission**, one more field — appended LAST:

```
intakeMeetings: { confirmed, pending, items: [{ date, name, house, status }] }
```

An admission counts for the house whose manager **held the intake meeting**
when ALL of these hold:

1. The Patients row links to its lead (`fromLead`) and that lead has a
   `meetingWith` (looked up in Leads, then the irrelevant / removed tabs).
2. The `meetingWith` name matches a Managers-tab row **active on the admission
   date**; that row's `house` gets the credit (it may differ from the admitted
   house — `items[].house` reports the admitted house). Two managers with the
   same name are disambiguated by date. No match → not counted.
3. The patient was the admitted house's **7th patient or later**: at least 6
   other patients were present on the admission day (entered earlier and had
   not left before that day; a patient leaving ON that day still counts as
   present), plus same-day admissions sitting above the row in the Patients
   sheet.
4. Stay of **30+ days**: `confirmed` = discharged after ≥ 30 days, or still in
   the house ≥ 30 days after entry; `pending` = still in the house, < 30 days
   so far (it confirms later — the admission month's count can grow until
   then); discharged before 30 days → not counted.

**Why**: Sandra's new manager bonus (13 Oct 2026): 250 ₪ per intake meeting
the manager held that closed into an admission of at least a month, once the
house has 6 patients. The **amount and the effective month (Oct 2026) live in
the Managers app** (`lib/bonus-eligibility.js`); this feed supplies raw facts
only, consistent with the "backend supplies raw data" rule.

**Code** (`apps-script/Code.gs`):
- `readPatientsForBonus_` also returns `fromLead` and `rowIndex` (additive).
- New: `INTAKE_MIN_PRIOR_PATIENTS` (6), `INTAKE_MIN_STAY_DAYS` (30),
  `daysBetween_`, `intakeToday_` (Asia/Jerusalem, pinnable in tests),
  `readLeadMeetingManagers_`, `managerHouseByName_`,
  `computeIntakeMeetingsByHouse_`.
- **Read-only**: lead tabs are read with `getSheetByName` — a missing tab is
  skipped, never created; nothing is written.
- No other payload field and no `totals` key changes (test-asserted).

**Contract change**: the pinned Managers payload keys in
`test/cross-app-payload-guard.test.js` now include `intakeMeetings` (LAST),
on purpose. The Managers app ignores unknown fields, so this deploys safely
before the Managers PR.

**Tests**: 2700 → 2712 (`test/intake-meeting-bonus-feed.test.js`: 7th vs 6th
patient, same-day ranking, exit on the entry day, 29 vs 30 days, pending →
confirmed, credit to the meeting manager across houses, same-name managers by
date, missing lead / meetingWith / unknown name, removed-tab lead,
managersHouse = overview, read-only, other fields untouched). Mutating the 6
or the 30 fails 4 tests.

**Deploy**: Apps Script deploys automatically on merge (clasp CI). No Railway
variable, no Script Property, no new action.
