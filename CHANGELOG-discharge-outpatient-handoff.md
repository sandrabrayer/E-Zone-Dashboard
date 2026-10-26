# Discharged → Outpatient: reliable send, «העבר לאמבולטורי», missing-from-Outpatient report, restore matching (October 26, 2026)

## Root causes (read-only trace)

### 1. Some «משוחרר לטיפול חוץ» patients never reached Outpatient

The Outpatient lead was created by the BROWSER only: one `fetch('/api/outpatient-lead')`
at the very end of `runDischarge`, with no server-side record. It was skipped or lost when:

1. **The Patients write failed** after the discharge row landed. The code threw before the
   send; the next load completed the discharge from its row, but nothing sent.
2. **The server answered `duplicate: true`** (an earlier attempt's answer was lost). The
   code returned before the send.
3. **The send failed** (Outpatient error, secret, timeout, page closed). The user got one
   toast. There was no record, no retry and no button.
4. **There was no phone.** The phone was looked up in `state.leads` only, so a patient
   whose lead had moved to the closed / removed tabs (or had no lead) was sent with
   `phone: ''`.
5. **The discharge came from the coordinators app** (`recordDischargeFromCoordinators_`
   writes `disposition: ''`), or «המשיך באמבולטורי» was set later. Neither ever sent.

### 2. One discharged patient could not be restored (or kept active)

A Dashboard discharge row found its patient only by an EXACT `houseId` + `name` + `date`
compare on the client (`matchActivePatientIndex`, `openDischargeAuditsFor`,
`auditRowForReleasedPatient`). Its `patientId` column was filled on coordinators rows
only. When the name or the date changed after the discharge (invisible bidi marks — the
documented «אביב שבתאי» case — a trim, a corruption repair, an entry-date fix):

- «החזרה לסטטוס הקודם» found no patient, rebuilt a second row with the same `fromLead`,
  and `saveAll` refused it through the duplicate-admission guard
  (`existing_patient_row` / `discharged_not_restored`). It failed every time.
- A ✏️ edit back to active missed the open discharge row, so the next load released the
  patient again.

## Fixes

### Send (no Code.gs sender — server.js `sendToOutpatient` + `/api/outpatient-lead`)

- `POST /api/outpatient-lead { dischargeId, manual }` — the browser names the discharge row
  only. server.js asks Code.gs `dischargeOutpatientPayload` (server-only, verified proxy
  callers):
  - the row must exist and be open;
  - automatic sends only «משוחרר לטיפול חוץ»; `manual` («העבר לאמבולטורי») allows any row;
  - answers `alreadySent` when AuditLog holds `outpatient_lead_sent` under
    `discharge:<row id>`;
  - else returns `{ name, phone, house (houseId key), note (source — notes) }`. The phone is
    taken from the source lead on Leads, then the closed and removed tabs.
- It sends through the existing `sendToOutpatient` (Railway `OUTPATIENT_LEAD_URL` /
  `OUTPATIENT_LEAD_SECRET`). Then `recordOutpatientLeadSend { dischargeId }` writes
  `outpatient_lead_sent` / `outpatient_lead_send_failed` to AuditLog (key `discharge:<id>`;
  no phone in the log). A blank phone is never sent (`no_phone`, Hebrew message).
- The שחרור flow sends by row id on **every** path once the discharge row landed: success,
  failed Patients write, and duplicate answer (the server skips a non-«טיפול חוץ» row).
- The old body `{ name, phone, house, note }` still works for a cached older page.

### «העבר לאמבולטורי» on discharged rows

- Edit mode, every open row. It uses the busy pattern (`busyButton(…, 'send', …)`).
- Once sent, the row shows «נשלח לאמבולטורי» instead (from getData's existing
  `outpatientSentLeadIds`, which now also carries `discharge:<id>` keys).
- Idempotent server-side. No schema change.

### Restore matching

- New Dashboard discharge rows record `patientId` (the existing appended column).
- `matchActivePatientIndex`: the persisted `patientId` first, then house + normalized name
  (`normalizeNameForMatch`: invisible marks, inner spaces, case) + `isoDate`. The restore
  alone also accepts the ONE released row of the house with the same source lead (a name or
  entry-date edit). The load-time heal never matches by lead.
- `openDischargeAuditsFor` / `auditRowForReleasedPatient` use the same rule, so a
  re-activation flags the right rows.
- Server: a rebuilt row (patient row hard-deleted) that carries the open discharge row's own
  id and is not 'released' is that stay's restore, so the duplicate-admission guard lets it
  land. `dischargedFromLeadIds_` now maps lead id → open row ids (still truthy per lead).

### Report — `outpatientMissingReportNow()` (editor-run, Google Doc)

Run it from the Apps Script editor. It is read-only on the spreadsheet; its only write is one
new private Doc, whose URL it logs. The log holds counts only, no names.

1. Open discharge rows with «משוחרר לטיפול חוץ» or «המשיך באמבולטורי» that have no recorded
   send and no matching name on the Outpatients tab. Rows from before this change have no
   send record, so they show «לא מאומת»: check them in Outpatient before sending.
2. Open discharge rows that match no patient by `patientId` or the exact triple — the rows
   whose restore failed — with «נמצא אחרי ניקוי» when the new normalized match finds them.

## Security

- `dischargeOutpatientPayload` and `recordOutpatientLeadSend` are server-only: 403 from
  `/api/sheets`, and Code.gs requires a verified proxy actor.
- The secret comes from Railway env only and is never logged or returned.
- `dischargeId` is validated (1–200 chars, no control characters). Values are cut to safe
  cell text on both sides.
- Every rendered value goes through `textContent`; the chip is fixed text.
- `npm audit`: 0 high / critical.

## Files

- `apps-script/Code.gs` — `dischargeOutpatientPayload_`, `recordDischargeOutpatientSend_`,
  `dischargeRowById_`, `dischargeLeadPhone_`, `dischargeOutpatientFields_`,
  `outpatientMissingRows_`, `unmatchedDischargeRows_`, `outpatientMissingReportNow`; the
  restore guard in `replaceHousePatients_`; `dischargedFromLeadIds_`.
- `server.js` — `dischargeOutpatientHandoff` in `/api/outpatient-lead`;
  `SERVER_ONLY_ACTIONS` += `dischargeOutpatientPayload`.
- `lib/ambulatory-handoff.js` — one shared send + record step (`sendAndRecord`);
  `handOffDischarge`.
- `public/app.js` — discharge send by row id, `createOutpatientLead(patient, dischargeId,
  { manual })`, «העבר לאמבולטורי», matching. `public/style.css` — chip on discharged rows.
- `public/sw.js` — v91 → **v92** (live v91 verified 26/10/2026; v17 never reused).
- Tests: `test/discharge-outpatient-handoff.test.js` (20). `test/discharge-to-outpatient.test.js`
  is adapted (the payload mapping moved server-side). Version pins are updated.

## Deploy

- Code.gs ships via clasp CI on merge (no manual paste, no new deployment).
- Railway redeploys on merge. Nothing to set.
- Afterwards: run `outpatientMissingReportNow` once from the editor and use
  «העבר לאמבולטורי» for the listed rows.
