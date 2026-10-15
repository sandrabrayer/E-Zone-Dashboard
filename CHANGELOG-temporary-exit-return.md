# Changelog — Managers bonus: a temporary exit and return does not break the stay (2026-10-15)

## What
CEO decision (15 Oct 2026): a patient who leaves temporarily (appointment, meeting, short
leave) and comes back must NOT break the stay. Their days count toward treatment days and the
average daily occupancy, with no double counting and no day-count reset.

## Investigation — how a temporary exit is stored today
- There is **no leave status**. A temporary exit is recorded as a release (Patients row
  `status='released'` + `exitDate`) followed by a **new Patients row** (new `date`).
- `computeMonthStats_` (source of `avgDaily`, `treatmentDays`, `dailyChart` for
  `managersOverview` / `managersHouse` / `occupancySnapshots`) counted every row on its own:
  - **same-day return** (exit day = re-entry day) → that day counted **twice**;
  - **gap days** between exit and return → not counted;
  - the return showed as a new entry + an exit in the month's activity counts.
- `managersWork` `houseData` («מטופלים בבית»): the admission date and «יום N» restarted
  from the re-entry row, and the return was listed under «נקלטו החודש».

## Rule (conservative)
- **Temporary exit** = the same patient (same house + same name, cleaned, spaces collapsed)
  re-admitted within **`READMIT_WINDOW_DAYS = 7`** calendar days of the previous row's exit
  date. That single named constant is the only place the window lives. A later return is a new
  stay.
- A patient counts **at most once per day**. This also fixes overlapping duplicate rows.
- **Gap days count only if the bed was held.** The sheet records no bed-held fact, so gap
  days are **not** counted (documented assumption). If a bed-held flag is ever recorded, it
  plugs into `computeMonthStatsContinuous_`.
- The stay keeps its **first admission date**; «יום N» runs from it. A return is not an
  admission, and the exit before it is not an exit, in the month's counts.
- **Month-aware**: from `STAY_CONTINUITY_FROM_MONTH = '2026-10'` (the running month) on.
  Every month up to Sep 2026 (settled) keeps the original computation byte-for-byte
  (`computeMonthStatsLegacy_`). So **no settled bonus can change**, and settled
  `OccupancySnapshots` rows are write-once anyway.
- Bonus math stays in the Managers app (`lib/bonus-eligibility.js`, unchanged). This backend
  supplies raw data only.

## Audit
`auditTemporaryExitsNow()` is editor-run and **read-only**: it writes nothing, creates no
sheet, and is not an endpoint. For the previous and the current month it logs:
- per house: `treatmentDays` / `avgDaily` before (original) and after (rule);
- every return within the window: house, patient **initials only**, exit and return dates,
  gap days, and whether the original computation counted, dropped or double-counted the days.

A settled-month error is **reported, never applied**. Changing a settled month needs Sandra's
explicit decision.

## Not changed (follow-ups)
- `patientsNow` (patients at month end) still counts rows. A same-day return on the last
  day of a month can count twice there.
- The intake-meeting bonus's 30-day stay check still uses the row's own dates.

## Tests
2822 → 2832 (`test/temporary-exit-return.test.js`, 10 new). Covered:
- stay with a gap;
- return within / after the window, and the 7 / 8-day boundary;
- same-day return counted once;
- overlapping duplicates;
- different patients not merged;
- May–Sep 2026 identical to the original computation;
- the audit is read-only and prints initials only.
