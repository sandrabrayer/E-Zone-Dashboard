# CRM «KPI»: only data we really have — no fake manager / house rows; aligned headings (2026-11-05)

Sandra, 05/11/2026 (screenshots from production): «תתקן את הטעויות, הכותרת לא ישרה, תנטרל מידע שאין
לך, אם אין לנו שם של מנהל אל תכניס את זה».

## What was wrong
- «סגירה לאחר פגישה — לפי מנהל/ת» grouped by the raw «נפגש/ת עם» cell, so old rows whose cell holds
  a timestamp (`2026-06-16T06:55:59.528Z`), a stage key (`visit`) or a role («ממלא מקום»,
  «אמבולטורי») each became a "manager" row.
- «המרת לידים» per house used the raw house text: a blank house became «ללא בית» and the damaged
  names (U+FFFD, the dashboard's old UTF-8 corruption) became their own rows.
- The heading and its count («לידים שנפתחו בתקופה: …») sat on different baselines.

## What changed (CRM only — `public/crm/crm.js`, `crm.css`)
- `managerNameOk`: a manager row only for a real name — Hebrew letters (spaces / quotes / hyphen
  allowed), no digits, no damaged characters, not a role or placeholder (ממלא מקום, אמבולטורי, ללא…).
  Meetings without a valid name are left out of the table and counted in one line
  («N פגישות ללא שם מנהל/ת תקין לא נכללו»).
- Conversion per house: rows only for the real houses (`houseId` resolves). Leads with a blank or
  damaged house still count in the totals and are named in one line («N לידים ללא בית מזוהה …»).
- Headings: `align-items: baseline`, wraps cleanly on narrow screens.
- SW v118 → v119.

The source rows are not changed — fixing the damaged names / cells stays the cleanup task already open.

## Tests
`test/crm-kpi-tab.test.js` (+1, and the manager test updated): timestamps, stage keys, damaged
text and placeholders never become a manager row; damaged / blank houses never become a table row.
