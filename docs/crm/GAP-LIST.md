# CRM restructure — gap list (spec §4–§10)

**Session A, 2026-10-27. Docs only. No UI is designed here.**

## How to read the tables

- **State**
  - **exists**: works today with the same meaning the spec asks for.
  - **partial**: the data or logic exists, but the screen, scope or meaning falls short.
  - **missing**: nothing exists today.
- **Maps to**: the existing helper, sheet or action to reuse. The spec forbids building a
  parallel mechanism (§2, §14).
- **Kind**: the work type needed.
  - **UI only**: presentation over data and actions that already exist. No Code.gs schema change,
    no new endpoint.
  - **infra**: needs at least one of
    - **S**: a new sheet
    - **E**: a new endpoint or action
    - **Σ**: a schema change to an existing sheet (append-only columns)
    - **X**: a cross-app write or read
    - **P**: server-side permission work

---

## §4 Navigation and shell

| Feature | State | Maps to | Kind |
| --- | --- | --- | --- |
| Fixed right side menu, ~220 px, 6 areas (היום שלי, פניות, לקוחות, יומן, גבייה, בקרה) | missing | The 13 tabs today (`index.html:107-129`) | **UI only** |
| Areas per role and permissions | partial | `allowedScreens()` (app.js:1699) plus the server body classes. This is UI hiding; the server gates exist only for money. | UI + **P** (enforce per area on the server) |
| Header: title, client search, «פנייה חדשה» for permitted users | partial | Global search (app.js:3605); «ליד חדש» modal (8256) | UI only for layout; **P** for "permitted" (no create gate exists today) |
| Search by permitted fields, showing patient vs contact | partial | Global search runs client-side over the full `getData` answer | **infra P + E**: a server-side search that returns only permitted fields. Today the browser already holds everything. |
| «גבייה» sub-screens: גבייה, בקרת גבייה, שיוך תשלומים, מעקב מסמכים | partial | Tabs 7, 8, 10; «בדיקת בקשות חשבונית» | **UI only** (regroup). «מעקב מסמכים» completion needs evidence: see §10. |
| Management content by actual permission | partial | approver-only blocks (Code.gs shaping) | UI + **P** |
| Keep every existing capability reachable | — | All 13 tabs and 21 modals ([CURRENT-STATE](CURRENT-STATE.md) §1–2) | **UI only**. Acceptance check: every current action is reachable from the shell. |
| Mobile: menu drawer, primary actions, list view | partial | Breakpoints 900 / 768 / 640 / 560 / 480 / 420 | **UI only** |

## §5 «היום שלי»

### Vered

| Feature | State | Maps to | Kind |
| --- | --- | --- | --- |
| Clickable KPIs: overdue, today, new leads, meetings today | partial | Dashboard cards, pipeline, meetings board, unadmitted badge | UI only for counts that already exist. "Overdue" needs a due date (below). |
| Work list: leads to follow up | partial | Leads `stage`, `created`, `assignedTo`. **No next-action or due-date field.** | **infra Σ/S**: next action + due date. A Leads column is unsafe (the concat hazard), so a new sheet. |
| Work list: call the family back | missing | none | **infra S** (task or activity record) |
| Work list: meetings without an outcome | partial | Leads `visitDate` < today and `meetingOutcome` blank: computable | UI only (a computed list) |
| Work list: missing manager reports | partial | `visitDate` past and `meetingReportedAt` blank: computable. **No mechanism exists today.** | UI only (computed). Due-date rule ❓ |
| Work list: billing tasks | exists | «להמשך טיפול» (`billingControlQueue_`, `lib/billing-control-rules.js` followupRows) | UI only (reuse) |
| Work list: open transitions | partial | AuditLog `outpatient_lead_sent/failed`; discharges with `continuity` | UI only for "sent / failed". Later steps: **infra X** (§9). |
| Row: client, action, who, due date, state or wait reason, action button | partial | Billing follow-up rows have owner and age, **no due date**. Lead rows have none. | **infra S** (who / due for non-billing items) |
| Separate "overdue", "today" and "waiting on someone else" | partial | Billing follow-up has `waiting` / `funderGrace` | infra (needs due dates) |
| Filter by assignee, house, service within permissions | partial | Client-side filters | UI + **P** |
| Vered keeps overall responsibility when someone else does the step | missing | — | **infra S** (an owner vs assignee distinction) |
| A task closes only on evidence from the source; a note never closes it | partial | Billing queue closes from Payments state ✅. CRM #220 encodes "only fresh complete evidence closes". | infra (closure rules per task type) |
| Task age never resets on refresh or reassignment | partial | Billing: `ageDays` from source dates ✅. #220 retains original deadlines. | infra (a stored `openedAt` for non-billing tasks) |

### Ortal

| Feature | State | Maps to | Kind |
| --- | --- | --- | --- |
| Payment reports awaiting verification | exists | «ממתין לאימות» `#bc-queue` | UI only |
| Partial verifications and differences to clarify | exists | «שולם חלקית», «סומנו כבעיה», «שולם מתחת למחיר» | UI only |
| Problems returned to Vered and waiting | exists | follow-up rows `flagged → owner vered` | UI only |
| Tracking billing tasks | exists | «להמשך טיפול», reminder preview | UI only |
| Waiting on funders | exists | `funderGrace` in the follow-up queue (`lib/funder-grace.js`) | UI only |
| Document requests and issuance evidence | partial | «בדיקת בקשות חשבונית» (requests). **No issuance evidence.** | **infra X/Σ** (a Hashavshevet evidence field or feed; `docs/billing-document-evidence.md`) |
| Ortal sees only her permitted scope | exists | `CONTROLLER_ACTIONS` + projection (server + Code.gs) | ✅. Debt-aging field cut is missing (**P**). |

## §6 «פניות»: card board and table

| Feature | State | Maps to | Kind |
| --- | --- | --- | --- |
| Cards by stage | exists | Kanban `renderKanban` (stages new / visit / waitlist / paid) | UI only (restyle) |
| Dense sortable table, same data and filters | missing | same `state.leads` | **UI only** |
| Card: name, service or house, source chip, assignee, stage, next action + due | partial | `name`, `house`, `source`, `assignedTo`, `stage` exist. **Next action and due date do not.** | UI only + **infra S** for next action |
| Stage vs next action vs alert kept separate | partial | Stage exists. The unadmitted chip is an alert. Next action is missing. | infra S |
| Primary button names the action («תיאום פגישה», «תיעוד שיחה», «דיווח תוצאה») | partial | Existing modals: edit lead, meeting edit, close | UI only for buttons mapped to existing modals. «תיעוד שיחה» needs **infra S** (Activity). |
| Opening and closing a card keeps filters, sort and scroll | missing | — | **UI only** |
| Board stages match existing data; any status change needs an explicit mapping | — | Stage enum (CURRENT-STATE §4) and every consumer (LINKED-APPS §9) | Rule: **no stage renames in B or C** |

## §7 Client card

| Feature | State | Maps to | Kind |
| --- | --- | --- | --- |
| Wide left drawer on desktop, full screen on mobile | missing | Today: lead edit modal, patient edit modal, discharged row | **UI only** |
| Fixed header: name, active service or period, main contact + relation, owner, next action + due | partial | Lead `contactName/Phone/Relation`, `assignedTo`. Patient house and stay. Next action missing. | UI + **infra S** (next action) |
| Overview: basics, contacts, referrer, payer, summary | partial | One contact per lead; `billingPhone`; `Funders`; `source`. **No contacts entity; referrer = `source` only.** | UI for what exists. **infra S** for multiple contacts and referrer (❓ scope). |
| Activity & tasks: calls, notes, meetings, state changes, payments, transitions, each with time, actor and source; manual vs system | partial | AuditLog (`timestamp, action, fn, patientId, details, actor`) is technical, keyed on lead id. Payments `recordedBy/At`, `confirmedBy/At`. Discharge `dischargedBy`. No calls or notes log. | **infra S + E**: an append-only Activity sheet (Session B) plus a permission-filtered read |
| Meetings & services: intake meetings and outcomes, stays, outpatient periods with history | partial | Lead meeting columns (one meeting per lead); Patients stays; `personId` (returning patients); discharges. Outpatient periods: none. | UI for Dashboard data. **infra X** for Outpatient. |
| Account: charges, payments, balances, verifications, refunds, by service and period | partial | Payments cycles + receipts, debt aging, Credits, BillingOverrides (keyed on the mutable triple) | UI (reuse debt aging and billing). **P** (field scoping). |
| Documents: documents and requests | partial | `invoiceWanted` / `invoiceTo` on receipts. No document store. | **infra** (❓ scope; Hashavshevet evidence) |
| Every field Vered edits today stays within 2 clicks | — | Edit lead, patient and receipt modals | **UI only** (acceptance check) |

## §8 Identity and service continuity

| Feature | State | Maps to | Kind |
| --- | --- | --- | --- |
| Many leads and many service periods per client | partial | `Patients.personId` links returning stays. **Leads have no personId.** `restorePatient_` creates a new lead. | **infra S** (a person link sheet; never a Leads column, because of the concat hazard) |
| Separate person / contacts / payer / lead / stay | partial | Lead = row; stay = Patients row; payer = `Funders` + receipt `payer`; contacts = 3 columns on the lead | **infra S** (contacts, payer entities) — ❓ |
| No automatic merge by name or phone; stable ids; keep source ids | exists (as policy) | Therapists idempotency by phone is for *creation*, not merge. The duplicate-phone *warning* only. | Rule for B/C: **links are explicit and verified, never inferred** |
| Unified view keeps an authoritative source and owner per datum; a link is not edit permission | — | LINKED-APPS ownership rows | Rule. **P** for cross-app reads. |

## §9 Exit, account closure, continuation (three parallel processes)

| Feature | State | Maps to | Kind |
| --- | --- | --- | --- |
| Actual exit: did they leave, when, who approved | exists | `dischargePatient_`, `recordDischargeFromCoordinators_` (`dischargedBy`, `dischargeSource`), Patients `exitDate` | UI only |
| Family asks to end treatment → follow-up; exit relies on the authorised house person | missing | — (Managers `expectedDate` is closest) | **infra S** (a task) + ❓ who is "authorised" |
| Account closure: billing end, reports, verifications, balance, documents, refunds | partial | debt aging, refund forecast, Credits, billing-control queue | UI only (compose) + documents gap (§10) |
| The account stays open after exit | exists | debt aging includes released patients; «השלמת גורם מממן» includes released with debt | UI only |
| Refund decision separate from refund execution | exists | Credit `pending` (decision: `approvedBy`, `decidedDate`) → `paid` (`settleRefund`: `paidDate`, `method`) | UI only |
| Continuation: handoff opened | exists | AuditLog `outpatient_lead_sent` | UI only |
| …accepted at destination / contact made / meeting set / verified start | missing | — | **infra X** (an Outpatient read feed; draft Outpatient #114; a stable link id) |
| Tracking stays open until the result | partial | `outpatientMissingReportNow` (an editor report) | infra S/X |
| Manager-report task after the intake meeting, before admission | partial | `/meeting-report` + 14-day window. **No "missing report" task.** | UI only (computed) |

## §10 Billing and control

| Feature | State | Maps to | Kind |
| --- | --- | --- | --- |
| Reported vs verified | exists | Receipt `confirmStatus` reported → confirmed / partial / flagged | UI only |
| Document issued | missing | `invoiceWanted` is a request, not evidence (spec: "an invoice request is not proof") | **infra X/Σ** |
| Refund decided vs refund paid | exists | Credits `pending` → `paid` | UI only |
| The same payment record moves Vered ↔ Ortal with actor, time and history; no double entry | exists | One receipt row (`recordedBy/At`, `confirmedBy/At`, `flagNote`, `controlNote`). **The history is only last-writer plus AuditLog.** | UI only. A full history needs Activity (S). |
| Keep "unreported balance" apart from "verification difference"; no automatic extra demand | exists | debt projection vs `confirmedAmount` / partial (Ortal billing PRs) | UI only. Rule: keep it. |
| Discharged patients stay reachable for Vered | exists | Tab 6 (D2) | UI only |
| Outpatient info read-only, with source, time and an explicit "missing / partial" | missing | — | **infra X** |
| Hashavshevet stays the document source; a request ≠ issued | — | `docs/billing-document-evidence.md` | Rule + infra X |
| «בקרה» KPIs: leads untouched, overdue tasks, meetings without outcome, open transitions | partial | Leads (computable), meetings (computable), AuditLog (sends). "Overdue tasks" needs due dates. | UI only for computed ones; infra S for overdue |

---

## Summary: UI only vs infra

**UI only.** Can ship in Session C behind the flag, over today's data and actions:
- the shell, side menu and mobile drawer;
- the leads board restyle and the table view;
- the client drawer showing existing fields;
- Ortal's «היום שלי» (everything already exists in «בקרת גבייה»);
- Vered's computed lists:
  - meetings without an outcome
  - missing manager reports
  - billing follow-up
  - outpatient sent / failed
- the exit, account and refund views;
- keeping filters and scroll.

**Infra.** Separate PRs, never mixed with UI (spec §14):
1. **S**: an append-only Activity sheet (calls, notes, system events with actor and source). Session B.
2. **S**: next action, due date, owner vs assignee for non-billing work. A task / next-action
   record, not Leads columns. Decide its relation to #220's retained queue first.
3. **P**: server-side field and house scoping for CRM reads, search and exports, plus write gates
   by role. Prerequisite: `PROXY_SECRET_MODE=enforce`.
4. **E**: permission-filtered read endpoints for the CRM (search, card, timeline).
5. **S**: person / contacts / payer links (❓ scope).
6. **X**: Outpatient read feed (continuation steps, read-only panel) and a stable link id.
7. **X/Σ**: Hashavshevet issuance evidence for document tracking.

---

## Theme: dark today vs light in the spec (§3)

The current UI is **dark only**:
- tokens on `:root` (`style.css:1-56`): `--bg #0b1020`, `--surface #182142`, `--text #f1f5ff`, …
- ~118 hard-coded hex literals elsewhere
- `color-scheme: dark` on inputs
- `<meta theme-color="#0b1020">`
- `manifest.json` `theme_color` / `background_color` `#0b1020`
- `meeting-report.css` duplicates the palette

There is no `prefers-color-scheme` and no `data-theme`. Spec §3 asks for a light background,
white surfaces, dark text, and status colours with text labels.

### What would change in a global switch
- every `:root` token
- the 118 literals
- the body gradient
- the `color-scheme`
- the theme-color meta and the manifest colours
- `meeting-report.css`
- `--grp-*` billing colours, which must stay equal to `lib/report-colors.js`, which also colours
  the .xlsx exports

### What would break in a global switch
- **Tests (CI):**
  - `billing-tab-section-colors` (tokens = report-colors; WCAG AA against `--surface`)
  - `date-picker-icon` (hard-coded `#182142`; expects `color-scheme: dark`)
  - `spinner-glyph` (hard-coded surface)
  - token-regex checks in `monthly-revenue`, `patients-tab-ui`, `unadmitted-lead-warning`,
    `patient-missing-from-house`, `funder-grace`, `coverage-month-split`, `header-brand`, the two
    mobile tests and `pwa-foundation`

  58 test files read `style.css`.
- **Browser tests** (they run locally; CI does not install Playwright): `date-picker-icon-browser`,
  `spinner-glyph-browser`, `billing-tab-section-colors-browser`, `billing-control-tab-browser`
  (contrast assertions).
- **SW cache:** any `style.css` / `index.html` / `manifest.json` change needs a `CACHE_VERSION`
  bump, monotonic from the **live** version (v93 today). Four tests pin the exact version:
  - `patient-missing-from-house.test.js:302`
  - `ortal-billing-ui.test.js:261` and `:395`
  - `dashboard-perf-assets.test.js:394`

  The manifest colour change also changes the installed PWA chrome.
- **Print:** the only print rule hides search (`style.css:2833`). There is no print stylesheet, so
  a light theme mostly *helps* print. Nothing tests print today.

### Recommendation (for Session C; not decided here)
Scope the light theme to the CRM shell: a separate stylesheet or `body.crm` token overrides,
loaded only when the flag is on. The current dark UI then stays untouched when the flag is off,
and no existing colour test changes. Deciding a global switch belongs after the pilot. ❓
