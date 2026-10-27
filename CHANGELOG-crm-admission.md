# C6 — admission from a lead + direct add inside the CRM — 2026-10-27

CRM restructure, Session C (write actions, third PR). Flag-gated (`CRM_ENABLED` + `/?view=crm`).
No server change, no Code.gs, no SW bump (hashed assets).

## The patient write path
Patients save through `saveAll`'s house payload. `replaceHousePatients_` matches by id / identity
key and keeps sheet rows absent from the payload — but it copies every kept row to the tombstone
audit, so a one-row payload would be noisy. The CRM therefore sends **the whole house as read**
(the raw `getData` rows, stamps included, which is what makes a stale save a refused conflict) plus
the new row — exactly what the classic tab sends for that house — never another house, with
`prove: { patients: [id], leads: [leadId] }`. Refusals: `skippedPromotes` (duplicate → «כפילות»),
`conflicts` («השתנו בינתיים — רענני»), unproven patient or lead, `invalidLeads`, server message.

## Actions
- **קליטה לבית** — in the drawer of a «בטיפול פעיל» lead (open by default): house (default = the
  lead's), entry date (lead's `entryDate` or today), monthly pay (required), advance (lead's),
  status (ניסיון / פעיל / בהמתנה), and for finance sessions the funder (required, the
  `PAYMENT_FUNDERS` list). Creates the patient (`source: 'lead'`, `fromLead`), retires the lead
  (`stage: 'admitted'`, `entryDate`, `meetingOutcome: 'entered'` when a visit date exists) in the
  same save; then `appendFunder` best-effort (a failure says so and points to the dashboard).
- **הוספת מטופל/ת ישירות** — button in «מטופלים»: name (two words), optional phone, house, entry
  date, monthly pay, status, funder (finance), notes. Creates the patient (`source:
  'direct_admin'`, `fromLead: 'dl-<id>'`) and its admitted «פנייה ישירה» lead in the same save —
  the exact pair `CHANGELOG-direct-add-auto-lead.md` expects (the server adopts / proves it).
- Optimistic with rollback; toasts; validation inline.

## Not yet
Discharge, house move, returning patient («מטופל חוזר» matching), patient edit — next PRs.

## Files
`public/crm/crm.js`, `test/crm-shell-ui.test.js` (+3), `test/crm-shell-browser.test.js` (+1), ESS.
Rollback: flag off, or revert.
