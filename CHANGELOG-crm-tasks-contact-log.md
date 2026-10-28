# CHANGELOG — CRM Stage 1a+1b: tasks, the contact log, Dana operational

Date: 2026-10-28 · Branch `claude/s1a-tasks-contact-log` → base `claude/build-ezone-dashboard-QOg5s`
Spec: Sandra's «הוראות האיפיון והעיצוב» §2 (permissions), §8 (contact form), §9 (weekly planning),
§11 (task record), §14 (reliability), §15 stage 1. Mapping: project doc `crm-stage0-mapping-2026-10-28`.

Data and permissions only — **no UI in this PR** (Stage 1c builds the panel over it).

## 1. The task record — `Tasks` sheet (new, Code.gs)

One row per task, created by `getOrCreateSheet_` on first use (text format forced on the id /
date / time columns so Sheets never coerces them). Columns, **append-only** from here on:

`id, kind, leadId, patientId, personId, houseId, title, reason, assignee, dueDate, dueTime,
windowStart, windowEnd, status, source, createdAt, createdBy, updatedAt, updatedBy, doneAt,
doneBy, outcome, cancelReason, contactEventId, submissionId, money`

- `id` = `task-<32 hex>` derived from the client's `submissionId` (`sub-<32 hex>`), so a double
  click or a timeout retry **cannot** create two tasks: the second call returns the existing row
  with `replayed: true` (§14). A follow-up created by `logContact` is `task-<sid>-next`.
- `kind` ∈ `call, meeting, collection, admission, discharge, continuity, review, other`;
  `status` ∈ `open, done, cancelled`; `source` ∈ `manual | contact | triage | system:<name>`.
- A task has a date (`dueDate` [+ `dueTime`]) **or** a window (`windowStart..windowEnd`, «במהלך
  שבוע נבחר») **or** neither (undated — the UI will show «קבעי תאריך», never an invented lateness).
- `money = '1'` for `kind = collection` or an explicit money flag — the scope key below.
- Subject required: at least one of `leadId / patientId / personId`. Title required (formula-only
  and blank titles are refused). Every text field goes through `leadCellText_` (formula-safe,
  length-capped).

## 2. The seven actions (all behind the `expectedDischarges` rule: PROXY_SECRET + verified personal session, even in `log` mode)

| Action | Body | Effect |
| --- | --- | --- |
| `getTasks` | `status, assignee, leadId, patientId, personId, from, to, limit` | the tasks the actor may see (scope below); a `from..to` range matches dated tasks inside it and windows that overlap it, and drops undated tasks |
| `createTask` | `submissionId, task{…}` | idempotent create; Activity `task_created` (eventId `task_created:<id>`); AuditLog |
| `completeTask` | `id, outcome?` | `status=done`, `doneAt/doneBy`; Activity `task_done` |
| `rescheduleTask` | `id, dueDate|dueTime|windowStart|windowEnd, reason?` | new date / window; Activity `task_rescheduled` with **prev and next** in details (§6 reschedule history); when the task came from a contact (`source = contact`, i.e. a date promised to the family) a `reason` is **required** (`missing_reason`) |
| `reassignTask` | `id, assignee` | Activity `task_reassigned` (prev → next) |
| `withdrawTask` | `id, reason` (≥ 2 chars) | `status=cancelled`, `cancelReason`; the **row stays** (history kept). Named `withdraw`, not `cancel`, because it is not a delete and needs no `deleter` role (`DELETE_ACTIONS` scan guard) |
| `logContact` | `submissionId, contact{leadId|patientId|personId, when?, withWhom?, channel, reason?, outcome, summary?, taskId?}, next{dueDate | days | windowStart+windowEnd | none:true + explanation}` | **one transaction**: (1) Activity `contact_logged` event (eventId `contact:<sid>`, every attempt is its own event — three calls = three events); (2) if `contact.taskId` is given, that task is completed with the contact outcome and `contactEventId`; (3) the follow-up task `task-<sid>-next` is created (`source = contact`, due = the chosen date / today + `days` (1–365) / the window) — or **none**, which requires an `explanation` (§8: no automatic 7-day default, «ללא משימת המשך» must be explained). A replay returns `replayed: true` and writes nothing |

Outcomes (`CONTACT_OUTCOMES`, §8 list): `spoke_follow_up, no_answer, call_back_later,
awaiting_decision, meeting_set, no_interest_now, bad_contact_details, stop_contact`. Channels:
`phone, whatsapp, sms, email, in_person, other`. None of them closes or deletes a lead
(`no_answer` / `no_interest_now` only record; the queues decide — §6, §8).

Every mutation goes through `taskMutate_`: lock, read the row **through the actor's scope**
(a task the actor may not see is `not_found`, never leaked), apply, stamp `updatedAt/updatedBy`,
AuditLog, Activity event. A closed task refuses further mutation (`task_closed`).

## 3. Scope (spec §2) — who sees which task

`taskVisible_(task, actor)`: `finance` → everything (Vered, Sandra); `billingControl` only
(Ortal) → **money tasks only**; otherwise (Dana) → **non-money tasks only**. The same function
filters `getTasks` and gates every mutation, so counters and lists come from one rule (§5).
Dana creating a `collection` task → `forbidden`. Ortal reaches `getTasks / completeTask /
rescheduleTask` through `CONTROLLER_ACTIONS` (appended, both lists) — she can close a
verification that waits on her, nothing else («אין לה סמכויות חדשות»).

## 4. Dana: operational, not read-only (Stage 1b — replaces Phase 2a, `CHANGELOG-readonly-role-dana.md`)

Decided in the spec: «לדנה יש הרשאה תפעולית מלאה … כולל תיעוד שיחות … הכסף מוחרג … הסינון נאכף
בשרת». Implemented on three layers, none of them the browser:

1. **Actions.** The read-only request gate is gone (`lib/readonly-scope.js` → `lib/ops-scope.js`,
   `requireReadonlyScope` removed from `server.js`, Code.gs `READONLY_*` / `forbidden_readonly`
   removed). Her writes now reach Apps Script like Vered's, stamped with her identity. The money
   actions stay refused by the gates that already existed: `FINANCE_ACTIONS` need `finance`
   (server `lib/finance-scope.js` + Code.gs `financeRefused_`), delete / void actions need
   `deleter` (`lib/role-scope.js`). She holds neither — by id, a `USER_PIN_HASHES` record can
   only take away (`OPS_USER_IDS = ['dana']`, `isOpsView`, `principalView → 'ops'`).
2. **Fields.** `opsGetDataView` (was `readonlyGetDataView`, unchanged projection): no
   `billingOverrides`, no `pay / adv / advance / price` on patients, discharged patients and
   every lead list. Activity (`activityScope_ no_money`) and Tasks (`taskVisible_`) cut the money
   kinds. `/api/me` reports `view: 'ops', ops: true` (the `readonly` key is gone).
3. **Saves.** New Code.gs `preserveMoneyFields_`: for any verified actor **without `finance`**,
   every lead / patient in a `saveAll` payload gets its money fields from the **sheet row it
   updates** (leads by id; patients by id, then by the legacy key `houseId::name::date`), and a
   row the sheet does not know gets none. She never saw those fields, so her payload's copies are
   blank or stale by construction — carrying them would wipe or rewrite a price. The response
   carries `moneyPreserved: <n>` when it applied. Vered / Sandra / shared-PIN saves are untouched.

Pages: the classic page serves her the restricted **edit** layout (no `view-readonly` class, no
forced view mode); the CRM shell gives her six areas (`today, leads, occupancy, clients,
calendar, control`) with actions on and never «גבייה» (`areasFor({view:'ops'})`); the
`.crm.readonly` CSS is gone.

## 5. Files

- `apps-script/Code.gs` — Tasks constants + module (`taskClean_`, `taskVisible_`, `getTasks_`,
  `createTask_`, `taskMutate_`, `completeTask_`, `rescheduleTask_`, `reassignTask_`,
  `cancelTask_` (action `withdrawTask`), `logContact_`, `contactOutcomeLabel_`), dispatch +
  `PROXY_KNOWN_ACTIONS`, `CONTROLLER_ACTIONS` += `getTasks, completeTask, rescheduleTask`;
  `OPS_USER_IDS`, `OPS_*_MONEY_KEYS`, `isOpsActor_`, `moneyPreservedActor_`,
  `preserveMoneyFields_`, saveAll dispatch hook; `READONLY_*` removed.
- `lib/users.js` (`OPS_USER_IDS`, `isOpsView`, `principalView`), `lib/ops-scope.js` (renamed
  from `lib/readonly-scope.js`), `lib/finance-scope.js` (`CONTROLLER_ACTIONS`), `server.js`
  (gate removed, `opsGetDataView`, `/api/me.ops`), `public/app.js`, `public/style.css`,
  `public/crm/crm.js`, `public/crm/crm.css`.
- Tests: `test/crm-tasks-contact-log.test.js` (7, real Code.gs in the sandbox),
  `test/ops-role-dana.test.js` (6, real server + real Code.gs; replaces
  `test/readonly-role-dana.test.js`), guards updated (`billing-control-tab`,
  `personal-pins-login`, `global-patient-search`).
- Docs: `DEPLOY.md`, `EZONE-ECOSYSTEM-STATUS.md`, `docs/crm/PERMISSIONS-MATRIX.md` (§4b new,
  Dana rows), `docs/crm/ROLLOUT.md` (Stage 1 table).

## 6. Security

- Fail-closed: every task action refuses unverified callers even in `log` mode; scope is applied
  on read **and** on every mutation; ids and submission ids are regex-validated; all text is
  formula-safe and length-capped; no secret, no PIN in logs.
- Money never leaves the server for a non-finance session: not in `getData`, not in Activity, not
  in Tasks, and not **into** the sheet through her saves.
- `npm audit`: 0 high / critical (1 pre-existing moderate, accepted).

## 7. Deploy

Nothing to set. The clasp CI deploys Code.gs on merge; the `Tasks` sheet appears on the first
task action. Dana's code: unchanged step (`DEPLOY.md`).

## 8. Open decisions (real ones only)

- Should Sandra's shared PIN (`auth: shared`) ever be used for a save? It carries `finance`, so
  `preserveMoneyFields_` does not apply to it — as today.
- The reminder / digest hook for follow-ups (§9 «להתחבר למנגנון התזכורות הקיים») — Stage 2, once
  «היום שלי» reads `getTasks`.
