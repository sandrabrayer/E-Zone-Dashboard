# CHANGELOG — CRM Stage 4a: follow-ups in Vered's existing daily reminder (spec §9)

Date: 2026-10-29 · Branch `claude/s9-reminder-hook` → base `claude/build-ezone-dashboard-QOg5s`
Spec §9: «להתחבר למנגנון התזכורות / הדייג׳סט הקיים, בלי מנגנון כפול».

## What

Vered's **existing** daily reminder mail (FIN-01.3, `BillingReminders.gs` + `BillingReminderCore`,
08:00–09:00 Asia/Jerusalem, `BILLING_REMINDER_*` properties) gains one section,
**«היום שלי — שיחות, מעקבים ופגישות»**, with aggregate counts only:

- שיחות ומעקבים באיחור · שיחות ומעקבים להיום · משימות אחרות להיום · פגישות קבלה היום ·
  משימות ללא תאריך — לקבוע (zero lines omitted), and a button «פתיחת היום שלי» → the CRM.
- No names, no money, no notes — the same privacy rule as the billing mail. Money tasks
  (`collection`) never enter the count; tasks assigned to someone else are not hers.
- The mail also goes out on a day with **no billing work but CRM work due**; Ortal's mail is
  unchanged. With no `Tasks` data (or a failed read) the section is simply absent — the mail is
  byte-identical to today's billing mail, never a fake «אין משימות».

No new trigger, no new property, no second mail (spec §9).

## How

- `lib/billing-reminder-mail.js`: `plan(data, config, clock, extras)` / `render(audience, day,
  extra)` / `extraOf`; `apps-script/BillingReminderCore.gs` regenerated
  (`node scripts/build-billing-reminder-core.js`, parity-tested).
- `apps-script/Code.gs`: `reminderExtras_(todayIso)` — open non-money tasks of «ורד» (or
  unassigned) split late / today / window / undated from the `Tasks` sheet + today's intake
  meetings from `Leads`; read-only; `null` on any failure.
- `apps-script/BillingReminders.gs`: passes `reminderExtras_(clock.day)` into `plan`.

## Tests

`test/crm-reminder-hook.test.js` (4): render / plan with and without extras (identical mail
without), generated core parity, the real `reminderExtras_` over a seeded sandbox, the adapter
end-to-end in preview mode. The 20 existing delivery tests stay green.

## Deploy

Nothing to set. The clasp CI deploys Code.gs + BillingReminders.gs + BillingReminderCore.gs on
merge (Apps Script versions: ~60 free after this morning's cleanup).
