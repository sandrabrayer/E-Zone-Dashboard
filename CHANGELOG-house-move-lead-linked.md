# A house move from the ✏ modal now persists (lead-linked patients included)

**Branch:** `fix/house-move-lead-linked` · **Base:** `claude/build-ezone-dashboard-QOg5s`

## The symptom

A patient admitted from a lead (so `fromLead` is set) lived in **pardes**.
Someone opened ✏ (edit patient), changed the house to **asher**, and saved.
The screen showed the patient in asher. On the next load they were back in
pardes.

## Root cause, confirmed with a failing test

`test/house-move-lead-linked.test.js` runs the real `public/app.js` against the
real `apps-script/Code.gs`. Before the fix, its first test failed with
`'pardes' !== 'asher'`. This is the trace (line numbers are the base branch's
`Code.gs`):

1. `saveAll` always sends **every** house. The patient now sits in asher's
   array and is missing from pardes'.
2. **asher's pass** (`replaceHousePatients_`). Rows are matched by id only
   within their own house, so the patient's id is not found in asher. The row
   takes the *append* path. There, the promotion-dedupe guard at
   **`Code.gs:2051`** (`if (fl && (fl in fromLeadOnSheet))`) sees the lead
   still sitting on the pardes row and **refuses** the row
   (`promote_skipped_duplicate` / `existing_patient_row`). That guard exists
   so a stale tab can't admit the same lead twice. It could not tell a
   deliberate move from that case. (The guard at `:2056`, for discharged
   leads, has the same blind spot.)
3. **pardes' pass**. The patient is missing from the payload, so
   merge-don't-drop **keeps** the pardes row. It is tombstoned as
   `saveAll-omitted-preserved` and echoed back in `preserved`.
4. **The client.** The modal had already closed as a success. A 6-second
   banner said *"שורה לא נשמרה — כפילות זוהתה"* (row not saved, duplicate
   found), which was misleading. Then the `preserved` echo triggered a reload
   that put the patient back in pardes.

The stale-edit refusal at **`Code.gs:1969`** played no part here: it only runs
for an id-match inside one house. It is kept as it is.

### A second bug found while testing, fixed here too

After **any** successful edit, the client kept the patient's old `updatedAt`.
The server had re-stamped the row, so the same person's next edit of that
patient in the same tab was refused by the `:1969` check: *"השינוי ל־X לא
נשמר — ורד עדכן/ה קודם"* ("the change to X wasn't saved, ורד updated first"),
where ורד was the person herself. A house move re-stamps the row, so without
this fix the first follow-up edit after a move would always be refused.

## The fix

### Backend (`apps-script/Code.gs`)

- **Explicit move intent.** A patient row can carry `movedFrom`, the house it
  is leaving. `collectHouseMoves_` reads the intent from the **whole** payload
  before any house is written. A row counts as a move only when it has an id
  and `movedFrom` names a different house. An id claimed twice is ambiguous
  and ignored. `movedFrom` is never stored, because it is not a sheet column.
- **The move, in the destination house's pass.** Before the id and key
  matches, the backend looks up the row that holds the id in another house:
  - if it is in the house the tab says it is leaving, **and** its `updatedAt`
    is exactly what the tab loaded (blank equals blank), the patient is
    **moved**. The old row is dropped, and the new one is written with the
    **same id** and the sheet's own `fromLead`. It is re-stamped, audited as
    `patient_moved_house`, and returned in `moved`. The drop and the add
    happen in the same `setValues`, so there are never two rows and never
    zero;
  - otherwise the move is **refused** and nothing is written:
    - `stale`: someone saved the patient after this tab loaded;
    - `moved_elsewhere`: the patient is already in a third house;
    - `source_missing`: the patient was permanently deleted, so it is never
      brought back.

    The refusal is a `conflicts` entry carrying
    `move: {from, to, reason, currentHouseId}`, audited as
    `patient_move_refused`.
- **The house being left** reserves the leaving row. No payload row there can
  consume it, for example a namesake admitted in the same save. It is not
  treated as a stale omission, so there is no tombstone and no `preserved`
  echo, and it is written back untouched. A refused move therefore leaves
  everything exactly as it was, whichever house's pass runs first.
- **Stamp echo.** Every row this save wrote whose final `updatedAt` differs
  from the one the payload carried comes back in `stamps`
  (`{id: {updatedAt, updatedBy}}`).
- `moved` and `stamps` are additive and absent when empty, so old clients and
  the Managers consumer see nothing new.

### Client (`public/app.js`)

- The ✏ modal sets `movedFrom` when the house changes. `serializePatients`
  sends it only while a move is pending. If the house is edited again while a
  move is still pending, the original house is kept, and moving back cancels
  the move.
- `applySaveOutcome` runs right after every save response and before any
  reload:
  - it **adopts fresh stamps**, but only on the objects that save sent, and
    only if they still hold the stamp they were sent with. An object a reload
    has replaced is never touched, so one tab's stamp can never cover up
    another tab's newer edit;
  - it **clears a landed move**;
  - for a **refused move**, it puts the patient back in the house they are
    really in and drops the intent. This has to happen here, not in the modal,
    so a later queued save can never re-send the patient under the new house
    without the intent.
- After its save, the modal checks the outcome. **Landed:** a toast *"X
  הועבר/ה ל…"* (X was moved to …). **Refused:** the banner below.
  **No answer** (an older backend, or no save reached the sheet): the move is
  undone on screen and the modal says *"המעבר של X ל… לא נשמר — X נשאר/ה ב…"*
  (X's move to … wasn't saved; X stays in …). The screen never keeps claiming
  a move that didn't happen.
- The Hebrew refusal messages (`moveRefusalMessage`), one per reason:

  | reason | message |
  |---|---|
  | `stale` | המעבר של X ל‹בית› לא נשמר — ‹מי› עדכן/ה את הרשומה בינתיים, ו-X נשאר/ה ב‹בית›. הנתונים רועננו — אפשר לנסות שוב. |
  | `moved_elsewhere` | המעבר של X ל‹בית› לא נשמר — X כבר נמצא/ת ב‹בית אחר› (‹מי› העביר/ה קודם). הנתונים רועננו. |
  | `source_missing` | המעבר של X ל‹בית› לא נשמר — הרשומה כבר לא קיימת בגיליון. הנתונים רועננו. |

  Refusals that aren't about a move keep their exact previous wording.
- Refusal banners (moves, other conflicts, promotion refusals) now stay up
  **15 s** instead of 6 s, so they can be read on a phone. `showError` also
  keeps a single timer, so an older banner's timeout can no longer hide a
  newer message early.

### Service worker

`CACHE_VERSION` **v16 → v18**. v17 is skipped on purpose: #145 used it, #146
reverted that PR, and phones still hold a v17 cache. The activate step
deletes every cache but the current one, so both v16 and v17 are evicted. The
exact `'v16'` pin in `test/date-format-he.test.js` is relaxed to `>= v16`.

## What did NOT change: stale-tab protection

- A tab that still shows the patient in the old house, and saves with **no**
  intent, is refused exactly as before: the fromLead guard for lead-linked
  patients, with `preserved` resync. It cannot drag the patient back.
- The id-match stale-edit refusal (`:1969`) is untouched, and one tab's
  stamp echo never reaches another tab.
- A cross-house id **without** the intent still goes down the legacy path.
  That path is locked by `patient-identity-foundation.test.js` and unchanged.

## Payments follow the patient

Payment rows find their patient by `patientUid`, which is the Patients `id`,
before they fall back to `house::name::entry date`. Keeping the **same id**
through the move is what keeps a moved patient's billing history attached. A
legacy payment row with no `patientUid` cannot follow a house change. It will
show up in «שיוך תשלומים» (the payment-linking screen), exactly as a manual
re-entry would have.

## Known follow-up (not in this PR)

A stale tab that still holds a **hand-entered** patient (no lead) in the house
they have left can still append a re-minted copy there. That is the legacy
no-intent path, and it behaves the same as before this PR. Now that deliberate
moves carry an explicit intent, a follow-up could safely refuse *any*
cross-house id that arrives without it.

## Tests

`test/house-move-lead-linked.test.js`, **26 tests**, end to end on the real
app.js against the real Code.gs:

- the bug: the move persists, with one row, the same id and the same fromLead,
  and the next load shows asher;
- no tombstone, no promotion refusal, no re-mint; audited once; a confirmation
  toast; the intent cleared;
- hand-entered moves; a move combined with other edits; order independence
  (asher → pardes); a two-patient swap in one save; re-editing a pending move
  (origin kept, moving back cancels);
- your own next edit after a move, and a second edit of the same patient
  without any move, are both saved;
- stale tab with no intent: refused, the patient stays put, the tab is told;
- stale move, moved elsewhere, deleted meanwhile: each refused, the sheet
  byte-for-byte unchanged, the Hebrew message checked word for word, the
  screen reverted, a 15 s banner;
- `:1969` intact, and stamps don't leak between tabs;
- an older backend: the move is undone on screen, with a clear message;
- backend units: `collectHouseMoves_`, additive `moved`/`stamps`, honest
  `written` counts, strict stamp equality, the legacy path unchanged, the
  leaving-row reservation;
- client units: `serializePatients`, `applySaveOutcome`, `sentPatientsById`,
  `conflictsMessage` per reason, `houseMoveVerdict`, `moveNotSavedMessage`,
  `showError`'s single timer;
- the SW: v18, never v17.

Mutation checks while writing this PR: no client intent; no stale-stamp
check; no leaving-row reservation; leaving row preserved; save outcome
ignored; lead link dropped. **Each one made at least one test fail.**

Two existing tests were adjusted (their intent is kept):
`rename-guard-followup.test.js` now accepts `showError(skippedMsg, …)` with a
duration, and `date-format-he.test.js` now accepts any version from v16 up.

The full suite is green. The **27 real-browser tests** (Playwright + Chromium,
installed locally with `--no-save`) also pass against this `app.js`, run
serially. One of them samples animation frames, which makes it
timing-sensitive when several Chromium instances run in parallel.

## Deploy

Nothing to set up. On merge, **Deploy Apps Script** (clasp CI) publishes
`Code.gs` and Railway publishes `app.js`. The order doesn't matter:

- a new client on the old backend gets no confirmation, so it undoes the move
  on screen and says so;
- an old cached client on the new backend sends no intent, so it gets exactly
  today's behavior.

The v18 service worker moves every phone onto the new `app.js`.

## Rollback

Revert this PR. The response fields are additive, and `movedFrom` is never
stored, so nothing is left behind on the sheet.
