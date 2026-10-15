# Changelog — committee feed: diagnosable refusals — 2026-10-15

## Why
The coordinators «ועדות קרובות» card showed the amber «לא סונכרן מהדשבורד» notice although a
committee was saved in Managers and the CEO had set both secrets. Every failure looked the same, so
nobody could tell an unset secret from a mismatch, a missing network permission or a Dashboard that
did not answer. Diagnosis in the coordinators PR (`docs/committees.md` → «Troubleshooting»).

## What (Apps Script, READ-ONLY action unchanged otherwise)
- **`coordinatorsCommitteesAuth_`** → `'ok' | 'not_configured' | 'unauthorized'`:
  - the Script Property `COORDINATORS_COMMITTEES_SECRET` and the sent `secret` are both
    **trimmed**: a value pasted with a trailing space or newline (the common copy-paste slip
    between two Script Property screens) no longer reads as a mismatch;
  - still fail-closed (unset / blank / missing / wrong → refused, nothing read) and constant-time.
- **Refusal body**: unset here → `{ ok:false, error:'unauthorized', reason:'not_configured' }`;
  wrong / missing → `{ ok:false, error:'unauthorized' }` (unchanged). The extra field says only
  that this gate is closed to everyone; it carries no data and nothing is read.
- `coordinatorsCommitteesAuthOk_` is kept (a thin wrapper).

## Security
No new secret, property or log line. The secret is never logged or echoed. Constant-time compare
kept. `npm audit`: 0 high / 0 critical (one pre-existing moderate, unchanged).

## Tests
`test/coordinators-committee-feed.test.js` (+2): trimmed match on either side, a near-miss still
refused, a blank value = unset → `not_configured`, the refusal carries no data, constant-time compare
kept, no logging. **2959 → 2961**.

## Deploy
Code.gs deploys automatically on merge. Nothing to set.
