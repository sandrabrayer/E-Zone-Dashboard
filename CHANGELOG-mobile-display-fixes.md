# Fix: two mobile-display issues (renewal-card clipping + build overlay)

CSS/markup only. No `Code.gs`, no Apps Script, no Apps Script deploy. Both
issues were mobile-only, confirmed via screenshots.

## Issue 1 — renewal cards clipped off the left edge on mobile

The dashboard's renewal alert ("חידושי תפוסה — השבוע הקרוב") rendered its cards
overflowing horizontally on phones: the "חידוש תשלום" button and card edges were
cut off at the **left** viewport edge. Scoped to this block only — the שימור
לידים (retention) tab rendered correctly, so the global mobile shell was healthy.

### Root cause (confirmed)

Each renewal card is `.renewal-row` (`public/app.js` `renderRenewalAlert`), laid
out with `public/style.css`:

```css
.renewal-row { grid-template-columns: 1.6fr 1fr auto; }
```

The third column is `auto`, holding `.rn-actions` — the חידוש תשלום / שחרור
buttons, which have an intrinsic min-width and cannot shrink. On a phone
`1.6fr + 1fr + (two buttons)` exceeds the viewport, so the row overflows. The
page is RTL (`<html dir="rtl">`, `body { direction: rtl }`) with a
`html/body { overflow-x: hidden }` guard, so the overflow spills off — and is
clipped at — the **left** edge. That is the exact symptom in the screenshot.

The retention list (`.irrelevant-row`) shares the same desktop multi-column grid
pattern but already had a `@media (max-width: 900px)` override collapsing it to
`1fr 1fr`. `.renewal-row` had **no** mobile override — the single missing rule
was the whole bug.

### Fix (scoped to `.renewal-row` only)

Added inside the existing `@media (max-width: 900px)` block, next to the
`.irrelevant-row` override:

```css
.renewal-row { grid-template-columns: 1fr; }
.renewal-row .rn-actions { justify-self: stretch; }
```

On mobile the info / date / actions now stack full-width and right-aligned, so
nothing overflows. Desktop layout is unchanged. The global mobile shell and the
retention tab's `.irrelevant-row` rules were not touched — `.renewal-row` and
`.irrelevant-row` share no class (only the common `.screen` ancestor), so the
fix cannot regress שימור לידים.

## Issue 2 — `build: <hash>` debug string bleeding into the UI

A `build: <hash>` string rendered as a fixed bottom-left overlay over the last
card, visible on **all** tabs (global, not tab-scoped).

### Root cause (confirmed)

`public/index.html` carried a visible overlay:

```html
<div id="build-marker" style="position:fixed;bottom:6px;left:6px;...">build: __BUILD__</div>
```

`__BUILD__` is substituted server-side per deploy (`server.js` `sendIndex`).
Because it was `position: fixed; bottom: 6px; left: 6px`, it floated over the
cards on every screen.

### Fix (hide but keep inspectable)

The build id is a genuine deploy-verification handle (the ecosystem doc stresses
verifying which build is live), so it is preserved off-screen rather than
deleted:

- Added `<meta name="build" content="__BUILD__" />` in `<head>` — the primary
  lookup handle, confirmable via view-source or
  `document.querySelector('meta[name=build]').content`.
- Converted the overlay to a non-rendering element:
  `<div id="build-marker" hidden data-build="__BUILD__">build: __BUILD__</div>` —
  still inspectable via devtools / `document.getElementById('build-marker')`, but
  never rendered on any viewport.

No visible build string remains on any tab; deploy verification is unaffected.

## Tests

`test/mobile-display-fixes.test.js` (repo's source-reading `node:test` /
vm-sandbox convention — CSS/markup changes are verified by reading the shipped
source, as with `test/mobile-tabs-and-edit-mode.test.js`):

- `.renewal-row` gets a single-column grid inside the `<=900px` block.
- The desktop `.renewal-row` grid (`1.6fr 1fr auto`) is unchanged.
- The retention `.irrelevant-row` mobile override is untouched (scope guard).
- The build id is still exposed via `<meta name="build">`.
- The `#build-marker` element is `hidden` and no longer uses `position: fixed`.

Full suite: `npm test` → **145 passing** (140 prior + 5 new).
