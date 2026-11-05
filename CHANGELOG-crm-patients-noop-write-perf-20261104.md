# CRM-SAVE-PERF — skip unchanged Patients grid rewrites (4 November 2026)

**Status: DRAFT. This change does not touch production until Sandra explicitly approves a merge and Apps Script deployment.**

## Why this specific work
On 4 Nov 2026 a read-only inspection of Railway production HTTP logs showed `POST /api/sheets` median ~14.15s (35 logged requests, sampled p95 ~17.19s, max ~24.28s). This route serves multiple actions, so these timings are **not** proof that each sample is `saveAll`; nevertheless exact deployed `Code.gs` shows that `saveAll_` calls `replaceHousePatients_` once for every provided house, and the function always runs two full-column text format writes plus a full Patients-grid write even when the resulting patient cells are entirely unchanged.

`mergeLeads_` already skips unchanged Leads writes. This applies the corresponding strict shortcut only to the **Patients** grid.

## Small production change
- During the existing single Patients read, copy the original rows before the house matcher normalizes/reorders its work buffers. No extra spreadsheet read and no new columns.
- Before the existing full `setNumberFormat('@')` / `setValues`, compare **all original cells** to all projected cells as a multiset, including duplicates and primitive types; `Date` and same-looking text are intentionally different. This avoids needless sheet writes on lead-only edits or whole-house no-ops, even when the original sheet interleaves houses. It also preserves the pre-existing row order instead of reordering for no change.
- The shortcut requires zero preserved omitted rows, suppressed/deleted IDs, skipped promotions, conflicts, house moves, leaving rows and updatedAt stamps. Genuine modifications, audit/safety paths and date-type migrations fall back to the unchanged guarded full-write path.
- The source still acquires/releases the existing lock, respects `updatedAt` and `personId`, never changes admission/discharge/finance logic, and returns the same `written/preserved/stamps/proven` contract. For non-serializable cells, the comparison fails closed to the normal write.

## Verification
- Synthetic real-Code.gs VM tests: 90 patients across 6 interleaved houses; unchanged save and lead-only change produce zero Patients `setValues` calls. Patient amount update, legacy date text healing, omitted stale patient, and duplicate/type mismatch all still force the correct behavior. Existing regression suites must remain green at exact PR SHA.
- The metric to compare **after separately approved deployment** is `POST /api/sheets` duration and Apps Script `[perf] saveAll` timing, plus source-confirmed save/reload. Do not advertise a latency gain from mocked Sheets tests alone.

## Safety, dependencies, rollout
- No production Google workbook edits, schema updates, new secret, role expansion or cross-app endpoint changes by creating this PR.
- On approval, Dashboard Apps Script is **automatically deployed** by GitHub workflow when the PR is merged to `claude/build-ezone-dashboard-QOg5s` (unlike Outpatient's explicit second phase), so do not merge until Sandra separately authorizes deployment.
- Existing CRM acceptance issue #339, central #331, and the current production backup/restore controls remain the record. Office-dependent staff role UAT is still open.
