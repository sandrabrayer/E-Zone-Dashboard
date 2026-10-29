# CRM — acceptance evidence (work package 29/10/2026 §4)

One place for «what is proven, by what, and what is still unverified». Statuses: **tested** (automated,
against the real server / Code.gs in the suite) · **verified in use** (seen in production by a person) ·
**not verified** (no evidence yet — never written as done).

| Area | Evidence | Status | Gap / next |
| --- | --- | --- | --- |
| Permissions — Vered / Dana / Ortal: reads, writes, money projection, direct access | `test/ops-role-dana.test.js` (real server + Code.gs: operational writes 200 with her identity, every FINANCE action 403, delete 403, getData without money, saves keep stored prices), `test/restricted-view.test.js`, `test/billing-control-tab.test.js`, `test/crm-tasks-contact-log.test.js` (money tasks scope), `test/crm-my-day.test.js` (contactIndex per role, controller refused) | tested | Production check with Dana's own login once her code is pasted: «גבייה» absent, no ₪ anywhere, a save keeps a patient's price (Sandra, 5 min). **Exports**: Dana's classic exports read the projected `getData` (no money fields reach the browser) — no dedicated export test yet. House scope is not a Dashboard rule (all houses by decision D16). |
| Save — contact log, follow-up, retry, failure keeps text, view after save | `test/crm-tasks-contact-log.test.js` (one transaction, replay writes nothing twice), `test/crm-shell-browser.test.js` Stage 1c (refusal keeps the text, retry reuses the submission id, one `logContact`, lists re-read), `test/crm-contact-panel.test.js` | tested | Another user's view after refresh: covered by the server cache busting on every write (`test/read-cache*.test.js`); F1/F2 fixed in PR #323 (merged). |
| Backup — `Tasks` + `Activity` | `CHANGELOG-crm-backup-tasks-activity.md`, `test/nightly-integrity.test.js` | tested; **run not verified** | Check `EZONE-Backups` the morning after the deploy for `dashboard-tasks-…` / `dashboard-activity-…`. A restore drill (copy a snapshot tab back into a scratch spreadsheet) — not done. |
| Finance flow — report → waiting on Ortal → verify / flag / document | `test/crm-ortal-day.test.js` (reported ≠ verified ≠ document; a requested invoice is not an issued one), `test/billing-control-tab*.test.js` (confirm / flag in the real Code.gs), the account pane tests (C10–C13) | tested | A generic task never certifies a payment (tasks and receipts are separate records by construction). Document issuance evidence lives in חשבשבת — not in this system (by decision). |
| Reminder — existing mechanism, scheduled run, receipt | `test/crm-reminder-hook.test.js`, `test/billing-reminder-delivery.test.js` (20) — deployed with #322 (Apps Script run 40852795332 ✅) | code deployed; **run / receipt not verified** | Vered confirms the first mail with the «היום שלי» section (next business day). No test mail, no second trigger. |
| Performance — «היום שלי», גבייה, בקרה, save + refresh | Progressive boot (#316), 30 s read cache (#320), clickable KPIs (#321); no timings recorded | **not measured** | After #323: record `/api/sheets?action=getData` and the three screens' load (DevTools) before / after, same session, same data — Sandra or a browser run with her go. |
| Triage ownership (operational) | — | **decided 29/10**: Dana first pass within her permissions, Vered owns follow-up decisions and exceptions | Start the round from «פניות» → «רשומות שדורשות בירור». |
| KPI semantics — «גבייה לביצוע» vs «ממתין לאימות אורטל» | two distinct counters on the first card (`CHANGELOG-crm-kpi-two-counters.md`); debt figures untouched | **decided 29/10, implemented** | — |

Rules kept while gathering evidence: no production writes for testing, no secrets read, no bulk changes
to customer records, no second reminder mechanism.
