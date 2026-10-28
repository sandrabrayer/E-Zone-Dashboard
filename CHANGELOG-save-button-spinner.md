# CHANGELOG — save-button spinner audit

**Branch:** `feat/save-button-spinner` · **Base:** `claude/build-ezone-dashboard-QOg5s`
(deployed branch; live SW = `v93` verified in the repo at `afdb195`, PR #281 merged).

## Ask

Every save / send / confirm button should show a spinner, stay disabled for the whole
operation, ignore a second tap or Enter, and be restored in a `finally`.

## Audit result

Every action button in `public/app.js` and `public/meeting-report.js` already runs through
`busyButton()` (directly, or through `showConfirm`, whose confirm button is wrapped).
The pass found ONE real gap and closed it.

| Surface | Wrapper | Status |
| --- | --- | --- |
| All form submits in app.js (13 handlers: lead/meeting/entry/direct-add/discharge/restore/delete-duplicate/credits/refund/funder/payment-report/…) | `busyButton(submitBtn, …)` | already wrapped; **now guarded by a test** |
| `showConfirm` confirm (renew, restore lead, remove lead, …) | `busyButton(confirmBtn, …)` | already wrapped |
| Row buttons: advance/back lead, delete patient, «העבר לאמבולטורי», phone add, funder save, billing control actions, payment void/reconnect/coverage/override, exports | `busyButton(btn, …)` | already wrapped |
| Buttons that only OPEN a modal (שחרור, שחזור, «לא נכנס», «סגור ליד», WhatsApp update) | none needed | the write happens in the modal's wrapped submit |
| Report/xlsx exports in the leads funnel | none needed | synchronous, no request |
| `/meeting-report` form submit | `busyButton` | already wrapped |
| **`/meeting-report` PIN page «כניסה»** | none → **fixed** | disabled but no spinner; Enter in the input bypassed `disabled`, so two Enters sent two requests |

## Change

- `public/meeting-report-pin.html`: busy ring + «טוען…», `aria-busy` re-entry guard that also
  covers the Enter key, restore of label/disabled on 401 / 429 / network error. Same ring as
  `.is-busy`, with a reduced-motion fallback. Page is served by the server and never cached.
- `test/save-button-spinner.test.js`: guard (every `.onsubmit` in app.js reaches `busyButton`,
  explicit allowlist with reason for the one synchronous handler, stale-allowlist check) and
  PIN behavior tests (spinner, one request for click+Enter spam, restore, 429 text).

## Not changed

No app.js / style.css / Code.gs / server.js change, so **no service-worker bump** (stays
`v93`; v17 stays burned). No schema, route, action or secret. Other apps: no change.
