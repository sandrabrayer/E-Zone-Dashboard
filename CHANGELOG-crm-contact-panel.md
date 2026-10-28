# CHANGELOG — CRM Stage 1c: the contact panel, «שיחות לביצוע», tasks in the card

Date: 2026-10-28 · Branch `claude/s1c-crm-contact-panel` → base `claude/build-ezone-dashboard-QOg5s`
Spec: «הוראות האיפיון והעיצוב» §6 (שיחות לביצוע), §7 (ordering), §8 (contact form), §9 (one task id
everywhere), §11 (task operations), §14 (reliability). Over Stage 1a+1b (`CHANGELOG-crm-tasks-contact-log.md`).

UI only (`public/crm/crm.js`, `crm.css`, SW v96 → v97). No Code.gs, no server change, no schema change.

## What Vered / Dana get

1. **«שיחות לביצוע»** at the top of «היום שלי»: the open `call` / `collection` tasks from
   `getTasks` (status open), ordered **overdue → today → upcoming → undated**; on one day a timed
   task first. Each row: who (name opens the card) and relation / contact person, what and why,
   assignee, when (a window shows as «במהלך … – …», an undated task as «ללא תאריך — קבעי תאריך»,
   never an invented lateness), state in words + chip, **«תיעוד שיחה»** and **«שינוי מועד»**.
   There is **no «בוצע»** on a call: a call closes only through the contact log (§6).
   The house / owner filters of the page apply. A `getTasks` that did not load shows
   **«המידע אינו זמין» + «נסי שוב»** — never 0 (§5). The «היום שלי» nav count adds the late +
   today calls.
2. **The contact panel** («תיעוד שיחה» on a queue row, a call task in the card, or the card head):
   the drawer shows the subject, the contact person and phone (dial / WhatsApp links, marked
   «קישור חיוג אינו תיעוד»), the **contact history** (`getActivity`), and the form: date (today
   or earlier) + time, who (the session user, read-only), with whom, channel, reason (prefilled
   from the task), **outcome** (the eight spec outcomes), summary, and **«קשר הבא»** with the
   nine choices — **no radio is preselected**; a relative choice shows the actual date and
   weekday; «במהלך שבוע נבחר» is a Sun–Sat window; «ללא משימת המשך» needs an explanation.
   Follow-up title and assignee are editable (default: «לחזור — <outcome>», the task's assignee or
   the user).
3. **Save** = one `logContact` (contact event + the fulfilled task done + the follow-up, server
   transaction). Client validation first; a refusal or a network failure **keeps the text** and
   the retry reuses the **same `submissionId`** (idempotent — a double click or a timeout never
   writes twice); nothing is marked done before the server echoes the event (§14). After the
   save the tasks re-read from the server and the card reopens on «משימות».
4. **«משימות» tab in the card**: the subject's open tasks (same rows), **«משימה חדשה»** (kind —
   money kinds only for finance —, title, why now, assignee, a date + time or a week),
   **«שינוי מועד»** (date or week; **a reason is required when the task came from a contact** —
   a date promised to the family, §6), **«סיום»** on non-call kinds, **«עוד…»** → reassign /
   «ביטול המשימה» with a reason (`withdrawTask`, the row stays).
5. The same task id is one row wherever it appears (queue and card); filters and scroll survive
   opening a card, as before.

## Files

- `public/crm/crm.js`: core (pure) — `CONTACT_OUTCOMES`, `CONTACT_CHANNELS`, `NEXT_CHOICES`,
  `TASK_KINDS`, `nextPlan`, `contactErrors`, `contactBody`, `contactAccepted`, `taskState`,
  `taskWhen`, `taskSubject`, `taskQueue`, `tasksFor`, `taskCounts`, `taskFormErrors`,
  `taskCreateBody`, `rescheduleErrors`, `rescheduleBody`, `taskAccepted`; UI — `applyTasks`,
  `reloadTasks`, `renderCallsQueue`, `renderTasksPane`, `openTaskForm`, `postTask`,
  `openContactPanel`, `refreshNextPreview`, `submitContact`; `load()` reads `getTasks` next to
  `getData` (not for the controller view).
- `public/crm/crm.css`, `public/sw.js` (v97).
- Tests: `test/crm-contact-panel.test.js` (6; the body is accepted by the real Code.gs),
  `test/crm-shell-browser.test.js` (+1 Chromium scenario at 1366 and 390 px), guards updated
  (`crm-shell-ui` action lists, `crm-pwa`, `dashboard-perf-assets`).
- Docs: `EZONE-ECOSYSTEM-STATUS.md`, `docs/crm/ROLLOUT.md`.

## Security

- Every write goes through the Stage 1a actions and their server-side scope (Dana never sees a
  money task; the money kind is not offered to a non-finance session either). All text goes
  through `esc()`; ids are regex-shaped; no new route, no secret.
- `npm audit`: 0 high / critical.

## Not in this PR (next)

- Stage 2: «היום שלי» / «השבוע» / «הושלמו», light theme, nav regroup, per-role cards, the other
  queues (§3–§7); the reminder / digest hook for follow-ups (§9).
