# CRM «KPI»: bold section headings (2026-11-05)

Sandra, 05/11/2026: «תעשה את הכותרות יותר בולטים».

## What changed
- The «KPI» page is wrapped in `.kpi-page`; its section headings (תפוסה היום, המרת לידים למטופלים,
  סגירה לאחר פגישה, משך שהייה, נקודת איזון) are now 20px, weight 800, dark text, with a 5px accent bar
  on the right (RTL start) and a rule underneath. The count after a heading stays small and muted.
- Scoped to the KPI page only — other CRM areas are unchanged.
- SW v116 → v117.

## Tests
`test/crm-kpi-tab.test.js` pins the wrapper and the heading style; SW pins updated.

## Files
`public/crm/crm.js`, `public/crm/crm.css`, `public/sw.js`, tests above. No Code.gs, no server change.
