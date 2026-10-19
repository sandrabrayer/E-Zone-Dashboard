# «לא נכנס» on «ממתינים לקליטה» — a soft close, never a delete (2026-10-19)

Each waiting card in the «מטופלים» tab's «ממתינים לקליטה» section now has **«לא נכנס»** next to «קלוט כמטופל» (edit mode).

## Behaviour
- It opens the **existing** `showCloseLeadModal` through the existing `closeLead`, so it is the same soft close as the board's «סגירת ליד»:
  - the lead moves from Leads to the closed sheet, which is shown in the **שימור לידים** tab;
  - `moveLeadIrrelevant_` records disposition, note, origin stage and `movedAt`, and writes an audit-log entry;
  - **no row is hard-deleted**, and «שחזר ליד» there brings it back.
- Dispositions offered: the lead ones that fit a person who never entered: `not_relevant` «לא רלוונטי» and `stopped_early` «הפסיק לפני הזמן» (`WAITING_NOT_ENTERED_DISPOSITIONS`).
- **A reason is required:** `showCloseLeadModal` gained an opt-in `requireNote` (the label becomes «סיבה *», and submit stays disabled until a status is picked and the reason is filled in). Existing callers pass nothing and behave the same as before.
- Optimistic: the card leaves the waiting list at once. On failure it is rolled back and the modal stays open (closeLead's existing R3 path).

## Server (Code.gs) — validation
- `moveLeadIrrelevant_` now refuses an unknown disposition (`bad_disposition`). A blank disposition keeps the legacy `not_relevant` default.
- The note is stored formula-safe: control characters are stripped (newlines kept), a leading `= + - @` is removed, and it is capped at 500 characters.
- The request flag `requireReason` (sent by «לא נכנס») makes the server refuse a close with no disposition or no reason (`reason_required`). The board's close does not send it.
- Code.gs ships through the clasp CI on merge.

## Other
- SW v74 → **v75** (stacked on #253).
- Tests: `test/waiting-not-entered.test.js` (9): UI button, modal options, optimistic move + payload, rollback, board close unchanged, required-reason gating, server refusal / soft move / sanitizing / allowlist.
