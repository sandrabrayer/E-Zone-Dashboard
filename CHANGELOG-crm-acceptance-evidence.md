# CRM acceptance evidence — 29 October 2026 (draft)

## Ownership and scope

At Sandra's request, ChatGPT takes the implementation and validation lane to
conserve external-agent credits. The coordination checkpoint is on PR325,
comment 6502457535. No agent mention, new paid-agent task or automated review
is requested by this change. Existing work must be checked before overlap.

This bounded change adds acceptance tests and documentation only. No application
runtime, Apps Script, workflow, dependency, permission, money rule, service-worker
version or production data changes. OP-03/Outpatient PR125 and all native-drill
evidence remain untouched. Separate production gates remain.

## Dedicated Dana export acceptance

`test/dana-export-acceptance.test.js` runs the real Express server with synthetic
personal sessions and an intercepted upstream response. It verifies the
operational getData projection across active/discharged patients and all lead
lists, preserves all-house operational access, and passes the projected data
to the real classic-page export handlers in the existing page sandbox.

The tests decode the actual generated XLSX files using the existing ExcelJS
dependency: full report, continuity section, patient list and lead list. They
also inspect the actual retention-summary CSV download. Unique finance canary
values must be absent, while known operational records must still be present.
A finance-authorized synthetic reader is a positive control. Direct finance
export routes must refuse Dana before upstream access. No export submits a
write or mutates the synthetic source.

This is not Dana's real sign-in, a native browser interaction, a full Google
round trip, a production export or proof about arbitrary money information
entered in free text. It covers the declared financial fields and these
existing export paths. Existing source-side tests remain separate evidence.

## Synthetic snapshot and manual-copy recovery acceptance

`test/crm-backup-roundtrip-acceptance.test.js` executes the real Code.gs task and
contact handlers to create five synthetic tasks, including dated/window tasks,
a completed task, a cancelled task, reassignment, reschedule history and a
contact-linked follow-up. It executes the existing `integrityWriteSnapshot_`
helper for both Tasks and Activity against an in-memory backup workbook.

The documented manual row-copy restore is then simulated into a FRESH Code.gs
runtime. Every header and cell is compared. Assignees, dates/windows, statuses,
submission IDs and the contact-event link are checked. Replaying the original
create/contact requests must add nothing and must not reset the restored
assignment or history. Another case exercises normal same-day replacement and
header-only datasets, distinguished from sheets that never existed. Source
rows are not mutated. No native phase, real backup or Google operation is run.

These are deliberately bounded tests, not certification of the whole nightly
job. They do NOT prove atomic/coherent capture across the sheets, recovery
from an interrupted same-day replacement, native Sheets formula/type/format
semantics, scheduled execution, backup permissions or live restoration. The
current helper clears an existing same-day snapshot before rewriting it; this
change neither modifies that behavior nor claims interruption safety. Those
recovery gates remain open and must be considered before relying on a real
restore. A passed row-copy test alone must never be called full recovery.

## Validation attribution

Both new JavaScript files pass local `node --check`. The first checkpoint
08acacc97bc6c9d19b5453df9c8b81d8f1a752dd passed the full existing GitHub Actions
suite: 3,618 passed, 0 failed, 0 skipped, run 40914816967 / job 123592105130.
The install step reported zero vulnerabilities. That checkpoint includes the
export tests, NOT the later round-trip file. The expanded candidate requires
its own exact-head CI; final evidence is recorded on PR326 without inheriting
the earlier count. Preparation cannot clone the complete repository, so the
ordinary repository CI is used instead of starting another agent session.

## Open lanes

Tasks/Activity native scheduled-run and coherent restore evidence, authenticated
screen performance, and real staff use remain unverified. Continue the existing
ACCEPTANCE matrix and ten-system roadmap; do not open a second design/program
plan. No new credentials or approvals are requested for these synthetic tests.
