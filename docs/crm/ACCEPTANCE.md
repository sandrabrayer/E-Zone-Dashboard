# CRM — acceptance evidence (work package 29/10/2026 §4)

One place for «what is proven, by what, and what is still unverified». Statuses: **tested** (automated,
against the real server / Code.gs in the suite) · **verified in use** (seen in production by a person) ·
**not verified** (no evidence yet — never written as done).

| Area | Evidence | Status | Gap / next |
| --- | --- | --- | --- |
| Permissions — Vered / Dana / Ortal: reads, writes, money projection, direct access | `test/ops-role-dana.test.js` (real server + Code.gs: operational writes 200 with her identity, every FINANCE action 403, delete 403, getData without money, saves keep stored prices), `test/restricted-view.test.js`, `test/billing-control-tab.test.js`, `test/crm-tasks-contact-log.test.js` (money tasks scope), `test/crm-my-day.test.js` (contactIndex per role, controller refused) | tested | Dana's personal-code configuration is reported complete; her personal production sign-in has not been independently observed. Observe permitted reads and her next genuine operational action, with authorized finance readback confirming stored prices unchanged; no fabricated patient notes/calls. House scope is not a Dashboard rule (all houses by decision D16). |
| Dana operational exports | `test/dana-export-acceptance.test.js`: actual server projection, actual classic-page XLSX/CSV handlers, decoded workbook cells, finance canaries, positive finance-reader control and direct finance-export refusals | tested on 08acacc9: CI 40914816967 passed; subsequent heads require their own CI | Scope: full report, continuity section, patient list, lead list, retention-summary CSV and protected server export routes. This is synthetic server/page-sandbox acceptance, not personal sign-in or native-browser evidence. See `CHANGELOG-crm-acceptance-evidence.md`. |
| Save — contact log, follow-up, retry, failure keeps text, view after save | `test/crm-tasks-contact-log.test.js` (one transaction, replay writes nothing twice), `test/crm-shell-browser.test.js` Stage 1c (refusal keeps the text, retry reuses the submission id, one `logContact`, lists re-read), `test/crm-contact-panel.test.js` | tested | Another user's view after refresh: covered by the server cache busting on every write (`test/read-cache*.test.js`); F1/F2 fixed in PR #323 (merged). Server TTL is not an automatic cross-browser refresh guarantee. Contacts belong in history; pending follow-ups appear according to assignment/date/filter. |
| Backup — `Tasks` + `Activity` | `CHANGELOG-crm-backup-tasks-activity.md`, `test/nightly-integrity.test.js`; new `test/crm-backup-roundtrip-acceptance.test.js` uses real task/contact writers and snapshot helper, then manual-copy restoration into a fresh VM with replay checks | previous tests passed; expanded round-trip candidate requires exact-head CI; **native run/restore not verified** | Check both dated `dashboard-tasks-…` and `dashboard-activity-…` plus contents and successful job evidence after the expected 30 October run. Synthetic row-copy tests do not certify coherent capture, interrupted replacement, native types/formulas, permissions or native restore. Tab existence alone is insufficient. No forced backup, new project or production restore. |
| Finance flow — report → waiting on Ortal → verify / flag / document | `test/crm-ortal-day.test.js` (reported ≠ verified ≠ document; a requested invoice is not an issued one), `test/billing-control-tab*.test.js` (confirm / flag in the real Code.gs), the account pane tests (C10–C13) | tested | A generic task never certifies a payment (tasks and receipts are separate records by construction). Document issuance evidence lives in חשבשבת — not in this system (by decision). |
| Reminder — existing mechanism, scheduled run, receipt | `test/crm-reminder-hook.test.js`, `test/billing-reminder-delivery.test.js` (20) — deployed with #322 (Apps Script run 40852795332 ✅) | code deployed; **run / receipt not verified** | Retain scheduled-run and Vered receipt evidence for the expected 1 November mail with «היום שלי». Absence from Sandra's inbox is not proof of failure to Vered. No test mail, no second trigger. |
| Performance — «היום שלי», גבייה, בקרה, save + refresh | Progressive boot (#316), 30 s read cache (#320), clickable KPIs (#321); no timings recorded | **not measured** | Record screen/data timings with existing authorized access, same session/data and documented conditions. Label synthetic and production measurements separately. No live test writes; observe genuine staff saves. |
| Triage ownership (operational) | — | **decided 29/10**: Dana first pass within her permissions, Vered owns follow-up decisions and exceptions | Start the round from «פניות» → «רשומות שדורשות בירור». |
| KPI semantics — «גבייה לביצוע» vs «ממתין לאימות אורטל» | two distinct counters on the first card (`CHANGELOG-crm-kpi-two-counters.md`); debt figures untouched | **decided 29/10, implemented** | — |

## Execution ownership and next lanes

ChatGPT is the primary technical implementer per Sandra's credit-saving instruction
(29 October; PR325 comment 6502457535). Do not launch an external agent for routine
reads, tests or documentation. A necessary handoff must be bounded to an exact
commit/task and coordinated after checking active work. No new merge/deploy
approval is implied; new changes remain draft.

After these acceptance gaps, continue the existing package: current Therapists
assignee mapping; manager report → CRM → admission; the missing outpatient
status-return contract; and the house-management/finance workstreams. Check
owners and existing implementation before edits. Do not redo Dashboard #223 or
interfere with OP-03/Outpatient #125. Human-use/scheduled-evidence gaps do not block
independent technical tasks. The existing roadmap remains the only plan.

Rules kept while gathering evidence: no production writes for testing, no secrets read, no bulk changes
to customer records, no second reminder mechanism.
