# «חובות פתוחים» — what is left to collect by a date («צפוי לגבייה עד …»)

## Why
Sandra (14/11/2026): in «גבייה» she wants the unpaid debts AND how much is left to collect by the end
of the month. «חובות פתוחים» only listed cycles already due, and «עד תאריך» was capped at today, so a
cycle due tomorrow could not be seen there.

## What changed (public/crm/crm.js only)
- «עד תאריך» has no `max` any more; a new preset «עד סוף החודש» = every past debt + up to the month end.
  «החודש» / «החודש הקודם» / «כל התקופות» are unchanged (now via the pure `debtPreset`).
- When the period ends after today:
  - three totals (`#crm-debt-split`): «חוב עבר · עד היום» (the existing list, unchanged),
    «צפוי לגבייה עד DD/MM», «סה"כ לגבייה עד DD/MM»;
  - a list «צפוי לגבייה עד DD/MM» (`#crm-debt-upcoming`): patient, house, funder, cycle, billing day,
    amount, and a grey chip «צפוי · DD/MM» (the expected collection day). A row opens «חשבון». It is in
    the calculator (`CALC_TABLES`) and gets its own «חתך לפי» table by funder / house.
- `upcomingDebts` reuses `cashForecast` + `sliceForecast` (the «צפי תזרים» rows) — no second
  calculation:
  - only cycles due AFTER today (due ≤ today is past debt from debtAging), so the parts never overlap —
    an institutional cycle inside its terms stays in «חוב עבר» with its «גוף מממן» chip;
  - active patients only; pro-bono never; discounts, credits and partial payments reduce the amount
    exactly as in the forecast;
  - private: the billing day; ביטוח לאומי / מכבי / משרד הביטחון: «שוטף +30» — counted only if that day
    is inside the period;
  - «לא הוגדר» counts (past debt counts it too) with a «להשלים» chip;
  - an aging bucket or «משוחררים» filter → past debt only (a note says so); «בבית» keeps them.
- Service worker `CACHE_VERSION` v134 → v135.

## Tests
- `test/open-debts-upcoming.test.js` (new): off for past-only periods; 15/11 shows by 30/11 and not by
  14/11; no overlap with past debt (due today / institutional in terms); «שוטף +30»; released,
  pro-bono, «לא הוגדר»; partial and full payment; slices and filters; period starting later; groups;
  presets; the UI source (no cap, button, totals, chip, escaping, no request).
- `test/crm-shell-browser.test.js`: «עד סוף החודש» in the real page — no max, three totals, total = past +
  upcoming, past list unchanged, «כל התקופות» removes the split.
- SW version tests bumped to v135.

## Security
Read-only view over the reads already loaded; no new endpoint, field or request. Every value written to
the page goes through `esc` / `fmtMoney` / `fmtDate`. Access unchanged: «גבייה» stays finance-only, so
Dana's restricted login still does not see it.
