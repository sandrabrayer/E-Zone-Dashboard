# CHANGELOG — CRM docs: B0 aligned to the coordinators build (`actor` / `house` / `actorUserId`) + D17 landed

**Date:** 2026-10-27 · **Type:** docs only (no runtime change)

## What changed
- **`docs/crm/ROLLOUT.md` B0 / B0-coord aligned to what was built** in
  [ezone-coordinators #337](https://github.com/sandrabrayer/ezone-coordinators/pull/337):
  - **Field names:** `actor` + `house` on every coordinators → Dashboard call; `actorUserId`
    inside the coordinators app. This replaces the earlier `coordUserId` / `coordHouse`.
  - **Wire contract table:**
    - discharge: `user:<id>`, or `rakaz:<house>` / `admin`, with the session house (or `*` for
      an admin session);
    - background and editor feed runs: `system:<job>` + `*`.
  - **What B0 will enforce** (Sandra, 2026-10-27):
    - `system:*` + `*` is accepted **only** on the two read-only feeds;
    - a discharge is refused for a `system:*` actor, for `*` from a non-admin, and for a patient
      outside the asserted house.
  - **Code-login discharges** (`rakaz:<house>`) are accepted for now; **Phase 3a makes personal
    logins mandatory for discharge**.
  - The paste-in prompt is replaced by a short "built" record that links #337.
- **D17 and the B0 pair order land here.** Commit `3a0e723` was pushed after #284 had merged, so
  these never reached the deploy branch. It brings:
  - D17: ezone-managers' five writes retire in Phase 3c;
  - D15 corrected to "no NEW write path";
  - the B0-coord → B0 order;
  - the permissions-matrix updates.

  The deploy branch is merged in (no force push).
- `test/crm-spec-docs.test.js` pins:
  - the new B0-coord heading;
  - the `actor` + `house` / `actorUserId` names;
  - the `system:*` read-only rule;
  - the Phase 3a note.

## Not changed
No code, Apps Script, env var, Script Property, schema or service-worker change. B0 itself is
not built yet.

## Tests
`npm test` green; `npm audit` 0 high/critical.

## Security
Names of fields and variables only; no secrets or values.
