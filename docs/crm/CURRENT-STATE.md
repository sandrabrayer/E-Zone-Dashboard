# CRM restructure — current state (read-only map)

**Session A, 2026-10-27.** This is a read-only map of what exists today in this repo. Nothing was
changed to produce it.

| Fact | Value (verified 2026-10-27) |
| --- | --- |
| Repo head mapped | `afdb195` = tip of `claude/build-ezone-dashboard-QOg5s` (merge of PR #281) |
| Railway deploy branch | `claude/build-ezone-dashboard-QOg5s`: `/healthz` answers `branch` = that name and `commit` = `afdb195` |
| Live service-worker cache | `v93`, the same in production `/sw.js` and in the repo (`public/sw.js:319`) |
| Test baseline | `npm test` after `npm ci`: 3456 tests, 3434 pass, 0 fail, 22 skipped |
| `npm audit` | 0 high/critical, 1 existing moderate |
| Size | `apps-script/Code.gs` 21,868 lines · `public/app.js` 18,209 · `server.js` 2,291 |

**Status legend**
- **active**: has a live caller or user.
- **dormant**: kept on purpose, but no current caller in this repo (an editor-run tool, an
  external consumer, or a removed UI).
- **dead**: code is still present but can never be reached or used.

Line references are `file:line` at `afdb195`.

---

## 1. Screens (top-level tabs)

All screens live in `public/index.html:107-129`. The client gate is `allowedScreens()`
(`public/app.js:1699-1702`). The server pre-paints a body class per session (`server.js:287-293`):
`view-controller` for Ortal, `view-restricted` for anyone without finance.

| # | Tab | id | Render fn | Who sees it (UI gate) | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | דשבורד | `dashboard` | `renderDashboard` app.js:4873 | everyone except Ortal | active |
| 2 | לידים | `leads` | `renderKanban` 5114, `renderLeadsFunnel` 6130 | everyone except Ortal | active |
| 3 | לוח פגישות | `meetings` | `renderMeetings` 4563 | everyone except Ortal | active (the comment at index.html:244-248, "empty shell", is stale) |
| 4 | מטופלים | `patients` | `renderPatientsTab` 9526 | everyone except Ortal | active |
| 5 | תפוסה (one sub-tab per house + «בית לא מזוהה») | `occupancy` | `renderHouseTabs` 9205 | everyone except Ortal | active |
| 6 | מטופלים משוחררים | `discharged-patients` | `renderDischargedPatients` 7283 | everyone except Ortal. **Vered's tab (Decision D2).** | active |
| 7 | גבייה | `billing` (`data-finance`) | `renderBilling` 13657 | Vered, Sandra. Ortal sees it read-only when the server sends `billingRead`. | active |
| 8 | בקרת גבייה | `billing-control` (`data-billing-control`) | `renderBillingControl` 17815 | Vered, Sandra, Ortal (her first and main tab) | active |
| 9 | הכנסות חודשיות | `revenue` (`data-finance`) | `renderMonthlyRevenue` 14898 | Vered, Sandra | active |
| 10 | שיוך תשלומים | `reconnect` (`data-finance`) | `renderReconnect` 13371 | Vered, Sandra | active |
| 11 | נקודת איזון | `breakeven` | `renderBreakeven` 16757 (stored in localStorage only) | everyone except Ortal | active (a local calculator) |
| 12 | גרף צמיחה | `growth` (`data-finance`) | `renderGrowthGraph` 16430 | Vered, Sandra | active |
| 13 | שימור לידים | `retention` | `renderIrrelevantLeads` 6961, `renderRemovedLeads` 7138 | everyone except Ortal | active |
| — | Global search panel (FAB, `/` key) | `#global-search-panel` | `initGlobalSearch` 3605 | everyone except Ortal | active (client-side over the getData answer) |
| — | `/meeting-report` (a standalone page, not a tab) | — | `public/meeting-report.js` | house managers, behind one shared PIN | active |

### Sub-views

**דשבורד**
- KPI cards.
- «חידושי תפוסה» (finance only).
- Overdue strip (finance only).
- «🚪 שחרורים מהבתים»: coordinator discharges, last 30 days.
- «שחרורים צפויים»: expected discharges, from the Managers app.
- Beds per house.
- Lead pipeline.
- «🟢 קליטת מטופל חדש».
- **Dead:** the «ועדות קרובות» card. `lib/committee-alerts.js` is still served
  (`server.js:370`), loaded (`index.html:782-783`) and SW-cached, but `app.js` never calls it.

**לידים**
- Kanban stages `new` / `visit` / `waitlist` / `paid` (`app.js:24-44`).
- «חתכים בלידים» funnel.
- «לא נקלט כמטופל · N ימים» chip, with a threshold of 3 days (`app.js:5288`).

**לוח פגישות**
- Weekly board with an outcome select.
- Manager-report block with an unseen badge.
- Per-manager conversion strip.
- WhatsApp invite / update.

**מטופלים**
- Filters.
- Problem chips (`PATIENT_PROBLEMS`).
- «ממתינים לקליטה» (`pendingAdmissionRows` 5719), with «קליטה» / «לא נכנס».
- Per-row ✏ / funder / payment-report / «שחרר» buttons.

**מטופלים משוחררים**
- Search.
- «חתכי מטופלים» (`renderPatientRetention` 6649).
- «שחזר» (restore-choice modal).
- Credits.
- «העבר לאמבולטורי».
- Duplicate-discharge delete.

**גבייה**
- KPI cards.
- «השלמת גורם מממן».
- Due list and open list.
- «זיכויים לתשלום» (refund forecast).
- «חובות פתוחים» (debt aging + .xlsx).
- «הכנסות לפי גורם מממן».
- «סיכום חודשי».

**בקרת גבייה**
- Summary cards.
- «בעיות גבייה»: canAccount or canDiscount.
- «להמשך טיפול»: the follow-up queue, plus «תצוגה מקדימה לתזכורות».
- «בדיקת בקשות חשבונית».
- «ממתין לאימות» / «סומנו כבעיה» / «שולם חלקית» / «אומתו».
- «שולם מתחת למחיר».
- «חריגים פתוחים»: Sandra only, `app.js:17926`.
- .xlsx export.

---

## 2. Modals

Every modal renders into `#modal-root`, except PIN admin.

| Modal | Opener (app.js) | Fields | Apps Script action |
| --- | --- | --- | --- |
| קוד אישי חדש (PIN admin) | `openPinAdmin` 1592 | user, pin ×2 | `/api/pin-admin/*` (server only) |
| ליד חדש | `openAddLeadModal` 8256 | name, phone, contact name/phone, house, source, assignedTo, note, meetingWith | `saveAll` |
| עריכת ליד | `openEditLeadModal` 8382 | name, phone, contacts, house, created, visitDate/Time, note | `saveAll` |
| כניסה לבית | `openEntryModal` 8462 | houseId, date, pay, adv, status | `saveAll` |
| הוספת מטופל / קליטת מטופל חדש | `openDirectAddPatientModal` 8712 | name, phone, houseId, date, pay | `saveAll` (auto lead `dl-<id>`) |
| עריכת מטופל | `openEditPatientModal` 8989 | name, phone, houseId, date, pay, status, notes | `saveAll` |
| Close lead / שחרור מטופל | `showCloseLeadModal` 8126 | disposition, date, note, continuity | `moveLeadIrrelevant` / `dischargePatient` (+ `/api/outpatient-lead`) |
| Confirm (generic) | `showConfirm` 8048 | — | `removeLead`, `restoreLead`, `deleteMeetingReport` |
| עריכת דיווח מנהל/ת | `showMeetingReportEditModal` 4342 | outcome, companion, note | `saveAll` |
| עריכת פגישה | `openMeetingEditModal` 4689 | meetingWith, visitDate, visitTime | `saveAll` |
| מחיקת שורת שחרור כפולה | `showDeleteDuplicateDischargeModal` 7456 | reason | `deleteDuplicateDischarge` |
| שחזור מטופל | `showRestorePatientChoiceModal` 7798 | choice | `restorePatientToActive` / `restorePatient` |
| מטופל חוזר | `openReturningPatientSearch` 8618 | search | → direct add (`saveAll`) |
| זיכויים והחזרים | `showCreditsModal` 10412 | status, amount, paidDate, method, decidedDate, month, approvedBy, notes | `saveCredit` |
| סימון זיכוי כשולם | `showSettleRefundModal` 10896 | paidDate, method | `settleRefund` |
| חריגה מהמדיניות | `showRefundExceptionModal` 10940 | amount, reason | `approveRefundException` |
| Duplicate payment confirm | `showDuplicateConfirm` 13515 | — | `savePayment` (void) |
| עריכת פרטי קבלה | `openReceiptEditModal` 15352 | payer, method, reference, invoice, coverage, reason | `editReceipt` |
| ביטול קבלה | `openReceiptVoidModal` 15490 | note | `savePayment` (void) |
| גורם מממן | `openFunderModal` 15616 | funder, effectiveFrom | `appendFunder` |
| דווח תשלום | `openPaymentReportModal` 15759 | amount, receivedDate, funder, method, payer, reference, invoice, coverage | `reportPayment` |

Inline editors (not modals):
- bill amount override: `upsertBillingOverride` / `deleteBillingOverride`
- control decisions: `confirmPayment`
- discount: `setBillingDiscount`
- continuity: `setDischargeContinuity`
- patient row delete: `deletePatientRow`

---

## 3. Apps Script actions (`doGet` / `doPost`)

### How a request is routed

1. `doGet` (Code.gs:1151) and `doPost` (1155) both call `gatedEntry_` (1550).
2. The four Managers actions branch off first. They are POST-only and need `MANAGERS_WORK_SECRET`
   in the JSON body.
3. Every other request goes through `proxyGate_` (1593), the PROXY_SECRET check, and then through
   the `handle_` if-chain (1792–2068).
4. Before dispatch, `handle_` runs the pre-dispatch guards:
   - `viewRefused_` (2194)
   - `financeRefused_` (2172)
   - `roleOperationFor_` / `roleAllowed_` (2246 / 2292)

   **All three apply only to a verified actor.**

**Gate legend**
- **PROXY**: needs `PROXY_SECRET`. In `log` mode an unverified caller is still served (§8).
- **own secret**: the action is in `OPEN_ACTIONS` (Code.gs:1494) and checks its own Script
  Property instead.
- **F** = FINANCE_ACTIONS · **BC** = billing-control capability · **D** = deleter role ·
  **A** = approver (Sandra) · **Acc** = accountant|approver · **V** = verified personal session.

| Action | Gate | Reads (R) / Writes (W) | Caller | Status |
| --- | --- | --- | --- | --- |
| `getData` | PROXY | R: Leads (+2 closed tabs), Patients, BillingOverrides, discharged, Managers, BonusConfig, AuditLog | app.js; `/api/healthcheck` | active |
| `saveAll` | PROXY, no role | W: Leads, Patients, PatientsTombstones, discharged, AuditLog, digest | app.js | active |
| `moveLeadIrrelevant` / `restoreLead` | PROXY, no role | W: Leads ↔ לידים לא רלוונטיים, AuditLog | app.js | active |
| `removeLead` | PROXY + D | W: Leads → לידים שהוסרו | app.js | active |
| `dischargePatient` | PROXY, no role | W: discharged, Credits (auto refund), AuditLog | app.js | active |
| `restorePatient` / `restorePatientToActive` | PROXY, no role | W: Leads / discharged, AuditLog | app.js | active |
| `setDischargeContinuity` | PROXY, no role | W: discharged | app.js | active |
| `deleteDuplicateDischarge`, `deletePatientRow`, `deleteMeetingReport` | PROXY + D | W: discharged (soft) / Patients (+tombstone) / Leads | app.js | active |
| `getPayments` | PROXY + F (controller allowed) | R: Payments, PaymentsTombstones, Patients, Funders | app.js | active |
| `savePayment` | PROXY + F. Void → D. Un-void → A **and** the name 'סנדרה' (9393). | W: Payments, AuditLog | app.js | active |
| `updatePayment` | alias of `savePayment` | — | no caller | dormant |
| `reportPayment` | PROXY + F (A lifts the 90-day limit, 10610) | W: Payments (receipt row) | app.js | active |
| `editReceipt`, `appendFunder` | PROXY + F | W: Payments / Funders | app.js | active |
| `billingControlQueue` | PROXY + BC (the answer varies by A/Acc, 1933) | R: Payments, Overrides, Credits, Patients, Funders, discharged | app.js; billing-control .xlsx | active |
| `confirmPayment` | PROXY + BC + controller\|approver (1937). `not_received` → Acc. | W: Payments | app.js | active |
| `upsertBillingOverride` | PROXY + F + finance\|Acc | W: BillingOverrides | app.js | active |
| `setBillingDiscount` | PROXY + F + finance cap | W: BillingOverrides, AuditLog | app.js | active |
| `deleteBillingOverride` | PROXY + F + D | W: BillingOverrides | app.js | active |
| `getCredits`, `refundPayoutForecast`, `debtAging`, `cleanupReport` | PROXY + F (controller allowed; forecast and cleanup are projected) | R | app.js; .xlsx exports | active |
| `saveCredit` | PROXY + F. Cancel → D. Manual `other` → A. Off-policy amount → A (14329). | W: Credits | app.js | active |
| `settleRefund` | PROXY + F (controller allowed) | W: Credits | app.js | active |
| `approveRefundException` | PROXY + A | W: Credits | app.js | active |
| `suggestRefunds` | PROXY + F | R | no caller (UI removed) | dormant |
| `expectedDischarges` | V (refused even in log mode, 16304) | R: Patients, ManagersExpectedDischarge | app.js | active |
| `upcomingCommittees` | V | outbound coordinators fetch | no caller (card removed) | dormant |
| `recordOutpatientLeadSend`, `dischargeOutpatientPayload` | verified only; blocked from the browser (`server.js:1044`) | W/R: AuditLog | server.js | active |
| `meetingReportLeads`, `submitMeetingReport` | PROXY + `MEETING_REPORT_SECRET` | R/W: Leads meeting-report columns | `/meeting-report` | active |
| `managersOverview`, `managersHouse`, `occupancySnapshots` | own secret `MANAGERS_WORK_SECRET` (POST) | R | ezone-managers | active (sibling) |
| `managersWork` (ops `capabilities`, `houseData`, `logAdd`, `logUpdate`, `houseCost`, `dischargeSet`, `meetingSummaries`, `feedbackDone`; `committeeSet` refused) | own secret `MANAGERS_WORK_SECRET` | W: Managers* log sheets, ManagersExpectedDischarge, ManagersFeedbackLog | ezone-managers | active (sibling) |
| `getAdmittedRoster` | own secret `ADMITTED_ROSTER_SECRET` | R (+ may append PatientPhones rows) | ezone-therapists | active (sibling) |
| `getDischargedRoster` | own secret `ALUMNI_SOURCE_SECRET` | R | ezone-therapists | active (sibling) |
| `createLeadFromTherapists` | own secret `CREATE_LEAD_SECRET` | W: Leads, AuditLog | ezone-therapists | active (sibling) |
| `getPatientsForCoordinators` | own secret `COORDINATORS_PATIENTS_SECRET` | R: Patients | ezone-coordinators | active (sibling) |
| `recordDischargeFromCoordinators` | own secret `COORDINATORS_PATIENTS_SECRET` | W: Patients, discharged, Credits, AuditLog | ezone-coordinators | active (sibling) |
| `getCommitteesForCoordinators` | own secret `COORDINATORS_COMMITTEES_SECRET` | R: ManagersCommittee (frozen) | legacy one-time import | dormant |
| `accountingPayments`, `accountingCredits` | PROXY + F + `ACCOUNTING_SECRET` (**not** in OPEN_ACTIONS) | R | `scripts/accounting-smoke.js`; external consumer unconfirmed | dormant |

Unreachable over HTTP:
- `mwCommitteeSet_`
- the reserved names `writeOffOpeningBalance` and `acceptOpeningBalance`
- every `*Now()` editor function

**Dead actions: none.**

### Scheduled jobs (time-driven triggers)

| Job | Schedule | What it does | Status |
| --- | --- | --- | --- |
| `nightlyIntegrityJob` (Code.gs:18072) | daily ~02:30 | Integrity checks, plus values-only backups to EZONE-Backups (30-day retention). Emails `ALERT_EMAIL` only on a problem. | active |
| `rebuildActivePatientsDigest` (17601) | hourly, plus after writes | Rewrites the ActivePatients digest that the coordinators read | active |
| `runMonthlyOccupancySnapshot` (17195) | 1st of the month, 03:00 | Appends to OccupancySnapshots | active |
| `paymentsDigestJob` (19814) | Sun–Thu 08:00 | Ortal's payments digest. It hands off to `billingReminderRun_` when `BILLING_REMINDER_ENABLED` is set. | active / handing off |
| `billingRemindersJob` (BillingReminders.gs:80) | daily at `BILLING_REMINDER_HOUR` | Per-owner reminder emails (Vered / Ortal) | off until configured; scheduled run not verified |
| Weekly healthcheck | GitHub Action, Sat 18:00 UTC | `/api/healthcheck?action=getData` | active |

About 40 editor-run `*Now()` functions exist: repairs, diagnostics and private Google-Doc
reports, for example `outpatientMissingReportNow` and `patientsMissingFromHousesReportNow`.
None of them is reachable over HTTP.

---

## 4. Sheets and columns

All headers are **positional and append-only** (`readSheet_` maps column N to headers[N]).
`getOrCreateSheet_` (Code.gs:2329) only ever appends missing trailing headers.

| Sheet | Columns (in order) | Key | Status |
| --- | --- | --- | --- |
| `Leads` (L55) | id, name, phone, house, source, note, stage, visitDate, visitTime, entryDate, advance, created, assignedTo, meetingWith, meetingOutcome, contactName, contactPhone, contactRelation, billingPhone, waitlistedAt, meetingReportOutcome, meetingCompanion, meetingNote, meetingReporter, meetingReportedAt, meetingSeen | `id` | active |
| `לידים לא רלוונטיים` (L69) | LEAD_COLUMNS + originSheet, movedAt, not_relevant_reason, not_relevant_note, disposition | `id` | active |
| `לידים שהוסרו` (L70) | LEAD_COLUMNS + removedAt, originSheet | `id` | active |
| `Patients` (L56) | houseId, name, date, pay, adv, status, fromLead, exitDate, source, notes, id, updatedAt, updatedBy, personId | `id` (fallback: houseId::name::date) | active |
| `מטופלים משוחררים` (L71) | id, houseId, name, date, pay, adv, status, fromLead, exitDate, source, notes, dischargedAt, disposition, discharge_note, restored, prior_status, updatedAt, updatedBy, dischargeSource, dischargedBy, dischargeReason, patientId, deletedAt, deletedBy, deleteReason, continuity | `id` (the discharge row's own) | active |
| `PatientsTombstones` (L77) | houseId … notes, droppedAt, reason, savedByAction, id, updatedAt, updatedBy | append log | active |
| `Payments` (L57) | id, patientId, patientName, houseId, dueDate, amount, status, amountPaid, balance, timestamp, coverageStart, coverageEnd, paymentUid, patientUid, payerUid, chargedAt, chargedBy, sourceUpdatedAt, sourceVersion, linkPatientUid, linkStatus, linkNote, linkedBy, linkedAt, receivedDate, method, payer, funder, reference, recordedBy, recordedAt, confirmStatus, confirmedBy, confirmedAt, flagNote, legacyAmountPaid, invoiceWanted, invoiceTo, confirmedAmount, controlNote, submissionId | `id` (cycle `pay::<triple>::<due>` / receipt `rcpt-<uuid>`), `paymentUid` | active |
| `PaymentsTombstones` (L919) | paymentUid, sourceRecordId, patientUid, houseId, dueDate, amount, amountPaid, status, deletedAt, deletedBy, deletedByFn, reason, values | `paymentUid` | active (rare) |
| `BillingOverrides` (L68) | id, patientId, month, amount, created, updatedBy, discountAmount, discountReason, discountBy, discountAt | `ovr::<triple>::<YYYY-MM>` | active |
| `Funders` (L784) | patientId, funder, effectiveFrom, setBy, setAt, submissionId | Patients.id + effectiveFrom (append-only rows) | active |
| `Credits` (L1065) | id, patientId, patientKey, patientName, houseId, facilityType, creditType, allocationMonth, calculatedAmount, amount, overrideReason, reason, approvedBy, decidedDate, payoutDate, status, paidDate, method, notes, basis, createdAt, createdBy, updatedAt, updatedBy, creditUid | `credit::<triple>::<month>::<seq>`, `creditUid` | active |
| `AuditLog` (L1110) | timestamp, action, fn, patientId, name, details, actor | append log (written only by `logAudit_`) | active |
| `SecurityLog` (L1537) | timestamp, action, method, secretPresent, callerType, hourKey, callerClass | hourly dedupe | active |
| `PatientPhones` (L63) | name, house, phone, note, patientId | name+house | active (a hand-kept phone book) |
| `Managers` / `BonusConfig` / `Outpatients` (L107-113) | house, manager_name, start_date, end_date · house, bep_patients, capacity_patients, bonus_base, bonus_per_day, type · patient_name, house_of_origin, therapy_type, start_date, end_date, notes | — | active, hand-edited, read-only to code (`Outpatients` is likely stale) |
| `ManagersFamilyCalls` / `ManagersStaffTalks` / `ManagersEvents` | id, house, …fields, followUpDate, followUpDone, author, createdAt, deletedAt, deletedBy, authorId | `id` | active (written by the Managers app) |
| `ManagersFeedbackLog` | id, house, employee, doneAt, doneBy, doneById, createdAt | `id` | active |
| `ManagersExpectedDischarge` | id, house, patientName, entryDate, expectedDate, previousDate, editedAt, editedBy, editedById, state | stay key house\|name\|entryDate | active |
| `ManagersCommittee` | id, house, patientName, entryDate, committeeDate, label, previousDate, previousLabel, editedAt, editedBy, editedById, state, pastCorrection | stay key | active as history only (no longer written) |
| `OccupancySnapshots` (L16901) | month, houseId, treatmentDays, daysInMonth, avgDaily, capacity, occupancyPct, manager, capturedAt | month+houseId | active |
| `RepairPlan` (L1137) | sheet, row, column, newValue, action, approved, oldValue, source | — | dormant (editor repair tooling) |
| `Clients` (string literal, L20474) | — | — | **dead** (read only by a diagnostic) |

Spreadsheets outside the bound file:
- **ActivePatients digest** (`DIGEST_SPREADSHEET_ID`). Columns: house, patientName, patientId,
  updatedAt. Written by the Dashboard.
- **ManagersHouse team digest** (`MANAGERS_DIGEST_SHEET_ID`). Written by the coordinators, read
  by the Dashboard.
- **EZONE-Backups**: nightly snapshots.
- **`EZONE-SNAPSHOT*` copies**: read by repair tooling.

### Facts the CRM must respect

- **No entity sheets exist for Meetings, Tasks, Activity, Persons, Contacts or Waitlist.**
  - A meeting is a set of columns on the lead row.
  - The waitlist is a stage plus `waitlistedAt`.
  - `personId` exists on Patients only.
- **Leads cannot safely take a new column.** `IRRELEVANT_LEAD_COLUMNS` and
  `REMOVED_LEAD_COLUMNS` are `LEAD_COLUMNS.concat(...)`, so appending a Leads column shifts the
  metadata columns of both live closed-lead tabs. New lead-level data needs a separate sheet or
  a migration plan.
- **The money sheets key on a mutable triple.** Payments, BillingOverrides and Credits use
  `houseId::name::entryDate`, which changes on a rename or re-date. `patientUid` /
  `linkPatientUid` patch this. The Managers* sheets key by house + name + entryDate.
- **Enumerations**
  - Lead stage: new | visit | waitlist | paid | entry | admitted | irrelevant.
  - Close disposition: not_relevant | completed | stopped_early | released_outpatient.
  - meetingOutcome: not_relevant | thinking | entered | postponed | cancelled.
  - meetingReportOutcome: advancing | undecided | not_fit | no_show.
  - Patient status: active | trial | wait | released.
  - Payment status: paid | partial | unpaid | void.
  - confirmStatus: reported | confirmed | partial | flagged.
  - linkStatus: linked | not_a_patient | duplicate | not_received.
  - Credit status: pending | paid | cancelled.

---

## 5. Secret-gated feeds, in and out

Secrets are named only, never their values.

| Feed | Direction | Secret (name) | Consumer / producer | Status |
| --- | --- | --- | --- | --- |
| `/api/sheets`, exports, meeting-report → Apps Script | Railway → Dashboard Apps Script | `PROXY_SECRET` (+ `MEETING_REPORT_SECRET`) | Dashboard browser and server | active |
| Outpatient `createLead` | Railway → ezone-outpatient | `OUTPATIENT_LEAD_URL`, `OUTPATIENT_LEAD_SECRET` | Discharges marked «משוחרר לטיפול חוץ», «העבר לאמבולטורי», meetingWith «אמבולטורי». Idempotent via AuditLog `outpatient_lead_sent`. | active |
| `managersOverview` / `managersHouse` / `occupancySnapshots` / `managersWork` | ezone-managers → Apps Script | `MANAGERS_WORK_SECRET` (JSON body) | ezone-managers | active |
| `getAdmittedRoster` | ezone-therapists → Apps Script | `ADMITTED_ROSTER_SECRET` | therapists (Outpatient use is not proven) | active |
| `getDischargedRoster` | ezone-therapists → Apps Script | `ALUMNI_SOURCE_SECRET` | therapists «בוגרים» | active |
| `createLeadFromTherapists` | ezone-therapists → Apps Script (write) | `CREATE_LEAD_SECRET` | therapists | active |
| `getPatientsForCoordinators`, `recordDischargeFromCoordinators` | ezone-coordinators → Apps Script (read + write) | `COORDINATORS_PATIENTS_SECRET` | coordinators | active |
| `getCommitteesForCoordinators` | ezone-coordinators → Apps Script | `COORDINATORS_COMMITTEES_SECRET` | coordinators (legacy import) | dormant |
| `getCommitteesForManagers`, `getMeetingSummariesForManagers` | Apps Script → ezone-coordinators | `COORDINATORS_SHEETS_URL`, `COORDINATORS_MANAGERS_SECRET` | serves Managers `houseData` | active |
| `getHouseCostsForManagers` | Apps Script → ezone-staffing | `STAFFING_SHEETS_URL`, `STAFFING_COST_SECRET` (**sent in the URL querystring**) | serves Managers `houseCost` | active |
| ActivePatients digest | Apps Script → separate spreadsheet | `DIGEST_SPREADSHEET_ID` | coordinators | active |
| ManagersHouse team digest | ezone-coordinators → spreadsheet → Apps Script | `MANAGERS_DIGEST_SHEET_ID` | Managers `team` | active |
| `accountingPayments` / `accountingCredits` | external accounting app → Apps Script | `ACCOUNTING_SECRET` | consumer unconfirmed; refused under `enforce` | dormant |
| `/api/healthcheck` | GitHub Actions → Railway | `HEALTHCHECK_TOKEN` | weekly healthcheck | active |
| Integrity, digest and reminder emails | Apps Script → MailApp | `ALERT_EMAIL`, `DIGEST_TO`/`CC`, `BILLING_ALERT_EMAIL_*` | Sandra / Ortal / Vered | active / reminders off |

---

## 6. Task and follow-up mechanisms that already exist

The CRM must reuse these and must not build a parallel copy (spec §2).

| Mechanism | Where | Stored? |
| --- | --- | --- |
| «להמשך טיפול» billing follow-up queue. Owners ורד / אורטל. Oldest first, aged in business days per owner calendar. | `billingControlQueue_` Code.gs:11850; `lib/billing-control-rules.js:339-374`; `lib/billing-work-calendar.js` | No, computed on every read |
| Billing reminder emails (FIN-01.3) | `BillingReminders.gs`, `BillingReminderCore.gs` | Script Properties only; off until configured |
| Bank-verification queue (reported → confirmed / partial / flagged) | `confirmPayment_` 11910 | Yes, on the Payments receipt row |
| Invoice-request review | `lib/billing-document-review.js` | No (no issuance evidence exists yet) |
| Renewal and overdue alerts | `app.js` 4994 / 12910 | No (frontend only) |
| Unadmitted-lead warning (3 days) | `app.js` 5288–5410 | No |
| Unseen manager report | `app.js` 3933 (`meetingSeen`) | Yes, a flag on Leads |
| "Manager report missing" | **none.** Only the 14-day reportable window (Code.gs:8796). | — |
| Managers log follow-ups | `followUpDate` / `followUpDone` on the Managers* logs | Yes |
| Expected discharges and committee alerts | `lib/discharge-alerts.js`, `lib/committee-alerts.js` | Dates stored by Managers / Coordinators |
| Outpatient handoff state | AuditLog `outpatient_lead_sent` / `_send_failed`; `outpatientMissingReportNow` | Yes, AuditLog |
| **CRM-02 retained work queue** (PR #220, unmerged) | encrypted PostgreSQL checkpoint, `/crm-work` | Draft only (see §7) |

---

## 7. PR #220, OP-03 and Outpatient #114

These are reported only. Nothing in this session touches them.

| Item | Repo / branch | Head | State | What it changes |
| --- | --- | --- | --- | --- |
| **Dashboard PR #220** "CRM-02: default-off source reads, retained queue and Dashboard work screen" | E-Zone-Dashboard · `codex/crm02-read-projections-20261013` → base `claude/build-ezone-dashboard-QOg5s` @ `43eba4d` | `a63c477` (last update 2026-10-14) | **Open draft.** CI green at its head. It is not mergeable as-is: its own body records an activation blocker (21 numeric lead IDs refused by the strict reader, plus one active/archive overlap), and the DB, key custody, backup and staging gates are not met. | 45 files, +3416. `apps-script/Code.gs` (+99: `getCrmLeads` v2 and `getCrmAdmittedRoster` projections), `server.js` (+34), new `lib/crm/*`, `crm-ui/*`, `test/crm/*`, `scripts/crm-*`, `docs/crm-*.md`, `CHANGELOG-crm-*.md`, `DEPLOY.md`, `package.json` (pg moved to runtime), `.github/workflows/test.yml`. Gates: `CRM_READS` + `CRM_QUEUE_*`, route `/crm-work`. |
| **Outpatient PR #114** "CRM-02: dormant read-only source projections and authorized adapters" | ezone-outpatient · `codex/crm02-read-projections-20261013` | `4d464d5` (2026-10-13) | **Open draft**, unchanged since 2026-10-13. Its merge base is 46 commits behind the Outpatient deploy branch. | 15 files, +1113: Outpatient `Code.gs` (+67), `server.js`, `lib/crm/*`, `test/crm/*`, docs |
| **OP-03** = Outpatient PR #125 "OP-03: preserve operational backup state and gate recovery" | ezone-outpatient · `codex/op03-operational-backup-20261019` | `3297311` (2026-10-26) | **Open draft**, active in a separate track and conversation. **Out of scope; do not edit.** | 22 files, +4847: Outpatient `Code.gs` (+442), `EZONE-ECOSYSTEM-STATUS.md`, operational-recovery docs, drill evidence, tests |

### Overlap risk with the CRM work

1. **Same product, two designs.** #220 already ships a CRM work queue: an encrypted PostgreSQL
   checkpoint, read-only lead projections and an authenticated `/crm-work` screen. The spec forbids
   parallel mechanisms (§2, §14). **Sandra decides before Session B** whether #220 is:
   - (a) the queue foundation the new CRM builds on,
   - (b) partly reused (for example its Code.gs read projections), or
   - (c) closed and superseded.

   See [ROLLOUT.md](ROLLOUT.md) §0.
2. **File collisions.** #220 touches `apps-script/Code.gs`, `server.js`, `package.json`,
   `.github/workflows/test.yml` and `DEPLOY.md`, which Sessions B and C will also touch.
   Its base `43eba4d` (2026-10-13) predates every PR merged since (#221 through #281), so it
   already needs a base merge. To avoid name
   clashes, Session B/C files must not use `lib/crm/`, `crm-ui/`, `test/crm/` or
   `docs/crm-*.md`. These docs live in `docs/crm/` (a directory), which #220 does not use.
3. **Flag naming.** #220 uses `CRM_READS` / `CRM_QUEUE_*` and `/crm-work`. Session C's
   `CRM_ENABLED` and `?view=crm` are distinct names, so the two cannot switch each other on.
4. **OP-03 has no file overlap with this repo** (it lives in ezone-outpatient). The indirect risk
   is the Outpatient `createLead` contract and its recovery/backup gates: the CRM must not change
   that contract while OP-03 is open.
5. **Outpatient #114** adds Outpatient read projections that a future CRM "read-only Outpatient
   data" panel (spec §10) would consume. It stays observation-only. A Dashboard session gains no
   Outpatient authority.

---

## 8. Security findings surfaced by this map

These are reported, not fixed: this is a docs-only session. Each needs a separate, scoped PR and
Sandra's go.

1. **`PROXY_SECRET_MODE=log` with an `ANYONE_ANONYMOUS` web app**
   (`apps-script/appsscript.json:24`; Code.gs:1567-1570, 1637-1642).
   - Today a caller of the `/exec` URL **without** the proxy secret is still served `getData`
     (full, including `billingOverrides`), `getPayments`, `saveAll`, `reportPayment`,
     `dischargePatient` and more. Only role-gated, verified-only and own-secret actions refuse it.
   - Per the docs, `log` is still the production setting (DEPLOY.md:499-502: "Do not set
     `enforce` yet"). The live Script Property value cannot be read from the repo.
   - **Every server-side permission in this matrix is only as strong as the secrecy of the
     `/exec` URL until `enforce`.**
2. **Restricted users get nearly everything in `getData`.** For Shiran and Yael only
   `billingOverrides` is stripped (`lib/finance-scope.js:270`, Code.gs:2759). They still receive
   lead phones and notes, `pay` / `adv`, discharge notes and manager phones.
3. **The `staff`, `reporter` and `viewer` roles are enforced nowhere.** Edit mode is UI-only, so
   any session can call the non-money writes (`saveAll`, discharge, restore, lead moves).
4. **Legacy `/api/outpatient-lead`** with a `{name,phone,house,note}` body lets any logged-in
   session create an arbitrary Outpatient lead (`server.js:1484-1540`).
5. **Managers identity is asserted by the Managers server.** `role`, `house` and `actorId` arrive
   in the body behind `MANAGERS_WORK_SECRET`, so the shared secret grants every house to whoever
   holds it.
6. **`/meeting-report` uses one shared PIN for all house managers.** The lead list covers every
   house (not house-scoped), and the reporter name is client-supplied (`server.js:2002`; Code.gs
   `submitMeetingReport_` checks only that it is a current manager name).
7. `STAFFING_COST_SECRET` travels in a URL querystring (Code.gs:15766).

### Doc drift found

- The Code.gs:1479 comment says OPEN_ACTIONS has "six" entries; it has 10.
- DEPLOY.md:130 documents a public GET for `occupancySnapshots`; it is now POST +
  `MANAGERS_WORK_SECRET`.
- `server.js:1637-1639` and `1729-1730` still say Ortal is inactive.
- EZONE-ECOSYSTEM-STATUS.md:338-349 and `docs/managers-hardening-rollout.md` call Managers
  protocol 2 (PR #223) a draft, but the code is in this head.
