# «אמבולטורי» as a «נפגש עם» option → the lead goes to Outpatient (October 26, 2026)

At the «ביקור נקבע» stage, «נפגש עם» lists the current managers. It now also has one
fixed option, **«אמבולטורי»**: the ambulatory unit (Shachar with Oren the coordinator).
The meeting is scheduled and stays on this board. Choosing it also sends the lead to
the Outpatient app, once.

## Trace (read-only, before the change)

| Where | What it does with `Leads.meetingWith` | After this PR |
|---|---|---|
| `meetingWithSelectHTML` / `meetingWithOptionNames` / `meetingWithField` (app.js) | card select, add/edit lead modals, meeting edit modal | «אמבולטורי» is the LAST option; a saved value stays selected |
| `autosaveMeetingWithDefaults` (app.js) | fills an EMPTY visit-stage meetingWith with the house manager | unchanged: a saved «אמבולטורי» is not empty, so it is never filled or overwritten |
| `currentManagers_` (Code.gs) | Managers tab → bonusconfig → HOUSE_MANAGERS | filters out «אמבולטורי» even if a tab row names it |
| `meetingReportManagers_` / `submitMeetingReport_` | the reporter must be a current manager | unchanged; «אמבולטורי» can never be a reporter |
| `readLeadMeetingManagers_` → `computeIntakeMeetingsByHouse_` → `managerHouseByName_` | intake-meeting bonus credit | `managerHouseByName_` returns '' for «אמבולטורי» → no house is credited. No bonus rule changed |
| meetings board (`meetingsForWeek`, `meetingRowHTML`) | lists each meeting with its meetingWith | shows «אמבולטורי»; WhatsApp button disabled (no phone) unless `MANAGER_PHONES` has it |
| summary strip (`meetingsSummaryHTML`) | current managers only | no «אמבולטורי» row, no «ללא מנהל» row |
| `mwHouseData_` visits / expected admissions (ezone-managers) | `meetingWith` as text | a plain name, no error |
| Dashboard → Outpatient | `POST /api/outpatient-lead` in server.js (Railway `OUTPATIENT_LEAD_URL` / `OUTPATIENT_LEAD_SECRET`), used by the discharge «משוחרר לטיפול חוץ» flow | refactored onto a reusable `sendToOutpatient` helper (same contract) |
| `sendToOutpatient_` | **did not exist** on the deploy branch | created as `sendToOutpatient` in server.js (the existing outbound channel; Code.gs has none) |

(`CREATE_LEAD_SECRET` is the INBOUND therapists → Dashboard secret; it is not involved.)

## How the send works

1. **Code.gs `saveAll_`** (inside its lock): `mergeLeads_` notes every lead whose
   meetingWith BECOMES «אמבולטורי» (a new lead, or a sheet value that was something
   else). `ambulatoryHandoffPending_` answers `ambulatoryHandoff`
   `[{ leadId, name, phone, note, source }]` for each «אמבולטורי» lead that:
   - has no `outpatient_lead_sent` row in AuditLog, AND
   - changed in this save, OR had an earlier `outpatient_lead_send_failed`.
   Values are cut to safe cell text (no formula lead-in, no control characters,
   capped); the phone is the handoff-normalized one (`''` when invalid). **No house**
   is sent: the preferred house is set in Outpatient.
2. **server.js** (`applyAmbulatoryHandoff`, saveAll only, after the lock is released):
   takes the list OUT of the answer (the browser and the debug store never see the
   phones), and for each lead (`lib/ambulatory-handoff.js`):
   - no phone → not sent, recorded as `no_phone`;
   - otherwise `sendToOutpatient({ name, phone, note, source })` — the secret from
     Railway env, in the body only, never logged; 20 s timeout;
   - then `recordOutpatientLeadSend` (Code.gs) → AuditLog `outpatient_lead_sent` or
     `outpatient_lead_send_failed` (patientId column = lead id; details = the outcome
     code only, never a phone).
   The browser gets `ambulatory: { sent: [ids], failed: [ids], warning? }`.
3. **app.js**: a sent id gets the «נשלח לאמבולטורי» chip on its card at once (and on
   every load via the additive getData key `outpatientSentLeadIds`). A failed send shows
   «הפגישה נשמרה, אך שליחת הליד לאמבולטורי נכשלה — לא נשלח».

### Guarantees

- **Idempotent:** a lead is never sent twice — not on a later save, not when the value
  goes away and comes back. A second `sent` record writes nothing. A send already in
  flight in the server process is not started again.
- **Retry:** a failure (Outpatient down / refused / timeout / not configured / no
  phone) never fails the save; the next save of the board retries.
- **Never closed or moved:** the lead keeps its stage and row; nothing touches the
  irrelevant / removed sheets.
- **No LEAD_COLUMNS change**, no new sheet, no new Script Property or Railway variable.

### Security

- `recordOutpatientLeadSend` is **server-only**: `/api/sheets` answers 403 to a browser
  call (`SERVER_ONLY_ACTIONS`), and Code.gs refuses it without a verified proxy actor.
- Secret only from Railway env (`OUTPATIENT_LEAD_SECRET`), redacted from every stored
  error; never in a URL, a log line or an answer.
- Every rendered value is `escapeHtml`-ed; the chip is fixed text.
- Inputs validated and length-limited on both sides (Code.gs cell text; server.js
  `cleanItem` + `sendToOutpatient` caps).
- `npm audit`: 0 high / critical.

### Known limits

- A timeout is reported as a failure, but Outpatient may still have created the lead
  after the 20 s; the retry could then create a second one there.
- If the send succeeds but the AuditLog record fails, the chip shows for this session,
  and the lead is not resent unless its value changes away and back.

## Files

- `apps-script/Code.gs` — `MEETING_WITH_AMBULATORY`, `isAmbulatoryMeeting_`;
  `currentManagers_` filter; `managerHouseByName_` guard; `mergeLeads_`
  `ambulatoryChanged`; `saveAll_` `ambulatoryHandoff`; `outpatientLeadSendLog_`,
  `ambulatoryHandoffPending_`, `recordOutpatientLeadSend_` (+ `handle_`,
  `PROXY_KNOWN_ACTIONS`); getData `outpatientSentLeadIds`.
- `server.js` — `sendToOutpatient` (the discharge route now uses it too),
  `applyAmbulatoryHandoff`, `refuseServerOnlyActions`.
- `lib/ambulatory-handoff.js` — the per-lead send + record loop.
- `public/app.js` — `MEETING_WITH_AMBULATORY`, option list, chip, warning.
- `public/style.css` — `.lc-amb-chip`. `public/sw.js` — v90 → **v91** (live v90
  verified 26/10/2026; v17 never reused).
- Tests: `test/meeting-with-ambulatory.test.js` (30); getData key lists, option lists
  and SW version updated in 11 existing suites.

## Deploy

Code.gs ships via the clasp CI on merge (no manual paste, no new deployment). Railway
redeploys server.js + public/ on merge. Nothing to set. ezone-outpatient is not changed:
it receives an extra `source` field and no `house`.
