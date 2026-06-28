# Discharge enhancements (PR 2 of 3)

Extends the patient שחרור (discharge) flow with a third disposition and an
optional discharge date. Frontend-only — no `Code.gs` change, no Apps Script
redeploy (both new data points map to existing persisted columns).

## What it does

- **Third disposition** `released_outpatient` → **משוחרר לטיפול חוץ**, registered
  in `DISPOSITION_LABELS`. The שחרור modal now offers all three options:
  סיים טיפול / הפסיק לפני הזמן / משוחרר לטיפול חוץ.
- **Optional discharge date** — a native `<input type="date">` (label
  **תאריך שחרור**, Hebrew RTL, opens the OS picker). Starts empty, never
  required for any disposition. When provided it's persisted as the patient's
  `exitDate`; when empty it falls back to today (unchanged prior behavior).
- **Discharged tab** now shows the user-chosen date: the "תאריך שחרור" row
  displays `exitDate`, falling back to `dischargedAt` (the action timestamp) for
  rows recorded before this field existed.

## Locked design decisions

- New disposition key `released_outpatient` → label `משוחרר לטיפול חוץ`. Stable
  key persists to the `disposition` column; the Hebrew label is render-time only.
- The discharge date is **optional** and **starts empty** for every disposition.
- The chosen date is persisted to the existing **`exitDate`** column
  (empty → `todayISO()`); `dischargedAt` stays the immutable action timestamp.
- The discharged tab's "תאריך שחרור" row displays `exitDate` with fallback to
  `dischargedAt`.
- **No cross-app Outpatient write.** `משוחרר לטיפול חוץ` only records the
  disposition + date for now. Outpatient lead creation is **PR 3** — not built
  or stubbed here (a regression test asserts no Outpatient fields leak into the
  audit row).

## Why this is frontend-only (no dual deploy)

- `disposition` is already a persisted column on the discharged sheet and the
  backend (`dischargePatient_`) writes any string value — a new key needs no
  schema change.
- `exitDate` is already part of `PATIENT_COLUMNS` and therefore
  `DISCHARGED_PATIENT_COLUMNS`; the backend spreads `...patient`, so the chosen
  date persists with no new column and no Apps Script change.

## Implementation notes

- `showCloseLeadModal` gains an optional `dateField = { name, label }`. When
  present it renders the date row and adds the value to the `onConfirm` payload
  under `name`. Callers that omit it (e.g. `closeLead`) keep the exact
  `{ disposition, note }` payload and no date row — fully backward-compatible.
- `dischargeAuditRow(patient, { disposition, note, dischargeDate }, today)` is a
  pure helper (no DOM, no I/O) that resolves `exitDate` and builds the audit
  row, so the date/disposition logic is unit-tested directly.
- `dischargePatient` passes `DISCHARGE_DISPOSITIONS` (the single source of truth
  for the three keys) and the date field; the optimistic write, `saveAll`, and
  `dischargePatient` apiPost paths are otherwise unchanged.
- All rendered patient text continues to go through `escapeHtml`.

## Files

- `public/app.js`
  - `DISPOSITION_LABELS` += `released_outpatient`; new `DISCHARGE_DISPOSITIONS`.
  - `showCloseLeadModal` extended with the optional `dateField`.
  - New pure helper `dischargeAuditRow`; `dischargePatient` rewired to use it,
    the three dispositions, and the date field.
  - `renderDischargedPatients` "תאריך שחרור" row now prefers `exitDate`.
- `test/discharge-enhancements.test.js` — vm-sandbox suite (10 tests): the new
  key→label mapping, the three offered dispositions, date-present persistence
  (→ exitDate) and empty-date fallback (→ today) across all three dispositions,
  patient-field preservation, and a no-Outpatient-leak guard.
- `CHANGELOG-discharge-enhancements.md` — this file.

## Commits

- _(pending)_ feat(discharge): third disposition + optional discharge date
