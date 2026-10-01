# Billing-control plan — planning document (docs only)

**What:** `docs/billing-control-plan.md`, a Hebrew planning document for the
בקרת גבייה module. **No code, sheet, trigger or deploy change.** No test
changes: the document describes tests to be written in later phases.

## Sandra's decisions applied (01/10/2026)

1. **Location:** a new בקרת גבייה tab inside the existing Dashboard. This
   **supersedes the 21/09 decision** for a separate accounting app, and with
   it the 22/09 principle "Dashboard holds no accounting state"
   (`CHANGELOG-accounting-source-feed.md`). The read-only accounting feed
   stays.
2. **Balance houses (asher, ramot):** "last 7 days" = the last 7 days of the
   patient's own billing month (the paid coverage window), not the calendar
   month. The code uses the calendar month today (`app.js:5714`), so this is a
   required logic change in phase 1, with a failing test first.
3. **Rehab / dual-diagnosis:** no refund from day 14 inclusive. The code
   (`tenureDays < 14`) matches; a pinning test (13 = refund, 14 = none) is
   planned. The plan flags how "day 14" is counted as an open question.
4. **No bank import:** `BankLines`, `BankMatches` and automatic matching are
   removed. Ortal works a daily queue (reported payments + cycles due with
   nothing reported), checks the bank herself and marks each one confirmed or
   flagged with a short note. Only confirmed counts as revenue.
5. **Refund exceptions and write-offs:** Sandra only, enforced on the server.

Phases, acceptance tests and open questions were updated to match.
