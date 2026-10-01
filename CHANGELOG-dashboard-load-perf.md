# CHANGELOG — Dashboard load / save performance

**Branch:** `perf/dashboard-load` → `claude/build-ezone-dashboard-QOg5s`
**Files:** `apps-script/Code.gs`, `public/app.js`, `public/sw.js` (v18),
`DIGEST-CONTRACT.md`, `test/dashboard-load-perf.test.js` (new), and small
harness updates in 3 existing tests (listed below).

## The problem

The live Dashboard is slow to load and slow to save. This PR measures where the
time goes, fixes the safe items, and adds timing so the real numbers show up in
the logs.

## How it was measured

1. **Timing instrumentation (shipped in this PR).**
   - Apps Script: one `Logger` line per request, milliseconds and row counts
     only (no names, no values), e.g.
     `[perf] getData_ 812ms | open=31 read=402 backfill=0 shape=77 phones=12 | leads=250 patients=90`.
     Written by `getData_`, `getPayments_`, `getCredits_` and the `saveAll`
     branch of `handle_` (`save=` / `digest=` laps).
     Where to read it: Apps Script editor → **Executions** → open a
     `doGet`/`doPost` row.
   - Browser: one console line per load,
     `[E-ZONE][perf] loadAll 1830ms | getData=1650 getPayments=1400 getCredits=1100 fetched=1700`
     (each request's own round trip, all three fetched, and the total with
     parse + render).
2. **Call-count benchmark (local, exact).** The real `Code.gs` runs over fake
   sheets that count every Sheets / Lock / Cache / Properties call. Data size:
   250 leads, 90 patients, 1,600 payments (10 of them orphans: a billing key
   that no longer matches a patient), 60 credits, 120 irrelevant leads, 60
   removed, 40 discharged, 30 overrides. Save payloads are what the client
   really sends: **every lead and every house**.

A live-sheet timing from this sandbox was not possible (no access to the
deployment). Real milliseconds come from the log lines above after deploy. For
a "before" figure, the Executions page already shows each `doGet`/`doPost`
duration for the current code.

## Where the time went (measured call counts, before → after)

| Call | getData | getPayments (cold / warm) | getCredits | saveAll: patient edit | saveAll: lead edit | saveAll: nothing changed |
|---|---|---|---|---|---|---|
| Sheet reads (`getValues`) | 9 → **6** | 5 → **2 / 1** | 2 → **1** | 10 → 10 | 10 → 10 | 10 → 10 |
| Cells read | 25,330 → **13,940** | 154,770 → **39,570 / 38,400** | 3,000 → **1,500** | 20,210 → 20,210 | 20,210 → 20,210 | 20,210 → 20,210 |
| Whole-column `setNumberFormat` (writes) | 15 → **0** | 17 → **0** | 6 → **0** | 51 → **43** | 49 → **45** | 49 → **41** |
| `setValues` | 0 → 0 | 0 → 0 | 0 → 0 | 10 → **9** | 9 → **7** | 9 → **6** |
| Cells written | 0 | 0 | 0 | 13,830 → **7,330** | 13,824 → 13,520 | 13,824 → **7,020** |
| Timezone lookups | 200 → **0** | 0 | 0 | 201 → **1** | 201 → **1** | 201 → **1** |
| Script lock | 0 → 0 | **1 → 0** | 0 → 0 | 2 → 2* | 2 → **1** | 2 → **1** |
| `openById` (digest spreadsheet) | 0 | 0 | 0 | 1 → 1* | 1 → **0** | 1 → **0** |
| Script Properties | 4 × `getProperty` → **1 × `getProperties`** | 0 | 0 | 2 → 1 | 2 → 1 | 2 → 1 |

\* The first save after a deploy writes the digest once, because nothing has
been recorded yet. After that, a patient edit that doesn't change the active
population skips the digest write too, as the other two columns show.

The costs, in order of impact:

1. **Timezone lookups on every read.** `asISOTime_` called
   `getSpreadsheetTimeZone()` on every call, even for clean `'HH:MM'` values
   that don't need it. That's one service call per lead, on every load and
   every save (200 per request here).
2. **Writes on the read path.** Every read opened its sheets with
   `getOrCreateSheet_`, which re-applies whole-column text formats on each call
   (15 on a load, 17 on getPayments, 6 on getCredits). Formatting is a write,
   so every page load was writing to the spreadsheet.
3. **The same sheet read several times.** Each id backfill pre-scanned its
   sheet with its own `getValues`, and then the sheet was read again for the
   answer. getPayments read the 1,600-row Payments sheet **four times**.
4. **An unnecessary lock on every getPayments.** The pre-scan treated *any*
   blank `patientUid` with a billing key as work to do. That includes orphan
   payments whose patient no longer exists, which stay blank forever by
   design. So every read took the script lock, re-read Payments twice and
   filled nothing. While a save holds the lock, that read waits up to 10 s.
5. **Sequential client fetches.** `loadAll` waited for getData, then
   getPayments, then getCredits. The page paid three web-app round trips back
   to back.
6. **Full-sheet writes on every save.** The client sends every lead on every
   save, and `mergeLeads_` rewrote the whole Leads sheet even when no lead
   changed. After each save the digest rebuild also opened the second
   spreadsheet (`openById`), cleared it and rewrote it, even when the active
   population was unchanged.
7. **Still there (not changed here):** `replaceHousePatients_` rewrites the
   whole Patients sheet once per house (6 passes, about 24 redundant
   whole-column formats per save). See follow-ups.

## What changed

### Apps Script (`apps-script/Code.gs`)

- **`sheetForRead_`**: the read accessor. It opens the sheet without the
  format pass. A missing sheet, or one whose header is shorter than the mapped
  columns, still goes through `getOrCreateSheet_`, so first-read setup is
  unchanged. Used by `getData_`, `getPayments_`, `getCredits_`,
  `patientUidIndexByKey_` and the digest rebuild. **Every write path still
  runs `getOrCreateSheet_`** before writing (`mergeLeads_`,
  `replaceHousePatients_`, `upsertPayment_`, `upsertCredit_`, …). The format
  guards protect values being *written*, so they stay where the writes are.
- **One `getValues` per sheet** (`sheetValues_` + `rowsFromValues_`, and
  `readSheet_` is now built from the two). The backfill pre-scans look at
  values already read. A backfill runs only if the pre-scan finds work
  (`blankInContentRows_`), and a sheet that was healed is read again so the
  answer carries the stored ids. `paymentIdentityNeedsBackfill_`,
  `backfillPaymentIdentityLocked_`, `creditUidsNeedBackfill_` and
  `backfillCreditUidsLocked_` take optional `values`; the accounting feed
  calls them unchanged.
- **Precise Payments pre-scan.** A blank `patientUid` counts as work only if
  its key resolves to a patient. Orphans no longer take the lock. The fill
  itself still runs under the lock against a **fresh**
  `patientUidIndexByKey_()`, exactly as before.
- **CacheService for the read-only lookup, with explicit invalidation.** The
  pre-scan's "which keys resolve" set is cached for 10 minutes as `fastHash_`
  values (hashes only, **no names, keys or ids in the cache**). `handle_`
  drops it in a `finally` **after** every Patients write action (`saveAll`,
  `deletePatientRow`, `dischargePatient`, `restorePatient`,
  `restorePatientToActive`), including when the action throws. `getData_`
  also drops it after healing Patients ids. Why staleness is harmless: the
  cache only decides whether to *look closer*. A stale copy can delay a fill
  until the next write or the TTL, and never changes a stored cell. If the
  service is absent, refused or failing, everything behaves as "not cached"
  (tested).
- **`asISOTime_`** looks up the timezone lazily, only for Date values and
  timestamp strings. This mirrors what `asISODate_` already does.
- **`managerPhones_`**: one `getProperties()` instead of one `getProperty()`
  per manager. The override rule is unchanged. If `getProperties` is missing,
  it falls back to per-key reads.
- **`mergeLeads_`** skips the rewrite when the final rows equal the sheet as
  read, cell for cell (`leadRowsUnchanged_`). A changed lead, a new lead, a
  reordered sheet or a legacy Date cell (which still needs healing to text)
  all still get the full write-then-trim. The meeting-report guard runs
  before the comparison, so it is unaffected.
- **Digest rebuild after a request** (`refreshDigestBestEffort_` →
  `rebuildActivePatientsDigest_({ skipIfUnchanged: true })`). The rows are
  still recomputed in full every time. When they equal what the tab holds,
  the write is skipped. How the tab's content is tracked:
  `digestSignature_` is an order-insensitive hash of the spreadsheet id plus
  each row's `house`/`patientName`/`patientId`. `updatedAt` is excluded
  because it is the rebuild time, not content. `writeDigestRows_` forgets the
  old record **before** writing, so a half-failed write can never cause a
  later skip. It records the new one only **while holding the lock**. The
  hourly backstop and setup always write. `DIGEST-CONTRACT.md` now says that
  `updatedAt` keeps the time of the last write and is never more than about
  an hour old.
- **Timing** helpers `perfStart_` / `perfLap_` / `perfEnd_`: fail-soft, and a
  broken `Logger` never breaks a request (tested).

### Browser (`public/app.js`)

- `loadAll` starts **getData, getPayments and getCredits together**
  (`startTimedRead`: `Promise`-based, never rejects, so a read nobody has
  awaited yet can't become an unhandled rejection). State is applied in the
  same order as before. getPayments/getCredits failures, including a row that
  breaks normalization, are still fail-soft. A getData failure still fails
  the load with the same Hebrew message.
- One `[E-ZONE][perf] loadAll …` console line per load.

### Service worker (`public/sw.js`)

`CACHE_VERSION` `v16` → **`v18`**. v17 is skipped on purpose: it was PR #145's
version, #146 reverted it, and phones still hold a v17 cache. The hunk is
byte-identical to PR #148's, so the two PRs merge in either order without a
conflict. The **next** `public/` change must use **v19**.

## Before / after — estimated wall time

These are **estimates**: the measured call counts above multiplied by
per-call costs typical of Apps Script on a live sheet. The log lines will
give the real figures.

| Assumed cost per call | |
|---|---|
| Web-app round trip incl. execution start (browser → Railway → `/exec`) | 0.8–1.5 s |
| `getValues` | ~75 ms + ~10 ms per 1,000 cells |
| Whole-column `setNumberFormat` | 30–80 ms |
| `getSpreadsheetTimeZone` | 5–20 ms (most uncertain: it may be cached by the runtime) |
| `getProperty` | 10–30 ms |
| `tryLock` | 20–50 ms free; **up to 10 s** while a save holds the lock |
| `openById` | 0.3–1 s |
| Cache get / put / remove | 5–20 ms |

| Operation | Before | After | Why |
|---|---|---|---|
| getData | ~5 s (~3 s if the timezone call is cached) | **~1.7 s** | 0 timezone calls, 0 formats, 6 reads instead of 9 |
| getPayments | ~4 s (+ up to 10 s during a save) | **~1.6 s** | 1 read instead of 4, no formats, no lock |
| getCredits | ~1.6 s | **~1.2 s** | 1 read, no formats |
| **Page load** | **~11 s** (sum of the three) | **~2 s** (the slowest of the three + render) | parallel fetches + the above |
| Save, patient edit | ~9 s | **~5 s** | no Leads rewrite, 1 timezone call instead of 201, no digest write |
| Save, lead edit | ~9 s | **~5.3 s** | as above, plus the one needed Leads write |

The remaining save time is mostly the six whole-sheet passes in
`replaceHousePatients_` (follow-up 1).

## Why each change is safe

- Reads no longer write, and every write path still applies the formats before
  it writes. The formats are sheet state; once applied they stay, and nothing
  on a read path depended on re-applying them.
- Every backfill still runs whenever its original criterion holds. Only a
  sheet with nothing to heal skips it. For Payments the pre-scan is stricter
  in one case only: an orphan that can never resolve. The fill logic, the
  lock, the 1,000-cell cap and "never overwrite a filled cell" are untouched.
- The cache holds hashes, only decides whether to look closer, is dropped
  after every Patients write, and is TTL-bounded for hand edits.
- A Leads rewrite is skipped only when it would write exactly what the sheet
  already holds.
- A digest write is skipped only when the tab already holds exactly those
  rows. The record is kept honest across failures and missed locks, and the
  hourly rebuild always writes.
- The client makes the same three reads with the same handling; only the
  start time moved.

## Tests

`test/dashboard-load-perf.test.js`, 45 tests, grouped A–H: getData_,
getPayments_, getCredits_, cache invalidation, mergeLeads_ skip, digest skip,
small wins and logs, client `loadAll`. Plus the SW version pin.
**Mutation-checked:** each of 27 deliberate regressions (one per optimisation
and guard, e.g. back to `getOrCreateSheet_`, orphan pre-scan made imprecise,
no invalidation, no before-snapshot, order-sensitive signature, sequential
`loadAll`, raw rejections) fails at least one test.

Harness-only updates to existing tests (no assertion changed its meaning):

- `test/coordinators-patients-digest.test.js`: stubs the new read accessor
  `sheetForRead_` next to the `getOrCreateSheet_` stub it already had.
- `test/occupancy-snapshots.test.js`: adds `sheetValues_` and
  `rowsFromValues_` to its function allowlist, since `readSheet_` is now built
  from them.
- `test/date-format-he.test.js`: the pin `v === 'v16'` becomes `>= v16`. This
  is identical to PR #148.

The full suite (including the Playwright browser tests) is green.

## Not changed / follow-ups

1. **`replaceHousePatients_` passes.** A save runs one pass per house (6). Each
   pass calls `getOrCreateSheet_` (4 whole-column formats) and rewrites the
   whole Patients sheet. One pass, or a per-execution "already formatted" memo,
   would save roughly another 1.5–2 s per save. It was left alone here because
   PR #148 changes this function.
2. `saveAll_`, `backfill*Locked_` and `writeDigestRows_` ignore `tryLock`'s
   result, so on a 10 s timeout they proceed without the lock. This is
   pre-existing and changing it is a behaviour change, not a speed-up. The
   digest record now respects the result.
3. `accountingPayments_` (external feed) still uses `getOrCreateSheet_` and
   reads Payments twice. It gains the precise pre-scan automatically. The same
   single-read pattern can be applied there.
4. Caching `getData_` itself was not done: its invalidation would have to
   cover hand edits and the Managers app's writes, which a TTL alone does not
   make safe.
