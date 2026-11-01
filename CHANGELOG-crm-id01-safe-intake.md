# CRM-ID-01 — safe intake identity decision (Draft, 2026-11-01)

This is an isolated **unreleased** candidate based on Dashboard #338. No production deploy or patient records were changed.

## Risk
The previous direct-add flow matched an open lead by a normalized phone number or full name and automatically admitted it. A phone may be shared by relatives. The separate «כבר בבית» badge allowed automatic closing of a lead as admitted from a similarly fuzzy comparison. The application has no authoritative, automatic person match from these fields.

## Candidate behavior
- A possible open lead is treated as a **review warning only**, never as an automatic admission.
- To admit the patient from an existing lead, the operator opens the *specific lead card* and uses its existing admission action (exact lead ID).
- If this is an independent person with a shared phone or name, the operator can proceed with a new direct intake **only after explicitly checking** the confirmation box. The new patient receives its own direct lead, with no implicit link to the candidate. Input remains in the form until the decision is made.
- The unverified «סגירת הפנייה כנקלטה» action was removed from a name/phone-only badge; a warning remains, no existing patient/lead history is changed.
- Server-side save-conflict protections remain unchanged, and the end-to-end E-ZONE One person/stay identity linkage remains a separate, gated program.
- SW v109 → v110. No Apps Script, schema, finance, access, database or integration changes.

## Acceptance and release gate
Synthetic browser cases in `test/crm-search-admit-funder.test.js` must prove **zero writes** before independent confirmation, a new independent lead afterwards, no close-by-fuzzy card action, and preserved funding submission ID. Existing test expectations that mandated automatic admission were replaced intentionally. Full suite/CI, safe read-after-write and production-grade user acceptance are still required.

**Never merge/deploy or run historical re-link from this draft without Sandra's separate approval.** See [CRM-ID-01 #341](https://github.com/sandrabrayer/E-Zone-Dashboard/issues/341) and [CRM-E2E-01 #339](https://github.com/sandrabrayer/E-Zone-Dashboard/issues/339).
