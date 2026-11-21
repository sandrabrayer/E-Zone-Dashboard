# CRM — three call kinds, «ביטול תיעוד», «מה הלאה», and «היום» as the team page (Sandra, 21/11/2026)

Sandra's review of `CHANGELOG-crm-incoming-contact.md`, the same day:

1. «פנו אלינו» is confusing — there should be three states: an outgoing call, an incoming call,
   and a plain call record.
2. "I entered the same call twice by mistake — how is that fixed?"
3. "When a task has a follow-up it must say clearly WHAT has to be done and WHEN."
4. "This is a general dashboard, not Sandra's or Vered's — call it «היום», not «היום שלי»."

## 1. Three kinds: «שיחה יוצאת» / «שיחה נכנסת» / «תיעוד שיחה»

- `direction` in the `contact_logged` details JSON is now `out` | `in` | `note`
  (Code.gs `CONTACT_DIRECTIONS`). **No sheet column.** A record with no direction — everything
  written before 21/11/2026, or a caller that sends none — is `note` («תיעוד שיחה»): the kind is
  never guessed. (The first version defaulted to "outgoing".)
- The card header has ONE button again, «📞 תיעוד שיחה». The panel's first question is
  **«סוג התיעוד»** with the three kinds; none is pre-chosen and saving without one is refused —
  except when the panel closes a call TASK (a call we planned to make), which opens as «שיחה יוצאת».
- «שיחה נכנסת» hides the outcomes that only describe our own attempt («לא היה מענה», «פרטי הקשר
  אינם תקינים») and words the fields accordingly («מי התקשר/ה», «מי קיבל/ה את השיחה»).
- Every list shows the kind as a chip. A record's text is built from its details (outcome +
  summary), not from the stored summary line, so the three records saved earlier today under the
  «פנייה נכנסת» wording read like every other record. New summaries are stored as
  «שיחה נכנסת · …» / «שיחה יוצאת · …».

## 2. «ביטול תיעוד» — a record entered by mistake

A contact record is never edited or deleted (spec §8). A mistake is **voided**:

- In «שיחות אחרונות» every record has «ביטול תיעוד». It asks for a reason and, when the record
  created a follow-up task that is still open, says that the task will be cancelled with it.
- New action **`voidContact { eventId, reason }`** (Code.gs `voidContact_`): ONE new Activity
  event, kind `contact_voided`, `eventId = 'void:<record>'`, `supersedesEventId = <record>`,
  with who / when / why. The record's own row is untouched. Its follow-up task is cancelled only
  if it is still `open` and was created by a contact (`source: 'contact'`); a task the record
  FULFILLED stays done. Idempotent — voiding twice writes nothing. Audit row `contact_voided`.
- Readers: `contactIndex_` skips a voided record (it is no longer «מגע אחרון» and is not
  counted, so a lead whose only contact was voided is «ללא מגע» again); the card's
  «שיחות אחרונות» leaves it out; the «פעילות» tab and the panel history keep it, struck through
  and marked «בוטל», followed by the void line.
- Role: `voidContact` is on **`DELETE_ACTIONS`** (Code.gs and its mirror `lib/role-scope.js`), like
  every other void in the app — it needs the `deleter` role (**Vered, Sandra**), on top of
  `logContact`'s verified personal session. server.js refuses it first, from the session cookie;
  Code.gs refuses it again. Dana documents calls but cannot void one; Ortal is refused. The
  button is drawn only for a deleter.

## 3. «מה הלאה» — what has to be done, and when

- **On every card**, above the details: each open follow-up of the lead / patient as one line —
  **what** (the task title + its reason), **when** (relative: «באיחור של 2 ימים» / «היום» / «מחר» /
  «בעוד N ימים», plus the real date and the weekday, plus the hour when set) and **who**
  («אחראי/ת»). Most urgent first; the box is edged red when something is overdue. One button
  opens «משימות» to finish or re-date.
- **On the board**, a lead's card shows its most urgent follow-up the same way.
- **After saving a call** the card returns to the overview (it used to open «משימות» when a
  follow-up was involved), where the record is in «שיחות אחרונות» and its follow-up in
  «מה הלאה»; the confirmation says «המשך: <what> — <when>». A record in «שיחות אחרונות» also
  names its own open follow-up.
- No new data: the rows are the open tasks the app already loads (`getTasks`).

## 4. «היום» — the team's page

- «היום שלי» → **«היום»**: the menu item, the page title, the two in-app texts that name it and
  the daily reminder mail («היום — שיחות, מעקבים ופגישות», «פתיחת «היום»»; `lib/billing-reminder-mail.js`
  and its mirror `apps-script/BillingReminderCore.gs`).
- The page's head said the signed-in user's name; it now says **«כל הצוות»**. The page already
  listed every owner's work (the «אחראי» filter narrows it) — only the personal framing is gone.
  The controller's own day (Ortal) is unchanged.

## Files

- `apps-script/Code.gs` — `CONTACT_DIRECTIONS` (+`note`), `CONTACT_DIRECTION_LABELS`,
  `logContact_`, `voidContact_`, `contactVoidedIds_`, `contactIndex_`, `PROXY_KNOWN_ACTIONS`,
  `DELETE_ACTIONS`, three messages. `lib/role-scope.js` — `DELETE_ACTIONS` mirror. `apps-script/BillingReminderCore.gs` — wording. **Deployed by the clasp CI on merge.**
- `public/crm/crm.js`, `public/crm/crm.css`, `public/crm/crm.html`; `lib/billing-reminder-mail.js`.
- `public/sw.js` — cache **v158 → v159** (from the live v158).

## Tests

- `test/crm-incoming-contact.test.js` (rewritten, 20): the real Code.gs in the vm sandbox — the
  three kinds stored / defaulted to `note` / refused; `voidContact` (append-only, the follow-up
  cancelled, idempotent, `contactIndex` skips it, a done follow-up untouched, fail-closed: reason,
  id shape, unknown id, controller, unverified); the client core — `contactDirection`,
  `contactErrors` (the kind is required), `recentContacts` (voided left out), `voidContact*`,
  `nextSteps`; markup pins (escaping, one button, «היום», «כל הצוות»).
- `test/crm-shell-browser.test.js`: the card test rewritten for all four items at 1366 / 390 px;
  the Stage 1c test follows the save to the overview.
- Pins moved: `crm-shell-ui` (write actions + `voidContact`), `crm-contact-panel`,
  `crm-reminder-hook`, `crm-search-admit-funder`, `crm-today-card-open`, `crm-activity-timezone`,
  `personal-pins-foundation` / `personal-pins-cleanup` (`DELETE_ACTIONS` + a `voidContact` body in
  the forbidden-role matrix), `crm-pwa`, `dashboard-perf-assets`.

## Security

- `voidContact` validates the id against `^contact:sub-[0-9a-f]{32}$` and requires a reason before
  it reads anything; it can only void a `contact_logged` row and only cancel the task that row
  itself names. Nothing is deleted; who / when / why is in the Activity sheet and the audit log.
- `direction` stays allow-listed on the server (fail closed). All new markup escapes stored text
  with `esc()`; the browser test stores `<b>` in a summary and asserts no markup reaches the page.
- No new role, secret or sheet column.

## Deploy note

Client and Code.gs deploy separately. Until the "Deploy Apps Script" run is green, saving a record
as «תיעוד שיחה» or pressing «ביטול תיעוד» is refused by the older script (nothing is written; the
typed text is kept) — retry a minute later.

## Rollback

Revert the PR (a later SW bump must still be > v159). `contact_voided` events and `direction:
'note'` are ignored by older code; a voided record would simply show again.
