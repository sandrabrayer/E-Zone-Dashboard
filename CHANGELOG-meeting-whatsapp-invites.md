# WhatsApp meeting invites — lead-card button + meetings-board edit modal

Frontend-only feature (no `Code.gs` / backend change). Lets Vered send a
WhatsApp **invite** to a lead the moment a meeting is scheduled, and send an
**update** when a meeting is edited from the weekly meetings board.

## What changed

### A. Message builder — `buildMeetingMessage(...)` (pure)
`buildMeetingMessage({ type, name, manager, house, dateISO, time })` where
`type` is `'invite'` or `'update'`. Both templates are addressed to the **lead**
(by name) and are meant to be sent to the **lead's** phone — distinct from the
existing meetings-board WhatsApp link, which pings the *manager*.

- **invite:** `שלום [שם], נקבעה פגישה עם [מנהל] ביום [יום] [תאריך] בשעה [שעה] בבית [בית].`
- **update:** `שלום [שם], הפגישה שונתה ליום [יום] [תאריך] בשעה [שעה] עם [מנהל] בבית [בית].`

Details:
- `[יום]` — bare Hebrew weekday (`ראשון`…`שבת`) derived from `dateISO` using
  **local** date parts (`parseLocalISO` → `getDay()`), never UTC parsing, per the
  codebase's `isoDate` timezone rule. New helper `hebrewWeekday(dateISO)`.
- `[תאריך]` — `DD/MM/YYYY` via the existing `formatDateDDMMYYYY`.
- `[בית]` — house **display name** (e.g. `קיסריה עפרוני`), resolved from a
  canonical key / Hebrew label / id via the new `houseDisplayName(house)` helper —
  never the canonical key.
- When `time` is empty/missing, the ` בשעה [שעה]` segment is dropped cleanly with
  no double spaces.
- The wa.me link is built by `meetingInviteWaUrl(rawPhone, message)`, which reuses
  the existing `normalizePhone` and the same `https://wa.me/<digits>?text=<enc>`
  construction as `meetingWhatsappUrl` (nothing reimplemented). A blank phone
  yields `https://wa.me/?text=…` so the sender picks the recipient in WhatsApp.

### B. Lead card — "שלח הזמנה" button
- Rendered inside the visit-stage inline fields (edit mode only).
- Enabled only when **visitDate + visitTime + meetingWith** are all set. State is
  refreshed live from the three inline fields on every `change` (via a separate
  `addEventListener`, so it never clobbers the autosave `.onchange` handler).
- Click opens the wa.me **invite** deep link in a new tab via the existing
  PWA-safe `openWhatsAppLink` (window.open → location fallback).
- Reuses the shared `.mtg-wa` green styling. Carries **no** `data-field`, so the
  generic autosave `[data-field]` handler never touches it — it cannot perturb the
  autosave busy-flag loop guard.

### C. Meetings board — edit modal
- Each meeting row gets an edit (✏️) action (edit mode only — it writes).
- `openMeetingEditModal(m)` pre-fills a modal with: a date input, the existing
  quarter-hour time `<select>` (`visitTimeOptions`), and a manager `<select>`
  (same `managerOptions()` as the lead card).
- **Save** persists through the same per-row path the lead-card inline fields use
  (`updateLead` → `saveAll`, `action: 'saveAll'`) — no new endpoint. On success the
  board re-renders; on failure `updateLead` rolls back and surfaces the error and
  the modal stays open for retry. (`updateLead` now returns a success boolean.)
- A **"שלח עדכון"** WhatsApp button builds the `'update'` message from the modal's
  **current** (live) field values and sends it to the lead.

## Files touched
- `public/app.js` — new pure helpers (`hebrewWeekday`, `houseDisplayName`,
  `buildMeetingMessage`, `meetingInviteWaUrl`); lead-card invite button + wiring;
  `meetingRowHTML` actions cell + edit button; `openMeetingEditModal`;
  `renderMeetings` edit wiring; `updateLead` now returns a boolean.
- `public/style.css` — `.mtg-actions` wrapper, `.mtg-edit` button, mobile grid
  tweak (last column now targets `.mtg-actions`).
- `test/meeting-whatsapp-invites.test.js` — `node:test` + vm-sandbox tests for
  `buildMeetingMessage` (invite with/without time, update, Hebrew weekday, DD/MM/YYYY,
  house display-name resolution, no double spaces) and `meetingInviteWaUrl`.

## Tests
`npm test` — full suite green (275 passing), including 12 new cases in
`test/meeting-whatsapp-invites.test.js`.
