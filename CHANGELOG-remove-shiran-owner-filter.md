# Shiran removed from the leads «אחראי» filter

Sandra, 17/11/2026. Frontend only; no Code.gs change.

The CRM leads board's owner filter (`renderLeads` in `public/crm/crm.js`) built its
options from the owners found in the lead data, so שירן (and יעל) kept appearing
while old leads still carried their names. It now lists the fixed current owners
(`ASSIGNEES` = ורד, דנה, סנדרה), the same list as the add-lead forms.

- Leads owned by שירן / יעל are unchanged: they still show with their owner chip
  and under «כל האחראים». No sheet data touched.
- Service worker cache v145 → v146.

Security: static option list, every name still passed through `esc()`; no secret
touched. `npm audit`: 0 high/critical.

Files: `public/crm/crm.js`, `public/sw.js`, `test/assignees-dana.test.js`,
`test/crm-pwa.test.js`, `test/dashboard-perf-assets.test.js`.
