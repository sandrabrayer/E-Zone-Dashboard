# Visit date+time persistence fix

Sheets returns native `Date` objects for date/time-typed columns via `getValues()`, and `normalizeLead` was passing `visitDate` / `visitTime` / `entryDate` through raw — so on every reload the inputs received strings like `"2026-05-25T00:00:00.000Z"` (and `"1899-12-30T13:30:00.000Z"` for time cells) which `<input type="date">` and `<input type="time">` silently reject. Wrap with `isoDate` / `isoTime` in `normalizeLead`, mirroring the existing fix the codebase already had for the `created` field.

## Why this exists

Pre-existing bug. Vered reported it during Phase 2b verification — entering a date+time on a ביקור נקבע lead, saving, and seeing the inputs revert to empty placeholders (`dd/mm/yyyy` and `--:--`) after reload. The bug is unrelated to Phase 2b code (Phase 2b touched `markLeadIrrelevant`); these two findings just happened to surface in the same testing pass. The data was being saved to the sheet correctly the entire time — only the round-trip render was broken.

## Root cause

`apps-script/Code.gs:239` — `readSheet_` reads cell values with `sh.getRange(...).getValues()`, which returns native JS `Date` objects for any cell Sheets has type-formatted as Date or Time (time-only cells are anchored to `1899-12-30` UTC). After JSON transport those `Date`s arrive at the browser as full ISO timestamp strings. `public/app.js:601-603` — `normalizeLead` passes `visitDate` / `visitTime` / `entryDate` through `pickField` unchanged, with no coercion to the `YYYY-MM-DD` / `HH:MM` formats the native inputs require. The author had already solved the identical problem for `created` (see comment on app.js:605-610 and the `isoDate` wrap on line 611) but the same coercion was never applied to the visit/entry fields.

## Changed

**`public/app.js`** — frontend-only fix:

- New `isoTime(v)` helper added next to `isoDate` (around line 1882). Handles four input shapes: native `Date` object (epoch 1899-12-30 UTC), full ISO string, already-good `"HH:MM"` string, and empty / null / undefined. Returns `"HH:MM"` or `""`. Uses `getUTCHours` / `getUTCMinutes` (not local-timezone getters) — Sheets anchors time-only values in UTC, and local reads would shift the displayed time by the user's offset.
- `normalizeLead` (lines 601-603): three fields wrapped with their coercion helpers — `visitDate: isoDate(...)`, `visitTime: isoTime(...)`, `entryDate: isoDate(...)`.
- `normalizePatient` (line 648): `date` field wrapped with `isoDate(...)`. Audit-found — `patient.date` feeds the `תאריך כניסה` input at line 1574 (`<input type="date" value="${p.date || ''}">`), so it had the same silent-empty bug for any patient whose entry-date cell was stored as a typed Date in Sheets.

Audit-checked but not changed (display-only, never fed to a `<input type="date">` / `<input type="time">`): `normalizeIrrelevantLead.movedAt` (rendered via `formatDate()` at line 1030), `normalizeRemovedLead.removedAt` (rendered via `formatDate()` at line 1175), `normalizePatient.exitDate` (rendered via `formatDate()` at line 1677; the only exit-date input at line 1699 seeds from `todayISO()`, not stored data). `normalizePayment.dueDate` was already correctly wrapped.

## Not changed

- `apps-script/Code.gs` — the bug could also be fixed at source by switching `readSheet_` to `getDisplayValues()`, but that would change every column's read shape (numbers become locale-formatted strings, currency cells gain a `₪` prefix, etc.) and force a much wider audit. The client-side fix is smaller, surgical, and lives next to the existing `isoDate` pattern. No backend deploy needed.
- `public/style.css` — no styling impact.
- No data migration. The sheet is the source of truth and stays untouched.

## Safety

Read-only normalization. The fix lives entirely in the parse-on-load layer (`state.leads = rawLeads.map(normalizeLead)` and the equivalent for patients), which already runs on every fetch. Both legacy rows (where the sheet returns a `Date` object) and any future rows flow through the same normalizer, so existing data is now rendered correctly without rewriting it. New writes are unaffected — the client was already sending `"YYYY-MM-DD"` / `"HH:MM"` strings from the input's `.value`, which Sheets accepts cleanly.

## Manual test checklist

1. Open a lead in the ביקור נקבע stage, enter a date + time, click away. Confirm both inputs hold their values.
2. Hard-refresh the browser (Ctrl+Shift+R / Cmd+Shift+R). Confirm the same lead still shows the date + time — this is the round-trip path that previously failed.
3. Pick a lead with a legacy visit date+time already in the sheet (one entered before this fix). Load the page. Confirm the inputs render the stored value instead of empty placeholders.
4. Clear a date+time on a ביקור נקבע lead (empty both inputs), save, reload. Confirm the cleared state persists (no spurious value reappears).
5. Advance a lead from ביקור נקבע to תשלום מקדמה and then to כניסה. Confirm the entry-date modal pre-fills with the lead's `entryDate` when present, or with today's date when not.
6. Add a new patient via the patient modal. Confirm `תאריך כניסה` defaults correctly and saves.
7. Open an existing patient for edit. Confirm their `תאריך כניסה` appears in the date input (previously could render empty for patients whose date cell was Date-typed in Sheets).
8. Verify the lead-card `נוצר` field, which was already wrapped with `isoDate`, is unchanged by this fix — no regression on that input.
