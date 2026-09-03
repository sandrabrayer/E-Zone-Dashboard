# Meeting-report badge: leads board only

## Bug

The דיווח מנהל strip (with the outcome chip, e.g. "התקיימה — מתלבט") rendered
on PATIENT cards in the תפוסה (occupancy) tab. It was built for LEAD surfaces;
a report about a pre-admission meeting showing on an admitted patient's card
is wrong information for Vered.

## Root cause (Phase 1 findings)

Not an accidental leak — a deliberately shipped feature
(`CHANGELOG-meeting-report-on-patient-card.md`) that is now unwanted:

- The badge markup comes from ONE shared renderer, `meetingReportBlockHTML`
  (public/app.js), used by the lead card, the meetings-board row, and the
  in-place refresh after Vered edits a report.
- A dedicated patient path wrapped it: `patientMeetingReportLead` resolved
  `patient.fromLead` → the lead row in `state.leads` (**the match key is the
  lead id**, not name or phone — retiring a lead to stage `admitted` only
  flips its stage, so the lead row and its six `meetingReport*` fields stay
  loaded), and `patientReportBlockHTML` rendered the shared block read-only
  into every patient row in `renderPatients`, wrapped in a `.pt-report` grid
  cell (style.css).

## Fix (frontend-only, minimal)

Scoped at the render-call level, as preferred: the **entire patient-card
path was removed** —

- `renderPatients` no longer renders or wires any report block;
- `patientReportBlockHTML` and `patientMeetingReportLead` deleted (they had
  no other callers);
- the now-dead `.pt-report` CSS rules deleted;
- `meetingReportBlockHTML` simplified: the `opts.readOnly` mode existed ONLY
  for the patient card, so it is gone — the function now renders lead
  surfaces only, and its header comment says so explicitly ("do not
  reintroduce a caller from renderPatients").

Edit/delete report actions were only ever emitted by the shared block; with
no block on patient cards they are unreachable from תפוסה (test-asserted, in
edit mode too).

**No data is deleted** — report rows stay in the Leads sheet untouched, and
no backend (Code.gs) change was needed: the backend does not attach report
data to patient objects; the join happened purely client-side via `fromLead`.

Deliberately unchanged (noted for review): the meetings board still shows the
report block on a PAST meeting row even after that lead was admitted — the
meetings board is Vered's report-reading surface and drives the unseen-count
tab badge, and the row there is about the meeting itself, in context. The
/meeting-report manager form and WhatsApp share are untouched.

## Service worker

`public/sw.js` stays at CACHE_VERSION v5 — since v5, `app.js` and `style.css`
are served **network-first** (cache is an offline-only fallback that
self-refreshes on every successful load), so this fix reaches clients on
their next online load without a version bump. (The live /sw.js could not be
fetched from the CI sandbox — outbound network to the app host is blocked —
but v5 is the version this deploy branch ships, and the v5 strategy exists
precisely so bundle fixes need no bump.)

## Tests

- `test/meeting-report-on-patient-card.test.js` **removed** — it locked the
  exact behavior this PR reverses (7 tests asserting the report renders on
  patient cards).
- `test/meeting-report-leads-only.test.js` **added** (5 tests, vm-sandbox on
  the real shipped app.js with a mini-DOM): the REAL `renderPatients` output
  contains no meeting-report markup even when the patient's originating lead
  carries a report — in view AND edit mode (so report edit/delete are
  unreachable from patient cards); the lead-surface renderer still shows the
  block with outcome chip, unseen cue, and edit-mode actions; view mode still
  hides actions; and a source scan pins the patient path (both helpers and
  `pt-report`) as deleted.

Full suite: **781 tests, all green** (`node --test`).

## For Sandra

Nothing to run — merge deploys via Railway as usual; users pick the fix up on
their next online load (network-first bundle). Reports remain visible and
manageable exactly where they were designed to live: the leads board card and
the meetings board.
