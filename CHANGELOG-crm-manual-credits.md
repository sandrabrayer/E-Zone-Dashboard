# CRM credits: edit a saved credit + Sandra's manual credit (2026-11-05)

Sandra, 05/11/2026: «כשלוחצים לזיכויים זה מחזיר לאפליקציה הקודמת. אנחנו רוצים שהכל יהיה פה.»

## What changed (CRM only — `public/crm/crm.js`; no Code.gs, no server change)
In the patient card → «חשבון» → «זיכויים»:
- **«עריכה»** on every unpaid credit (finance sessions — Vered, Sandra):
  - amount — editable by Sandra only (read-only for Vered); a reason is required when it differs
    from the policy figure (`calculatedAmount`);
  - decision date, notes;
  - status «ממתין» / «בוטל» — «בוטל» offered to a deleter only and requires a note.
  A paid credit is locked (payout goes only through the request → approve → settle flow).
- **«+ זיכוי ידני»** (Sandra only): month, amount > 0, reason → a credit of type «אחר».
- The classic links «זיכויים ידניים», «עריכת קבלות», «שיוך תשלומים» are gone from «גבייה»
  (all three are in the CRM); the classic dashboard stays linked as a backup only.

## Authority (unchanged)
The CRM sends the SAME `saveCredit` action as the classic modal:
- Express: finance scope; cancel → `cancelCredit` (deleter); a manual create →
  `approveRefundException` (approver).
- Code.gs `upsertCredit_`: recalculates the policy figure, refuses an amount change or manual
  credit without Sandra (`override_requires_approver`), refuses `paid` (`use_settleRefund`),
  refuses a stale edit (`updatedAt` → `conflict`).
The CRM accepts a save only when the answer echoes the credit id (`creditSaveRefusal`); every
refusal is shown in Hebrew and the form stays open.

## Tests
New `test/crm-manual-credits.test.js` (6) + a Chromium test in `test/crm-shell-browser.test.js`
(Vered edits, Sandra adds; reasons enforced; no classic link). Updated: C8 browser assertion,
`crm-kpi-tab` (credits no longer classic-only), SW pins.

## Files
`public/crm/crm.js`, `public/sw.js` (v115 → v116), `EZONE-ECOSYSTEM-STATUS.md`, tests above.
