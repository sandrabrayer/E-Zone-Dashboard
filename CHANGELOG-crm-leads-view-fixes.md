# CRM leads view — two fixes (Sandra, 20/11/2026)

Two small, co-reported fixes in the leads board.

## 1. A mobile's lost leading 0 in the lead-edit form

Google Sheets coerces a phone written as a number and drops its leading 0
(`0525264094` → `525264094`). In the lead-edit card («עריכת פרטי הליד») that showed up two ways:
the **«טלפון אחר לגבייה»** input displayed the number without its 0, and because the coerced
billing phone no longer matched the contact phone, the **«טלפון לגבייה ועדכונים»** selector fell to
**«אחר»** instead of **«פונה»**.

- New pure helper **`ilPhoneDisplay(v)`**: a bare 9-digit mobile (`5XXXXXXXX`) regains its leading
  0; anything already valid or not a bare mobile is returned unchanged.
- `billingModeOf` restores the leading 0 on the billing / patient / contact phones **before**
  comparing them, so the selector reads the right mode again («פונה», not «אחר»).
- `leadEditValues` shows the restored phone / contact-phone, and on **save** the coerced value
  self-heals back to its 0-prefixed form (`leadEditPlan` already recomputes the billing phone).

This is display + edit only; the stored sheet value is corrected the next time the lead is saved.

## 2. Newest leads first in the board columns

`board()` kept the raw feed order (append order = oldest first). Each column now lists leads
**newest-first**: the filtered list is reversed, then a **stable** sort by «נוצר» (desc) keeps
same-day leads newest-first too. The table view keeps its own sort control; «משוחררים» and
«לא רלוונטי» are unchanged.

## Tests

- `test/crm-lead-full-edit.test.js`: the coercion case end-to-end (`ilPhoneDisplay`, `billingModeOf`
  reads «פונה», `leadEditValues` shows no stray «אחר», save self-heals `billingPhone`); the legacy
  incomplete-lead test updated to the restored-display baseline.
- `test/crm-shell-ui.test.js`: `board()` newest-first ordering (incl. same-day reverse-append).
- Full suite green. SW cache **v156 → v157**. `npm audit` 0 high/critical.

## Security

No new endpoint, action or secret; a typed phone is still format-validated on save; rendered
values stay escaped.
