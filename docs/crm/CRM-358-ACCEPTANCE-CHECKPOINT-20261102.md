# Residential CRM #358 — acceptance checkpoint, 02 November 2026

**Decision: HOLD production approval. One candidate: #358.** This checkpoint advances synthetic acceptance and identifies the remaining specific gates. It is not a new project or release branch. #359 and #346/#348/#352/#353 are reference material only.

## Reconciled source

Started at `b5a24217789c0dfe0f8e2e95ef1fb5993b437950`. During acceptance, another session advanced #358 to `964f8ddb1e88c8b88e76cf68b91d3cc6223b48e3` with admission-source reconciliation. Those admission changes and their tests were reused unchanged. A later concurrent advance to `3bc3034` added three funder fault modes, also retained; its expected submissionId in the read projection was corrected against the actual Apps Script contract. Israel-day date fixes through `84f2b37` were retained. This session adds only second-stage funder reconciliation, persistent finance clarification, account-cache invalidation and broader existing browser coverage. No parallel PR.

Read-only production probes returned Railway source `f7b5b0c378541b17d2bbf296d12deee55467df17` and service worker `v112`. This proves that #358 was not live at the probe. It does not prove the active Apps Script revision, authentication properties or production data integrity. No authenticated production dataset was requested.

## Business acceptance coverage

| Business step | Executed synthetic evidence | Remaining source/environment boundary |
| --- | --- | --- |
| New inquiry, validation, stage change, close and restore | Existing `crm-shell-browser` C4/C5; underlying source suites | Native staging write/read and staff usability |
| Contact, promised next action, failed-save retention, retry | Shell Stage 1c; `crm-tasks-contact-log`, `crm-contact-panel` | Native two-user read and real concurrency |
| Visit booking/rescheduling, manager report, no-show callback, calendar | Shell C14/C15; `crm-meeting-no-show-followup`, browser no-show, work-acceptance tests | Actual house-manager session/source path |
| Exact lead identity and independent admission | `crm-search-admit-funder`, `crm-admission-source-reconcile`, shell C6 | Native staging exact-ID/source confirmation |
| Lost admission reply, missing/partial/unavailable source | Existing SAVE-02 four Chromium fault injections, reused from concurrent #358 update | Native Sheets timeout behavior |
| Payer save/refusal/lost reply and durable clarification | Funder fault modes in `crm-search-admit-funder`; `crm-save-integrity`; source projection test | Native source read failures can still collapse to an empty funder list; clarification says unverified, never absent |
| Due-date collections, old-cycle receipt, verification/flagging, account | Shell C8–C13/C18; billing-browser suite; source billing and cross-release tests | Hashavshevet issuance is external; live finance remains untouched |
| Patient edit/move, actual discharge, partial audit/status save, duplicate identity refusal | Shell C7; `crm-save-discharge-browser`; source suites | Actual native multi-sheet commit/recovery |
| Discharge follow-up, no false completion from `sent`, opening urgent cards | `crm-continuity-handoff-gate`, `crm-today-card-open`, `crm-work-acceptance` | Outpatient accepted/contacted/started return remains a separate staged integration |
| Vered/Dana/Ortal screens and switching identities | Shell roles/mobile; `crm-switch-user-browser`; `ops-role-dana`, role/session/proxy/read-cache suites | Real individual login and current source security settings |
| Management | Sandra independently reads the payer clarification; existing finance-reader tests | Ron parity is not implemented in the current `lib/users.js` model |
| Backup/restore and rollback | Existing nightly/source tests only | A verified native Dashboard Tasks/Activity restore plus exact release rollback is still required |

The browser tests use the actual local Express application and Chromium with intercepted dummy upstream responses. Source tests execute Apps Script functions in a VM. These complementary layers do **not** constitute an authenticated native Sheets end-to-end test.

## Permission acceptance is not closed

Current technical gates preserve Dana's operational access without finance and Ortal's controller scope. Do not infer that this proves all program policy decisions:

- `lib/users.js` has no Ron identity; Sandra/Ron management-read parity is therefore unproven/unimplemented here.
- `lib/role-scope.js` still defines `DISCOUNT_REQUIRED = 'finance'`; Vered can satisfy that gate. The central #331 decision says Sandra decides discounts.
- `settleRefund` remains on the finance/controller allow-lists rather than being restricted to Ortal alone, unlike the central separation-of-duties decision.

These are source-observed policy gaps, not new grants in this patch. Keep permission changes in the program's explicit approval path. No live role settings or credentials were changed or read.

## Exact validation and final gates

Use PR #358's latest exact SHA and CI links; old green results never certify a newer head. The browser workflow now includes shell business journeys and user switching and rejects skipped tests. Local CI-equivalent runs use Node 22 and UTC; this host defaults to America/Chicago, which causes 43 pre-existing date-fixture failures if left unpinned. Those host-specific failures are not silently counted as passing. Dependency audit reported **0 high, 0 critical, 9 moderate**; no dependency upgrades are included.

Before a production decision:

1. Run the bounded native staging journey with synthetic records under Vered, Dana and Ortal identities, including source row confirmation, reload, second-user read, timeout and retry. No test patient in production.
2. Reconcile the three permission-policy gaps above with the central program owner and implement/test the approved scope; do not silently grant Ron Sandra's execution powers.
3. Verify the active Apps Script revision and enforcement settings, native Dashboard restore evidence and the exact rollback target. Source code and green GitHub runs are insufficient substitutes.
4. Recheck final #358 head, base and all required CI, then request Sandra's explicit merge/deployment approval. No merge or deployment is authorized by this document.

Outpatient reciprocal acknowledgment and OP-03 are gates for the cross-app rollout. They must not be represented as completed by this residential patch or used to start a second CRM implementation.
