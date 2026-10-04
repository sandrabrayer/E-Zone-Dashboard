# Patient funder (גורם מממן) — foundation (PR 1 of 2)

Branch `claude/peaceful-meitner-43w32h` → base `claude/build-ezone-dashboard-QOg5s`.
**Zero user-facing change.** No UI, no `app.js` change, nothing new loaded by
`index.html` or `sw.js`, so no `CACHE_VERSION` bump. `server.js` changes only
a comment. Once this is merged, clasp CI deploys `Code.gs`. Nothing to set in Railway,
no new Script Property.

## Why

The גבייה tab can say how much is owed (`debtAging`, PR #161), but not **who
is paying**: the patient privately, ביטוח לאומי, משרד הביטחון or מכבי. The
funder can change during a stay, so we need its history. Old debt must stay
under the funder that was active when that debt arose.

## Decisions (Sandra, locked)

- **A fixed list with stable keys.** There is no "other".

  | key | label |
  |---|---|
  | `private` | פרטי |
  | `btl` | ביטוח לאומי |
  | `mod` | משרד הביטחון |
  | `maccabi` | מכבי |
  | `unset` (no row) | לא הוגדר |

  Only the keys are stored. The server refuses a Hebrew label, a case variant
  (`BTL`), padding (`" btl"`) or an unknown key.
- **History, append-only.** Each row says: from day D, patient P is funded by
  F. A correction is a **new row**. No path edits or deletes a row.
- **The funder on day D.** It is the row with the latest `effectiveFrom` ≤ D.
  If two rows have the same `effectiveFrom`, the latest `recordedAt` wins. If
  that is also equal, the later row on the sheet wins. With no row, the
  funder is `unset`.
- **Debt by funder.** Every owed cycle goes to the funder that was active on
  the cycle's **start day**. That is `cycles[].start` in `debtAging_`: the
  recorded coverage start when there is one, otherwise the due date. A
  patient with no history, or with no id, goes to `unset`.

## Investigation (Step 1)

- **Patient key.** The persisted Patients `id` (`id-…`, PR patient-identity
  foundation). Payments link to patients on this key first:
  `recMatchPatient_` tier 1, `Payments.patientUid` = Patients `id`.
  `debtAging_` returns it as `byPatient[].patientId`. The key is stable across
  renames and house moves (the move keeps the same id, see
  `CHANGELOG-house-move-lead-linked.md`).
- **Debt.** `Code.gs debtAging_(asOf, tabs)` builds it from cycles. Each owed
  cycle has a `start`, a `balance` and a `kind` (`recorded` / `unrecorded`).
  The two figures, `recorded_debt` and `unrecorded_cycles`, are **never
  summed**. `debtByFunder` takes this report as it is and never recomputes a
  cycle.
- **Code.gs write pattern.** `handle_` dispatches after the finance and role
  checks. `proxyGate_` applies the `PROXY_SECRET` transition: log mode serves
  and records in `SecurityLog`, enforce mode refuses. `PROXY_KNOWN_ACTIONS`
  is the list of names `SecurityLog` may record. Writers call
  `lock.tryLock(10000) !== true → lockBusy_()`. `getOrCreateSheet_` extends
  headers without overwriting anything and forces date columns to text.
- **server.js.** It has no allowlist of write actions. Every action passes
  `/api/sheets`. The per-action gate is `lib/finance-scope.js
  FINANCE_ACTIONS` (403 for a session without `finance`), mirrored in
  `Code.gs`. A guard test pins the two lists equal.

## What changed

### `apps-script/Code.gs`

- **New sheet `FunderHistory`.**
  `FUNDER_HISTORY_COLUMNS = ['id', 'patientId', 'funder', 'effectiveFrom', 'recordedAt', 'recordedBy']`.
  The column order is append-only and pinned by a test. `patientId`,
  `funder`, `effectiveFrom`, `recordedAt` and `recordedBy` are forced to text
  in `getOrCreateSheet_`, and per row before each write.
- **New action `setPatientFunder`** (`funder: { patientId, funder, effectiveFrom }`):
  - `funderPayloadCheck_` (pure) checks:
    - `funder` is exactly one of `FUNDER_KEYS`;
    - `effectiveFrom` is a bare real `yyyy-MM-dd`, at most 1 day after today
      (Asia/Jerusalem);
    - `patientId` is a non-empty string of at most 200 characters.
  - Errors: `missing_funder`, `missing_patientId`, `bad_funder`,
    `bad_effectiveFrom`, `future_effectiveFrom`.
  - Under the script lock: the `tryLock` result is checked, and a busy lock
    returns `{ok:false, error:'lock_busy'}` with nothing written. The patient
    id must exist on the Patients sheet (`unknown_patient`). Then **one row is
    appended**:
    - `id` = `fh-<uuid>`;
    - `recordedAt` = the server clock;
    - `recordedBy` = the session user (`requestUser_`). Whatever the payload
      sends for these three is ignored.
  - Gated by `PROXY_SECRET` (not in `OPEN_ACTIONS`) and listed in
    `PROXY_KNOWN_ACTIONS`.
  - A **finance** action (`FINANCE_ACTIONS`): Shiran and Yael are refused
    before anything is read. It is not a delete or approver action.
  - No `console`, `Logger` or AuditLog line. The FunderHistory row is itself
    the audit trail (who and when).
- **`getData` gains `funderHistory`.** It is appended, under the
  append-only contract.
  - `readFunderHistory_` reads with `getSheetByName`, so a missing tab reads
    `[]` and is **not created** by a read.
  - `normalizeFunderHistoryRow_` turns a date-typed `effectiveFrom` into its
    Israel day with `asISODate_` (the Sheets Date trap), and a Date
    `recordedAt` into ISO text.
  - `funderHistory` is added to `GETDATA_FINANCE_KEYS`, so a restricted
    session (and the healthcheck) does not receive it.

### `lib/finance-scope.js` (the server.js allowlist)

`setPatientFunder` is added to `FINANCE_ACTIONS` and `funderHistory` to
`GETDATA_FINANCE_KEYS`, the same as `Code.gs`. `server.js` itself changes only
the healthcheck comment.

### New `public/funder.js` (pure, UMD)

Nothing loads it yet. `server.js` has no route for it, and `index.html`,
`sw.js` and `app.js` do not reference it (a test checks this).

- `FUNDER_KEYS`, `FUNDER_UNSET`, `FUNDER_LABELS`, `isFunderKey`,
  `funderLabel`, `isoDay`.
- `normalizeFunderEntry(raw)`: reads the fields with `pickField`, like the
  other normalize helpers. It returns `null` for a row that cannot count: no
  patient, a funder that is not exactly a key, or no real day. A Date or a
  full timestamp is read by its **local** day, never sliced as UTC.
- `funderAt(history, patientId, isoDate)` and
  `currentFunder(history, patientId[, todayIso])`. Today is computed in
  Asia/Jerusalem whatever the device's time zone.
- `debtByFunder(report, history[, asOfDate])` → `{ private, btl, mod, maccabi, unset }`.
  - Each value is `{ recorded_debt: {count,total}, unrecorded_cycles: {count,total}, byHouse: { houseId: { recorded_debt, unrecorded_cycles } } }`.
  - `report` is a `debtAging_` response.
  - An `asOfDate` that differs from `report.asOf` throws.

## Tests

New file `test/patient-funder-foundation.test.js` (23 tests). They run in a vm
sandbox on the real `Code.gs`, with TZ = Israel and synthetic names. They
cover:

- the keys and labels, and that `Code.gs FUNDER_KEYS` equals `funder.js`;
- the key allowlist: unknown keys, Hebrew labels, case variants, padding and
  non-strings are refused;
- `normalizeFunderEntry`;
- `funderAt`:
  - no history gives `unset`;
  - a future `effectiveFrom` is ignored;
  - a switch in the middle of a month;
  - a correction on the same day: the later `recordedAt` wins, in either row
    order, and a tie goes to the later row;
  - a Sheets Date-object `effectiveFrom`, also after JSON transport;
- `debtByFunder`:
  - **the invariant**: for each figure, the five funders sum to
    `report.totals`, and per house to `report.byHouse`. It is checked on three
    as-of dates, with full history and with no history;
  - each cycle goes to the funder of its start day;
  - the two figures are never summed, and the inputs are not mutated;
  - a bad report or a mismatched `asOfDate` is refused;
- `Code.gs`:
  - the header order guard;
  - the validation table;
  - the append-only write (the text format is set before the value);
  - `recordedBy` comes from the session, never the body;
  - a correction is a new row;
  - nothing is written when the lock is busy, the patient is unknown, the
    actor is restricted, or enforce mode gets no secret or a wrong one;
  - no log line carries patient data;
  - only one writer touches the sheet;
  - `getData` coerces Date cells, reads a missing tab as `[]` without creating
    it, and drops `funderHistory` for a restricted actor;
- nothing in the browser loads `funder.js`.

Existing tests that pin the exact `getData` keys now include `funderHistory`
(and exclude it for the restricted view). The guard tests for
`GETDATA_FINANCE_KEYS` were updated the same way.

I mutated the code five ways to check that the tests catch a break: a
reversed tie-break, attributing debt by the as-of day, a future limit of 5
days, a skipped patient check, and an un-coerced Date. Each one failed at
least one test.

**Full suite: 1998 / 1998** (1975 before).

## PR 2 scope (not in this PR)

- UI:
  - a «גורם מממן» field on the patient card (finance users only), showing the
    current funder and the change history;
  - «שינוי גורם מממן» with an effective date, which appends a row;
  - a correction is a new row, never an edit.
- גבייה «חובות פתוחים»: a breakdown by funder (`debtByFunder` on the existing
  `debtAging` response), with per-house totals and `unset` shown as «לא הוגדר».
  Optionally, a funder column in the debt-aging `.xlsx`.
- Load `funder.js` from `index.html`, add it to the `sw.js` precache, add a
  `server.js` static route, and bump `CACHE_VERSION`.
- Guide / help text.

## For Sandra

Nothing to set. Once this is merged, clasp CI deploys `Code.gs`. The
`FunderHistory` tab is created on the first `setPatientFunder` call (PR 2's UI)
and never by a read. **Do not edit or delete rows by hand.** To fix a
mistake, add a new row. With the same `effectiveFrom`, the later
`recordedAt` wins.
