# PR #220 independent review response — 2026-10-13

Review: https://github.com/sandrabrayer/E-Zone-Dashboard/pull/220#issuecomment-6152232656

Claude reviewed `0ee02d997683285eff85d4f04a2e3cfe97a17b4d`, found one blocker
(B1) and seven non-blocking notes. The changes below are the author's response,
not a claim that Claude has reviewed/approved the new commits. Keep draft;
no merge, deployment, production records/configuration or paid resources.

| Finding | Response |
| --- | --- |
| B1: archive moves leave tasks open forever | Fixed in draft: the read-only projection reads active Leads plus IDs from both existing archive sheets. Source-derived lifecycle explicitly retires both prior reminders for the same ID, without asserting attendance or a completed report. Archives missing/invalid = unavailable. Active/archive overlap = partial/quarantined. Restoring active source rows reopens the appropriate tasks. |
| R1: unbounded historical retention until cap | Still an activation gate. No pruning/deletion policy invented. The existing 25,000 historical-task cap and combined 10,000 source-row cap can block collection; closure does not free capacity. Retention/archival/recovery must be approved before activation. |
| R2: no source deadlines; reopening keeps prior date | Documentation corrected. All current source deadlines remain missing; preservation tests inject synthetic dates. New-cycle semantics require a business decision before integrating a dated source. No business rule changed. |
| R3: static registry, not hot revocation | Documentation corrected. The running registry changes only after restart with changed environment. In-flight revocation tests inject a policy resolver; they do not prove production hot reload. |
| R4: server/source ID sets can drift | Node now checks the same four source IDs for GET and refresh. A semantic parity test binds the mirrored Apps Script and Node constants. Adding a generic staff identity alone cannot widen retained-data access. No existing identity or permission expanded. |
| R5: Code.gs and roster release scope | The whole PR does change Code.gs; merge can auto-deploy it. The original projection and archive fix each remain isolated Code.gs/test commits. Roster endpoint retained because Outpatient #114 needs it; the release approver must explicitly review both endpoints. No new roster authority. |
| R6: database-enforced read-only GET | Implemented `BEGIN READ ONLY`. A real-PostgreSQL regression injects a write into the read path and requires SQLSTATE 25006 while retaining the stored task. |
| R7: cleared visit date keeps historical reminder | Documented as an unresolved review item while the lead stays active. Blank date is not proof of cancellation/completion. Later explicit archive evidence retires the reminder even with a blank date. |

## Regression evidence

`test/crm/lead-archive.test.js` executes the actual `moveLeadIrrelevant_`,
`removeLead_` and `restoreLead_` against a synthetic spreadsheet, then the real
v2 source projection, Node collection validation, adapter, normalization, merge
and projection. It verifies both reminders close after archiving and reopen on
explicit restoration. Removed-lead restoration is modeled as the existing manual
Sheets recovery, not a new application action. The source projection itself is
checked for zero mutations, with separate Apps Script API mutation-trap tests.

A local negative-control copy of Code.gs disables only the archive loop; both
archive-action regression cases then fail with two tasks still open instead of
zero. Both pass with the fix. No repository source is changed for that probe.

Additional tests cover unavailable/malformed archives, duplicates across active
and archive sources, old v1 deployments, empty/unknown lifecycle, cleared dates,
actual HTTP/PostgreSQL persistence and browser reload after closure. CI/local
results, tested head and CI's actual merge checkout are recorded in the PR body;
no unperformed real-DB or production test is reported as passed.

## Contract/release dependency

Only Dashboard leads move to `crm-source-v2`; Outpatient and the admitted roster
stay v1. Node refuses v1 lead responses so an old Code.gs deployment cannot
pretend to include archives. Deploy order/activation remains a separately
approved operation; both sides stay disabled. No checkpoint migration is needed:
the payload stores a nullable allowlisted archive-resolution basis, and old
payloads remain readable. Existing encrypted state is retained.
