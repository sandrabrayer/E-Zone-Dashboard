# Revert of PR #206 (write-path hardening C — leads)

Branch `claude/revert-write-path-hardening-leads` off
`claude/build-ezone-dashboard-QOg5s`. **Railway + Code.gs** (clasp CI on merge).

## Why

PR #206 merged as `24b30ef`. CI was green and the «Deploy Apps Script» run
was green (the redeploy step's `Deployed …@<version>` guard passed), but
Railway's public service never served it:

- GitHub deployment statuses for `24b30ef`: `zucchini-hope / production`
  went `in_progress` (13:37:10Z) → `inactive` (13:37:44Z) with no
  `success`; `believable-connection / production` reported `success`.
- `https://ezone-dashboard.up.railway.app/api/version` stayed on
  `ec5a8a1` (PR #205) for the full 10-minute window.

The run's rule is that any failed verification is reverted. Production was
running the PR B client against the PR C Apps Script (a compatible pair —
every PR C server change is additive), and this revert realigns both on the
PR B tree.

## What

`git revert -m 1 24b30ef`. The resulting tree is byte-identical to
`ec5a8a1` (PR #205) plus this file. SW `CACHE_VERSION` stays **v51**, the
version production serves (v52 was never served). `npm test` 2596 / 2596.

## Follow-up

PR C is re-landed in a new PR once this revert is verified on Railway
(see `CHANGELOG-write-path-hardening.md`). No manual step.
