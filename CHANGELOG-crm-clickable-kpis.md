# CHANGELOG — Clickable KPIs: «בקרה» opens the list, «גבייה» filters the tables

Date: 2026-10-29 · Branch `claude/clickable-kpis` → base `claude/build-ezone-dashboard-QOg5s`
Sandra: «גם בגבייה וגם בבקרה כשלוחצים על הריבועים הם לא נפתחים». UI only, SW v103 → v104.

## «בקרה»

The tiles are now built from the **same model as «היום שלי» and the triage** (spec §5: counters and
lists from one rule) and each one opens its list:

| Tile | Opens |
| --- | --- |
| דיווחי מנהל/ת שלא נקראו · דיווחים שנקראו ללא החלטה · פגישות שעברו ללא דיווח | «היום שלי» → המשך טיפול לאחר פגישות |
| רשומות שדורשות בירור (no documented contact, no task — replaces the age-based «פניות ללא טיפול 3+ ימים») | the triage round |
| משימות באיחור (overdue **tasks**, not lead age) | «היום שלי» → שיחות ומעקבים |
| ביקורים ללא תאריך | «היום שלי» → פגישות ותיאומים |
| מעברים פתוחים (קליטה) (+ how many are past the entry date) | «פניות» board |

«—» + «טוען… / המידע אינו זמין» when a source is not in yet.

## «גבייה»

The money tiles and the aging buckets are buttons: a bucket filters «חובות פתוחים לפי מטופל/ת» to
that age (a «סינון: … ✕» chip clears it; an empty range says so), «דיווחים לאימות» narrows the
receipts to the unverified ones, «התקבל ב-30 יום» jumps to the receipts; «חוב פתוח» / «מטופלים עם
חוב» = the full list. The page scrolls to the filtered table.

## Files

`public/crm/crm.js` (`renderControl`, `renderBilling`, `data-go` / `data-billing-filter`
handlers), `public/crm/crm.css`, `public/sw.js` (v104); browser assertions in
`test/crm-shell-browser.test.js`; SW guards. `npm audit`: 0 high / critical. Nothing to set.
