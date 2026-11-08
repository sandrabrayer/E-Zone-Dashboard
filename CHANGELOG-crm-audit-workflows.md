# CRM acceptance audit — focused workflow corrections, 2026-11-06

Status: prepared locally after Sandra's explicit approval. No merge, deployment,
new issue/PR, production data change or Claude task. Base:
`5349d75c0bf40ea276429ab3ff78a7470b968697`.

## Problem and resulting behavior

- **R3, collection responsibility:** open debt cycles disappeared when «היום שלי»
  was filtered to Vered because the derived row had no owner. These rows now
  display Vered as the collection owner, consistent with the existing funder
  exceptions. Manually assigned tasks and Ortal receipt-verification ownership
  are unchanged. Finance permission and house filters still apply. This is a
  view rule, not a source task reassignment or a financial adjustment.
- **R4, cancelled meeting:** recording cancellation via the ordinary outcome
  form hid the next action. Both cancellation entry paths now yield one derived
  follow-up until the lead is closed, rescheduled or already has an open call /
  meeting task (including a deferred task). No task is created. A completed task
  or an unrelated review does not conceal unresolved cancellation. This approved
  rule supersedes the earlier #362 assumption that recording cancellation alone
  meant the follow-up was settled; two previous regression expectations reflect
  that change.
- **R7, work control:** the unread, undecided, missing-report, unscheduled and
  overdue-task cards now count and open the same filtered rows. For example,
  three unread reports open three rows, rather than all 25 follow-ups. Historic
  cutoff, owner/house filters and financial scope are applied consistently.
  The admission-board and triage links are outside this correction.

## Implementation and acceptance

Only CRM view logic changes; no server or Apps Script change. Use the existing
row model and delegated navigation, with a return to all domains. SW v119 → v120.

`test/crm-audit-workflows.test.js` contains seven synthetic regressions:
77 collection cycles survive the Vered filter; permissions and manual owners
remain correct; both cancellation paths retain work; existing/deferred tasks
prevent duplicate actions; exact report groups agree; overdue task categories
and financial scope agree; actual boot/render/click handlers navigate correctly
through an in-memory DOM adapter without any POST. This is not Chromium QA.

## Real-browser follow-up

The existing Chromium fixture now tests the three corrections at 1366px and
390px: debt cycles remain under Vered; ordinary cancellation is visible; three
unread reports open exactly three rows; returning restores normal navigation;
an existing future callback suppresses the derived cancellation row. Browser
traffic is restricted to the local fixture, and navigation makes no source
writes. The fixture disables its own read cache only when changing synthetic
upstream state directly; production caching remains unchanged.

Test-only portability: three older browser suites now honor `CHROMIUM_PATH`,
as other suites already did. Playwright 1.51.1 / Chromium 134 headless shell is
installed outside application dependencies (the same tooling as Outpatient CI).
An older shell assertion now targets the exact unread section rather than the
superseded combined follow-up section.

The expanded suite also exposed a date-dependent pre-existing export test:
after selecting three calendar months, its 80-day-old synthetic patient's list
was empty, correctly disabling CSV. The test now restores the patient's entry
date through the real date control and asserts one row before testing export.
No export implementation changed, and the original spinner assertions remain.

Full-suite results and remaining release gates are recorded in
`docs/crm/CRM-AUDIT-CANDIDATE-20261106.md`. No production acceptance is implied.
