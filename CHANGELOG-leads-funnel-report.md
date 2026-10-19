# «חתכים בלידים» — the leads funnel report (2026-10-19)

A read-only panel on the **ניהול לידים** tab (button «חתכים בלידים»).

- **Period picker:** from / to dates plus presets «החודש», «החודש הקודם», «3 חודשים אחרונים» (this month + the two before it, up to today).
- **Counted by the date the lead was created** (`created`, both ends inclusive). The panel says so. Leads with no creation date are reported apart («… לא נספרו»).
- **Three counts**, each clickable to show its lead list, with **CSV export** of the list shown:
  - **לא רלוונטי:** a closed lead whose disposition (`computeDisposition`) is `not_relevant`;
  - **הגיעו לפגישה ולא נכנסו:** had a meeting (visitDate, a stage at/after «ביקור נקבע», or a manager meeting report), never became a patient, and is not `not_relevant`;
  - **נכנסו לבית:** became a patient (a Patients / discharged row with `fromLead` = the lead, or stage admitted).
- Exact rules, precedence and edge cases: `docs/leads-funnel-report.md`.

## Implementation
- `lib/leads-funnel.js` (new, pure UMD → `window.LeadsFunnel`): `presetRange`, `funnel`, `toCsv`, `csvFilename`. Served like the other lib assets (`server.js` ASSETS + route, `index.html` before app.js, `sw.js` BUNDLE_PATHS).
- `public/app.js`: `leadsFunnelReport`, `leadsFunnelHtml` (every value escaped), `renderLeadsFunnel`, `exportLeadsFunnelCsv` (built client-side as a Blob, so there is no new server route).
- CSV: UTF-8 BOM, quoted cells, and a leading `= + - @` is neutralized (CSV-injection safe).
- **No Code.gs change**, because the getData payload already carries everything.
- Service worker: v72 → **v73** (stacked on PR #251, which takes v72).

## Tests
`test/leads-funnel.test.js` (16): presets (Feb / leap year / year boundary), inclusive boundaries, missing creation date, bad range, each bucket and its precedence, duplicates / direct_admin, CSV safety, escaping, wiring.
