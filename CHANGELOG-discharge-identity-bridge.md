# D-ID-2: Dashboard discharge → Outpatient exact identity

2026-10-30 · **DRAFT ONLY — no merge, deploy, production writes or data changes.**
Stacked on Dashboard D-ID-1 PR #329. Depends on Outpatient OP-ID-1 PR #137
and OP-ID-2 PR #138.

## Scope and safety
- The browser supplies only the discharge audit row id. The source backend
  resolves that row, takes its persisted patientId, and reads exactly one
  Patients.id to obtain personId (returning-stay root); it also carries
  the pre-existing fromLead as dashboardLeadId.
- Missing, duplicate, malformed or legacy identity fails closed. No PII-based
  lookup or automatic linking, no new IDs and no Sheet schema changes.
- Outgoing createLead receives server-owned dashboardPatientId, dashboardPersonId,
  dashboardLeadId, and source=dashboard_discharge in addition to existing
  name, phone, house, note.
- An Outpatient success with a missing/malformed downstream id is not marked
  sent; retries use the same exact stable identity. A discharge record and
  refund are never rolled back by handoff failure.
- The legacy browser route remains name/phone-only; no browser-controlled
  identity fields can reach the outgoing call.
- Changes are strictly on Dashboard; OP03/Outpatient backup and CRM PRs
  remain untouched.

## Ordered release (separate approval required)
1. Merge/verify Dashboard D-ID-1 #329, which auto-deploys Apps Script.
2. Merge/verify Outpatient OP-ID-1 #137 and OP-ID-2 #138, using the
   two-phase Railway → explicitly dispatched Apps Script source release.
3. Only after Outpatient's identity-aware createLead is live, deploy D-ID-2
   (this draft). Verify both Dashboard Railway services and Apps Script source.
4. Run synthetic end-to-end exact-id/retry/legacy-refusal validation before
   any production handoff. Reconcile real missing legacy identity manually;
   never silently create on PII. No production writes/tests without approval.
