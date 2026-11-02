# An admitted lead stays closed — 2026-11-02

## Bug
מתן כחלון was admitted to קיסריה ריהאב on 01/11/2026: the Patients row exists (active, entry
01/11, `fromLead` = his lead id) and his first payment was reported on 02/11. His lead was still on
the leads board under «בטיפול פעיל» with the «כניסה לבית» button.

## Root cause (checked against the live sheet)
- The Leads row is `stage: paid`, with no `entryDate` and no `meetingOutcome`. Both admission
  paths (classic `openEntryModal`, CRM `admitLead`) write `stage: admitted` + `entryDate` +
  `meetingOutcome: entered` in the same `saveAll` as the patient. So the admission did write it,
  and something later wrote the old copy back.
- Every classic `saveAll` sends EVERY lead from that tab's in-memory copy, and `mergeLeads_`
  writes whatever it receives. A tab (any user, any device) loaded before 01/11 11:27 that saved
  anything afterwards reverted the lead to «בטיפול פעיל». Nothing on the server stopped it.
- The classic load-time heal (`retireAdmittedLeads`) only covered the legacy `entry` / `entered`
  stages, so it never repaired a lead reverted to a board stage.

## Fix
1. **Server (`Code.gs` `mergeLeads_`)** — new guard `keepAdmittedLeadStages_`: when the SHEET row is
   admitted and a Patients row that is **not released** has `fromLead` = this lead, the incoming
   `stage`, `entryDate` and `meetingOutcome` are replaced by the sheet's. The rest of the lead's
   fields still save. The answer carries `admittedKept: [ids]` (additive), and AuditLog records
   `lead_admitted_kept`. The Patients sheet is read only when a payload lead would leave an
   admitted stage.
   - A real reopen (restore as a lead after a discharge) has a released patient → not blocked.
   - An admitted lead with no linked patient → unchanged behaviour.
2. **Classic load-time heal (`retireAdmittedLeads`)** — a lead at new / visit / waitlist / paid
   whose id is the `fromLead` of a not-released patient is retired to `admitted` (entry date filled
   from the patient) and saved by the existing auto-save. Exact link only, never by name. This
   repairs rows already reopened, מתן כחלון included, on the next classic load in edit mode.
3. **CRM read (`normalise`)** — the same rule at read time: such a lead reads as admitted, so it is
   not on the board and not in «היום שלי».

## Tests
`test/admitted-lead-stays-closed.test.js` (7): the stale save is kept closed (other fields still
land), a released patient lets a reopen through, no linked patient → as before, ordinary stage
moves and admission unchanged (real Code.gs, in-memory sheets); classic heal by link (with entry
date) and never by name / never for a released patient; CRM read. SW pins updated.

## Security
No new route or action; the guard only narrows what a save can overwrite. AuditLog carries lead
ids only, no PII.

## Files
`apps-script/Code.gs` (ships through the clasp CI on merge — never paste, no new deployment),
`public/app.js`, `public/crm/crm.js`, `public/sw.js` (**v111 → v112**),
`test/admitted-lead-stays-closed.test.js`, `test/crm-pwa.test.js`,
`test/dashboard-perf-assets.test.js`, `EZONE-ECOSYSTEM-STATUS.md`.
