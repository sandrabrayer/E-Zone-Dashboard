# Name picker + stale-save conflict refusal (PR 2a)

**Why:** PR #112 gave Patients a persisted `id`; PR #113 added
`updatedAt`/`updatedBy` stamping and an optional tamper-proof `user` inside
the signed session cookie — nothing user-visible. Three people now use the
dashboard concurrently. This PR makes it visible: **each person identifies
once per device** (a fixed-name picker after the PIN), and **a stale tab can
no longer overwrite a newer edit** (the id-match save branch refuses when
the tab's loaded `updatedAt` no longer matches the sheet's).

## Phase 1 findings

1. The names already exist: `ASSIGNEE_OPTIONS = ['ורד', 'שירן', 'יעל']`
   (the leads assignedTo dropdown) — reused verbatim, nothing invented.
2. Login flow: `tryPin()` POSTs `{pin}` → `enterApp()`; logout button posts
   `/api/logout` + reload. `/api/me` existed (PR #113) but had no consumer.
3. Save-response handling: `maybeResyncPreservedPatients` (30s-floored
   `loadAll()` reload) + `promoteSkippedMessage` → `showError` — the exact
   pattern the conflict handling reuses.
4. `replaceHousePatients_` id-match branch captures the payload's echoed
   `updatedAt` before `carryStamps` overwrites it — the natural refusal
   witness. `saveAll_` already aggregates per-house result lists.
5. Service worker `CACHE_VERSION` on the deploy branch: **v5**.

## A. Name picker

- **One list, three places, pinned equal by test**: `lib/users.js
  SESSION_USERS` (server validation) === `public/app.js SESSION_USERS`
  (picker buttons) === `ASSIGNEE_OPTIONS`. `/api/verify-pin` accepts `user`
  only from the list (`validateSessionUser` = sanitize → allow-list → '');
  anything else mints the legacy user-less cookie, so `updatedBy` can never
  carry an arbitrary string however the request is crafted.
- **Flow**: PIN ok → `/api/me`; empty user → one-screen RTL picker (same
  `pin-box` styling, one tappable button per name, no free text). Picking
  re-issues the cookie via `/api/verify-pin` with `{pin, user}` — the PIN is
  held in a closure only for that call, never persisted. Cookie TTL
  unchanged (7 days). Existing user-less sessions are routed through the
  PIN form once on next load (the re-issue needs the PIN), then remembered.
- **Header**: `מחובר/ת כ: <name> · החלף` (hidden for legacy sessions).
  החלף = logout → PIN → picker.
- `updatedBy` remains server-authored from the cookie. No other UI change.

## B. Conflict refusal (server, id-match branch ONLY)

In `replaceHousePatients_`'s id-match branch: with `sheetStamp` = the sheet
row's `updatedAt` and `seenStamp` = the payload's echoed `updatedAt`
(captured before the carry), a save is REFUSED when **all** hold:
real content changed (`patientRowDiffCols_`, meta-blind) AND `sheetStamp`
non-empty AND `seenStamp` non-empty AND `seenStamp !== sheetStamp`. The
sheet row is consumed and kept **byte-for-byte**; the refusal lands in a new
additive `conflicts` response array (`{id, name, houseId, sheetUpdatedAt,
sheetUpdatedBy, changed}`) aggregated across houses by `saveAll_` (absent
when none — old clients and the Managers consumer see nothing new), and is
audited `patient_save_conflict` (with `seenUpdatedAt` + the acting user).
Empty `seenStamp` (pre-#113 tab) or empty `sheetStamp` (never-stamped row)
→ today's last-writer-wins, no refusal. Key-match / rename / append
branches unchanged — a pre-#112 id-less tab keeps saving.

## C. Conflict handling (client)

Non-empty `conflicts` → Hebrew `showError` banner via the pure
`conflictsMessage(res)` (precedent: `promoteSkippedMessage`):
`השינוי ל־<names> לא נשמר — <updatedBy> עדכן/ה קודם. הנתונים רועננו.`
(neutral fallback when the winning stamp has no name), and
`saveAllResponseNeedsResync` now also fires on conflicts, so the same
guarded resync that serves `preserved` reloads the sheet's version. Never
retried automatically.

## D. Service worker

`CACHE_VERSION` **v5 → v6** (index.html / style.css / app.js changed).

## Tests

`test/name-picker-conflicts.test.js` — 15 tests: the three-way list pin;
`validateSessionUser` accept/sanitize/reject; re-issue TTL unchanged +
`/api/me` readback; refusal (sheet survives byte-for-byte, `conflicts`
shape, audit, no `patient_edited`); meta-only echo / empty seenStamp /
empty sheetStamp / matching stamp → no refusal; key-match unaffected;
cross-house aggregation + field absent when clean; `conflictsMessage`
formats/dedups/fallback; resync trigger; picker shown only on empty
`/api/me` user, buttons = the fixed list, pick re-sends `{pin, user}`;
header renders + hides; existing user-less session routed through PIN once.
Two #113 tests updated to the new contracts (forged-stamp fixture now echoes
the matching `updatedAt`; source-scan expects `validateSessionUser`). Full
suite: **854 passing**.

## Deferred — PR 2b plan (so it isn't lost)

**Per-row saves by id**: a `savePatient` action carrying ONE row (matched by
`id`) instead of the whole-house array — shrinking the write window that
makes stale-tab merges necessary, and giving the conflict refusal a
row-scoped 409-style response the client can resolve field-by-field instead
of reloading everything. The `conflicts` shape shipped here is designed to
carry over unchanged.
