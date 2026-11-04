# E-ZONE One | CRM Business Journey & Work Queue — 2026-11-02

**Owner:** CRM-PRODUCT-FLOW-01 [#350](https://github.com/sandrabrayer/E-Zone-Dashboard/issues/350) · **Source audit matrix:** [PRODUCT-CAPABILITY-GAP-MATRIX-20261102.md](PRODUCT-CAPABILITY-GAP-MATRIX-20261102.md). **Status:** UX and business process specification (proposed unless previously decided by Sandra), **not an implementation approval**.

## 1. Product principles that govern each screen

1. **One accountable work item per business need, not one to-do per click.** A contact event changes Activity; a follow-up belongs in the existing Tasks engine; a manager report belongs in Leads; payment truth belongs in Payments; discharge belongs in Patients + DischargedPatients. An aggregated queue reads these states but never creates duplicate task records as an undocumented side effect.
2. **Business status ≠ next action ≠ alert.** Example: 'visit scheduled' is a business phase; 'manager to submit report' is an action; 'report 2 days overdue' is an alert. A manager report marked 'seen' means only that it was read, never that the family accepted.
3. **Do not overload the `paid` lead stage.** In the shipped code `paid` is labelled `בטיפול פעיל` while Managers `STAGE_LABELS.paid` is `שילם מקדמה`. Until stage consumers are mapped, preserve the storage token; derive separate read-only labels from authoritative payment/admission evidence, with `unknown` when not available. No direct rename.
4. **An exact stay identity is necessary.** A person can have several inquiries, residential stays or Outpatient episodes. Caller, patient and payer may differ. Name or phone similarity is only a warning, never the evidence for an automatic link.
5. **Full write confirmation:** click → authenticated action → server source acknowledgment for exact ID/version → authoritative read after reload → independent second authorized reader → receiving app's separate acknowledgement. On timeout: `unknown`, not success or an invitation to repeat a non-idempotent operation.
6. **Vered overall relationship owner.** Operational assignee may be Dana or a manager. Ortal owns verification only. Sandra/Ron must have identical permitted management READ data, while separate write/approval scopes remain enforced server-side. Existing discrepancies between `docs/crm/SPEC.md` D1/D5 and later E-ZONE One role rules need a superseding decision record before implementation.
7. **No misleading financial state.** Recorded receipt, verified money, receivable, funder, due date, old arrears, credit, invoice requested and accounting-issued invoice are all distinct. Historic data remains discoverable after discharge.
8. **No silent empty state.** Any failed source yields `— / המידע אינו זמין` and a retry with source time, never 'nothing to do' or '0'.

## 2. End-to-end workflow contract

| Step / source | Entry condition and must-have fields | Primary action + owner | Source acknowledgment / next | Failure and exception |
|---|---|---|---|---|
| A1 New inquiry, Leads | New inquiry, patient name + call-back number + owner; caller and relation, service/house, source where supplied | Create, Vered or authorized delegate | Exact `leadId` stored, source available after reload; create contact or scheduled first call | Duplicate phones/names flag review; no fuzzy-link; pending contact if no source activity |
| A2 First attempt, Activity | Lead exists; with whom, when, channel and outcome | Log contact, Vered/Dana | Exact `eventId` from `logContact`; one NextTask with due date or reason for 'none' | Phone not answered is an attempt, not an answered contact; no unauthorized financial field |
| A3 Qualification, Leads/Tasks | Correct service/house eligibility, contactability, family decision | Select next action or reasoned close/waitlist | Assignee, next due and reason, archive reversible; waitlist remains visible | Incomplete facts not treated as rejection; reassign doesn't reset original age |
| A4 Schedule meeting, Leads/Calendar | Service/house selected; manager and visit date/time | Set/reschedule/cancel, Vered | `visitDate/visitTime/meetingWith` source-backed; manager's own-house view sees it | `visit` stage without date = actionable exception; date past ≠ held |
| A5 Meeting occurred? Leads + /meeting-report | Scheduled appointment's outcome explicitly known, separate `held`, `no_show`, `cancelled`, `rescheduled` | House manager reports professional result; Vered handles attendance and family contact | Current manager report stores `meetingReportOutcome/Note/Reporter/ReportedAt`; reviewed state `meetingSeen` | Manager has `no_show` label 'לא הגיע / בוטל'; CRM result lacks no-show. Do not auto-map to held |
| A6 Family decision, Leads/Tasks | Professional report received or pending, family response known or missing | Vered records thinking/approved/not fit/etc. with due date for unresolved | `meetingOutcome` + task when pending; reading report doesn't close work | Report unread, waiting report, undecided family remain distinct visible cards |
| A7 Commercial readiness, Leads/Payments/Funders | Chosen house/service and planned date, agreed price, contract/consent status, payment reporting/verification | Vered coordinates; Ortal verifies; Sandra exceptional approvals | Proven receipt is separate from invoice and actual admission; payer linked to person/stay as proper | New lead stage `paid` alone isn't source proof; paid/no admission even without date demands decision |
| A8 Actual admission, Patients/Leads/Funders | Explicit matching lead or authorized direct-add with stable ID | Confirm actual entry and payer, authorized user | `Patients.id/fromLead` plus verified funder row with original key; source read + occupancy | Admission succeeded but funder did not → partial completion queue; never re-admit just to fix funder |
| A9 Residential stay, Patients/Managers/Coordinators | Active patient/stay, house | Track attendance, transfer, operational notes, planned discharge | One owning system per object and exact stay ID, house scope | Missing feed must be 'unavailable'; historical stay remains for billing |
| A10 Discharge planning, Managers | Approximate date or `none`, manager accountability | Manager updates `ManagersExpectedDischarge` | History appended, conflict on `previousDate`; **not** actual discharge | Unknown planned date ≠ discharge; preserve original and last update |
| A11 Actual discharge, Patients/DischargedPatients | Verified departure date and disposition | Authorized discharge source, not a second source created by CRM | One audit + `Patients.status=released` + released occupancy, verified in independent read | If audit succeeded and status failed, one unresolved exception; block second fresh audit by same ID pending reconciliation |
| A12 Financial closure, Payments/Credits | Real cycle and coverage, reported/confirmed receipts, credit policies | Ortal reconciliation, Sandra exceptions | Source-owned amount + receivable + verified payment separately; post-discharge history still viewable | Discharge date can equal billing anchor: never label a newly projected full cycle 'November debt' without policy and coverage explanation |
| A13 Handoff to Outpatient, Dashboard→OP | Proposed before discharge, patient consent & destination | Vered initiates, Outpatient accepts and performs contact | Exact handoff/episode IDs + distinct milestones: `offered→sent→accepted→contacted→scheduled→held/no_show→result→actual treatment start` | `sent` not `accepted`, `accepted` not `started`; no false task close, retry idempotently on same key |
| A14 Outpatient plan, Therapist sessions | Outpatient episode/plan exists, authorized therapist, service scope | Outpatient owns plan/payment, Therapists scheduling/attendance | Source evidence for actual treatment and renewal; management view consumes only allowed fields | No parallel session scheduler or financial ledger; preserve OP-03 restore gates |
| A15 Discharged/alumni relation | Completed episode, follow-up or potential new inquiry | Vered outreach by consent; task-based plan, no auto-send | Next scheduled contact with owner or documented reason for none | Historical patient remains searchable; never imply continued treatment without source |

### Definition of 'done' for each work item
- **Call task** closes on a confirmed call/contact event or explicitly documented cancellation, not merely when an attempt is written (depends on task outcome).
- **Meeting task** closes on confirmed 'held' report and recorded family follow-up decision, or reasoned cancel/no-show workflow, not on passing date.
- **Admission task** closes on source patient/stay admission, mapped lead, funded/financial completion separated; pending pieces remain open.
- **Collection task** closes only on the authorized financial source condition (receipt verified, status resolved or policy-approved adjustment), not on note.
- **Discharge task** closes on both status and audit; financial close and Outpatient continuation are **parallel processes** that remain open independently.
- **Handoff task** closes only at the required downstream milestone — receiving 'sent' by itself is not enough.

## 3. Vered's `היום שלי` — screen contract

**Screen hierarchy:** (1) small compact KPI strip; (2) 'דורש פעולה עכשיו' ranked by actual due and exception; (3) row-based work list; (4) 'ממתין לגורם אחר'; (5) navigation to historical/completed work. No duplicate tiles and lists with conflicting definitions. The 'Today' screen should be useful but need not dominate Vered's day.

### Reusable source contract for tiles (don't invent values)
| Tile | Exact source and acceptance meaning | Drill-down | Missing-source state |
|---|---|---|---|
| `גבייה לביצוע` | debtAging owed cycles + open authorized collection Tasks + flagged receipt exceptions; exclude Ortal verification-only receipts | Filtered actionable rows, oldest/highest-risk first, one-click account | Unavailable or partial, never 0 |
| `ממתין לאימות אורטל` | reported receipts pending actual confirmation | Read-only queue with Ortal as next owner | `—` when getPayments not reliable |
| `שיחות ומעקבים` | `getTasks(status=open)` kinds call/followup, due past or today | Open contact form with previous note, exact taskId, owner and due | `—` when tasks unavailable |
| `פגישות היום` | `Leads.visitDate == today`, not inferred held | Open exact lead on meetings tab | Calendar/stale-state warning |
| `פגישות ללא תאריך` | scheduled stage but empty `visitDate` | 'קביעת תאריך' on same lead | Count source-backed |
| `אחרי פגישה` | manager report missing, unread, or read but undecided; separate sublabels | Manager report and decision on source lead | No date-only auto-close |
| `פניות חדשות ללא מגע` | lead stage new + proven absence in contactIndex + no open call task | Triage or direct first contact; same priority/SLA across screens | `—` if contactIndex or Tasks unavailable |
| `חריגי בתים` | paid but not admitted, source mismatch, discharge/continuation integrity | Exact lead/stay with reason and owner | If source incomplete, show 'not verified' |
| `השלמות אחרי שחרור` | unmatched discharge/audit, debt/credit work, outpatient not accepted/started | Distinguish three independent workstreams | Handoff not complete by disappearance of one row |

### Row shape, same for every department
`{sourceApp, sourceType, sourceId, subjectKind, subjectId, displayName, operation, why, owner, assignee, dueAt, originalDueAt, sourceUpdatedAt, lastContactAt, lastContactResult, state, nextAction, ackLevel, href}`. **View-layer projection only.** User sees name + action + reason, deadline, previous note, owner, right action button, and saved status. Money fields are omitted at the server for unauthorized principals; a hidden column is insufficient.

### Work prioritization proposal (requires product approval)
1. **Safety/data integrity** exceptions (partial admissions, orphan discharge, financial ambiguity).
2. Binding meetings/calls today with time commitments.
3. Past-due dated tasks, ordered by original due date (oldest first).
4. New inquiries without actual contact, prioritized by SLA threshold from first intake; default cannot be assumed from `created` alone.
5. Waiting for external role or no due date. Each such row has an owner and review reminder or documented reason.
The existing Today `newLeadsNoContact` sorts newest-first and Triage `triageQueue` sorts oldest-first. Pick **one policy** after measuring missed contact age, without another queue engine.

## 4. Critical UX acceptance
- **Every button** must match its intended action: navigation, card opening, save/cancel, prev/next stage, meeting result, contact log, defer, refund, Outpatient send. A click-only test is not enough.
- Save: display `שומר…` while in flight; state after success must reflect exact source ID; exceptions retain text/selection; any lost reply shows `מצב לא אומת`, not generic 'try again' for non-idempotent writes.
- Drawers must be visible at widths 1440 / 1280 / 1024 / 960 / 768 / 390 px, in Hebrew RTL, at zoom 125% as an optional usability variant. Keep filters and scroll position when a record is opened and closed.
- Profile tests: Vered, Dana (NO money), Ortal (only finance/allowed client attributes), Manager own-house, Sandra/Ron same management read with distinct action permissions.
- Distinguish read-only changes on draft code from signed-in tests in staging. Production data changes are **not** authorized.
- Old/new CRM parity: equal authorized source views on the same asOf, same patient/stay, role and filters. Differences must be explained by projection/period instead of silently dropped. Includes **released** patients and old balances.
- Each KPI has label, formula/data source, refresh timestamp, filters and one actionable list. Income tiles remain on both Dashboard and Outpatient.

## 5. Cross-application ownership and no work duplication
- **Dashboard** owns Leads, Patients, DischargedPatients, its own Tasks/Activity and finance records.
- **Managers** already collects intake reports via Dashboard `/meeting-report`, expected discharge dates via own-house protected writes, family calls, events; [Managers #63](https://github.com/sandrabrayer/ezone-managers/issues/63) remains its audit. Do not retire any existing write until new app proven.
- **Coordinators** supplies roster and actual departure entries under its own secure endpoint; no new CRM writer.
- **Outpatient** owns own lead/client/episode/treatments/billing. [Outpatient #149](https://github.com/sandrabrayer/ezone-outpatient/issues/149) is its product assessment; #142–148 and identity #137/138 are DRAFT, not production.
- **Therapists** owns its appointment/attendance operations; no second calendar engine.
- **Hashavshevet** owns accounting issuance. `invoiceRequested` not equivalent to `invoiceIssued`.
- **E-ZONE One** view unifies authorized read and actions only via the existing domain owner; **Ron and Sandra management-read parity** needs reconciliation with obsolete decision D1 that says otherwise.

## 6. Freeze line before implementation
No stage token rename; no money calculation/credit rule rewrite; no auto-backfill; no direct production mutations; no new consent schema, no live automatic notification, no cross-app merge or deploy from this work package. Features are `PROPOSED` until approved. Safe next steps are backlog priorities, synthetic tests and one scoped change per app after release dependencies are known.
