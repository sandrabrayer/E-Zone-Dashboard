# Overdue-payment alerts (billing PR 3 — frontend only, no schema)

Who needs to pay, surfaced the moment their cycle arrives: a dashboard strip
"X מטופלים ממתינים לתשלום" and amber-highlighted overdue rows in the גבייה tab.

## The rule

A patient is **overdue** when **today ≥ the current cycle's due date** — their
most recent billing-day occurrence, computed with the SAME entry-day anchor
the billing model already uses (`dayOfMonth(p.date)`), with the SAME
short-month clamp (entry day 29/30/31 in a shorter month → that month's last
day) — **AND no payment is recorded for that cycle**. A recorded **paid or
partial** payment clears the alert immediately (the same coverage rule
`patientsNeedingRenewal` uses). **Released patients are excluded**
(`activePatients()`); a brand-new patient whose first cycle hasn't started yet
is never flagged.

## What changed (`app.js`, `index.html`, `style.css`)

- **`lastBillingDayOnOrBefore(entryISO, fromISO)`** (new, pure) — the mirror
  image of the existing `nextBillingDayOnOrAfter`: the most recent occurrence
  on or before a date, same anchor, same clamp, year-rollover safe.
- **`overduePatients(fromISO)`** (new, pure over state) — applies the rule
  above; routes through the override-aware `paymentForPatientOnDate`, so an
  overridden month's coverage check uses the same record everything else
  sees. Sorted oldest-due first.
- **Dashboard strip** (`#overdue-alert`, visible on load via
  `renderDashboard → renderOverdueAlert`): count pill (reuses the
  renewal-alert pill style) + "X מטופלים ממתינים לתשלום" + a למעבר לגבייה cue.
  Hidden at zero. **Clicking navigates to the גבייה tab** by invoking the
  billing tab button's own switch handler.
- **גבייה tab highlight**: an unpaid current-list row whose due date has
  arrived gets `.billing-row.overdue` — the SAME `var(--warning)` amber
  leading-edge treatment carry-forward rows already use, plus a faint tint.
  **No new color system.** Carry rows keep their existing styling.
- Hebrew strings; RTL-safe (flex + gap, leading-edge `border-right`,
  `margin-inline-start` for the cue).

## Tests — `test/overdue-payment-alerts.test.js` (10 new)

- Anchor math: this-month vs previous-month occurrence, on-the-day boundary,
  **short-month clamping for entry days 31/30/29** (→ Feb 28) and 31 → Apr 30,
  year rollover (Jan → Dec).
- Rule: before the renewal day (previous cycle paid) → not overdue; **on the
  renewal day → overdue**; **paid AND partial clear**; short-month cycle due
  on the clamped date; **released excluded**; not-yet-started first cycle
  excluded; oldest-due-first ordering.
- Strip: Hebrew count text rendered; hidden at zero.
- Row highlight: unpaid past-due → `.overdue`; future-due, paid, and carry
  rows unhighlighted.

Full suite: `npm test` — **450 pass, 0 fail** (440 + 10).

## Deploy

Frontend only — no Code.gs, no server, no schema change. Railway redeploys on
merge.

## Live verification (after merge)

A patient past their renewal day with no recorded payment appears in the
dashboard strip ("X מטופלים ממתינים לתשלום"; clicking jumps to גבייה) and
their row in the גבייה tab is amber-highlighted. Recording the payment (or a
partial one) clears both immediately.
