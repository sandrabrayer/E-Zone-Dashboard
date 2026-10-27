# CHANGELOG — CRM restructure, Session A follow-up: #220 decision + permission decisions D5–D17

**Date:** 2026-10-27 · **Type:** docs only (no runtime change)

## What changed
- **PR #220 closed as superseded** (Sandra's decision). Branch `codex/crm02-read-projections-20261013`
  is kept at `a63c477`. Later CRM PRs will cherry-pick:
  - the archive-aware lead reader, **with** the numeric-ID fix;
  - the task-queue rules (close only on fresh complete evidence; keep the original deadline).

  **No PostgreSQL.** Recorded in:
  - `docs/crm/ROLLOUT.md` §0.1 and §7
  - `docs/crm/CURRENT-STATE.md` §7
  - `EZONE-ECOSYSTEM-STATUS.md`
- **`docs/crm/SPEC.md` Decisions D5–D12**, Sandra's answers to the eight PERMISSIONS-MATRIX §6
  questions:
  - D5: Shiran and Yael removed; Dana read-only, with no money screens.
  - D6: coordinators get no Dashboard access; their only view is the own-house roster in ניהול בית.
  - D7: discounts are Sandra only.
  - D8: refund decision = Sandra, execution = Ortal, never the same person.
  - D9: prices are Sandra only (not built).
  - D10: Therapists keeps the 730-day alumni phones, plus a per-read access log.
  - D11: Ortal's seen / not-seen field set.
  - D12: manager identity via ניהול בית; full text confirmed (D15): never a client-supplied house.
    Corrected: ezone-managers never gets a NEW write path, and its existing five writes retire in
    Phase 3c.
- **D13–D16**, Sandra's answers to the follow-ups:
  - D13: the coordinators' discharge write becomes own-house only. This is a security gap, fixed in the
    first Session B code PR: ROLLOUT **B0** added.
  - D14: rule-based refunds are Sandra's standing decision; only exceptions need her approval; Ortal executes.
  - D15: D12 completed and corrected (no NEW write path).
  - D17: ezone-managers' five writes (family calls, staff talks, events, expected discharges,
    feedback) keep working until Phase 3c. They then move to ניהול בית with the bonus card, and
    ezone-managers goes read-only.
- **ROLLOUT B0 ships as a pair:**
  - first **B0-coord**: the coordinators app sends the verified user + house next to the shared
    secret, and the Dashboard ignores them;
  - then the Dashboard **B0** enforces them.

  The coordinators-side prompt is written into ROLLOUT.
  - D16: Dana is all houses, read-only, and may export חתכי מטופלים without money columns; no money exports.
- **`docs/crm/PERMISSIONS-MATRIX.md`** rewritten around D5–D17:
  - Shiran and Yael rows removed; a Dana row added.
  - Each changed permission is marked *today → decided* (🟨).
  - §5 lists the server work each decision needs.
  - §6 records the answers plus four follow-up questions.
  - §7 is the **revoke list** for the existing Shiran/Yael entries: the Railway `USER_PIN_HASHES`
    records, `lib/users.js`, Code.gs `CREATE_LEAD_ASSIGNEES`, `app.js` `ASSIGNEE_OPTIONS`, and
    open leads assigned to them.
- `docs/crm/ROLLOUT.md` §0.4 is marked decided. The B3 and "Later" items now point at the
  decisions.

## Why a follow-up
The #220 edit was first pushed to PR #283 after it had merged (`3b74ec9`), so it never reached the
deploy branch. This PR lands it, together with the decisions.

## Not changed
No code, Apps Script, Railway variable, Script Property, schema or service-worker change. None of
D5–D12 is implemented yet. Shiran and Yael are **not** revoked by this PR: Sandra does that in
Railway (PERMISSIONS-MATRIX §7).

## Tests
- `test/crm-spec-docs.test.js` now also pins:
  - D5–D16 in SPEC.md, the full D12 text and the ROLLOUT B0 entry;
  - no Shiran/Yael identity rows in the matrix;
  - the revoke list.
- Full `npm test` green.

## Security
- No secrets or values. Names of variables only.
