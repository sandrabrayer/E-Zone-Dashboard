# Deploy — E-ZONE Dashboard (shared Apps Script backend)

**Invoice-request review candidate (October 16):** frontend/static-route change,
cache v71 from verified live v70. No Apps Script deploy, migration, flag or trigger
change. After separate release approval, verify the existing deployment, content
hashes and the collapsed Billing Control section. See
[scope and completion contract](docs/billing-document-evidence.md).

**Billing reminders #242 (October 15):** separately approved, merged, deployed and
activated for daily all-open summaries at 08:00–09:00 Asia/Jerusalem. Settings were
read back and the owner's old digest trigger replaced; scheduled execution and
inbox arrival remain unverified. No reinstall is needed for the frontend change.
The code remains default-off on unconfigured projects. Follow
[the reminder rollout/stop procedure](docs/billing-reminder-rollout.md) for operation.

**Managers protocol 2 rollout:** this change closes the old unauthenticated
Managers feeds. Follow [the coordinated activation order](docs/managers-hardening-rollout.md)
before merging. The existing auto-deploy updates the original URL immediately;
first prepare a separate versioned candidate and activate compatible Managers
code/configuration. Do not run the ordinary deploy workflow on the PR branch.


This repo owns the deploy for the **"ezone dashboard" Apps Script**, which serves
three consumers (per `EZONE-ECOSYSTEM-STATUS.md`): Dashboard (`SHEETS_URL`),
Managers (`APPS_SCRIPT_URL`), Therapists (`DASHBOARD_SHEETS_URL`). `ezone-managers`
reads this backend and writes its own authenticated work logs — it has no deploy workflow, so the two repos never fight
over the same project.

Two independent deploy paths:

| Layer | Runs it | Trigger |
| --- | --- | --- |
| **Node/Express + frontend** | Railway | Auto-deploys the connected branch (`claude/build-ezone-dashboard-QOg5s`). |
| **Apps Script backend** (`apps-script/**`) | GitHub Actions → clasp | Push to `claude/build-ezone-dashboard-QOg5s` touching `apps-script/**`. |

**Verify a Railway deploy:** `GET https://ezone-dashboard.up.railway.app/api/version` returns
`{ commit, builtAt }` (public, `no-store`). When `commit` equals the merge SHA, Railway is
serving the merge; if it never changes, the deploy was skipped. See `CLAUDE.md` rule 4.

## Automatic Apps Script deployment (clasp in CI)

**Workflow:** [`.github/workflows/deploy-apps-script.yml`](.github/workflows/deploy-apps-script.yml)

On every push to **`claude/build-ezone-dashboard-QOg5s`** that changes
`apps-script/**` (or `.clasp.json` / the workflow), CI installs
`@google/clasp@3.3.0`, writes `~/.clasprc.json` from the `CLASPRC_JSON` secret,
runs `clasp push -f`, then `clasp deploy -i <DEPLOYMENT_ID>` — a **new version of
the EXISTING deployment**, so the `/exec` URL never changes and all three
consumers keep working. It **fails loudly and early** if a secret is missing or
`CLASPRC_JSON` isn't valid JSON, and requires clasp's `Deployed …@<version>`
confirmation (clasp 3.x can reject an id and still exit 0).

### ⚠️ After this merges, CI fails until you add two secrets

**Settings → Secrets and variables → Actions → New repository secret:**

| Secret | Value |
| --- | --- |
| `CLASPRC_JSON` | `npm i -g @google/clasp@3.3.0` → `clasp login` → full contents of `~/.clasprc.json` |
| `DEPLOYMENT_ID` | the `AKfyc…` segment of the live `/exec` URL (Manage deployments → the active Web App), no quotes/space |

> **Version alignment:** CI uses clasp **3.3.0**; log in with a 3.x clasp so the
> `~/.clasprc.json` format matches. Refresh: re-run `clasp login`, re-copy into
> `CLASPRC_JSON`.

### ⚠️ Confirm the manifest before the first deploy

`clasp push -f` overwrites the project's `appsscript.json` with the committed one
(`webapp.access: ANYONE_ANONYMOUS`, `executeAs: USER_DEPLOYING`, V8,
Asia/Jerusalem). Because THREE apps consume this backend, a wrong manifest is
especially risky — if the live project differs, run `clasp pull` locally and
commit the real manifest first. Flipping access off "Anyone" breaks every
consumer.

## Occupancy snapshots

The `OccupancySnapshots` sheet is a **permanent, append-only** monthly occupancy
record per house (see `CHANGELOG-occupancy-snapshots.md`). Code deploys with the
rest of `apps-script/**`, but two things must be run **once, by hand, from the
Apps Script editor** after that deploy lands — a web request can never trigger
them (`handle_` does not route to either).

Open the script project (`clasp open`, or the Script ID in `.clasp.json`), pick
the function in the **Run** dropdown, press Run, and read the **Execution log**.

### 1. Install the monthly trigger

```
installOccupancySnapshotTrigger
```

Installs exactly one time-driven trigger: `runMonthlyOccupancySnapshot` on **day
1 of each month, 03:00–04:00** (project timezone **Asia/Jerusalem**), which
snapshots the **previous** month.

**Idempotent** — it deletes every existing trigger bound to
`runMonthlyOccupancySnapshot` before creating the new one, so running it twice
leaves one trigger, not two. Triggers belonging to other jobs (e.g. the ~02:30
`nightlyIntegrityJob`) are never touched. Verify afterwards under **Triggers** in
the editor sidebar: one row for `runMonthlyOccupancySnapshot`.

> The first run asks for authorization (the trigger scope). Approve it with the
> same Google account that owns the deployment.

### 2. Backfill the history

Dry run first — it writes **nothing** and logs, per month, what it would write:

```
previewOccupancySnapshotsNow
```

Then the real backfill (`2026-05` → the last finished month):

```
backfillOccupancySnapshotsNow
```

**Idempotent** — a `month` + `houseId` row that already exists is skipped, so a
second run appends 0 rows. Rows are never overwritten and never deleted; the
running month is always refused (`month_not_finished`). Safe to re-run at any
time, including after a later month has already been captured by the trigger.

Expect one log line per month plus a `TOTAL` line, e.g.
`[occupancy-snapshot] 2026-06: appended 5 row(s), skipped 0`.

### 3. Check the feed

```
<the /exec URL>?action=occupancySnapshots
```

Returns `{ ok: true, rows: [...] }`, sorted by month then houseId. Read-only,
**same access model as `managersOverview`** — no new secret, no Script Property
to set, no financial data.

## Payments sheet — coverage-period columns

The `Payments` sheet gained two APPENDED columns, `coverageStart` and
`coverageEnd` (positions 11 and 12), recording the period a payment covers.
Rules: `CHANGELOG-payment-coverage-period.md`.

**No manual step is needed.** `getOrCreateSheet_` backfills the header and
force-formats the two columns to plain text (`'@'`) on the first read after
deploy, and blank cells are legal — a row without them reads as the inferred
billing cycle, exactly as before. Nothing is written to existing rows.

One thing to **not** do: never insert or reorder a Payments column.
`readSheet_` maps by position, so a shift re-reads every historical row
against the wrong field. New columns go at the end.

## Payments sheet — payment-report columns and the Funders tab (October 4, 2026)

The `Payments` sheet gains eleven APPENDED columns (positions 25–35):
`receivedDate`, `method`, `payer`, `funder`, `reference`, `recordedBy`,
`recordedAt`, `confirmStatus`, `confirmedBy`, `confirmedAt`, `flagNote`.
Rules: `CHANGELOG-payment-report-foundation.md`.

**No manual step is needed for Payments.** The header is added and the eleven
columns are text-formatted on the first read after deploy; existing rows stay
blank and read exactly as before. Before merging, glance at the Payments tab:
if there is a hand-added column in column 25 or later, tell Claude — the
report columns are then left untouched (the server logs
`[payments] report columns not used — header clash`) until it is moved.

**Optional — the Funders tab.** In the Apps Script editor pick
`setupFundersSheetNow` → **Run**. It creates the `Funders` tab
(`patientId`, `funder`, `effectiveFrom`, `setBy`, `setAt`). Safe to run again.
Until a row exists for a patient, the patient counts as **פרטי** and is listed
in «ייצוא רשימת תיקונים» → «חסר גורם מממן». A change of funder is a **new
row** with a later `effectiveFrom` — never edit or delete a row.

## Payments — the «דווח תשלום» form (October 4, 2026)

`CHANGELOG-payment-report-form.md`. **No manual step.** Column 36,
`legacyAmountPaid`, is added to `Payments` on the first read after deploy.
The `Funders` tab is created by the first funder save if it does not exist
yet. If column 36 (or 25–35) of `Payments` holds a hand-added header, every
report is refused (`sheet_header_clash`) and nothing is written until it is
moved.

**08/10/2026 — `CHANGELOG-payment-report-persistence.md`:** no manual step.
One column, `submissionId` (the report's idempotency key), is APPENDED at
the end of `Payments` (after `controlNote`) and writes its own header name on
the first read or report after the clasp deploy. If a hand-added header sits
in that position, reports are refused (`sheet_header_clash`) until it is
moved. SW `CACHE_VERSION` v47 → **v48**.

**08/10/2026 — `CHANGELOG-write-path-hardening.md` (PR A, money):** no
manual step. One column, `submissionId` (the funder form's idempotency key),
is APPENDED at the end of `Funders` (after `setAt`) and writes its own header
on the first funder save after the clasp deploy. If a hand-added header sits
in that position, funder saves keep working without the key (the old
behaviour, a console warning). SW `CACHE_VERSION` v49 → **v50**.

**08/10/2026 — `CHANGELOG-write-path-hardening.md` (PR B, patients):** no
manual step and no column. `saveAll` gains an optional `prove` parameter
(answered with `proven`). Railway and the clasp deploy both run on merge; in
the minute between them an admission may report «השמירה לא אושרה» while the
older Apps Script answers without `proven` — retrying from the same form is
safe (same id, no duplicate). SW `CACHE_VERSION` v50 → **v51**.

**08/10/2026 — `CHANGELOG-write-path-hardening.md` (PR C, leads):** no
manual step and no column. The meeting-report idempotency keys live in the
Apps Script script cache (6 h, the saved answer only — no report text). SW
`CACHE_VERSION` v51 → **v52**.

**08/10/2026 — `CHANGELOG-write-path-hardening.md` (PR D):** Railway only, no
manual step. SW `CACHE_VERSION` v52 → **v53**.

**09/10/2026 — `CHANGELOG-meetings-board-fixes.md`:** no manual step and no
column. Railway (`app.js`, `sw.js`) + Code.gs (`getData_` sends `visitDate` as
`YYYY-MM-DD`, read path only) — clasp CI deploys on merge; either order is
safe. SW `CACHE_VERSION` v53 → **v54**.

**09/10/2026 — `CHANGELOG-meetings-board-rerender.md`:** Railway only
(`app.js`, `sw.js`), no manual step, no column, Code.gs not touched. SW
`CACHE_VERSION` v54 → **v55**.

**09/10/2026 — `CHANGELOG-visit-date-guard.md`:** no manual step, no column.
Railway (`app.js`, `style.css`, `sw.js`) + Code.gs (`saveAll_` refuses a
changed lead visitDate / entryDate outside [2024, this year + 2] with
`error: 'bad_lead_date'`) — clasp CI deploys on merge. Either order is safe:
the old page never sends such a date once the user finishes typing, and the
new page never sends one at all. Damaged rows are only flagged, never
rewritten. SW `CACHE_VERSION` v55 → **v56**.

**09/10/2026 — `CHANGELOG-inclusive-coordinator-wording.md`:** Railway only
(`index.html`, `sw.js`), no manual step, no column, Code.gs not touched. One
UI string: «ע״י הרכזות» → «ע״י הרכזים». SW `CACHE_VERSION` v56 → **v57**.

**10/10/2026 — `CHANGELOG-inclusive-role-wording.md`:** no manual step, no
column. Code.gs (the coordinators feed stamps new `updatedBy` values as
«רכזים · …»; old rows keep «רכזות · …», nothing is rewritten) — clasp CI
deploys on merge. Railway (`app.js`, `meeting-report.html`, `sw.js`):
house-manager labels in slash form. Either order is safe. SW
`CACHE_VERSION` v57 → **v58**.

## «בקרת גבייה» — Ortal's tab (October 4, 2026)

`CHANGELOG-billing-control-tab.md`. **No env var, no Script Property, no
column.** One step for Sandra after the merge: «קוד אישי חדש» → אורטל →
paste the line into `USER_PIN_HASHES` in Railway (same as the other codes).
Until that line exists Ortal is simply not on the login screen.

**06/10/2026 — `CHANGELOG-ortal-billing-access.md`:** nothing to set. The
clasp CI deploys Code.gs. The two appended `Payments` columns
(`confirmedAmount`, `controlNote`) write their own header names on the first
decision. If a hand-added column sits where they belong, decisions are
refused (`sheet_header_clash`) until it is moved.

**22/10/2026 — `CHANGELOG-ortal-billing-discounts.md` (accountant role):**
no new env var — the existing personal PINs are extended (there is **no
`ORTAL_PIN`**). One Railway step for Sandra: in `USER_PIN_HASHES`, add
`"accountant"` to Ortal's record so her roles read
`["controller","accountant"]` (same `hash`, same `pinVersion`; the server
restarts on save). Until then «לא שולם — בטל תביעה» and «הנחה» are refused for
her (fail-closed). The clasp CI deploys Code.gs; the four appended
`BillingOverrides` columns (`discountAmount`, `discountReason`, `discountBy`,
`discountAt`) write their header names on the first discount. If a
hand-added column sits where they belong, discounts are refused
(`sheet_header_clash`) until it is moved.

## Accounting source feed — one Script Property to set

The Dashboard Apps Script gained two READ-ONLY actions for the external
accounting-control app: `accountingPayments` and `accountingCredits`. Full
contract, example request/response, errors and retry policy:
`CHANGELOG-accounting-source-feed.md`.

**One manual step after deploy.** In the Apps Script editor →
**Project Settings → Script Properties**, add:

| Property | Value |
|---|---|
| `ACCOUNTING_SECRET` | a freshly generated random string |

It is a **separate** secret from `ADMITTED_ROSTER_SECRET` and
`MEETING_REPORT_SECRET`, so it unlocks nothing else and can be rotated on its
own. Until it is set the endpoint refuses every request (**fail-closed**) —
which is the safe default, not a bug.

Check the feed:

```
curl -sS -L -X POST "<the /exec URL>" \
  -H 'Content-Type: application/json' \
  -d '{"action":"accountingPayments","secret":"<ACCOUNTING_SECRET>","limit":5}'
```

`-L` matters: `/exec` answers with a redirect. Expect
`{ "ok": true, "sourceApp": "ezone-dashboard", "schemaVersion": 1, ... }`.
Without the secret you should get `{"ok":false,"error":"unauthorized"}` — verify
that too. Offline equivalent, no deployment needed: `npm run smoke:accounting`.

### Payments / Credits sheets — the appended identity columns

`Payments` gained `paymentUid`, `patientUid`, `payerUid`, `chargedAt`,
`chargedBy`, `sourceUpdatedAt`, `sourceVersion` (positions 13–19); `Credits`
gained `creditUid` (position 25). A new `PaymentsTombstones` sheet is created
lazily, only if a payment row is ever deleted.

**No manual step is needed.** `getOrCreateSheet_` backfills the headers and
force-formats the text columns on the first read after deploy. The first
dashboard load (or the first authenticated feed call) mints every uid under the
script lock, **up to 1000 cells per call** so a big Payments sheet cannot time
the read out; it converges over the next few reads and then performs zero
writes forever. `accountingPayments` reports `identityPending` — tell the
accounting app to wait for it to reach 0 before its first full sync. Blank cells are legal and
are what every historical row carries — nothing is rewritten, and **no charge
stamp is ever invented for a historical row**.

Same rule as always: never insert or reorder a Payments or Credits column.

## Coordinators roster — one Script Property to set (October 4, 2026)

Two actions for the **ezone-coordinators** app: `getPatientsForCoordinators`
(read-only feed) and `recordDischargeFromCoordinators` (a coordinator's
discharge, written back immediately). Full contract: `CHANGELOG-coordinators-roster.md`.

Since B0 (`CHANGELOG-coordinators-discharge-own-house.md`, October 27, 2026) the discharge
write also requires the caller's verified `actor` + `house` (sent by ezone-coordinators ≥ #337)
and refuses a patient outside that house. Nothing new to set — the same secret, no Railway variable.

**Steps:**

1. **Generate a secret** on your own computer: `openssl rand -hex 32`.
2. **Apps Script editor → Project Settings → Script Properties**, add:

   | Property | Value |
   |---|---|
   | `COORDINATORS_PATIENTS_SECRET` | the string from step 1 |

   Its **own** secret — do not reuse `ADMITTED_ROSTER_SECRET`,
   `ACCOUNTING_SECRET`, `MEETING_REPORT_SECRET` or `PROXY_SECRET`. Until it is
   set both actions refuse every request (**fail-closed**) — the safe default.
3. **Merge the PR.** The Apps Script deploys automatically (the clasp workflow
   runs on a push to `claude/build-ezone-dashboard-QOg5s` that touches
   `apps-script/**`). Railway redeploys the Dashboard UI. Nothing to set on
   Railway.
4. **Give the coordinators app** the Dashboard `/exec` URL and the secret
   (server-side only — never in browser code). It sends `secret` in the POST
   body.
5. **Check it:**

   ```
   curl -sS -L -X POST "<the /exec URL>" \
     -H 'Content-Type: application/json' \
     -d '{"action":"getPatientsForCoordinators","secret":"<COORDINATORS_PATIENTS_SECRET>"}'
   ```

   Expect `{"ok":true,"patients":[{"id":…,"name":…,"house":…,"active":…,"admissionDate":…,"dischargeDate":…}]}`.
   Without the secret: `{"ok":false,"error":"unauthorized"}` — verify that too.
   Do **not** test the discharge on a real patient.

The discharged-audit sheet (`מטופלים משוחררים`) gains four columns at the END
(`dischargeSource`, `dischargedBy`, `dischargeReason`, `patientId`); they are
added automatically on the first read. Never insert or reorder a column there.

## Missing-patient diagnostic (read-only)

`diagnoseRamotPatientsNow()` is an editor-run diagnostic for the
missing-ramot-patient investigation. It is **read-only**: it takes no lock and
sets no property, it never creates or formats a tab, and it is not reachable
over HTTP. There is nothing to set up. After the deploy lands, run it from the
Apps Script editor: pick `diagnoseRamotPatientsNow` → **Run** → **View →
Executions log**. Besides the ramot sections, section (e) lists — for ANY
house — every Patients / PatientsTombstones row whose house no Dashboard tab
can show, and every permanent delete (✕) recorded in the last 60 days. What
each log section means and how to read it:
`CHANGELOG-ramot-diagnostic-reland.md`.

## Direct patients without a lead — editor backfill (DRY RUN by default)

`migrateDirectPatientLeadsNow()` (CHANGELOG-direct-lead-backfill.md) is editor-only. It has no trigger
and is not reachable over HTTP.

1. Pick `migrateDirectPatientLeadsNow` → **Run** → **View → Executions log**. This is the dry run: it
   writes nothing. It lists every `direct_admin` patient without a valid lead, with the entry date, the
   house and the phone that would be used.
2. After reading that list, pick `migrateDirectPatientLeadsApplyNow` → **Run**. This is the same
   function with `dryRun = false`.

The real run:
- takes the script lock;
- writes one `dl-<patient id>` «פנייה ישירה» lead per patient (`created` = the patient's entry date)
  and then that patient's `fromLead` cell;
- logs one AuditLog entry `direct_lead_backfilled` per patient.

A second run finds nothing to do.

## Stale cycle amounts — editor repair (DRY RUN by default)

`repairStaleCycleAmountsNow()` (CHANGELOG-cycle-balance.md) is editor-only:
no trigger, not reachable over HTTP. Run it with **no argument** first. It
logs the plan («row N name date: amount A → B …») and writes nothing: pick
`repairStaleCycleAmountsNow` → **Run** → **View → Executions log**. Only after
reading the plan, apply it from the editor console with
`repairStaleCycleAmountsNow(true)`. It takes the script lock, re-checks each
row, writes `amount` / `balance` / `status` only, and logs one AuditLog
`cycle_amount_repaired` per row. The display does not depend on it: the page
and `debtAging_` already read every open cycle at the agreed price.
Under-stamped settled cycles (paid in full at a stamp below the agreed price)
are never written by it. The dry run lists them apart as «NEEDS HUMAN
DECISION»; the same rows show read-only in בקרת גבייה as «שולם מתחת למחיר».

## Proxy secret (Phase 0b-1, TRANSITION mode) — Sandra's steps

From this release the Railway server sends a shared secret, `PROXY_SECRET`, on
**every** call to the Dashboard Apps Script. It travels in the request body only
— never in a URL, a log line or an error message. The Apps Script checks it.

In this phase the check is in **log mode**: a request without the secret
(today: Managers and Therapists, which call the same `/exec`) is **still
served**, and one row per action per hour goes into a new tab, `SecurityLog`. Nothing is blocked yet. Blocking (`enforce`) comes in a later
phase, only after Managers and Therapists have been given the secret.

> **Order matters.** The new `server.js` **refuses to proxy** when
> `PROXY_SECRET` is missing (fail-closed): the dashboard would show no data.
> So set the Railway variable (step 2) **before** this PR is merged.

### Step 1 — Generate the secret (once, on your own computer)

Open a terminal and run **one** of these:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

```bash
openssl rand -hex 32
```

Copy the line it prints (43 or 64 characters). That is the secret.

- Do **not** paste it into WhatsApp, email, a ticket, a GitHub comment or a
  chat with Claude. Keep it only in the two places below (and your password
  manager, if you use one).
- Do **not** reuse `SESSION_SECRET`, `ACCOUNTING_SECRET`,
  `MEETING_REPORT_SECRET` or any other existing secret. This one is new.

### Step 2 — Railway (before merging the PR)

1. Railway → the **E-Zone Dashboard** project → the web service →
   **Variables** tab.
2. **New Variable** → name `PROXY_SECRET`, value = the secret from step 1.
   No quotes, no spaces, no newline at the end.
3. Save. Railway redeploys the *current* code, which simply ignores the new
   variable — nothing changes for users yet.

### Step 3 — Apps Script (before or after merging — either is safe)

1. Open the Apps Script project (Script ID in `.clasp.json`, or `clasp open`).
2. ⚙️ **Project Settings** (left sidebar) → scroll to **Script Properties** →
   **Edit script properties** → **Add script property**:

   | Property | Value |
   |---|---|
   | `PROXY_SECRET` | the **same** secret as in Railway, character for character |
   | `PROXY_SECRET_MODE` | `log` |

3. **Save script properties**.

`PROXY_SECRET_MODE` may also be left out: unset means `log`. Any value other
than `log` (or empty) is treated as `enforce` — a typo fails **closed**, so type
exactly `log`.

### Step 4 — Merge the PR

Railway deploys the new `server.js`; GitHub Actions (clasp) deploys the new
`Code.gs` to the same `/exec` URL. Either may land first; both orders are safe:

| Lands first | What happens in between |
|---|---|
| new `server.js` | the old `Code.gs` ignores the extra fields; everything works |
| new `Code.gs` | the old server sends no secret → served + logged in `SecurityLog` |

### Step 5 — Check it (about 5 minutes after both deploys)

1. Open the dashboard, enter the PIN, open a house, open Payments. Everything
   loads as before.
2. In the spreadsheet, the `SecurityLog` tab appears **only** when something
   called without the secret. Rows with `callerType` = `no_secret` for actions
   like `managersOverview` / `managersHouse` / `occupancySnapshots` are
   Managers and Therapists — expected in this phase.
3. A row for `getData`, `saveAll`, `savePayment` etc. **from the dashboard
   itself** with `bad_secret` means the two values differ: copy the secret
   again into both places (step 2 + step 3).
4. Railway → **Deployments → logs** must **not** show
   `[config] PROXY_SECRET is not set`. If it does, step 2 was missed: add the
   variable and Railway redeploys.

### Step 6 — After a few days: who calls without the secret?

In the Apps Script editor pick **`securityCallersReportNow`** → **Run** →
**Execution log**. It is read-only (writes nothing: no cell, tab, lock or
property). It lists, for the last 7 days, each `action · callerType · hours ·
GET/POST · first/last seen`. `hours` = in how many distinct hours that action
was called without a valid secret. Send this list (it contains no names, no
data and no secret) — it is what we need to plan the Managers / Therapists
change before `enforce`.

### Do NOT do yet

- Do **not** set `PROXY_SECRET_MODE` to `enforce`. Managers and Therapists
  would stop working. That switch is a later phase.

### Rollback / emergency

- Something breaks after the merge and the Railway log says `PROXY_SECRET is
  not set` → add the Railway variable (step 2).
- `enforce` was set by mistake → change `PROXY_SECRET_MODE` back to `log` in
  Script Properties. It takes effect on the next request; no deploy needed.

### Rotating the secret later

1. Generate a new one (step 1).
2. Set it in Apps Script first (with `PROXY_SECRET_MODE` = `log`), then in
   Railway. Between the two, dashboard requests are served and logged as
   `bad_secret` — not blocked.
3. In `enforce` mode, switch to `log` before rotating and back afterwards.

## Railway variables — the login and the healthcheck (October 4, 2026)

The dashboard login is **personal codes only** (personal PINs PR C,
`CHANGELOG-personal-pins-cleanup.md`). The variables, on the Railway web
service:

| Variable | Required | What it is |
|---|---|---|
| `SESSION_SECRET` | yes | signs the session cookie. Unset → every data route answers 503 (fail-closed). |
| `PROXY_SECRET` | yes | the Apps Script proxy secret (see "Proxy secret" below). |
| `USER_PIN_HASHES` | yes | the personal-code records (JSON, one per user). A bad value **stops the server from starting**. Made with «קוד אישי חדש». |
| `PIN_PEPPER` | yes | mixed into every code hash. **Never change it** — every personal code would stop working. |
| `HEALTHCHECK_TOKEN` | for the weekly healthcheck | at least 32 characters. Opens only the read-only `GET /api/healthcheck`. The same value is the GitHub Actions secret `HEALTHCHECK_TOKEN`. Unset → that route answers 404 and the weekly check fails. |
| `TRUST_PROXY_HOPS` | no | escape hatch, default 1 (Railway's one hop). |
| `BOOTSTRAP_TOKEN` | no — delete it | one-time setup of Sandra's own record. Closed for good once her record exists; the log warns while it is set. |
| ~~`APP_PIN`~~, ~~`APP_PIN_UNTIL`~~ | **removed** | the old shared code and its window. Ignored if still set (one warning in the log). Delete them. |

## Patient missing from a house tab — nothing new to set (October 26, 2026)

`CHANGELOG-patient-missing-from-house.md`. No new Railway variable, Script Property, sheet or
column. Code.gs deploys automatically on merge (clasp CI). After that, run
**`patientsMissingFromHousesReportNow`** once from the Apps Script editor. It is read-only on the
spreadsheet, creates one private Google Doc and logs only counts and the URL. For each listed
row: «מטופלים» → ✏️ → pick the right house (or «שחרר» straight from «מטופלים»). Rows marked
«יתוקן בשמירה הבאה» heal on their own with the next save.

## Discharged → Outpatient + missing report — nothing new to set (October 26, 2026)

`CHANGELOG-discharge-outpatient-handoff.md`. Discharge sends and «העבר לאמבולטורי» go through
`/api/outpatient-lead` with the same Railway `OUTPATIENT_LEAD_URL` / `OUTPATIENT_LEAD_SECRET`.
No new variable, Script Property, sheet or column. After the automatic Code.gs deploy, run
**`outpatientMissingReportNow`** once from the Apps Script editor. It creates a private Google
Doc and logs its URL. Then use «העבר לאמבולטורי» for each row it lists.

## «אמבולטורי» → Outpatient — nothing new to set (October 26, 2026)

`CHANGELOG-meeting-with-ambulatory.md`. Choosing «אמבולטורי» in «נפגש עם» sends the lead to
Outpatient through the SAME Railway variables the discharge handoff already uses:
**`OUTPATIENT_LEAD_URL`** and **`OUTPATIENT_LEAD_SECRET`** (server.js `sendToOutpatient`). No new
Railway variable, Script Property, sheet or column. The send log is the hidden AuditLog
(`outpatient_lead_sent` / `outpatient_lead_send_failed`). If either variable is unset, the meeting
still saves and Vered sees «הפגישה נשמרה, אך שליחת הליד לאמבולטורי נכשלה — לא נשלח»; the next
save retries. Code.gs deploys automatically on merge.

## Expected discharges on the dashboard — nothing to set (October 15, 2026)

`expectedDischarges` (CHANGELOG-dashboard-expected-discharges.md) is a READ-ONLY Apps Script
action behind the «שחרורים צפויים» card. It reuses `PROXY_SECRET` and the existing
`ManagersExpectedDischarge` sheet: **no new Script Property, Railway variable or sheet**. Code.gs
deploys automatically on merge; until it has, the card shows «לא ניתן לטעון את השחרורים
הצפויים כרגע» (the old Code.gs does not know the action) and nothing else on the page changes. Access (CHANGELOG-expected-discharges-all-users.md, CEO 15 Oct 2026): every user who can log
in — any personal session, Ortal's controller view included (the card sits on «בקרת גבייה»
there). No session → 401; nothing else changes. Still nothing to set.

## Coordinators committee feed — ONE Script Property (October 15, 2026)

`CHANGELOG-coordinators-committee-feed.md`. After the automatic Code.gs deploy, set the Script
Property **`COORDINATORS_COMMITTEES_SECRET`** (a new random value of 32+ characters). Put the same
value in the coordinators Apps Script as `DASHBOARD_COMMITTEES_SECRET`. Unset → the feed answers
`unauthorized` (fail-closed) and the coordinators show «לא סונכרן». No Railway variable.

**Diagnostics (CHANGELOG-committee-feed-diagnostics.md):** both sides are trimmed, so a value
pasted with a trailing space or newline still matches. An unset value here answers
`{ok:false, error:'unauthorized', reason:'not_configured'}`; the coordinators card then says
«הסוד לא הוגדר» instead of «הסוד לא תואם». Check from the coordinators editor:
`previewCommitteeSyncNow()`.

## Committees from the coordinators — TWO Script Properties (October 20, 2026)

`CHANGELOG-committees-from-coordinators.md`. From now on the coordinators set committees, and the
Managers app and the dashboard card «ועדות קרובות» only read them. This Apps Script reads the
coordinators' read-only action `getCommitteesForManagers`.

1. **Coordinators Apps Script** → Project Settings → Script Properties → add
   **`MANAGERS_READ_SECRET`** = a new random value of 32+ characters (the coordinators PR adds the
   action).
2. **This (Dashboard) Apps Script** → Project Settings → Script Properties → add:

   | Property | Value |
   |---|---|
   | `COORDINATORS_SHEETS_URL` | the coordinators Apps Script Web App URL (`https://script.google.com/macros/s/…/exec`, the same one the coordinators' Railway `SHEETS_URL` uses) |
   | `COORDINATORS_MANAGERS_SECRET` | the SAME value as the coordinators' `MANAGERS_READ_SECRET` |

Both values are trimmed. The `script.external_request` scope is already granted here
(`appsscript.json`; the dashboard already calls the staffing feed), so no new consent is needed.

Until the properties are set, Managers shows «הוועדות לא זמינות כרגע» and the dashboard card shows
«הוועדות לא זמינות כרגע — הנתון מאפליקציית הרכזים לא התקבל». Nothing else changes. Results are
cached for 5 minutes (a failure for 60 s), so a fix shows within a minute.

`managersWork` op `committeeSet` is refused (`committee_read_only`). The append-only
`ManagersCommittee` sheet is kept as history and is never written again. No Railway variable.

**One-time import** (after the coordinators deploy): the coordinators editor-run
`importManagersCommitteesNow` reads `getCommitteesForCoordinators` with `range:'future'` (added
here) to copy the managers' future committee dates into the coordinators' sheet.

## Alumni feed `getDischargedRoster` — ONE Script Property (October 18, 2026)

`CHANGELOG-discharged-roster-endpoint.md`. READ-ONLY feed for the E-Zone Therapists app's alumni
(בוגרים) list. After the automatic Code.gs deploy, set the Script Property **`ALUMNI_SOURCE_SECRET`**
(a new random value of 32+ characters) — Apps Script editor → Project Settings → Script Properties.
Put the same value in the therapists Apps Script / server as `ALUMNI_SOURCE_SECRET`. Unset →
`{ok:false, error:'unauthorized'}` (fail-closed). No Railway variable. Returns
`{ sourceApp, name, phone, house, entryDate, exitDate }` only, for patients released in the last 730 days.

## «ועדות קרובות» card — nothing to set (October 15, 2026)

`CHANGELOG-dashboard-committees.md`. A read-only action `upcomingCommittees` reuses
`PROXY_SECRET` and the `ManagersCommittee` sheet. No Script Property, Railway variable or sheet.
Code.gs deploys automatically on merge.

## Committee date «ועדה» — nothing to set (October 15, 2026)

`CHANGELOG-managers-committee.md`. Code.gs deploys automatically on merge. The first save creates
the append-only sheet `ManagersCommittee`. No Script Property, Railway variable or editor run.
Merge before the paired Managers PR.

## Expected discharge clear / «אין צפי» — nothing to set (October 15, 2026)

`CHANGELOG-managers-discharge-clear.md`. Code.gs deploys automatically on merge. The
`ManagersExpectedDischarge` header gets `state` appended on the first write after deploy (append
only). No Script Property, Railway variable or editor run. Merge before the paired Managers PR.

## Managers expected-discharge save — one editor run (October 15, 2026)

`CHANGELOG-managers-discharge-save-fix.md`. Once, after the deploy, as the account that owns the
Web App deployment: Apps Script editor → function **`authorizeSheetsWriteNow`** → **Run** → in the
consent dialog tick **every** box (a partial grant makes writes fail while reads pass) → the
execution log must read `authorizeSheetsWriteNow: OK — all scopes granted; temp-sheet
write/read/delete passed; ManagersExpectedDischarge ready`. It touches only a temporary sheet
(deleted) and the existing append-only header. No Script Property or Railway variable changes.

## Discharged sheet `continuity` column — nothing to set (October 20, 2026)

Appended LAST to «מטופלים משוחררים» by `getOrCreateSheet_` on the first discharge
or `setDischargeContinuity` after the clasp deploy. Blank legacy cells read as
«לא ידוע». No Script Property, no trigger, no Railway change.
See `CHANGELOG-patient-retention-foundation.md`.

## Security

- Credentials live **only** in GitHub Secrets — never committed, never printed;
  the runner's `~/.clasprc.json` is deleted at job end (`if: always()`).
- `.clasprc.json` / `.clasp.local.json` are git-ignored. The Script ID in
  `.clasp.json` is an identifier, not a secret.
- `PROXY_SECRET` lives only in Railway **Variables** and Apps Script **Script
  Properties** — see "Proxy secret" above.

## Manual fallback

> ⛔ **Emergency use only — not the routine path.** As of the July 2026 clasp CI rollout (verified 22/07/2026, ecosystem-wide), Apps Script deploys are **automatic** on every merge to the deployed branch. Reach for this manual `clasp` fallback only when CI itself is down. The old **copy-paste-into-the-Apps-Script-editor** procedure is **OBSOLETE** — do not hand-paste `Code.gs`. See `EZONE-ECOSYSTEM-STATUS.md` → "Apps Script deployment".

```bash
npm i -g @google/clasp@3.3.0 && clasp login
clasp push -f
clasp deploy -i <DEPLOYMENT_ID> -d "manual deploy"
```


### CREATE_LEAD_SECRET (Dashboard Script Property)
Required for `createLeadFromTherapists` (alumnus → lead). Unset = the action refuses everything. Same value goes in the ezone-therapists Railway variable `CREATE_LEAD_SECRET`. Phone rule on this path: 10-digit mobile or 9-digit landline (`/^0[2-9]\d{7}$/`); refusals return `invalid_phone` / `invalid_name` and are logged as AuditLog `lead_handoff_refused` (see `CHANGELOG-landline-handoff.md`).

## Activity sheet (B1, October 27, 2026) — nothing to configure

`appendActivity_` and the `Activity` sheet definition ship inert (no caller). No Script Property,
no Railway variable. The sheet appears in the spreadsheet only once B2's first write runs. See
`CHANGELOG-crm-activity-foundation.md`.

## Activity events — turning the timeline on (B2, October 27, 2026)

Default is OFF: nothing is written until you set the switch.

1. Dashboard Sheet → Extensions → Apps Script → ⚙️ Project settings → Script properties → Add.
2. Property `ACTIVITY_WRITES`, value `on` (exactly, lower-case) → Save.
3. Takes effect on the next request. To stop instantly: delete the property.

Nothing to set on Railway. Rows appear in a new `Activity` tab on the next mapped write (a discharge,
a payment report …). See `CHANGELOG-crm-activity-system-events.md`.

## CRM shell flag (C1, October 27, 2026) — off until you set it

`/?view=crm` serves the new CRM shell only when the Railway variable `CRM_ENABLED` is exactly `true`
and the user has a personal login. Until then nothing changes anywhere.

1. https://railway.app → project `zucchini-hope` → service `web` → Variables → New Variable.
2. Name `CRM_ENABLED`, value `true` → Add → Deploy (variables apply to the next deployment).
3. Open https://ezone-dashboard.up.railway.app/?view=crm with a personal login.
Rollback: delete the variable and redeploy. See `CHANGELOG-crm-shell-flag.md`.
