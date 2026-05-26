# Cleanup — remove @deprecated Phase 2b modal code

Removes the @deprecated 2d-2 dead code (`showIrrelevantReasonModal`, `markLeadIrrelevant`) now that Phase 2d-2 is verified live. Safety net no longer needed.

## Why this exists

Phase 2d-2 PR #10 kept old Phase 2b code paths as `@deprecated` dead code for one PR as a hot-revert safety net. PR #10 is now verified live and stable. The safety window is closed; the dead code is removed.

## Changed (`public/app.js`)

- Deleted `showIrrelevantReasonModal` function (~80 lines).
- Deleted `markLeadIrrelevant` function (~40 lines).
- Both had zero callers since PR #10.

## Not changed

- `NOT_RELEVANT_REASON_LABELS` still in use by `renderIrrelevantLeads` for legacy row display.
- `not_relevant_reason` / `not_relevant_note` columns still in the sheet for legacy data.
- No backend changes.

## Safety

Pure deletion of unreferenced code. Grep verified zero callers across the entire repo. No new behavior, no new surface area.

## Manual test

Single check — open the live app, click סגירת ליד on a lead, confirm the new modal still appears correctly (regression check that we didn't accidentally delete the wrong block).
