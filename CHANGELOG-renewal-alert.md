# Renewal alert + renew action (PR 1 of 3)

Vered needs a heads-up before each active patient's monthly renewal comes due,
and a one-click way to act on it. This PR adds a dashboard (דשבורד) alert listing
patients whose next billing day falls within the next 7 days and whose upcoming
cycle isn't already paid, with per-patient **RENEW** and **DISCHARGE** actions.

Frontend-only. No `Code.gs` change, no Apps Script redeploy.

## What it does

- **Renewal alert card** on the dashboard, under the stat cards. Shows a count
  and one row per patient with name, house, and renewal date. Hidden entirely
  when nobody is due. Hebrew RTL, styled as a `.card` with an amber accent bar
  to read as an alert (distinct from the blue/purple stat cards).
- **RENEW** — writes next month's payment row for that patient on its renewal
  due date and marks it paid. Because the renewal date is derived from the
  billing schedule, recording the payment marks the cycle covered, so the
  patient drops off the alert and the next occurrence advances a month
  automatically. Optimistic UI with rollback on failure.
- **DISCHARGE** — opens the existing שחרור modal unchanged (`dischargePatient`).
  PR 2 will enhance that modal; this PR does not touch it.

## Design decisions (locked with the requester)

- **Renewal model = the existing billing model.** Renewal date is the patient's
  next entry-day-of-month billing occurrence, computed from the same
  `dayOfMonth(p.date)` anchor the גבייה tab (`patientsDueOn`) already uses — one
  source of truth. We deliberately did **not** introduce a "last payment + 1
  month" derivation. (Phase 1 investigation confirmed no such logic existed; the
  billing tab has always been day-of-month-anchored to the entry date.)
- **Zero payment history → fall back to the entry date.** Because the schedule
  is anchored on the entry day-of-month, a brand-new patient with no payments
  still has a renewal date (their entry day in the current/next month) and still
  appears in the alert.
- **Cycle coverage counts only paid or partial.** A `paid`/`partial` payment for
  the upcoming due date suppresses the alert; an `unpaid` placeholder does not.
- **Month-length clamping.** An entry day past the length of a short month (e.g.
  31) clamps to that month's last day (Feb 28), so the renewal date is always a
  real calendar date.

## Window semantics

A patient is alerted when `today <= renewalDate` **and**
`renewalDate - today <= 7` days, i.e. the inclusive window `[today, today+7]`.
Exactly 7 days and today (0 days) are in; 8 days is out.

## Reused, not reinvented

- `dayOfMonth`, `isoDate`, `todayISO`, `paymentForPatientOnDate`, `patientKey`,
  `paymentId`, `activePatients` — existing billing helpers.
- `savePayment` — the existing payment write path (→ `apiPost('savePayment')` →
  Apps Script `upsertPayment_`). RENEW does not add a new write path.
- `dischargePatient` / the שחרור modal — unchanged.
- `escapeHtml` — all patient-derived text rendered into the DOM is escaped.

## Files

- `public/app.js`
  - New billing helpers: `parseLocalISO`, `daysBetween`,
    `nextBillingDayOnOrAfter`, `renewalDateISO`, `patientsNeedingRenewal`.
  - New dashboard functions: `renderRenewalAlert`, `renewPatient`.
  - `renderDashboard` now calls `renderRenewalAlert`.
- `public/index.html` — renewal alert container in the dashboard section.
- `public/style.css` — `.renewal-alert` / `.renewal-row` styling.
- `test/renewal-alert.test.js` — vm-sandbox suite (16 tests): renewal-date
  computation (same/next month, today, short-month clamp, year rollover), the
  7-day window boundary (7 / 8 / today / past), the zero-history entry-date
  fallback, and the paid/partial-vs-unpaid cycle-coverage check.

## Commits

- _(pending)_ feat(dashboard): renewal alert with renew + discharge actions
