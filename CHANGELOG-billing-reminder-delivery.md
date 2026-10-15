# FIN-01.3 — disabled reminder delivery candidate

October 15, 2026. Base: `8e547fe169ae489c715fffdcb681b8471eb9a895`.
The preview (#237) is already deployed; this is a separate unmerged candidate.

## Why and behavior

The preview has no outbound delivery or persistent duplicate guard. This change
adds an editor/trigger-only sender using the same queue classifications and
workday calendar. Vered receives her work; Ortal receives verification work and
oversight of Vered. Mail is aggregate Hebrew RTL HTML plus plain text, with a
link to Billing Control and no patient names, identifiers, amounts or notes.

Sending stays disabled until recipients, hour, policy and explicit replacement
of the existing payments digest are configured. No hour/threshold defaults are
invented. Complete current sources are mandatory. The dated calendar is bundled
from the shared tested implementation; regeneration is deterministic:
`node scripts/build-billing-reminder-core.js`.

Script locking plus a durable per-owner/day attempt marker prevent concurrent
and repeated invocations, including a surviving old digest trigger. A thrown
provider call is uncertain, not success and not automatically retried that day.
A failed success-state write retains the pre-send marker. Known pre-send failures
remain retryable. Provider return does not prove inbox delivery.

The opt-in transition routes the old scheduled handler through the same sender;
its existing behavior stays intact while the flag is absent/false. Installation
is a separate editor operation. No HTTP send/configuration routes, source-sheet
writes, dependencies, access changes, frontend or service-worker changes.

## Validation

- Twenty focused delivery tests: config, audience/privacy, calendars, stale and
  partial sources, thresholds, quota, concurrency, uncertain send, failed state
  writes, corrupt/future state, Israel DST, source-read-only integration,
  old-trigger deduplication and no HTTP dispatcher entry.
- Generated core matches the source and all dates from 2020–2035, without Intl
  at Apps Script runtime. Work-age calculation parity includes year boundaries.
- Fixed a tokenizer coverage bug exposed by template literals in the shared
  generated module: template delimiters were omitted from its regions. Added
  contiguous-region coverage for empty/nested templates; invisible-character
  rules remain strict and unchanged.
- Real-browser email case covers Hebrew RTL and phone/desktop bounds without
  remote assets; CI retains synthetic screenshots. Chromium rendering is not
  a guarantee for every email client; recipient inbox verification is part of
  separately authorized activation.
- Full suite and browser CI results are recorded in the PR after completion.
  Dependency audit: zero high/critical, one existing moderate; dependencies unchanged.

## Rollout boundary

No real email, live properties or trigger installation in this change. Recipient
mapping is stored privately, not in git. Sandra must settle the hour/policy and
replacement of the old digest; new release and activation need separate approval.
See [the concrete rollout and stop procedure](docs/billing-reminder-rollout.md).
CRM #220, broader security/speed work and FIN-02–04 are unchanged.
