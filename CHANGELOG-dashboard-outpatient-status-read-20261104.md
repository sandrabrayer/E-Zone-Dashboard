# E-ZONE One — CRM exact-ID status read, Dashboard → Outpatient (04 Nov 2026)

**DRAFT; no production merge, clasp deployment, variable/secret write, or customer data write.** This feature closes the *read side* of G2 without adding any new leads, Tasks/Activity, billing ledger, clinical files, or cross-app data owner.

## Existing source reused
- Dashboard stores `outpatient_lead_sent` AuditLog events, keyed by Lead ID or `discharge:<discharge audit ID>` with `details.outpatientId`. Successful send is NOT proof of contact or treatment.
- Outpatient's already deployed `getHandoffStatus` (dedicated `HANDOFF_STATUS_SECRET`) projects states and next non-money task by exact Outpatient lead/client ID, read-only. It does not match by phone/name.
- This PR adds Dashboard `getOutpatientHandoffRef` — source-read-only, actor-authenticated, no sheet creation — and a session-protected Node route `GET /api/outpatient-handoff-status?leadId=...` or `?dischargeId=...`. Browser cannot call the GS reference action directly through `/api/sheets`.
- User clicks **בדיקת המשך טיפול באמבולטורי** in the existing CRM card of a sent lead or discharged patient. Only verified states show. On missing ID, feed failure, multiple IDs, timeout, stale request or absent configuration the UI says **not verified** and does not clear a task.
- Node returns a bounded operational projection only. No phone, prices, amounts, clinical fields or arbitrary raw JSON passed through. Success cached at most 60 seconds per exact ID; failures not cached.

## Release dependencies and gate
1. **Source action** is new in Dashboard `apps-script/Code.gs`; merging deploys that script automatically, so requires Sandra's separate authorization. Do not merge this draft under prior CRM approvals.
2. Set **separate read-only** secret: Outpatient Apps Script `HANDOFF_STATUS_SECRET` Script Property = Dashboard Railway `HANDOFF_STATUS_SECRET`, at least 32 random chars, provisioned through authorized secure settings by Sandra. Do not copy a createLead, proxy, or personal PIN secret; no value may appear in a PR/log.
3. Confirm the latest Dashboard production branch/head (currently #364 merge `c9f6f7cf...`) and resolve any conflicting open performance #361 Code.gs changes before approved release.
4. Test exact-head CI including real Code.gs sandbox; then Sandra checks one **existing legitimate** sent lead/discharge: source AuditLog contains one OUT ID → status from OUT is visible after refresh → progress changes show within 60 seconds; no financial/clinical details; no task is silently marked done.
5. Manually verify source read permissions (Sandra/Vered and permitted Ops, not controller/unauthenticated). Verify missing/source mismatch/ambiguous ID, feed unavailable, expired session, unauthenticated direct request and two-tab states. **No fabricated live patient, record, appointment, payment or WhatsApp.**
6. Current feature is *on-demand verification on a card*, not a completed global executive CRM task unification. A follow-on centralized queue must reuse the two existing Tasks/Activity owners and this exact status link instead of maintaining a third ledger.

## Truthful status
`SOURCE / CI VERIFIED` after tests is not `LIVE ACCEPTED`. Until deployment and secret provisioning: **G2 still open in production**. A source sent marker with no stored outpatientId stays unresolved, and the user checks Outpatient directly; never fuzzy-relink.
