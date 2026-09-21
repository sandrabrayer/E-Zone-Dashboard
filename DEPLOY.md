# Deploy — E-ZONE Dashboard (shared Apps Script backend)

This repo owns the deploy for the **"ezone dashboard" Apps Script**, which serves
three consumers (per `EZONE-ECOSYSTEM-STATUS.md`): Dashboard (`SHEETS_URL`),
Managers (`APPS_SCRIPT_URL`), Therapists (`DASHBOARD_SHEETS_URL`). `ezone-managers`
only reads this backend — it has no deploy workflow, so the two repos never fight
over the same project.

Two independent deploy paths:

| Layer | Runs it | Trigger |
| --- | --- | --- |
| **Node/Express + frontend** | Railway | Auto-deploys the connected branch (`claude/build-ezone-dashboard-QOg5s`). |
| **Apps Script backend** (`apps-script/**`) | GitHub Actions → clasp | Push to `claude/build-ezone-dashboard-QOg5s` touching `apps-script/**`. |

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

## Security

- Credentials live **only** in GitHub Secrets — never committed, never printed;
  the runner's `~/.clasprc.json` is deleted at job end (`if: always()`).
- `.clasprc.json` / `.clasp.local.json` are git-ignored. The Script ID in
  `.clasp.json` is an identifier, not a secret.

## Manual fallback

> ⛔ **Emergency use only — not the routine path.** As of the July 2026 clasp CI rollout (verified 22/07/2026, ecosystem-wide), Apps Script deploys are **automatic** on every merge to the deployed branch. Reach for this manual `clasp` fallback only when CI itself is down. The old **copy-paste-into-the-Apps-Script-editor** procedure is **OBSOLETE** — do not hand-paste `Code.gs`. See `EZONE-ECOSYSTEM-STATUS.md` → "Apps Script deployment".

```bash
npm i -g @google/clasp@3.3.0 && clasp login
clasp push -f
clasp deploy -i <DEPLOYMENT_ID> -d "manual deploy"
```
