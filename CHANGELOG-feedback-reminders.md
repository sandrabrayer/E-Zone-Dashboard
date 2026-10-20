# CHANGELOG — half-yearly feedback «משוב» for the Managers app (October 20, 2026)

## What

- **Roster start dates**: the team digest's `ManagersStaff.startDate` is read as an **optional** column. The Coordinators append it on the same day; an older digest still reads, with every start date `''`. It reaches the Managers app as `houseData.team.staff[].startDate` (`''` when it is unknown or not a real date).
- **`ManagersFeedbackLog`**: a new APPEND-ONLY sheet, header `id, house, employee, doneAt, doneBy, doneById, createdAt`, pinned in `test/managers-work-tool.test.js`. Every «בוצע» is a new row; rows are never edited or deleted.
- **`managersWork` op `feedbackDone`** `{ employee, doneAt }`:
  - The house, author and author id come from the verified caller, never the client.
  - The employee must be on the house's current staff list (the coordinators digest); otherwise `not_found`. When the roster is unavailable the answer is `roster_unavailable` (fail-closed).
  - `doneAt` must be a real date, not in the future (Israel time) and not before 2000; otherwise `bad_date`.
  - Writes take the script lock with `tryLock(5000)` (`lock_busy`). Cells are text.
- **`houseData.feedback`** = `{ supported: true, rows: [{ employee, doneAt }] }`, for the caller's house only.
- The due-date logic (6 months after the last feedback, else after the start date) lives in the Managers app's `lib/feedback-due.js`.

## Setup

No new Script Property. The coordinators `Code.gs` (ManagersStaff `startDate`) must be redeployed for the start dates to appear.

## Tests

`test/managers-work-tool.test.js`:

- the optional column, read with and without it;
- one appended row per «בוצע», with the author taken from the caller;
- house isolation;
- every refusal.
