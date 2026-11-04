# CHANGELOG — CRM: Vered's feedback round (04/11/2026)

Branch `claude/crm-vered-feedback-1104` → base `claude/build-ezone-dashboard-QOg5s`.

## What changed for Vered / Dana

1. **App icon** — the CRM page now has `<link rel="icon">` (the tab showed a blank globe; the
   classic page already had it) and the menu header shows the real app icon instead of the «E» badge.
2. **«פניות» → «לידים»** everywhere a lead is meant: menu item, nav group («לידים ומטופלים»),
   card / domain «לידים חדשים ללא מגע», «+ ליד חדש», search placeholder and results, drawer texts,
   admission warnings, triage. Kept as is: «פנייה ישירה» (a source key), «הפנייה נשלחה» (an outpatient
   referral), «סיבת הפנייה» (the reason for a call), «התבקשה הפסקת פניות».
3. **No urgent band** («⚠ חריגים דחופים ומחויבויות להיום») on «היום שלי» — it repeated rows already
   listed in their domain and in «פגישות היום». The menu badge still counts them.
4. **Manager report grace — 3 days.** A meeting whose report has not arrived is «ממתין לדיווח
   מנהל/ת · הדיווח צפוי עד …» (not an exception) for 3 days; from day 3 it is «דיווח המנהל/ת באיחור»
   with «N ימים ללא דיווח», an exception. Same rule on the board / table chip and the derived queue.
   A meeting today opens with «פרטי הפגישה» (was «לדיווח»).
5. **May exceptions gone** — follow-up rows dated before 01/06/2026 are no longer listed in
   «היום שלי» (`EXCEPTION_CUTOFF`). Source rows are untouched.
6. **«מה דחוף בבתים» removed from «היום שלי»** — no card (Dana's slot), no domain, no side box
   «חריגים בבתים»; the admission-due and «לעדכן המשך טיפול» rows are gone from the day (the
   continuity select still works from the patient card → «פגישות ושירותים»; «תפוסה» still counts
   admission-due). **Kept on purpose:** a discharge whose audit row exists but whose Patients status
   did not save («בדיקת שלמות שחרור») — a P0 data-integrity check, listed only while one exists, under
   «שחרור שלא נשמר במלואו — לבדיקה», never a card.
7. **Waitlist reason** — a lead in «רשימת המתנה» has «סיבת המתנה» (open in the card): **ממתין למקום** /
   **ממתין לאישור הקופה**. The board / table / card chip shows it; default (no choice yet) = ממתין למקום.
8. **Meeting cancelled / changed by the patient** — new block in the lead card «הפגישה בוטלה / שונתה
   ע״י המטופל/ת»: בוטלה, or שונה מועד (new date ≥ today + optional time), optional note to the manager.
   - The lead is written through the normal one-lead `saveAll` (cancel → `meetingOutcome:'cancelled'`;
     reschedule → new `visitDate` / `visitTime`, outcome cleared), then the change is recorded.
   - The card / board say «בוטלה ע״י המטופל/ת — לתאם מחדש» or «פגישה dd/mm · שונתה ע״י המטופל/ת»;
     the meetings tab shows the change, when and by whom.
   - **Message to the manager:** «📲 הודעה למנהל/ת בוואטסאפ» at the top of the card — a wa.me link to
     the manager's number (`managerPhones` from getData; unknown → WhatsApp asks for the chat) with a
     prefilled Hebrew text (name, house, old / new slot, note). WhatsApp cannot be sent without a tap,
     so the button is focused and a toast asks for it. The managers app already receives the new
     date / outcome from the Leads sheet.
   - A patient cancellation opens one «לתאם מועד חדש או לסגור את הליד» row in «המשך טיפול לאחר
     פגישות»; a cancellation Vered documented herself (outcome only) stays settled, as before.
   - Calendar: «בוטלה»; the outcome is shown in Hebrew everywhere (was the raw key `cancelled`).

## Data — no new column

A new `LEAD_COLUMNS` entry would shift the position-mapped closed-lead sheets
(`IRRELEVANT_LEAD_COLUMNS` / `REMOVED_LEAD_COLUMNS` = `LEAD_COLUMNS.concat(...)`), so both flags are
append-only **Activity** events (latest wins):

| kind | details |
| --- | --- |
| `waitlist_reason` | `{ reason: 'place' \| 'funder' }` |
| `meeting_patient_change` | `{ change: 'cancelled' \| 'rescheduled', prevDate, prevTime, newDate, newTime, withWhom, note≤200 }` |

- **`logLeadFlag`** (Code.gs, new action; in `PROXY_KNOWN_ACTIONS`): body
  `{ submissionId: 'sub-<32 hex>', flag: { leadId, kind, … } }`. Gate = `logContact`
  (PROXY_SECRET + verified personal session); the controller (money-only) view is refused. Strict
  enum / date / time validation; the lead must exist on Leads; idempotent by submission
  (`eventId = kind:sid`); script lock; AuditLog `lead_flag_logged`.
- **`contactIndex`** additionally returns `flags[leadId] = { waitReason?, meetingChange? }` (invalid
  stored rows are dropped). Existing fields unchanged.

## Files

- `apps-script/Code.gs` — `LEAD_FLAG_*`, `leadFlagClean_`, `leadFlagIndexPut_`, `logLeadFlag_`,
  dispatch, `contactIndex_` flags.
- `public/crm/crm.js` — labels; `DOMAINS` (houses → integrity-only), `MANAGER_REPORT_GRACE_DAYS`,
  `EXCEPTION_CUTOFF`; `meetingBuckets.cancelled`; `myDay`, `compute`, `nextActionFor(l, today, flags)`,
  `calendarRows`; new pure `WAIT_REASONS`, `waitReasonLabel`, `flagsOf`, `patientMeetingChange`,
  `reportOverdue`, `meetingOutcomeLabel`, `managerChangeMessage`, `managerWaUrl`, `leadFlagBody`,
  `patientChangePlan`; UI `waitReasonBlock`, `patientChangeBlock`, `managerChangeLink`, `postLeadFlag`;
  urgent band + side exceptions box removed.
- `public/crm/crm.html` (favicon, logo image, placeholder), `public/crm/crm.css`, `public/sw.js` (v112 → v113).
- Tests: new `test/crm-vered-feedback-1104.test.js` (13: grace, cutoff, houses out, labels, waitlist,
  patient change, message / link, calendar, source guards, real Code.gs `logLeadFlag` + `contactIndex`);
  `test/crm-shell-browser.test.js` (+1 Chromium scenario; labels / band updated);
  `crm-my-day`, `crm-shell-ui`, `crm-today-card-open`, `crm-search-admit-funder`, `crm-pwa`,
  `dashboard-perf-assets` updated to the new behaviour.
- Docs: `EZONE-ECOSYSTEM-STATUS.md`.

## Security

- Every rendered value goes through `esc()` (names, notes, the wa.me href). The wa.me path accepts
  digits only (9–15); the text is `encodeURIComponent`-ed; the link opens from the click with
  `noopener`. The flag is shown only after the server echoes it.
- `logLeadFlag` is fail-closed (unverified → refused; controller → `forbidden`), validates every field
  server-side, never stores money, and writes nothing on any refusal.
- `npm audit`: 0 high / critical.

## Deploy

Code.gs deploys via the clasp CI on merge (never paste, no new deployment). Railway auto-deploys the
frontend. Nothing to set.
