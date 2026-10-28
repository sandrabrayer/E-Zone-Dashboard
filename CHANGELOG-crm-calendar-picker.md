# C15 — «יומן»: any day or week, past included — 2026-10-28

CRM restructure (Sandra, first live review 2026-10-28: "צריך גם אפשרות לצפות בפגישות מיום אחר
לפי בחירה מיומן"). Flag-gated. No Code.gs, no server change, no SW bump, read-only.

- Toolbar: יום / שבוע toggle, ‹ ›, a date input, «היום», and the title («היום · DD/MM/YYYY»,
  «יום שלישי · …», «שבוע … – …») with the count. Week = Sunday–Saturday, grouped by day.
- Every lead with a visit date on the chosen day(s) is listed — whatever its stage today (an
  admitted or closed lead still had its meeting), so a past day shows what happened. Status chip:
  היום / מתוכנן / Vered's outcome / «יש דיווח מנהל/ת (· חדש)» / «ללא תוצאה». Row → the card.
- The 14-day «upcoming» count is shown when the chosen range is empty.
- Pure core: `calendarRange`, `calendarRows`, `calendarTitle`, `weekStart`.

Tests: `test/crm-shell-ui.test.js` +1, `test/crm-shell-browser.test.js` +1 Chromium scenario.
Files: `public/crm/crm.js`, `public/crm/crm.css`, tests, ESS, `docs/crm/ROLLOUT.md`.
