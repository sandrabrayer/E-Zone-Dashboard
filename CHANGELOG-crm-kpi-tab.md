# CRM «KPI» area, «תפוסה היום», «בקרת עבודה», «חריגים לבדיקה», required fields (2026-11-05)

Sandra, 05/11/2026: bring the data slices back, add occupancy %, a KPI tab with break-even,
flag impossible billing states (one person in two houses at once), never save with a field
missing, and make «בקרה» understandable.

## What changed (CRM only — `public/crm/*`; no Code.gs, no server, no new endpoint)

### New area «KPI» (menu group «דוחות והגדרות»)
Visible to finance (Vered, Sandra) and the operational view (Dana); not to the controller (Ortal).
Period presets: החודש / החודש הקודם / 3 חודשים אחרונים (default) / מתחילת השנה.
1. **תפוסה היום** — overall % (in house ÷ capacity of open houses) + per-house table.
2. **המרת לידים למטופלים** — leads OPENED in the period → נכנסו לאשפוז / עברו לאמבולטורי /
   עדיין פתוחים / נסגרו — לא רלוונטי / נסגרו — אחר, with % and a per-house table.
   - inpatient = a Patients or discharge row links to the lead (`fromLead`), or stage admitted;
   - outpatient = handed to Outpatient (AuditLog `outpatientSentLeadIds`), closed
     «משוחרר לטיפול חוץ», or an «אמבולטורי» meeting with outcome «נכנסים לטיפול»;
   - direct adds (`direct_approach`) are counted apart, phone records (`direct_admin`) never.
3. **סגירה לאחר פגישה — לפי מנהל/ת** — intake meetings HELD in the period (visit day passed,
   or a manager report) grouped by «נפגש/ת עם»: meetings, entered (+ % close), closed without
   entering (+ %), still open, total row.
4. **משך שהייה והמשך טיפול** — the classic «חתכי מטופלים» rules (`lib/patient-retention.js`,
   now loaded by `crm.html`): ≤30 / 31–60 / 61+ days, still in treatment, continuity.
5. **נקודת איזון לבית** (finance only) — the classic tab's model mirrored exactly
   (`BREAKEVEN_DEFAULTS`, ex-VAT price and revenue, break-even point, P/L, margin, network
   after HQ). The expenses are the SAME browser-stored figures as the classic tab
   (`localStorage['ezone-breakeven-v1']`, same origin), else the financial-analysis defaults;
   an inline form edits them (validated: non-negative, a counted house needs expenses).

### «תפוסה»
The «בטיפול היום» card is now **«תפוסה היום»**: the overall % with «N מתוך M מיטות».

### «בקרה» → «בקרת עבודה», moved up
Now right under «היום שלי» (was last), with a one-line explanation: what is stuck in the daily
work (unread reports, untouched records, late tasks, meetings without outcome). Metrics live in KPI.

### «חריגים לבדיקה» at the top of «גבייה»
Read-only exceptions; each row opens the stays it names (drawer → «חשבון»):
- **stay_overlap** — two stays of the same person (personId chain, or the same full name —
  flagged "לוודא שזה אותו אדם") whose periods overlap. A move/return on the exit day is not an
  overlap. The «טל לוי» case (רמות 18/05–31/08 + אשר 17/05–13/09) is listed.
- **debt_after_exit** — an open debt cycle starting after the stay's exit day.
- **exit_before_entry**, **released_no_exit**, **zero_pay_in_house** (in house, price 0).
The exit day falls back to the discharge audit row when the Patients row has none.

### Nothing saves with a field missing
- New lead: **source** and **house** required (house may be blank only when «נפגש/ת עם» =
  אמבולטורי); a contact name needs its relation; «אחר» needs its text; billing via the contact
  or another phone needs a valid phone.
- Close lead: status + **reason** required (`closeLeadErrors`).
- Direct add: **patient phone** required.
- Discharge: **discharge date** required (no silent default to today).

### Still in the classic dashboard (`CLASSIC_ONLY`, for Sandra's decision)
Manual credits, extended receipt edit, בקרת גבייה verification, override delete, editing a
released stay's dates (needed to fix an overlap), patient delete, returning-patient match at
intake, «בית לא מזוהה» fix, Excel exports, monthly revenue + growth graph.

## Security
Read-only views over data the session already receives; every value is escaped (`esc`), numbers
wrapped in `<bdi dir="ltr">`. Break-even renders only for `me.finance` (Dana's getData has no
prices anyway). The only write is the browser-local expense figures (same key as the classic tab).
No secrets, no logs, no new routes.

## Files
`public/crm/crm.js`, `public/crm/crm.css`, `public/crm/crm.html` (loads `patient-retention.js`),
`public/sw.js` (v114 → v115), tests: new `test/crm-kpi-tab.test.js` (17, incl. break-even parity
with app.js), `test/crm-shell-browser.test.js` (+1 browser test), updated pins in
`crm-shell-ui`, `crm-my-day`, `ops-role-dana`, `crm-pwa`, `dashboard-perf-assets`.
