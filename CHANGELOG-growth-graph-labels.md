# Growth graph — x-axis label overlap/clipping fix

On the גרף צמיחה tab the x-axis date labels overlapped near the right edge of
both SVG charts, and the last label was cut off. Frontend-only, `public/app.js`.
**No `Code.gs` change, no Apps Script deploy.**

## Root cause

`growthLineChartSVG()` thinned labels with `every = ceil(n / maxXLabels)` and
kept every `every`-th index plus a forced last index. When `n-1` wasn't a
multiple of `every`, the forced last label landed adjacent to the previous kept
one (~76px apart for ~73px-wide `dd/mm/yyyy` labels) → collision. The last label
was also `text-anchor="middle"` at `x = W - padR` (744 of a 760 viewBox), so half
of it rendered past the right edge → clipped.

## Fix

1. **Tick selection** extracted into a pure, testable `pickTickIndices(n,
   plotWidth, labelWidth)`. It computes the minimum index spacing needed so
   adjacent labels stay `labelWidth` apart
   (`minDelta = ceil(labelWidth / pxPerStep)`), picks at most
   `floor((n-1)/minDelta)+1` evenly-spaced indices, and **always includes the
   first (0) and last (n-1)** points. Because the even step stays ≥ `minDelta`,
   integer rounding can never place two labels closer than `minDelta` — so no
   overlap, even for narrow charts (which collapse to just `[0, n-1]`).
2. **Edge anchoring:** the first label is `text-anchor="start"` and the last is
   `text-anchor="end"` (middle labels stay `middle`), so neither extreme renders
   outside the viewBox.
3. **`dir="ltr"` on the `<svg>`** so RTL layout never mirrors the plot
   coordinates (which is what makes `start`/`end` resolve to left/right). The
   `.growth-svg { direction: ltr }` rule already existed; the attribute makes it
   robust even without the stylesheet.
4. `labelWidth` defaults to **100px** — the measured `dd/mm/yyyy` footprint
   (~73px) plus headroom for the edge-anchored extremes (which occupy a full
   label-width inward). Dead `maxXLabels` option removed from the two call sites.

## Verification

Measured every label's rendered bounding box in Chromium (real `style.css` +
the shipped functions) across n = 2…104 for both the weekly `dd/mm/yyyy` and
monthly `yyyy-mm` series: **no overlaps, nothing outside the 0..760 viewBox,
worst-case gap +23px.**

## Tests

`test/growth-graph-labels.test.js` (node:test + vm-sandbox) locks the
`pickTickIndices` contract: first/last always included; strictly-increasing,
unique, in-range indices; adjacent center-spacing ≥ `labelWidth` (the
no-overlap invariant) for n = 2…120; narrow charts collapse to the endpoints;
degenerate n (0 → `[]`, 1 → `[0]`).

Full suite: **120 passing** (`npm test` → `node --test`).
