# PWA follow-up (PR 2): mobile UX for the kanban board and growth graph

Frontend-only. Builds on the PR-1 PWA foundation, which deliberately left the
kanban columns and growth graph for this PR.

## Kanban — horizontal scroll-snap carousel (≤768px)

`public/style.css`, new `@media (max-width: 768px)` block:

- The board becomes a horizontal, one-column-at-a-time carousel:
  `.kanban { display:flex; overflow-x:auto; scroll-snap-type: x mandatory }`.
- Each `.col` is `flex: 0 0 88vw` with `scroll-snap-align: start`, so exactly one
  column fills the view and the **next column's edge peeks** as a cue that more
  exist.
- Momentum scrolling via `-webkit-overflow-scrolling: touch`; `overflow-y:
  visible` so vertical swipes fall through to the page (no scroll hijack);
  `overscroll-behavior-x: contain` stops end-of-list bounce / back-navigation.
- **Desktop unchanged:** the base `.kanban` 4-column grid and the ≤900px rules
  are untouched; the flex/scroll-snap layout only applies at ≤768px.

### Drag/touch note (no tradeoff)

The board has **no drag-and-drop** — leads move between stages with the on-card
buttons (`שלב הבא` / `שלב קודם` → `advanceLead`/`moveLead`). A repo-wide search
for `draggable`/`dragstart`/`Sortable`/`touchmove` returns nothing. So the new
horizontal swipe cannot fight a drag gesture, and there is no drag-vs-scroll
tradeoff to document.

## Growth graph — width-aware SVG

`public/app.js`:

- `growthLineChartSVG` is now width-aware: it takes `opts.width` and uses it as
  the coordinate width `W` (fallback **760** — the historical desktop box),
  clamped to a **280px floor** so labels never collapse. Height tracks width
  (`≈ W × 0.316`, i.e. 240 at 760) with a **200px minimum** so the plot stays
  legible on a phone.
- `renderGrowthGraph` now renders in two passes: it writes the card shells with
  empty `.growth-chart` slots, **measures each slot's `clientWidth`** (fallback
  760 when the screen is still hidden), then renders the SVG into it.
- The existing `growthTickIndices` cap (one label per ~70px of plot width) means
  a narrow container automatically thins the x-axis — a 360px container renders
  ~4 evenly spaced labels with the last `end`-anchored, nothing clipped.
- Re-renders on `resize` / `orientationchange`, debounced (150ms) and gated on
  the growth screen being active, so rotating the phone reflows the charts.

## Tests

`test/growth-graph-labels.test.js` extended (now also exercises the rendered
SVG string, not just the tick helper):

- 360px and 414px containers: ~4–5 labels, **no x-coordinate exceeds the viewBox
  width** (proves nothing clips), last label `end`-anchored.
- Width fallback (missing → 760) and floor (120 → 280).
- Desktop 760 still yields 8 labels, last `end`-anchored, nothing clipped.

Full suite: `npm test` → **131 passing**.
