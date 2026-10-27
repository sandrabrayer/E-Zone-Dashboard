# CHANGELOG — CRM restructure, Session A: spec + read-only investigation

**Date:** 2026-10-27 · **Type:** docs only (no runtime change)

## What changed
- New `docs/crm/` with six documents:
  - `SPEC.md`: Sandra's Hebrew CRM spec, verbatim, plus a "Decisions" header (D1–D4):
    - Ron is ניהול בית only, with no Dashboard access.
    - «מטופלים משוחררים» stays Vered's tab.
    - Manager logins are the current ezone-managers passwords, carried over.
    - Ortal is a verifier role, not הנהלה.
  - `CURRENT-STATE.md`: a read-only map of what exists today:
    - every tab, modal and Apps Script action
    - the scheduled jobs
    - every sheet and its columns
    - every secret-gated feed (names only)
    - active / dormant / dead status for each item
    - the state of Dashboard PR #220, Outpatient PR #114 and OP-03 (Outpatient #125), with the
      overlap risk
  - `PERMISSIONS-MATRIX.md`: per spec §11, built from the server checks in `server.js` / `lib` /
    `Code.gs`, with every UI-only hiding flagged.
  - `LINKED-APPS.md`: per spec §12, the nine questions for each linked app. Unknowns are marked,
    not guessed.
  - `GAP-LIST.md`: spec §4–§10 rated exists / partial / missing, with UI-only work kept apart from
    infra, plus the dark-vs-light theme impact.
  - `ROLLOUT.md`: the proposed PR sequence for Session B (Activity foundation, append-only, no UI)
    and Session C (CRM shell behind `?view=crm` + `CRM_ENABLED`, default off).
- `EZONE-ECOSYSTEM-STATUS.md`: a 5-line "CRM restructure — Session A" section.

## Not changed
- No change to code, Apps Script, sheets, schema, the service worker (stays v93), routes, env vars or secrets.
- PR #220, Outpatient #114 and OP-03 were only read, never edited.

## Tests
- `test/crm-spec-docs.test.js`: a guard that the six docs exist and that `SPEC.md` keeps its
  Decisions header and verbatim spec.
- Full suite: `npm test` green.

## Security
- No secrets, no secret values, and no personal data in the docs. Secret and Script Property
  **names** only.
- The investigation surfaced security findings. They are documented in `CURRENT-STATE.md` §8 and
  not fixed here:
  - `PROXY_SECRET_MODE=log` with an anonymous web app
  - restricted `getData` is not field-filtered
  - the legacy `/api/outpatient-lead` body
  - `/meeting-report` is not house-scoped

  Each needs its own scoped PR and Sandra's go.
