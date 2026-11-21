# ManagersHouse publication v1 — paired producer/reader contract

Companion to Dashboard #331 and Coordinators #360 / draft #362. This is the
consumer-first contract for the existing shared-roster package. Work owns the
Coordinators producer; central owns this Dashboard reader. No activation is
authorized by this document. The existing business columns and house scopes stay
unchanged. This document must be copied/referenced by the producer implementation.

## Opt-in and workbook

Dashboard Script Property `MANAGERS_DIGEST_REQUIRE_MANIFEST` enables strict reads
only when its trimmed value is `true`. Unset/other values preserve the legacy
reader. `MANAGERS_DIGEST_SHEET_ID` still selects the same read-only workbook.
Strict mode never falls back to the legacy cache or uncertified tables.

A new dedicated tab `ManagersPublication` holds one JSON string in A1 (maximum
12,000 characters). No existing table/header is renamed or reordered. Ready JSON:

```json
{
  "schema": "managers-house-v1",
  "state": "ready",
  "publicationId": "unique-publication-id",
  "publishedAt": "2026-11-20T08:00:00.000Z",
  "source": {"revision": 2, "token": "64-lowercase-hex-characters"},
  "tables": {
    "shifts": {"rows": 10, "columns": 6, "sha256": "64-lowercase-hex-characters"},
    "staff": {"rows": 8, "columns": 9, "sha256": "64-lowercase-hex-characters"},
    "therapistWeek": {"rows": 4, "columns": 6, "sha256": "64-lowercase-hex-characters"}
  }
}
```

The example hash/token strings are descriptive placeholders, not valid values.
Exact object keys are required at every level. `publicationId` is unique for
every attempt, including retries, and matches `[A-Za-z0-9_-]{16,100}`. The producer
must never reuse it or restore an older manifest (no ABA transition).
`publishedAt` is a canonical UTC ISO timestamp with milliseconds and no more
than five minutes in the future. `source.revision` is a nonnegative even safe
integer; token is the ready source generation's lowercase SHA-256 token. The
source generation must stay ready and unchanged through publication.

`tables` has exactly `shifts`, `staff`, `therapistWeek`, mapped to existing
`ManagersShifts`, `ManagersStaff`, `ManagersTherapistWeek`. `rows` counts data
rows (excluding the header), integer 0..50,000. `columns` is the persisted grid
width, integer 1..64. The complete persisted rectangular grid, including its
header and appended columns, must match both dimensions and hash. Headers must
be nonempty unique strings; existing mandatory columns are required by name.
The optional `startDate` column remains optional. New columns are ignored in the
public team projection, but are covered by the hash. Header-only certified
tables are valid empty tables; missing or cleared tables are never valid empties.

## Canonical hash (both sides)

Use SHA-256 UTF-8 over `JSON.stringify` of the full rectangular grid after
mapping each cell to a tagged pair. No trimming, sorting, or Unicode
normalization occurs before hashing:

| Persisted `getValues()` value | Canonical pair |
| --- | --- |
| string | `["s", value]` |
| null / undefined (empty) | `["s", ""]` |
| finite number | `["n", String(value)]` |
| boolean | `["b", value]` |
| valid native Date | `["d", value.toISOString()]` |

Reject any other value or invalid Date. Hash output is 64 lowercase hexadecimal
characters (Apps Script signed bytes must be normalized before hex conversion).
Hash the actual persisted readback, not pre-write objects. This protects literal
apostrophes, leading-zero phones, Hebrew, empty cells and native dates without
conflating a numeric cell with text. The producer must additionally verify the
readback against intended values, using plain-text formats and formula guards;
it must not certify formula evaluation or accidental phone/date coercion.

## Producer order (Work / Coordinators; not implemented by this consumer PR)

1. Prepare all three tables from one ready source generation. Serialize exports
   with the source ScriptLock and recheck the generation under that lock.
2. Write `{schema:"managers-house-v1",state:"pending",publicationId:NEW_ID}` to A1,
   flush, and read it back exactly **before any destination table mutation**.
3. Rewrite all three tables. Read them back, validate intended content/headers,
   and compute counts/hashes using the canonical form above.
4. Recheck the same ready source generation. Write the complete ready manifest
   last, flush, and verify exact readback. Release the lock.

Any failed, uncertain or interrupted write leaves the publication pending. Do
not restore an old ready manifest over modified tables. A retry uses a new ID
and rewrites a complete publication. No table mutation is permitted while its
old ready manifest remains published.

## Reader order and cache (Dashboard)

Open the configured workbook and read/validate a ready manifest first. Verify
the entire three-table publication against that manifest before mapping rows.
Reread the exact A1 JSON string after all reads; only an unchanged ready manifest
can return/caches `available:true`. Missing/pending/invalid/unreadable/changed
publication returns `available:false` with no partial rows.

Strict cache namespace is separate from `mw:team-digest:v1`; key it by SHA-256
of workbook ID + newline + exact manifest JSON, TTL 300 seconds. Cache entries
include that exact manifest and the certified data. Even a hit requires two
live manifest reads, before and after retrieving the cached data. An unavailable
workbook, pending manifest or new publication must not reuse an older cache.
`updatedAt`/the existing two-hour stale indicator use `publishedAt`, not the
newest individual row's timestamp. Existing house filtering/sanitized output
remains in `mwTeam_`; no source token, hashes or new fields reach the UI.

Reason codes: `not_configured`, `unreadable`, `pending`, `contract_mismatch`,
`publication_changed`. A failure has no success-cache write. The entry point
catches sheet/cache/hash read failures and fails closed.

## Acceptance and activation boundary

Consumer tests cover certified/noncertified empties, pending/missing/bad
manifests, mixed publications at each table boundary, changed manifests on
cache hits, count/hash/header corruption, workbook swaps, canonical values,
house filtering and legacy-off behavior. They use synthetic producer fixtures,
not a claim that the unimplemented real producer passes end-to-end.

Before any activation, Work must implement the paired publisher and run the
real producer + real reader against one isolated workbook, including injected
write failures and simultaneous publishers. Approve/deploy the compatible reader
first, then enable strict mode only with a verified ready publication. No flag,
sheet, production data, schedule or deployment changes are made in this PR.
Rolling back to the legacy reader is unsafe while identity-changing publication
continues; pause it and review the paired rollback rather than disabling the gate.
