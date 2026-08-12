# CHANGELOG — Waitlist stage UI (PR 2 of 2)

## What this is

The רשימת המתנה (waitlist) stage goes live on the leads kanban. A lead in
this stage is a potential patient waiting for a spot; the card's existing
house label is the house they are waiting for. Builds on the foundation PR
(#83), which shipped the `waitlistedAt` column and the gated `STAGE_WAITLIST`
constant.

## Column placement — between ביקור נקבע and בטיפול פעיל

The board is now: **ליד חדש → ביקור נקבע → רשימת המתנה → בטיפול פעיל**.

Why this slot:

- Semantically: a lead that visited and is waiting for a spot to open before
  it can start active care.
- Mechanically it's the only placement where every existing move path works
  with zero special cases: visit's שלב הבא enters the waitlist, waitlist's
  שלב הבא reaches paid, the שלב קודם buttons mirror both, and paid's admit
  action (`advanceLead` is keyed on the stage **id**, not array position) is
  untouched. Placed last it would be unreachable — paid's "next" is the admit
  action, so no button path would ever move a lead in.

The pipeline strip on the dashboard inherits the new stage automatically
(`ALL_STAGES_FOR_PIPELINE` derives from `STAGES`). The desktop kanban grid was
already `repeat(4, 1fr)` (from the removed entry column), and the mobile
carousel is count-agnostic, so the fourth column needs no layout change.

## Stamp logic (`moveLead`)

`moveLead` is the single choke point for board stage changes (the on-card
שלב הבא/קודם buttons — the app has no drag-and-drop), so the stamping lives
there:

- Moving **into** the waitlist sets `waitlistedAt = new Date().toISOString()`.
- Moving **out** (forward or back) clears it to `''`, so a future re-entry
  restamps.
- Persisted through the existing optimistic path: mutate → `renderAll()` →
  `saveAll()`, with the catch-block rollback now restoring **both** `stage`
  and `waitlistedAt` before re-rendering and showing the error toast.

Closing a lead (לא רלוונטי) or removing it takes the row off the board via its
own sheet-move action and intentionally keeps any stamp, so a restore back to
the waitlist stage resumes the original waiting clock.

## Card badge

Waitlist cards show a waiting-duration pill under the meta line:

- day 0 → `ממתין מהיום`, 1 day → `ממתין יום אחד`, N days → `ממתין N ימים`.
- Computed by **calendar-date diff** (not hour diff): `waitlistDayCount` runs
  `waitlistedAt` through the existing `isoDate` (whose bare-date regex is
  anchored — a full ISO timestamp is never prefix-matched; timestamps resolve
  to the local calendar day), then diffs the two dates in UTC space so a DST
  transition can't produce an off-by-one.
- Blank/unparseable `waitlistedAt` (legacy rows) → no badge at all, never NaN.
  A future-dated stamp (clock skew) clamps to day 0.
- The badge renders only in the waitlist column; the card's existing meta line
  keeps the house visible (that's "which house they're waiting for" — no new
  field).

`waitlistDayCount` / `waitlistBadgeText` are pure and take an injectable `now`
for tests; production callers omit it.

## Async guards

No new action buttons were added — moves reuse the existing שלב הבא/קודם
buttons — so no new `withBusyButton` wiring was needed.

## Styling (`public/style.css`)

- New `--stage-waitlist` color (`#19c8e0`), applied to the kanban column
  title/top-border and the dashboard pipeline pill via the existing
  `[data-stage]` rule pattern.
- New `.lc-wait-badge` pill on lead cards.

## Tests

- New `test/waitlist-ui.test.js` (node:test, vm-sandbox on the real shipped
  functions): stage order incl. pipeline strip; rendered board shows the
  column with its card and house; move-in stamps ISO timestamp / move-out
  clears / re-entry restamps; failed save rolls back both fields (both
  directions); badge day counts for day 0 / 1 / N / blank / garbage /
  future-clamp; card renders badge only on waitlist cards and never NaN.
- `test/waitlist-foundation.test.js`: the PR-1 "zero-UI-change gate" tests
  are removed (this PR deliberately reverses them); all schema/normalization
  guards stay.

## Deployment

Nothing manual — Apps Script deploys automatically via clasp CI on merge (no
backend change in this PR anyway).
