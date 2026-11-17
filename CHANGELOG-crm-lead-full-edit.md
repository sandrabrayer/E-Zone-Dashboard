# CRM — «עריכת פרטי הליד»: the whole lead is edited in its card

Vered, 17/11/2026: in the CRM lead card, «עריכה מלאה בדשבורד» opened the previous
version of the app (`/?view=classic`). A lead must be fully editable in the new
version. CRM only — **no Code.gs change, no new column, no new action.**

## What is new

The lead card («סקירה») has **«עריכת פרטי הליד»** — a button under the details and a
section in the card — instead of the link to the classic page. One form, the whole lead:

| Group | Fields |
| --- | --- |
| פרטי המטופל | שם מלא, טלפון |
| פרטי הפונה | שם, טלפון, קשר למטופל (+ «קשר אחר»), טלפון לגבייה ועדכונים (מטופל / פונה / אחר) |
| פרטים נוספים | בית מועדף, מקור הליד, אחראי, נוצר, תאריך כניסה (only on a lead that has one), הערות |

That is every field of the classic «עריכת ליד» modal, plus «מקור הליד» and «אחראי».
Stage, «תיאום פגישה» and «דיווח תוצאת פגישה» keep their own buttons in the same card
(they carry their own rules — a dated meeting moves a new lead to «ביקור נקבע»).
«הערה ואחראי» stays as the quick form.

## Rules

- **Only what changed is sent.** The patch holds the changed fields only and goes
  through the existing one-lead write (`writeLead` → `saveAll` with one lead and
  `prove.leads`). The answer must prove the lead, or the edit is rolled back.
- **A field is checked only when it changed** — the same rule as the classic modal
  and Code.gs `leadRequiredViolations_`, so an old incomplete lead still saves its
  other fields. A changed name needs two words; a changed phone must be an Israeli
  10-digit number and is stored normalised; a changed source or house cannot be
  emptied (a house may be empty when «נפגש/ת עם» is «אמבולטורי»); «נוצר» cannot be in
  the future.
- **טלפון לגבייה ועדכונים** follows the classic selector: «מטופל» / «פונה» track that
  phone when it changes; a blank stored value already means «מטופל» and stays blank.
- **A phone another lead already has** asks before saving, as on a new lead.
- **A patient's own lead** («פנייה ישירה»): the source is a system key and is not
  editable; name / phone are exempt as on the server.
- **Nothing typed is lost:** a refused save leaves the form open with what was typed;
  ✕, a click outside and Esc ask before closing a card with unsaved lead edits.

## Not changed

- The patient card still has «עריכה מלאה בדשבורד» (its own actions are separate work).
- Ortal's view (the verifier) gets no lead-edit form.
- Roles are enforced where they already are: the server and Code.gs decide who may
  save a lead; this form adds no permission.

## Security

Every value is escaped on render (the note is text, never markup); the form sends no
key the lead row did not already have; input lengths are capped; no secret, no new
endpoint, no new external link. `npm audit`: 0 high / critical.

## Tests

- `test/crm-lead-full-edit.test.js` (new, 11): the starting values, the changed-only
  patch, each validation rule, the billing-phone selector, dates, the system-source
  lead, the save body, the card wiring, no server change.
- `test/crm-shell-browser.test.js`: one scenario on the real page — no classic link,
  nothing-changed, bad fields, the full save, a refused save, the unsaved-edits
  question, the duplicate phone, Dana on a 390 px phone (no horizontal scroll).

## Files

`public/crm/crm.js`, `public/crm/crm.css`, `public/sw.js` (v143 → v144),
`test/crm-lead-full-edit.test.js` (new), `test/crm-shell-browser.test.js`,
`test/crm-pwa.test.js`, `test/dashboard-perf-assets.test.js`,
`EZONE-ECOSYSTEM-STATUS.md`.

## Deploy

Railway only (auto-deploy of the deployed branch). No Apps Script deploy.
