# A re-activated patient no longer vanishes on the next load (PR #145's fix, re-landed)

Base: `claude/build-ezone-dashboard-QOg5s` (the deployed branch, at #188).
Service worker `CACHE_VERSION` **v40 → v41**. **v17 stays burned and is never reused.**
**`apps-script/Code.gs` is not touched.** The fix reuses the existing
`restorePatientToActive` action, so there's no Apps Script deploy and nothing
changes for ezone-managers or ezone-therapists.

## History

| PR | What happened |
|---|---|
| #145 | Shipped this fix together with the read-only `diagnoseRamotPatientsNow` diagnostic. SW v16 → v17. |
| #146 | Reverted all of #145: phones stopped loading, because they were pinned to a stale SW v17 cache. |
| #147 | Re-landed **only** the diagnostic (`Code.gs` + its tests). No `public/` change. |
| this PR | Re-lands **only** the fix (`public/app.js`), adapted to today's code. The #147 diagnostic is untouched. |

## The bug (still live on the deployed branch until this PR)

`healClobberedDischarges()` runs on every load: a reload, or a tab refocus at
least 60 s after the last load. It finds the first patient whose house + name +
entry date match an **open** (not restored) discharge audit row, flips them back
to `released`, and saves that. Released rows are hidden from the house tab.

The heal reads only the audit row's `restored` flag. That means it can't tell a
clobbered discharge from a patient someone set back to live on purpose. Four
deliberate paths never closed the stay's audit rows:

1. ✏️ **edit patient**, status שוחרר → פעיל / הפסקה זמנית;
2. **direct add / «🟢 קליטת מטופל חדש»** with the original entry date (the new
   row is written first in the house, so it is the heal's first match);
3. **admission** (the entry modal) with that same entry date;
4. **restore** of a stay that has a **second** open audit row (only the
   clicked row was flagged).

In each case the patient came back after the save, then disappeared on the next
load with no error.

## The fix (`public/app.js` only)

- Each of those four writes now flags **all** of the stay's open audit rows
  `restored='TRUE'`, right after its `saveAll`. It uses the same
  `restorePatientToActive` action and payload the restore modal already sends.
- The new pure helpers are `openDischargeAuditsFor`, `reopenedDischargeAudits`,
  `withAuditsRestored`, `persistAuditsRestored` and `healedToastMessage`.
- **Rollback:** if the flag write is refused, the UI rolls back the same way the
  restore modal does. The next load's heal then releases the half-saved row on
  the sheet too, so the sheet matches what the screen showed.
- **The heal announces itself** with a toast:
  «סומנו כמשוחררים לפי רישום שחרור פתוח: <names>». It is rendered with
  `textContent`, so a name is always plain text.
- A real clobber is still healed exactly as before. An ordinary save sends no
  extra write.

### Adapted to today's code (compared with #145)

- **✏️ edit + house move** (the `movedFrom` intent, `CHANGELOG-house-move-lead-linked.md`):
  - The flags are written only once the move has **landed** (`houseMoveVerdict === 'moved'`).
    If the backend refused the move or never confirmed it, nothing is closed and
    the open rows reappear on screen.
  - **Rare case, handled on purpose:** the move landed but the flag write
    failed. The edit is **kept**, because putting the patient back in the old
    house would send them there without a move intent. The user sees:
    «השינוי נשמר, אבל רישום השחרור לא נסגר — בטעינה הבאה המטופל יסומן שוב
    כמשוחרר. ערכו שוב את הסטטוס.»
- **Intake mode** (`openDirectAddPatientModal({ intake: true })`, the
  coordinators-roster PR) gets the same fix, because it shares direct-add's
  save path.
- **Controller view (Ortal, #187/#188):** her `getData` carries no discharge
  record, so nothing ever matches. She can't `saveAll` anyway. No change for
  her.
- **#154 current managers, #186 hashed assets and SW strategy, #187/#188 Ortal
  billing:** not touched.

## Why phones pick this up (the #146 lesson)

- `index.html` is served **network-first**. It links `app.js?v=<12-hex content
  hash>` (#186), and the hash changes with the bytes.
- The SW's `cache-first-hashed` lookup is by **exact URL**, so the new hash is a
  cache miss: the phone fetches the new `app.js`, and older hashes are pruned.
- `activate` deletes every cache that isn't `ezone-dashboard-v41`. That includes
  v40 and any orphaned **v17** left over from #145.
- A test pins all of this
  (`test/reactivation-fix.test.js` → "SW v41: a phone still holding the v40
  cache, the burned v17 one and the OLD app.js hash gets the new app.js").

## Tests

- `test/reactivation-fix.test.js` (25): the real `app.js` runs end to end
  against the real `Code.gs`, over fake sheets.
  - **The bug scenario, outcome only:** it fails on the pre-fix `app.js` with
    "before the fix the load-time heal released her again here".
  - All four paths plus intake, a U+FFFD name, house-label and padded variants,
    a house move that lands, a refused move, and a flag failure after a landed
    move.
  - No regression for active, released and restored patients, or for leads
    (re-admission with a new date, restore-as-new-lead). No extra writes.
  - Escaping, the SW pickup test, and a view-mode session that writes nothing
    (`persistAuditsRestored` follows `saveAll`'s edit-mode gate).
- `test/reactivation-fix-browser.test.js` (2): real Chromium at 360 px, real
  `server.js`, with `/api/sheets` routed into the real `Code.gs`.
  - ✏️ → פעיל → save → **reload**: the patient is still in the ramot tab. This
    test fails on the pre-fix `app.js`.
  - The heal toast shows an `<img onerror>` name as text. No element is
    created and nothing runs.
- SW pin tests: `test/dashboard-perf-assets.test.js` is now pinned to `v41`;
  `test/ortal-verification-status.test.js` now checks `>= v40` and never v17.
- **Mutation checks (11, all caught):**
  - drop the "before" identity;
  - drop the sibling flags on restore;
  - persist flags on a refused move;
  - remove the heal toast;
  - ignore the `restored` flag;
  - roll the house back after a landed move;
  - skip the flags on admission;
  - SW back to v40;
  - make `withAuditsRestored` mutate its input;
  - make `showToast` use `innerHTML` (caught by both the node test and the
    browser test);
  - drop the view-mode guard from `persistAuditsRestored`.
- **Full suite:** 2305 pass, 0 fail, 0 skipped, Playwright browser tests
  included. The baseline was 2278.

## After merge

- Railway redeploys the frontend. The Apps Script deploy does **not** run,
  because `apps-script/**` is unchanged.
- **Check on a phone:** open the app once, then reload. DevTools → Application →
  Cache Storage shows only `ezone-dashboard-v41`.
