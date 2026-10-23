# CHANGELOG — open debts: fix them where you see them; income by funder

## What Vered sees
- **«חובות פתוחים»**: a short «איך קוראים» explainer (what «חוב רשום» and «מחזורים ללא רישום» mean), the funder on every patient row, and on every owed cycle
  **«שולם»** (the existing «דווח תשלום» form) and **«שנה סכום»** (the per-month
  amount). A part-paid cycle offers only «שולם». Both appear in edit mode.
- **«השלמת גורם מממן»**: each patient row (released patients with a debt
  included) now shows **«חוב פתוח»** (the sum of the owed cycles) and a
  «פירוט וטיפול» list with the same two actions per cycle.
- After a payment is reported or an amount changes, the debt view and the
  «בקרת גבייה» queue are re-read.
- **«הכנסות לפי גורם מממן»** (new, in «גבייה»): pick a period (or «החודש»,
  «חודש קודם», «מתחילת השנה»); a funder × house table by the money's received
  date. **Income = only what Ortal verified in the bank.** «ממתין לאימות» is a
  separate column and is never added to the income; void and «לא שולם»
  receipts count nowhere. The funder is the receipt's own, else the patient's
  funder on that day, else «לא הוגדר».
- Monthly summary wording: «נגבה» → «שולם», «יתרה» → «חוב פתוח», with a
  one-line explanation.

## What Ortal sees (accountant)
- In «בקרת גבייה» → «בעיות גבייה»: the unpaid cycles are listed **from
  January 2026 only, newest first**, each with **«שנה סכום»**. No discount.

## Permissions (server.js first, Code.gs again — fail-closed)
- New `AMOUNT_ACTIONS = ['upsertBillingOverride']` (lib/role-scope.js = Code.gs,
  pinned by a test): needs `finance` (Vered, Sandra) OR `accountant` OR
  `approver`. Ortal without `accountant`, Shiran and Yael are refused with
  nothing written. The row is stamped `updatedBy` from the verified session.
  A discount on the same row is untouched by an amount change.
- `upsertBillingOverride` joins `CONTROLLER_ACTIONS` (lib + Code.gs, pinned).
  `deleteBillingOverride` does NOT: Ortal still cannot delete.
- `/api/me` carries `canAmount`.
- `billingControlQueue` returns `problems` to the `finance` capability too.

## Not done on purpose
- **Delete for Ortal.** She can cancel an unconfirmed reported amount
  («הסכום שדווח שגוי - בטל», soft-void with a reason) and change an amount, but a
  hard delete of a debt/payment stays Sandra-only (a pinned rule). Say if you
  want a soft «בטל חוב» with a reason instead.

## Deploy
Service worker v86 (live was v85). Apps Script deploys automatically on merge
(clasp CI) — never paste Code.gs. No Railway variable change.

## Tests
New: amount permissions (Code.gs + server + pins), debt amount check, debt
action buttons, fill-screen debt, Ortal's list (January, newest first), income
by funder (verified vs waiting, void/flagged, period edges, funder resolution),
page wiring. Updated: controller list pins, /api/me shapes, Ortal refusal lists.
