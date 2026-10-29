# CRM acceptance evidence — 29 October 2026 (draft)

## Ownership and scope

At Sandra's request, ChatGPT takes the implementation and validation lane to
conserve external-agent credits. The coordination checkpoint is on PR325,
comment 6502457535. No agent mention, new paid-agent task or automated review
is requested by this change. Existing work must be checked before overlap.

This first bounded change adds acceptance tests and documentation only. No
application runtime, Apps Script, workflow, dependency, permission, money rule,
service-worker version or production data changes. OP-03/Outpatient PR125 and
all native-drill evidence remain untouched. Separate production gates remain.

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

## Validation attribution

The new file passes `node --check` locally. Dependency-backed execution and the
full suite are required on this exact draft head; do not inherit the 3,616-test
result from aa4843a. Read the draft PR's current CI result before marking this
acceptance passed. The environment used for preparation cannot clone the full
repository, so ordinary repository CI is used, not another agent session.

## Open lanes

Tasks/Activity native scheduled-run and restore evidence, authenticated screen
performance, and real staff use remain unverified. A successful export suite
does not close them. Continue the existing ACCEPTANCE matrix and ten-system
roadmap; do not open a second design/program plan.
