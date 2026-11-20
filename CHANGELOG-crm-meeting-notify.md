# CRM — «זימון» to the manager when a meeting is scheduled (Part A: WhatsApp)

Sandra, 20/11/2026: when a meeting is scheduled with a lead, the manager it is scheduled
with should get a «זימון» that the meeting is with them. Chosen delivery: **both** a
WhatsApp link (this PR) and, separately, an automatic item in the managers' app (Part B,
cross-repo, a later PR).

## What is new (Part A)

In the lead card's **«תיאום פגישה»**, once the lead has a dated meeting with a real
manager (not «אמבולטורי»), a ready **WhatsApp «זימון»** to that manager appears — tap
«שליחה בוואטסאפ» to send. It reuses the exact mechanism that already notifies a manager
of a patient-side cancel/reschedule (`managerWaUrl` + the `managerPhones` map), so there
is no new channel and no new backend.

- The message: «זימון לפגישה — <lead> (<בית>): נקבעה פגישה איתך ל-<תאריך> בשעה <שעה>»,
  plus the contact and any note.
- The link persists on the card, so it can be sent at scheduling time or later.
- No phone for that manager → a wa.me link with no number (the sender picks the chat),
  the same fallback as the existing notice.

## Not in this PR

Part B — an **automatic** item in the managers' app (ezone-managers) feed — is a
separate cross-repo change and will deploy to that app.

## Security

No new endpoint, action or channel; the message is built client-side from the lead the
user is already viewing; values are escaped. `npm audit`: 0 high / critical.

## Tests

- `test/crm-meeting-notify.test.js` (new, 3): the message text, the wa.me url, the
  show-only-for-a-real-manager guard + the render.
- `test/crm-shell-browser.test.js`: one scenario — a scheduled meeting shows the invite
  with the manager's phone in the link; an ambulatory meeting shows none.

## Files

`public/crm/crm.js`, `public/sw.js` (v153 → v154),
`test/crm-meeting-notify.test.js` (new), `test/crm-shell-browser.test.js`,
`test/crm-pwa.test.js`, `test/dashboard-perf-assets.test.js`, `EZONE-ECOSYSTEM-STATUS.md`.

## Deploy

Railway only (auto-deploy of the deployed branch). No Apps Script deploy.
