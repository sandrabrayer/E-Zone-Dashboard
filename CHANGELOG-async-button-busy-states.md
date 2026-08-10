# Async-button busy states — spinner/disabled pass on every async trigger

PR-R3 of the restore-fix plan. Every control that fires a slow Apps Script
round-trip now freezes (disabled + spinner/dim) for the duration, so nothing
can be double-fired mid-save.

## Inventory — every async trigger and its guard

| Surface | Guard |
| --- | --- |
| `showModal` submits (add/edit lead, admit, edit patient, …) | already had full busy discipline — unchanged |
| `showCloseLeadModal` (close lead / discharge) | already had it — unchanged |
| Restore-choice modal (PR-R1) | already had it — unchanged |
| **`showConfirm` flows** (remove lead, restore irrelevant lead, …) | **NEW** — used to close instantly and run `onConfirm` untracked; now stays open with both buttons frozen + spinner until the worker settles, then closes. Double-click and backdrop-close are guarded while busy. Errors still surface via toast. |
| **Renewal-alert "חידוש תשלום"** | **NEW** — wrapped in `withBusyButton`; `renewPatient` now returns its settle promise so the wrapper can track it (behavior otherwise identical). |
| **תפוסה delete (✕)** | **NEW** — wrapped in `withBusyButton`. |
| **Billing row status select + שולם-בפועל input** | **NEW** — both controls freeze and the row dims (`.billing-row.saving`) while `savePayment` is in flight; re-enabled on settle (rollback/toast unchanged, owned by `savePayment`). |

## New pieces

- **`withBusyButton(btn, fn)`** — disable + `.busy` for the duration of an async
  action; restores on settle (success or failure — rejections propagate after
  the restore); passthrough on a falsy button. Single reusable primitive.
- **CSS**: `.btn.busy` (dim + inline spinner; `border-inline-start` /
  `margin-inline-start` logical properties keep the spinner RTL-correct) and
  `.billing-row.saving` (row dim).

## Tests — `test/async-button-busy-states.test.js` (8 new)

- `withBusyButton`: freeze during, restore after, restore + propagate on
  rejection, pre-disabled preserved, falsy-button passthrough.
- `showConfirm`: stays open + frozen while an async `onConfirm` runs; the
  worker runs exactly once under double-click; backdrop close guarded while
  busy; error surfaces via `showError` and the dialog still closes; normal
  cancel/backdrop close unaffected when idle.
- `renewPatient` returns a thenable and still writes the paid record.
- Billing row: status change freezes select + input + dims the row until
  `savePayment` settles, then re-enables.

Full suite: `npm test` — **401 pass, 0 fail** (zero regressions).

## Stacking

Built on `feature/occupancy-show-released` (PR-R2), which stacks on
`feature/restore-choice-modal` (PR #73) — merge order: #73 → R2 → R3.
Frontend-only (app.js, style.css); no backend change.
