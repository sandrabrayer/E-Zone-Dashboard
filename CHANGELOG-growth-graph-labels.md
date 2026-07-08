# Growth graph: fix x-axis date labels overlapping / clipping at the right edge

On the גרף צמיחה tab both SVG charts crowded their x-axis: the last two date
labels collided and the final label was cut off at the right edge of the
viewBox.

## Root cause (`public/app.js`, `growthLineChartSVG`)

- **Uneven final gap.** Labels were thinned with `i % every` plus a forced
  `i === n - 1` special case. When `n - 1` fell just after a kept modulo tick,
  the last two labels landed one point apart and overlapped.
- **Clipping.** Every label used `text-anchor="middle"`, but the last point
  sits at `x = W - padR = 744`; half the centered text spilled past the
  `W = 760` viewBox edge and was clipped.

## Fix

- New pure helper `growthTickIndices(n, maxTicks)`: returns evenly spaced
  indices, always including the first (0) and last (n-1) point, with rounding
  collisions de-duplicated so indices are strictly increasing.
- The renderer derives the cap from the plot area: one label per ~70px of
  `innerW` (`LABEL_W = 70`), then honors the optional caller cap. For the
  standard 760-wide chart that yields ~8 evenly spaced labels ≥ ~98px apart.
- The first label is anchored `start` and the last `end` (interior stay
  `middle`), so no text renders outside the viewBox — this removes the clip
  without needing extra plot padding.
- Added `dir="ltr"` to the `<svg>` so the RTL app layout can't mirror the
  x-axis order or reorder digits/slashes inside the date strings.

## Tests

- New `test/growth-graph-labels.test.js` (vm-sandbox, `node:test`): first/last
  always included, count never exceeds the cap (narrow widths), strictly
  increasing indices, even final gap (the last-two-collision guard), all-points
  when `n` fits the cap, a known even-spacing case, and degenerate inputs.

Full suite: `npm test` → 112 passing.
