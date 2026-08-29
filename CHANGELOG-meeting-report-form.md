# Meeting Report — Form + Endpoint (PR 2)

House managers now report meeting outcomes from a **standalone mobile page**
(`/meeting-report`) served by the same Railway app — replacing the WhatsApp-only
flow. The page is gated by its **own PIN** (`MEETING_REPORT_PIN`), deliberately
NOT the main-app PIN: a manager holding the reporting PIN gains **zero access
to the dashboard**, and a dashboard session grants nothing on the reporting
routes. Builds on PR 1 (#90) — the six `meetingReport*` lead columns and the
label maps. **Nothing Vered sees in the main app changes**; her view ships in
PR 3.

## Auth model — `server.js` + `lib/session.js`

- `lib/session.js` gains an optional **scope** on token signing
  (`ezone-session.<scope>.<expiry>`); the default (no scope) signs the original
  message, so **every existing main-app cookie stays valid**. The
  meeting-report cookie (`mr_session`, HttpOnly, SameSite=Strict, 7 days,
  Secure on HTTPS) is signed in the `meeting-report` scope with the existing
  `SESSION_SECRET` — the two cookies can **never unlock each other's routes**
  (locked by tests, including token-smuggling both ways).
- `GET /meeting-report` — **503 fail-closed** when `MEETING_REPORT_PIN` or
  `SESSION_SECRET` is unset. With a valid `mr_session`: the form page.
  Without: a self-contained PIN entry page (maxlength 6, numeric, mirroring
  the main pin-box pattern).
- `POST /api/meeting-report/verify-pin` — constant-time compare against
  `MEETING_REPORT_PIN` via the existing `checkPin`, with its **own** per-IP
  rate-limit counter (10 / 15 min, same policy as the main PIN).
- `GET /api/meeting-report/leads` — meeting-report session only. Proxies
  `meetingReportLeads` and re-applies the field whitelist server-side:
  `{ id, name, house, visitDate }` — **no phones, no notes, no contact or
  billing fields**.
- `POST /api/meeting-report/submit` — meeting-report session only. Forwards
  the report with `MEETING_REPORT_SECRET` attached **server-side, in the POST
  body** (never a URL, never the browser — the outpatient-secret discipline).
  The secret also joins the debug-log redaction list.
- `/meeting-report.js` + `/meeting-report.css` are served behind the same
  session gate (the PIN page is self-contained inline).

## Apps Script — `apps-script/Code.gs`

- New Script Property **`MEETING_REPORT_SECRET`**; both actions refuse
  (`unauthorized`) when it is unset or mismatched — the
  `ADMITTED_ROSTER_SECRET` fail-closed pattern.
- `meetingReportLeads` (read): open leads only (a Leads-sheet row whose stage
  is not admitted/irrelevant, covering both stable ids and legacy Hebrew
  labels), each reduced to `{ id, name, house, visitDate }` with `visitDate`
  normalized to `YYYY-MM-DD`.
- `submitMeetingReport` (write): payload `{ leadId, outcome, companion, note,
  reporter }`. Validation (reject, never partially write):
  - `leadId` must match an **open** lead;
  - `outcome` ∈ `advancing|undecided|not_fit|no_show`;
  - `companion` ∈ preset keys OR free text ≤ 100 chars (the אחר flow — raw
    text stored as-is);
  - `note` ≤ 2000 chars; `reporter` non-empty, ≤ 100 chars.
  On success: **read-merge-write** through `upsertRowById_` (the full existing
  row is preserved) setting `meetingReportOutcome`, `meetingCompanion`,
  `meetingNote`, `meetingReporter`, `meetingReportedAt` (ISO timestamp string;
  the columns are already `@`-text-forced from PR 1) and **resetting
  `meetingSeen` to `''`** so PR 3 surfaces the report as unseen. A
  resubmission for the same lead **overwrites** — last write wins.

## Form — `public/meeting-report.html` (+ `meeting-report.js` / `.css`)

Hebrew RTL, mobile-first, no dependency on `app.js`. Single screen:
1. **מדווח/ת** — dropdown from frozen `MEETING_REPORTERS`, one entry per
   house. **Placeholders** (`מנהל/ת רעננה אשר` …) — Sandra replaces them with
   the real names (small follow-up commit is fine).
   ⚠️ Spec deviation: the prompt listed 4 keys (`raanana|ramot|arfoni|rehab`)
   but the app has **six houses** (`arfoni, rehab, asher, pardes, ramot, sde`;
   there is no `raanana` house id) — the constant follows the real roster,
   honoring "one entry per house".
2. **ליד** — picker of open leads with `visitDate` ≤ today, sorted newest
   first; a "לא מוצא את הליד?" toggle reveals all open leads (blank visit
   dates last).
3. **תוצאה** — 4 large tap targets with the PR-1 Hebrew labels.
4. **מי הגיע איתו** — chips for the 8 preset keys; אחר reveals a free-text
   input whose value is submitted as `companion`.
5. **פירוט** — free-text textarea (maxlength 2000).
6. Submit with a local busy-guard (double-tap can't fire twice).

Confirmation screen: success summary, **שלח לקבוצה** (opens
`https://wa.me/?text=…` — the WhatsApp chat picker; the manager picks the
group) with the formatted Hebrew message, and **דיווח נוסף** to reset.

The label maps are duplicated from `app.js` (the form must not load the
dashboard bundle); a test locks them **in sync** with the PR-1 maps.

## Service worker

**No change needed** — the existing rules already treat the new routes
correctly: `/api/meeting-report/*` is network-only (never cached) via the
`/api/` rule, and `/meeting-report` passes through to the network uncached.
Locked in by tests.

## `scripts/healthcheck.js`

Unaffected — no schema change; its `LEAD_COLUMNS` sync copy already carries
the PR-1 columns.

## Tests

`node --test`, matching the repo's patterns — 42 new tests across:
- `test/meeting-report-backend.test.js` — fail-closed secret (both actions),
  field whitelist, open-only filter, all validation rejections, happy-path
  write of the five fields + `meetingSeen` reset, resubmit-overwrites.
- `test/meeting-report-server.test.js` — scoped-token isolation (main cookie
  ↛ meeting-report routes and vice versa, incl. smuggled tokens), 503 when
  `MEETING_REPORT_PIN` / `SESSION_SECRET` unset, PIN page vs form page
  serving, cookie attributes.
- `test/meeting-report-form.test.js` — picker filter/toggle/sort, אחר
  free-text substitution, WhatsApp template + encoding, label-map sync with
  app.js, SW strategy for the new routes.

Full suite green, zero regressions.

## Post-merge setup checklist

1. Railway env: set `MEETING_REPORT_PIN` (≤6 digits) and
   `MEETING_REPORT_SECRET`; redeploy (Railway vars apply only to new
   deployments).
2. Apps Script Script Properties: set `MEETING_REPORT_SECRET` (same value).
3. clasp CI deploys Code.gs on merge — verify via DevTools Network that the
   new actions respond JSON (not Google HTML).
4. Replace `MEETING_REPORTERS` placeholder names (small follow-up commit is
   fine).
5. Send managers the URL + PIN.
