# CHANGELOG — Read cache: generations + settle-time invalidation (review F1 / F2)

Date: 2026-10-29 · Branch `claude/read-cache-generations` → base `claude/build-ezone-dashboard-QOg5s`
Source: Sandra's work package «EZONE-CRM-Claude-Work-Package-20261029-v2», §3 (fix before any more design).
Fixes the cache merged in PR #320 (`CHANGELOG-crm-read-cache.md`). No permission or money rule changes.

## The defects (reproduced first, as failing tests)

- **F1** — `bust()` cleared stored answers but not reads **in flight**: a read that started before a
  save could be joined by the read-after-save and, when it finally resolved, store its pre-write
  answer. Reproduced: the read-after-save and the next read both returned «before-save», zero fresh
  fetches.
- **F2** — invalidation happened only when a write **started**: a read that started during the
  write stored a pre-write snapshot that a later read reused. Reproduced the same way.

## The fix (`lib/read-cache.js`, `server.js`)

1. **Generations.** `bust()` advances a generation counter. A read records the generation it
   started in; a newer read never joins an older in-flight read; an older read's answer is
   returned to its own caller but **never stored**; its late cleanup never deletes a newer
   in-flight entry for the same key.
2. **Bust at start AND at settle.** `POST /api/sheets` busts before the upstream call and again in
   a `finally` — success, refusal, or an ambiguous network failure where the upstream may have
   committed. `/api/outpatient-lead` and `/api/meeting-report/submit` bust on `finish` as well.
   No write is ever retried automatically.
3. Unchanged: per-actor / per-scope keys (the secret is never part of the key), failures never
   cached, `SHEETS_READ_CACHE_MS=0` disables, 30 s TTL.

## Bounded staleness that remains (documented, by design)

- A write made by **another app directly in Sheets** (managers, therapists, outpatient) is seen up
  to 30 s late on the CRM.
- The cache is **per Node process**: with more than one Railway replica, a bust on one replica is
  not a bust on the other. Today the service runs one replica; if that changes, lower the TTL or
  set `SHEETS_READ_CACHE_MS=0`.

## Tests

`test/read-cache-generations.test.js` (5): F1 and F2 against the real module; the same scenarios
against the **pre-fix module kept as a fixture** (`test/fixtures/read-cache-prefix.js`) prove they
were real races; new-generation-completes-before-old; actors / TTL 0 / expiry / failed read / the
server wiring. The 3 existing cache tests stay green. Full suite: 3616 pass / 0 fail.

## Rollback

Revert this PR (one commit). The pre-fix behaviour returns with its races; `SHEETS_READ_CACHE_MS=0`
disables the cache entirely without a deploy.
