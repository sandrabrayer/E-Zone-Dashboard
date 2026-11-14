# «+ דווח תשלום למחזור אחר» — closed, nothing pre-selected

## Why
In the CRM patient drawer «חשבון» tab, the C13 picker (CHANGELOG-crm-report-any-cycle.md) was always open
under «מחזורים פתוחים» with the label «דווח תשלום למחזור אחר (מקדמה / מחזור שלא ברשימה)» and the NEXT
cycle pre-selected with its amount (e.g. «15/11/2026–14/12/2026 · ₪32,000»). Sandra read it as a debt that
does not exist.

## What changed (public/crm/crm.js only)
- The section is a closed `<details>`: «+ דווח תשלום למחזור אחר». Inside: one line saying it is for an
  advance or an earlier cycle and is not debt.
- The select starts on the placeholder «בחר מחזור…»; no cycle is pre-selected, no amount is shown until
  the section is opened.
- Options in two groups: «מחזור עתידי (מקדמה)» (nearest first) and «מחזור קודם» (newest first).
- «דווח תשלום» is disabled until a cycle is picked; the click handler also refuses the placeholder
  (`otherCyclePick` — `Number('')` used to resolve to cycle 0).
- `defaultReportable` removed (no default any more). New pure helpers: `otherCycleGroups`,
  `otherCyclePickerHtml`, `otherCyclePick`.
- The report form, its rules and what is sent to the server are unchanged.
- Service worker `CACHE_VERSION` v133 → v134 (monotonic from the live v133).

## Tests
- `test/crm-shell-ui.test.js`: grouping/order, closed by default, single `selected` (the placeholder),
  disabled button, old label gone, escaping, placeholder/junk never picks a cycle.
- `test/crm-shell-browser.test.js`: the C13 flow opens the section, checks nothing is picked and the
  button is disabled, picks the next cycle under «מחזור עתידי (מקדמה)», reports it (same payload as before).
- SW version tests bumped to v134.

## Security
UI-only change. No new endpoint or field; option labels stay escaped; server-side validation of the
report is unchanged.
