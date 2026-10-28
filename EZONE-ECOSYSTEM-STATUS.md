# E-ZONE Ecosystem Status — updated October 28, 2026

## «ביקור נקבע» without a date — the strip + the prompt (classic + CRM) — October 28, 2026 (PR open, stacked on #309)

- Sandra's report: אורן's meeting with אורנה (today) was on no board and in no managers' feed. Live row: stage «ביקור נקבע», «נפגש עם» אורן, **visitDate blank** — every surface keys on visitDate; ezone-managers is not at fault. Now: an undated strip on «לוח פגישות» and the CRM «יומן» (chip → meeting modal / drawer «תיאום פגישה»), and a stage move to «ביקור נקבע» without a date opens the date prompt at once. Code.gs untouched. SW v95 → v96. Details: `CHANGELOG-undated-visit-leads.md`.

## גבייה search finds the patient — any status, every cycle (classic + CRM) — October 28, 2026 (PR open)

- Vered's report: the classic גבייה search box filtered two DATE-scoped lists, so a released patient (or anyone with nothing due that day) was never found. New «תוצאות חיפוש — כל המחזורים» group lists every matching patient (any status, discharged rows, orphan rows) with all their cycles; explicit not-found text. CRM «גבייה» answers the top search box the same way. SW v94 → v95. Details: `CHANGELOG-billing-search-any-patient.md`.

## C17 — CRM «משוחררים»: list, restore (previous status / new lead), «העבר לאמבולטורי» — October 28, 2026 (PR open)

- The classic «מטופלים משוחררים» tab's daily uses now live in the CRM (house-as-read `saveAll` + `restorePatientToActive`, `restorePatient`, `/api/outpatient-lead manual:true`). Duplicate-discharge delete stays classic. Details: `CHANGELOG-crm-discharged.md`.

## C16 — the CRM as a PWA — October 28, 2026 (merged, #307)

- SW v93 → v94: the CRM bundle rides `BUNDLE_PATHS` (cache-first at its hash); crm.html links the manifest and registers the worker. An installed Dashboard app opens the CRM after the switch. Details: `CHANGELOG-crm-pwa.md`.

## C15 — CRM «יומן» with a date picker (day / week, past included) — October 28, 2026 (merged, #306)

- Sandra's review request. Day / week toggle, ‹ ›, date input, «היום»; past meetings with their status (outcome, manager report, none). Details: `CHANGELOG-crm-calendar-picker.md`.

## C14 — CRM «פגישות ושירותים» over real data — October 28, 2026 (merged, #305)

- Manager meeting reports (from `/meeting-report`) in the drawer tab with seen-marking via the one-lead `saveAll`, an unseen-report row in «היום שלי», a «בקרה» metric; the patient's discharge record in the same tab. Services (Therapists) still not connected. Details: `CHANGELOG-crm-meetings-tab.md`.

## Phase 2b — lead owners: Dana and Sandra in, Shiran and Yael out — October 28, 2026 (merged, #304)

- Classic add-lead form and CRM now offer the same owners (`ורד / דנה / סנדרה`); Code.gs `CREATE_LEAD_ASSIGNEES` keeps the legacy names accepted for older Therapists builds. Therapists follow-up: offer דנה / סנדרה there. Details: `CHANGELOG-assignees-dana.md`.

## Phase 2a — Dana's read-only login — October 28, 2026 (merged, #303)

- New user `dana` (staff only), read-only BY ID: the server refuses every write and every non-read action before the proxy (`lib/readonly-scope.js`), projects getData without money fields, Code.gs holds the second lock. Classic page in view mode + restricted layout; CRM: five read areas, no actions. Sandra creates her code with «קוד אישי חדש». Details: `CHANGELOG-readonly-role-dana.md`.

## C13 — report for any cycle; fix or void a receipt — October 28, 2026 (merged, #302)

- «חשבון»: «דווח תשלום למחזור אחר» (entry-anchored stay cycles, advances included, default = the next cycle); per receipt «עריכה» (`editReceipt`, non-money fields, shared rules) and «ביטול» (classic `savePayment` void with a reason, `deleter`). Found by Sandra on the first live review. Details: `CHANGELOG-crm-report-any-cycle.md`.

## C12 — the switch: `/` serves the CRM when `CRM_DEFAULT=true` — October 28, 2026 (merged, #301)

- New Railway variable `CRM_DEFAULT` (needs `CRM_ENABLED` too): `/` → the CRM for full-view personal logins (Vered, Sandra); `/?view=classic` → the old dashboard; Ortal / Dana keep classic by default; `/?view=crm` unchanged. Every classic link in the shell now points at `/?view=classic`. Inert until Sandra sets the variable (DEPLOY.md has the click-steps). Details: `CHANGELOG-crm-default.md`.

## C11 — credits, discount and amount change inside the CRM — October 28, 2026 (merged, #300)

- «חשבון» tab: «הנחה» / «שנה סכום» per open cycle, the patient's credits with «סמן כשולם»; «גבייה» area: «זיכויים לתשלום». Classic contracts (`setBillingDiscount`, `upsertBillingOverride`, `settleRefund`) + `getCredits` read, unchanged. With C10 Vered's daily collections work is now inside the CRM; receipt edit / void, manual credits and linking remain classic links. Details: `CHANGELOG-crm-credits-overrides.md`.

## C10 — «דווח תשלום» inside the CRM — October 28, 2026 (merged, #299)

- The patient «חשבון» tab reports payments natively: the classic strict form rebuilt in the CRM over the shared `lib/payment-report-rules.js` and the unchanged `reportPayment` contract (submissionId idempotency, duplicate confirm, re-read after save). C9 money-row matching fixed (legacy triple + uid). Credits / discounts / refunds next. Decision (Sandra 2026-10-28): rebuild in the CRM, then switch Vered. Details: `CHANGELOG-crm-payment-report.md`.

## C9 — CRM patient drawer «חשבון» tab over real data — October 27, 2026 (merged, #298)

- The patient drawer's «חשבון» tab shows open cycles, stamped payment cycles, the patient's receipts and the funder history, from the same `debtAging` + `getPayments` answers the גבייה area loads (fetched once per page, shared). Finance users only; actions still link to the classic dashboard. No write, no Code.gs, flag-gated. Details: `CHANGELOG-crm-account-tab.md`.

## C8 — «גבייה» inside the CRM, read-only — October 27, 2026 (merged, #297)

- The גבייה area now shows real data from `debtAging` + `getPayments` (fetched on first open): open-debt KPIs, aging buckets, debt per house, debtors table (row → patient drawer), latest receipts with verification chips. Every action («דווח תשלום», overrides/credits, linking, Ortal's queue) still links to the classic dashboard — embed-vs-rebuild of the report form is an open decision. No write, no Code.gs, flag-gated. Details: `CHANGELOG-crm-billing-readonly.md`.

## C7 — CRM patient actions: edit, house move, discharge — October 27, 2026 (merged, #296)

- Patient drawer: edit (house as read, id-match replace), move (target house + `movedFrom` intent), discharge (`dischargePatient` audit row → house as read released → `/api/outpatient-lead` for «טיפול חוץ»). With C4–C6 every daily write of the classic leads/תפוסה tabs now exists in the CRM except returning-patient matching, restore and delete. Flag-gated. Details: `CHANGELOG-crm-patient-actions.md`.

## C6 — CRM admission from a lead + direct add — October 27, 2026 (PR open)

- `saveAll` with ONE house as read + the new patient (+ the lead), `prove` for both; refusals for duplicates / conflicts / unproven. «קליטה לבית» in a paid lead's drawer (funder via `appendFunder` for finance), «הוספת מטופל/ת ישירות» in מטופלים (patient + `dl-` lead pair). Remaining writes: discharge, house move, returning patient, patient edit. Flag-gated. Details: `CHANGELOG-crm-admission.md`.

## C5 — CRM lead lifecycle: new lead, close, remove, restore, «לידים סגורים» — October 27, 2026 (PR open)

- New-lead drawer form (classic rules + duplicate warning) via the one-lead `saveAll`; close (`moveLeadIrrelevant`, four dispositions + reason), remove (`removeLead`), closed-leads view with restore (`restoreLead`). Flag-gated. Remaining writes: admission, direct add, discharge, house move. Details: `CHANGELOG-crm-lead-lifecycle.md`.

## C4 — CRM lead actions (stage move, meeting, outcome, note/owner) — October 27, 2026 (PR open)

- First write path in the CRM: `saveAll` with ONE full lead row + `patients: {}` + `prove` (Code.gs keeps absent leads; nothing else is touched). Optimistic, rolled back on refusal, proven or failed. Stage buttons on cards and in the drawer; meeting / outcome / note forms in the drawer. Remaining writes (new lead, close, admission, discharge, house move) in the next PRs. Flag-gated. Details: `CHANGELOG-crm-lead-actions.md`.

## C3a — CRM shell: «תפוסה» area, «מטופלים», DD/MM/YYYY — October 27, 2026 (PR open)

- Sandra's review fixes: new תפוסה area (per-house cards, same in-house rule as the classic count), לקוחות renamed מטופלים, every date DD/MM/YYYY, created date on lead cards. גבייה keeps linking to the classic screens until Phases 4–6. Flag-gated; **CRM_ENABLED should stay off in Railway except for review sessions** (Sandra, 2026-10-27). Details: `CHANGELOG-crm-occupancy-area.md`.

## C2 — CRM shell: side menu + six areas, read-only — October 27, 2026 (PR open, stacked on C1)

- **What:** `public/crm/` — menu, היום שלי (computed work queue + KPIs; Ortal's day from `billingControlQueue`), פניות (board ⇄ table, shared filter), לקוחות, יומן, גבייה (links), בקרה (action metrics), client drawer with the B3 timeline. Areas per role mirror the server gates. Reads only; every button links to the classic dashboard. Dark theme, RTL, 1366/390 verified in Chromium.
- **Server:** two hashed assets + routes; not in `sw.js` (v93). No Code.gs. Visible only with `CRM_ENABLED=true` + `/?view=crm`.
- **Next:** C3 — remaining computed lists (billing follow-up, outpatient sent/failed) and drawer tabs over real data; then Sandra flips the flag for Vered. Details: `CHANGELOG-crm-shell-areas.md`.

## C1 — CRM shell behind `CRM_ENABLED` + `/?view=crm` — October 27, 2026 (PR open)

- **What:** `lib/crm-shell-flag.js` + one guarded branch on `/`: the placeholder shell (`public/crm/crm.html`, dark, RTL) is served only when `CRM_ENABLED === 'true'` (Railway, default off) and the session is a verified personal user. Flag off = every response byte-identical (tested). No Code.gs, no SW bump (v93), no new asset.
- **Sandra sets the flag** when C2/C3 are ready: Railway → `web` → Variables → `CRM_ENABLED` = `true`. Theme: dark.
- **Next:** C2 (side menu + areas, read-only over existing actions), C3 («היום שלי», board/table, client drawer + timeline). Details: `CHANGELOG-crm-shell-flag.md`.

## B3 — `getActivity` permission-filtered read — October 27, 2026 (PR open)

- **What:** `action=getActivity` by lead / patient / person / paymentUid. Gate = `expectedDischarges` rule (PROXY_SECRET + verified personal session, even in `log` mode). Server-side scope by caps: finance → all; Ortal → money kinds only, no `leadId`; no caps (Dana) → no money kinds. Fields a scope may not see are absent. Read-only, no UI consumer yet.
- **Lists:** appended to `PROXY_KNOWN_ACTIONS`, `CONTROLLER_ACTIONS` (Code.gs = lib), `ALL_USERS_READ_ACTIONS`. No SW bump, no secret, no Railway variable.
- **Session B is complete (B0–B3).** Next: Session C — CRM shell behind `?view=crm` + `CRM_ENABLED` (default off). Details: `CHANGELOG-crm-activity-read.md`.

## B2 — Activity system events behind `ACTIVITY_WRITES` — October 27, 2026 (PR open)

- **What:** one hook in `logAudit_` maps 17 audit actions (lead close/restore/remove/create, discharge incl. coordinators, restores, house move, payment reported/confirmed/flagged/unconfirmed/void-reversed, refunds) to `Activity` events — idempotent by stable eventId, best-effort, ids only. Unmapped actions write nothing.
- **DEFAULT OFF.** Script Property `ACTIVITY_WRITES=on` enables (Apps Script editor → Project settings → Script properties); delete it to stop instantly. No Railway variable, no SW bump.
- **Next:** B3 permission-filtered `getActivity` read. Details: `CHANGELOG-crm-activity-system-events.md`.

## B1 — `Activity` sheet + writer, not wired — October 27, 2026 (PR open)

- **What:** `ACTIVITY_SHEET` / `ACTIVITY_COLUMNS` (16 cols, append-only) + `appendActivity_` (locked, idempotent by `eventId`, pure validator `activityRow_`). **No caller, no action, no `getData` change** — no row is written in production. Code.gs only, inert; clasp CI on merge.
- **Next:** B2 dual-writes system events from the existing writers behind a Script Property kill switch (default off); B3 the permission-filtered read. Details: `CHANGELOG-crm-activity-foundation.md`, `docs/crm/ROLLOUT.md` §B1.

## B0 — coordinators' discharge → own house only — October 27, 2026 (PR open)

- **What:** `recordDischargeFromCoordinators` now refuses a patient outside the caller's verified session house (`actor` + `house` from ezone-coordinators #337, live). `system:*` actors and `*` from a code login are refused on the write; `admin` / `user:<id>` with `*` reach every house. Refusals: `actor_not_allowed` / `forbidden_house`, Hebrew message, AuditLog row with ids only, nothing written.
- **Feeds unchanged:** `getPatientsForCoordinators` / `getCommitteesForCoordinators` keep serving regardless of the pair.
- **Deploy:** Code.gs only, clasp CI on merge (same `/exec` URL). No SW bump, no schema change, no secret, no Railway variable.
- **Verify live:** one «שחרור» in the coordinators app of an own-house patient succeeds; an admin test on another house's patient from a רכז session answers «השחרור נדחה …».
- **Next:** B1 (`Activity` sheet). Details: `CHANGELOG-coordinators-discharge-own-house.md`, `docs/crm/ROLLOUT.md` §B0.

## CRM restructure — Session A — October 27, 2026 (merged as #283, docs only)

- **What:** `docs/crm/` holds SPEC (Hebrew spec + Decisions D1–D4), CURRENT-STATE, PERMISSIONS-MATRIX, LINKED-APPS, GAP-LIST and ROLLOUT. No code, schema or SW change (stays v93).
- **Decisions:** D1–D4: Ron = ניהול בית only (no Dashboard); «מטופלים משוחררים» stays Vered's; managers keep their passwords; Ortal = verifier, not הנהלה. D5–D17 (Oct 27): Shiran/Yael removed (revoke list in PERMISSIONS-MATRIX §7), Dana read-only, all houses, with no money; coordinators no Dashboard and discharge own-house only (security gap: ezone-coordinators #337 sends `actor` + `house` first, then Dashboard B0 enforces; `system:*` only on the read-only feeds; personal logins mandatory for discharge in Phase 3a); discounts and refund exceptions Sandra, rule-based refunds automatic, execution Ortal; managers via ניהול בית, never a client-supplied house; ezone-managers' five writes retire in Phase 3c, with no new write path. All agreed, not yet implemented.
- **PR #220 closed as superseded (Oct 27);** branch kept. Its archive-aware lead reader (+ numeric-ID fix) and its task-queue rules will be cherry-picked later; no PostgreSQL. **Still open:** when to switch `PROXY_SECRET_MODE` to `enforce` (today any `/exec` caller bypasses server gates).
- **Other apps: no change.** OP-03 (Outpatient #125), Outpatient #114 and PR #220 were read, not edited. See `CHANGELOG-crm-spec.md`.

## Active patient missing from every house tab — October 26, 2026 (PR open)

- **Root cause:** «מטופלים» lists every non-released Patients row and filters the house
  leniently. תפוסה compared the stored house to the tab id EXACTLY, and `resolveHouseId`
  knew neither another app's id (`hapardes`, `raanana`, `efroni`, `ofroni`) nor an
  invisible mark / NBSP / doubled space. Such a row was in «מטופלים», in no house tab, and
  could not be discharged. The server matched a house's rows with the same exact compare.
- **Now:** ONE house rule (`resolveHouseId` = Code.gs `diagClientHouseId_`, parity test) for
  תפוסה, «מטופלים», the per-house save, moves, delete and the coordinators digest. A row
  stored under an alias / label / invisible mark is updated in place and its cell healed to
  the id on the next save. A house no rule resolves shows in a new «בית לא מזוהה» tab.
  «שחרר» on active «מטופלים» rows (edit mode) opens the same `dischargePatient` flow.
- New editor report `patientsMissingFromHousesReportNow()` (Google Doc, read-only).
- **Other apps: no change.** No schema change. Code.gs + app.js + style.css; SW v92 →
  **v93**. See `CHANGELOG-patient-missing-from-house.md`.

## Vered's scheduling note on the managers' form — October 26, 2026 (PR open)

- **Dashboard → `/meeting-report`:** `meetingReportLeads` adds ONE additive per-lead key,
  `officeNote` = the lead's `note` (the «הערות» textarea next to the visit date/time).
  `server.js` re-applies the whitelist (`meetingReportLeadsWhitelist`: `id, name, house,
  visitDate, officeNote` only — still no phone, contact or billing fields).
- The form shows it read-only as «רקע מהמשרד» under the lead picker (hidden when empty).
  **It never goes into the WhatsApp group message** (it can hold clinical background) nor
  into the submit payload — test-pinned.
- **ezone-managers / other apps: no change** (the feed is the meeting-report form's own).
- Code.gs (clasp CI on merge) + server.js + meeting-report page. No SW bump (the
  meeting-report page is never cached), no new column, route, action or secret.
  See `CHANGELOG-vered-note-to-managers.md`.

## Discharged → Outpatient: reliable send + «העבר לאמבולטורי» — October 26, 2026 (PR open)

- **Root cause 1:** the «משוחרר לטיפול חוץ» → Outpatient lead was a browser-only, one-shot
  call at the end of the discharge. It was lost on a failed Patients write, on a duplicate
  answer, on any Outpatient error, or with no phone. Coordinators discharges never sent.
- **Root cause 2:** discharge rows matched their patient by an exact house + name + date
  compare. A name cleaned after the discharge (invisible marks) made restore rebuild a second
  row, which the duplicate-admission guard refused.
- **Now:** `/api/outpatient-lead { dischargeId }` → Code.gs builds the payload → server.js
  `sendToOutpatient` → AuditLog `discharge:<id>`. Sent once, retried on demand with
  «העבר לאמבולטורי» on discharged rows. Restore matches by `patientId`, then by normalized
  name. New editor report `outpatientMissingReportNow()` (Google Doc).
- **ezone-outpatient: no change** (same `createLead` contract: name, phone, house key, note).
- Code.gs + server.js + app.js; SW v91 → **v92**. See `CHANGELOG-discharge-outpatient-handoff.md`.

## «אמבולטורי» meeting option → Outpatient — October 26, 2026 (PR open)

- **Dashboard:** «נפגש עם» gets one fixed, LAST option «אמבולטורי» (Shachar with Oren the
  coordinator). It is not a manager: never in the Managers tab, `currentManagers_`, the summary
  strip, the meeting-report reporter list, or a house's bonus credit (`managerHouseByName_`).
  The meeting stays on the board; the lead is never closed or moved.
- **→ ezone-outpatient:** when a lead's meetingWith BECOMES «אמבולטורי», `saveAll_` lists it and
  server.js `sendToOutpatient` calls the existing Outpatient `createLead` once (name, phone, note,
  source — no house; the preferred house is set in Outpatient). Logged in AuditLog
  (`outpatient_lead_sent`), never sent twice. A failure (Outpatient down, timeout, no phone) →
  the meeting saves, Vered gets a Hebrew warning, the next save retries.
- **ezone-outpatient: no change.** It receives an extra `source` field and no `house`
  (to verify on its side: a lead with an empty house is accepted).
- **ezone-managers:** visits / expected admissions may now carry `meetingWith: 'אמבולטורי'`
  (a plain name; no house credit). Its WhatsApp button stays disabled unless a phone is set.
- Code.gs + server.js + app.js; SW v90 → **v91**; one new getData key
  `outpatientSentLeadIds` (additive). See `CHANGELOG-meeting-with-ambulatory.md`.

## Meeting-flow gaps — October 26, 2026 (PR open)

- **Admitted lead reports:** a manager can now report on an ADMITTED lead whose meeting
  was in the last 14 days. The report goes on its Leads row (same 5 columns, `meetingSeen`
  cleared), and the `/meeting-report` picker lists those leads. Closed and removed leads
  are still `lead_not_found`.
- **Visits past month end:** `managersWork` `houseData.visits`, for the current month,
  also includes today … today + 14 days, de-duplicated by lead id. Each visit gets the
  additive `inSelectedMonth`.
  - **ezone-managers follow-up:** «ביקורים החודש» and the «מטופלים» visits card count
    `visits.length`, so they over-count until they filter on `inSelectedMonth !== false`.
- **Reporter names:** the reporter list comes from the Managers tab (`currentManagers_`,
  falling back to HOUSE_MANAGERS) via the additive `managers` field of
  `meetingReportLeads`. `submitMeetingReport_` refuses any other name
  (`reporter_not_manager`).
- Code.gs changed (clasp CI on merge); SW v89 → **v90**. See
  `CHANGELOG-meeting-flow-gaps.md`.

## Ortal billing — «בעיות גבייה» view + «הנחה» chip — October 22, 2026 (PR open, stacked on PR 1)

«בקרת גבייה» gets «בעיות גבייה» (Ortal / Sandra only): per patient, unconfirmed receipts with
«שולם - אשר» / «לא שולם - בטל תביעה» (reason required) and owed cycles with «הנחה» (amount +
reason). Discounted cycles show the «הנחה» chip and the amount after it; a full discount is never
debt. Sandra's «חריגים פתוחים» lists every void and every discount with who / why. Code.gs: the
queue answer only (read). SW v83 → **v84**. See `CHANGELOG-ortal-billing-ui.md`.

## Ortal billing — accountant role + discount schema (foundation) — October 22, 2026 (PR open)

New `accountant` role (Ortal; extends `USER_PIN_HASHES`, no `ORTAL_PIN`): void ONE unconfirmed
receipt claim («לא שולם — בטל תביעה», `confirmPayment` status `not_received`, reason 2–120,
soft delete, Sandra-only undo) and set a cycle discount (`setBillingDiscount`). `BillingOverrides`
gets 4 APPENDED columns (`discountAmount`, `discountReason`, `discountBy`, `discountAt`).
Effective expected = base − discount (≥ 0) in the shared cycle rule, debt aging and the forecast;
revenue unchanged. No UI change; no SW bump. Code.gs changed (clasp CI on merge). Railway: add
`"accountant"` to Ortal's `USER_PIN_HASHES` roles. See `CHANGELOG-ortal-billing-discounts.md`.

## Backfill: «פנייה ישירה» lead for direct patients without one — October 21, 2026 (PR open, stacked on PR A)

`migrateDirectPatientLeadsNow(dryRun)` is editor-only, and the dry run is the default: it logs patient,
entry date, house and phone, and writes nothing. `migrateDirectPatientLeadsApplyNow()` writes, under the
lock, row by row:
- the same `dl-<id>` lead as `saveAll_` (same builder, `created` = entry date, phone blank allowed);
- then the patient's `fromLead`.

It is idempotent by patient id. Code.gs changed (clasp CI on merge); no SW bump.
See `CHANGELOG-direct-lead-backfill.md`, `DEPLOY.md`.

## Direct add → a regular ADMITTED lead «פנייה ישירה» — October 21, 2026 (PR open)

A patient added directly in «תפוסה» gets a real lead. That covers a direct add, an intake and a returning
stay. The lead: `dl-<patient id>`, stage `admitted`, source `direct_approach`, house in Hebrew, the
patient's entry date, phone (blank allowed). `saveAll_` writes it inside its lock, before any patient row.

- An old client's `direct_admin` phone-record lead is adopted in place.
- A real board lead link is kept.
- A returning stay gets its own lead (`personId` stays on Patients; no Leads column).
- A failed lead write refuses the save (`direct_lead_failed`, AuditLog).
- A patient that does not land loses its lead again (`directLeadsDropped`).
- The response adds `directLeads`.

UI: a «פנייה ישירה» / «חוזר» chip replaces «ללא ליד». The lead card, «פרטי הליד» and the funnel show the
Hebrew label. The funnel counts these leads once under «נכנסו לבית». The bonus path
(fromLead → meetingWith) is unchanged.

Code.gs changed (clasp CI on merge); SW v83. See `CHANGELOG-direct-add-auto-lead.md`.

## Lead moves write first — October 21, 2026 (PR open)

`moveLeadIrrelevant_` and `restoreLead_` deleted the lead BEFORE writing it to the other sheet, so a
failed write lost it. All three lead moves (closure, restore, remove) now go through
`moveRowWriteFirst_`: upsert the destination by id → read-back verify → only then delete the source,
under the script lock. A failed write returns `move_write_failed` and is logged; a retry adds no
duplicate. Code.gs changed (clasp CI on merge); no public/ change, no SW bump.
See `CHANGELOG-lead-move-write-first.md`.

## Dashboard Apps Script: half-yearly feedback «משוב» for Managers (October 20, 2026)

- New APPEND-ONLY sheet `ManagersFeedbackLog`: `id, house, employee, doneAt, doneBy, doneById, createdAt`.
- `managersWork` op `feedbackDone`: the employee must be on the house staff (fail-closed); the date is real and not in the future.
- `houseData.feedback.rows` carries the caller's house only. The team digest's `startDate` is optional.
- Deploys automatically on merge. Details: `CHANGELOG-feedback-reminders.md`.

## Dashboard Apps Script: «סיכומי ישיבות» for Managers (October 20, 2026)

- `managersWork` op `meetingSummaries` `{ month }` → the coordinators' read-only `getMeetingSummariesForManagers` for the
  caller's house. FINAL meetings only, with their patient rows.
- Same Script Properties as the committees feed. Fail-closed contract; cached per house + month.
- Deploys automatically on merge. Details: `CHANGELOG-meeting-summaries-feed.md`.

## Committees come from the coordinators — October 20, 2026 (PR open)

- Committees (date, time, type, participants, house) are set in ezone-coordinators.
- This Apps Script reads them through the coordinators' read-only `getCommitteesForManagers`.
  - Script Properties here: `COORDINATORS_SHEETS_URL` and `COORDINATORS_MANAGERS_SECRET` (= the
    coordinators' `MANAGERS_READ_SECRET`).
  - It is fail-closed, has a strict contract and is cached 5 min.
- Consumers:
  - Managers `houseData.committees` (the caller's house only);
  - the dashboard «ועדות קרובות» card (an honest «לא זמין» when the feed is down).
- `committeeSet` is refused (`committee_read_only`). `ManagersCommittee` is kept as history and
  never written again.
- `getCommitteesForCoordinators` gains `range:'future'` for the one-time coordinators import.
- SW v82. Details: `CHANGELOG-committees-from-coordinators.md`, `DEPLOY.md`.
## «חתכי מטופלים» fixes — dead buttons, list behind a number, sub-lines — October 20, 2026 (PR open)

Root cause of the dead buttons: the threshold inputs re-rendered the panel from `change`, which fires
on blur = the mousedown of the next control, so that click never fired. Now one delegated listener,
inputs only store, «החל» applies. Click-a-count opens its list under its section (phone, close, own
exports). Bucket cards add «+N עדיין בטיפול» (same numbers in «סיכום», «שהות – חתך», summary CSV).
Spinner + aria-busy + retry toast on every action; 44px. No Code.gs change; SW v81.
See `CHANGELOG-chitukim-fixes.md`.

## «השלמת תקופת טיפול» — completion view — October 20, 2026 (PR open)

«חתכי מטופלים» gets a completion section: per threshold (30 / 60 + custom) over the entered-in-period
cohort — הגיעו לסף (discharged or active ≥ N) / עזבו לפני הסף / מוקדם לקבוע (not in the rate);
rate = reached / (reached + left early), «אין מספיק נתונים» when 0. Pure `computeCompletion` in
`lib/patient-retention.js`; clickable lists, CSV section, Excel sheet «השלמת טיפול» (full export = 8
sheets). Bucket cards unchanged. No Code.gs change; SW v80. See `CHANGELOG-completion-view.md`.

## «ייצוא לאקסל» for every חתך — October 20, 2026 (PR open, stacked on #258)

In-browser .xlsx (`lib/report-xlsx.js`, no library, no server route): «ייצוא הכל לאקסל» = one file,
7 Hebrew sheets (סיכום, לידים – חתך/רשימה, שהות – חתך, המשך טיפול, מטופלים – רשימה, נתונים חסרים);
per-section and per-list «ייצוא לאקסל». RTL, frozen bold header, real dates, text phones, % numbers,
formula-guarded text (the CSV rule). Values read from the on-screen reports. No Code.gs change; SW v79.
See `CHANGELOG-report-xlsx-export.md`.

## «חתכי מטופלים» + required «המשך טיפול» — October 20, 2026 (PR open, stacked on #257)

שחרור modal: required «המשך טיפול» (3 real values; submit gated). «מטופלים משוחררים» gets a
«חתכי מטופלים» sub-view: period + presets + custom days, length cards (% of cohort), continuity
cards (% of discharged), bucket × continuity table, clickable lists, CSV (BOM, formula-guarded),
«נתונים חסרים». Legacy rows: «לא ידוע — עדכון» (optimistic + rollback). No Code.gs change; SW v78.
See `CHANGELOG-patient-retention-ui.md`.

## «חתכי מטופלים» foundation — `continuity` column — October 20, 2026 (PR open)

Discharged sheet gets `continuity` appended LAST (keys `continued_outpatient` /
`continued_other` / `none` / `unknown`, default `unknown`). `dischargePatient_` refuses an
unknown key; new action `setDischargeContinuity` (by id, LockService, single-row cells, AuditLog).
Pure `lib/patient-retention.js` (stay length, buckets, cohort by entry date). No UI change.
Code.gs changed (clasp CI on merge); SW v77. See `CHANGELOG-patient-retention-foundation.md`.

## Landlines on the lead handoff — October 19, 2026 (PR open)

`createLeadFromTherapists_` (server-to-server only) accepts a 9-digit landline
`/^0[2-9]\d{7}$/` besides the 10-digit mobile, after `normalizePhone_`. The Dashboard UI
form and `saveAll` stay mobile-only. A refused handoff returns `invalid_phone` /
`invalid_name` and is logged (console + AuditLog `lead_handoff_refused`, no name/phone).
Code.gs changed (clasp CI on merge); no public/ change, no SW bump.
See `CHANGELOG-landline-handoff.md`.

## «מטופל חוזר» — returning patient — October 19, 2026 (PR open)

Occupancy «מטופל חוזר»: search discharged + closed leads by phone/name; a unique match pre-fills
the add form with history; confirm = one new stay linked by `personId` (Patients column appended
LAST, immutable once set) and the old discharge rows flagged restored. No / several matches →
manual pick only. Card «היסטוריית שהיות»; «ללא ליד · נוסף ישירות / מטופל חוזר». Code.gs changed;
SW v76. See `CHANGELOG-returning-patient.md`, `docs/returning-patient.md`.

## «לא נכנס» on «ממתינים לקליטה» — October 19, 2026 (PR open)

Waiting cards get «לא נכנס»: the existing soft close (closeLead → moveLeadIrrelevant, to
«שימור לידים»), lead dispositions only, required reason, optimistic + rollback. Code.gs:
disposition allowlist, formula-safe note, `requireReason` flag. SW v75.
See `CHANGELOG-waiting-not-entered.md`.

## «מטופלים»: missing phone + funder button fix — October 19, 2026 (PR open)

New «חסר טלפון» chip (summary + «בעיות בלבד») with inline «הוסף טלפון» (the phone lives on
the patient's lead; same plan as the ✏️ form; optimistic + rollback). «הגדר גורם מממן» now
shows only when no funder is set (it was rendered unconditionally in edit mode). No Code.gs
change; SW v74. See `CHANGELOG-patients-phone-funder-fix.md`.

## Leads funnel report «חתכים בלידים» — October 19, 2026 (PR open)

Read-only panel on the leads tab: לא רלוונטי / הגיעו לפגישה ולא נכנסו / נכנסו לבית
by lead creation date, with presets, lists and CSV. Pure `lib/leads-funnel.js`; no
Code.gs change. SW v73. See `CHANGELOG-leads-funnel-report.md`, `docs/leads-funnel-report.md`.

## Lead name + phone required — October 19, 2026 (PR open)

New leads need a full name (2+ words) and a valid Israeli phone (`/^0\d{9}$/` after
normalizing), checked inline in the UI and refused server-side by `mergeLeads_`
(`invalid_lead`) and `createLeadFromTherapists_`. Existing incomplete leads are only
checked on a changed field. Code.gs changed (clasp CI on merge); SW v72.
See `CHANGELOG-lead-name-phone-required.md`.

## Invoice-request review — October 16, 2026 (draft candidate)

Read-only Billing Control section preserves requested invoices after payment
verification, exposes unknown legacy choices and distinguishes requests from
issuance evidence. No extra data fetch, write, access or reminder change.
See `CHANGELOG-billing-document-review.md` and `docs/billing-document-evidence.md`.
Issuance evidence capture remains open; this is not completed document tracking.

## Reminder delivery — October 15, 2026 (deployed and activated)

Sandra approved #242 merge/deployment and daily all-open summaries at 08:00–09:00
Asia/Jerusalem, replacing the old Ortal digest. Merge `1e81cf9`, Apps Script #108,
Tests #362 and Railway succeeded; version/health were verified. Six settings were
saved/read back and the owner's new trigger replaced the old one, retaining three
unrelated triggers. Private recipients are not committed here. First eligible mail
date: October 18; scheduled execution and inbox arrival remain unverified. See
`CHANGELOG-billing-reminder-delivery.md` and `docs/billing-reminder-rollout.md`.
CRM #220, security/access, broader speed work and FIN-02–04 remain unchanged.

## Reminder preview — October 15, 2026 (deployed)

A collapsed Billing Control section previews aggregate follow-up summaries:
Vered's own work, Ortal's verification plus oversight, and neutral funder waiting.
Uses the existing queue and calendar; no names, money, new permissions or sends.
Partial/stale sources cannot claim all work is done. See
`CHANGELOG-billing-reminder-preview.md`. Sandra approved #237; merge
`0efb7dca278dcea3029f8311a319300112d89f29` was verified live (cache v68),
with 2,845 local tests and four Chromium scenarios passing. No further release
approval is needed for #237. CRM, security/access and broader speed work are unchanged.

## Owner workday calendar — October 15, 2026 (deployed)

FIN-01.3 adds owner-specific work age alongside calendar age. Ortal uses Sun–Thu;
Vered uses Sun–Wed, with optional Thursday remote actions still available.
Holidays and eves are excluded. No new alerts, permissions or money calculations.
See `CHANGELOG-billing-workdays.md` for the date range and calendar contract.
Sandra approved #234, merged as `908fe4496e131cc067aa6d2ae6afe2db2b0bc295`.
2,827 local tests and three real Chromium cases passed. Tests #345 and Railway
production deployment `99cd7a40-c86d-4606-b9d1-a912c3c456bc` succeeded.
`/api/version`, `/healthz` and byte-identical live calendar/SW assets were verified
(cache v66). Home probes: 200 in 6.668 / 6.377 / 6.606 seconds. No Apps Script
deploy was needed, and no live payment write was tested. Vered may work on
Thursday, Friday and Saturday night; the calendar never gates access/actions.
CRM numeric-ID work remains separately owned; no changes to security/access,
other applications or the broader performance track are made by this candidate.

## Billing follow-up queue — October 15, 2026 (deployed)

FIN-01.2 adds a read-only chronological work list in Billing Control, combining
existing receipt verification work with the debt-aging engine's open cycles.
Amounts stay separate; original dates, Vered/Ortal responsibility and the existing
institutional grace period are preserved. No bank imports, notifications, new
permissions or sheet writes are introduced. See `CHANGELOG-billing-followup-queue.md`.
The isolated branch includes the deployed recovery fix #229 and Managers #231.
Sandra separately authorized #232, merged as `8620735c87e24c80ad375d5fcdd079af2d80ae02`.
Apps Script #100, Tests #341 and Validate Workflows #38 passed. Railway reported
SUCCESS and `/api/version` and `/healthz` returned the merge SHA. Three public
home-page probes returned 200 in 6.683 / 5.816 / 7.372 seconds. These are
availability checks; no live payment writes were tested. #233 subsequently
advanced the deployed branch to `e85c812` and cache v65.
The first CI screenshots exposed waiting-row contrast and RTL overflow in a
confirmed partial-payment line. Both are corrected in the review branch with
browser assertions for text contrast and bounds. Browser run #2 passed all three
cases with no skips; the corrected 360px and 1280px screenshots were reviewed.
The same code tree passed 2,793 local tests, Tests #339 and Validate Workflows #36.

## Dashboard payment report recovery — October 15, 2026 (deployed)

Synthetic fault injection reproduced double-counting when a cycle update
succeeded but the first receipt append failed. The proposed fix persists the
receipt before the new cycle total and repairs a stale summary on same-key
retry. Eleven recovery cases pass; the full suite has 2,760 passes, no failures
and 65 Chromium skips. No live data was inspected or changed. See
`CHANGELOG-payment-report-write-recovery.md` for evidence and audit limits.
Sandra explicitly authorized PR #229: merged as `0d9790a51f10ce914cf3bc9d84b41373f504991d`.
The merged tree passed 2,778 local tests (0 failures, 65 browser skips), GitHub
Tests #337 and Apps Script deploy #99 succeeded, Railway reported SUCCESS and
`/api/version` returned the merge SHA. `/healthz` returned ok; three unauthenticated
home-page requests returned 200 in 6.065 / 5.462 / 5.675 seconds from the test
environment. These are availability checks, not a live payment-write test.
This does not resolve
the CRM numeric-ID blocker or complete the wider finance workflow.

## Managers protocol 2 — October 15, 2026 (candidate active per operator report)

Coordinated Managers/Dashboard hardening requires immutable account IDs,
authenticated and scoped read feeds, private-note ownership by ID, and a
protocol/secret readiness gate. Follow `docs/managers-hardening-rollout.md`.
Sandra reports Managers PR #37 (`7a6ea76`) serving through the separate candidate
from Dashboard PR #223 (`88635fc`), with signed-in read checks passed. Dashboard
#223 is still a draft: merge needs her explicit go, then verified Apps Script
auto-deployment before switching Managers back to the original URL. Final
activation, historical-deployment coverage and live write persistence are not
verified here. The rollout document distinguishes operator reports from checks
independently reproduced in review; account IDs, codes and secrets stay unchanged.


Add this file to the knowledge of EVERY E-Zone app Project (all eight), replacing
the July 22 version, so any future chat/session starts from the true state. This
Sep 10 revision is the UNION of every repo's copy (the per-repo sections that had
drifted — Dashboard git history, Therapists roster source, Managers Sep 5–10 work,
Logistics access code — are folded in below); the same file now lives in all repos.

## Conventions

- Gendered roles: use slash form (רכז/ת, מטפל/ת) in the singular and the masculine plural (רכזים) as inclusive. Never feminine-only for a role.

## Deployment ground truth (branches re-verified July 22, 2026)

| App | Repo | Deploys branch |
|---|---|---|
| Outpatient | ezone-outpatient | **claude/youthful-volta-laarnk** (UNIFIED — see below) |
| Dashboard | E-Zone-Dashboard | claude/build-ezone-dashboard-QOg5s |
| Therapists | ezone-therapists | claude/inspiring-tesla-jipobw |
| Managers | ezone-managers | main |
| Staffing | ezone-staffing | main |
| Kitchen | ezone-kitchen | main |
| Coordinators | ezone-coordinators | main |
| Logistics | sandrabrayer-ezone-logistics | main |

⚠️ Verify the Railway-connected branch in the Railway dashboard before any work —
it is NOT stored in the repo and has been silently switched before (July 3:
outpatient was switched dashboard-hKjf9 → volta, orphaning a day of work). The
clasp CI deploy workflow, by contrast, DOES store the deployed branch (its
`branches:` list) in the repo — see "Apps Script deployment" below.

## Apps Script deployment — automatic via clasp CI (rollout COMPLETE, verified 22/07/2026)

Every E-Zone app's Apps Script backend now auto-deploys from GitHub Actions via
clasp. No more hand-pasting `Code.gs` into the editor. The rollout is complete
and was verified green across all six apps on 22/07/2026 (ezone-therapists
already ran this exact setup — it was the template the six were matched to).

- **Automatic via GitHub Actions** — `.github/workflows/deploy-apps-script.yml`,
  clasp pinned to `@google/clasp@3.3.0`, hardened workflow: it fails loudly and
  early (before touching the live deployment) if a secret is missing or
  `CLASPRC_JSON` isn't valid JSON, and it requires clasp's `Deployed …@<version>`
  confirmation on the redeploy step — so a rejected deployment ID can never pass
  as a green no-op. Runners use `actions/checkout@v5` + `actions/setup-node@v5`
  (Node 24 native — clears the Node 20 deprecation warning) with the clasp
  toolchain on `node-version: '22'`.
- **Trigger** — a push/merge to the app's **deployed branch** that touches
  `apps-script/**` (also `.clasp.json` or the workflow file itself). A
  `workflow_dispatch` trigger allows manual on-demand runs from the Actions tab,
  and a `concurrency` group serializes runs so two pushes can't race the same
  deployment.
- **Redeploys the EXISTING deployment (same `/exec` URL)** — `clasp push -f`
  uploads `apps-script/**`, then `clasp deploy -i <DEPLOYMENT_ID>` republishes
  the existing deployment as a NEW VERSION. The deployment ID is reused, so **the
  `/exec` URL never changes** and no consumer (Railway `APPS_SCRIPT_URL`, sibling
  apps) has to be re-pointed.
- **Secrets (per repo)** — `CLASPRC_JSON` (clasp OAuth tokens from a local
  `clasp login`) + `DEPLOYMENT_ID` (the existing Web App deployment ID, starts
  with `AKfyc…`). Both live ONLY in GitHub Secrets, never in git; the workflow
  `rm`s the runner's token copy at job end (`if: always()`).
- **Token-refresh procedure** — clasp OAuth tokens expire / can be revoked. To
  refresh: run `clasp login` locally (clasp 3.x) → copy the fresh
  `~/.clasprc.json` → update the **`CLASPRC_JSON`** secret **in all six repos**
  (the SAME value everywhere — they share one deploying Google account) → re-run
  the failed deploy job. `DEPLOYMENT_ID` and the per-repo Script IDs are
  unchanged.

### Per-app deployed branch (verified 22/07/2026)

| App | Repo | Deployed branch |
|---|---|---|
| Staffing | ezone-staffing | `main` |
| Kitchen | ezone-kitchen | `main` |
| Coordinators | ezone-coordinators | `main` |
| Outpatient | ezone-outpatient | `claude/youthful-volta-laarnk` |
| Logistics | sandrabrayer-ezone-logistics | `main` |
| Dashboard | E-Zone-Dashboard | `claude/build-ezone-dashboard-QOg5s` |

Each app's workflow `branches:` list and its `.clasp.json` Script ID are the
source of truth for that app's deploy; the deployment ID lives only in the
repo's `DEPLOYMENT_ID` secret. Setup, token-refresh, and the manual fallback are
documented per repo in `DEPLOY.md`.

### ⛔ OBSOLETE — manual copy-paste redeploy (superseded by clasp CI)

The old manual procedure — open the Apps Script editor, paste `Code.gs`, Save,
Deploy → Manage deployments → New version of the EXISTING deployment — is
**SUPERSEDED** by the clasp CI above and must no longer be used for routine
deploys. It is retained only as an emergency fallback (see each repo's
`DEPLOY.md` → "Manual fallback", which uses clasp locally, not the editor). The
CI path is the ecosystem's standard; hand-pasting was the ecosystem's most
error-prone operation (accidental "New deployment" → the `/exec` URL changes →
every consumer breaks).

## Coordinators (רכזים) — Sep 10, 2026: PRs #139–#148 shipped (all merged to `main`, Code.gs redeployed)

Ten coordinators PRs merged Sep 9–10, 2026, one at a time off `main`, Railway
auto-deployed each, and every `Code.gs` change went out as an isolated commit +
manual "Deploy Apps Script" run afterwards (no auto-deploy trigger — policy unchanged).
Suite at #148: **1221 tests green** (`node --test --test-concurrency=1`).

| PR | What shipped | Code.gs |
|---|---|---|
| #139 | **Guide roster is staffing-owned.** `getGuides` syncs from staffing's read-only `getGuidesForCoordinators` feed on every read (name match, phone as secondary key, upsert under LockService; local rows never deleted/renamed; feed down → zero writes, `rosterSource:'local'` + amber notice). Add / remove / rename retired in the app (410 routes, denylist); only «עריכת מינימום» stays. Inactive guides greyed in the picker, red chips on today/future. | yes |
| #140 | **Guide-name migration** `migrateGuideNamesNow(dryRun)` — editor-run, dry-run default; aligns three guide spellings to staffing's and deactivates one departed guide; rewrites references house-scoped across ShiftAssignments / SwapRequests / PickupRequests / Constraints / TrainingRecords. | yes |
| #141 | **קופה קטנה limit 1,000 → 2,000 ₪/month** — single `PETTY_CASH_LIMIT` constant (guard test forbids other literals), admin-only `POST /api/petty-cash/migrate-limit` (dry run unless `confirm:true`), Guide §14. | yes |
| #142 | **Perf**: `getHouseBundle` (one execution per house open) + `getCorrectionState`, sheet cache TTL 300 s, staffing sync `tryLock(2s)`; proxy request **coalescing**, targeted invalidation (`WRITE_INVALIDATES`), stale-while-revalidate (`X-Cache: HIT / STALE / MISS`), warm-up ≤3 in flight. Diagnosis + Railway verification in `docs/perf-bundle.md`. | yes |
| #143 | **Soft delete** in תקציב רווחה + קופה קטנה — 🗑 with a required reason (2–120), `deletedAt/deletedBy/reason` appended columns, summaries skip deleted rows, «רישומים שנמחקו» collapsed section, amber «תיקון עודף» instead of a negative balance. | yes |
| #144 | **Hard block on manual edits** — double shift + one free day per week (+ cap 6) enforced on every manual path (tap-to-correct, draft override, post-publish correction, swap request, swap approval) via `getCorrectionState`; no override flag; picker greys violators with the reason; one shared Hebrew reason map (`REASON_HE`). | no |
| #145 | **WhatsApp group send** — «📤 שליחה לקבוצת המדריכים — כל החודש»: the full schedule (every date × shift, ❗ on unfilled from the board model), `wa.me/?text=` without a number, «העתקה», weekly parts «חלק i/n» over 1,200 chars; the same week button on the ראשי card and the weekly view. Pure builder `lib/whatsapp.js scheduleMessage`. | no |
| #146 | **Team-meeting day per house** — `Houses.MEETING_DAY` (raanana Tue · ramot Mon · rehab Tue · pardes Sun · efroni Thu) is the source of truth; scheduler soft term 50,000 (≥1 shift/week on the meeting day, below the 100,000 minimum, above load); «ישיבת צוות» chip on the board, ראשי and «המשמרות שלי». | no |
| #147 | **Visit order + psychiatrists** — `InpatientSessions.visitOrder` (appended), `inpatientSession` op `move`, «פסיכיאטר/ית» tag from `Therapists.role`. (Superseded on the UI side by #148: order is now by time.) | yes |
| #148 | **לוז מטפלים restructured, therapist-first + timed** — `InpatientSessions.time` (appended, 'HH:MM' text) **required** on add, **no two sessions of one therapist at the same time on a day**, op `setTime`; UI = «שיבוץ לפי מטפל/ת» cards (workdays from `TherapistWorkdays` → «HH:MM · מטופל» slots, off-day confirm) + derived read-only «לוז שבועי» with filters; legacy rows «ללא שעה» + «הגדרת שעה». **Also: house labels always Hebrew** — `Houses.label()` everywhere, staffing ids (`asher` / `ofroni` / `hapardes`) mapped at read, `hapardes → pardes` in the staffing sync map, `test/house-label-guard.test.js`. | yes |

### Script Properties added in this run (never in code)

| App | Property | Purpose |
|---|---|---|
| **Staffing** | `COORDINATORS_READ_SECRET` | Unlocks ONLY the read-only `doGet?action=getGuidesForCoordinators` feed (name · phone · active · houses · startDate — no financial data). Set on the staffing Apps Script (staffing PR #26). |
| **Coordinators** | `STAFFING_SHEETS_URL` | The staffing Apps Script `/exec` URL the guide sync calls. |
| **Coordinators** | `STAFFING_GUIDES_SECRET` | = staffing's `COORDINATORS_READ_SECRET`. Missing / mismatched → sync skipped, local roster served, amber «לא סונכרן מהסטאפינג» notice. |

Both coordinators properties are set and verified (roster line shows «מנוהלת במערכת
הסטאפינג»). The `script.external_request` scope was authorized once by running
`previewStaffingGuideSyncNow` from the editor. No Railway variables were added.

### Coordinators conventions confirmed this run

- One PR at a time, branched off `main`, PR base `main`; explicit-path `git add`;
  CHANGELOG + Guide.html + tests in every PR; SW cache bumped on any asset change
  (now `v120`); `Code.gs` changes in isolated commits, deploy manual after merge.
- Sheets headers are append-only — new columns this run: `WelfareLog` /
  `PettyCashLog` (`deletedAt`, `deletedBy`, `reason`), `InpatientSessions`
  (`visitOrder`, `time`). `_ensureSheet` writes a new header cell on the first
  write after deploy; `_isTimeHeader` pins `time` columns to text.
- The staffing feed is the roster's source of truth; `InpatientAssignments` stays
  dead; no financial data beyond תקציב רווחה + קופה קטנה.

## Outpatient: the two production lines are UNIFIED (July 4, PR #56)

- `claude/ezone-outpatient-dashboard-hKjf9` and `claude/youthful-volta-laarnk`
  had **no common git ancestor** (unrelated histories) and both accumulated real
  features. PR #56 merged dashboard INTO volta (`--allow-unrelated-histories`).
- **claude/youthful-volta-laarnk is now the single canonical production branch.**
  Treat `dashboard-hKjf9` as dead — do not commit there.
- Restored dashboard features now live on volta: createLead endpoint
  (fail-closed via `CREATE_LEAD_SECRET`), LockService around `_saveAll`,
  persisted paymentStatus/paymentDate/nextBillingDate, backdated payment dates,
  renewal anchored on stored nextBillingDate, card extra-charge paid/unpaid
  toggle, optimistic saves, urgency-sorted patient cards, two-panel patient-card
  redesign, סניף location dropdown/source-of-truth, frequency unit שבוע/חודש.
- **CLIENTS_HEADERS is APPEND-ONLY** (33 cols). `_readAll/_writeAll` map the
  live sheet BY POSITION and `_ensureSheet` never migrates data — NEVER reorder
  or remove mid-array columns; append only. Guard tests enforce the exact order.

## Outpatient therapist-payout subsystem (shipped July 1–4)

- "תשלומי מטפלים" tab: monthly per-therapist totals (pre-VAT / with VAT),
  detail toggle, mark-forwarded-to-payroll, Excel/CSV export (UTF-8 BOM).
- Pipeline: therapists app marks a session → posts `recordSessionOutcome`
  (secret `SESSION_OUTCOME_SECRET`, set on BOTH Apps Scripts, fail-closed) →
  outpatient writes a `SessionLog` row → payout tab reads `getSessionLog`.
- **Pay rates live in the `TherapistRates` sheet** (name / flatRate /
  intakeRate / followupRate), auto-seeded, cached 120s (edits apply ≤2 min).
  Names must EXACTLY match the therapists app's full names (e.g.
  'ד"ר מיכאל שפרינץ', 'הילה תבור'). Unknown names fail closed. ~14 newer
  therapists still have blank rates — fill before their sessions can record.
- Credit/quota engine: `creditsOwed` persisted per client, single-cell writes.
- Perf: `loadAll` is PARALLEL (Promise.all, guard-tested); session save writes
  one cell, not the whole Clients sheet.
- Deferred: "+ הוסף סשן חסר"/"תיקון סשן" correction modal; historical backfill
  of sessions recorded before the pipeline existed.

## Managers bonus overhaul shipped July 4, 2026 (PRs #5, #7)

- ALL bonus math now lives ONLY in the frontend (`lib/bonus-eligibility.js`);
  the Apps Script backend's bonus fields (qualifies, lockedIn, projectedBonus,
  quarterly*) are ignored everywhere — backend supplies raw data only
  (avgDaily, treatmentDays, treatmentDaysSoFar, manager names). This ended the
  recurring two-systems-out-of-sync bug. Pending: strip the dead bonus code
  from the live "ezone dashboard" Apps Script.
- Model: tier by average daily occupancy — Ramot 17/19/20, Ra'anana 10/12/14,
  Efroni, Rehab & Pardes 10/12/13 → 2,000/2,500/3,000₪. Treatment-days gate is FIXED
  per house: threshold × 30 (Ramot 510, others 300), independent of month
  length and tier.
- Settled previous-month bonus ("בונוס לתשלום") is the headline: trophy
  winners banner (house + manager + amount), per-card rows, KPI total —
  computed on the 1st for the finished month.
- Quarterly 5,000₪ computed locally: windows anchored May 2026 (May–Jul,
  Aug–Oct…), each finished month's settled bonus must be ≥2,000₪; first
  possible payout end of July 2026. Frontend fetches each finished window
  month via `managersOverview&month=YYYY-MM`.
- Day counts run from the 1st (never front-dated); readability pass
  (text-mute 0.72, small fonts 12–13px). Tests: 36 via `node --test`.
- Efroni house-id checked: data-entry app and backend both use 'arfoni'
  consistently — no mismatch.

## Managers: bonus month labelling (September 8, 2026)

- **Settled vs running month are now two labelled blocks everywhere**
  (`בונוס אוגוסט 2026 — סופי (לתשלום)` / `ספטמבר 2026 — חודש נוכחי (בתהליך)`).
  A settled month shows a final state only (`זכאי · מדרגה X · Y ₪` or
  `לא זכאי · המכסה לא הושלמה (441/510)`) — never `בדרך`/`בתהליך`/`חסרים`.
  Hero banners lead with the settled month; running-month progress is a
  secondary line with the month name and `בתהליך`.
- **Running month = ACTUAL days-so-far from the 1st + a separately labelled
  `צפי לסוף החודש` projection.** A tier is shown as achieved only when
  settled-and-met or locked in; otherwise `מדרגה הבאה: N (P מטופלים/יום) ·
  ממוצע נוכחי X`.
- **Single days-so-far figure**: `public/bonus-view.js` → `daysSoFar` (daily
  chart summed to today; else the feed's `treatmentDaysSoFar` capped at
  elapsed × capacity) feeds the KPI, hero, progress bar and house card. The
  feed's raw `treatmentDaysSoFar` is front-dated (366 vs 102 on 8 Sep) and is
  no longer shown as-is.
- **Stray "2500" under the manager name**: the card rendered the feed's
  `type` field verbatim. House type now comes from `HOUSE_LABELS` only; feed
  manager/name strings pass through `BonusView.safeLabel`. Tests assert no
  backend bonus field reaches the DOM (`test/app-render.test.js`).
- New module `public/bonus-view.js` (labelling only; math stays in
  `lib/bonus-eligibility.js`). Tests: 113 via `node --test`. SW cache v7.
  Details: `docs/bonus-month-labelling.md`. Still pending: strip the dead
  bonus code from the live dashboard Apps Script (unchanged by this work).

## Managers: occupancy history picker (September 10, 2026)

- Every house tab opens with a **"היסטוריית תפוסה"** card: a month picker
  (current month back to the May 2026 quarterly anchor, up to 12 months)
  that shows a past month's daily occupancy chart, `ימי טיפול` vs the fixed
  gate, daily average and settled status — always `(סופי)`, never `בתהליך`.
- Data: `managersOverview&month=YYYY-MM` (shared `fetchMonthOverview_`
  helper); the daily chart from that payload or one
  `managersHouse&house=…&month=…` attempt accepted only when its `month`
  matches. Fetch errors show an explicit error state. **The picker never
  touches the bonus KPIs / hero / cards** (snapshot-tested). SW cache v9,
  tests 125. Details: `docs/occupancy-history-view.md`. Backend unchanged:
  whether the month overview carries a per-house `dailyChart` is decided in
  the dashboard Apps Script.

## Managers: bonus history month picker (September 10, 2026)

- **"חודש בונוס" picker on the overview and on every house tab**: the
  running month (default) plus every finished month back to the May 2026
  quarterly anchor, no cap. One page-wide selection; `חזרה לחודש נוכחי`
  restores the live view. A finished month renders the WHOLE page settled
  through `BonusView.settledMonthView` — `יולי 2026 — סופי`, tier reached,
  amount, gate result — KPIs, winners banner, network chart, house cards,
  house hero, month split, days bar, tier track, quarterly block
  (anchored to the selected month's window, with `מאי ✓ · יוני ✗ · יולי ✓`
  marks) and breakdown. Never `בתהליך` / `בדרך` / `חסרים` / `צפי`; the
  next-tier card is hidden; days-so-far of a finished month = full-month
  total.
- Data: the existing `managersOverview&month=YYYY-MM` fetch only (selected
  month + finished months of its window, ≤ 3 requests), cached per month in
  memory for the life of the page; explicit error state, retried on
  re-select. **No new endpoints, no Apps Script changes.** The running month
  is byte-for-byte unchanged (snapshot-tested). SW cache v10, tests 136.
  Details: `docs/bonus-month-labelling.md` → "Bonus history month picker".

## Dashboard Apps Script: managers work tool (October 13, 2026)

- New action `managersWork` (POST, own fail-closed Script Property
  `MANAGERS_WORK_SECRET`; in OPEN_ACTIONS like the other cross-app actions):
  house patients / outpatients / visits / admissions, and three logs —
  family calls, staff talks (private to author + admins), unusual events —
  with follow-up dates. New sheets `ManagersFamilyCalls`, `ManagersStaffTalks`,
  `ManagersEvents`. Details: `CHANGELOG-managers-work-tool.md`.

## Dashboard Apps Script: temporary exit and return keeps the stay (October 15, 2026)

- **CEO rule**: a return within `READMIT_WINDOW_DAYS = 7` of the exit (same house + name)
  continues the stay.
- **Counting**: one count per patient per day; gap days are not counted (bed-held is not
  recorded).
- **«יום N»**: the admission date and «יום N» run from the first admission; a return is not a
  new admission.
- **From Oct 2026 only** (`STAY_CONTINUITY_FROM_MONTH`); settled months keep the original
  computation byte-for-byte.
- **Audit**: editor-run, read-only `auditTemporaryExitsNow()` (initials only).
- Details: `CHANGELOG-temporary-exit-return.md`.

## Dashboard Apps Script: committee feed — diagnosable refusals (October 15, 2026)

- `getCommitteesForCoordinators`: the secret is **trimmed on both sides** (a pasted trailing
  space / newline no longer reads as a mismatch); still constant-time and fail-closed.
- Our `COORDINATORS_COMMITTEES_SECRET` unset → `{ok:false, error:'unauthorized',
  reason:'not_configured'}` (the coordinators show «הסוד לא הוגדר»); wrong → plain `unauthorized`
  («הסוד לא תואם»). Nothing is read either way.
- Details: `CHANGELOG-committee-feed-diagnostics.md`.

## Dashboard Apps Script: committee feed for the coordinators (October 15, 2026)

- Read-only `getCommitteesForCoordinators` (open action, own fail-closed Script Property
  `COORDINATORS_COMMITTEES_SECRET`). Returns `{ id, name, house, date, label }` only, for
  in-house patients whose committee is today … +3 (Israel time).
- The coordinators' `DASHBOARD_COMMITTEES_SECRET` must equal it.
- Details: `CHANGELOG-coordinators-committee-feed.md`.

## Dashboard: «ועדות קרובות» — committees, read-only (October 15, 2026)

- «דשבורד» card, all houses: «היום» first, then the next 7 days. Each row shows house, patient,
  date, label and «נקבע ע״י <manager> ב-<date>».
- Empty and error states are always visible. Ortal sees it on «בקרת גבייה».
- Apps Script action `upcomingCommittees` (READ-ONLY, only today … +7):
  - same `ManagersCommittee` sheet and readers as Managers;
  - same gate as `expectedDischarges` (`PROXY_SECRET` + a personal session, every logged-in
    user).
- The shared rule lives in `lib/committee-alerts.js`; the fixture `committee-alert-cases.json` is
  pinned in both repos.
- SW v70. No new secret or variable. Details: `CHANGELOG-dashboard-committees.md`.

## Dashboard Apps Script: committee date per patient «ועדה» (October 15, 2026)

- `managersWork` op `committeeSet` (`set` / `clear`) writes the new APPEND-ONLY sheet
  `ManagersCommittee`:
  - keyed by house + patient + admission date: one current date per stay, the last row wins;
  - `label` ≤ 60 chars;
  - who / when / previous date and label on every row.
- Optimistic concurrency on date + label. Israel "today". A past date only as a correction of an
  existing date (`warning: 'past_date'`).
- `houseData` returns `patients[].committee`, `committeeSupported` and `committeeToday`.
- Same secret, house scope and validation as `dischargeSet`; no new property. Details:
  `CHANGELOG-managers-committee.md`.

## Dashboard Apps Script: expected discharge clear + «אין צפי לשחרור» (October 15, 2026)

- `managersWork` `dischargeSet` takes `mode`: `set` (default), `clear`, or `none` («אין צפי
  לשחרור»).
- Both new modes APPEND a row with an empty date: nothing is deleted, and the last row wins.
- `ManagersExpectedDischarge` gets the column `state` appended (`set` / `cleared` / `none`).
  Older rows have `''`, read as a date.
- Concurrency token `previousDate`: `''`, a date, or `none`.
- `houseData` / `expectedDischarges` advertise `expectedDischargeModes`.
- The «שחרורים צפויים» card leaves «אין צפי» patients out of the alerts and out of the no-date
  count. The shared fixture gained `states` (new sha256 in both repos).
- No new secret or property. Details: `CHANGELOG-managers-discharge-clear.md`.

## Dashboard: «שחרורים צפויים» — expected discharges, read-only (October 15, 2026, Task F)

- «דשבורד» card, all houses: expected discharge within 14 days (inclusive), a red «דורש עדכון»
  list for passed dates (patient still in the house), one «N מטופלים ללא תאריך שחרור משוער» line
  per house, and «נקבע ע״י <manager> ב-<date>» per row. No editing: dates change in Managers.
- Apps Script action `expectedDischarges` (READ-ONLY): same `ManagersExpectedDischarge` sheet and
  readers as Managers `houseData` — one source of truth, append-only sheet untouched.
- Gate: `PROXY_SECRET` + a verified personal session — **every user who can log in** (CEO,
  15 Oct 2026; no per-person allow-list, no role check; Ortal sees the card on «בקרת גבייה»).
  No / bad session → 401; a non-personal caller → refused, in both proxy-secret modes; server.js
  refuses first. No new secret or variable. SW v67. `CHANGELOG-expected-discharges-all-users.md`.
- The alert rule is shared with Managers: `lib/discharge-alerts.js` copies the Managers core and
  both repos run the identical fixture `test/fixtures/discharge-alert-cases.json` (sha256 pinned).
- Israel time; text-only rendering; SW v65. Details: `CHANGELOG-dashboard-expected-discharges.md`.

## Dashboard Apps Script: managers expected-discharge save fix (October 15, 2026)

- Managers writes (`dischargeSet`, `logAdd`, `logUpdate`) take the script lock with a checked
  `tryLock(5000)` → JSON `lock_busy`, instead of `waitLock(10000)` that threw and could outlast the
  Managers proxy's 15 s timeout («upstream_error»).
- Editor-run `authorizeSheetsWriteNow()`:
  - `requireAllScopes(FULL)` first;
  - a real temp-sheet write/read/delete;
  - `ManagersExpectedDischarge` ensured.

  Run once after deploy (DEPLOY.md). Details: `CHANGELOG-managers-discharge-save-fix.md`.

## Dashboard Apps Script: managers expected discharge date (October 15, 2026)

- `managersWork` op `dischargeSet` sets / changes a patient's «שחרור משוער»; `houseData`
  returns `expectedDischarge` per patient and `expectedDischargeSupported: true`.
- New APPEND-ONLY sheet `ManagersExpectedDischarge` (every edit a new row: who, when, the
  previous value); a stale `previousDate` → `conflict`, never a silent overwrite.
- Same fail-closed `MANAGERS_WORK_SECRET`; no new Script Property. Details:
  `CHANGELOG-managers-expected-discharge.md`.

## Dashboard Apps Script: managers house manpower cost (October 14, 2026)

- `managersWork` op `houseCost` returns the caller's house cost totals for a month, from the
  staffing feed `getHouseCostsForManagers`.
- Script Properties: `STAFFING_SHEETS_URL` and `STAFFING_COST_SECRET` (= staffing's
  `MANAGERS_COST_READ_SECRET`).
- When the cost can't be read, it returns `available:false`, never 0.
- Details: `CHANGELOG-managers-house-cost.md`.

## Dashboard Apps Script: managers expected admissions (October 14, 2026)

- `managersWork` `houseData` adds `expectedAdmissions`: the open leads of the house with a
  planned entry date between today and +13 days (name, date, stage and who met them only).
- Details: `CHANGELOG-managers-expected-admissions.md`.

## Dashboard Apps Script: managers work tool stage 2, the house team (October 14, 2026)

- `managersWork` `houseData` adds `team`: today's shifts, the next 14 days of shifts, the
  staff list and the therapists' week.
- It reads the Coordinators-owned **ManagersHouse** digest through the new Script Property
  `MANAGERS_DIGEST_SHEET_ID`, which has the same id on both Apps Scripts.
- When it can't read the digest, it returns `available:false` with a reason, never an empty team.
- Details: `CHANGELOG-managers-team.md` and `DIGEST-CONTRACT.md`.

## Dashboard Apps Script: one-time referral facts for the Managers bonus (October 13, 2026)

- `managersOverview_` / `managersHouse_` append `referralStarts: { count,
  items }` per Managers house per month: patients whose FIRST day package
  (day_2x / day_daily) started that month — once per patient, ever. Feeds the
  Managers app's one-time 300 ₪ continued-treatment bonus. Details:
  `CHANGELOG-referral-one-time-feed.md`.

## Dashboard Apps Script: intake-meeting facts for the Managers bonus (October 13, 2026)

- `managersOverview_` / `managersHouse_` append `intakeMeetings: { confirmed,
  pending, items }` per Managers house, per month of ADMISSION: admissions
  whose intake meeting (`Leads.meetingWith`, matched to the Managers tab on
  the admission date) that house's manager held, where the patient was the
  admitted house's 7th+ patient and stayed 30+ days (`pending` while < 30
  days and still in the house). Read-only; raw facts only — the 250 ₪ amount
  and the Oct 2026 start live in the Managers app. Details:
  `CHANGELOG-intake-meeting-bonus-feed.md`.

## Managers: house roster (5 houses, current as of September 5, 2026)

The Managers app (`ezone-managers`) covers FIVE houses. Hardcoded fallbacks
live in `HOUSE_LABELS` (`public/app.js`) and `HOUSE_BONUS`
(`lib/bonus-eligibility.js`); the live feed's `manager` field, when present,
still takes precedence over the hardcoded name. `test/house-coverage.test.js`
and `test/ecosystem-status-doc.test.js` fail CI if any enumeration (or this
table) drifts.

| Key | House | Manager | Type | Eligibility threshold | Capacity |
|---|---|---|---|---|---|
| raanana | רעננה אשר | שחר | בית מאזן | 10 | 14 |
| ramot | רמות השבים | אורן | בית מאזן | 17 | 20 |
| efroni | קיסריה עפרוני | חנן | תחלואה כפולה | 10 | 13 |
| rehab | קיסריה ריהאב | רנטה | גמילה | 10 | 13 |
| pardes | רעננה הפרדס | חן | תחלואה כפולה | 10 | 13 |

- רעננה הפרדס (`pardes`) was added August 24, 2026 with Efroni's bonus
  parameters; the shared dashboard Apps Script must return `pardes` in
  `managersOverview` / `managersHouse` for its live data to appear.
- Manager history: raanana עידו → שחר (Aug 24, 2026); ramot שחר → אורן
  (Aug 25, 2026). Ra'anana's שחר and Ramot's former שחר are different people.
- Efroni's backend house-id is `arfoni` (data-entry app and backend agree);
  the frontend key is `efroni`.

## Dashboard Apps Script: permanent monthly occupancy snapshots (September 17, 2026)

The shared dashboard Apps Script now keeps a **permanent, append-only** record of
each finished month's occupancy per house, so a settled month stops changing when
a historical patient row is edited, merged, repaired or discharged later.
(`managersOverview` recomputes from the LIVE Patients sheet on every call — right
for the running month, wrong as a history.)

- **New sheet `OccupancySnapshots`** — append-only headers `month` (YYYY-MM,
  stored as TEXT) · `houseId` · `treatmentDays` · `daysInMonth` · `avgDaily` ·
  `capacity` · `occupancyPct` · `manager` · `capturedAt`. Rows are **never
  overwritten and never deleted**; an existing month+house row is SKIPPED, so
  every entry point is idempotent. The write is wrapped in `LockService` and
  re-reads the existing keys inside the lock. Houses/capacity are pinned in code
  (a later `BonusConfig` edit must not change what a past month meant): raanana
  14 · ramot 20 · **arfoni** 13 (Efroni's backend id) · rehab 13 · pardes 13. No
  financial data.
- **No duplicated math** — `snapshotMonth_(yyyyMm)` calls `managersOverview_`
  and projects its per-house numbers; there is no second occupancy
  implementation to drift. **Finished months only**: the running month is refused
  (`month_not_finished`), Asia/Jerusalem. A house with no data → no row.
- **New monthly trigger** — `runMonthlyOccupancySnapshot` snapshots the PREVIOUS
  month; `installOccupancySnapshotTrigger()` (editor-run, idempotent) leaves
  exactly one time-driven trigger on the 1st of each month, 03:00–04:00, and
  removes duplicates. `backfillOccupancySnapshotsNow()` writes 2026-05 → the last
  finished month (the same May 2026 anchor the Managers app uses);
  `previewOccupancySnapshotsNow()` is its dry run. None of the four is reachable
  over HTTP.
- **New read-only action** `doGet?action=occupancySnapshots` →
  `{ ok:true, rows:[...] }`, sorted by month then houseId. **Same access model as
  `managersOverview`** — no new secret, no new Script Property. No existing
  action's response shape changed (this backend is shared by Dashboard, Managers
  and Therapists).
- Tests: **983 green** (`node --test`), 37 of them new in
  `test/occupancy-snapshots.test.js`. Details: `CHANGELOG-occupancy-snapshots.md`;
  the two post-deploy editor runs are in `DEPLOY.md` → "Occupancy snapshots".
- **LIVE as of Sep 17, 2026** — OccupancySnapshots: monthly trigger installed
  (1st, 03:00–04:00 Asia/Jerusalem), May–Aug 2026 backfilled. **Two Apps Script
  projects are named "ezone dashboard" (intentional); the CI/live one is
  scriptId `1cY1qkZoAExfkX2NZsB-UCQs7lnSy2RyWC_6UVAYjCnELWkEp9KQvVlOT`**
  (shared — it is the id in this repo's `.clasp.json`, the one clasp CI pushes
  to). If the backfill times out, just re-run it — it is idempotent.

## Monthly revenue: a CROSS-APP contract between Dashboard and Outpatient (September 20, 2026)

Both apps now have a **הכנסות חודשיות** screen answering "how much revenue
belongs to month X", independent of when the cash arrived. Outpatient shipped
first (`ezone-outpatient` PR #109, `public/monthly-revenue.js`); the Dashboard
followed with the same contract inside `public/app.js`. Full rules in each
repo's `CHANGELOG-monthly-revenue.md`.

**These two are meant to be ADDED TOGETHER into a network total, so they must
agree.** Four things are the contract — change one and you must change both, or
a consolidated figure is silently wrong:

1. **Allocation by coverage window, day by day.** A payment covers
   `[dueDate, dueDate + 1 month − 1 day]`; a window straddling a month boundary
   contributes to both months split by day count. ₪3,000 covering 20 Jan – 19 Feb
   gives January 12/31 and February 19/31. **Neither the payment date nor
   `monthKey(dueDate)` takes any part.**
2. **Four figures, and RECEIVED + EXPECTED are never summed into one.** Money in
   hand and a forecast are different certainties; NET is the only place they
   meet and is labelled a projection. Neither app exposes a combined accessor.
3. **Ex-VAT display, ÷1.18**, over amounts stored VAT-INCLUSIVE in both apps.
   Ex-VAT is taken **per row at 2dp** and a bucket total is the sum of its rows,
   so a drill-down reconciles with its header; only the printed value rounds.
4. **Credits split by the span they actually refund** (`creditedFrom..coverageEnd`
   for `days_unused`, the whole window for `prepaid_return`), falling back to
   `allocationMonth` only when the basis is unusable. `allocationMonth` is
   reporting metadata in both ledgers and never enters the math. `pending` and
   `paid` count; `cancelled` does not.

**Both repos assert the SAME worked example numerically** — ₪2,542 ex-VAT for a
₪3,000/month patient billed on the 20th whose December and January cycles are
both paid — in a unit test and again in a real-browser test. If the two ever
diverge, one of those goes red.

**Known asymmetries (deliberate, documented in each changelog):** Outpatient has
a real `paymentDate` column and one-time extra charges; the Dashboard has
neither, and anchors cycles on the patient's **entry day-of-month** rather than a
stored `nextBillingDate`. Outpatient breaks down by `location`, the Dashboard by
`houseId` — the same physical sites, so they line up per site.

**Pitfall this surfaced:** `public/app.js` is one flat script scope, so two
`function foo()` declarations are not two functions — the later silently
overwrites the earlier at hoist time. `monthKey` had been declared twice for a
long time; the copy that looked authoritative was dead code. A guard test now
pins each shared date primitive to exactly one declaration in that file.

### The coverage period is now RECORDED, not assumed (Dashboard, September 21, 2026)

Contract point 1 above said a payment covers `[dueDate, dueDate + 1 month − 1
day]`. In the Dashboard that was an **assumption** — the patient's entry
day-of-month plus "one month paid in advance" — and nothing on the row recorded
whether it was true.

`PAYMENT_COLUMNS` now **appends** `coverageStart` / `coverageEnd`, so the period
is an explicit fact on the payment row. Rules: `CHANGELOG-payment-coverage-period.md`.

- **The cross-app contract is unchanged.** The window rule above is still the
  DEFAULT, stamped onto every payment on write, so nothing in a consolidated
  total moves. The ₪2,542 worked example is untouched and still asserted in
  both apps.
- **Where it comes from changed, not how it is used.** `paymentCoverage()` is
  still the one shared primitive; it now answers from the recorded period when
  the row has one and infers when it does not. Credits arithmetic and the
  monthly view's arithmetic are byte-for-byte the same.
- **Nothing was backfilled.** Historical rows carry blank cells and read
  exactly as before, derived on read.
- **A deliberately edited period is flagged on both screens** — a `מותאמת`
  badge on the גבייה row, a `תקופה מותאמת` chip in the revenue drill-down — so
  a row whose window disagrees with its due date always says so.
- **Outpatient has not adopted this.** It stores a real `nextBillingDate` per
  client and does not have the entry-day inference this fixes. If it ever does
  gain a recorded period, the two must agree on the same default or contract
  point 1 forks.

## Dashboard → accounting app: a read-only source feed (September 22, 2026)

An external **accounting-control app** reconciles what Vered reported as
collected against what actually reached the bank. Dashboard is the SOURCE and
holds **no accounting state** — no confirmation flag, no queue, no invoice.
Vered's workflow is unchanged: she marks a payment paid, and Ortal verifies it
in the accounting app. Full contract: `CHANGELOG-accounting-source-feed.md`.

- **Stable keys.** `PAYMENT_COLUMNS` appends `paymentUid` (`pmt-<uuid>`, minted
  once and permanent), `patientUid` (the persisted Patients `id`, joined on the
  exact billing triple — never by name; ambiguous or unresolved stays blank) and
  a nullable `payerUid`. `CREDIT_COLUMNS` appends `creditUid`. Backfilled under
  the script lock with the `backfillPatientIdsLocked_` pattern: idempotent,
  zero writes and no lock at rest. **The existing `id` schemes are unchanged** —
  billing overrides and the reconcile still key on them.
- **`payerUid` is ALWAYS NULL.** Dashboard has no payer / billing-party entity;
  nothing records who actually pays. The accounting app needs its own explicit
  crosswalk from `patientUid` → billing party. Payer identity is never inferred
  from a name.
- **Charge stamp.** `chargedAt` / `chargedBy` are server-owned, Israel time with
  an explicit offset, from the SIGNED SESSION COOKIE (the who/when rule).
  **`chargedAt` means "reported paid by Vered", NOT "confirmed in the bank".**
  Re-stamped when `amountPaid` moves; **historical rows stay blank and no stamp
  is ever derived**; reads never stamp.
- **Endpoint.** Two READ-ONLY actions on the existing Dashboard `/exec`:
  `accountingPayments` and `accountingCredits`, behind their OWN Script
  Property **`ACCOUNTING_SECRET`** (separate from `ADMITTED_ROSTER_SECRET` /
  `MEETING_REPORT_SECRET`, fail-closed, no write action reachable). Incremental
  via `updatedSince` + an opaque `cursor`, `limit` ≤ 500. Amounts stay
  VAT-INCLUSIVE — do not convert twice. **No clinical data**: the projection is
  an allow-list and drops even the credits' free-text fields.
- **Historical flood guard.** Rows never written since the contract shipped come
  back `historical: true` with `sourceUpdatedAt: null`, and an incremental read
  excludes them by construction. At activation: one full sync → import
  `historical` rows straight to settled, record `serverTime` as the watermark,
  then poll with `updatedSince`.
- **Deletions.** A new `PaymentsTombstones` sheet records the repo's only
  payment-delete path (the orphan-reconcile stray-twin removal) and the feed
  serves them; the recovery copy of the row is never served.
- `server.js`, `public/app.js` and the client are untouched. Known pre-existing
  limitation, deliberately not changed: the web app is `ANYONE_ANONYMOUS`, so
  the `/exec` URL already reaches the write actions — a separate read-only
  deployment is the proper fix and is follow-up work.

## Dashboard Apps Script: proxy secret in TRANSITION mode (October 1, 2026 — Phase 0b-1)

The Dashboard `/exec` now checks a shared **`PROXY_SECRET`** (billing-control
plan §11.1). Full detail: `CHANGELOG-proxy-secret-transition.md`; Sandra's
steps: `DEPLOY.md` → "Proxy secret".

- **New Railway variable (Dashboard):** `PROXY_SECRET`. The server sends it in
  the POST body of every call to its Apps Script (reads are now forwarded as
  POST too — never in a URL). Unset → the server refuses to proxy (503).
- **New Script Properties (Dashboard Apps Script):** `PROXY_SECRET` (same
  value) and `PROXY_SECRET_MODE` = `log` (default) | `enforce`.
- **New tab:** `SecurityLog` (append-only; ≤ 1 row per action per hour for
  calls without a valid secret; never the value).
- **New editor-run:** `securityCallersReportNow()` — read-only 7-day summary
  by action × caller type.
- **⚠️ Managers (`APPS_SCRIPT_URL`) and Therapists (`DASHBOARD_SHEETS_URL`)
  are NOT affected in this phase** — `log` mode serves them and records their
  actions. They WILL break if `PROXY_SECRET_MODE` is set to `enforce` before
  they are given the secret (or a separate read-only deployment). That is the
  coordination step of phase 0b.
- Unchanged and not gated: the actions with their own secret
  (`getAdmittedRoster`, `meetingReportLeads`, `submitMeetingReport`,
  `accountingPayments`, `accountingCredits`).
- Every `LockService.tryLock` result in the Dashboard `Code.gs` is now checked;
  a busy lock returns `{ok:false,error:'lock_busy'}` and writes nothing.

## Dashboard Apps Script: open-actions allowlist, LOG mode (October 1, 2026 — Phase 0b-2)

Detail: `CHANGELOG-open-actions-gate.md`. **Nothing is refused yet, and
nothing needs to be set.**

- `OPEN_ACTIONS` = `managersOverview`, `managersHouse`, `occupancySnapshots`
  (Managers) and `getAdmittedRoster` (Therapists, still with its own secret).
  These are served without `PROXY_SECRET` in log and enforce mode, so
  **Managers and Therapists need no change**.
- **Every other action** (`getData`, all writes, the accounting feed, future
  billing actions) is gated by `PROXY_SECRET` under `PROXY_SECRET_MODE`.
- **⚠ Accounting feed:** `accountingPayments` / `accountingCredits` will be
  refused in enforce mode unless the accounting app sends `PROXY_SECRET`.
  Decide before 0b-3.
- **`SecurityLog`** gains an appended `callerClass` column
  (proxy / open / none / wrong). `securityCallersReportNow` prints
  `non-open actions without a valid secret: N`, which **must be 0 before
  0b-3**.
- The roster, meeting-report and accounting secret checks are now
  constant-time.

## Dashboard: personal PINs — foundation (October 2, 2026 — PR A)

Detail: `CHANGELOG-personal-pins-foundation.md`; decisions: plan §11.5.
**Zero user-facing change. Nothing needs to be set until PR B.**

- **Security fix, live:** the server now trusts exactly one proxy hop
  (Railway) and rate-limits PIN attempts by `req.ip`. Before, the limiter read
  the client-controlled leftmost `X-Forwarded-For`, so a fake value per request
  reset it.
- **New Railway variables (all optional now, used from PR B):**
  `USER_PIN_HASHES` (JSON records; a bad value **stops the server from
  starting**), `PIN_PEPPER`, `BOOTSTRAP_TOKEN` (one-time Sandra setup via
  `POST /api/bootstrap-pin`; delete it afterwards — the log warns while it is
  set), `TRUST_PROXY_HOPS` (escape hatch, default 1).
- **Roles** (`staff, reporter, deleter, approver, viewer, controller`) are sent
  to Apps Script as `proxyRoles`; `Code.gs` believes them only with a valid
  `PROXY_SECRET`. `DELETE_ACTIONS` / `APPROVER_ACTIONS` were defined here and
  are **enforced since PR C** (October 4).
- **Append-only columns:** `AuditLog.actor`, `BillingOverrides.updatedBy`.
  Every delete / void / lead move now writes an AuditLog row with its actor.

## Dashboard: shared code removed, roles enforced (October 4, 2026 — personal PINs PR C)

Detail and Sandra's steps: `CHANGELOG-personal-pins-cleanup.md`.
**Railway + GitHub steps needed: add `HEALTHCHECK_TOKEN`, remove `APP_PIN`.**

- **The shared code is gone.** `APP_PIN`, `APP_PIN_UNTIL`, the dual window
  (`lib/shared-pin-window.js`), the «כניסה עם הקוד המשותף» link, the
  «מי מתחבר/ת?» picker and the amber banner were removed. Every login is a
  personal 6-digit code. A cookie without a personal id (`auth:'shared'`) gets
  **401** everywhere. `POST /api/verify-pin` without `userId` → **400
  user_required**. The server starts with `APP_PIN` unset; if `APP_PIN` or
  `APP_PIN_UNTIL` is still set, the log prints one "set but ignored" warning.
- **Roles enforced** (plan §11.5 decisions 3–4):
  - Every `DELETE_ACTIONS` operation (`removeLead`, `deletePatientRow`,
    `deleteBillingOverride`, `deleteMeetingReport`, `voidPayment`,
    `cancelCredit`) needs **`deleter`**: Vered and Sandra; not Shiran or Yael.
  - Every `APPROVER_ACTIONS` operation (`unvoidPayment`,
    `approveRefundException`, `writeOffOpeningBalance`,
    `acceptOpeningBalance`) needs **`approver`**: Sandra's personal session
    only.
  - Refused → `{ok:false, error:'forbidden_role', message:'אין הרשאה לפעולה זו'}`,
    nothing written, logged with the user id and the operation only.
  - **Code.gs** (`handle_` → `roleAllowed_`) is the authority. **server.js**
    makes the same decision first (`lib/role-scope.js`, HTTP 403), except the
    un-void, which only Code.gs can see (it needs the stored row).
  - A call without a valid `PROXY_SECRET` holds no role, so it can never
    delete.
- **UI:** the delete / void / cancel controls show only for a deleter; the
  un-void only for Sandra (`/api/me` now returns `deleter`).
- **Weekly healthcheck:** its own credential, **`HEALTHCHECK_TOKEN`** (Railway +
  GitHub Actions secret, at least 32 characters). It opens one read-only route,
  `GET /api/healthcheck?action=getData` with `Authorization: Bearer <token>`.
  - The token is compared in constant time.
  - The route serves the restricted getData (no `billingOverrides`).
  - It mints no cookie.
  - It is rate-limited to 10 per IP and 20 in total per 15 minutes.
  - The token is never logged.
- SW `CACHE_VERSION` v28 → v29.

## Dashboard: restricted view for Shiran and Yael (October 3, 2026)

Detail and the full tab → action map: `CHANGELOG-restricted-view.md`.
**Nothing to set in Railway; no `USER_PIN_HASHES` change.**

- **Shiran and Yael** see every tab except גבייה, הכנסות חודשיות, שיוך
  תשלומים and גרף צמיחה, and no billing widget elsewhere: no renewal alert
  or overdue strip on דשבורד, no «זיכויים» on מטופלים משוחררים, no refund
  step after a discharge. They edit as staff and cannot delete.
- **Sandra, Vered:** unchanged, full view. (The shared `APP_PIN` session that
  also kept the full view was removed on October 4 — PR C.)
- **New capability `finance`**, derived from the stable user id
  (`lib/users.js FINANCE_USER_IDS = vered, sandra`).
- **server.js** answers `403 forbidden` («אין הרשאה לצפות בנתוני גבייה») for
  every billing action and route (`lib/finance-scope.js`), and logs the user
  id and the action only. `getData` drops `billingOverrides` for a restricted
  session.
- **Code.gs** refuses the same actions again for a verified actor without
  `finance`, re-deriving it from `proxyAuth` + `proxyUserId` (new proxy-only
  field `proxyCaps`).
- SW `CACHE_VERSION` v26 → v27.

## Dashboard: personal PINs — the live login (October 2, 2026 — PR B)

Detail and Sandra's setup steps: `CHANGELOG-personal-pins-login.md`.
**Superseded on October 4 by PR C: the shared code and its dual window are gone.**

- **Login:** tap your name (only users with an **active** `USER_PIN_HASHES`
  record), then a personal **6-digit** PIN. Per-user lock: 5 failures → 15 min;
  plus 10 per IP and 30 in total per 15 min (`PinLockout`, `req.ip`).
- **Dual window:** new Railway variable **`APP_PIN_UNTIL`** (`YYYY-MM-DD`,
  Israel time, inclusive, at most 14 days ahead). While it is open, the shared
  `APP_PIN` still works through a small link, as a **staff-only** session with an amber
  banner. Unset or past → `APP_PIN` is refused **and existing shared cookies
  get 401**.
- **«קוד אישי חדש»** (Sandra's personal session only; 403 otherwise) makes the
  record line to paste into `USER_PIN_HASHES`. Reset = `pinVersion + 1`;
  revoke = `status: "revoked"`. Either logs the person out after the deploy.
- `Code.gs` unchanged; un-void still = Sandra (now from her personal session).
  Delete/approver roles are **not enforced yet** (PR C, with `APP_PIN` removal).
- SW `CACHE_VERSION` v25 → v26.
- **⚠ Weekly healthcheck** logs in with `APP_PIN`; it will fail after
  `APP_PIN_UNTIL` until PR C gives it its own credential.

## Dashboard: refund payout forecast on גבייה (October 1, 2026)

Detail: `CHANGELOG-refund-payout-forecast.md`. **Nothing to set.**

- New **read-only** action `refundPayoutForecast`, gated by `PROXY_SECRET`
  (not in `OPEN_ACTIONS`). It returns three sections, never summed together:
  saved pending credits grouped by their **stored** `payoutDate`; discharges
  awaiting a refund decision (suggestion > 0); discharges with no recorded
  payment for the exit cycle (shown as «אין תשלום רשום — לבדוק», never 0).
- The existing «זיכויים ממתינים לתשלום» section on גבייה gains those two
  sections and a «ייצוא להנהלת חשבונות» CSV. No new tab, no new column, no
  new Script Property. SW `CACHE_VERSION` v21 → v22.

## Dashboard Apps Script: Ortal's daily payments digest (October 2, 2026)

Detail and setup: `CHANGELOG-ortal-daily-digest.md`. Apps Script only; no
`public/` change, no SW bump, no new HTTP action.

- **One email, Sunday–Thursday ~08:00 Asia/Jerusalem**, to Ortal: every
  payment **recorded** (`chargedAt`, PR #139) since the last successful digest,
  void rows excluded, re-recorded rows marked «עודכן», totals per house and
  overall. Empty → a «אין תשלומים חדשים» heartbeat. No clinical data, no
  phone, no id.
- **New Script Properties (Sandra sets):** `DIGEST_TO` (Ortal — required;
  missing → nothing sent), `DIGEST_CC` (Sandra), `DIGEST_CC_UNTIL`
  (`YYYY-MM-DD`, CC only while today ≤ it). **Written by the digest itself:**
  `DIGEST_LAST_AT`, `DIGEST_LAST_SENT_DAY`, `DIGEST_LEDGER_*`.
- **Setup order (editor):** `authorizeDigestNow` → `previewDigestNow` →
  `sendDigestTestNow` → `installDigestTriggerNow`. Trigger handler:
  `paymentsDigestJob`.
- `appsscript.json` unchanged — `script.send_mail` and `script.scriptapp` were
  already pinned.

## Dashboard: «חובות פתוחים» — debt aging screen + .xlsx (October 2, 2026)

Detail: `CHANGELOG-debt-aging-ui.md`. Railway only: `Code.gs` and
`appsscript.json` unchanged (it reads the existing read-only `debtAging`
action from PR #161).

- A collapsible «חובות פתוחים» section on the גבייה tab, right under the
  refund payout forecast, before «סיכום חודשי». As-of date (default today,
  Israel) with «סוף חודש קודם», a house filter and a patient-status filter.
  «חוב רשום» and «מחזורים ללא רישום» are two blocks, never summed; pending
  credits sit beside them, never subtracted.
- New route `GET /api/export/debt-aging.xlsx?asOf=YYYY-MM-DD&house=…&status=…`
  (session-gated, 400 on a bad parameter, `no-store`), file
  `חובות-YYYY-MM-DD.xlsx`. No new env var, no new Script Property.
- SW `CACHE_VERSION` v23 → v24.

## Dashboard: «ייצוא רשימת תיקונים» — the data-cleanup workbook (October 3, 2026)

Detail: `CHANGELOG-cleanup-workbook.md`. Apps Script **and** Railway.

- New read-only Apps Script action `cleanupReport` (`PROXY_SECRET`, not in
  `OPEN_ACTIONS`, in `PROXY_KNOWN_ACTIONS` and `FINANCE_ACTIONS`). It reuses
  the existing checks (reconciliation §A/§D/§E/§F, `debtAging_`,
  `refundPayoutForecastFor_`) and adds three: cross-tab spellings,
  near-duplicate names in one house, same-month duplicate payments.
- New route `GET /api/export/cleanup.xlsx` (session + `finance`, 403
  otherwise; `no-store`), file `רשימת-תיקונים-YYYY-MM-DD.xlsx`. A button
  «ייצוא רשימת תיקונים» beside «ייצוא זיכויים לאקסל» on the גבייה tab.
- No new env var, no new Script Property, no new scope. SW `CACHE_VERSION`
  v27 → v28.

## Dashboard Apps Script: the strict payment report — foundation (October 4, 2026)

Detail: `CHANGELOG-payment-report-foundation.md`. Apps Script, plus one
workbook tab on Railway. **No user-facing change** on the dashboard screens;
`public/` untouched, no SW bump.

- `Payments` gains 11 appended, text-formatted columns (positions 25–35):
  `receivedDate` (append-only, audited when changed), `method`, `payer`,
  `funder`, `reference`, `recordedBy`/`recordedAt` (server),
  `confirmStatus`/`confirmedBy`/`confirmedAt`/`flagNote` (Ortal's
  confirmation — `controller` or `approver` only). The original 24 columns do
  not move.
- New tab **`Funders`** (`patientId`, `funder`, `effectiveFrom`, `setBy`,
  `setAt`), append-only; `currentFunder_` → latest `effectiveFrom` ≤ date,
  ~~default **פרטי**~~ — **no default since Oct 4 (see below): missing =
  unset «לא הוגדר»**. Created by the editor-run `setupFundersSheetNow`.
- `validatePaymentReport_` (Code.gs) + `lib/payment-report-rules.js`
  (mirror, parity-tested). **Not enforced yet** on `savePayment` (Phase 3
  PR 2 wires the form).
- `debtAging_` and Ortal's digest use `receivedDate` when present, else
  `chargedAt` as before. **The accounting feed (`accountingPayments`) is
  unchanged** — it projects an explicit field list and exposes none of the
  new columns.
- «ייצוא רשימת תיקונים» gains a tab «חסר גורם מממן».
- No new HTTP action, env var, Script Property, scope or trigger.

## Dashboard: the strict payment-report form — live (October 4, 2026)

Detail: `CHANGELOG-payment-report-form.md`. Apps Script **and** Railway.
Phase 3 of `docs/billing-control-plan.md` is complete.

- **One `Payments` row per money received.** New action `reportPayment`
  (`PROXY_SECRET`, `FINANCE_ACTIONS`, not in `OPEN_ACTIONS`). It appends a
  **receipt** row (`id` `rcpt-…`, server-minted) and never edits an amount.
  The cycle row's `amountPaid` / `balance` / `status` are derived from its
  receipts (`recomputeCycleFromReceipts_`). An incomplete report is refused
  (`invalid_report`) with nothing written. `receivedDate` may be at most 90
  days back (older: Sandra only).
- One more appended column, **`legacyAmountPaid`** (position 36): the money a
  cycle held before its first receipt.
- New action `appendFunder` (finance): the patient card's funder editor
  appends to `Funders`.
- **`getPayments`** keeps `payments` (cycles only, derived) and adds
  `receipts` and `funders`.
- **The accounting feed still exports one record per cycle**, with the
  derived total; receipts are not exported.
- Ortal's digest lists one line per receipt, with method and reference.
- The גבייה status dropdown and «שולם בפועל» are gone. The page loads
  `/payment-report-rules.js` (the same `lib/` file). SW `CACHE_VERSION`
  v29 → v30.
- No new env var, Script Property, scope or trigger.

## Dashboard: patient funder on the Funders sheet — no default (October 4, 2026)

Detail: `CHANGELOG-patient-funder-on-funders.md`. Apps Script **and** Railway.
Supersedes #174 / #175 (closed by Sandra).

- **`Funders` is the single source of truth** for the funder (גורם מממן).
  Stored values stay the Hebrew `PAYMENT_FUNDERS` labels (no migration).
  **`FunderHistory` / `setPatientFunder` never shipped.**
- **Missing = unset.** No `Funders` row, or an unrecognized effective label →
  «לא הוגדר» (`unset`), never «פרטי». `reportPayment` with no funder for an
  unset patient is refused (`funder_unset`) instead of writing «פרטי».
- New `public/funder.js` (labels → keys `private`/`btl`/`mod`/`maccabi`,
  `funderAt`, `debtByFunder`). Finance-only UI: amber «לא הוגדר» on the card,
  funder required at admission, «השלמת גורם מממן» on גבייה (incl. released
  patients with open debt), funder filter, funder × house strip on «חובות
  פתוחים» (recorded / unrecorded never summed). Restricted users: no funder
  UI, admission unchanged.
- SW `CACHE_VERSION` v30 → **v32** (v31 is held by open PR #177).
- No new action, env var, Script Property, scope or trigger.

## Dashboard Apps Script: payments the old default funder decided (October 5, 2026)

Detail: `CHANGELOG-defaulted-funder-report.md`. Editor-run
**`defaultedFunderPaymentsReportNow()`**: a dry run that writes nothing to the
sheet. It lists every Payments row written «פרטי» while the patient had no
recognized Funders row on its `receivedDate`, in one private RTL Doc plus a
Logger line (counts and URL, no names). The cleanup workbook gains the tab
«גורם מממן ברירת מחדל» («תשלומים שקיבלו גורם מממן ברירת מחדל»). Fix: set the
funder in «השלמת גורם מממן», then correct a cycle row's funder with
`updatePayment`; a receipt is immutable, so it is voided and reported again.
No `public/` change, no SW bump, no new HTTP action.

## Dashboard: «בקרת גבייה» — Ortal's verification tab (October 4, 2026)

Detail: `CHANGELOG-billing-control-tab.md`. Apps Script **and** Railway.
Phase 4 of `docs/billing-control-plan.md` is complete.

**Extended 06/10/2026 (`CHANGELOG-ortal-billing-access.md`, server + schema):**

- **Ortal can read the full «גבייה» tab**, enforced on the server:
  - the reads: `getData` cut to patients + overrides, payments, credits,
    the refund forecast, debt aging, the fix list;
  - two exports.
- She still cannot write, delete, void or approve. Shiran and Yael are
  still blocked.
- `confirmPayment` takes `partial` (an amount > 0 and below the reported
  one) and a `controlNote` (up to 500 characters).
- Two columns are appended to `Payments`: `confirmedAmount` and
  `controlNote`.
- Every change writes an AuditLog row with at / by / prev / next.
- Only confirmed money reduces the tab's open debt. Shared revenue rules
  and Outpatient are unchanged.

**UI (`CHANGELOG-ortal-verification-status.md`, SW v40):**

- A status dropdown on every «בקרת גבייה» row.
- «שולם חלקית»: an amount field with the remaining balance shown live, its
  own list, and an «יתרה פתוחה» card.
- «+ הערה» on every row.
- Ortal gets a read-only «גבייה» tab
  (`<body class="view-controller view-billing-read">`).

- **Ortal logs in** (`lib/users.js`: `ortal` active, roles `['controller']`
  only). Her session is the **controller view**: the «בקרת גבייה» tab and
  logout, nothing else. server.js refuses every other `/api/sheets` action
  and every other `/api/` route (403, `controllerRouteLock`); Code.gs refuses
  the same (`viewRefused_`) — `getData` included, so she never receives
  patients or leads. Sandra creates her code via «קוד אישי חדש».
- New capability **`billingControl`** (Vered, Sandra, Ortal — by stable id).
  Shiran / Yael never see the tab (403).
- Two new actions, `PROXY_SECRET`-gated, not open:
  `billingControlQueue` (read: receipts + counts + «חובות מעל 60 יום», and
  Sandra's read-only «חריגים פתוחים») and `confirmPayment` (controller or
  approver role; `reported` → `confirmed` / `flagged` (note 2–300) / back;
  atomic bulk; `confirmedBy/At` stamped once; one AuditLog row per change).
  Only the four confirm cells of a receipt are written.
- New route `GET /api/export/billing-control.xlsx` («ייצוא אימות»). The
  debt-aging export is now open to the controller too.
- **הכנסות חודשיות** gains «מאומת» (confirmed receipts allocated by
  coverage) next to «נגבה». No shared revenue rule changed; Outpatient
  untouched.
- **Item H:** `savePayment` refuses any direct `amountPaid` / status move
  (`use_report_payment`), also on cycles without receipts.
- Ortal's digest gains «ממתינים לאימות: N» with a link to `/#billing-control`.
- `/api/me` adds `capabilities`, `billingControl`, `view`, `canConfirm`.
  The page loads `/billing-control-rules.js`. SW `CACHE_VERSION` v32 → **v33**
  (built as v31, rebased onto #178's v32).
- No new env var, Script Property, scope, column or trigger.

## Dashboard ⇄ Coordinators: shared patient roster (October 4, 2026)

Detail: `CHANGELOG-coordinators-roster.md` (Dashboard repo).

- **New Script Property (Dashboard Apps Script):** `COORDINATORS_PATIENTS_SECRET`
  (own secret, fail-closed, constant-time).
- **`getPatientsForCoordinators`** — read-only. Per row EXACTLY `id, name,
  house, active, admissionDate, dischargeDate` (`'yyyy-MM-dd'`, `''` when
  none). `house` = canonical `ramot|raanana|efroni|rehab|pardes`. Active
  patients + discharges from the last 30 days. No phone / billing / payment.
- **`recordDischargeFromCoordinators`** — `id, dischargeDate, reason, by`.
  Immediate effect (status released + exitDate; occupancy, Managers feed and
  the digest follow), idempotent, never deletes; audit on the discharged sheet
  (4 columns appended last). Vered sees these in «🚪 שחרורים מהבתים».
- Both are in `OPEN_ACTIONS` (now six) — they survive `PROXY_SECRET_MODE=enforce`.
- Dashboard: «🟢 קליטת מטופל חדש» on the dashboard (name, house, admission
  date; finance sessions also pick the required funder, as at any admission).
  SW v33 → **v34**.
- **Managers / Therapists payloads unchanged** (guard test pins them).

## Dashboard: pro-bono — the fifth funder (October 5, 2026)

Detail: `CHANGELOG-funder-probono.md`. Apps Script **and** Railway.

- **`PAYMENT_FUNDERS` gains `'פרו-בונו'`, appended LAST** (key `probono` in
  `public/funder.js`). The four existing positions never move.
- **A pro-bono patient owes nothing.** `debtAging_` (Code.gs) now reads the
  `Funders` tab and drops every cycle whose start day is pro-bono from
  `byPatient`, `byHouse` and `totals` (new informational field
  `probonoExcluded`). A mid-stay switch drops only the cycles from that date on.
  `billingControlQueue`'s «חובות מעל 60 יום» follows automatically.
- The page skips pro-bono rows in «לגבייה בתאריך הנבחר», «יתרות פתוחות» and the
  renewal / «ממתינים לתשלום» alerts (finance view only). The funder × house
  strip always shows a ₪0 «פרו-בונו» row. Occupancy, cards and meetings are
  unchanged.
- **Ortal's daily email is unchanged:** every payment received is listed,
  pro-bono or not (money received is always reported). Pro-bono exclusion
  lives only in `debtAging_`, the due list, «יתרות פתוחות» and the alerts.
- A payment report for a pro-bono patient needs an **explicit** funder: the
  form never prefills pro-bono; the savePayment fill path refuses
  `funder_probono_explicit`.
- «ייצוא רשימת תיקונים» gains a last tab, «מטופלי פרו-בונו».
- SW `CACHE_VERSION` v34 → **v37** (v35 / v36 are held by open PRs #181 / #182).
- No new action, env var, Script Property, scope, column or trigger.

## Dashboard: the invoice on the payment report (October 5, 2026)

Detail: `CHANGELOG-payment-invoice.md`. Apps Script **and** Railway.

- **`Payments` gains two columns, appended LAST** (positions 37–38, text):
  `invoiceWanted` (`yes` | `no`) and `invoiceTo` (1–120 characters, no
  formula lead-in). Rows from before stay blank and display «—».
- «דווח תשלום» asks **«חשבונית?» כן / לא with no default**; refused without
  a choice (`invoice_choice_missing`), and with כן without «על שם»
  (`invoice_to_missing`). In the UI and on the server, nothing is written on
  a refusal.
- `updatePayment` may change the pair (on a receipt, it is the only edit
  besides the void), with the same rules and one `payment_invoice_changed`
  AuditLog row.
- Shown in the גבייה receipts list, the «בקרת גבייה» card, «ייצוא אימות»,
  and Ortal's daily email («חשבונית» / «על שם»).
- **Accounting feed (additive, `schemaVersion` still 1):** each cycle record
  gains `invoiceWanted` / `invoiceTo` and `invoices` (one per receipt:
  `receiptUid, receivedDate, amount, void, invoiceWanted, invoiceTo`; `null`
  = from before the question). A receipt edit moves its cycle into the next
  incremental read.
- SW `CACHE_VERSION` v34 → **v38** (v35–v37 are held by open PRs #181–#183).
- No new action, env var, Script Property, scope or trigger.

## Dashboard: page-load performance (October 6, 2026)

Detail: `CHANGELOG-dashboard-perf.md` (carries PR #149, rebased, plus
compressed / content-hashed assets). Apps Script **and** Railway.

- `loadAll` starts `getData` / `getPayments` / `getCredits` **together**.
  The page waits for the slowest read (~2 s est.), not the sum (~11 s est.).
  A session without `finance` still never asks for the money reads.
- `Code.gs` read path: no whole-column format writes, one `getValues` per
  sheet, timezone lookups only for Date cells, and no lock in `getPayments`
  unless there is work. Per load: 51 → 0 writes, 13 → 8 reads, 166 → 0
  timezone lookups. Byte-identical responses.
- Assets: `index.html` links each JS/CSS file as `?v=<content hash>`.
  - Those URLs are `immutable` and served br/gzip; any other request stays
    `no-store`.
  - Apps Script JSON answers are compressed too.
  - Bytes per page: 789 KB → 204 KB on a first visit, 9 KB after.
- SW `CACHE_VERSION` v38 → **v39**, with a new `cache-first-hashed`
  strategy (exact URL; older hashes pruned). `/api/` stays network-only.
- No new action, env var, Script Property, scope, column or trigger.
- Timing lines: `[perf] …` in Apps Script Executions and
  `[E-ZONE][perf] loadAll …` in the browser console.

## Dashboard: re-activated patients stay visible — PR #145's fix re-landed (October 6, 2026)

Detail: `CHANGELOG-reactivation-fix.md`. **Railway only**: `public/app.js`;
`Code.gs` is not touched.

- **The bug:** the load-time heal released any live patient whose stay still
  had an open discharge row. So a patient set back to live through ✏️, direct
  add / intake, admission (same entry date) or restore (with a second open row)
  vanished from the house tab on the next load.
- **The fix:** each of those writes now also closes the stay's open discharge
  rows, using the existing `restorePatientToActive` action. When the heal does
  act, it shows a toast.
- **History:** #145 shipped this fix, #146 reverted it (phones were pinned to a
  stale SW v17 cache), and #147 re-landed only the diagnostic.
- SW `CACHE_VERSION` v40 → **v41**. v17 stays burned and is never reused.
  Phones pick up the new `app.js` through #186's content hash; `activate`
  evicts v40 and any orphaned v17.
- No new action, env var, Script Property, scope, column or trigger.

## Dashboard: «לא נקלט כמטופל» — paid / entering leads with no patient record (October 7, 2026)

Detail: `CHANGELOG-unadmitted-lead-warning.md`. **Railway only**: `public/`;
`Code.gs` is not touched.

- **When it flags:** a lead that is paid (stage בטיפול פעיל, an advance, or a
  recorded payment) or has the outcome «נכנסים לטיפול», whose `entryDate` is
  3+ days ago (Asia/Jerusalem), with no matching Patients row.
- **What it shows:** a red chip on the card, «לא נקלט כמטופל · N ימים», and a
  red count on the לידים tab.
- **Never flagged:** no entryDate; closed, irrelevant, removed or admitted
  leads; an ambiguous match (logged once).
- **The match** is reconciliation report §A's `recLeadPatient_`
  (fromLead → phone → name + house). It is ported to app.js as
  `unadmittedLeadPatient` and parity-tested against the Code.gs original.
- Display only, computed in the browser. Ortal's controller view has no leads
  and is untouched.
- SW `CACHE_VERSION` v41 → **v42** (v41 was the highest on every remote
  branch; v17 stays burned).
- No new action, env var, Script Property, scope, column or trigger.

## Dashboard: duplicate discharges — one open row per stay, «מחק כפילות» (October 7, 2026)

Detail: `CHANGELOG-duplicate-discharges.md`. Apps Script **and** Railway.

- **Root cause:** every discharge confirm minted a new audit id, and
  `dischargePatient_` upserted by that id. So a retry after a lost answer or
  «נשמר חלקית», or a stale tab, appended a second row for the same stay.
- **Credits:** «זיכויים (N)» counts per stay. Two duplicate rows showing «(1)»
  are **one** credit.
- **Server guard:** one OPEN (not restored, not deleted) discharge row per
  stay (house + name + entry date). A second row is refused as `{ ok:true,
  duplicate:true, id }` and nothing is written. Same rule in the coordinators
  discharge and for credits (same stay + rule).
- **Client:** one audit id per modal, an in-flight guard per stay, and the
  toast «השחרור כבר נרשם».
- **«מחק כפילות»** (`deleteDuplicateDischarge`, in `DELETE_ACTIONS` = Vered /
  Sandra): a soft delete with a reason (2–120). It never touches the last row
  of a stay, and refuses a row with its own credit or a stay with a double
  credit. It writes an AuditLog row.
- **Editor-run dry run:** `listDuplicateDischargesNow()`.
- **Columns:** `deletedAt` / `deletedBy` / `deleteReason` appended to the
  discharged sheet. Nothing else is new: no env var, Script Property, scope or
  trigger. Additive for ezone-managers / ezone-therapists.
- SW `CACHE_VERSION` v42 → **v43** (v17 stays burned).

## Dashboard: receipts — month-split label, duplicates, ✏️ edit (October 7, 2026)

Detail: `CHANGELOG-receipt-duplicates-and-edit.md`. **Railway + Code.gs**
(clasp CI on merge). No new column, sheet, Script Property, env var or scope.

- **«אומתו» line:** a month-split confirmed receipt reads «חלק אוקטובר: ₪x ·
  הקבלה המלאה ₪y (תקופה dd/mm–dd/mm) · שולם במלואו». «שולם חלקית» appears
  only for `partial`. The «ייצוא אימות» month columns now read «חלק <חודש>»,
  «הקבלה המלאה» and «סטטוס».
- **Duplicates at report time:** same patient + same amount within 14 days
  of a live receipt → `possible_duplicate`, and nothing is written. Vered
  re-sends with `confirmDuplicate:true`, and AuditLog records
  `payment_duplicate_override`.
- **«כפילות» in Ortal's dropdown** (`confirmPayment` status `duplicate`,
  controller or approver): a required note (2–300) voids the receipt through
  the PR #144 path (`payment_link_duplicate` audit, cycle re-derived, «נגבה»
  drops it). The only live receipt of its cycle is refused. Un-void stays
  Sandra's alone.
- **`listDuplicateReceiptsNow()`**: a read-only editor function. Run it from
  the Apps Script editor and read the Execution log.
- **`editReceipt`** (new, appended to `FINANCE_ACTIONS`; Vered and Sandra
  only): ✏️ on a receipt edits reference, method, payer, the invoice pair and
  coverage. Amount, receivedDate and status are refused server-side. Each
  edit writes one `receipt_edited` audit row with prev / next. Confirmation
  is kept. Ortal gets 403.
- SW `CACHE_VERSION` v43 → **v44** (v43 shipped with the duplicate-discharges PR #193;
  v17 stays burned).

## Dashboard: the cycle balance — one rule (October 11, 2026)

Detail: `CHANGELOG-cycle-balance.md`. **Railway + Code.gs** (clasp CI on
merge). No column, sheet, Script Property or env var; nothing written.
- A cycle's price is owed ONCE per coverage period; the month split is
  display only. Balance = expected − all money attached to the cycle. An
  OPEN cycle owes the month override, else the patient's agreed price
  (`pay`), else its stamp; a settled cycle stays settled.
- Root cause on the live sheet: the cycle row freezes the price at creation,
  and Vered corrects `pay` minutes after reporting (אליהו חן 33,000 → 30,000,
  שחר חיון 35,000 → 32,000, נועם שני 30,000 → 28,000). אוריאן אלון's 10,000 is
  genuine. ינון כהן / טמיר בן מיור carry August-only overrides and need
  Sandra's decision.
- `lib/cycle-balance.js` (window.CycleBalance) = Code.gs `cycleBalanceState_`
  (parity-tested). Used by גבייה (due list, יתרות פתוחות, monthly summary),
  «מטופלים» and `debtAging_` (בקרת גבייה «חובות מעל 60 יום»).
- Under-stamped settled cycles (stamp below the agreed price / override) stay
  «שולם» but are flagged (`underStamped`, gap). They are listed read-only in
  בקרת גבייה («שולם מתחת למחיר», Ortal included, and Sandra's exceptions) and
  never written by the repair. Live: Payments 59 (אביעד חביבאן, gap 5,000).
- Vered's price path = patient ✏️ «תשלום חודשי». Open cycles recompute at
  once; בקרת גבייה is re-read after the save; the audit now carries
  price from → to.
- 121 / 133 (ינון כהן, טמיר בן מיור) left open pending Vered's price
  correction in-app.
- Editor repair `repairStaleCycleAmountsNow()`, a DRY RUN by default, is NOT
  run (see DEPLOY.md).
- SW `CACHE_VERSION` v60 → **v61** (v17 stays burned).

## Dashboard: one payment status for «מטופלים» and גבייה (October 11, 2026)

Detail: `CHANGELOG-payment-status-unified.md`. **Railway + Code.gs** (clasp CI
on merge). No column, sheet, Script Property or env var; nothing written.
- «מטופלים» found a cycle only by the exact id built from the patient's
  CURRENT triple; גבייה used `matchPatientForPayment`. A house move (נועם שני)
  or a payment reported under the lead's name (Payments rows 45 «ערן», 86
  «עדי») split the answers. Now ONE lookup, `patientCycleRecord`, serves
  «מטופלים», the גבייה due list and «דווח תשלום».
- New fail-closed tier 5 `lead_link` (app.js + Code.gs `recMatchPatient_`,
  parity-tested): the row's triple names exactly one lead, and exactly one
  patient has that lead in `fromLead`. Row 76 (עמית יעקובי, no patient) stays
  on «שיוך תשלומים».
- SW `CACHE_VERSION` v59 → **v60** (v17 stays burned).

## Dashboard: tab order follows the business flow (October 11, 2026)

Detail: `CHANGELOG-tab-order.md`. **Railway only** (`public/`); Code.gs not
touched. Top tabs read דשבורד, לידים, **לוח פגישות**, **מטופלים**, then the
rest unchanged (a lead gets a meeting; only after paying is the lead admitted
as a patient). Badges and the default tab unchanged; `SCREENS` mirrors the
nav. Pinned by `test/tab-order.test.js`. SW `CACHE_VERSION` v58 → **v59**
(v17 stays burned).

## Dashboard: inclusive role wording (October 10, 2026)

Detail: `CHANGELOG-inclusive-role-wording.md`. **Railway + Code.gs** (clasp CI
on merge). No column, sheet, Script Property or env var.
- The coordinators feed (`recordDischargeFromCoordinators`) stamps new
  `updatedBy` values as «רכזים · <by>». Rows written before keep «רכזות · <by>»;
  nothing parses the stamp, nothing rewrites old rows. The guard
  `test/inclusive-coordinator-wording.test.js` now runs with zero exceptions.
- House-manager labels (display only): «דיווח מנהל/ת», «דיווח המנהל/ת»,
  «עריכת דיווח מנהל/ת», «המרת פגישות למנהל/ת», «דיווח מנהלי הבתים». The
  conversion strip's unassigned bucket KEY stays «ללא מנהל» (matched in code);
  only its label is «ללא מנהל/ת».
- SW `CACHE_VERSION` v57 → **v58** (v17 stays burned).

## Dashboard: inclusive coordinator wording (October 9, 2026)

Detail: `CHANGELOG-inclusive-coordinator-wording.md`. **Railway only**
(`public/index.html`); Code.gs not touched. Coordinators include men: the
«🚪 שחרורים מהבתים» subtitle now says «ע״י הרכזים» (was «ע״י הרכזות»).
`test/inclusive-coordinator-wording.test.js` fails the build on «רכזת» /
«רכזות» in public/** or a Code.gs string literal (the stored updatedBy stamp
`'רכזות · '` was the one documented exception — removed on October 10, see
«inclusive role wording»). Convention: see «Conventions»
at the top. SW `CACHE_VERSION` v56 → **v57** (v17 stays burned).

## Dashboard: visit-date guard (October 9, 2026)

Detail: `CHANGELOG-visit-date-guard.md`. **Railway + Code.gs** (clasp CI on
merge). No column, sheet, Script Property or env var.
- A lead's visitDate / entryDate must be in [2024, this year + 2]. The page
  never sends one outside it (inline card, lead ✏️, board ✏️, entry modal); the
  field turns amber quietly while typing.
- `saveAll_` refuses a CHANGED out-of-range date (`bad_lead_date`, Hebrew
  message, nothing written); an unchanged damaged date still lets the lead's
  other fields save.
- Damaged rows from before #211 (0002 / 0020 years) are flagged read-only: an
  amber chip on the lead card and «N לידים עם תאריך ביקור לא תקין» at the top
  of «לוח פגישות» (click a name → the lead's ✏️ modal). Fixing the date clears it.
- SW `CACHE_VERSION` v55 → **v56** (v17 stays burned).

## Dashboard: meetings board re-render (October 9, 2026)

Detail: `CHANGELOG-meetings-board-rerender.md`. **Railway only** (`public/app.js`);
Code.gs not touched. No column, sheet, Script Property or env var.
- A visit set or changed on a lead card (date / time / «נפגש עם») shows on
  «לוח פגישות» at once, again when the sheet confirms it, and rolls back off it
  on a failed save. The tab badge is refreshed with the board.
- Entering the tab always renders the board first, from the current leads,
  and follows today's week unless the user navigated to another week.
- A change made while the same field's save is still in flight is no longer
  dropped (typing a date used to save an intermediate year).
- SW `CACHE_VERSION` v54 → **v55** (v17 stays burned).

## Dashboard: meetings board fixes (October 9, 2026)

Detail: `CHANGELOG-meetings-board-fixes.md`. **Railway + Code.gs** (clasp CI on
merge). No column, sheet, Script Property or env var.
- «לוח פגישות» week arrows follow the lead-card RTL convention: «שבוע קודם →» /
  «← שבוע הבא». Text only.
- A lead's scheduled visit now always lands in its week: `getData_` sends
  `visitDate` as `YYYY-MM-DD` (like `visitTime`), and the page reads any other
  shape (Date / UTC timestamp, Sheets serial, DD/MM/YYYY) as the Asia/Jerusalem
  day, never the device's — a Sunday visit no longer slips to the Saturday before.
- SW `CACHE_VERSION` v53 → **v54** (v17 stays burned).

## Dashboard: write-path hardening — PR D, proven saves never hidden (October 8, 2026)

Detail: `CHANGELOG-write-path-hardening.md`. **Railway only** (`public/app.js`);
Code.gs not touched. Admission, direct add / intake and ✏️ patient edit no
longer roll a PROVEN patient save off the screen when only the follow-up
discharge-row flag write fails: the patient stays, the form closes, and the
Hebrew error says the discharge record was not closed (the next load's heal
converges, as before). SW `CACHE_VERSION` v52 → **v53**.

## Dashboard: write-path hardening — PR C, leads and the rest (October 8, 2026)

Detail: `CHANGELOG-write-path-hardening.md`. **Railway + Code.gs** (clasp CI
on merge). No column, sheet, Script Property or env var.
- **R1:** close / restore / «הסר» / delete-report are tracked in flight; the
  meeting-report edit conflict refreshes only after the saves drain.
  Server: `mergeLeads_` no longer re-appends a lead that sits on the closed
  or removed sheet (a stale tab) — reported as `closedSuppressed`, which
  makes that tab resync. `submitMeetingReport_` now takes the script lock.
- **R3:** every lead save (new, ✏️, stage, inline fields, «נפגש עם»
  autosave, report edit) is proven via `saveAll`'s `proven`. One lead id per
  new-lead form; a failure (or «ביטול» on the duplicate-phone question) keeps
  the form open with its values. «הסר» never invents a record; a retry
  replays server-side. The manager report page sends one `submissionId` per
  form (forwarded by `server.js` only when well-formed); a retry replays from
  the script cache (6 h) — no second stamp, «נצפה» not reset.
- SW `CACHE_VERSION` v51 → **v52**.

## Dashboard: write-path hardening — PR B, patients (October 8, 2026)

Detail: `CHANGELOG-write-path-hardening.md`. **Railway + Code.gs** (clasp CI
on merge). No column, sheet, Script Property or env var.
- **R1:** discharge, restore (to a lead / to active), delete and «מחק כפילות»
  are tracked in flight — the visibility resync never reloads under them.
- **R2:** a failed automatic save after a load (promote / heal) shows a
  Hebrew error instead of only a console line.
- **R3:** `saveAll` takes `prove: {leads, patients}` and answers `proven`
  (the ids the sheet holds after the write, read under the same lock).
  Admission, intake, ✏️ edit, discharge and restore-to-active say «נשמר»
  only for a proven row; a stale-edit refusal keeps the ✏️ form open. One
  patient / lead id per form (crypto), so a retry never adds a row. A delete
  retry and a restore-as-lead retry replay on the server.
- SW `CACHE_VERSION` v50 → **v51**.

## Dashboard: write-path hardening — PR A, money (October 8, 2026)

Detail: `CHANGELOG-write-path-hardening.md`. **Railway + Code.gs** (clasp CI
on merge). The three PR #201 rules applied to every money write besides
«דווח תשלום»: void receipt, cycle edits and links, ✏️ coverage, ✏️ amount
(and ↩), receipt edit, funder, credits, Ortal's decisions.
- **R1:** shared read guards (`createReadGuard`) for getData, getPayments,
  getCredits and the «בקרת גבייה» queue; every write is tracked in flight
  (`trackedWrite`). A `getData` answer is never applied while a save is in
  flight or after one landed; it is re-read once the saves drain.
- **R2:** a failed `getCredits` keeps the credits and shows a Hebrew error
  (it used to wipe them silently).
- **R3:** «נשמר» only with the server's copy of the row (`requireSavedId`).
  The ✏️ editors stay open with the typed values on failure. Retries replay:
  a void, a «כפילות», a receipt edit, an Ortal decision and a credit edit
  answer the stored row; `appendFunder` stores the form's `submissionId`
  (new APPENDED `Funders` column) and never writes a second row.
- SW `CACHE_VERSION` v49 → **v50** (v17 stays burned).

## Dashboard: the month split on the «תקופת כיסוי» row (October 8, 2026 — PR #137)

Detail: `CHANGELOG-coverage-month-split.md`. **Railway only** (display); Code.gs
is not touched.

- **What it shows:** under each גבייה row's coverage period, how the amount
  divides across the calendar months it buys: month · days · ₪. The month on
  screen is shown in the accent colour; other months are marked «נדחה».
- **Same numbers as «הכנסות חודשיות»:** it uses `revenueAllocate`, the same
  rule as that screen, with whole-shekel largest-remainder rounding so the
  months always add up to the amount shown.
- SW `CACHE_VERSION` v48 → **v49** (PR #137's original v17 bump renumbered;
  v17 stays burned).

## Dashboard Apps Script: duplicate-payment report (October 8, 2026)

Detail: `CHANGELOG-duplicate-payments-report.md`. **Code.gs only** (clasp CI
deploys it on merge). No column, sheet, Script Property, env var or SW change.

- **What it does:** `duplicatePaymentsReportNow()` is run from the editor. It
  lists non-voided Payments money rows created since 30/09/2026 that share a
  patient or cycle, have the same amount, and either share a payment date or
  were created within 10 minutes of each other.
- **Output:** one private Google Doc; the function logs its URL.
- **Read-only:** the spreadsheet is never written.

## Dashboard: «דוח תשלום» persistence fix (October 8, 2026)

Detail: `CHANGELOG-payment-report-persistence.md`. **Railway + Code.gs**
(clasp CI on merge). Vered saw a reported row flip back to «לא שולם».
The data was in the sheet; the client overwrote it on screen.
- A `getPayments` read that started before a payment write can no longer
  overwrite that write's echo. A request-sequence guard handles this, and a
  report counts as a save in flight for the visibility resync.
- A failed `getPayments` keeps the money state and shows a Hebrew error.
  It no longer wipes every row to «לא שולם» without a message.
- After a confirmed report, the app re-reads `getPayments` with `no-store`
  and reconciles.
- Each report form carries an idempotency key (`submissionId`, a new
  APPENDED `Payments` column). A retry after a lost response returns the
  same receipt and never writes a second one.
- SW `CACHE_VERSION` v47 → **v48** (v17 stays burned).

## Dashboard: «מטופלים» patient list — PR 1, the foundation (October 7, 2026)

Detail: `CHANGELOG-patients-tab-foundation.md`. **Railway only**: `public/app.js`
(pure helpers, not yet called by any render) and a test. Nothing changes on
screen. `Code.gs` is not touched.

- **Helpers:**
  - `patientLeadInfo`: `fromLead` → board / closed / removed lists, else the
    #192 name + house match; ambiguous → no lead.
  - `patientProblems`: ללא גורם מממן · לא דווח תשלום (3+ days) · בית שונה
    מהליד · ללא ליד. The first two are finance only.
  - `patientPaymentState`: the current cycle through the billing helpers.
  - `patientListRows`, `patientProblemSummary`, `pendingAdmissionRows`: the
    #192 rule without its threshold.
- **The lead's details are a display join.** Nothing is copied onto the
  Patients sheet.
- **Admission** (requirement 7): «כניסה לבית» and the load-time promote
  already set `fromLead` and stage `admitted`. Pinned by tests; no
  write-path change.
- No new action, env var, Script Property, scope, column or trigger. SW
  `CACHE_VERSION` unchanged (v44).

## Dashboard: «מטופלים» patient list — PR 2, the tab (October 7, 2026)

Detail: `CHANGELOG-patients-tab-ui.md`. **Railway only**: `public/`; `Code.gs`
and `server.js` are not touched.

- **Placement:** a new tab right after לידים. A red badge counts active
  patients with open problems.
- **The tab, top to bottom:**
  1. A problems summary.
  2. «ממתינים לקליטה»: the #192 rule without its threshold. Each row has
     «קלוט כמטופל» (the «כניסה לבית» modal) and the #192 chip from day 3.
  3. The list, one row per patient. Filters: house, פעילים / משוחררים / הכל,
     בעיות בלבד, name. Columns: name, house, entry date, days, funder,
     payment status, problem chips. Each row has a «פרטי הליד» section, a
     display join from the lead.
- **Actions:** existing flows only — ✏️, «הגדר גורם מממן», «דווח תשלום»,
  «קלוט כמטופל», «שחזר».
- **Visibility:**
  - Shiran / Yael see the tab without the payment column, the funder cell,
    the finance chips or «דווח תשלום».
  - Ortal has no tab.
  - The server already withholds the money data (`FINANCE_ACTIONS`).
- SW `CACHE_VERSION` v44 → **v45**: v44 was the highest on all 159 remote
  branches; v17 stays burned.
- No new action, env var, Script Property, scope, column or trigger.

## Dashboard: grace period for institutional funders (October 7, 2026)

Detail: `CHANGELOG-funder-grace.md`, plan §7.5. **Nothing to set.**

- **The rule (Sandra, 07/10/2026):**
  - A cycle whose funder on its due date is ביטוח לאומי, מכבי or משרד
    הביטחון reads **«ממתין לגורם מממן»** (grey) until 30 days after its due
    date (`FUNDER_GRACE_DAYS = 30`). From day 31 it is red / overdue as
    usual.
  - Private, pro-bono and unset funders are unchanged.
- **Every total is unchanged.** The amount stays outstanding in debt aging,
  «חובות פתוחים», «יתרות פתוחות» and Ortal's open debt. Only the problem
  marking waits:
  - the «לא דווח תשלום» chip and the problem count on מטופלים;
  - the גבייה row status and colour;
  - the overdue strip on the dashboard;
  - a «בתוך תקופת גורם מממן» column in debt aging and its .xlsx.
- **The shared helper** is in `lib/funder-grace.js` (served at
  `/funder-grace.js`) and in `Code.gs` (`isWithinFunderGrace_`). A parity
  test checks that the two agree. `debtAging_` flags each cycle
  (`funderGrace`, `funderGraceUntil`) and counts them (`funderGrace`).
- SW `CACHE_VERSION` v46 → **v47**. v17 stays burned.
- Code.gs changes, so clasp CI deploys it on merge. There is no data change
  and no new action, Script Property, env var, column or trigger.

## Dashboard: refunds automatic by policy — one list «זיכויים לתשלום» (October 14, 2026)

Detail: `CHANGELOG-refunds-auto-policy.md`, plan §8.7. **Nothing to set.**

- **No decision step.** The server creates the refund at discharge
  (`dischargePatient_`, `recordDischargeFromCoordinators_`). It writes only
  positive lines, `pending`, `approvedBy 'מדיניות אוטומטית'`.
  - **Payment date by the exit date:** ≤ 10th → the 15th of that month,
    else the 15th of the next.
  - **Removed:** «ממתין להחלטה — לא לתשלום», the old pending list and the
    post-discharge modal.
- **The rule by the ENTRY date:** `REFUND_POLICY_CUTOVER = '2026-10-07'`, only
  in `Code.gs`, with a guard test.
  - Entry on or after the cutover: the unified stay-day-14 rule for every
    house.
  - Entry earlier: the old per-house rule, unchanged.
  - This replaces the exit-date `REFUND_RULE_V2_FROM` below.
- **Zero-amount credits** (the 7 «ימים שלא נוצלו» ₪0 rows the old modal saved):
  never created again, hidden from the list, not counted as a decision. They
  stay on the sheet.
- **New actions:**
  - `settleRefund` («סמן כשולם», finance, not the controller view);
  - `approveRefundException` (APPROVER_ACTIONS: Sandra's personal session
    only, on both servers).
  - **`saveCredit` recalculates the policy on the server.** An amount equal to
    the policy figure is saved with no approval. A different amount, or a
    manual credit, needs Sandra plus a reason. The client's amount and label
    are never trusted.
  - **«סמן כשולם»:** Vered, Ortal and Sandra (Shiran and Yael refused).
- **`refundPayoutForecast` response:** `toPay`, with totals per payment date, a
  grand total, and rows that carry the full stay. `decided` and
  `awaiting_decision` are removed. Ortal's schema carries every row column. The
  reason for leaving is the disposition label only: the free-text discharge
  note never reaches her.
- SW `CACHE_VERSION` v61 (live) → **v62**. Code.gs → clasp CI on merge.

## Dashboard: global search «🔍 חיפוש» (October 15, 2026)

Detail: `CHANGELOG-global-patient-search.md`. **Railway only; nothing to set.**

- A floating button (and the `/` key) opens one search over patients, leads,
  closed leads and discharged rows, by name or phone (any phone format; a
  patient is reached through its linked lead). A pick opens the record's own tab
  with that tab's filter pre-filled. Read-only, text-only rendering, removed
  from the DOM for the controller view (Ortal).
- It is NOT in the top bar: that bar already overflows below ~1440 px.
- SW `CACHE_VERSION` v62 (live) → **v63**.

## Dashboard: refund rule v2 — stay day 14, every house (October 7, 2026)

Detail: `CHANGELOG-refund-rule-v2.md`, plan §8.6. **Nothing to set.**

- **The rule (Sandra, 07/10/2026), for every house:**
  `stayDay = exit − entry + 1`. The entry day is day 1, and the count runs
  across month boundaries.
  - `stayDay ≥ 14` → no refund for the current cycle.
  - `stayDay` 1–13 → pro-rata of the current cycle, as before.
  - The first draft counted the billing month; Sandra corrected it to the
    stay the same day.
- **Unchanged:** the prepaid full refund, the payout timing (by the 10th → the
  15th), and the rule that exceptions are Sandra-only.
- **Selected by the EXIT date** (superseded 14/10/2026: now by the ENTRY date,
  `REFUND_POLICY_CUTOVER` — see the section above): `REFUND_RULE_V2_FROM`. An
  earlier exit keeps the old per-house rule (the last 7 days for אשר / רמות,
  stay day 14 for the others). Saved credits are never recomputed.
- **The shared rule** is in `lib/refund-rules.js` (served at
  `/refund-rules.js`) and in `Code.gs` (`refundCurrentCycleRule_`,
  `refundRuleVersion_`). A parity test checks that the two agree.
  `suggestRefunds`, the refund forecast and the «זיכויים» modal all follow it.
- SW `CACHE_VERSION` v45 → **v46**. v17 stays burned.
- Code.gs changes, so clasp CI deploys it on merge. There is no new action,
  Script Property, env var, column or trigger.

## Dashboard: meetings strip shows current managers only (PR #154, October 1, 2026; re-verified October 6)

Detail: `CHANGELOG-meeting-summary-active-managers.md`. Apps Script **and** Railway.

- `getData` adds `currentManagers` + `currentManagersSource` (additive;
  `houseManagers` unchanged for ezone-managers / ezone-therapists).
- Source: the `Managers` tab (house | manager_name | start_date | end_date),
  current = start ≤ today ≤ end (blank = open), today in Asia/Jerusalem.
  Missing/empty tab → bonusconfig `manager` column → `houseManagers`.
  Read-only: no tab created, no header written.
- The strip hides former managers and «ללא מנהל»; the meetingWith dropdowns
  and the house default use current managers. A meeting saved with a former
  manager keeps and shows that name — saved data is never rewritten.
- Oct 6: confirmed intact after #186–#188 (no code change, SW stays v40);
  tests added for escaping and the saved-former-manager meeting row.

## Apps Script topology (July 4)

- Outpatient Apps Script: **ONE active deployment** (URL ending FOwWYIw/exec);
  two accidental extra deployments created July 4 were archived. All three
  consumers point at it: outpatient `SHEETS_URL`, therapists
  `OUTPATIENT_SHEETS_URL`, dashboard `OUTPATIENT_LEAD_URL`.
- Dashboard backend: ONE Apps Script serves Dashboard (SHEETS_URL), Managers
  (APPS_SCRIPT_URL), Therapists (DASHBOARD_SHEETS_URL) — rotate together.
- Secrets (Script Properties, never in code): SESSION_OUTCOME_SECRET (new,
  both outpatient+therapists), CREATE_LEAD_SECRET (outpatient — set it to
  enable Dashboard→Outpatient lead handoff), DEBT_STATUS_SECRET,
  TREATMENT_PLANS_SECRET, OCCUPANCY_SECRET, OUTPATIENT_LEAD_SECRET,
  WINBACK_SOURCE_SECRET, ACCOUNTING_SECRET (Dashboard — unlocks ONLY the
  read-only accountingPayments / accountingCredits feed; see the Sep 22 section
  above). Dashboard login: personal codes only (Railway `USER_PIN_HASHES` +
  `PIN_PEPPER`; the shared `APP_PIN` was removed on October 4, 2026 — PR C;
  the weekly healthcheck uses `HEALTHCHECK_TOKEN`). Logistics uses
  SHARED_ACCESS_CODE, its own shared login code. Coordinators' staffing
  pair (STAFFING_SHEETS_URL / STAFFING_GUIDES_SECRET) and staffing's
  COORDINATORS_READ_SECRET: see the Sep 10 coordinators section above.

## Therapists: roster source = the ezone-staffing feed

- The Therapists app's therapist list is SYNCED from ezone-staffing (workers
  with role מטפל/ת) on every getData — `getTherapistsForTherapists`. Names are
  edited in the STAFFING app; `active` is overwritten by every sync (exact-name
  upsert, add/deactivate/reactivate only — never a row delete or rename; all
  downstream matching, incl. outpatient TherapistRates, is exact-string, so
  renames go through staffing + `migrateTherapistNames` + a TherapistRates row
  rename together).
- Secret pairing: staffing's `THERAPISTS_READ_SECRET` = therapists'
  `STAFFING_THERAPISTS_SECRET` (plus `STAFFING_SHEETS_URL` on the therapists
  Apps Script). Unset/unreachable ⇒ NO writes; the last-synced list is served
  and the UI shows an amber "לא סונכרנה" toast. (The coordinators app follows
  the same pattern for guides — see the Sep 10 section.)

## Dashboard git history: the deploy branch is an ORPHAN SNAPSHOT (verified Aug 9, 2026)

`claude/build-ezone-dashboard-QOg5s`'s root commit (`62f5f7b`, "Merge pull
request #18", June 17 2026) has **no parents** — the branch began life that day
as a flattened snapshot of everything through PR #18. The original PR #1–#18
history (phase-2a…2e work) is git-disconnected from it; the old `feature/phase-2*`
and early `claude/*` branches still carry that severed line, which is why they
show alarming "50–64 commits not on the deploy branch" counts. **This is an
artifact, not lost work** — an Aug 9 audit verified the snapshot contains the
full pre-#18 content and that every documented feature since is present at HEAD.
Do not launch a lost-work hunt (or merge one of those stale branches) because of
those counts; content-level comparison, not commit ancestry, is the correct
check against pre-June-17 branches.

## Known pitfalls (hard-won, extended July 4)

- **[OBSOLETE for routine deploys — Apps Script now deploys automatically via
  clasp CI; see "Apps Script deployment" above. Kept as history / emergency
  fallback only.]** Apps Script NEVER auto-syncs from GitHub: paste Code.gs →
  Save → deploy a NEW VERSION of the EXISTING deployment. Wrong choices seen this
  week: new deployment (URL changes, consumers break) and access flipped off
  "Anyone" (consumers get Google's HTML page → "Non-JSON from Apps Script").
- GitHub web editor nests paths when creating files inside a folder — type only
  the filename when already in the folder. Browser re-downloads add " (N)"
  suffixes — drag FOLDERS to the upload page, not loose files.
- Claude Code opens PRs against the repo DEFAULT branch — always verify PR base
  = the deployed branch. PRs #33/#55 were closed for this; #56 was correct.
- Railway variable changes apply only to deployments started after saving.
- PIN inputs have maxlength (Outpatient 6, Dashboard: personal PIN
  `#login-pin-input` **6** since PR B; the shared 4-digit `#pin-input` was
  removed with `APP_PIN` in PR C). The meeting-report page
  (`/meeting-report`) PIN input is 6.

## Next tracks (in priority order)

1. **Outpatient housekeeping**: set GitHub default branch = volta; delete stale
   claude/* branches (incl. dashboard-hKjf9 after a grace period); fill the
   blank TherapistRates rows; review `matchStatus:"no_match"` SessionLog rows.
2. **Outpatient mobile/PWA** ("the phone option"): manifest + service worker +
   letter-E green icons + mobile CSS pass — same recipe as therapists.
3. **Therapists carryovers**: `_cancelFutureBookings` on patient delete (verify
   deployed); live end-to-end quota test (Yarden→Vered); plan-change history.
4. **Logistics**: mobile-responsive, then hardening (חירום auto-approval,
   LockService, deferral wake-up).
5. **Managers + Logistics auth** to the ezone-staffing standard.
6. **Design tokens** across apps; then feature tracks (plan-compliance,
   occupancy forecast, debt aging). Managers bonus distance-to-target: shipped
   July 4.
7. **Dashboard Apps Script cleanup**: strip dead bonus logic (frontend now
   ignores it); keep raw-data endpoints only.

## Alumni feed — `getDischargedRoster` (October 18, 2026)

Dashboard → Therapists, read-only, own fail-closed Script Property `ALUMNI_SOURCE_SECRET`
(`CHANGELOG-discharged-roster-endpoint.md`). Frozen row contract: `sourceApp, name, phone, house,
entryDate, exitDate`; patients released within 730 days; phone via `Patients.fromLead → Leads.phone`
(`''` when unlinked). Open action (no PROXY_SECRET), gated inside `handle_`. Consumer: the therapists
app's alumni list (restructure PR 7).


## 2026-10-18 — createLeadFromTherapists
Dashboard action `createLeadFromTherapists` (own fail-closed Script Property `CREATE_LEAD_SECRET`) appends one lead from the Therapists «בוגרים» tab. See `CHANGELOG-create-lead-from-therapists.md`.


## 2026-10-18 — roster phone recovery
`getAdmittedRoster` / `getDischargedRoster` fall back to the unique same-name lead phone when `fromLead` gives none (read-only, retroactive). See `CHANGELOG-roster-phone-fallback.md`.


## 2026-10-18 — PatientPhones sheet
Manual phone book `PatientPhones` for house patients without a lead phone; auto-listed by `getAdmittedRoster`. See `CHANGELOG-patient-phones-sheet.md`.


## 2026-10-18 — intake captures the phone
«קליטת מטופל חדש» requires the patient's phone and stores it on a linked lead (`fromLead`), so it flows to every feed. See `CHANGELOG-intake-phone.md`.

## Discounts by Vered, Ortal's tab trimmed (October 22, 2026)
- `setBillingDiscount` = `finance` capability (Vered, Sandra) — never Ortal.
  Ortal (`accountant`) only cancels unconfirmed reported amounts
  (`voidUnpaidClaim`). `/api/me` carries `canAccount` and `canDiscount`.
- Ortal's «בקרת גבייה»: «בעיות גבייה» first (two subsections), no releases /
  committees cards. SW v85. See CHANGELOG-discount-by-vered.md.
- No Railway change; Apps Script deploys via clasp CI on merge.

## Open debts fixable in place; income by funder (October 23, 2026)
- «חובות פתוחים», the «השלמת גורם מממן» rows and Ortal's «בעיות גבייה» list now
  carry «שולם» / «שנה סכום» per cycle. `upsertBillingOverride` =
  `finance | accountant | approver` (AMOUNT_ACTIONS); delete stays Sandra-only.
  `/api/me` has `canAmount`. Ortal's unpaid-cycle list: from 2026-01-01, newest first.
- New «הכנסות לפי גורם מממן» (period, funder × house, verified money only).
- SW v86. See CHANGELOG-open-debts-cleanup.md. No Railway change.

## One «חוב פתוח» figure (October 23, 2026)
- «חובות פתוחים», the funder strip and the monthly summary show ONE open-debt
  figure (recorded + unrecorded cycles); the split is a footnote. The monthly
  card reads the debt report loaded when «גבייה» opens. Excel export unchanged.
  SW v87. See CHANGELOG-debt-clarity.md.
