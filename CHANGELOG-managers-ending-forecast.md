# Managers — ends of employment in the per-worker house cost (November 16, 2026)

Sandra, 16 Nov 2026: «לגבי עובד שמסיים, לחזות את קיזוז השכר העתידי שלו מהיום שהוא מסיים … על מנת שכל
האפליקציות יהיו מעודכנות». The staffing app now forecasts what an end of employment takes off the
payroll (ezone-staffing PR #135). This change passes that to the managers app.

## What changed

`managersWork` op `houseStaffCost` — `apps-script/Code.gs` `mwHouseStaffCost_`:

- Each worker gains **`endDate`**: a strict `yyyy-MM-dd`, or `''` while employed. For a person listed
  under both ids of one house (`pardes` + `hapardes`) the date is given only when every entry ends,
  and then it is the later one.
- `staff` gains **`ending`**: `{ count, monthlySaving, savingThisMonth, savingNextMonth }`, whole
  shekels, summed over the house's staffing ids. `null` when the staffing feed does not send it —
  never a made-up 0.
- Every value is re-validated here: numbers rounded and floored at 0, the count capped, dates checked
  as calendar dates, any other upstream key dropped. Only the caller's house leaves, as before.
- The cache key moved to `mw:staffing-worker-cost:v2:<month>`, so a copy cached before the staffing
  deploy is not served without the new fields.

No new op, no new Script Property, no sheet change. A managers app that ignores the new keys is
unaffected.

## Tests

`test/managers-crm-backend.test.js` 10 → 11: the new keys cleaned and summed, another house's
figures never leave, a person ending under one id only has no date; the two existing shape tests
now pin `endDate` and `ending: null`. Full suite 4078 → 4079.
