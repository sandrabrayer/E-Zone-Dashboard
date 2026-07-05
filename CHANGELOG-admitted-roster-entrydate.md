# Admitted roster — add `entryDate` (admission date)

## What changed
`getAdmittedRoster_` in `apps-script/Code.gs` now returns each admitted
patient's **admission/entry date** as a new `entryDate` field
(`'YYYY-MM-DD'`, or `''` when unknown), alongside the existing
`sourceApp`, `name`, `phone`, and `house`.

The value comes from the Patients sheet `date` column (labelled
"תאריך כניסה" in the dashboard UI — the same column the frontend and
billing-renewal logic treat as the entry date). It is normalized through
the existing `asISODate_` helper: Date-typed cells → `YYYY-MM-DD`, plain
`YYYY-MM-DD` strings pass through, blank/empty → `''`.

## Why
The outpatient app's **מסלול המשך** tab is already live; its tenure
badges show `—` because the roster endpoint did not expose an admission
date. Shipping `entryDate` lets those badges compute real tenure.

## Backward compatibility
Purely additive — no field was removed, renamed, or reordered. Every
existing key (`sourceApp`, `name`, `phone`, `house`) is unchanged, and
consumers that ignore `entryDate` are unaffected. The therapists app's
`/api/admitted` path consumes the same `getAdmittedRoster` action and
continues to work without changes. The no-leak projection is preserved:
raw sensitive columns (`pay`, `adv`, `notes`, `source`, `status`,
`fromLead`, `exitDate`, raw `date`, `id`) are still never exposed —
`entryDate` is a derived, non-sensitive value.

## Tests
`test/admitted-roster.test.js` (runs the real shipped function in a vm
sandbox) now asserts the roster exposes exactly the five keys including
`entryDate`, and covers all three conversion paths: string-cell
passthrough, Date-cell → `YYYY-MM-DD`, and blank → `''`. Full suite:
`npm test` → 101 passing.

## Manual redeploy reminder ⚠️
Apps Script does **not** auto-sync from GitHub. This ONE Apps Script
serves **Dashboard + Managers + Therapists**, so redeploy carefully:

1. Paste the updated `apps-script/Code.gs` into the Apps Script editor.
2. **Ctrl+S** (Save).
3. **Deploy → Manage deployments**.
4. Select the **EXISTING** deployment → pencil ✏️ (edit).
5. Version → **New version** → **Deploy**.

Keep access = **Anyone**. **Never** create a new deployment — a new
deployment changes the URL and breaks all three consumers.
