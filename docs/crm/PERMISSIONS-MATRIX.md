# CRM restructure — permissions matrix (spec §11)

**Session A, 2026-10-27. Docs only.**

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
| 🟨 | **Agreed but not implemented** (a decision exists in the spec, in D1–D4, or in an earlier signed-off rollout doc) |
| ❓ | **Undecided**: needs Sandra's decision |
| 🟥 | **Hiding is UI-only**: the server would serve or accept it |
| — | Not applicable / no access |

Business responsibility, agreed authority and implemented permission are three different things
(spec §11). The "Business role" column records responsibility only. The other columns record what
the system enforces.

---

## 1. Identity: who exists where

| Row | Business role | Dashboard identity (server) | Roles (`USER_MODEL`) | Capabilities (decided by id) | Status |
| --- | --- | --- | --- | --- | --- |
| **Vered** (ורד) | Owns the whole client sequence, family contact, billing, payment reporting, problem resolution | `vered`, personal PIN | staff, reporter, deleter | finance, billingControl | ✅ |
| **Ortal** (אורטל) | **Verifier** (D4): payment verification, partial and mismatch handling, billing-task control, accounting-document tracking | `ortal`, personal PIN, view `controller` | controller, accountant (accountant is active only when present on her `USER_PIN_HASHES` record) | billingControl | ✅ (not הנהלה, not admin) |
| **Shiran** (שירן) | Office staff | `shiran`, view `restricted` | staff, reporter | none | ✅ |
| **Yael** (יעל) | Office staff | `yael`, view `restricted` | staff, reporter | none | ✅ |
| **House managers** | Run their house; report intake meetings | **Not Dashboard users.** They use (a) ezone-managers (personal code in Railway `MANAGER_ACCESS`; the Managers server calls Code.gs with `MANAGERS_WORK_SECRET`) and (b) `/meeting-report` (one shared `MEETING_REPORT_PIN`) | Managers-app `manager` | — | ✅ as is · 🟨 D3: CRM access with their existing ezone-managers passwords |
| **Coordinators** (רכזים) | Per-house patients, discharges, committees | **Not Dashboard users.** They use the ezone-coordinators app, which holds `COORDINATORS_PATIENTS_SECRET` / `COORDINATORS_COMMITTEES_SECRET` | — | — | ✅ as is · ❓ CRM access |
| **Sandra** (הנהלה) | Owner / management | `sandra`, personal PIN | staff, deleter, approver (only Sandra may hold it), viewer | finance, billingControl | ✅ |
| **Ron** (רון) | ניהול בית only (D1) | **None.** He is `admin` in ezone-managers only (Code.gs:15200). | — | — | ✅ D1 matches today: no Dashboard access |
| **App: ezone-managers** | Machine caller | `MANAGERS_WORK_SECRET` (JSON POST) | body-asserted `manager`/`admin`, `house`, `actorId` | — | ✅ |
| **App: ezone-therapists** | Machine caller | `ADMITTED_ROSTER_SECRET`, `ALUMNI_SOURCE_SECRET`, `CREATE_LEAD_SECRET` | — | — | ✅ |
| **App: ezone-coordinators** | Machine caller | `COORDINATORS_PATIENTS_SECRET`, `COORDINATORS_COMMITTEES_SECRET` | — | — | ✅ |
| **App: ezone-outpatient (OUT)** | Receives leads | The Dashboard **calls it** with `OUTPATIENT_LEAD_SECRET`. No inbound Outpatient → Dashboard call is proven in this repo. | — | — | ✅ |

---

## 2. Screens, records, fields and houses (what each row may SEE)

| Row | Screens | Records | Fields | Houses / services | Implemented / agreed / undecided |
| --- | --- | --- | --- | --- | --- |
| **Vered** | All 13 tabs (bc: «חריגים פתוחים» hidden) | All leads, patients, discharges, payments, credits, overrides | All | All houses | ✅. 🟥 «חריגים פתוחים» is Sandra-only by Code.gs response shaping (approver flag), and the billing-control export has no server field cut. ✅ D2: «מטופלים משוחררים» stays hers. |
| **Ortal** | «בקרת גבייה»; read-only «גבייה» when `billingRead` | Only `CONTROLLER_ACTIONS` (server.js:973-981 + Code.gs `viewRefused_`) | `getData` projected to `{id, houseId, name, date, exitDate, status, pay, adv}` + overrides (finance-scope.js:129-162). Forecast and cleanup are projected. | All houses | ✅. 🟥 **The `debtAging` answer and its .xlsx have no controller field cut** (finance-scope.js:238-242). 🟥 Any other `/api/` route returns 403, **including `/api/version`**. 🟨 Her own CRM "היום שלי" (spec §5) is not built. |
| **Shiran / Yael** | All tabs except the 4 money tabs (גבייה, הכנסות, שיוך, גרף צמיחה) and «בקרת גבייה» | Every lead, patient and discharge | 🟥 **`getData` is NOT field-filtered**: only `billingOverrides` is removed. They receive lead phone, note and advance, patient `pay` / `adv` / notes, discharge notes and manager phones (finance-scope.js:270; Code.gs:2759). | All houses | ✅ no money actions. 🟥 field exposure. ❓ what they may see in the CRM. |
| **House managers** | Managers app: their house (`mwScopeHouse_`, Code.gs:15306). `/meeting-report`: a lead picker. | Their house's patients, visits, logs, expected admissions | Managers feeds carry no billing. `/meeting-report` leads are whitelisted to `id, name, house, visitDate, officeNote` (server.js:1934-1944). | Managers app: own house ✅. 🟥 **`/meeting-report` lists leads of ALL houses**: one shared PIN, no house filter. | 🟨 D3: a CRM surface with existing passwords, house-scoped on the server. Not built. |
| **Coordinators** | Coordinators app only | `getPatientsForCoordinators`: active patients + releases from the last 30 days | `id, name, house, active, admissionDate, dischargeDate` (no phone, no billing) | 🟥 **All houses**: the secret is not house-scoped. Per-house scoping, if any, lives in the coordinators app (UNKNOWN here). | ✅ field minimisation. ❓ house scoping inside the Dashboard feed. |
| **Sandra** | All, including «חריגים פתוחים» and PIN admin | All | All | All | ✅ |
| **Ron** | — | — | — | — (in ezone-managers: all houses as `admin`) | ✅ D1 |
| **ezone-managers app** | — | Patients, leads, visits, logs, snapshots | Non-billing facts (bonus, occupancy) | All houses for an `admin` caller | ✅. 🟥 Spec §11: "an inter-app secret is not a user permission". Today the house and role are **asserted by the caller**, and Code.gs trusts them. |
| **ezone-therapists app** | — | Admitted roster; discharged roster (730 days) | `name, phone, house, entryDate (, exitDate)` | All houses | ✅ secret-gated. ❓ Is phone exposure for 730 days of alumni agreed? |
| **ezone-coordinators app** | — | as the Coordinators row | as the Coordinators row | All houses | ✅ |
| **ezone-outpatient app** | — | Nothing read from the Dashboard (proven) | — | — | ✅ |

---

## 3. Actions (what each row may DO)

Cell values: ✅ allowed and enforced · ⛔ refused by the server · 🟥 allowed only because the server
does not check (the UI hides it) · ❓ undecided · 🟨 agreed, not built.

Shiran and Yael share the "S/Y" column. "Mgr" = house managers. "Coord" = coordinators.

| Action | Vered | Ortal | S/Y | Mgr | Coord | Sandra | Ron | Server check |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **Create** lead (`saveAll`) | ✅ | ⛔ | 🟥 | — | — | ✅ | — | None by role. 🟥 S/Y can call `saveAll` directly. |
| **Create** lead from Therapists | — | — | — | — | — | — | — | therapists app, `CREATE_LEAD_SECRET` ✅ |
| **Edit** lead / patient / meeting (`saveAll`) | ✅ | ⛔ | 🟥 | — | — | ✅ | — | None by role (edit mode is UI-only) |
| **Edit** patient `pay` / `adv` (price for a stay) | ✅ | ⛔ | 🟥 | — | — | ✅ | — | 🟥 Not money-gated: rides `saveAll` |
| Close / restore lead (`moveLeadIrrelevant`, `restoreLead`) | ✅ | ⛔ | 🟥 | — | — | ✅ | — | None by role |
| **Discharge** (`dischargePatient`) | ✅ | ⛔ | 🟥 | — | ✅ via `recordDischargeFromCoordinators` (immediate, no Vered confirmation, by Sandra's decision 2026-10-04) | ✅ | — | None by role on the Dashboard path |
| Expected discharge date | — | — | — | ✅ (Managers `dischargeSet`) | — | ✅ (admin in Managers) | ✅ (admin in Managers) | `MANAGERS_WORK_SECRET` + body role |
| **Report** meeting outcome (manager report) | — (edit via `saveAll`) | — | — | ✅ `/meeting-report`, shared PIN | — | ✅ | — | `MEETING_REPORT_PIN` + `reporter_not_manager` check. 🟥 Any manager can report on any house's lead. |
| **Report** payment (`reportPayment`) | ✅ | ⛔ | ⛔ | — | — | ✅ (no 90-day limit) | — | FINANCE ✅ |
| **Verify** payment (`confirmPayment` confirmed / partial / flagged) | ⛔ | ✅ | ⛔ | — | — | ✅ | — | BC + controller\|approver ✅ |
| **Void** unpaid claim («לא שולם — בטל תביעה») | ⛔ | ✅ (when accountant is on her record) | ⛔ | — | — | ✅ (+ undo) | — | accountant\|approver ✅ |
| **Void** a receipt / payment (`savePayment` void) | ✅ | ⛔ | ⛔ | — | — | ✅ | — | deleter ✅ |
| **Un-void** a payment | ⛔ | ⛔ | ⛔ | — | — | ✅ | — | approver **and** the name 'סנדרה' (Code.gs:9393) ✅ |
| Change billed amount («שנה סכום», `upsertBillingOverride`) | ✅ | ✅ (accountant) | ⛔ | — | — | ✅ | — | finance\|accountant\|approver ✅ |
| **Discount** (`setBillingDiscount`) | ✅ | ⛔ | ⛔ | — | — | ✅ | — | finance cap ✅ |
| Delete override / meeting report / duplicate discharge / patient row / remove lead | ✅ | ⛔ | ⛔ | — | — | ✅ | — | deleter ✅ |
| **Refund decision**: auto credit on discharge | ✅ (rides `dischargePatient`) | ⛔ | 🟥 (rides `dischargePatient`) | — | ✅ (rides the coordinator discharge) | ✅ | — | Automatic policy |
| **Refund decision**: manual / off-policy amount (`saveCredit`) | ⛔ (needs approver) | ⛔ | ⛔ | — | — | ✅ | — | approver ✅ (`approveRefundException`, `override_requires_approver`) |
| **Refund execution** («סימון זיכוי כשולם», `settleRefund`) | ✅ | ✅ | ⛔ | — | — | ✅ | — | FINANCE (controller allowed) ✅. ❓ Should one person both decide and execute? |
| Cancel credit | ✅ | ⛔ | ⛔ | — | — | ✅ | — | deleter ✅ |
| Funder (`appendFunder`) | ✅ | ⛔ | ⛔ | — | — | ✅ | — | FINANCE ✅ |
| **Approve** policy exception | ⛔ | ⛔ | ⛔ | — | — | ✅ | — | approver ✅ |
| Price list change | — | — | — | — | — | — | — | **No price-list feature exists.** Price is per stay (`Patients.pay`). BonusConfig is hand-edited. ❓ |
| **Export** debt aging / refund forecast / cleanup .xlsx | ✅ | ✅ (🟥 debt aging uncut) | ⛔ | — | — | ✅ | — | finance-or-controller ✅ |
| **Export** billing-control .xlsx | ✅ | ✅ | ⛔ | — | — | ✅ | — | billingControl ✅. 🟥 approver-only rows depend on Code.gs shaping. |
| **Export** every חתך report (leads funnel, patient retention) | ✅ | ⛔ | ✅ (client-side .xlsx from `getData`) | — | — | ✅ | — | Client-side only |
| Outpatient handoff («העבר לאמבולטורי») | ✅ | ⛔ | 🟥 (session only) | — | — | ✅ | — | `/api/outpatient-lead`: session only. 🟥 The legacy body creates arbitrary Outpatient leads. |
| PIN admin | ⛔ | ⛔ | ⛔ | — | — | ✅ | — | approver ✅ |

### Needs a second approver (today)

| Action | First actor | Second approver | Status |
| --- | --- | --- | --- |
| Off-policy refund amount / manual credit | Vered (proposes) | Sandra | ✅ enforced |
| Un-void a payment | — | Sandra only | ✅ |
| Payment reported → verified | Vered (reports) | Ortal (verifies) | ✅ two different capabilities. Vered cannot confirm; Ortal cannot report. |
| Void an unpaid claim | Ortal | Sandra may undo | ✅ |
| Discount | Vered or Sandra | none | ❓ Should a discount need a second approver? |
| Refund execution after decision | Vered or Ortal | none | ❓ |
| Coordinator discharge | Coordinator | none (Sandra decided "immediate", 2026-10-04) | ✅ by decision |
| Family request to end treatment → actual exit (spec §9) | Vered (opens follow-up) | the authorised house person | 🟨 agreed in the spec, not implemented |

---

## 4. Every place where hiding is UI-only (🟥)

| # | What | Evidence | Risk |
| --- | --- | --- | --- |
| 1 | The `staff`, `reporter` and `viewer` roles are never enforced | Grep finds them only in `lib/users.js` and Code.gs `KNOWN_ROLES` | Removing a role changes nothing |
| 2 | Edit mode (`state.mode === 'edit'`) | `app.js` 1723 / 10769 / 15315; the server has no edit concept | Any session can call `saveAll`, discharge, restore and lead moves |
| 3 | Restricted `getData` is not field-filtered | `finance-scope.js:270`; Code.gs:2759 | S/Y receive phones, notes, `pay` / `adv`, discharge notes |
| 4 | Legacy `/api/outpatient-lead` | `server.js:1484-1540` | Any session creates an arbitrary Outpatient lead |
| 5 | Un-void button | `app.js:275-277` (name check); real gate is Code.gs only | OK in Code.gs; the server has no matching check |
| 6 | «חריגים פתוחים», approver rows in the billing-control queue and export | Code.gs response shaping; no server field cut | Correct today; fragile |
| 7 | Ortal's `debtAging` answer and .xlsx | No controller schema (`finance-scope.js:238-242`) | She receives every field debt aging returns |
| 8 | `/meeting-report` house scope | One shared PIN; leads from all houses | A manager sees and reports another house's leads |
| 9 | Non-string `action` (array / repeated key) skips the server finance check | `finance-scope.js:250-276` | Code.gs still refuses it; defense-in-depth gap |
| 10 | `PROXY_SECRET_MODE=log` | Code.gs:1637-1642 | Direct `/exec` callers bypass every Railway gate |
| 11 | The Managers `house` / `role` / `actorId` are trusted from the caller body | Code.gs:15260-15267 | Spec §11: a secret is not a user permission |

---

## 5. What the CRM must add (spec §11 "Enforcement")

These are 🟨 agreed, not implemented. They are inputs to [GAP-LIST.md](GAP-LIST.md) and
[ROLLOUT.md](ROLLOUT.md).

1. **Server-side field scoping per role** for every CRM read, including search, activity timeline,
   summaries, exports, cache and deep links. A field a role may not see is never sent (§11).
   Today only finance keys and Ortal's projection are cut.
2. **House scoping on the server** for house managers (D3) and, if decided, coordinators. The
   house comes from the authenticated identity, never from a request field.
3. **Write gates for the non-money writes** (create / edit / discharge / restore) by role, replacing
   UI-only edit mode. Needs a decision on S/Y (row ❓).
4. **No CRM screen widens authority** (§11: "a design change does not widen them"). Discounts,
   refunds, deletes and prices keep exactly the gates in §3.
5. **Turn on `PROXY_SECRET_MODE=enforce`** (Phase 0b-3) before any CRM read model ships. Otherwise
   the server-side enforcement above can be bypassed through `/exec`.

## 6. Open decisions for Sandra (❓)

1. What Shiran and Yael see and do in the CRM: their fields and write actions.
2. Whether coordinators get any CRM access, and with what house scope.
3. Whether a discount needs a second approver.
4. Whether refund decision and refund execution must be done by different people.
5. Who owns price changes (no feature exists today).
6. Whether Therapists may keep 730 days of alumni phone numbers.
7. Ortal's debt-aging field cut: what she should and should not see.
8. How the D3 manager logins reach the Dashboard. Options:
   - (a) the Managers app proxies with a per-user identity;
   - (b) the Dashboard verifies ezone-managers credentials itself.

   Either way the house must come from the verified identity.
