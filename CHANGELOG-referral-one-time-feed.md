# One-time referral facts — Managers feed (October 13, 2026)

**What**: `managersOverview_` / `managersHouse_` append one more field, LAST:

```
referralStarts: { count, items: [{ date, name }] }
```

per Managers house and month: patients from that house whose **first** day
package (`therapy_type` `day_2x` or `day_daily`) **started** in the month.
Each patient (`house_of_origin` + trimmed `patient_name`) counts once, in the
month of their earliest day-package `start_date` across all their
Outpatients rows — a renewal row or a switch between day packages never
counts again. Maintenance never counts. Rows with an unknown house, a blank
name or no start date are skipped. Read-only.

**Why**: Sandra (13 Oct 2026) — the 300 ₪ continued-treatment bonus is
**one-time** per patient, not monthly. The old per-month `bonus.continuity`
counts (patients *in* a package that month) cannot express that. Amount and
effective month stay in the Managers app.

**Unchanged**: `bonus.continuity` still flows exactly as before; no other
field and no `totals` key changes. Payload guard updated on purpose.

**Tests**: 2712 → 2718 (`test/referral-one-time-feed.test.js`); a mutation
that drops the "earliest start" rule fails the renewal test.

**Deploy**: Apps Script deploys automatically on merge (clasp CI).
