# Lead Contact Fields — Foundation

**Foundation only. ZERO user-facing change. No UI in this PR — the UI arrives in the next PR.**

Adds the schema plumbing for referrer-contact fields and a billing/updates phone
so a later PR can render and edit them. The fields flow through save/load
untouched; nothing new is displayed or persisted by user action yet.

## Context
A lead's existing `name` + `phone` **remain** and now semantically mean the
**patient** (פרטי המטופל). Four new columns carry:

| column | meaning |
| --- | --- |
| `contactName` | referrer's name (פרטי הפונה) |
| `contactPhone` | referrer's phone |
| `contactRelation` | referrer's relation to the patient |
| `billingPhone` | phone for billing + updates (טלפון לגבייה ועדכונים) |

## What changed

### Backend — `apps-script/Code.gs`
- Appended `contactName`, `contactPhone`, `contactRelation`, `billingPhone` to
  the **end** of `LEAD_COLUMNS`, in that exact order (append-only — nothing
  above reordered or inserted). `readSheet_` maps cells to keys by position, so
  append-last keeps existing reads correct.
- **No new column-handling code needed:** `getOrCreateSheet_` already extends the
  header row non-destructively when the schema grows, exactly as it did for
  `meetingWith` / `meetingOutcome`. Pre-existing rows stay blank —
  `objectToRow_` defaults missing keys to `''`, no backfill runs.
- **Derived schemas inherit automatically:** `IRRELEVANT_LEAD_COLUMNS` and
  `REMOVED_LEAD_COLUMNS` are `LEAD_COLUMNS.concat([...extras])`, so the four new
  columns flow into them with no change — leads moved to the שימור/removed sheets
  do not silently drop the new fields.
- No new endpoints, no behavior change.

### Frontend — `public/app.js`
- Added the four fields to `normalizeLead` via the same `pickField` defensive
  pattern as the other fields (each with Hebrew/English aliases; default `''`),
  preventing a silent drop on the `getData` round-trip.
- `normalizeIrrelevantLead` / `normalizeRemovedLead` build on
  `base = normalizeLead(l)` and only add their own metadata — they do not
  re-enumerate base lead fields, so the four contact fields flow through them
  automatically (verified by tests). No changes needed there.
- **No UI.** No rendering changes. The fields are schema-only pass-through.

## Tests — `test/lead-contact-fields-foundation.test.js`
Uses the existing `node:test` + vm-sandbox pattern (not Jest):
- `LEAD_COLUMNS` ends with the four fields in the specified order, immediately
  after `meetingOutcome`, each exactly once.
- The derived `IRRELEVANT_LEAD_COLUMNS` / `REMOVED_LEAD_COLUMNS` carry the four
  fields.
- `normalizeLead` preserves all four when present, defaults each to `''` when
  absent, and does not silently drop them on a round-trip.
- `normalizeIrrelevantLead` / `normalizeRemovedLead` carry the four fields.

**Existing test updated:** `test/meeting-outcome-foundation.test.js` asserted
`meetingOutcome` was the *terminal* column. That snapshot assertion is inherent
to append-only growth (the same situation the `meetingWith` test hit); it was
changed to assert `meetingOutcome`'s position *relative to* `meetingWith`
(appended immediately after it, exactly once) instead. Its real contract is
unchanged.

Full suite: `npm test` — **299 passed, 0 failed** (292 prior + 7 new), zero
regressions.

## Deploy
- `Code.gs` changes deploy via the clasp CI on merge
  (deployment ID `AKfycbx85qRq2lA_tenySLTLc6JoZHQA1zQYEdj4cesniPHcPQfY4SQ27-F-G_6bf08gsHw`).
  No manual Apps Script steps.
- **Post-merge verification:** live app → DevTools → Network →
  `sheets?action=getData` → lead objects contain `contactName`, `contactPhone`,
  `contactRelation`, `billingPhone` (blank on pre-existing leads).
