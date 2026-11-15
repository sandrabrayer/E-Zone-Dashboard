# «חשבון»: «דווח תשלום» is always in view; a paid-on-another-date debt is explained

Sandra, 15/11/2026: «כשרוצים לסמן שולם לא קורה כלום». CRM only, no Code.gs change.

## What was wrong

In the patient's «חשבון» the open-cycles table is wider than the drawer. The
action column («דווח תשלום», «הנחה», «שנה סכום») was the last one, so it sat
outside the visible part until the table was scrolled sideways. What stayed in
view was the green «שולם» pill of the «תשלומים» table — a status, not a button.

## What changed

- The action column of «מחזורים פתוחים» is pinned to the edge of the table
  (sticky), its buttons stacked — «דווח תשלום» is visible without scrolling.
- When a patient has an open cycle «ללא דיווח» AND a payment marked «שולם» on
  another date, the account now says so (it is usually the same money stamped
  on the wrong month): do not report it again; for a released patient close it
  in «גבייה» → «ניקוי חובות היסטוריים» with «שולם — לא נרשם באפליקציה»;
  otherwise «דווח תשלום» on the cycle's row.

## Security

Display only. No new action or permission. `npm audit`: 0 high / critical.

## Files

`public/crm/crm.js`, `public/crm/crm.css`, `public/sw.js` (v137 → v138, from the
live v137), `test/account-actions-visible.test.js` (new), a browser assertion in
`test/crm-shell-browser.test.js`, `test/crm-pwa.test.js`,
`test/dashboard-perf-assets.test.js`, `EZONE-ECOSYSTEM-STATUS.md`.
