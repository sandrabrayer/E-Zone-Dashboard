# CRM restructure — rollout (Sessions B and C)

**Session A, 2026-10-27. This is a proposal, not an approval.**

Each PR below is opened as a **draft**. Merge, deploy and any production permission change each
need Sandra's separate go (spec §14). The repo's CLAUDE.md rules apply to every PR:
- base = `claude/build-ezone-dashboard-QOg5s`
- one PR at a time
- explicit-path `git add`
- tests + CHANGELOG + docs in the same PR
- `npm audit` with 0 high/critical
- SW bumps monotonic from the **live** version

Spec §14 separation, applied here:
- **Session B** changes data and infra only. No UI.
- **Session C** changes UI only, behind a default-off flag, with no schema change.
- No PR mixes the two. No PR in B or C writes to another app.

---

## 0. Decisions needed before Session B starts

| # | Decision | Why it blocks |
| --- | --- | --- |
| 0.1 | ✅ **DECIDED 2026-10-27: PR #220 (CRM-02) is closed as superseded** by this CRM restructure. Its branch `codex/crm02-read-projections-20261013` is kept at `a63c477`. Later CRM PRs will cherry-pick two things from it: (1) the archive-aware lead reader, **with** the numeric-ID fix, and (2) the task-queue rules (close only on fresh complete evidence; keep the original deadline). **No PostgreSQL.** | Spec §2/§14: no parallel mechanism. Session B no longer depends on #220. Analysis: **§7**. |
| 0.2 | **When to turn on `PROXY_SECRET_MODE=enforce`** (Phase 0b-3; needs the Managers / Therapists / accounting-feed checks first) | Until then, any server-side CRM permission can be bypassed through `/exec` (CURRENT-STATE §8.1). Recommendation: before C goes to a pilot with real users, not before B. |
| 0.3 | Activity scope: which event kinds, whether free-text notes may hold clinical content, who may read which kinds | Shapes B1's columns and B3's filter |
| 0.4 | ✅ **DECIDED 2026-10-27:** the PERMISSIONS-MATRIX §6 questions and follow-ups are answered by SPEC D5–D16 (Shiran and Yael removed, Dana read-only with no money; coordinators no Dashboard; discounts Sandra; refund decision Sandra / execution Ortal; prices Sandra; Therapists 730 days + access log; Ortal's field set; managers via ניהול בית, never a client-supplied house; coordinators' discharge own-house only (D13); rule-based refunds automatic, exceptions Sandra (D14); Dana all houses with a no-money חתכי מטופלים export (D16)). D17: ezone-managers' five writes retire in Phase 3c. No permission item remains open. | Needed before C2's area gating. **Not** needed for B. |

Nothing in B or C edits OP-03 (Outpatient #125), Outpatient #114 or PR #220.

---

## Session B — Activity sheet foundation (append-only, no UI)

### B0 · Security gap first: coordinators' discharge write → own house only (D13)

This is the **first Session B code PR** (SPEC D13). It comes before B1.

**Status (2026-10-27): built** — see `CHANGELOG-coordinators-discharge-own-house.md` (B0-coord #337 merged and its Code.gs deployed first). Refusal codes as shipped: `actor_not_allowed`, `forbidden_house`; refusals are audited to `AuditLog` (`coord_discharge_refused`), ids only.

**It ships as a pair, in this order (confirmed by Sandra, 2026-10-27):**
1. **B0-coord**, in the ezone-coordinators repo (deploy branch `main`), merges and deploys first:
   [ezone-coordinators PR #337](https://github.com/sandrabrayer/ezone-coordinators/pull/337).
   Every call the coordinators app makes to the Dashboard Apps Script sends `actor` + `house` next
   to the shared secret. The Dashboard **ignores** both at this point. Its handlers for the three
   coordinator actions read only `secret`, `id`, `dischargeDate`, `by`, `reason` and `range`, so
   nothing changes in behaviour.
2. **B0**, in this repo, merges only after B0-coord is confirmed live (Railway **and** the manual
   coordinators "Deploy Apps Script" run). It enforces the rules below.

**The wire contract (as built in B0-coord):**

| Coordinators call | `actor` | `house` |
| --- | --- | --- |
| `recordDischargeFromCoordinators` (a user's «שחרור») | `user:<id>` for a personal login, else the session label `rakaz:<house>` / `admin` | the session house as a Dashboard id (`ramot`, `raanana`, `efroni`, `rehab`, `pardes`; `hapardes` → `pardes`), `*` for an admin session |
| `getPatientsForCoordinators` (background `patientListSync`) | `system:patientListSync` | `*` |
| `getCommitteesForCoordinators` (editor runs only) | `system:committeePreview` / `system:committeeImport` | `*` |

On the coordinators side, `house` is derived from the session-built `by`. The personal user id is
`req.authSession.u`, forwarded internally as `actorUserId`. Neither is ever read from a client field.

**What B0 enforces (Sandra, 2026-10-27):**
- `actor: 'system:*'` with `house: '*'` is accepted **only** on the two **read-only** feed actions
  (`getPatientsForCoordinators`, `getCommitteesForCoordinators`).
- `recordDischargeFromCoordinators` is **refused** when:
  - the actor is `system:*`, or
  - the house is `*` and the actor is not an admin (`admin` or an admin personal user), or
  - the patient's house (through the single house rule `resolveHouseId`) is not the asserted
    `house`.
- A missing or malformed `actor` / `house` is refused on the write. The two feeds keep serving
  during the transition.
- **Code-login discharges** carry `rakaz:<house>` (no personal id). Accepted for now; **Phase 3a
  makes personal logins mandatory for discharge**, and from then on B0 accepts only `user:<id>` or
  `admin` actors on the write.

| Item | Plan |
| --- | --- |
| Goal | `recordDischargeFromCoordinators` refuses a patient whose house is not the caller's **verified session house**: the feed secret plus the asserted `actor` / `house` pair (D12), never a free client field. Today it accepts any house. |
| Dependency | **B0-coord must be live first** (see the order above). Otherwise every coordinator discharge is refused. Before merging B0, confirm that real calls carry `actor` + `house`; ask Sandra for one test discharge or check the coordinators' logs. Phase 4 later moves the write behind the ניהול בית shared-discharge endpoint. |
| Files | `apps-script/Code.gs`: the `recordDischargeFromCoordinators_` actor/house check, plus the two feeds' `system:*` acceptance. `test/coordinators-discharge-own-house.test.js`. `CHANGELOG-coordinators-discharge-own-house.md`. ESS. `DEPLOY.md`. |
| Tests | Own house → discharged. Other house → refused (`forbidden_house`), with nothing written. `system:*` actor on the write → refused. `*` from a non-admin → refused. `*` from `admin` → allowed. Missing pair on the write → refused. The feeds accept `system:*` + `*`. An alias house (`hapardes`) still resolves. Idempotency unchanged (`alreadyDischarged`). |
| SW bump | **No** |
| Code.gs | **Yes**. clasp deploys on merge. |
| Rollback | Revert. The coordinators app keeps working, because it simply sends fields the old code ignores. |

### B0-coord · coordinators side — built ([ezone-coordinators #337](https://github.com/sandrabrayer/ezone-coordinators/pull/337))

The original paste-in prompt asked for `coordUserId` / `coordHouse`. Sandra's revised prompt chose
`actor` / `house` (plus `actorUserId` inside the coordinators app), and that is what was built; see
the wire contract above. Coordinators PR #337 details:
- an isolated `Code.gs` commit;
- `server.js` forwards `actorUserId` from the signed session only;
- tests pin that every Dashboard call carries `actor` + `house`;
- ⚠️ the coordinators' "Deploy Apps Script" is a manual run after merge.

### B1 · `Activity` sheet + writer helper (not wired)

**Status (2026-10-27): built** — `CHANGELOG-crm-activity-foundation.md`. Columns confirmed as proposed; `eventId` restricted to `[A-Za-z0-9:_.-]`; `details` must be a JSON object.

| Item | Plan |
| --- | --- |
| Goal | Add an append-only `Activity` sheet definition and one locked, idempotent writer `appendActivity_(event)`. **No caller yet**, so no row is written in production. |
| Files | `apps-script/Code.gs`: `ACTIVITY_SHEET`, `ACTIVITY_COLUMNS`, `appendActivity_` with dedupe by `eventId`. `test/activity-foundation.test.js`. `CHANGELOG-crm-activity-foundation.md`. `EZONE-ECOSYSTEM-STATUS.md`. `DEPLOY.md` (nothing to configure). |
| Proposed columns | To be confirmed in B1; append-only from day one: `eventId, occurredAt, recordedAt, kind, source, actorId, actorName, leadId, patientId, personId, paymentUid, dischargeId, houseId, summary, detailsJson, supersedesEventId`. `source` ∈ `manual` / `system:<fn>` / `app:<sibling>`, which gives the spec §7 split between manual and system events. |
| Tests | Header pinned and append-only (guard style like the existing header tests). Idempotency: the same `eventId` twice gives one row. Runs under the script lock. `getData` does not change shape. `handle_` does not dispatch any new action. The Code.gs invisible-chars test still passes. |
| SW bump | **No** (no `public/` change) |
| Code.gs | **Yes**. clasp CI deploys it on merge. Inert, because there is no caller. |
| Rollback | Revert the PR. No sheet exists until a writer runs, so there is nothing to clean up. |

### B2 · System events dual-written from existing writers (behind a kill switch)

**Status (2026-10-27): built** — `CHANGELOG-crm-activity-system-events.md`. Implemented as ONE hook in `logAudit_` + an allow-list map (`ACTIVITY_AUDIT_MAP`), not per-call-site edits; switch `ACTIVITY_WRITES=on`, default off.

| Item | Plan |
| --- | --- |
| Goal | Each existing state change also appends one Activity event, **best-effort**, after its primary write succeeds. Same pattern as `refreshDigestBestEffort_`: a failure is logged and never fails or reverts the primary write. Covers lead stage move, close and restore; meeting outcome and manager report; admission; discharge (Dashboard + coordinators); payment report, verify, flag and void; refund decide and paid; outpatient handoff sent / failed. |
| Idempotency | `eventId` is derived from a stable action identity, e.g. `discharge:<id>`, `rcpt:<id>:confirmed:<confirmedAt>`, or the existing `submissionId`. A retry after a failure adds no duplicate (spec §14). |
| Kill switch | Script Property `ACTIVITY_WRITES` (`on` / anything else = off). **Default off.** Sandra turns it on in the Apps Script editor (Project settings → Script properties). No Railway change. |
| Files | `apps-script/Code.gs` (call sites + the switch). `test/activity-system-events.test.js`. CHANGELOG. ESS. `DEPLOY.md` (the Script Property click-steps). |
| Tests | One event per writer, with stable ids. An injected `appendActivity_` failure leaves the primary write and its answer unchanged. Switch off means zero Activity writes. No sibling-app contract changes (the existing feed tests still pass). |
| SW bump | **No** |
| Code.gs | **Yes** |
| Rollback | Set `ACTIVITY_WRITES` to off (instant), or revert. The rows already written are harmless because nothing reads them yet. |

### B3 · Permission-filtered read: `getActivity` (no UI)

**Status (2026-10-27): built** — `CHANGELOG-crm-activity-read.md`. Scopes `full` / `money` / `no_money` by caps; subject id required; `actorId` never served.

| Item | Plan |
| --- | --- |
| Goal | One read action returning a subject's events. It requires a **verified personal session** and refuses unverified callers **even in `log` mode** (same rule as `expectedDischarges`, Code.gs:16304). The kinds and fields a role may see are filtered **on the server**: money kinds only with `finance`; Ortal limited to the billing kinds and the D11 field set; Dana per D5 (no money kinds). |
| Files | `apps-script/Code.gs` (action + filter). `lib/role-scope.js` / `lib/finance-scope.js` (classify the action). `server.js` (only if a new list entry is needed). `test/activity-read-scope.test.js`. CHANGELOG. ESS. |
| Tests | Per-role matrix (Vered, Sandra, Ortal, Dana, unverified, NO_PRINCIPAL): fields absent, not just hidden. Ortal's controller lock still holds. Healthcheck path unaffected. |
| SW bump | **No** |
| Code.gs | **Yes** |
| Rollback | Revert. The action has no UI consumer. |

---

## Session C — CRM shell behind a flag (`?view=crm` + `CRM_ENABLED`, default off)

**Invariant for every C PR:** with `CRM_ENABLED` unset or not exactly `true`, every existing
response is byte-for-byte unchanged:
- `/`, `/index.html`, `/app.js`, `/api/*`, `/healthz`, `/api/version`, `sw.js`
- `/?view=crm` is served the normal page

A test pins this.

### C1 · Flag plumbing (server only)

**Status (2026-10-27): built** — `CHANGELOG-crm-shell-flag.md`. Theme decision: the shell is **dark** (matches the live app; the light-theme ask in SPEC §3 is deferred to the «global theme switch» track). `/index.html` never serves the shell.

| Item | Plan |
| --- | --- |
| Goal | `CRM_ENABLED` (Railway env, strict `=== 'true'`, default off). When it is on **and** the session is a personal Dashboard user, `/?view=crm` serves the CRM shell page. Otherwise the current page. Names stay distinct from #220's `CRM_READS` / `/crm-work`. |
| Files | `server.js` (one guarded branch in the index route). `lib/crm-shell-flag.js` (not `lib/crm/`, to avoid #220's directory). `test/crm-shell-flag.test.js`. CHANGELOG. ESS. `DEPLOY.md` (Railway click-steps for Sandra: Variables → New → `CRM_ENABLED` = `true`. **Claude never sets it.**) |
| Tests | Flag off: identical HTML for `/` and `/?view=crm`. Flag on with no session: the PIN page as today. Flag on with a session: the shell. `/healthz` and `/api/version` unchanged. Ortal's controller lock still applies. |
| SW bump | **No.** `sw.js` is untouched. `/?view=crm` is a navigation under the existing network-first rule. C1 must prove it is cached under its own URL key and never replaces the `/` offline entry; if `sw.js` has to change, bump to **v94+ from the live version**. |
| Code.gs | **No** |
| Rollback | Unset `CRM_ENABLED` (Sandra, in Railway), or revert. |

### C2 · Shell: side menu, areas, dark theme (decided 2026-10-27), read-only over existing data

**Status (2026-10-27): built** — `CHANGELOG-crm-shell-areas.md`. Assets in `ASSETS` (hashed), not in `BUNDLE_PATHS`; browser test at 1366 / 390 px. C3's scope is now: billing follow-up and outpatient sent/failed rows, and the drawer's פגישות / חשבון / מסמכים tabs over real data.

| Item | Plan |
| --- | --- |
| Goal | The 220 px right side menu and mobile drawer. Areas היום שלי / פניות / לקוחות / יומן / גבייה / בקרה. Light tokens **scoped to the shell's own stylesheet**. Reads only existing actions (`getData`, `getPayments`, `billingControlQueue`, `expectedDischarges`). Every action button opens the **existing** modal or tab, so no new write path. Synthetic, labelled demo data only in tests (spec §14). |
| Files | `public/crm/crm.html`, `public/crm/crm.js`, `public/crm/crm.css` (new). `server.js` (static routes, hashed like the other bundles). Tests: `test/crm-shell-ui.test.js` plus one `*-browser` test at 1366 and 390 px. CHANGELOG. ESS. |
| Tests | Current UI untouched (the existing colour, token and mobile tests are unchanged and still pass). Area visibility per role mirrors the **server** gates. Every current capability is reachable (GAP-LIST §4). RTL. Loading, success and failure states. |
| SW bump | **Only if** the new assets join `BUNDLE_PATHS`. Recommended: keep them out at first (default `network` strategy), so **no bump**. |
| Code.gs | **No** |
| Rollback | Flag off, or revert. The dark UI is unaffected. |

### C3 · «היום שלי» (Vered + Ortal), the leads board/table and the client drawer, over computed lists

| Item | Plan |
| --- | --- |
| Goal | The UI-only rows of GAP-LIST: (1) Ortal's day, all from «בקרת גבייה»; (2) Vered's computed lists: meetings without an outcome, missing manager reports, billing follow-up, outpatient sent / failed; (3) the board/table toggle with kept filters, sort and scroll; (4) the client drawer showing existing fields, plus the timeline from `getActivity` (B3) when available. Due dates and next action stay "not connected" (spec §14: a working capability is marked apart from one waiting on infra). |
| Files | `public/crm/*`, tests, CHANGELOG, ESS |
| SW bump | No (same rule as C2) |
| Code.gs | **No** |
| Rollback | Flag off, or revert |

### Later (not B or C; each a separate approved track)

- A task / next-action record with due dates and owner vs assignee (decide against #220 first).
- Server-side field scoping (Ortal D11, Dana D5); Dana's read-only role; D7 discount and D8 refund-execution gates; the D10 Therapists access log; house-scoped manager access via ניהול בית (D3, D6, D12). See PERMISSIONS-MATRIX §5.
- The Outpatient continuation feed (Outpatient #114 lineage), with the createLead contract frozen while OP-03 is open.
- Hashavshevet issuance evidence.
- Person, contacts and payer entities.
- A global theme switch (GAP-LIST theme section).

---

## Summary table

| PR | Kind | Files (main) | Tests | SW bump | Code.gs | Rollback |
| --- | --- | --- | --- | --- | --- | --- |
| B0-coord | ezone-coordinators #337 (first) | every coordinators → Dashboard call | `actor` + `house` sent from the session | — | — | revert (the Dashboard ignores the pair) |
| B0 | security fix (D13), after B0-coord is live | Code.gs | own-house / other-house / `system:*` and `*` rules / missing pair | No | Yes | revert |
| B1 | infra | Code.gs | header / idempotency guards | No | Yes (inert) | revert |
| B2 | infra | Code.gs | per-writer events, failure isolation, switch | No | Yes | `ACTIVITY_WRITES` off, or revert |
| B3 | infra | Code.gs, lib/role-scope, lib/finance-scope | per-role scope matrix | No | Yes | revert |
| C1 | UI flag | server.js, lib/crm-shell-flag.js | flag off = byte-identical | No (unless sw.js changes → v94+ from live) | No | `CRM_ENABLED` unset, or revert |
| C2 | UI | public/crm/*, server.js | role areas, reachability, 1366/390 browser | No if kept out of BUNDLE_PATHS | No | flag off, or revert |
| C3 | UI | public/crm/* | computed lists, drawer, kept state | No | No | flag off, or revert |
| C4–C7 (#293–#296, merged) | UI writes | public/crm/crm.js | one-lead `saveAll`, lifecycle, admission, house-as-read edit / move / discharge; browser scenarios | No | No | flag off, or revert |
| C8 (#297, merged) | UI read | public/crm/crm.js | `billingOverview` over `debtAging` + `getPayments`; fetched once; Vered + Ortal browser scenario | No | No | flag off, or revert |
| C10 (#299, merged) | UI write | public/crm/crm.js, crm.html | the strict payment report over the shared rules + `reportPayment`; browser scenario | No | No | flag off, or revert |
| C11 (#300, merged) | UI write | public/crm/crm.js | discount / amount / settle + credits read; browser scenario | No | No | flag off, or revert |
| C12 (#301, merged) | the switch | lib/crm-shell-flag.js, server.js | `CRM_DEFAULT` rule per user / view; real-server cases; classic-link guard | No | No | delete `CRM_DEFAULT`, or revert |
| C13 (#302, merged) | UI write | public/crm/crm.js | any-cycle report, receipt edit / void; browser scenarios | No | No | flag off, or revert |
| C14 | UI | public/crm/crm.js | meetings tab over manager reports + discharge record; seen-marking; browser scenario | No | No | flag off, or revert |
| C9 (#298, merged) | UI read | public/crm/crm.js | `patientAccount` — the drawer's «חשבון» tab over the shared C8 reads; browser scenario | No | No | flag off, or revert |

---

## 7. PR #220 — reuse or close

[PR #220](https://github.com/sandrabrayer/E-Zone-Dashboard/pull/220) is "CRM-02: default-off
source reads, retained queue and Dashboard work screen". It is an open draft at head `a63c477`,
last updated 2026-10-14, branch `codex/crm02-read-projections-20261013`, base `43eba4d`.
Its paired Outpatient draft is #114 (head `4d464d5`). Source: the PR body and its file list,
read 2026-10-27. Nothing in it was edited.

### What #220 already builds

The PR changes 45 files, +3416 / −5.

| Layer | What exists in #220 | Files |
| --- | --- | --- |
| Apps Script read projections | `getCrmLeads`, contract `crm-source-v2`: active Leads plus the IDs only of both archive tabs. `getCrmAdmittedRoster` serves Outpatient #114. Both are read-only: they never create or repair a sheet. Missing or malformed archives fail closed; duplicate IDs across tabs are quarantined as partial evidence. | `apps-script/Code.gs` (+99), `test/crm/apps-script-readonly.test.js`, `test/crm/lead-archive.test.js` |
| Node source transport | Authenticated adapters that normalise Code.gs answers; a parity test pins the same four staff IDs as Apps Script. | `lib/crm/transport.js`, `read-routes.js`, `source-adapters.mjs`, `date.mjs`, `policy.js` |
| Retained work queue | An **encrypted PostgreSQL checkpoint**. Tasks survive source outages and restarts. A task closes only on fresh, complete, explicit evidence. Original deadlines are kept on reopen. The checkpoint GET runs in a `BEGIN READ ONLY` transaction. Refresh is an explicit POST: no timer, no background collector. | `lib/crm/checkpoint-postgres.js`, `checkpoint-state.js`, `queue-runtime.js`, `queue-routes.js`; `pg` moved to runtime in `package.json` |
| Work screen | Authenticated Hebrew/RTL `/crm-work` page, Dashboard leads only, behind `CRM_READS` + `CRM_QUEUE_*` (DB, key, tenant, epoch), all default off | `crm-ui/*`, `server.js` (+34) |
| Ops and CI | Source and checkpoint preflight scripts; a real-PostgreSQL CI job; a `pg_dump` / restore drill; restart drill | `scripts/crm-*`, `.github/workflows/test.yml` (+92), `test/crm/*` |
| Docs | Review response, queue integration, read projections, checkpoint review, pilot readiness | `docs/crm-*.md`, `CHANGELOG-crm-*.md`, `DEPLOY.md` |

### What Session B (and C) would duplicate

| Planned here | Overlap with #220 | Duplicate? |
| --- | --- | --- |
| B1/B2: Activity sheet + system events | #220 has no event log. It derives tasks from current source state. | **No.** An append-only history (who / when / source) is new and complementary. |
| B3: `getActivity`, a permission-filtered read | #220's `lib/crm/read-routes.js` + `transport.js` already authenticate and normalise CRM reads | **Partly.** Same pattern; the route conventions should be reused, not re-invented. |
| GAP-LIST "task / next-action record", "age never resets", "close only on evidence" | This is exactly #220's retained queue and closure rules | **Yes**, for the queue semantics. Session B does **not** build a queue (B is the Activity log only), so nothing is duplicated *in B*. The queue is in "Later". |
| C1: `CRM_ENABLED` + `?view=crm` shell | #220's `CRM_READS` + `/crm-work` page | **Partly.** Two default-off CRM screens would co-exist. The names were kept distinct on purpose (CURRENT-STATE §7.3). |
| Code.gs lead read for the CRM | `getCrmLeads` v2 (archive-aware, fail-closed) | **Yes**, if C or a later PR needs a lead projection. Reuse the archive-aware logic instead of writing a second reader. |

### The numeric-lead-ID blocker

This comes from #220's own approved, aggregate-only inspection on 2026-10-14:
- **21 of 621 lead IDs are numeric cells:** 5 on `Leads`, 16 on `לידים לא רלוונטיים`.
- #220's strict reader `crmReadRows_` rejects any non-string value. **One numeric ID makes the
  whole projection fail** with `crm_source_unavailable`. Today that would happen on every read.
- **One text ID appears on both `Leads` and `לידים לא רלוונטיים`.** #220 quarantines it as partial
  evidence; the business cause is unknown.
- **The required fix is a narrow contract change in the reader:** accept a safe non-negative
  integer as its canonical string ID, while preserving source identity and fail-closed behaviour.
  Production IDs must never be rewritten, rows never silently dropped, other fields never coerced.
  That needs a separately reviewed change. The overlap needs a business decision, not an automatic
  merge or close.
- The operating gates are also unmet: DB namespace and least-privilege role, key custody, retention
  and backup policy, staging, capacity. The base is also stale: every PR from #221 to #281 merged
  after it, including changes to `Code.gs`, `server.js` and `.github/workflows/test.yml`.

### Options

| Option | For | Against |
| --- | --- | --- |
| **(a) Rebase B on #220** (merge #220 first, then build on it) | One CRM lineage; the queue and evidence rules come for free | Session B would depend on PostgreSQL provisioning, key custody and backup policy that are not approved. B would also inherit the numeric-ID blocker and a large stale diff. B stops being "Sheets-only, append-only, no UI". |
| **(b) Cherry-pick (port selectively onto the current base)** | Keeps the reviewed ideas and code without the unmet infra | Re-review of the ported parts; #220's history is not merged |
| **(c) Close #220 now** | Simplest | Loses reviewed work (fail-closed archive-aware lead projection, closure-on-evidence rules, the PostgreSQL drills) that the later task-queue track needs |

### Recommendation: (b) cherry-pick, then close #220 as superseded — ✅ DECIDED 2026-10-27

1. **Session B goes ahead independent of #220.** B1–B3 do not touch `lib/crm/`, `crm-ui/`,
   `test/crm/` or PostgreSQL, so nothing collides and nothing is duplicated.
2. **Port, don't merge**, when a later PR needs it. Each port is a separately reviewed PR on the
   current base:
   - the archive-aware `getCrmLeads` logic, **together with the numeric-ID contract fix**;
   - the fail-closed transport and adapter pattern, for B3 / C reads;
   - the "close only on fresh complete evidence" and "keep original deadline" rules, as tests, for
     the later task-queue track.
3. **No PostgreSQL** (decided). The later task-record track uses Sheets-based retention and
   ports only #220's rules, not its encrypted PostgreSQL checkpoint.
4. **#220 was closed as superseded on 2026-10-27**, with branch
   `codex/crm02-read-projections-20261013` kept at `a63c477` as the cherry-pick source. **Outpatient #114** stays as is: it is
   observation-only, and its fate follows the Outpatient continuation track, not Session B.
5. **Decision: Sandra, 2026-10-27 (§0.1).** Sandra closed #220. These docs never edited, rebased or
   closed it, and Outpatient #114 is untouched.
