# «ביקור נקבע» without a date — never invisible again (classic + CRM)

October 28, 2026. **Railway only** (`public/`). Code.gs not touched — no
Apps Script deploy, no column, sheet, Script Property or env var. SW
`CACHE_VERSION` v95 → **v96**, stacked on PR #309 (v95); live `/sw.js` read
v93 on 28/10/2026 with v94 on the deploy branch; monotonic, v17 stays burned.

## The report (Sandra, 28/10/2026)

A meeting אורן (ramot) scheduled and held today with the lead אורנה does not
appear in the managers' app feed, nor on the Dashboard's «לוח פגישות», nor in
the CRM «יומן».

## Root cause — evidence from the live sheet (read-only)

The lead row `אורנה פרלמן` (ramot, created 23/10, stage **«ביקור נקבע»**,
«נפגש עם» **אורן**) has **`visitDate` = '' and `visitTime` = ''**. Every
meeting surface keys on `visitDate`:

- Dashboard `meetingsForWeek` — a lead with no `visitDate` is in no week;
- CRM `calendarRows` — same filter;
- managers' feed — Code.gs `computeIntakeMeetingsByHouse_` and
  `expectedAdmissions` read the same date; the ezone-managers app only
  displays what these answer. **It is not at fault**, and nothing in it or in
  Code.gs changes here.

How a dateless «ביקור נקבע» lead comes to exist: the «שלב הבא» button
(classic card) and the CRM kanban move a lead to «ביקור נקבע» without asking
for a date, and `autosaveMeetingWithDefaults` then fills «נפגש עם» from the
house default — so the card *looks* scheduled while being on no board.

## What changed

### Classic (`public/app.js`, `public/style.css`)

- **`undatedVisitLeads(leads)`** (pure): stage `visit`, no valid `visitDate`
  (leads with a damaged date keep their own banner).
- **A strip on «לוח פגישות»**, above the week (`undatedVisitsBannerHTML`,
  next to the damaged-dates banner): «N לידים ב«ביקור נקבע» ללא תאריך פגישה —
  לא מופיעים בלוח ולא אצל המנהלים», one chip per lead (name · house · manager).
  In edit mode a chip opens the existing meeting modal (`openMeetingEditModal`),
  date field first; in view mode the chips are plain text.
- **`moveLead` → «ביקור נקבע» with no date**: once the stage move is saved,
  the meeting modal opens on the spot with a reason line («הליד עבר ל«ביקור
  נקבע» — בלי תאריך הפגישה לא תופיע בלוח ולא אצל המנהל/ת») and the date field
  focused. A refused / failed move rolls back as before and asks nothing.
- `openMeetingEditModal(m, { reason })` — optional reason line; returns
  quietly when the page has no modal host. `meetingStubForLead(lead)` builds
  the modal's input from a bare lead.

### CRM (`public/crm/crm.js`)

- **`undatedVisits(leads)`** (pure, exported): the same leads, oldest first,
  with house label and manager.
- **«יומן»** shows them above the day / week as «N לידים ב«ביקור נקבע» ללא
  תאריך פגישה — לא ביומן ולא אצל המנהלים»; a row or its «קביעת תאריך» button
  opens the lead drawer with «תיאום פגישה» expanded and the date focused
  (`focusMeetingForm`).
- **Kanban move to «ביקור נקבע»** without a date: after the one-lead `saveAll`
  succeeds, the drawer opens the same way and the toast says «השלב נשמר —
  עכשיו תאריך הפגישה, אחרת היא לא תופיע ביומן ולא אצל המנהל/ת».
- «היום שלי» already listed such leads as «לתאם פגישה»; unchanged.

## The live row

Code does not write data. אורנה's `visitDate` is set to 28/10/2026 through
the Dashboard UI after the merge (Sandra's statement that the meeting was
today), and both surfaces are then checked.

## Tests

- `test/undated-visit-leads.test.js` (new, 9): the two reproductions (board
  week buckets, CRM calendar range) first; the pure helpers; the strip
  (edit / view, escaping, empty); the modal stub; the render + guard wiring in
  both views.
- `test/meetings-board-rerender.test.js`: "on the board" now means the week's
  rows (the strip is above them).
- `test/crm-shell-browser.test.js` C4: the stage move now opens the drawer on
  «תיאום פגישה» with the date focused — asserted, then closed.
- `test/dashboard-perf-assets.test.js`, `test/crm-pwa.test.js`: v96 pins.
- Full suite: 3585 tests, green. `npm audit`: 0 high / critical.
