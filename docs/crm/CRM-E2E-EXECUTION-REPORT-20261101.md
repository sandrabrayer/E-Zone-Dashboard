# E-ZONE CRM-E2E-01 — Execution evidence and release-blocker register (2026-11-01)

**Purpose:** distinguish actual technical tests from business acceptance for Dashboard + Outpatient + Therapists. Owner: E-ZONE One central architecture. Central issue [#339](https://github.com/sandrabrayer/E-Zone-Dashboard/issues/339). Original 60-scenario checklist: [CRM-E2E-ACCEPTANCE-PLAN-20261101.md](CRM-E2E-ACCEPTANCE-PLAN-20261101.md). This report does not assert a production write or live customer acceptance.

## Snapshot of work carried out

| Workstream | Current evidence | Classification |
|---|---|---|
| Dashboard production-source baseline | GitHub deploy branch `claude/build-ezone-dashboard-QOg5s` at `f406f39a`, after merged #337/#338; no Railway+Apps Script live authenticated comparison performed | SOURCE SEEN; live deploy unverified |
| Dashboard standalone reproduction | #342: synthetic tests show shared family phone or same full name can pick a wrong lead; CI success on old code | PASS (reproduction of bug), NOT fix; PR closed without merge |
| Dashboard P0 fixes | #343/#344 drafts were combined in #345; #345 standalone synthetic Chromium + full Node CI + billing browser + workflow validation passed | PASS-SYNTHETIC (draft only); #343/#344 closed without merge |
| Dashboard latest Work acceptance integration | [DRAFT #346](https://github.com/sandrabrayer/E-Zone-Dashboard/pull/346) integrates #345 P0 + Work F1–F4 from #334, preserving existing F5 stronger handoff state | DRAFT; exact-head CI status is the authority |
| Outpatient deployed-source baseline | `claude/youthful-volta-laarnk` @ `a487a3a8`, OP-CRM-1 only merged | SOURCE SEEN; no authenticated user walkthrough in this review |
| Outpatient CRM capability chain | #142–148 stacked DRAFT, `#148` CI Test completed success at `2520d957` | PASS-SYNTHETIC (draft only); NOT LIVE |
| Outpatient payment period | #152, tests/doc #153, read-only model #154; #154 CI Test successful | POLICY/SOURCE CORRECTION still BLOCKED; NO financial writes approved |
| Inter-app source identity/status | Dashboard #329/#330, Outpatient #137/#138/#145 still DRAFT | NOT ACTIVE; cannot claim delivered/accepted/contacted/started |
| Outpatient backup/restore | OP-03 #125/#139/#140 drafts; #139 tests green but real isolated restore not proven here | RELEASE GATE BLOCKED |

## Business workflow gates (60 named scenarios)

**Dashboard D01–D30** — validated by static source inspection and existing synthetic tests where explicitly mapped; *no complete authenticated live click→write→reload→other user read set was performed*. Key source-level fixes staged: D14/D15 direct admission identity P0; D23 handoff pending P0; D02/D08/D09/D10 Work F1–F4 draft; D16 intake + `appendFunder` two-step save remains an unresolved partial-failure risk; D21 discharge → Patients save → handoff remains a multi-step recovery-risk scenario; D25 old-cycle payment fix merged #335 but real business acceptance unverified. Every other scenario remains **LIVE-UNVERIFIED** until executed in a private approved staging environment.

**Outpatient O01–O20** — existing deployed OP-CRM-1 plus source code covers legacy leads/clients/treatments/finances; the planned full task/contact logs and money scoping are draft-only #142/#143/#144. New Outpatient read-return #145 is draft; paid-through business policy #152 is not fixed by draft #154. Real therapist session→Outpatient save and complete workflow across roles have not been observed in this audit. Classification: **DRAFT-TESTED for named PR coverage; LIVE-UNVERIFIED otherwise**. Do not equate test suite pass with actual production operation.

**Cross-app X01–X10** — no complete two-way source acknowledgment was verified live in this audit. X05 (Dashboard sends to Outpatient) has source code and status sent only; X06 (Outpatient return status) draft-only; X08 (Therapists session outcome to Outpatient) documented+tested synthetically in its own repo but real cross-user observation pending; X09 invoice proof from Hashavshevet is not integrated. Classification **SOURCE/DRAFT ONLY** until exact source IDs, auth, time-of-source, retry, ack and independent second-user read are confirmed.

## Evidence checklist per test completion

An item can become `PASS-E2E` only with: (1) exact live or staging SHA/Service Worker/Apps Script version; (2) synthetic/pseudonymous patient or authorized test account; (3) expected result and actual click/response; (4) backend authoritative row and stable IDs; (5) reload and second role read, field permission negatives; (6) downstream acknowledgment; (7) timeout/replay no duplicates; (8) no real PII in recorded screenshots/logs. Unavailable source is `UNKNOWN` not count zero. This is mandatory before claiming application readiness.

## Open P0/P1 items preventing final production signoff

1. **P0 / cross-app person identity:** #346 candidate mitigates immediate unsafe Dashboard UI auto-link; authoritative exact IDs and Outpatient pre-discharge linkage remain draft.
2. **P0 / unknown Outpatient continuation:** #346 keeps source-visible missing handoff follow-up; real status acknowledgment #145 + Dashboard consumer and final acceptance not active.
3. **P0 / Outpatient operations and field-level finance:** staged #142–148 require secure release, real role tests and full OP-03 coverage before activation.
4. **P0 / backup and recovery:** verify a complete, isolated OP-03 restore and Dashboard Tasks/Activity backup coverage before any schema/Apps Script release.
5. **P0 / billing policy:** Outpatient #152 payment date vs coverage period needs authoritative source+client consistency before changing records.
6. **P1 / partial writes:** Dashboard direct admission save→funder and discharge audit→Patients status→Outpatient handoff require a durable error/reconcile queue and idempotency tests; no silent `true` if only one step succeeded.
7. **P1 / users:** Vered, Dana, Ortal and the professional clinic team must complete scripted workflow walkthroughs, including mobile and intermediate 960/1024px widths in an isolated staging setup.

## Release policy

No automatic Merge/Deploy, Apps Script changes, role grants, financial recalculation, live data repair, background reminder trigger or unsupervised customer messages are permitted by this audit. Dashboard draft #346 and outpatient draft chains are separate; integration/dependency and backup gates must be explicitly approved. The focus remains **restore reliable CRM operation**, not starting a third CRM engine or parallel task/financial store.
