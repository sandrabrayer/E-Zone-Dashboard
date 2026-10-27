# B0 — coordinators' discharge write → own house only (2026-10-27)

CRM restructure, Session B, first code PR (`docs/crm/ROLLOUT.md` §B0; SPEC D12 / D13).
Pair of [ezone-coordinators #337](https://github.com/sandrabrayer/ezone-coordinators/pull/337)
(merged and deployed first: every coordinators → Dashboard call now carries `actor` + `house`).

## Gap closed
`recordDischargeFromCoordinators` accepted a discharge for **any** patient of any canonical house:
the shared secret authenticated the coordinators app, not the person or the house. A coordinator
of one house could release a patient of another.

## What the Dashboard enforces now (Code.gs only)
Before the lock, from the pair the coordinators server builds from its **signed session** (never
a client field) and sends next to the secret:

| Case | Answer | Written |
| --- | --- | --- |
| `actor` missing, malformed, or not `admin` / `user:<id>` / `rakaz:<house>` | `actor_not_allowed` | nothing |
| `actor` is `system:<job>` (a job never discharges) | `actor_not_allowed` | nothing |
| `house` missing or not a known house id (aliases such as `hapardes` → `pardes` resolve) | `forbidden_house` | nothing |
| `house` is `*` and the actor is `rakaz:<house>` | `forbidden_house` | nothing |
| the patient's canonical house ≠ `house` (checked under the lock, before idempotency) | `forbidden_house` | nothing |
| own house, or `*` from `admin` / `user:<id>` (only an admin session is marked `*`) | as before | discharge |

Every refusal answers a Hebrew `message` («… דבר לא נשמר.») and writes one `AuditLog` row
`coord_discharge_refused` with ids, actor and house only — no patient name, no phone. The success
audit row now also carries `actor` + `house`.

The two read feeds (`getPatientsForCoordinators`, `getCommitteesForCoordinators`) are untouched:
they are allow-listed projections and keep serving whatever pair arrives (`system:*` + `*` is their
normal shape).

## Decisions recorded (Sandra, 2026-10-27)
- `system:*` + `*` is accepted only on the two read-only feeds.
- Code-login discharges (`rakaz:<house>`) stay allowed for now; Phase 3a makes personal logins
  mandatory for discharge, after which only `user:<id>` / `admin` may write.
- Phase 4 moves this write behind the ניהול בית shared-discharge endpoint.

## Files
- `apps-script/Code.gs` — `coordActorInput_`, `coordDischargeActorRefusal_`, `coordRefuse_`,
  `COORD_REFUSAL_MESSAGES`; the two checks in `recordDischargeFromCoordinators_`. Ships via the
  clasp CI on merge (existing deployment, same `/exec` URL).
- `test/coordinators-discharge-own-house.test.js` (new, 10 tests); `test/coordinators-roster.test.js`
  and `test/duplicate-discharges.test.js` send the pair.
- `docs/crm/ROLLOUT.md` §B0 marked built; `EZONE-ECOSYSTEM-STATUS.md`; `DEPLOY.md`.

No frontend file, no SW bump, no schema change, no new secret, no Railway variable.

## Rollback
Revert the PR. The coordinators app keeps sending fields the old code ignores.
