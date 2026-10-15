# Billing reminders: separate release and activation

Status: disabled review candidate, based on production `8e547fe` (October 15, 2026).
No real mail, trigger installation or live property change was performed.
Recipient addresses supplied by Sandra are recorded in the private work-plan Page;
use those exact values during an authorized activation, never copy them into git.

## Decisions still required

- Delivery hour in Asia/Jerusalem. 08:00 is a proposal, not an approved setting.
  Apps Script selects a time within the configured hour, not an exact minute:
  [Google's time-driven trigger documentation](https://developers.google.com/apps-script/guides/triggers/installable#time-driven_triggers).
- Policy: `all_open` sends one daily summary when actionable work exists;
  `aged` sends only when at least one task reaches its explicitly chosen workday
  threshold. Unknown ages remain eligible for review, never treated as zero.
  All five thresholds are required; comparisons are inclusive (`>=`). The older
  plan's “more than two/three days” must be translated explicitly, not copied
  as a guessed threshold. Thresholds gate sending, not the contents: each email
  summarizes all open work for that audience and says so.
- Replace the old Ortal payments digest with this aggregate open-work summary.
  This removes its recent-payment detail; it is a deliberate content change.
  Keeping both would be a different approved design, not a second toggle here.
- Separate approval to merge/deploy this PR, then activate the chosen settings.

## Configuration (Script Properties; no production defaults)

| Property | Meaning |
| --- | --- |
| `BILLING_REMINDER_ENABLED` | Only exact `true` activates sending; keep `false` during preparation |
| `BILLING_REMINDER_REPLACES_DIGEST` | Exact `true` acknowledges the approved digest replacement |
| `BILLING_ALERT_EMAIL_VERED` | Vered's single confirmed address |
| `BILLING_ALERT_EMAIL_ORTAL` | Ortal's single confirmed address; different from Vered's |
| `BILLING_REMINDER_HOUR` | Explicit integer string 0–23, local Jerusalem hour |
| `BILLING_REMINDER_POLICY` | Explicit `all_open` or `aged` |
| `BILLING_REMINDER_MIN_DAYS` | For `aged`: JSON object with explicit integer 0–365 values for `reported`, `partial`, `flagged`, `recorded`, `unrecorded` |

Each owner receives at most one MailApp invocation per local day after an attempt
marker is persisted. Vered: Sun–Wed; Ortal: Sun–Thu; holidays/eves excluded.
The tested calendar covers 2020–2035; unavailable calendar or partial/stale source
blocks sending. Funder waiting alone never triggers a message. App actions remain
available on every day, including Thursday, Friday and Saturday night.

## After separate approval only

1. Recheck the exact PR head, current base, green tests and shared Apps Script
   deployment workflow. Merge/deploy through the existing workflow; verify the
   deployed revision and `/api/version`. Deployment itself installs no trigger.
2. With `BILLING_REMINDER_ENABLED=false`, configure the confirmed recipient
   mapping, approved hour/policy and replacement acknowledgement. Review
   `previewBillingRemindersNow()` in the Apps Script editor. It reads live queue
   data and returns aggregate mail content; it does not send or write state.
   Check the appropriate business day; holiday previews can legitimately be empty.
3. In a controlled window outside the approved sending hour, activate the flag
   and run `installBillingReminderTriggerNow()` as the account that owns the
   old digest trigger. It requires full scopes, creates the new trigger first,
   then removes only that account's `paymentsDigestJob`/`billingRemindersJob`
   triggers. Other accounts' triggers may not be visible; the surviving legacy
   scheduled handler delegates to the same new sender while enabled, sharing
   the lock and daily state. Inspect trigger creation before leaving the window.
   If installation fails, turn the new flag off and inspect the actual trigger
   inventory before retrying; do not assume rollback was complete.
4. Observe the first scheduled execution and bounded outcomes. Provider return
   means accepted by MailApp, not confirmed delivery to an inbox. Check arrival
   with the recipients before calling the delivery rollout complete. No test
   message should be sent without explicit authorization.

## Failure handling and stop

State is one bounded property per owner, `BILLING_REMINDER_STATE_VERED` and
`BILLING_REMINDER_STATE_ORTAL`, containing day, status and timestamp only.
`attempting` is written before MailApp. A thrown send or failed success commit is
uncertain; no automatic retry occurs for that owner that day. This favors avoiding
duplicates over retrying potentially delivered mail. It is not exactly-once
inbox delivery. The next workday may send a new current daily summary.

A quota/pre-send state-write failure can be retried within the approved hour,
provided no attempt marker exists. A successful first recipient is retained if
the second fails. Corrupt/future state fails closed. Logs expose bounded owner
and status codes only, not addresses, source records or raw provider errors.

To stop the new sender, set `BILLING_REMINDER_ENABLED=false`. Retain the daily
state: do not clear it or change recipients to force another same-day send.
The installer has removed the old account's digest trigger, so disabling does
not automatically restore it. If other accounts' legacy triggers remain, they
resume legacy behavior with the flag off; inspect ownership before rollback.
Restore a legacy schedule only after separately approving and checking for
same-day duplication. For an uncertain outcome, inspect execution/provider
records and confirm receipt before any separately authorized recovery action.
