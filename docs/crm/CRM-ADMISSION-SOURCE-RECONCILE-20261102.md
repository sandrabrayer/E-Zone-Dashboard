# CRM-SAVE-02 | Safe source reconciliation for uncertain admission and funder replies

**2026-11-02 — DRAFT code and synthetic tests; no production source, policy, schema or data change.**
**Owner:** [Dashboard #339](https://github.com/sandrabrayer/E-Zone-Dashboard/issues/339) · **Single candidate:** [DRAFT #358](https://github.com/sandrabrayer/E-Zone-Dashboard/pull/358) · **Business workstream:** [#350](https://github.com/sandrabrayer/E-Zone-Dashboard/issues/350).

## Source-confirmed defect addressed
When `saveAll` persists the new Patients and Leads rows, the HTTP response can still be lost after the commit (or return nonconfirming JSON). The CRM historically undid its **browser** optimistic admission and returned failure, which could encourage the operator to re-admit the same individual with a **fresh patient ID**, potentially duplicating occupancy and requiring a second funder record. A separate `appendFunder` write may likewise have reached the source before its response was lost.

These are **code-path hazards and synthetic fault scenarios**, not proof of a specific live patient's duplicated admission or lost financial record. GitHub tests must never contain real identities.

## First stage: admission source proof, not blind retry
On a refused, malformed or lost `saveAll` reply **during admission/direct add only**, run one read-only `getData` through the existing authenticated Dashboard API. This read goes through `lib/read-cache.js`, which is invalidated on POST start and settle; other replicas/external writers can still cause temporary staleness, therefore a **negative read does NOT authorize a second attempt**.

The pure helper `admissionSourceProof(data, { patientId, leadId, houseId, date })` checks:
- Exactly ONE matching source patient `id`, across *all houses*. It never uses name or a shared phone.
- Exact `fromLead`, exact house (including source house-key fallback), exact original entry date, non-released source status.
- Exactly ONE lead with the same exact `id` and source stage `admitted`.
- On `confirmed`, update the in-memory view to the source data and continue the **original** second-stage funder write with the **same original patient ID** — never a second admission.
- On `patient_only / missing / mismatch / ambiguous / unavailable`, do not send `appendFunder`, show the reason in a **blocking error**, and require an explicit human source review. No fresh ID and no blind automatic write retry.

The general `postAction` flow for lead archive/restore, edits and transfers remains unchanged; this guard is supplied only by the two admission actions.

## Second stage: funder source proof, no second finance write
`appendFunder` submits **one** generated `submissionId`. Its acknowledged response must contain that exact key. When this response is refused/invalid/lost, **do not POST again**; call read-only `getPayments` and compare one unique Funders row by exact `patientId`, `funder`, and effective date. The deployed `fundersForClient_` projection omits `submissionId`; the read verifies the requested source state, not acknowledgment of the transaction. If a future source exposes a key, a conflicting key is refused. Success requires an unambiguous matching state. If the source cannot be read, does not match, or is duplicate, the UI warns: **admission saved, funder not verified; do not readmit**. This is a status distinction, not a correction or refund.

## Test coverage — dummy source and real local Chromium only
1. `test/crm-admission-source-reconcile.test.js`: exact admission source proof and all negative identity cases (same-name/lookalike, wrong house/date/lead, duplicated ID, released, stale/absent lead, failed read), no rePOST from recovery.
2. `test/crm-save-integrity.test.js`: exact funder reply key and independent source-state proof, including the actual `fundersForClient_` projection; refuses missing/wrong/duplicate finance source evidence.
3. `test/crm-search-admit-funder.test.js` now injects a **real transport failure after the dummy source commits**, and tests successful source read recovery, no committed patient, partially committed patient without lead, failed source read. It also tests lost funder reply with committed row, no committed row and unreadable funder history. All include **one** original admission and at most **one** appendFunder write. Browser service uses **local Express + synthetic fake Apps Script** only.
4. Existing Chromium scenarios for synthetic authenticated roles, conflicting identity, old/new collection and discharge audit guards remain required.

## What remains intentionally unsolved
- Reads from another Railway replica can be stale despite this process's bust. A negative or missing read still blocks actions and requires human reconciliation. There is no new durable operation journal or cross-browser lock.
- Parallel browser sessions may attempt unrelated new admission IDs. Source-side unique person identity/transaction ownership and verified data recovery need an approved design and robust identity model, **not a heuristic by phone/name**.
- If the Patients record is present but Leads is stale, the browser refuses to auto-fix or proceed with the finance stage. A source owner must reconcile the partial state.
- Third-party Outpatient's accepted/contacted/started status is a separate staged return feed; not part of this patch.
- Tested code in GitHub's synthetic pipeline is **NOT authenticated staging or production source acceptance**. A restore drill and permission tests remain prerequisites for release.

## Governance
No changes were made to `apps-script/Code.gs`, `server.js`, `lib/read-cache.js`, current financial calculations, the live Dashboard, Outpatient, permissions, invoices, existing payments or production data. **No new backend endpoint, financial write, automatic retry, merge or deploy.**

The older duplicate [DRAFT #359](https://github.com/sandrabrayer/E-Zone-Dashboard/pull/359) was closed **without merge**; this work remains on **the one selected DRAFT #358**. Separate explicit Sandra approval is still mandatory for production merge/deploy and data changes.

Persistent finance-only admission-funder clarification, independent-reader coverage and account-cache invalidation are documented in [the #358 acceptance checkpoint](CRM-358-ACCEPTANCE-CHECKPOINT-20261102.md).
