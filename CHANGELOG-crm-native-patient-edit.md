# CRM — the patient card is edited in the CRM; no link to the classic page

Sandra, 19/11/2026: the patient card's «עריכה מלאה בדשבורד» still opened the previous
version of the app. A patient must be editable in the new version. CRM only — **no
Code.gs change, no new column, no new action.**

## What is new

- The in-house patient «עריכה» form gains a **name** field (alongside the existing
  entry date, monthly amount, advance, status and notes).
- **Released** patients, which had no edit form, now get **«עריכת פרטי המטופל/ת»**
  (name + notes) above the «העברה לאמבולטורי» transfer.
- The patient card's **«עריכה מלאה בדשבורד» link is gone**. Editing lives in the card.
- **טלפון ופרטי קשר** live on the patient's linked lead; the card shows **«עריכת טלפון
  ופרטי קשר»** which opens that lead's own native edit («עריכת פרטי הליד», built
  earlier) — shown only when the lead is on the board and the user may edit it.

## Rules

- A field is validated and saved **only when the form carries it** — so a released
  name/notes edit never touches stay dates, money or status (those stay bound to the
  discharge row in the classic flow). The name cannot be emptied.
- The patient row is written through the same proven house save as before
  (`houseSaveBody` + `prove.patients`); only the changed fields differ.
- The name is trimmed and space-collapsed.

## Still in the classic page (reachable via the sidebar «חזרה לדשבורד הרגיל»)

These are not yet in the CRM, so the escape hatch and their own inline links stay:
a released patient's **stay-date edit** (overlap fixing) and **delete**; **Ortal's
billing-control** verification (partial / not-received / duplicate); the **«בית לא
מזוהה»** fix. The patient-card and finance-note classic links were removed.

## Security

Every value escaped on render; the save sends no key the patient row did not have;
input lengths capped; no new endpoint, no new external link. `npm audit`: 0 high /
critical.

## Tests

- `test/crm-native-patient-edit.test.js` (new, 5): name-required-when-present, the
  changed-only patient row, the removed/kept classic links, the linked-lead button
  guard.
- `test/crm-shell-browser.test.js`: one scenario — in-house name edit + empty-name
  refusal, the linked-lead button opening the lead edit, a released name/notes edit
  with stay dates untouched, no classic link, a 390 px check.
- `test/crm-lead-full-edit.test.js`: the overview assertion updated for the removed
  patient link.

## Files

`public/crm/crm.js`, `public/crm/crm.html` (unchanged link kept), `public/sw.js`
(v148 → v149), `test/crm-native-patient-edit.test.js` (new),
`test/crm-shell-browser.test.js`, `test/crm-lead-full-edit.test.js`,
`test/crm-pwa.test.js`, `test/dashboard-perf-assets.test.js`,
`EZONE-ECOSYSTEM-STATUS.md`.

## Deploy

Railway only (auto-deploy of the deployed branch). No Apps Script deploy.
