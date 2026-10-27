# CRM restructure — linked apps (spec §12–§13)

**Session A, 2026-10-27. Docs only.**

**Evidence rule:** every statement comes from the feeds mapped in
[CURRENT-STATE.md](CURRENT-STATE.md) §5, or from this repo's docs
(`EZONE-ECOSYSTEM-STATUS.md` = ESS, `DIGEST-CONTRACT.md` = DC, `DEPLOY.md`).
**UNKNOWN** means no evidence was found in this repo. Nothing was guessed.
The sibling repos were not read, except for the Outpatient PR heads in CURRENT-STATE §7.

## Relation summary

| App | Relation to the Dashboard | Evidence | Deployed branch (ESS:362-431) |
| --- | --- | --- | --- |
| ezone-managers | **Direct**: it calls Dashboard Apps Script (read + write) | `MANAGERS_WORK_SECRET`; Code.gs:1554, 15271 | `main` |
| ezone-coordinators | **Direct, both ways** | `COORDINATORS_*` secrets; ActivePatients and ManagersHouse digests | `main` |
| ezone-outpatient (מטופלי חוץ / אמבולטורי) | **Direct**: the Dashboard writes `createLead` to it. Also a shared revenue-rule contract. | `server.js:487-538`; ESS:833-905 | `claude/youthful-volta-laarnk` |
| ezone-therapists | **Direct**: it reads two rosters and creates leads | Code.gs:7648, 7678, 7730 | `claude/inspiring-tesla-jipobw` |
| ezone-staffing | **Direct (read)**: Dashboard Apps Script reads house costs from it. **Indirect** through the coordinators' digest. | Code.gs:15745-15770 | `main` |
| kitchen (מטבח) | **None found** (only "the digest pattern was proven with kitchen", Code.gs:17314) | — | `main` |
| logistics (לוגיסטיקה) | **None (data)**. It has its own sheet and its own `/dashboard` board, which staff may confuse with this app (issue #120). | CHANGELOG-healthz-deploy-identity.md:9-51 | `main` |
| hadrachot (הדרכות) | **UNKNOWN**: not found in this repo | — | UNKNOWN |
| helpdesk | **Indirect (monitoring only)**: it checks `/healthz` `ok:true`; triage maps the word "dashboard" to this repo | CHANGELOG-healthz-deploy-identity.md:31-32, 68-71 | UNKNOWN |
| finance (כספים, planned) | **Planned / partial.** Read feeds `accountingPayments` / `accountingCredits` exist (`ACCOUNTING_SECRET`); the separate accounting app was superseded on 01/10 by «בקרת גבייה». A "כספים" app by that name: UNKNOWN. An Outpatient accounting feed is planned (`docs/billing-control-plan.md` §13). | ESS:907-949; plan:122-139, 660-714 | — |

---

## 1. ezone-managers (מנהלי בתים)

| # | Question (spec §12) | Answer |
| --- | --- | --- |
| 1 | Who uses it, and what do they do | House managers: own house only (`mwScopeHouse_`). Admins Sandra and Ron: all houses. They work occupancy and bonus facts, family calls, staff talks, events, follow-ups, expected discharges, half-yearly feedback, the team, house cost and committees (read). Meeting outcomes are reported on the Dashboard's own `/meeting-report` page. |
| 2 | What it receives, and from where | Dashboard Apps Script: `managersOverview`, `managersHouse`, `occupancySnapshots`, `managersWork.houseData` (patients, visits incl. +14 days, expected admissions, logs, team, committees, feedback). Committees and meeting summaries arrive via the Dashboard's fetch from coordinators. House cost arrives via the Dashboard's fetch from staffing. |
| 3 | What it returns | It writes to Dashboard sheets: ManagersFamilyCalls / StaffTalks / Events (append, soft delete), ManagersExpectedDischarge (append history, `previousDate` conflict check), ManagersFeedbackLog. Meeting reports go via `/meeting-report` into the Leads `meetingReport*` columns. |
| 4 | Linking ids | House key `raanana/ramot/efroni/rehab/pardes` ↔ Patients `houseId` (`MANAGER_HOUSE_TO_PATIENTS_HOUSE_ID`, Code.gs:123). Patients are linked by **house + name + entryDate** (not Patients.id). Lead id on visits. `actorId` per manager. |
| 5 | Who owns each shared datum | The Dashboard owns Patients, Leads (incl. meetingWith) and the Managers tab. Managers owns its log sheets and expected-discharge dates. Coordinators own committees. |
| 6 | What depends on it | Dashboard «שחרורים צפויים» (`expectedDischarges`); bonus math (Managers frontend); intake-meeting and referral bonus facts; meeting-report reporter list (`currentManagers_`). |
| 7 | What the CRM changes | **Nothing on day one.** The CRM must not rename meetingWith, stages or meeting fields that `houseData` / bonus facts read. A future «דיווח מנהל» task (spec §9, §13) reads the existing Leads meeting-report columns. D3: managers would log into a CRM surface with their existing ezone-managers passwords; this needs the identity design in PERMISSIONS-MATRIX §6.8. |
| 8 | Missing, stale or failed data | Writes use `tryLock` → `lock_busy`. A stale `dischargeSet` → `conflict`. Team, cost and committees → `available:false` with a reason, never 0. A missing secret → `unauthorized`. |
| 9 | Evidence a process finished | Meeting report: `meetingReportedAt` set (and `meetingSeen` once Vered reads it). Expected discharge: the latest ManagersExpectedDischarge row. Log follow-up: `followUpDone='1'`. |

Open follow-ups from the docs:
- Managers must filter visits on `inSelectedMonth !== false` (ESS:75-76).
- Protocol-2 rollout steps 6–7 are pending per `docs/managers-hardening-rollout.md`, although the code is already in this head.

## 2. ezone-coordinators (רכזים)

| # | Question | Answer |
| --- | --- | --- |
| 1 | Users / work | Coordinators see a per-house patient list, record discharges, own committees, and write the ManagersHouse team digest (shifts, staff, therapist week). |
| 2 | Receives | `getPatientsForCoordinators` (`id, name, house, active, admissionDate, dischargeDate`; active patients plus releases from the last 30 days; no phone, no billing). The ActivePatients digest (house, patientName, patientId, updatedAt). `getCommitteesForCoordinators` (legacy import). |
| 3 | Returns | `recordDischargeFromCoordinators` (`id, dischargeDate, reason, by`) **writes Patients, the discharge row, an auto refund Credit and AuditLog, effective immediately**. Committees and meeting summaries are fetched by the Dashboard for Managers. The ManagersHouse digest is read by the Dashboard. |
| 4 | Ids | Patients `id` (immutable). Discharge row id `coord-<patientId>-<date>`. Digest `patientId` from houseId + name + entry date (DC:51). Canonical house ids (DC:64-79, 137-138). |
| 5 | Ownership | The Dashboard is the sole writer of ActivePatients. Coordinators own committees and the team digest. The discharge write is executed by Dashboard Apps Script on the coordinators' request (Sandra's decision 2026-10-04: no Vered confirmation). |
| 6 | Depends on it | Occupancy, the Managers feed, the digest, «🚪 שחרורים מהבתים» (Vered: billing and refunds), auto refunds, the Managers `team` and committees. |
| 7 | CRM changes | A coordinator discharge becomes an **"actual exit"** event (spec §9) in the client timeline and opens **account closure**. Known gap: it writes `disposition:''`, so it never auto-sends to Outpatient. The CRM continuation flow must show this as an open «המשך טיפול» item. No contract change planned. |
| 8 | Missing / failed | Same-date repeat → `alreadyDischarged`; another date → `already_discharged`. A digest failure never breaks the save. The feeds are fail-closed (`bad_contract`); the Dashboard card shows «לא זמין». |
| 9 | Evidence | A discharge row with `dischargeSource='ezone-coordinators'` plus Patients `status=released`. |

## 3. ezone-outpatient (מטופלי חוץ / אמבולטורי)

| # | Question | Answer |
| --- | --- | --- |
| 1 | Users / work | Outpatient staff and the «אמבולטורי» coordinator (Shachar with Oren). They run outpatient treatment and billing. The details of its users are UNKNOWN here. |
| 2 | Receives | `createLead` from the Dashboard server (`OUTPATIENT_LEAD_URL` / `OUTPATIENT_LEAD_SECRET`): name, phone, note, house key (discharge) or no house plus `source` («אמבולטורי» meeting). |
| 3 | Returns | The `createLead` answer. `outpatientId` is logged in AuditLog details only; the Dashboard stores no Outpatient id. Nothing else is proven. Whether Outpatient calls `getAdmittedRoster`: UNKNOWN. |
| 4 | Ids | AuditLog idempotency key `discharge:<dischargeId>` or the lead id. **No stable cross-app client id.** The planned accounting crosswalk depends on it (plan §13.1 item 5). |
| 5 | Ownership | The Dashboard owns the handoff event. Outpatient owns the outpatient client, sessions and billing. Spec §8: linking is not permission to edit. |
| 6 | Depends on it | «העבר לאמבולטורי» on discharged rows; the meetingWith «אמבולטורי» warning; `outpatientMissingReportNow`; the monthly-revenue network total (a shared rule, not a data link). |
| 7 | CRM changes | Spec §9 «המשך טיפול»: handoff opened → accepted at destination → contact → meeting set → **verified start of treatment**. Today the Dashboard knows only "sent / failed". The later steps need a **read-only Outpatient feed** (the draft Outpatient PR #114 adds projections) and a stable link id. That is a cross-app change, kept out of Sessions B and C. **OP-03 (Outpatient #125) is open; the `createLead` contract must not change meanwhile.** |
| 8 | Missing / failed | Not configured → 503. Timeout 20 s. No phone → `no_phone`. The save always succeeds and Vered gets a warning. Retry by «העבר לאמבולטורי» or on the next save. An in-flight guard returns 409. The send log is AuditLog `outpatient_lead_sent` / `outpatient_lead_send_failed`. |
| 9 | Evidence | Today: AuditLog `outpatient_lead_sent`. Spec: a verified treatment start in Outpatient, not yet readable. |

Open follow-up from the docs: verify that Outpatient accepts a lead with an empty house (ESS:59-60).

## 4. ezone-therapists (מטפלים)

| # | Question | Answer |
| --- | --- | --- |
| 1 | Users / work | Therapists. Their «בוגרים» alumni outreach; they create a lead when an alumnus needs care. |
| 2 | Receives | `getAdmittedRoster` (`sourceApp, name, phone, house, entryDate`). `getDischargedRoster` (+ `exitDate`, 730-day window). The phone comes from Patients.fromLead → Leads.phone, else the PatientPhones sheet. |
| 3 | Returns | `createLeadFromTherapists`: a new Leads row (`id-<16hex>`, source `alumni_therapists`, `assignedTo` ∈ ורד/שירן/יעל), idempotent by phone. |
| 4 | Ids | Normalized phone; lead id. |
| 5 | Ownership | The Dashboard owns Leads. Therapists owns its own records. |
| 6 | Depends on it | The lead board (new leads appear), assignee views. |
| 7 | CRM changes | Therapist-created leads show as a «פנייה» with source chip «מטפלים», assignee preserved. No contract change. The CRM must keep `assignedTo` values and `alumni_therapists` source semantics. |
| 8 | Missing / failed | Fail-closed `unauthorized`. `invalid_phone` / `invalid_name` → AuditLog `lead_handoff_refused`. `lock_busy`. |
| 9 | Evidence | The lead row exists (or `alreadyExists`). |

## 5. ezone-staffing (סטאפינג)

| # | Question | Answer |
| --- | --- | --- |
| 1 | Users / work | UNKNOWN here (staffing / shifts). |
| 2 | Receives | Nothing from the Dashboard. |
| 3 | Returns | `getHouseCostsForManagers` house totals (projectedTotal, actualConfirmed, estimated, missingDataCost, instructorsCost, budget, stale…) to Dashboard Apps Script (`STAFFING_COST_SECRET`, sent in the querystring). |
| 4 | Ids | Staffing house ids mapped to Managers keys (Code.gs:15751). |
| 5 | Ownership | Staffing. |
| 6 | Depends on it | The Managers `houseCost` card only. |
| 7 | CRM changes | **None.** Not a client-facing datum. |
| 8 | Missing / failed | `available:false` with a reason, never 0. Cached 10 min; a stale answer is not cached. |
| 9 | Evidence | n/a |

## 6. Kitchen · Logistics · Hadrachot · Helpdesk

| App | Relation | CRM changes | Notes |
| --- | --- | --- | --- |
| Kitchen | None found | None | UNKNOWN beyond the deploy branch. |
| Logistics | None (data) | None | Naming confusion: its `/dashboard` ≠ this app. Keep the CRM name distinct in Hebrew UI copy. |
| Hadrachot | UNKNOWN | UNKNOWN | Not found in this repo. Coordinators keep `TrainingRecords` (ESS:454), with no Dashboard link. |
| Helpdesk | Monitoring | **`/healthz` must keep `ok:true`** and stay public. A `CRM_ENABLED` flag must not change `/healthz` or `/api/version`. | Triage keyword "dashboard" → this repo. |

## 7. Finance (planned כספים / accounting)

| # | Question | Answer |
| --- | --- | --- |
| 1 | Users / work | CPA / accounting. In the Dashboard: Ortal in «בקרת גבייה». |
| 2 | Receives | `accountingPayments` / `accountingCredits`: incremental by `updatedSince` + `cursor`, tombstones, no clinical data. |
| 3 | Returns | Nothing. The Hashavshevet (חשבשבת) document number / issuance evidence has **no feed** (`docs/billing-document-evidence.md`). |
| 4 | Ids | `paymentUid` (`pmt-<uuid>`), `patientUid` (Patients.id), `creditUid`; `payerUid` always blank. |
| 5 | Ownership | Hashavshevet owns the accounting document (spec §10). The Dashboard owns reported and verified payment status. |
| 6 | Depends on it | Unconfirmed external consumer; `scripts/accounting-smoke.js`. |
| 7 | CRM changes | The spec §10 «מעקב מסמך» step needs **issuance evidence from the authoritative source**. Not available, so the CRM must show "invoice requested", never "issued". **The feed is not in `OPEN_ACTIONS`: it breaks when `enforce` is turned on, so decide before Phase 0b-3.** |
| 8 | Missing / failed | Fail-closed on its secret. |
| 9 | Evidence | Today none for issuance. Needs an agreed evidence field or feed. |

---

## 8. Processes that must keep working (spec §13)

Each process is listed with the asset it depends on today; the CRM must not break that asset.

| Process | Depends on |
| --- | --- |
| Manager report after the intake meeting, also before admission | Leads `meetingReport*` columns; `/meeting-report`; 14-day window for admitted leads |
| Admission, occupancy, exit, house moves | `saveAll` → Patients (`replaceHousePatients_`), the single house rule `resolveHouseId`, direct-lead `dl-<id>` |
| Handoff to outpatient up to a verified start | `/api/outpatient-lead`, AuditLog send log (verified start: not yet readable) |
| Meeting outcome → billing → info back to other apps | Leads `meetingOutcome` / `meetingWith` → bonus facts (Managers) → Patients `pay` → Payments cycles |
| Vered report → Ortal verification → document tracking | Payments receipt row: `recordedBy/At` → `confirmStatus/By/At` → `invoiceWanted/To` |
| Calculations, reports, alerts | debt aging, refund forecast, revenue, digest, reminders, integrity job, occupancy snapshots |
| House and role separation | Today: house-level only inside ezone-managers. Role-level as in PERMISSIONS-MATRIX. |

## 9. Fields and events the CRM will touch, and who consumes them

| Field / event | Consumers today | Required adjustment |
| --- | --- | --- |
| Lead `stage` values | app kanban, funnel, `recStage_`, `mwHouseData_` (expected admissions), bonus facts, `isOpenLeadStage_`, CRM #220 projection | **No renames.** A CRM "stage" label maps onto existing values (spec §6: an explicit mapping is required). |
| `meetingWith`, `visitDate`, `meetingOutcome`, `meetingReport*` | Managers `houseData` / bonus, `/meeting-report`, meetings board, Outpatient handoff trigger | Read-only in the CRM shell until a mapping is approved. |
| Patients `status` / `exitDate` | occupancy, Managers, coordinators digest, rosters (therapists), refunds | No change. |
| Payments `confirmStatus` | «בקרת גבייה», reminders, accounting feed | No change; the CRM reads it. |
| **New Activity events** (Session B) | none yet | Append-only. No sibling app reads them in B or C. |
