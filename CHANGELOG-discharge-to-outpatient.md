# Discharge → Outpatient lead (PR 3 of 3)

When a patient is discharged with the disposition **משוחרר לטיפול חוץ**
(`released_outpatient`, added in PR 2), the Dashboard now also creates a lead in
the **Outpatient** app carrying name + phone + house + a source note. The other
two dispositions (סיים טיפול / הפסיק לפני הזמן) do nothing cross-app.

## Locked design decisions

- **Trigger:** only when `disposition === 'released_outpatient'`.
- **Fields carried:** `name`, `phone`, `house`, `note` — nothing else.
- **Non-fatal:** the discharge must still succeed locally even if the Outpatient
  write fails. The cross-app call runs *after* the local discharge has persisted,
  catches all its own errors, never throws, and never touches discharge state —
  so it can never block or roll back the discharge. On failure the user gets a
  warning (showError) telling them to add the lead manually; on success a toast.

## Cross-app contract (Outpatient `createLead`)

```
POST {OUTPATIENT_LEAD_URL}?action=createLead
Body (JSON): { secret, name, phone, house, note }
Success:     { ok: true, id }
Failure:     { ok: false, error }
```
Fail-closed on a bad/missing secret, mirroring the Dashboard `getAdmittedRoster`
secret discipline.

## Architecture / where the secret lives

The discharge runs in the browser, but the shared secret must never reach the
client. So the call is proxied:

```
browser  →  POST /api/outpatient-lead { name, phone, house, note }
server.js →  injects secret from Railway env, POSTs
             {OUTPATIENT_LEAD_URL}?action=createLead { secret, name, phone, house, note }
Outpatient → { ok, id }
```

- The secret (`OUTPATIENT_LEAD_SECRET`) and URL (`OUTPATIENT_LEAD_URL`) are read
  from **Railway env** in `server.js` — never hardcoded, never sent to the
  browser, never logged (only `{ ok, id, error }` is logged).
- This was chosen over a Dashboard `Code.gs` + `UrlFetchApp` path specifically so
  that **`Code.gs` is not touched** — avoiding the dual Dashboard Apps Script
  deploy. (The only existing outbound channel, the paused bonus-bridge
  `getContinuationBonus`, is read-only and could not be reused for a write.)

## Field mapping (and one data-availability note)

- `name`  ← `patient.name`.
- `phone` ← **joined from the originating lead** (`patient.fromLead` →
  `state.leads`), exactly as `getAdmittedRoster_` does it. Patients carry no
  phone of their own, so a hand-entered patient with no lead sends `phone: ''`.
- `house` ← the stable **`houseId` key** (e.g. `arfoni`), NOT the Hebrew display
  name. The **Outpatient side maps the key to its own house** — the endpoint
  receives a houseId key, not a Hebrew name.
- `note`  ← the patient's **`source` + `notes` combined** (`' — '`-joined,
  empty parts dropped). **No exit/discharge date** is placed in the note — the
  discharge date is recorded on the discharge audit row (PR 2), not on the lead.

## Deploy surface

- **Outpatient Apps Script (ezone-outpatient repo — SEPARATE repo, NOT in this
  workspace):** must add the `createLead` write endpoint + a shared-secret Script
  Property and **deploy via pencil ✏️ → New version on the EXISTING deployment**
  (never New deployment). This is a hard prerequisite handled outside this repo;
  until it exists the proxy returns `outpatient_not_configured` and the
  Dashboard warns the user to add the lead manually.
- **Dashboard (this repo):** `server.js` + `public/app.js` only. Set Railway env
  vars `OUTPATIENT_LEAD_URL` and `OUTPATIENT_LEAD_SECRET`; Railway redeploys on
  merge. **`apps-script/Code.gs` is NOT touched → no Dashboard Apps Script
  deploy, the dual deploy IDs `AKfycbyScn2vcaOb` + `AKfycbxkUs27ZOJdK` do NOT
  apply to this PR.**

## Files

- `server.js` — `OUTPATIENT_LEAD_URL` / `OUTPATIENT_LEAD_SECRET` env reads;
  `outpatientPost`; the fail-closed, secret-free-logging `POST
  /api/outpatient-lead` proxy route.
- `public/app.js` — `shouldCreateOutpatientLead` (trigger), `outpatientLeadPayload`
  (pure field mapping), `createOutpatientLead` (non-fatal proxy call); the
  `dischargePatient` `onConfirm` calls it after the local discharge persists,
  only for `released_outpatient`.
- `test/discharge-to-outpatient.test.js` — vm-sandbox suite (8 tests): trigger
  fires only for `released_outpatient`; field mapping incl. phone-from-lead and
  empty-phone / unknown-house fallbacks; failed and `ok:false` writes are
  non-fatal (no throw, no discharge-state mutation).
- `CHANGELOG-discharge-to-outpatient.md` — this file.

## Operator setup (required before this has any effect)

1. ezone-outpatient: add the `createLead` endpoint + secret Script Property,
   deploy the Web App (New version on the existing deployment).
2. Dashboard Railway: set `OUTPATIENT_LEAD_URL` (the Outpatient /exec URL) and
   `OUTPATIENT_LEAD_SECRET` (matching the Outpatient secret). Redeploy.
3. Until both are set, a `released_outpatient` discharge still succeeds locally
   and the user is told to add the Outpatient lead manually.

## Commits

- _(pending)_ feat(discharge): create Outpatient lead on released_outpatient discharge
