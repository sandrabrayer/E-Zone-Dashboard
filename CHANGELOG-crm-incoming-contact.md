# CRM — incoming contacts («פנו אלינו») + the lead card shows its details first (Sandra, 21/11/2026)

Sandra, 21/11/2026: a lead who had called a few days earlier called AGAIN. The card had no
place to document it — «תיעוד שיחה» is built for a call WE make («לא היה מענה», «מי ביצע»…),
and nothing on the overview showed that any contact had been documented. The card also read
«נפגש/ת עם: <manager>» although no meeting was ever set, and its actions came before its details.

## 1. An incoming contact is a first-class record

- **Card header:** next to «📞 תיעוד שיחה» there is now **«📥 פנו אלינו»**. It opens the same
  contact panel with the direction set to incoming. Both buttons stay hidden from the controller
  view, as before.
- **The panel:** a new first question, **«מי יזם את הקשר?»** — «שיחה יוצאת — אנחנו יזמנו»
  (pre-chosen when the panel is opened the old way, so nothing changes for an outgoing call) or
  «פנייה נכנסת — פנו אלינו». Switching keeps everything typed and adapts the wording
  («תיעוד פנייה נכנסת», «מי פנה», «מי קיבל/ה את הפנייה», «שמירת הפנייה») and the outcome list:
  «לא היה מענה» and «פרטי הקשר אינם תקינים» describe OUR attempt and are not offered for an
  incoming contact.
- **New outcome «התקיימה שיחה — לא נדרש המשך»** (`spoke_no_follow_up`, both directions). It is
  itself the answer to «קשר הבא»: choosing it selects «ללא משימת המשך» and the explanation may be
  left empty (stored as «לא נדרש המשך»). Every other outcome still must explain why there is no
  follow-up, and «קשר הבא» still has no pre-checked default.
- **Storage:** the direction lives in the `contact_logged` Activity event's details JSON
  (`direction: 'out' | 'in'`) — **no sheet column**, headers untouched. An event written before
  this change has no direction and reads as outgoing. For an incoming contact the timeline summary
  starts with «פנייה נכנסת · ». The audit row carries the direction too.
- **After saving:** a record that closed a task or created a follow-up returns to «משימות» (as
  before); any other record returns to «סקירה», where it is now visible (below).

## 2. The lead card: details → documented contacts → actions

- The overview now opens with the lead's details, grouped: **פרטי קשר** (טלפון, איש קשר, טלפון
  איש קשר) · **סטטוס** (שלב, בית, אחראי, מקור, מסלול, נוצר) · **פגישה** · **הערות**. Empty values
  and empty groups are dropped. «עריכת פרטי הליד» sits right under them.
- **«שיחות ופניות אחרונות»:** the last 3 documented contacts with date, who, a direction chip
  («פנו אלינו» / «שיחה יוצאת»), outcome and summary — from the `getActivity` answer the card
  already loads (no extra request). More than 3 → «כל הפעילות» opens the «פעילות» tab. Not shown
  to the controller view (its activity scope is money-only). The patient card gets the same block.
- Then the actions (stage buttons and the collapsible forms), unchanged.

## 3. «נפגש/ת עם» no longer claims a meeting that never happened

`meetingWith` is chosen when the lead is created, so on its own it does not mean a meeting took
place. In the card's details and in the «פגישות ושירותים» pane it now reads **«פגישה מיועדת עם»**
until Vered records an outcome of a meeting that was held («נכנסים לטיפול» / «חושבים על זה»);
only then «נפגש/ת עם». A lead with no visit date and no outcome shows **«פגישה: לא נקבעה»**.
Display only — stored data and the forms' field names are unchanged.

The «פגישות ושירותים» pane only displays; on a lead card it now has a **«תיאום פגישה» /
«עדכון הפגישה»** button that jumps to the scheduling form on the overview.

## Files

- `apps-script/Code.gs` — `CONTACT_DIRECTIONS`, `spoke_no_follow_up` in `CONTACT_OUTCOMES`,
  `logContact_` (direction validated + stored, summary prefix, default no-follow-up text),
  `contactOutcomeLabel_`, `TASK_MESSAGES.bad_direction`. **Deployed by the clasp CI on merge.**
- `public/crm/crm.js` — `CONTACT_DIRECTIONS`, `contactOutcomesFor`, `contactNextPlan`,
  `recentContacts`, `meetingWithLabel`, `leadOverviewGroups` (pure, exported); the drawer
  overview, the contact panel, the meetings pane, two delegated handlers.
- `public/crm/crm.css` — group headings inside `.kv`, the direction fieldset, a wrapping card header.
- `public/sw.js` — cache **v157 → v158** (from the live v157).

## Tests

- `test/crm-incoming-contact.test.js` (new, 14): the real Code.gs in the vm sandbox — direction
  stored / defaulted / refused (`bad_direction`, nothing written), the no-follow-up rule and that
  other outcomes still need an explanation; the client core — lists mirror Code.gs, outcome list
  per direction, `contactErrors`, `contactBody`, `recentContacts`, `meetingWithLabel`,
  `leadOverviewGroups`; markup pins (escaping, controller view, tab allow-list).
- `test/crm-shell-browser.test.js` (+1, real Chromium at 1366 / 390 px): the card order, the
  recent-contacts block, the panel switching direction, ONE `logContact` with `direction: "in"`,
  no horizontal scroll with two header buttons.
- `test/crm-tasks-contact-log.test.js`, `test/crm-pwa.test.js`,
  `test/dashboard-perf-assets.test.js` — pins moved (outcome list, v158).

## Security

- No new endpoint, action, role or secret. `logContact` keeps its gate (verified personal session).
- `direction` is validated against a fixed allow-list on the server (fail closed: an unknown value
  is refused before anything is written) and again on the client.
- Everything rendered from stored text (summaries, names, group values) goes through `esc()`; a
  browser test stores `<b>` in a summary and asserts no markup reaches the page.
- `data-tab-go` can only open a tab on a fixed allow-list.

## Deploy note

The client and Code.gs deploy separately (Railway / clasp CI). If the page is live a minute before
the Apps Script version, saving the NEW outcome answers «תוצאת שיחה לא מוכרת» — nothing is written
and the typed text is kept; retry after the "Deploy Apps Script" run is green. An incoming
contact with an existing outcome saves on either version.

## Rollback

Revert the PR (a later SW bump must still be > v158). Events already written with
`details.direction` stay valid — the field is ignored by older code.
