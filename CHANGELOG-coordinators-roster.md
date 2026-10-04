# Coordinators patient roster — intake, read feed, discharge write-back (2026-10-04)

The patient roster is now shared with **ezone-coordinators** in both directions:

- **Vered admits** a new inpatient in the Dashboard (**«🟢 קליטת מטופל חדש»**) →
  the patient appears in the coordinators app's per-house list
  (`getPatientsForCoordinators`).
- **A coordinator marks a discharge** in the coordinators app → it is written
  straight back to the Dashboard (`recordDischargeFromCoordinators`) and takes
  effect immediately. Vered sees it in **«🚪 שחרורים מהבתים»** to handle
  billing / refunds.

Base branch: `claude/build-ezone-dashboard-QOg5s` (the deployed branch).
`apps-script/Code.gs` changes are in their own commit (the clasp CI deploys
them automatically on merge). Service worker `CACHE_VERSION` **v33 → v34**
(built as v31, rebased onto PR #178's v32 and PR #179's v33).

---

## Decisions (Sandra, 2026-10-04)

| | Decision |
|---|---|
| 1 | The coordinator's discharge takes effect **immediately** — status, occupancy, the Managers feed and the ActivePatients digest all see it on their next read. **No Vered confirmation step.** |
| 2 | Intake requires exactly **name, house, admission date**. It reuses the existing direct-add flow (same record, same `saveAll` path, `source: 'direct_admin'`). |
| 3 | The feed carries **only** `id, name, house, active, admissionDate, dischargeDate`. No phone, billing or payment field — pinned by a contract test. |
| 4 | Own Script Property **`COORDINATORS_PATIENTS_SECRET`**, constant-time compare, **fail-closed**. |

---

## 1. Read feed — `getPatientsForCoordinators`

`POST <the /exec URL>` with JSON body `{ "action": "getPatientsForCoordinators", "secret": "<COORDINATORS_PATIENTS_SECRET>" }`
(GET with `?action=…&secret=…` works too; POST keeps the secret out of URLs/logs).

```json
{
  "ok": true,
  "patients": [
    { "id": "id-3f…", "name": "דנה כהן", "house": "ramot", "active": true,
      "admissionDate": "2026-09-01", "dischargeDate": "" },
    { "id": "id-9a…", "name": "מיכל", "house": "efroni", "active": false,
      "admissionDate": "2026-07-01", "dischargeDate": "2026-09-29" }
  ]
}
```

### Field contract (FROZEN — exactly these keys, in this order)

| Key | Type | Meaning |
|---|---|---|
| `id` | string | The persisted `Patients.id` — immutable, the key for the discharge write. |
| `name` | string | Patient display name (trimmed). |
| `house` | string | Canonical coordinators house id — the `DIGEST-CONTRACT.md` encoding: `ramot` \| `raanana` \| `efroni` \| `rehab` \| `pardes`. |
| `active` | boolean | In the house now: status is not released **and** no discharge date — the population occupancy counts (`wait` / `trial` count as active). |
| `admissionDate` | string | `'yyyy-MM-dd'` (Patients `date`, «תאריך כניסה»); `''` if blank. |
| `dischargeDate` | string | `'yyyy-MM-dd'` (Patients `exitDate`); `''` when not discharged. |

**Which patients:** every active patient, plus released patients whose
`dischargeDate` is within the **last 30 days** (so a discharge stays visible to
the coordinator who made it). Older history is not shared — data minimization.
Houses outside the canonical set (`sde` / unknown) are excluded, exactly as in
the ActivePatients digest.

**Never in the feed:** `pay`, `adv`, phone, notes, `fromLead`, `source`,
`status`, the who/when stamps, or anything from Payments / Credits / Leads. The
projection is an explicit allow-list (`buildCoordinatorsRoster_`), and
`test/coordinators-roster.test.js` pins the key set against the shipped code.

A patient row that has no persisted id yet gets one minted (the same idempotent
`backfillPatientIdsLocked_` `getData` uses — zero writes in the steady state), so
no row is ever served without its key.

## 2. Write — `recordDischargeFromCoordinators`

```json
{ "action": "recordDischargeFromCoordinators", "secret": "<…>",
  "id": "id-3f…", "dischargeDate": "2026-10-04",
  "reason": "סיים טיפול", "by": "רכזת רמות" }
```

| Field | Rule |
|---|---|
| `id` | Required. A `Patients.id` from the feed (≤ 100 chars, no control characters). A patient in a house the feed never shows (`sde` / unknown) answers `patient_not_found`. |
| `dischargeDate` | Required. Strict `'yyyy-MM-dd'` calendar date; **not in the future** (Asia/Jerusalem); not before the admission date. |
| `reason` | Optional free text — one line, formula lead-in (`= + - @`) stripped, `<>` removed, capped at 500. |
| `by` | Required. The coordinator's name — cleaned the same way, capped at 60. |

Under the **script lock** (`LockService`, 10 s; busy → `lock_busy`, nothing written):

1. **Audit row first** — the standard discharged-audit sheet (`מטופלים משוחררים`,
   the one the Dashboard's own «שחרר» writes) gets a row with a deterministic id
   `coord-<patientId>-<dischargeDate>`, `status: released`, `exitDate`,
   `prior_status`, `discharge_note: reason`, and the four **appended** audit
   columns (below). Written first, as in the Dashboard's own discharge: once it
   lands the discharge is durable (the client's `healClobberedDischarges`
   completes a release from it, and the saveAll discharge-loop guard sees the
   lead).
2. **The Patients row** — exactly four cells: `exitDate`, `updatedAt`,
   `updatedBy` (`רכזות · <by>`), then `status: released` last. No other cell
   changes; **no row is ever deleted**. The fresh `updatedAt` means a stale
   Dashboard tab that later saves the old "active" copy is refused as a
   **conflict** (existing `replaceHousePatients_` rule) instead of silently
   re-activating the patient — covered by a test.
3. Best-effort ActivePatients digest refresh (fail-soft), and an `AuditLog`
   entry `patient_discharged_by_coordinators`.

### Responses

| Case | Response |
|---|---|
| Discharged | `{ ok:true, discharged:true, id, dischargeDate }` |
| Replay (already released with the **same** date) — **idempotent** | `{ ok:true, discharged:false, alreadyDischarged:true, id, dischargeDate }` — zero writes |
| Already released with a **different** date | `{ ok:false, error:'already_discharged', id, dischargeDate }` (the existing date) — nothing written |
| Bad / missing secret | `{ ok:false, error:'unauthorized' }` |
| Validation | `invalid_id`, `invalid_discharge_date`, `discharge_date_in_future`, `discharge_before_admission`, `missing_by` |
| Unknown id | `patient_not_found` (`ambiguous_patient_id` if the sheet ever held the id twice) |
| Lock busy | `{ ok:false, error:'lock_busy', … }` — safe to retry |

A retry after an interrupted write completes the discharge on the **same**
audit row (deterministic id) — never a second one.

## 3. Sheet headers — append-only

Verified before the change (`PATIENT_COLUMNS`):
`houseId, name, date, pay, adv, status, fromLead, exitDate, source, notes, id, updatedAt, updatedBy`.
**Unchanged** — the discharge writes existing columns only.

The discharged-audit sheet (`DISCHARGED_PATIENT_COLUMNS`) gains four columns
**appended last** (after `updatedBy`); every existing column keeps its position
and `getOrCreateSheet_` adds the headers non-destructively on the first read:

| Column | Value |
|---|---|
| `dischargeSource` | `'ezone-coordinators'` (blank on the Dashboard's own discharges) |
| `dischargedBy` | the coordinator's `by` |
| `dischargeReason` | the coordinator's `reason` |
| `patientId` | the `Patients.id` that was discharged |

The client's `normalizeDischargedPatient` carries the four fields, so a restore
(which upserts the whole audit row back) never blanks them.

## 4. Dashboard UI

- **«🟢 קליטת מטופל חדש»** — a green, top-level button in the dashboard
  header (edit sessions). Opens the direct-add form in *intake* mode: title
  «קליטת מטופל חדש», required = name / house / admission date (default today),
  monthly amount optional (pre-filled 29,000; blank → 0), no status picker
  (always פעיל). Saves through the existing `saveAll`. **Finance sessions**
  (Vered / Sandra) also get the required «גורם מממן» picker and the funder is
  appended after the save — the admission funder rule from PR #178
  (`CHANGELOG-patient-funder-on-funders.md`) applies to intake exactly as to
  the direct-add form; restricted sessions see no funder field. The «+ הוסף מטופל
  ישירות» button on תפוסה is unchanged.
- **«🚪 שחרורים מהבתים»** — a dashboard card listing coordinator discharges
  from the last 30 days (newest first; restored rows hidden; the Dashboard's
  own discharges are not listed): name, house, discharge date, reason, reported
  by. Read-only, rendered with `textContent` (values come from another app).
  No money in it, so it is visible to every session; the follow-up actions
  (credits / refunds) stay where they were, on מטופלים משוחררים / גבייה.

## 5. Impact on the other consumers (checked; payloads unchanged)

This Apps Script also serves **Managers** (`managersOverview`,
`managersHouse`, `occupancySnapshots`) and **Therapists / Outpatient**
(`getAdmittedRoster`).

- **No payload changed.** `test/cross-app-payload-guard.test.js` pins every key
  of those four responses (and `getData`'s top-level keys), the Patients header
  in full, the discharged-audit header and the occupancy-snapshot header.
- **Data effect, by design:** a coordinator discharge sets `exitDate`, so the
  Managers occupancy figures (`patientsNow`, treatment days) and
  `getAdmittedRoster` drop the patient on their next read — the same effect as
  a discharge done in the Dashboard (asserted in the test). Finished months
  already written to `OccupancySnapshots` never change (append-only sheet).

## 6. Security

- Own secret, **fail-closed** (unset / empty / wrong / missing / non-string →
  `unauthorized`, nothing read or written), constant-time compare
  (`constantTimeEquals_`). Other apps' secrets do not unlock it, and it unlocks
  nothing else. The secret is never echoed, logged or written (tested).
- Both actions are in `OPEN_ACTIONS` (the coordinators app calls Apps Script
  directly, like Therapists) so they keep working when `PROXY_SECRET_MODE` is
  set to `enforce`; their own secret is checked inside `handle_` before
  anything is read. Neither is a finance action.
- The only write is the discharge: four cells + one audit row, under the lock,
  input validated and cleaned (formula lead-ins stripped) before the lock is
  taken.
- Known, pre-existing (unchanged): the web app is deployed
  `ANYONE_ANONYMOUS`, so the `/exec` URL is a capability; handing it to one more
  app widens who holds it (see `CHANGELOG-accounting-source-feed.md`).

## Tests

- `test/coordinators-roster.test.js` — feed key contract + values, auth (fail
  closed, constant time, enforce mode), discharge write, idempotency, retry,
  validation, text cleaning, lock busy, immediate occupancy effect, stale-tab
  conflict refusal.
- `test/cross-app-payload-guard.test.js` — headers append-only; Managers /
  Therapists payload key sets.
- `test/coordinators-roster-ui.test.js` — panel filter, intake fields, audit
  field carry-through, markup.
- `test/coordinators-roster-browser.test.js` — real Chromium at 360px: the
  intake saves a new active patient; the panel lists only recent coordinator
  discharges.
- Existing pins updated for the append-only additions: `open-actions-gate`,
  `payment-report-form` (OPEN_ACTIONS, SW version), `patient-identity-foundation`,
  `patient-who-when`, `restore-choice-modal` (discharged header).

Full suite: **2084 / 2084 green**.

## Setup (once)

See `DEPLOY.md` → «Coordinators roster». In short: set Script Property
`COORDINATORS_PATIENTS_SECRET`, merge (the Apps Script deploys automatically),
give the coordinators app the `/exec` URL + the secret.
