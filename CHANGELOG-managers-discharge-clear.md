# Changelog — expected discharge: clear + «אין צפי לשחרור» (backend + card) — 2026-10-15

## Why
A date could be set or changed in the Managers app, but not cleared. The CEO set a test date on a
patient who has no expected discharge, and there was no way to undo it or to say "no expected
discharge". Paired with ezone-managers (the UI and the Managers alerts).

## What
- **Apps Script** (`managersWork` op `dischargeSet`), new optional `mode`:
  - `set` (default, unchanged): a date;
  - `clear`: no current value; the patient is «ללא תאריך» again;
  - `none`: «אין צפי לשחרור». Feeds return `{ date: '', none: true, editedAt, editedBy }`.
- **Append-only**: `clear` and `none` APPEND a row with an empty `expectedDate`. Nothing is
  deleted or overwritten. The current value of a stay is still its LAST row.
- **Sheet header**: `ManagersExpectedDischarge` gets one column appended at the end, `state`:
  - `set`, `cleared` or `none`;
  - rows written before it have `''`, read as a date;
  - the header is extended on the first write (`getOrCreateSheet_`), never rewritten.
- **Optimistic concurrency** covers all three: `previousDate` is the token the screen showed
  (`''`, `yyyy-MM-dd` or `none`). A stale token gives `conflict` plus the current value. The same
  target as the current value gives `unchanged`, with no new row.
- **Validation**: an unknown `mode` → `bad_request`. A date sent with `clear` / `none` →
  `bad_date` (refused, never ignored). `set` keeps every existing check.
- **Authorization**: unchanged. The secret is fail-closed, the house is pinned by the Managers
  server, the patient must be in that house today with that admission date, and the actor id is
  required.
- **Capability flag**: `houseData` and `expectedDischarges` return
  `expectedDischargeModes: ['set','clear','none']`. Managers shows the new buttons only when it
  sees it.
- **Dashboard card «שחרורים צפויים»**: a patient marked «אין צפי» is neither an alert nor counted
  in «N מטופלים ללא תאריך שחרור משוער». A cleared one is counted again. Shared rule:
  `lib/discharge-alerts.js` `dischargeState`. The model has a new `noExpected` count, which is
  not rendered.
- **Shared fixture** `test/fixtures/discharge-alert-cases.json`: a `states` section was added. The
  file is identical in both repos and its new sha256 is pinned on both sides.

## Conservative readings
- «ניקוי תאריך» clears «אין צפי» as well: the patient goes back to «ללא תאריך».
- «אין צפי» patients are not shown as a separate line on the card (the request only asks to
  exclude them). The count is in the model for later.
- No bonus, occupancy or settled-month figure reads any of this. Tested.

## Tests
`test/managers-discharge-clear.test.js` (+11): clear, none, re-set, conflict / unchanged,
validation, own-house authorization, the append-only guard on a legacy 9-column sheet, bonus
figures unchanged, the feed, the card model, and the fixture `states`. The existing header pins
were updated (`state` appended). **2912 → 2923**, all green.

## Deploy
SW cache v68 → v69 (`/discharge-alerts.js` changed; live v68 verified). Code.gs deploys automatically on merge («Deploy Apps Script»). No new Script Property, Railway
variable, secret or sheet. Merge this BEFORE the Managers PR. Until then the Managers UI hides
the new buttons (no `expectedDischargeModes`).
