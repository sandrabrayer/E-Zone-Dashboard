# Billing Override — Foundation

**Foundation only. ZERO user-facing change. No UI in this PR — the inline
per-month amount editor arrives in the next PR (`feature/billing-override-ui`).**

This change adds the storage + state plumbing for a per-patient, per-month
override of the monthly billing amount (סכום חודשי). One override per patient
per month; a later PR will let an editor set/clear it from the גבייה tab. The
overrides load into state on every `getData`; nothing reads or renders them yet,
and the patient's base `pay` is never touched.

## What changed

### Backend — `apps-script/Code.gs`
- **New internal sheet `BillingOverrides`** (`BILLING_OVERRIDES_SHEET`). Not a
  Hebrew-facing tab; it backs the future inline edit.
- **`BILLING_OVERRIDE_COLUMNS = ['id', 'patientId', 'month', 'amount', 'created']`.**
  `readSheet_` maps cells to keys by position, so this order is a contract.
  - `id` is deterministic — `ovr::<patientId>::<month>` (see `billingOverrideId_`),
    mirroring the `pay::…` payment-id idiom so re-writing a (patient, month) pair
    upserts into the same row instead of duplicating.
  - `month` is a `'YYYY-MM'` string.
- **Month + amount stored as plain text (`@`).** `getOrCreateSheet_` force-texts
  the whole `month` and `amount` columns at sheet-ensure time (same mechanism as
  the Leads `visitDate`/`visitTime` fix), and `upsertBillingOverride_` also sets
  those two cells to `@` on the target row **before** `setValues`. Sheets would
  otherwise coerce `"2026-08"` into a date and re-format the number — the known
  corruption class in this codebase.
- **`getData_` returns a new `billingOverrides` array** (alongside `leads`,
  `patients`, …).
- **New write action `upsertBillingOverride`** → `upsertBillingOverride_`: upsert
  by (patientId, month) using the per-row upsert pattern (deterministic id +
  `LockService`, no full-sheet write). Writing again for the same pair **replaces**
  the amount. Fails closed on missing `patientId`, a non-`YYYY-MM` `month`, or a
  negative / non-numeric `amount`.
- **New write action `deleteBillingOverride`** → `deleteBillingOverride_`: removes
  the override (restores the base amount) via the existing `deleteRowsById_`
  helper, keyed by id or by (patientId, month).
- No change to `server.js`: both new actions ride the generic session-gated
  `POST /api/sheets` proxy (fail-closed behind the `ezone_session` cookie), so
  they inherit the authenticated write path with no new surface.

### Frontend — `public/app.js`
- **`state.billingOverrides` = []** — populated in `loadAll` from
  `data.billingOverrides` (missing array on older deploys → empty). Rows without
  a `patientId`+`month` are dropped. State only — nothing renders it.
- **`normalizeBillingOverride`** — defensive `pickField` normalizer (same idiom
  as `normalizePayment`/`normalizeLead`): coerces `amount` to a number
  (default 0), clamps `month` to `'YYYY-MM'` via `slice(0, 7)` so no day
  precision leaks into the key, and rebuilds a missing `id` deterministically.
- **`billingOverrideId(patientId, month)`** — client twin of the server helper,
  byte-for-byte identical, so a client-built id targets the same row the server
  would compute.
- **No UI.** No rendering, no selectors, no billing-tab changes.

## Tests — `test/billing-override-foundation.test.js`
Uses the existing `node:test` + vm-sandbox pattern (fakeSheet mirrors
`visittime-text-columns-and-quarter-select.test.js`):
- `BILLING_OVERRIDE_COLUMNS` is exactly `[id, patientId, month, amount, created]`;
  sheet name is `BillingOverrides`.
- `billingOverrideId` matches between Code.gs and app.js.
- `upsertBillingOverride_`: appends for a new pair, **replaces** (no duplicate)
  for the same (patientId, month), keeps different months isolated, and
  text-formats month + amount **before** `setValues`.
- Validation: rejects missing `patientId`, non-`YYYY-MM` month, negative /
  non-numeric amount.
- `deleteBillingOverride_`: removes the matching row; needs id or (patientId+month).
- `normalizeBillingOverride`: preserves present values, coerces/defaults amount,
  clamps month to `YYYY-MM`, derives id when absent, survives a round-trip,
  tolerates junk input.
- `monthKey` formatting.

Full suite: `npm test` — 425 pass, zero regressions (+19 new; rebased onto the
deploy head after PRs #71–#76 with a clean auto-merge — the foundation's Code.gs
regions are disjoint from the id-backfill, diagnostics, and prior_status
changes).

## Deploy
- `Code.gs` changes deploy via the clasp CI on merge — no manual Apps Script
  steps (do NOT hand-paste).
- **Post-merge verification (Sandra):** open the live app → DevTools → Network →
  `sheets?action=getData` → confirm the response contains a `billingOverrides`
  array (empty until the first override is written). Verify on **both** consumers
  of this Apps Script backend — the **Dashboard** and the **ezone-managers**
  deployment — since they share the one backend.
