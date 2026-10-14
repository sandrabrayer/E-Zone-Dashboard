# Changelog — managers work tool: expected admissions (2026-10-14)

## What
`managersWork` `houseData` adds `expectedAdmissions: [{ name, date, stage, meetingWith }]`.
These are the **open** leads of the caller's house (stage not admitted or irrelevant) whose
planned `entryDate` falls between today and 13 days from now, sorted by date.

## Why
Sandra, 14 Oct 2026: the manager dashboard should show the admissions expected this week.

## Safety
- Read-only.
- Minimal fields: no phone, notes or money.
- Names are cleaned with `coordTextClean_`.
- Scoped to the house the managers server decided.

## Tests
2764 → 2765 (`test/managers-work-tool.test.js`).
