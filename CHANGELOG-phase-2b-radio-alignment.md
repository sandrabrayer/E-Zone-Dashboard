# Changelog — "Phase 2b follow-up — radio button alignment in reason modal"

Phase 2b's `showIrrelevantReasonModal` rendered each radio circle stacked above its label text instead of inline next to it. Root cause: `.reason-radio` had no CSS, and the project's `.modal label { display: block }` rule (specificity `0,0,1,1`) was being inherited by the `<label>` wrapper around each radio + text pair. Also reset uppercase/letter-spacing/muted color so Hebrew labels render normally instead of as form-row labels.

## [Unreleased]

### Why this exists

1. Bare `.reason-radio` selector (specificity `0,0,1,0`) cannot override `.modal label` — needed `.modal .reason-radio` scoping to win.
2. The form-row label styling (uppercase, muted, letter-spaced) is wrong for radio option labels — added minimal resets.
3. `.modal input { width: 100% }` would stretch the radio circle full-width, so `width: auto` reset added on the input.

### Changed (public/style.css)

- Added `.modal .reason-radio` flex rule (display: flex, align-items: center, 8px gap, 4px vertical padding) so the radio circle sits inline with its label.
- Added `.modal .reason-radio input[type="radio"]` reset (`width: auto`, `margin: 0`, `flex-shrink: 0`).

### Not changed (intentional)

- `public/app.js` — radio markup unchanged.
- `apps-script/Code.gs` — no schema or backend change.
- Other modal styling — untouched.

### Manual test

1. Hard refresh https://ezone-dashboard.up.railway.app.
2. Open any active lead → click לא רלוונטי ✕.
3. Confirm: each of the 3 radio options renders with the circle inline (right side in RTL) of its Hebrew label text, with a small gap. Labels are normal-case, normal weight, full-contrast — not uppercase/muted.
