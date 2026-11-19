# E-ZONE One — Executive & Management Control Layer v0.1

**Status:** DESIGN PROPOSAL awaiting Sandra's business decision; not deployed or merged.  
**Date:** 2026-10-31.  
**Parent:** [ARCH-01 #331](https://github.com/sandrabrayer/E-Zone-Dashboard/issues/331); [architecture PR #332](https://github.com/sandrabrayer/E-Zone-Dashboard/pull/332).  
**Relevant existing business decisions:** Dashboard docs/crm/SPEC.md D1–D17, especially D1 (Ron stays in ניהול בית; NO Dashboard login), D3/D12/D17 (reuse Managers credentials during integration), D4/D8/D14 (Ortal is a verifier, not executive), D5/D16 (Dana no money), D7/D9 (Sandra exceptional financial approval).

## 1. Product principle — preserve what's valuable

The two operational Dashboard opening screens remain available with their existing KPIs. Sandra likes the headline **monthly revenue** on both residential Dashboard and Outpatient, and should keep that convenience; **never remove or relocate the original KPI as a prerequisite for E-ZONE One**.

A *new executive overview* is an additional **read-only projection over verified source data**. It can present residential + ambulatory results side-by-side, as sourced values with labels/as-of timestamps, and link directly to each detailed operational page. It must NOT create another authoritative financial ledger or another manually editable revenue number.

**Screenshot evidence (user supplied 2026-10-31; display only, NOT verified against ledgers):**
- Residential: 36 active, ₪1,036,805 monthly revenue shown, network occupancy 49% (36/73 beds).
- Outpatient: 25 active, ₪148,250 monthly income shown, zero open leads on screen.
- Do not combine these two money KPIs into a group total without reconciling periods, actual-vs-forecast/accrual, VAT basis, sources, duplicate cross-service client counting, discounts/refunds and recognition rules.
- The 73-bed live denominator requires a documented definition distinguishing **active licensed/operational capacity** from total physical or prospective capacity; 36/73 is numerically ~49.3%. Absence of an explicit denominator definition is a KPI specification issue, NOT proof of a system defect.

## 2. Separate layers of the user experience

1. **Executive overview:** role-specific, read-only KPI + exceptions + cross-module management tasks; accessible through E-ZONE One. It has links back to Residential and Outpatient dashboards. Not an additional ledger/task data writer.
2. **Operational dashboards:** existing residential and Outpatient "Today"/revenue/capacity/collections/therapy details are preserved and improved. Vered/Dana/Ortal use role-scoped interfaces, not a universal executive view.
3. **Professional modules:** management of homes, therapists, workforce, training, logistics, kitchen and Helpdesk; source-owned writes; app-centric views until migration.
4. **Management assurance plane:** owner, source, timestamp, freshness, thresholds, audit, evidence of completed action, failure states, backup/restore verification and change requests. An executive card can never claim that a missing source is zero.

A **single personal sign-in/SSO is a target design, not an implemented fact**. Until one is proven, the entrance may link to the existing separately authenticated apps. Do not imply that an URL card grants a new permission.

## 3. Proposed views and exact existing access boundaries

### Sandra — group executive cockpit

- Network scope and full financial read, as authorized: occupancy by home, active residential clients, outpatient clients/plans, new leads and conversion/first-response times, household/treatment revenue by service, collections and aged receivables, expected vs received cash, expected discharges and care continuity.
- Operations and people: house staffing coverage, exceptions, service delivery/therapy attendance and capacity (no extra clinical notes), staffing costs, budget variance, pending procurement/maintenance, Kitchen and training compliance.
- **Action/approval inbox:** exceptional discount/write-off/refund decisions, unresolved payment mismatches when escalation requires Sandra, house-level operations escalations, repeated system failures and overdue management commitments. Draft proposals only until exact authority and data-source checks.
- At a glance: overall numbers and exceptions first; one click into the existing operational screen with the same status and no duplicate data entry.
- Financial control prototype is demo only: never present demo cash/bank/P&L figures as actual company results.

### Ron — house/network operations cockpit, subject to existing D1

- Existing authorization **D1: Ron is NOT a Dashboard CRM user.** He currently has house-network admin access through ezone-managers. Do not silently create Dashboard access for him in the architecture.
- Provide a future **house operations management view** sourced from Managers/ניהול בית: current/settled occupancy, arrivals, expected exits, house staffing coverage, shifts and gaps, committees/reporting gaps, incidents, maintenance, staff conversations, follow-up deadlines and existing Manager bonus/cost screens where already permitted. Preserve server-level house/role rules.
- **Explicit decision needed:** whether Ron may see executive group revenue, individual patient prices, receivables, salaries or margin by house. Default **NO ADDITIONAL FINANCIAL PERMISSION**; show already-granted Managers data only. An aggregate operations card does not change his underlying right to detailed patient data.
- If Sandra later approves Ron's access to selected aggregate financial KPIs, implement a *new narrowly scoped executive role* with minimum required field projection, not generic Dashboard superuser access. Test that clickthrough cannot bypass it.

### Other roles remain distinct

- Vered: complete client-service responsibility and current authorized collections; tasks can be delegated to Dana without removing Vered's oversight.
- Dana: operational all-house and outpatient view; financial data excluded at the server/API/export level.
- Ortal: financial verification and accounting-document evidence, NOT "management". Separate payment reported/verified/bank matched/issued-invoice states. No clinical notes.
- Home managers/coordinators: only own-house operations according to verified identity; no global finance or broad cross-home clinical data without authorization.
- Workforce and operations staff: only own HR/training/logistics/kitchen tasks with original owner.
- Helpdesk: technical monitoring/incident data, not a secret or patient-record proxy.

## 4. The managerial control contract

Every management KPI/card must have:

| Attribute | Example/Rule |
|---|---|
| KPI identity | e.g. \`residential.revenue_monthly\`; never ambiguous "income" |
| Exact source owner | Dashboard billing calculation OR Outpatient source, not a third hand-entered total |
| Definition | Actual collected vs booked vs recognized vs forecast; net/gross VAT; included refunds |
| Business period | YYYY-MM and/or \`asOf\` timestamp in Israel local time |
| Population | operating houses vs authorized vs planned houses; active treatment episodes vs unique people |
| Responsible owner | Vered, Ortal, Ron or Sandra as decided; action != accountability |
| Freshness | last successful fetch + stale status and last source version |
| Reliability | \`available/partial/stale/unavailable\` + reason; missing does not turn into 0 |
| Access | stable signed identity, function/house and field-level scope |
| Drilldown | source module deep link with same filters where feasible, never widen permissions |
| Audit and action | reference ID, immutable operation ID, next task, owner and evidence for closing |

Do not solve this with more decorative charts. Management functionality is the ability to **identify a variance, assign responsibility, follow the remedy and verify completion**.

### Key dashboard areas

- Executive home: occupancy and revenue side by side (not automatically aggregated), collection risk, pending admissions, demand/pipeline and open managerial exceptions.
- Homes portfolio: active capacity vs planned/licensed capacity, average occupancy, weekly arrivals/exits, staffing vs requirements, exceptions and budget/house margin where permitted.
- Outpatient portfolio: referrals, first contact SLA, lead → intro → plan → active, actual sessions delivered/no-shows, utilization/capacity, renewals, collections and source-backed revenue.
- Workforce: vacancies/shift understaffing, overtime & labor cost (authorized only), employees leaving, training completion/overdue — no personal salary details in broad summaries.
- Procurement, logistics, kitchen: maintenance aging, purchase approval bottlenecks, critical stock/food shopping, actual budget use and outliers; no duplicate purchase/order ledger.
- Finance and control: receivables, collections, credits/payables, payroll forecast, actual vs budget, cash forecasts when backed by external source evidence.
- Incident and reliability: health by app and by data service, errors/delayed saves, stale source, backup/restore status, pending bugs/owner — Helpdesk remains independently deployable.

## 5. Required detailed per-app feature audit

For EACH of the 10 domain apps + Finance Control demo record:
1. Real business purpose, users and current adoption \`used/not-yet-used/unknown\` — **user confirms adoption, not GitHub**.
2. Production baseline (repo, actual deployed service/commit), draft-only additions, existing screens and each key action.
3. Required business journeys (who/what/when) and managerial control points: events, bottlenecks, thresholds, reports, manager decisions, alerts and follow-ups.
4. Evidence of source integrity (save/readback, idempotent retry, backup coverage/restore, security and house/role scope).
5. Feature maturity: \`exists + tested\`, \`exists unverified\`, \`draft\`, \`missing\`, \`proposed\`, \`obsolete\`.
6. A specific **reuse vs refactor vs consolidate vs retire** recommendation. Reuse live calculations and PR work unless independently shown inadequate.
7. Per-role acceptance test for **staff user**, **team manager**, **Sandra/Ron where authorized** and disconnected/stale-data scenario.
8. Priority \`P0 security/reliability\`, \`P1 essential controls\`, \`P2 executive optimization\` and implementation owner/app, with no guessed costs or dates.

**No app is "done" merely because it runs and tests pass; the capability audit verifies if it meets the intended business purpose.**

## 6. Release boundary

Keep Dashboard and Outpatient headline revenues on their current landing pages. Build executive overview first as a read-only prototype using source-backed aggregates. Reconcile as-of/period/VAT/forecast before any company-wide sum or margin.

No generic Ron executive/finance access without business authorization that explicitly amends D1. No authentication bypass or new default all-houses exposure. No new task store, financial ledger or uncontrolled API cross-write. No merge/deploy/source changes from this design. Production readiness requires evidence from current releases, technical review, and Sandra's separate approval.

## 7. Questions for owner

**Q1 (material):** Sandra, should Ron's future view include **operations-only** across houses (matching existing D1), or selected aggregate revenue/profitability measures? If any financial data is approved, which exact metrics and scope, and whether he may drill down to patients? Until decided, preserve D1.

**Q2:** Should Sandra's default opening page be **executive overview** with one-click Residential/Outpatient dashboards, or keep today's Residential default with a prominent "Group Management" link? Either preserves both current income cards.

**Q3:** Which existing apps are used by real staff today vs not yet adopted? This changes migration cost and how aggressively their interfaces may be consolidated. The app inventory is not evidence of adoption.

**Q4:** How should a threshold trigger action (e.g. low occupancy, overdue funds, missing report) be assigned to Ron/Vered/Ortal/Sandra without creating two tasks in two source apps?

**Q5:** House operational capacity definition: what homes and bed count are in the current 73 denominator? Distinguish active from planned/closed-but-licensed capacity. Do not silently redefine historical occupancy.
