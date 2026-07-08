# Fix: large currency KPI values clipped on mobile

On mobile, big currency figures on the KPI/summary cards were clipped —
`₪1,513,200` rendered as `₪3,200` (leading digits cut).

## Root cause (confirmed)

Both the main dashboard and the נקודת איזון summary use `.card.stat` →
`.stat-value`, which is `font-size: 42px`. `.card` has `overflow: hidden`
(and 22px padding), so on a narrow card the oversized value overflows and is
clipped. Under the app's RTL layout the number sits at the right edge, so the
overflow is cut from the **left** — removing the LEADING digits. That is
exactly `₪1,513,200 → ₪3,200`. The per-house `.be-metric-value` cells (15px)
can clip the same way in the 2-column grid on small phones.

## Fix — the full number is always visible (no abbreviation)

Currency is never abbreviated; Vered needs exact figures.

**CSS (`public/style.css`):**

- `.card.stat .stat-value`: `font-size` → `clamp(22px, 6vw, 42px)` (responsive
  baseline), `white-space: nowrap`, and `direction: ltr; unicode-bidi: isolate;
  text-align: right`. The value is always a pure number, so forcing an isolated
  LTR run is the "wrap the number in `dir="ltr"`" fix applied at the element —
  the RTL page can no longer clip or reorder its leading digits.
- New `.num-ltr` utility (`direction: ltr; unicode-bidi: isolate; white-space:
  nowrap`) for currency values that live inside mixed Hebrew+number cells.
- `.be-metric-value`: `white-space: nowrap` so it measures on one line.
- `@media (max-width: 560px)`: `.cards-row` becomes a single full-width column,
  giving the stat cards room for 7-digit values on phones.

**JS (`public/app.js`):**

- New `fitStatText(el)` / `fitAllStatText()`: after a value is written, shrink
  its font-size until the single-line content fits its box (down to a 14px
  floor). This **guarantees** the whole number fits at any width / column count
  — belt-and-suspenders over the CSS `clamp()`, covering edge cases (e.g. a
  narrow 3-up desktop) that viewport-based `clamp()` alone can't. It no-ops when
  the element isn't laid out (hidden screen) or already fits.
- Called at the end of `renderDashboard`, `renderBreakevenSummary`, and
  `renderBreakevenHousesGrid`; re-runs on debounced `resize`/`orientationchange`
  so rotating the phone re-fits.
- Per-house currency metrics (total expenses, avg price, marginal profit,
  current P/L) are wrapped in `<span class="num-ltr">`.

Applied to every currency-bearing card on both tabs: dashboard revenue, the
three network-summary cards, and the per-house metric cards.

## Tests

**No unit test added — this is a CSS + DOM-measurement fix, not a change to any
number-formatting logic.** The value strings still come from the unchanged
`toLocaleString('he-IL')` calls; `fitStatText` only measures `scrollWidth`
vs `clientWidth` and adjusts `font-size`, which requires a real layout engine
the `node --test` vm harness doesn't have (it no-ops there). The existing suite
still passes: `npm test` → **131 passing**.

Real-device note: the fit/clamp math is verified by reasoning, but the actual
shrink-to-fit depends on browser layout — worth a quick check on a real phone.
