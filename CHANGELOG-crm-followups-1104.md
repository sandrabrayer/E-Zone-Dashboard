# CHANGELOG — CRM follow-ups 04/11/2026: Outpatient handoff without a lead phone · save spinner · waitlist reason that did not save

Branch `claude/outpatient-handoff-phone` → base `claude/build-ezone-dashboard-QOg5s` (after #362).

# Part 1 — «העבר לאמבולטורי» asks for the phone instead of failing

## Reported

רוני לוי (רמות השבים) was discharged on 04/11 as «משוחרר לטיפול חוץ», but «העבר לאמבולטורי» failed with
«אין טלפון לליד של המטופל. יש להוסיף טלפון לליד ולנסות שוב» — with nowhere in the CRM to add it.

## Root cause

- The discharge itself **was saved** (she is in «משוחררים», exit 04/11). Only the Outpatient lead was not
  created.
- `dischargeOutpatientPayload_` took the phone **only from the source lead** (`fromLead`). A patient added
  directly, or whose lead has no phone, had none — even when the phone was already in the `PatientPhones`
  book the rosters use.
- The phone stays **required for the send**: it is Outpatient's matching key (cross-app matching is
  phone-based and must never fail open), so a lead without one would be an unreachable / duplicate record.

## Fix

1. **Code.gs** — no source-lead phone → the same resolution the rosters use: `PatientPhones` by patientId,
   then by a unique exact name, then a unique same-name lead phone (`dischargeBookPhone_`). Ambiguous → none.
2. **A phone can be typed for the send.** `/api/outpatient-lead { dischargeId, manual, phone }`:
   - `server.js` `dischargeTypedPhone` — digits only, 9–10 starting with 0 (`+972` and a lost leading zero
     normalised); anything else → 400 `bad_phone` + Hebrew message, nothing called.
   - `Code.gs` re-validates (`rosterValidPhone_`), keeps it in **`PatientPhones`** (update the row of this
     patientId, else of this name + house, else append; note «הוזן בהעברה לאמבולטורי»; under the script
     lock), and uses it. AuditLog `patient_phone_set` carries the digit count only — never the phone. Every
     existing gate stays (verified caller, open discharge row, already-sent).
3. **CRM** — when the send answers `no_phone` / `bad_phone`, the patient's row in «מטופלים» → «משוחררים»
   opens a phone field («טלפון של … (או של איש הקשר)») + «שמירת הטלפון ושליחה לאמבולטורי». After a
   discharge whose automatic send hit `no_phone`, the toast says where to type it and that row opens with
   the field. The phone is asked once: next time it is found in the book.
4. The server message now reads «אין טלפון למטופל/ת. יש להזין טלפון בשורה של המטופל/ת ב«משוחררים» ולשלוח
   שוב.»

## Also in the patient card (Vered looked there first)

A released patient's card had no way to send and showed the raw status «released». Now: status «שוחרר/ה»,
«תאריך יציאה» with the days stayed (no running «ימים בבית»), and an open «העברה לאמבולטורי» block: the phone
is optional (sent without one, the server finds it from the lead / the book); when none is found the field
says «לא נמצא טלפון — הזיני טלפון ולחצי שוב». Once sent: «נשלח לאמבולטורי ✓».

# Part 2 — save spinner; «ממתין לאישור הקופה» that looked selected but did not save

## Reported

Vered marked two waitlist leads «ממתין לאישור הקופה»; the radio showed it, the server never got it.

## Root cause

- The reason needed a separate «שמירה» click — choosing the radio alone sent nothing.
- When chosen right after another save of the same card (e.g. the move to «רשימת המתנה», still in flight),
  `postLeadFlag` returned **silently** (`state.saving`). Every other CRM form had the same silent drop.
- On the board a waitlist lead with an unread manager report showed only «דיווח מנהל/ת חדש», so a saved
  reason was not visible there.

## Fix

- «סיבת המתנה» **saves on the click** (no «שמירה» button): radios disabled, «⟳ שומר…», then «נשמר <when> ·
  <who>» from the server echo; a refusal re-enables and says «לא נשמר — נסי שוב». If another save of the card
  is still running, the choice **waits for it** (up to ~18 s) instead of being dropped.
- **Spinner on every CRM save:** the submit button of the form being saved shows a spinner and is disabled from
  the moment the save starts until the answer (hooked on every `state.saving` start / end; 30 s safety stop;
  a form refused by its own validation never spins). A submit while another save runs → a toast «שמירה קודמת
  עדיין מתבצעת», never a silent drop.
- The waitlist reason chip is shown on the board card, the table and the card header **next to** any other
  next step (e.g. «דיווח מנהל/ת חדש»).

## Files

`apps-script/Code.gs`, `server.js`, `public/crm/crm.js`, `public/crm/crm.css`, `public/sw.js` (v113 → v114).
Part 2 tests: `test/crm-shell-browser.test.js` «Vered 04/11/2026 (2)» (spinner during a slowed save; the reason
chosen while the stage move is still saving is saved; chip on card + board).
Tests: new `test/outpatient-handoff-phone.test.js` (7: book fallback, typed phone saved / updated / used,
gates, server validation, CRM rule = server rule); `test/crm-shell-browser.test.js` C17 (no-phone → field →
invalid refused → valid sent); `crm-pwa`, `dashboard-perf-assets` (v114). Docs: `EZONE-ECOSYSTEM-STATUS.md`.

## Security

Validated in the browser, on the server and in Code.gs; digits only reach the sheet (text-forced column);
no phone in any log or audit row; `dischargeOutpatientPayload` stays server-only; the input is not echoed
into HTML. `npm audit`: 0 high / critical.

## Deploy

Code.gs via the clasp CI on merge. Nothing to set.
