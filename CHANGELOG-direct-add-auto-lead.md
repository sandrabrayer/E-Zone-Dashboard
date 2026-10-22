# Direct add → a regular ADMITTED lead («פנייה ישירה»)

**What:** a patient added straight into «תפוסה» now gets a regular lead. That covers a patient Vered
adds, a patient who approached a manager directly, and a returning patient. Before, such a patient was
shown as «ללא ליד» or kept only a hidden phone-record lead.

The lead:

| Field | Value |
| --- | --- |
| `id` | `dl-<patient id>`. Deterministic, so a retry never adds a second lead. |
| `stage` | `admitted` (never on the board, never in «ממתינים לקליטה») |
| `source` | `direct_approach`, a stable key. The UI shows «פנייה ישירה». |
| `entryDate` | the patient's entry date |
| `house` | the house's Hebrew name |
| `name` | copied from the patient |
| `phone` | `normalizePhone_` / `leadHandoffPhone_` (mobile or landline). It may be blank: a patient without a phone still gets a lead. |
| `created` | today |
| `note` | «פנייה ישירה (נוסף בתפוסה)», or «פנייה ישירה — מטופל חוזר (נוסף בתפוסה)» for a returning stay |

The patient's `fromLead` points to the lead. Base: `claude/build-ezone-dashboard-QOg5s` at `c4092c9`
(after #262, #264, #265).

## Server (`apps-script/Code.gs`, `saveAll_`)

This runs inside the existing lock, after the lead guards and **before any patient is written**. It
covers every **new** patient row (id and `houseId::name::date` key not on Patients) whose source is
`direct_admin`:

| The patient's `fromLead` | Result |
| --- | --- |
| a free `direct_approach` lead (a retry) | linked as is, nothing written |
| a free `direct_admin` phone-record lead (from an old client) | **adopted in place**: upgraded to `direct_approach`, never duplicated |
| a free real board lead (not a returning stay) | the link stays, no extra lead |
| closed / removed / unknown lead, a lead another patient row or an open discharge holds, or a returning stay | a **new** `dl-<id>` lead |

- "Free" means no other Patients row and no open discharge row links to the lead.
- The client's copy of `dl-<id>` is taken out of the lead payload. The server reads only its phone and
  writes the canonical lead itself.
- A new row with no id gets one first.

**Returning patient:** the new stay gets its own new lead. The previous lead is untouched. `personId` +
`fromLead` stay on the patient row. Leads gets **no** `personId` column: `IRRELEVANT_LEAD_COLUMNS` and
`REMOVED_LEAD_COLUMNS` are built from `LEAD_COLUMNS`, so an extra column would shift their layouts.

**Failures are never silent:**
- A lead write that throws or does not land refuses the whole save before any patient is written. The
  response is `{ok:false, error:'direct_lead_failed', message}` (Hebrew), with an AuditLog entry
  `direct_lead_failed`. The leads already written for that save are taken back.
- A patient write that throws removes the leads created for it (`direct_lead_undone`), then rethrows.
- A lead made for a patient that did not land (delete tombstone, duplicate refusal) is removed again and
  reported in `directLeadsDropped`.
- The response adds `directLeads: [{patientId, leadId}]`. It is additive and absent when empty.

**Never a backfill:** an ordinary `saveAll` never adds a lead for an already-saved patient. The backfill
is `migrateDirectPatientLeadsNow` (CHANGELOG-direct-lead-backfill.md).

**Name/phone rule:** `direct_approach` is exempt, like `direct_admin`, on the server
(`leadRequiredViolations_`) and in the edit-lead form (`leadRequiredErrors`).

New helpers: `buildDirectApproachLead_` (the one builder, shared with the backfill),
`directPatientCandidates_`, `ensureDirectPatientLeads_`, `undoDirectLeads_`, `settleDirectLeads_`,
`directLeadId_`, `PATIENT_HOUSE_NAMES_HE`. Reused as-is: `leadHandoffPhone_` and `normalizePhone_` (PR C),
`movedOffLeadsIds_`, `dischargedFromLeadIds_`, `upsertRowById_`, `countRowsById_`, `deleteRowsById_`,
`logAudit_`.

## Client (`public/app.js`, `lib/leads-funnel.js`, `public/style.css`)

- **Forms:** the direct-add, intake and returning forms build the same lead (`buildDirectApproachLead`,
  matching the server builder field for field). They send it in the same `saveAll` with `prove.leads`.
  A refused or unproven save rolls back both the patient and the lead, and the form stays open. A board
  lead of the same person (name + phone) is still linked instead (not for a returning stay).
- **Source chip:** «פנייה ישירה», or «חוזר» for a returning stay, replaces «ללא ליד · נוסף ישירות /
  מטופל חוזר» in «פרטי הליד» and in the problem chip. It uses the info colour, not the danger one.
- **Hebrew labels:** the lead card, «פרטי הליד», «ממתינים לקליטה» and the funnel rows and CSV show
  «פנייה ישירה» instead of the key (`leadSourceLabel`, `LeadsFunnel.sourceLabel`).
- **Funnel:** a `direct_approach` lead counts once under «נכנסו לבית» in the period of its creation date.
  `direct_admin` stays excluded.
- **SW:** v82 → **v83** (live v82 verified 21/10/2026).

## Bonus (traced, unchanged)

The only bonus that reads leads is the intake-meeting bonus:
`Patients.fromLead → Leads.meetingWith → Managers tab`, via `managersOverview_` /
`computeIntakeMeetingsByHouse_` (`readLeadMeetingManagers_`). Nothing on that path looks at the lead's
`source` or `stage`.

So a direct-add lead counts exactly like a normal admitted lead once someone sets `meetingWith`. While
`meetingWith` is blank, it is not counted, the same as any lead. No bonus rule or amount changed. A test
checks that both paths give the same result.

## Tests

3269 → 3295 (`npm test`, all green).
- `test/direct-add-auto-lead.test.js` adds 26 tests: one lead per add, the client copy cannot set
  fields, retry without duplicate, phone-less and landline, id minted, returning (×2), legacy adopt,
  board-lead link untouched, closed / removed / unknown → fresh lead, failed write (throw and silent)
  saves nothing and is logged, second write failing, patient write throwing, tombstone leaves no orphan,
  no backfill and the manual path unchanged, the name/phone exemption, bonus parity, the forms build and
  send the lead, phone-less form, refusal rollback and retry, same-person board lead, client = server
  builder, chip and labels, not on the board or in «ממתינים לקליטה», edit-form exemption, funnel counts
  once.
- Updated for the new behavior: `returning-patient.test.js` (own lead, chip labels),
  `audit-log-dedupe.test.js` and `patient-identity-foundation.test.js` (a direct append is now a linked
  append), `patients-tab-ui.test.js` (escape allow-list), `dashboard-perf-assets.test.js` (v83).

## Deploy

- Code.gs deploys automatically on merge (clasp CI).
- Railway deploys `public/`.
- No new route, action, Script Property or Railway variable.
- Existing patients without a lead: run `migrateDirectPatientLeadsNow()` (dry run first) after PR B.
