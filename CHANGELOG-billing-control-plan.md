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

## Sandra's final answers applied (01/10/2026, second round)

- **A. Strict payment report.** Required: patient (from the list only),
  amount (> 0, ₪), payment date (valid, not in the future, not before entry),
  method (fixed list of six; "אחר" needs a note), payer name, billing cycle
  (preselected), and a receipt photo or reference number. Validated in the UI
  (send disabled + Hebrew message naming the field) and on the server (rejected,
  nothing written). Validation table R0–R12 with a test per rule. The old
  "שולם" select now opens the report form instead of saving directly.
- **B. Ortal owns follow-up.** Every alert, reminder and escalation goes to
  Ortal (Vered gets her own tasks). No automatic escalation to Sandra. Sandra
  gets a read-only "חריגים פתוחים" view (age, owner, next step).
- **C. No long-term receipt retention.** Receipts are deleted automatically
  once confirmed and the month is closed; the deletion is logged and the
  reference number kept. The 7-year rule is dropped (חשבשבת is the record).
- **D.** Entry day = day 1 for the 14-day rule, which makes the current code
  wrong (a correction to the previous round); refund payout cutoff moves to
  the 10th; a fully prepaid cycle after the exit is always refunded; opening
  balance frozen as of the run date; payer is free text; personal PINs replace
  the shared PIN in the security phase; undoing a void is Sandra only; no
  change to the shared revenue rules or Outpatient in this phase.
- All open questions removed; five assumptions listed in §15.
