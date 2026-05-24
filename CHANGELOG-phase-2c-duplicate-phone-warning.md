# Changelog — "Phase 2c — duplicate-phone soft warning on lead creation"

Dashboard's `openAddLeadModal` had no protection against duplicate-phone entries. This PR adds a client-side soft warning that fires before lead creation when a normalized phone match exists in `state.leads ∪ state.irrelevantLeads` (`state.removedLeads` intentionally excluded — re-adding a soft-deleted contact is a legitimate flow). The user can override the warning if the duplicate is intentional (e.g., a family member sharing a phone). Mirrors Outpatient PR #6.

## [Unreleased]

### Why this exists

1. The Dashboard's only existing lead-creation gate was the name validation. No duplicate-phone check meant two real-world failure modes: Vered entering the same lead twice from a phone log, or two staff members both opening Add Lead and submitting the same contact.
2. Soft warning (not hard block) preserves legitimate cases — family members sharing a phone number, parent + child contacts, etc. Vered retains override authority on every flag.
3. Cross-app feature parity with Outpatient PR #6 (same UX pattern, same dedup-pool exclusion rules adapted for Dashboard's three-bucket data model: active / irrelevant / removed).

### Changed (public/app.js)

- Added `normalizePhone(raw)` utility helper (lines 643–660) — canonicalizes Israeli phone input formats to a single comparable string. Strips whitespace/dashes/parens, normalizes `+972` and `00972` prefixes to bare `972`, converts leading `0` (local format) to `972`. Mirrors Outpatient's helper exactly. Empty input returns `''` so callers skip dedup.
- Added `findDuplicateLeadByPhone(normalizedPhone)` helper (lines 663–675) — scans `state.leads` concatenated with `state.irrelevantLeads`, returns the first lead whose normalized phone matches, or `null`. `state.removedLeads` intentionally excluded.
- Refactored `openAddLeadModal`'s `onSubmit` callback (lines 1192–1237). Extracted the create flow (`cryptoId → normalizeLead → unshift → renderAll → saveAll → rollback on error`) into a local `doCreateLead(vals)` function. Added dedup check between name validation and create: if phone is non-empty and a duplicate exists, show a confirmation modal via `showConfirm` with text `כבר קיים ליד "[existing name]" עם הטלפון [entered phone]. להוסיף בכל זאת?` and `confirmLabel` `הוסף בכל זאת`. Cancel = no lead created. Confirm = `doCreateLead` runs.
- Both paths (no duplicate, duplicate-confirmed) call `doCreateLead` — no code duplication.

### Not changed (intentional)

- `apps-script/Code.gs` — frontend-only PR. No backend dedup. Server-side dedup would require a fresh read of the sheet on every save, slower for marginal benefit. Threat model is accidental duplicate-entry, not adversarial.
- `public/style.css` — untouched. Reuses the existing `showConfirm` modal styling.
- `showConfirm` signature — NOT extended further this time. The `danger: false` / `confirmLabel: 'הוסף בכל זאת'` combination is already supported by PR #2's signature.
- `openDirectAddPatientModal` (a separate patient-creation flow) — out of scope. Different entity, different sheet, different dedup semantics if any.
- Edit-existing-lead flow — out of scope. Dedup only fires on new-lead creation, never on edit (editing an existing lead's phone to match another would false-positive against itself).
- Empty-phone leads — skipped (no point matching empty strings; some leads legitimately have no phone yet).
- Modal lifecycle on cancel: closes the Add Lead modal entirely (via `return true` from `onSubmit`), per Vered's decision. If she wants to retry, she clicks `ליד חדש` again. Documented in the inline comment at the `showConfirm` call site.

### Safety

- `showConfirm` escapes the existing lead's name via its existing `escapeHtml` on the text field — XSS-safe even if a sheet entry contains malicious markup.
- Soft warning (not hard block) preserves Vered's agency for legitimate same-phone cases.
- Backend rollback path (`state.leads.filter` + `showError`) preserved unchanged inside `doCreateLead` — any `saveAll` failure still cleans up `state.leads`.
- No new dependencies, no new event handlers, no new backend endpoints. Smallest possible surface area.
- `normalizePhone` returns `''` for empty/null/undefined input — caller's `if (normalized)` guard prevents matching against the empty string (which would falsely match every phone-less lead in the pool).

### Manual test checklist (run on live URL after Railway deploy)

1. Hard refresh https://ezone-dashboard.up.railway.app.
2. Create a new lead with a unique phone (e.g., `050-1111111`). Confirm normal save flow — no modal.
3. Try to create a second lead with the EXACT same phone. Confirm:
   - Add Lead modal closes
   - Confirmation modal opens with text `כבר קיים ליד "[name]" עם הטלפון 050-1111111. להוסיף בכל זאת?`
   - Buttons: `ביטול` and `הוסף בכל זאת`
4. Click `ביטול` — modal closes, no lead created. (Add Lead modal is fully closed — Vered must reopen it via the column button if she wants to retry.)
5. Repeat step 3 then click `הוסף בכל זאת` — confirm the duplicate IS created (override path), reload to verify it persists.
6. Try same phone in different formats: enter `+972-50-1111111` and then `0501111111`. Confirm modal opens for both — normalization works.
7. Edit an existing lead's phone via the edit-lead flow (NOT add-new) to match another lead's phone. Confirm NO modal appears — edit path bypasses dedup.
8. Soft-delete a lead via `הסר`. Then create a new lead with the soft-deleted lead's phone. Confirm NO modal — removed leads are excluded from the dedup pool.
9. Mark a lead as `לא רלוונטי` (existing flow). Then try to create a new lead with that lead's phone. Confirm modal DOES open — irrelevant leads are NOT excluded from the pool.
10. Create a lead with empty phone. Confirm normal save flow — no modal.
