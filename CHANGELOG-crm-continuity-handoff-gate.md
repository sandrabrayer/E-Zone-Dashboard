# CRM continuity and handoff gate — draft 01.11.2026

**Evidence:** Dashboard merged #338 suppressed unresolved continuation tasks after day 14, or whenever the discharge had disposition `released_outpatient` or an Outpatient referral was `sent`. It also rendered the discharged patient as `המשיך באמבולטורי` based only on send/disposition. The cross-application status return feed #145 is currently an Outpatient draft and cannot verify actual treatment start.

**This narrow UI-only draft fixes only what can be decided with the current sources:**
- An unknown/blank discharge continuation remains an unresolved work row after any age, including when a referral was sent. A user with an explicitly documented result (`continued_outpatient`, `continued_other`, `none`) does not get that missing-result row.
- Labels distinguish “sent but unverified start” and “planned, neither send nor start confirmed.”
- “Outpatient sent” does NOT display “continued treatment” in the discharged table without a documented result.
- Existing source-owner and record IDs are unchanged. No second writable tasks engine, follow-up trigger, auto-retry or Outpatient integration is introduced.
- The row remains one per discharge audit id with Vered as accountable owner; no financial or clinical information added.
- SW v109 → v110 (must be reconciled with concurrent CRM-ID-01 v110 if both change branches are integrated).

**Still required before E-ZONE One signoff:** Outpatient authorized read-only acknowledgment `getHandoffStatus` in draft #145 + exact stable IDs #137/#138/#329/#330, source evidence of contact/meeting/start, handling of conflicting manual status and raw server read failures, backup/recovery and staff acceptance. This code alone does not complete the cross-app protocol.

**Tests:** `test/crm-continuity-handoff-gate.test.js` synthetic regression checks; current CI is the authority for pass/fail. No Merge/Deploy/Apps Script/data change without Sandra's explicit approval. Reconcile overlap with Dashboard #334 before integration.
