# C17 — «משוחררים» in the CRM: list, restore, «העבר לאמבולטורי» — 2026-10-28

CRM restructure. Flag-gated. No Code.gs, no server change, no SW bump. Classic contracts reused.

## What
- «מטופלים» gets a בבית / משוחררים toggle. The discharged view lists the open discharge audit rows
  (`getData.dischargedPatients`, not restored, not soft-deleted) within 30 / 90 / 365 days / all,
  with house filter and search: entry, exit, disposition, continuity, and the Outpatient state
  («נשלח» from `outpatientSentLeadIds`, «לא נשלח» when the disposition was «משוחרר לטיפול חוץ»).
- **העבר לאמבולטורי** → `POST /api/outpatient-lead { dischargeId, manual: true }` (confirm first);
  «נשלח» after `sent` / `alreadySent`; a failure is a toast and nothing changes.
- **שחזר** → a two-way choice, as the classic restore-choice modal:
  - *to the previous status* (`prior_status`, default פעיל): the released Patients row is found by
    the audit's `patientId`, else the house / name / entry-date triple, else the one released row of
    the house with the same source lead; it is sent as the **house as read** with `status` =
    prior and `exitDate` = '' (`saveAll` + `prove`), then every open audit row of the stay is
    flagged with `restorePatientToActive` (idempotent upserts). No matching row → the option is
    disabled with a note (classic dashboard).
  - *as a new lead*: `restorePatient { patient: <audit row>, newLeadId: 'lead-<16hex>' }`;
    accepted only when the server echoes the lead id.
  Either way the data is re-read afterwards (no optimistic state for a multi-step write).
- Fix: a `change` inside a form rendered in the main area (the restore choice) no longer
  re-renders the area — the generic filter handler now reacts to its own controls only.

## Tests
`test/crm-shell-ui.test.js` +1 (list window / filters / sent flag; restore target by id, triple,
source lead; restored row; sibling audits; bodies); `test/crm-shell-browser.test.js` +1 Chromium
scenario (list, Outpatient handoff body + state, restore to active = house-as-read saveAll + audit
flag, restore as lead with a minted id). Guards: writes + `restorePatient`,
`restorePatientToActive`; two `/api/outpatient-lead` call sites.
Files: `public/crm/crm.js`, tests, ESS, `docs/crm/ROLLOUT.md`.
