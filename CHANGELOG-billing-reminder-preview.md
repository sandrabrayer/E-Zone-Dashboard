# FIN-01.3 — reminder preview (review candidate, October 15, 2026)

The existing payment digest follows recent reports, not every open follow-up
item. Before connecting another delivery path, the team needs to review what
Vered and Ortal would each see, including partial verification and funder grace.

A collapsed **תצוגה מקדימה לתזכורות** section in Billing Control now shows:
- Vered's collection/billing-issue work.
- Ortal's verification work and a separate oversight summary of Vered's work.
- Counts by work type, oldest known work age for the responsible owner, missing
  age counts and a separate funder-waiting count.
- Navigation to each owner's existing queue, resetting house filters.

The preview covers all houses regardless of the visible queue filters. It
contains no patient names/IDs, clinical notes, payer names, receipt references,
amounts or recipient addresses. Counts are tasks, not distinct patients. The
same Vered work appears in both audiences intentionally; do not add audiences.

`BillingControlRules.reminderPreview` derives its aggregate-only projection
from `followupRows`, using the deployed owner calendar. Confirmation echoes
update it immediately. Unknown dates remain unknown. A partial source, an
unknown future work kind or a failed refresh carries a visible warning; empty
stale/partial groups never claim that no work remains. An unavailable queue
shows no fabricated complete summary. Funder grace is never aged as action work.

The UI explicitly says this is a preview and does not send from this screen.
No severity/overdue threshold, send time or recipient address is invented. No
scheduler, MailApp, email provider, new permission, API route, sheet mutation,
Apps Script change or notification delivery is introduced. Existing digest
behavior remains unchanged. Future delivery still needs verified recipients,
a settled schedule/threshold policy, coordination with the existing digest,
and idempotency/retry/failure recording; none is claimed implemented here.

## Validation

- Full local suite on the integrated base: **2,845 passes, 0 failures, 67 browser skips**.
- Six new synthetic regressions cover audiences, privacy, missing dates/grace,
  unavailable/partial/stale sources, immediate confirmation and safe navigation.
- Real Chromium regression covers 360px/1280px, labels, privacy, independent
  filters, keyboard focus, immediate confirmation, funder grace, stale refresh,
  text contrast and RTL bounds. Results/screenshots are recorded in the PR.
- `npm audit`: 0 high/critical, one existing moderate; dependencies unchanged.
- Live cache v67 verified; candidate v68. Built on the current merged base,
  `7f10b574d4cca7da94626b538e21680f607792b3` (#236), including #234's calendar
  and #235. The parallel backend fix is retained without further modification.

Sandra also clarified that Vered uses the app on Fridays and Saturday nights.
The calendar never gates access/actions on any day; the on-screen explanation
now says so explicitly. A task's completion is not delayed by a nonworking day.
