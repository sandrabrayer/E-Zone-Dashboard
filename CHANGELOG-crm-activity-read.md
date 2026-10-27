# B3 — `getActivity`: the permission-filtered timeline read (no UI) — 2026-10-27

CRM restructure, Session B (`docs/crm/ROLLOUT.md` §B3; SPEC §7, D5/D11/D16). Read-only; no
consumer yet (Session C's side panel reads it). Nothing changes on any screen.

## The action
`POST action=getActivity { leadId? | patientId? | personId? | paymentUid?, limit? }` →
`{ ok, scope, total, events: [{ eventId, occurredAt, recordedAt, kind, source, actorName, leadId,
patientId, personId, paymentUid, dischargeId, houseId, summary, details, supersedesEventId }] }`.
At least one subject id is required (`missing_subject`); newest first; `limit` 1–500 (default 200);
`total` is the unlimited count. `details` is the parsed `detailsJson` (`{}` when unparseable).
`actorId` (session labels) is never served. A read never creates the sheet.

## Gate — same as `expectedDischarges`
`PROXY_SECRET` (not an open action) **and** a verified personal session, refused **even in `log`
mode**: unverified → `unauthorized`; a verified non-personal session (shared login, a sibling proxy)
→ `forbidden`. Added to `PROXY_KNOWN_ACTIONS`, `CONTROLLER_ACTIONS` (Code.gs = lib, pinned) and
`lib/role-scope.js ALL_USERS_READ_ACTIONS` (server.js `requireExpectedDischargesView` covers it).

## Scope — cut ON THE SERVER by the actor's caps (`actorCaps_`)

| Who | caps | `scope` | Kinds | Fields |
| --- | --- | --- | --- | --- |
| Vered, Sandra | `finance` | `full` | all | all public fields |
| Ortal (controller) | `billingControl` only | `money` | `payment_*`, `refund_*` only | `leadId` **absent** (D11: no lead data) |
| Dana / any personal session with no caps | — | `no_money` | all except `payment_*` / `refund_*` (D5, D16) | all public fields |

A field a scope may not see is absent from the object, never blank. Ortal's controller lock is
unchanged: `getActivity` is appended to her allow-list, every other action stays refused.

## Files
`apps-script/Code.gs` (`getActivity_`, `activityProject_`, `activityScope_`, dispatch, three
lists — clasp CI on merge), `lib/finance-scope.js`, `lib/role-scope.js`, `server.js` (log label
only), `test/activity-read-scope.test.js` (10), pinned-list tests updated, ESS, ROLLOUT §B3.
No frontend, no SW bump, no schema change, no secret, no Railway variable.

## Rollback
Revert. No UI consumer.
