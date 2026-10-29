# CHANGELOG — CRM Stage 3: «רשומות שדורשות בירור» + progressive boot

Date: 2026-10-29 · Branch `claude/s3-triage` → base `claude/build-ezone-dashboard-QOg5s`
Spec: «הוראות האיפיון והעיצוב» §12 (triage), §14 (reliability), §16 (acceptance: triage keeps history).
UI only (`public/crm/crm.js`, `crm.css`, SW v98 → v99). No Code.gs, no server change.

## The triage round (spec §12)

- Reached from **«פניות» → «רשומות שדורשות בירור (N)»** and from the «פניות חדשות ללא מגע» domain on
  «היום שלי» («סבב בירור — אחת אחרי השנייה»). Not in the menu.
- **The queue is computed** from the data on every render — never a hard-coded 75: open leads
  (stage new, or a visit without a date) with **no documented contact** (`contactIndex`) and **no
  open task**, oldest first (the family waited longest). A record leaves the queue only because a
  decision left a record: a contact event, a task, a stage change, a closed lead.
- **One record at a time**: name, house, stage, created + age (information, not lateness),
  owner, source, phone + contact person, the lead's note, the reason it is here, «הבאה: …», a
  progress counter «k / N הוחלט» (session), «דלג» moves on (nothing is written). **No bulk defer.**
- **Six options, one click each, each with a visible result**:
  1. **שיחה עכשיו** → the contact panel (Stage 1c); the saved contact is the decision.
  2. **לחזור בתאריך** → a `call` task with date (+ time, assignee, why) — `createTask`.
  3. **רשימת המתנה** → house, assignee, **reason and check date required** → ONE lead `saveAll`
     (stage `waitlist`, house, owner, the dated reason **appended** to the note — never overwritten)
     + a `review` task «לבדוק מקום פנוי — <בית>» on the check date (it shows in «היום שלי» on its day).
  4. **עדכון לפי מידע מאומת** → the card (edit forms).
  5. **סגירה — לא רלוונטי** → reason required → classic `moveLeadIrrelevant` (restorable from
     «לידים סגורים»).
  6. **לסמן לבדיקה נוספת** → a `review` task (what to check, until when, who).
- Client validation first; a refusal keeps the form; the counter advances only after the server
  confirmed; every write carries the actor (server-side).

## Progressive boot (the slowness Sandra saw after Stage 2)

`/api/me` and `getData` are requested **at once** (the classic page's pattern), the page renders
as soon as `getData` arrives, and `getTasks` / `contactIndex` / `debtAging` (finance) fill in as
they land — a card says «טוען…» meanwhile and «המידע אינו זמין» only if its source failed
(`undefined` = loading, `null` = failed). Before this PR the screen waited for all four reads.

## Files

- `public/crm/crm.js`: core `TRIAGE_OPTIONS`, `triageQueue`, `waitlistErrors`, `waitlistPatch`,
  `laterErrors`; UI `renderTriage`, `triageTask`, `triageWaitlist`, `triageDecided`, handlers;
  `load()` rewritten; area `triage` (in `areasFor` for every non-controller view, never in
  `NAV_GROUPS`).
- `public/crm/crm.css`, `public/sw.js` (v99), `DEPLOY.md` (the 200-versions cap + Railway's
  «Wait for CI» trap, documented).
- Tests: `test/crm-triage.test.js` (4), `test/crm-shell-browser.test.js` (+1 Chromium scenario),
  guards (`crm-shell-ui`, `ops-role-dana`, `crm-pwa`, `dashboard-perf-assets`).

## Security

No new action; the writes are the Stage 1a / classic ones with their server gates (Dana: no money
kind is offered; the controller view has no triage). All text through `esc()`. `npm audit`: 0
high / critical.

## Deploy

Nothing to set. No Code.gs change → no Apps Script run. SW v99.
