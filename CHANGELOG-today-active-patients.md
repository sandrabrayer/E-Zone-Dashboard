# CHANGELOG — «מטופלים פעילים» on «היום שלי»

Date: 2026-11-11 · Branch `claude/today-active-patients` → base `claude/build-ezone-dashboard-QOg5s`
Sandra: «תוסיף ליום שלי מספר מטופלים פעילים.»

## What everyone sees (CRM «היום שלי»)
- A new card at the end of the summary strip: **«מטופלים פעילים»** — the number of patients
  in the houses now, with «מתוך N מיטות» under it.
- Same number as «תפוסה»: everyone who is not released. A patient whose house is not
  recognised is counted and the card says «K בבית לא מזוהה».
- The day's house filter narrows it to that house.
- Vered / Sandra / Dana: the card opens «תפוסה». Ortal: a plain card (she has no «תפוסה» area).

## Data / security
- Read-only, no new request: computed from the `getData` answer already loaded (Ortal's
  projected answer holds patients too). No money on the card — safe for Dana.
- No server, Code.gs or Railway change. `npm audit`: 0 high / critical.

## Files
- `public/crm/crm.js`: `activePatientsCard` (pure, on `occupancy`), `activePatientsHtml`,
  both day strips.
- `public/sw.js`: v126 → **v127**.
- Tests: `test/today-active-patients.test.js` (new, 4); `test/crm-shell-browser.test.js`
  (Vered, Dana and Ortal strips), SW guards.
