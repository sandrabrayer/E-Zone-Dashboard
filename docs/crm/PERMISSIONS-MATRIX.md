# CRM restructure — permissions matrix (spec §11)

**Session A, 2026-10-27. Docs only.** Updated the same day with Sandra's decisions D5–D17
([SPEC.md](SPEC.md) "Decisions").

**Rule for this matrix:** a permission counts as **implemented** only when a server-side check
enforces it: in `server.js` / `lib/*.js` (Railway) **and/or** `apps-script/Code.gs`. If the UI
hides something but the server would still return or accept it, that is flagged 🟥 **UI-only**.

Sources:
- `lib/users.js:26-42` (`USER_MODEL`)
- `lib/role-scope.js`, `lib/finance-scope.js`, the `server.js` middleware chain (1004-1039)
- Code.gs `viewRefused_` 2194, `financeRefused_` 2172, `roleAllowed_` 2292, plus the handler checks
  listed in [CURRENT-STATE.md](CURRENT-STATE.md) §3

> ⚠️ **Caveat over every row.** While Apps Script runs `PROXY_SECRET_MODE=log` (the documented
> current state), anyone who calls the `/exec` URL **directly**, without the proxy secret, is served
> the non-role-gated actions with no identity. That includes full `getData`, `getPayments`,
> `saveAll`, `reportPayment` and `dischargePatient`. The server checks below protect the Railway
> path; the Code.gs checks protect only *verified* callers. See CURRENT-STATE §8.1.

## Legend

| Mark | Meaning |
| --- | --- |
| ✅ | **Implemented today**, enforced on the server |
| 🟨 | **Agreed but not implemented** (a decision exists in D1–D17, the spec or an earlier signed-off rollout doc; code still differs) |
| ❓ | **Undecided**: needs Sandra's decision |
| 🟥 | **Hiding is UI-only**: the server would serve or accept it |
| — | Not applicable / no access |

Business responsibility, agreed authority and implemented permission are three different things
(spec §11). The "Business role" column records responsibility only. The other columns record what
the system enforces, or what has been decided.

Shiran and Yael are **removed from this matrix** (D5). Their user entries still exist in code;
see §7 for the revoke list.

---

## 1. Identity: who exists where

| Row | Business role | Dashboard identity (server) | Roles (`USER_MODEL`) | Capabilities (decided by id) | Status |
| --- | --- | --- | --- | --- | --- |
| **Vered** (ורד) | Owns the whole client sequence, family contact, billing, payment reporting, problem resolution | `vered`, personal PIN | staff, reporter, deleter | finance, billingControl | ✅ |
| **Ortal** (אורטל) | **Verifier** (D4): payment verification, partial and mismatch handling, billing-task control, accounting-document tracking, **refund execution (D8)** | `ortal`, personal PIN, view `controller` | controller, accountant (accountant is active only when present on her `USER_PIN_HASHES` record) | billingControl | ✅ identity. 🟨 refund-execution-only and the D11 field set. |
| **Dana** (דנה) | Office staff; replaces Yael (D5). **Operational across all houses, no money** (CRM spec §2, supersedes the read-only reading of D5) | `dana`, personal PIN, view `ops` (Stage 1b, 2026-10-28) | staff (ops is decided BY ID: `OPS_USER_IDS`; money actions refused by `lib/finance-scope.js` + Code.gs `financeRefused_`; money fields cut by `lib/ops-scope.js`; her saves keep the stored money fields — Code.gs `preserveMoneyFields_`) | none | ✅ implemented (CHANGELOG-crm-tasks-contact-log.md); her code is created by Sandra |
| **House managers** | Run their house; report intake meetings | **Not Dashboard users.** Today they use (a) ezone-managers (personal code in Railway `MANAGER_ACCESS`; the Managers server calls Code.gs with `MANAGERS_WORK_SECRET`) and (b) `/meeting-report` (one shared `MEETING_REPORT_PIN`). | Managers-app `manager` | — | ✅ as is. 🟨 D3 + D12: per-user identity via ניהול בית, existing passwords carried over. |
| **Coordinators** (רכזים) | Per-house patients, discharges, committees | **No Dashboard access (D6).** Their only view is their own-house roster inside ניהול בית (Phase 3), read-only, via the secret-gated feed. | — | — | ✅ no Dashboard login today. 🟨 own-house scoping of the feed. |
| **Sandra** (הנהלה) | Owner / management. Sole approver: write-offs, discounts (D7), refund decisions (D8), prices (D9). | `sandra`, personal PIN | staff, deleter, approver (only Sandra may hold it), viewer | finance, billingControl | ✅ identity. 🟨 the D7/D8 narrowing below. |
| **Ron** (רון) | ניהול בית only (D1) | **None.** He is `admin` in ezone-managers only (Code.gs:15200). | — | — | ✅ D1 matches today: no Dashboard access |
| **App: ezone-managers** | Machine caller | `MANAGERS_WORK_SECRET` (JSON POST) | body-asserted `manager`/`admin`, `house`, `actorId` | — | ✅ today. 🟨 D12 replaces it as the identity proxy with ניהול בית. |
| **App: ezone-therapists** | Machine caller | `ADMITTED_ROSTER_SECRET`, `ALUMNI_SOURCE_SECRET`, `CREATE_LEAD_SECRET` | — | — | ✅. 🟨 a per-read access log (D10). |
| **App: ezone-coordinators / ניהול בית** | Machine caller | `COORDINATORS_PATIENTS_SECRET`, `COORDINATORS_COMMITTEES_SECRET` | — | — | ✅. 🟨 the D6 house scope and the D12 user/house pair. |
| **App: ezone-outpatient (OUT)** | Receives leads | The Dashboard **calls it** with `OUTPATIENT_LEAD_SECRET`. No inbound Outpatient → Dashboard call is proven in this repo. | — | — | ✅ |

---

## 2. Screens, records, fields and houses (what each row may SEE)

| Row | Screens | Records | Fields | Houses / services | Implemented / agreed / undecided |
| --- | --- | --- | --- | --- | --- |
| **Vered** | All 13 tabs (bc: «חריגים פתוחים» hidden) | All leads, patients, discharges, payments, credits, overrides | All | All houses | ✅. 🟥 «חריגים פתוחים» is Sandra-only by Code.gs response shaping (approver flag), and the billing-control export has no server field cut. ✅ D2: «מטופלים משוחררים» stays hers. |
| **Ortal** | «בקרת גבייה»; read-only «גבייה» when `billingRead` | Only `CONTROLLER_ACTIONS` (server.js:973-981 + Code.gs `viewRefused_`) | **D11 SEES:** patient name, phone, house, entry/exit dates, every payment row, verification state, debt aging, invoice/document status, refund execution. **D11 does NOT see:** lead notes, referrer/contact details, meeting data, clinical notes, bonus data. | All houses | ✅ she gets no lead notes, contacts or meeting data today (controller projection `{id, houseId, name, date, exitDate, status, pay, adv}`). 🟨 **phone is not in her projection yet** (finance-scope.js:129-162) and must be added. 🟨/🟥 the `debtAging` answer and .xlsx have **no controller field cut** (finance-scope.js:238-242); they must be checked against the D11 "does NOT see" list. 🟥 Any other `/api/` route returns 403, **including `/api/version`**. 🟨 her own CRM "היום שלי" (spec §5) is not built. |
| **Dana** | Leads, patients, meetings, calendar, discharges, tasks and the contact log — every operational screen. **No** גבייה, בקרת גבייה, שיוך תשלומים, client-card «חשבון» or payment rows. | leads, patients, discharges, tasks (non-money kinds), activity (non-money kinds) | Cut **on the server**: no payment rows, no `billingOverrides`, no `pay` / `adv` / `advance` / `price` on any lead or patient row (`lib/ops-scope.js`); Activity and Tasks money kinds absent (Code.gs caps). Her `saveAll` never changes a money field (`preserveMoneyFields_`). | **All houses** (D16) | ✅ implemented 2026-10-28 (CHANGELOG-crm-tasks-contact-log.md). 🟨 D16 export (חתכי מטופלים without money columns) builds on the projected `getData` — the client never holds the fields — but no explicit export test yet. |
| **House managers** | Managers app: their house (`mwScopeHouse_`, Code.gs:15306). `/meeting-report`: a lead picker. | Their house's patients, visits, logs, expected admissions | Managers feeds carry no billing. `/meeting-report` leads are whitelisted to `id, name, house, visitDate, officeNote` (server.js:1934-1944). | Managers app: own house ✅. 🟥 **`/meeting-report` lists leads of ALL houses**: one shared PIN, no house filter. | 🟨 D12: per-user identity via ניהול בית, house from the verified session only. Not built. |
| **Coordinators** | **None in the Dashboard (D6).** ניהול בית only. | `getPatientsForCoordinators`: active patients + releases from the last 30 days | `id, name, house, active, admissionDate, dischargeDate` (no phone, no billing) | 🟥 **All houses today**: the secret is not house-scoped. 🟨 D6: own house only. | ✅ field minimisation. 🟨 own-house scope (read: D6; discharge write: D13). |
| **Sandra** | All, including «חריגים פתוחים» and PIN admin | All | All | All | ✅ |
| **Ron** | — | — | — | — (in ezone-managers: all houses as `admin`) | ✅ D1 |
| **ezone-managers app** | — | Patients, leads, visits, logs, snapshots | Non-billing facts (bonus, occupancy) | All houses for an `admin` caller | ✅ today. 🟥 Spec §11: "an inter-app secret is not a user permission". Today the house and role are **asserted by the caller**, and Code.gs trusts them. ✅ D17: its five existing writes (ManagersFamilyCalls / StaffTalks / Events, ManagersExpectedDischarge, ManagersFeedbackLog) **keep working until Phase 3c**, then move to ניהול בית with the bonus card, and ezone-managers goes read-only. 🟨 D15: no NEW write path, ever. |
| **ezone-therapists app** | — | Admitted roster; discharged roster (730 days) | `name, phone, house, entryDate (, exitDate)` | All houses | ✅ D10 keeps the 730 days. 🟨 **one access-log entry per read**. Today only `SecurityLog` records open-action calls, once per action per hour (`securityLogOnce_`, Code.gs:1659), which is not per read. |
| **ezone-coordinators / ניהול בית app** | — | as the Coordinators row | as the Coordinators row | 🟨 own house per user (D6, D12) | ✅ secret-gated today |
| **ezone-outpatient app** | — | Nothing read from the Dashboard (proven) | — | — | ✅ |

---

## 3. Actions (what each row may DO)

Cell values: ✅ allowed and enforced · ⛔ refused by the server · 🟥 allowed only because the server
does not check (the UI hides it) · 🟨 decided, the code still differs (shown as *today → decided*) ·
❓ undecided.

"Mgr" = house managers. "Coord" = coordinators.

| Action | Vered | Ortal | Dana | Mgr | Coord | Sandra | Ron | Server check |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **Create** lead (`saveAll`) | ✅ | ⛔ | ✅ (no `advance`: stripped server-side) | — | — | ✅ | — | ops: `preserveMoneyFields_` ✅ |
| **Create** lead from Therapists | — | — | — | — | — | — | — | therapists app, `CREATE_LEAD_SECRET` ✅. 🟨 `CREATE_LEAD_ASSIGNEES` still lists שירן / יעל (§7). |
| **Edit** lead / patient / meeting (`saveAll`) | ✅ | ⛔ | ✅ (money fields kept from the sheet) | — | — | ✅ | — | ops: `preserveMoneyFields_` ✅ |
| **Edit** patient `pay` / `adv` (price for a stay) | ✅ | ⛔ | ⛔ (server: stored value wins) | — | — | ✅ | — | ✅ for every verified actor without `finance` (`preserveMoneyFields_`); Vered / Sandra unchanged |
| Close / restore lead (`moveLeadIrrelevant`, `restoreLead`) | ✅ | ⛔ | 🟨 must be ⛔ | — | — | ✅ | — | None by role |
| **Discharge** (`dischargePatient`) | ✅ | ⛔ | 🟨 must be ⛔ | — | 🟥 via `recordDischargeFromCoordinators`, **any house today** (immediate, Sandra's decision 2026-10-04). 🟨 **D13: own house only**, from the session house; behind ניהול בית in Phase 4. | ✅ | — | None by role on the Dashboard path. Coordinators: secret only, no house check. **Security gap (D13), fixed in Session B's first code PR (ROLLOUT B0).** |
| Expected discharge date | — | — | — | ✅ (Managers `dischargeSet`) | — | ✅ (admin in Managers) | ✅ (admin in Managers) | `MANAGERS_WORK_SECRET` + body role |
| **Report** meeting outcome (manager report) | — (edit via `saveAll`) | — | — | ✅ `/meeting-report`, shared PIN | — | ✅ | — | `MEETING_REPORT_PIN` + `reporter_not_manager`. 🟥 any manager can report on any house's lead. 🟨 D12 house scope. |
| **Report** payment (`reportPayment`) | ✅ | ⛔ | ⛔ | — | — | ✅ (no 90-day limit) | — | FINANCE ✅ |
| **Verify** payment (`confirmPayment`: confirmed / partial / flagged) | ⛔ | ✅ | ⛔ | — | — | ✅ | — | BC + controller\|approver ✅ |
| **Void** unpaid claim («לא שולם — בטל תביעה») | ⛔ | ✅ (when accountant is on her record) | ⛔ | — | — | ✅ (+ undo) | — | accountant\|approver ✅ |
| **Void** a receipt / payment (`savePayment` void) | ✅ | ⛔ | ⛔ | — | — | ✅ | — | deleter ✅ |
| **Un-void** a payment | ⛔ | ⛔ | ⛔ | — | — | ✅ | — | approver **and** the name 'סנדרה' (Code.gs:9393) ✅ |
| Change billed amount («שנה סכום», `upsertBillingOverride`) | ✅ | ✅ (accountant) | ⛔ | — | — | ✅ | — | finance\|accountant\|approver ✅ (not addressed by D5–D12) |
| **Discount** (`setBillingDiscount`) — **D7** | 🟨 today ✅ → decided ⛔ | ⛔ | ⛔ | — | — | ✅ | — | today: the finance cap (Vered + Sandra). 🟨 D7: approver only, like write-offs. |
| **Price change** — **D9** | — | — | — | — | — | 🟨 decided, not built | — | No feature exists. Price is per stay (`Patients.pay`); BonusConfig is hand-edited. |
| **Refund decision — EXCEPTION**: outside the rule / manual amount (`saveCredit`, `approveRefundException`) — **D8, D14** | ⛔ (needs approver) | ⛔ | ⛔ | — | — | ✅ | — | approver ✅ (`approveRefundException`, `override_requires_approver`) |
| **Refund decision — RULE-BASED** (day-14 / prepaid-cycle), created at discharge — **D14** | automatic (rides `dischargePatient`) | ⛔ | — | — | automatic (rides the coordinator discharge) | automatic | — | ✅ D14: the standing rule is Sandra's decision; no per-case confirmation. |
| **Refund execution** («סימון זיכוי כשולם», `settleRefund`: date, reference) — **D8, D14** | 🟨 today ✅ → decided ⛔ | ✅ | ⛔ | — | — | 🟨 today ✅ → decided ⛔ (never executes) | — | today: FINANCE (controller allowed). 🟨 D8/D14: **Ortal only**, for rule-based and approved-exception refunds alike. |
| Cancel credit | ✅ | ⛔ | ⛔ | — | — | ✅ | — | deleter ✅ |
| Funder (`appendFunder`) | ✅ | ⛔ | ⛔ | — | — | ✅ | — | FINANCE ✅ |
| **Approve** policy exception / write-off | ⛔ | ⛔ | ⛔ | — | — | ✅ | — | approver ✅ |
| **Export** debt aging / refund forecast / cleanup .xlsx | ✅ | ✅ (🟥 debt aging uncut; 🟨 D11 cut) | ⛔ | — | — | ✅ | — | finance-or-controller ✅ |
| **Export** billing-control .xlsx | ✅ | ✅ | ⛔ | — | — | ✅ | — | billingControl ✅. 🟥 approver-only rows depend on Code.gs shaping. |
| **Export** חתכי מטופלים (patient-retention) reports | ✅ | ⛔ | 🟨 ✅ **with no money columns** (D16) | — | — | ✅ | — | Client-side today, from `getData`. 🟨 Dana's export must never contain money fields. |
| **Export** leads funnel («חתכים בלידים») | ✅ | ⛔ | ⛔ (not granted by D16) | — | — | ✅ | — | Client-side today |
| **Export** any payment / debt / revenue data | ✅ | ✅ (per D11) | ⛔ (D16) | — | — | ✅ | — | finance / controller gates ✅ |
| Outpatient handoff («העבר לאמבולטורי») | ✅ | ⛔ | 🟨 must be ⛔ | — | — | ✅ | — | `/api/outpatient-lead`: session only. 🟥 The legacy body creates arbitrary Outpatient leads. |
| PIN admin (incl. revoking Shiran / Yael, §7) | ⛔ | ⛔ | ⛔ | — | — | ✅ | — | approver ✅ |

### Second approver / separation of duties

| Action | First actor | Second actor | Status |
| --- | --- | --- | --- |
| Off-policy refund amount / manual credit | Vered (proposes) | Sandra decides | ✅ enforced |
| **Refund EXCEPTION → execution (D8, D14)** | Sandra approves (outside the rule, write-off, discount) | **Ortal** marks it paid (date + reference) | 🟨 Today Vered, Ortal and Sandra can all `settleRefund`. |
| **Rule-based refund → execution (D14)** | the standing rule (automatic) | **Ortal** marks it paid | 🟨 same `settleRefund` narrowing |
| **Discount (D7)** | Sandra only | none: Sandra is the approver | 🟨 Today Vered can also discount. |
| Un-void a payment | — | Sandra only | ✅ |
| Payment reported → verified | Vered (reports) | Ortal (verifies) | ✅ two different capabilities. Vered cannot confirm; Ortal cannot report. |
| Void an unpaid claim | Ortal | Sandra may undo | ✅ |
| Price change (D9) | Sandra only | — | 🟨 decided, no feature |
| Coordinator discharge | Coordinator (own house, D13) | none (Sandra decided "immediate", 2026-10-04) | 🟥 any house today → 🟨 D13 own house |
| Family request to end treatment → actual exit (spec §9) | Vered (opens follow-up) | the authorised house person | 🟨 agreed in the spec, not implemented |

---

## 4. Every place where hiding is UI-only (🟥)

| # | What | Evidence | Risk |
| --- | --- | --- | --- |
| 1 | The `staff`, `reporter` and `viewer` roles are never enforced | Grep finds them only in `lib/users.js` and Code.gs `KNOWN_ROLES` | Removing a role changes nothing. **Dana's read-only role (D5) cannot reuse them as-is.** |
| 2 | Edit mode (`state.mode === 'edit'`) | `app.js` 1723 / 10769 / 15315; the server has no edit concept | Any session can call `saveAll`, discharge, restore and lead moves |
| 3 | Restricted `getData` is not field-filtered | `finance-scope.js:270`; Code.gs:2759 | A non-finance session receives phones, notes, `pay` / `adv`, discharge notes. That conflicts with D5 for Dana. |
| 4 | Legacy `/api/outpatient-lead` | `server.js:1484-1540` | Any session creates an arbitrary Outpatient lead |
| 5 | Un-void button | `app.js:275-277` (name check); real gate is Code.gs only | OK in Code.gs; the server has no matching check |
| 6 | «חריגים פתוחים», approver rows in the billing-control queue and export | Code.gs response shaping; no server field cut | Correct today; fragile |
| 7 | Ortal's `debtAging` answer and .xlsx | No controller schema (`finance-scope.js:238-242`) | Must be cut to the D11 field set |
| 8 | `/meeting-report` house scope | One shared PIN; leads from all houses | A manager sees and reports another house's leads (D12) |
| 9 | Non-string `action` (array / repeated key) skips the server finance check | `finance-scope.js:250-276` | Code.gs still refuses it; defense-in-depth gap |
| 10 | `PROXY_SECRET_MODE=log` | Code.gs:1637-1642 | Direct `/exec` callers bypass every Railway gate |
| 11 | The Managers `house` / `role` / `actorId` are trusted from the caller body | Code.gs:15260-15267 | Spec §11: a secret is not a user permission (D12) |

---

## 4b. Tasks and the contact log (Stage 1a, 2026-10-28)

`Tasks` sheet + Activity events (`CHANGELOG-crm-tasks-contact-log.md`). Every action needs a verified personal session (the `expectedDischarges` rule) and stamps the actor.

| Action | Vered / Sandra | Ortal | Dana | Server check |
| --- | --- | --- | --- | --- |
| `getTasks` | all tasks | **money tasks only** (`taskVisible_`: `money='1'`) | **non-money tasks only** | Code.gs caps; Ortal via `CONTROLLER_ACTIONS` |
| `createTask` | any kind | ⛔ | any kind except `collection` / money (`forbidden`) | `taskClean_` + `taskVisible_` |
| `completeTask` / `rescheduleTask` | ✅ | ✅ on a money task she can see (closing a verification) | ✅ on a task she can see | `taskMutate_` reads through `taskVisible_` → `not_found` otherwise |
| `reassignTask` / `withdrawTask` (status `cancelled`, reason required, row kept) | ✅ | ⛔ | ✅ on a task she can see | same |
| `logContact` (contact event + fulfilled task + follow-up, one transaction, idempotent by `submissionId`) | ✅ | ⛔ | ✅ | `activityScope_` keeps money kinds away from her |

Decided vs implemented vs gap: all rows above are implemented and tested (`test/crm-tasks-contact-log.test.js`, `test/ops-role-dana.test.js`). Gap: no UI consumer yet (Stage 1c), and the D16 export has no dedicated test.

## 5. What the CRM must add (spec §11 "Enforcement" + D5–D17)

These are all 🟨 agreed, not implemented. Each is a separate server-side PR; none belongs in
Session B (Activity) or in the UI-only Session C PRs.

1. **Server-side field scoping per role** for every CRM read, including search, activity timeline,
   summaries, exports, cache and deep links:
   - Ortal per D11 (add phone; cut debt aging);
   - Dana per D5 (no money fields, no payment rows).
2. ~~A real read-only role for Dana (D5)~~ → **done as the operational role** (2026-10-28, CRM spec §2): money actions refused, money fields cut, saves money-preserving — all on the server.
3. **D7:** `setBillingDiscount` moves from the finance cap to `approver` (Sandra only), in
   `lib/role-scope.js` **and** Code.gs `requiredRoleFor_`.
4. **D8 + D14:** `settleRefund` is allowed for Ortal only (rule-based and approved-exception
   refunds alike). Exceptions (outside the rule, write-off, discount) stay approver-only.
5. **D10:** one access-log row per Therapists roster read: a new append-only log, not the hourly
   SecurityLog.
6. **D6 + D12 + D15:** house scoping on the server for the ניהול בית proxy. The house comes from
   the verified per-user identity (the feed secret plus the asserted user/house pair), never a
   client-supplied house.
6a. **D13 (security gap, first Session B code PR):** `recordDischargeFromCoordinators` refuses a
   patient outside the caller's verified house.
6b. **D15 + D17:** ezone-managers gets no new Dashboard write path. Its five existing writes retire
   in Phase 3c (moved to ניהול בית with the bonus card); it goes read-only then, not before.
6c. **D16:** Dana's חתכי מטופלים export carries no money columns.
7. **No CRM screen widens authority** (§11: "a design change does not widen them").
8. **Turn on `PROXY_SECRET_MODE=enforce`** (Phase 0b-3) before any CRM read model ships. Otherwise
   the server-side enforcement above can be bypassed through `/exec`.

## 6. Decisions — resolved 2026-10-27 (D5–D17)

The eight open questions are answered by D5–D12 in [SPEC.md](SPEC.md):
- Q1 → D5 (Shiran and Yael removed; Dana read-only, no money)
- Q2 → D6 (coordinators: no Dashboard; own-house roster in ניהול בית)
- Q3 → D7 (discounts: Sandra only)
- Q4 → D8 (decision Sandra, execution Ortal, never the same person)
- Q5 → D9 (prices: Sandra; not built)
- Q6 → D10 (keep 730 days; log each read)
- Q7 → D11 (Ortal's field set)
- Q8 → D12 (option (a) via ניהול בית)

### Follow-ups — resolved 2026-10-27

- Coordinator discharge write → **D13** (own house now; behind ניהול בית in Phase 4)
- Automatic policy refunds → **D14** (the rule is Sandra's standing decision; exceptions need her approval)
- D12 completion → **D15**
- Dana's houses and exports → **D16**

### Last two items — resolved 2026-10-27

1. **The end of ezone-managers' Dashboard writes → D17.** The five writes keep working until
   Phase 3c, then move to ניהול בית with the bonus card, and ezone-managers goes read-only.
   D15 is corrected to "never gets a NEW write path".
2. **The session house for D13 → confirmed as a pair** ([ROLLOUT.md](ROLLOUT.md) B0):
   - First, a coordinators PR (**B0-coord**) sends the verified user + house with the shared
     secret. The Dashboard ignores the pair until B0.
   - Then the Dashboard B0 PR enforces it.

No permission question is open at the end of Session A.

---

## 7. Shiran / Yael entries to revoke (D5)

Nothing was changed here (docs-only PR). For Sandra to action:

| Where | Entry | Action |
| --- | --- | --- |
| Railway `USER_PIN_HASHES` (env) | The records with `"id":"shiran"` and `"id":"yael"`, if present | **Revoke** in Railway: Project → the Dashboard service → **Variables** → `USER_PIN_HASHES`. In the two records, either set `"status":"revoked"` or delete them; keep the JSON array valid. Railway redeploys, and their sessions fail on the next request (every request re-checks the record's status, `lib/users.js:166-173`). The in-app «קוד אישי חדש» screen only generates new records and cannot revoke. **Claude does not change Railway variables.** |
| `lib/users.js:34-35` (`USER_MODEL`) | `shiran` and `yael` with roles staff + reporter | Remove in a code PR (with `dana` added once her role exists). Until then a record for them cannot widen anything, but the slots exist. |
| `apps-script/Code.gs:7732` (`CREATE_LEAD_ASSIGNEES`) | `['ורד', 'שירן', 'יעל']` | Code PR: replace with the current assignees (e.g. ורד, דנה). The ezone-therapists sender must change in step, or its lead creation is refused. |
| `public/app.js:15` (`ASSIGNEE_OPTIONS`) | `['ורד', 'שירן', 'יעל']` | Same code PR |
| Leads data (`assignedTo` column) | Open leads assigned to שירן / יעל | Reassign in the UI. Data, not code. |
| Script Properties | **None found** for Shiran / Yael in the repo (Script Property names only; no per-user PIN property exists) | — |
| Comments | `server.js`, `lib/users.js`, `lib/finance-scope.js`, Code.gs and `public/*` comments name them as examples of the restricted view | Tidy in the same code PR; no runtime effect |
