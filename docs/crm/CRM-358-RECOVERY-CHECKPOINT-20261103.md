# Residential CRM #358 — recovery checkpoint, 03 November 2026

> **Separate post-checkpoint qualification, 03 Nov 2026:** [stacked DRAFT #360](https://github.com/sandrabrayer/E-Zone-Dashboard/pull/360) adds five **append-only** payout approval columns to existing Credits (after creditUid); these five fields now form part of the exact source/backup/restore contract. The original #358 VM recovery result did **not** validate these new fields. A new synthetic and then authorized native recovery drill MUST preserve the request/approval actor stamps and approved amount across capture→restore; old backups without these fields cannot be misrepresented as verified approval evidence. Automatic computed policy credits do not count as personally approved; after an amount change, prior payment approval is invalidated. No production Google header edit or merge/deploy is authorized by this addendum.


**Decision: production HOLD; #358 remains the single draft candidate.** This continues the [02 November checkpoint](CRM-358-ACCEPTANCE-CHECKPOINT-20261102.md), after qualifying Outpatient OP-BILL-01 with CRM/OP-03 in its existing #162. It does not authorize a merge, Apps Script deployment, production write or permission change.

## Existing work reused

- Start: #358 `d191f44da8d3eb1c4c6d05582fcdb9f5eb5833a7`, deployed base `f7b5b0c378541b17d2bbf296d12deee55467df17`.
- Reuse #326 `f54739c48abb77db53303b377d8b356a1ffe6548` acceptance tests, rather than opening overlapping development. Dana's actual Express responses feed the actual XLSX and CSV handlers: operational exports retain useful fields and omit finance canaries, with finance-reader positive controls. Tasks/Activity snapshots restore every cell into a fresh VM and replay the original requests without duplicates.
- Correct the old #326 fixture's contact-link expectation: `contactEventId` identifies the completed task's contact; `Activity.detailsJson.nextTaskId` identifies its new follow-up. Exercise both relationships. This follows the unchanged source contract, not a new schema.
- Reuse the existing OP-03 snapshot write/readback/publish implementation, adapting only Dashboard names and the repository's strict `tryLock(...) !== true` convention. No automatic restore API or new ledger.

## Reproduced blocker and correction

A same-day snapshot previously cleared its good predecessor before the replacement write. An interrupted write could therefore destroy that day's usable backup. The nightly job also continued publishing/expiring old backups after a source-read exception. Twelve independent fault tests failed on the previous implementation.

The candidate writes a new temporary sheet, preserves literal text and cell types, flushes, verifies every cell and the absence of formulas, then publishes it. Only after successful publication is the old snapshot removed. Failed publication attempts restore the previous name; ambiguous failures retain recovery remnants for inspection. The same user's backup writers serialize with a UserLock. This does not establish a cross-user or multi-sheet transaction.

A read exception in Patients, Leads, Tasks or Activity now prevents publication and retention. A missing family prevents expiry of old snapshots. Strict retention names exclude `dashboard-pending-*`, `dashboard-previous-*`, Outpatient snapshots and manual sheets. Do not delete these remnants automatically.

## Verification

- Focused UTC suite: **60 passed, zero failed/skipped/TODO**, covering source failures, five replacement failure points, literal formula-like text, apostrophes, leading zeros, numbers/booleans/Dates, a busy lock, foreign names, cleanup failure, missing-source retention, successful retention, complete task/history restore and Dana exports.
- The restored CRM scenario uses actual Code.gs writers and snapshot helper, then the documented manual row-copy procedure into a fresh VM. It proves synthetic data/replay behavior, not native Google serialization or an atomic backup.
- Full Node 22 suite and required CRM/billing Chromium workflows are reported against the final exact head in #358. Do not use an older green head as evidence for this patch. Generic-job browser skips are separate from explicit browser execution.
- Dependency audit: **0 high, 0 critical, 9 existing moderate**. No dependency upgrade in this patch.
- Code.gs SHA-256: `afc3ac5341cc53581dfd720a9aabc4b836e17878d78bc1a09d3347890bcc1d8a` (superseded if any subsequent source edit changes the file; see final PR record).

## Native acceptance and rollback still required

The connected tools in this execution environment do not offer native Apps Script execution. No production script, spreadsheet, trigger, deployment, credential or permission setting was changed. The source change is only on the draft branch; this repository's deployed-branch workflow would update Apps Script on an approved merge.

Before release, use an authorized isolated staging project/workbook with synthetic records and the exact candidate Code.gs. Record the project/version, source SHA, sheet identities and backup destination. Verify text/formula-like values, Date/number/boolean types, complete Tasks/Activity headers and links, interrupted same-day replacement, old-copy survival, source-read refusal, retention and manual restore into a separate disposable workbook. Replay original task/contact submissions, reload and read as a second user. Confirm real backup destination access/configuration without exposing credentials.

The four snapshot families are read/published sequentially, **not a coherent or atomic four-sheet capture**. Dashboard's snapshot scope is Patients, Leads, Tasks and Activity, **not a complete financial disaster-recovery backup**. Native source acceptance and the required financial recovery scope cannot be inferred from these VM tests.

For rollback, retain the verified existing Railway base `f7b5b0c378541b17d2bbf296d12deee55467df17` and independently record the active Apps Script version/deployment before release. A Git rollback alone does not prove the backend was restored. Preserve dated snapshots and recovery remnants; inspect and verify any selected copy in a disposable destination before an approved live restore. This turn did not execute rollback or live restoration.

The existing #331/#347 policy gaps remain: Ron identity/read parity, Sandra-only discount authority versus the current finance gate, and Ortal refund execution versus current finance/controller gates. Resolve these centrally before changing rights. Native staff UAT and source security enforcement are also still open. No production approval is requested while these acceptance gates remain open.
