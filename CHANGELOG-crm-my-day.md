# CHANGELOG — CRM Stage 2: «היום שלי» rebuilt, light theme, grouped navigation

Date: 2026-10-29 · Branch `claude/s2-my-day` → base `claude/build-ezone-dashboard-QOg5s`
Spec: «הוראות האיפיון והעיצוב» §1, §3 (navigation + views), §4 (design), §5 (summary counts),
§6 (queues), §7 (ordering), §9 (week), §13–§14. Over Stage 1a–1c.

## What changed for Vered / Dana (the CRM opening screen)

1. **Light theme** (spec §4): background `#F5F7FA`, white surfaces, text `#172B36`, borders
   `#DCE3EA`, action `#0F766E`; red = exception, orange = waiting, green = done — every state also
   carries a word or an icon («⚠ חריג», «⏰ באיחור», «● להיום», «◷ ממתין ל…»), never colour alone.
   Body 16px. The classic page keeps its own dark theme. `theme-color` updated.
2. **Navigation** regrouped: היום שלי · **פניות ומטופלים** (פניות, מטופלים) · **פגישות ויומן** (יומן) ·
   **בתים והמשך טיפול** (תפוסה) · **כספים** (גבייה — finance only) · **דוחות והגדרות** (בקרה).
   Header: title, the user, today's date («יום רביעי, 28/10/2026», Asia/Jerusalem).
3. **«היום שלי» = what / why now / what happened / what can I do.** No lateness by lead age any
   more: a new lead without a *documented* contact is «אין מגע מתועד» (information), an overdue
   dated task is «באיחור».
   - **Three views**: **היום** · **השבוע** (any week, visible range, grouped Sun–Sat, a window task on
     each day it covers, «משימות ללא תאריך — קבעי תאריך» apart) · **הושלמו** (done / cancelled tasks
     of the chosen week with who, when, outcome; opens the record).
   - **Filters** (assignee, house) + **quick actions** (תיעוד שיחה / משימה חדשה / פגישה → pick a
     lead or patient, then the panel / the card).
   - **Summary strip** — five cards, counts and lists from the same rows (spec §5):
     Vered / Sandra: גבייה לטיפול (collection tasks due + recorded debts past their cycle; hint =
     open cycles from `debtAging`) · שיחות ומעקבים · פגישות היום **+ תיאומים פתוחים** (two numbers) ·
     המשך טיפול לאחר פגישות · פניות חדשות ללא מגע. **Dana**: no money card — «מה דחוף בבתים»
     (all exceptions) takes the slot. A source that did not load shows **«—» + «המידע אינו זמין»**,
     never 0. A card click filters to its domain.
   - **Urgent band** on top: timed commitments of today (binding) and the exceptions.
   - **Work list by domain (~70%)**: each row = name (opens the card), house, contact person, the
     action, why now, when (a window as «במהלך … – …», undated as «קבעי תאריך»), state, assignee,
     **last documented contact** (date · outcome · summary), and the action button that opens the
     form directly («תיעוד שיחה», «סיום», «שינוי מועד», «לדיווח», «לחשבון», «קביעת תאריך»).
     Domains: גבייה לטיפול (finance: recorded debt / cycle without a report / collection tasks) ·
     שיחות ומעקבים · פגישות ותיאומים · המשך טיפול לאחר פגישות (waiting for the manager's report —
     «תאריך שעבר אינו הוכחה שהתקיימה», the manager is the owner; report unseen; report read but
     undecided) · פניות חדשות ללא מגע · מה דחוף בבתים (admission due and not done — a future entry
     date is **not** an exception; discharge without continuity in the last 14 days).
   - **Side column (~30%)**: פגישות היום · ממתין לגורם אחר (owner + since when) · חריגים בבתים.
   - **Ordering** (spec §7): timed today → exceptions → overdue → today → upcoming → undated. One
     row per item — the same report exception is never listed twice.
4. Mobile (390px): vertical list, two-column cards, side column below, no horizontal scroll.

## Data

- New Apps Script read **`contactIndex`** (gate = `expectedDischarges` rule: PROXY_SECRET + verified
  personal session; the controller view is refused): the last `contact_logged` event per lead /
  patient `{ at, outcome, channel, actorName, summary≤120, noNext }`. Contact events are never money
  kinds, so Dana reads the same index. Read-only; no sheet is created.
- `getData` gains nothing; the CRM reads `entryDate` from the lead rows it already receives.
- Boot reads, in parallel: `getData`, `getTasks(open)`, `contactIndex`, and `debtAging` for a
  finance session (reused by «גבייה» — read once; a billing write resets both). All fail-soft.

## Files

- `apps-script/Code.gs`: `contactIndex_`, dispatch, `PROXY_KNOWN_ACTIONS`.
- `public/crm/crm.js`: core — `NAV_GROUPS`, `MY_DAY_VIEWS`, `DOMAINS`, `meetingBuckets`,
  `newLeadsNoContact`, `houseExceptions`, `myDay`, `weekPlan`, `doneInWeek`, `lastContactText`,
  `hebDate`; UI — `renderMyDay`, `renderWeek`, `renderDone`, `loadDone`, `renderQuick`,
  `quickList`, `workRow`, `rowsBlock`, `weekBar`, grouped `renderNav`, `resetBilling`; the Stage 1c
  «שיחות לביצוע» block is folded into the calls domain.
- `public/crm/crm.css` (light tokens + the day layout), `public/crm/crm.html` (date, user,
  theme-color), `public/sw.js` (v97 → v98).
- Tests: `test/crm-my-day.test.js` (8: model, theme/nav guards, the real Code.gs `contactIndex`
  per role), `test/crm-shell-browser.test.js` (+1 scenario: Vered 1366 / Dana 390; the first,
  C8, C9, C14 and Stage 1c scenarios updated to the new screen), guards (`crm-shell-ui`,
  `crm-pwa`, `dashboard-perf-assets`).
- Docs: `EZONE-ECOSYSTEM-STATUS.md`, `docs/crm/ROLLOUT.md`, `docs/crm/PERMISSIONS-MATRIX.md` §4b.

## Security

- `contactIndex` refuses unverified callers even in `log` mode and the controller view; it
  returns no phone, no note, no money. Every interpolated field goes through `esc()`.
- Dana's day never requests `debtAging` and shows no ₪ (browser-tested).
- `npm audit`: 0 high / critical.

## Deploy

Nothing to set. The clasp CI deploys Code.gs on merge. SW v98.

## Open (real) decisions

- «גבייה לטיפול» counts "reported, awaiting Ortal's verification" only once `getPayments` is read
  — today the card is debt + collection tasks; the verification state stays in «גבייה».
- Stage 3 next: «רשומות שדורשות בירור» triage for the 75 old leads (they now sit in «פניות חדשות ללא
  מגע» as information, not as lateness).
