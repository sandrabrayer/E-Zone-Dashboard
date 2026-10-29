# CHANGELOG — Dana lands on the CRM by default

Date: 2026-10-29 · Branch `claude/crm-default-ops` → base `claude/build-ezone-dashboard-QOg5s`
Sandra: «איך עכשיו דנה וורד נכנסות לאפליקציה במודל החדש?» — Vered landed on the CRM, Dana on the
classic page. One rule, no env change.

- `lib/crm-shell-flag.js`: `CRM_DEFAULT_VIEWS = ['full', 'ops']` — with `CRM_DEFAULT=true` (already
  set) `/` serves the CRM shell to Dana's session as well. `/?view=classic` stays the classic page
  for everyone; Ortal (controller) keeps the classic page by default and can open `/?view=crm`.
- Tests: `crm-shell-flag` pin, `ops-role-dana` (Dana gets the shell on `/`, classic on
  `/?view=classic`). Nothing to set.
