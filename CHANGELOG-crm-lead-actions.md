# C4 — lead actions inside the CRM: stage move, meeting, outcome, note / owner — 2026-10-27

CRM restructure, Session C (write actions, first PR). Flag-gated (`CRM_ENABLED` + `/?view=crm`).

## The write path (one, narrow)
The classic app saves with `saveAll` carrying EVERY lead and patient. Code.gs `mergeLeads_` upserts
by id and keeps leads absent from the payload, and `patients: {}` touches no house — so the CRM
sends **one full lead row** (the raw `getData` object, patched) with `prove: { leads: [id] }`, and
treats the write as failed unless the answer's `proven.leads` names the id (R3). Optimistic UI,
rolled back on any refusal, Hebrew reasons (`invalidLeads` → שם וטלפון, `badLeadDates`,
`closedSuppressed`, `lock_busy`, unproven). Same role gate as the classic save (any verified
personal session; Dana's read-only role is a later track).

## Actions
- **«שלב הבא»** on every board card and in the drawer (+ «שלב קודם» there): `new → visit →
  waitlist → paid`; `waitlistedAt` stamped / cleared exactly as `app.js moveLead`. `paid`'s next
  step is admission — a link to the classic תפוסה until the admission PR.
- **תיאום פגישה**: date, time, «נפגש/ת עם» (current managers of the lead's house from
  `currentManagers`, then all managers, then «אמבולטורי» — the existing Outpatient handoff
  trigger stays server-side). A dated meeting on a `new` lead moves it to «ביקור נקבע».
- **דיווח תוצאת פגישה**: the five `meetingOutcome` keys (labels mirror `MEETING_OUTCOME_LABELS`).
- **הערה ואחראי**: `note` + `assignedTo` (ורד / דנה / סנדרה; a stored other value is kept).
- Saving state in the drawer, toast on success / failure; the drawer keeps its tab across a save.

## Not in this PR
New lead, close lead («לא רלוונטי» / הסר), admission, direct add, discharge, house move — next PRs.

## Files
`public/crm/crm.js`, `public/crm/crm.css`, `test/crm-shell-ui.test.js` (+3), `test/crm-shell-browser.test.js`
(+1 real-Chromium scenario: card move → one-lead body, refusal rollback, meeting form), ESS.
No server change, no Code.gs, no SW bump (hashed assets). Rollback: flag off, or revert.
