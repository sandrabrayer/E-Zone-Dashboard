# PWA icon rebrand — ecosystem color scheme

Part of the ecosystem-wide PWA icon rebrand. This is the **E-Zone Dashboard**
app's slice: the installed-app icon moves from the old green-on-dark mark to the
shared scheme — **white background, `#5b8bff` letter** — and the home-screen
label is shortened to **"Dashboard"**.

Frontend / static assets only. **No `Code.gs` change, no Apps Script deploy.**

## What ships

1. **Icons** (`public/icons/`) — the 192, 512 and maskable-512 PNGs redrawn as a
   **bold, heavy block letter "E"** (this replaces the old thin logo mark — the
   glyph is drawn from scratch, not recolored):
   - a thick vertical spine plus three thick equal-length arms; stroke thickness
     ≈ **19% of the canvas height**, the E filling ≈ **70%** of the canvas and
     centered
   - background `#ffffff`, letter `#5b8bff`
   - **every pixel fully opaque** — the maskable safe-zone padding is the white
     background color, so Android's circular/rounded mask never reveals a
     transparent (cropped-looking) border.

   The E is rasterized with **8×8 supersampled anti-aliasing** for clean edges,
   and stays crisp and readable when scaled down to home-screen size (verified
   at 48 px). The maskable variant uses the same E scaled to ≈74% so all strokes
   sit well inside the mask safe zone.

2. **`public/manifest.json`** — `short_name` changed `"E-Zone"` → `"Dashboard"`.
   The full `name` (`"E-Zone Dashboard"`) is unchanged.

3. **`public/sw.js`** — `CACHE_VERSION` bumped `v2` → `v3`
   (`ezone-dashboard-v3`). The old green icons were cache-first static assets,
   so bumping the version evicts them on `activate` and the new icons take over
   without a manual cache clear.

## How the icons were generated

A **self-contained Node script** using only built-ins (`fs`, `zlib`) — no
`canvas`, `sharp`, or any new dependency, modeling on the PWA foundation PR's
built-in-zlib encoder. It:

- composes the E from four axis-aligned rectangles (spine + top/middle/bottom
  arms) sized from `height`, `width` and `stroke` fractions of the canvas,
- computes each pixel's letter coverage by 8×8 supersampling, then writes
  `white·(1−cov) + #5b8bff·cov`, alpha `255`,
- encodes with a hand-rolled PNG writer (CRC32 chunks, `deflate` IDAT).

Because it is a one-off generation tool (matching the foundation PR's
convention), it is not committed to the repo.

## Tests

`test/pwa-foundation.test.js` extended:

- **manifest validity** — `short_name` is now asserted to equal `"Dashboard"`
  (full `name` still `"E-Zone Dashboard"`); the existing icon-declaration and
  file-existence checks still pass.
- **cache version bump** — the locked-value test now requires
  `CACHE_VERSION === 'v3'` / `CACHE_NAME === 'ezone-dashboard-v3'`, so an
  accidental revert fails loudly.
- **icon palette** (new) — a built-in-only PNG decoder verifies the actual
  pixels of all three icons: the top-left corner is opaque white, **no pixel is
  even partially transparent** (maskable safe zone is white), the `#5b8bff`
  letter color is present, and **no old-green (`#2dd47a`) pixel remains**.

Full suite: **129 passing** (`npm test` → `node --test`).

---

# PWA icon redesign — bold geometric E, `#0055ff` on dark with a white halo

Follow-up to the rebrand above. The letter mark is **redrawn from scratch** as a
heavier, more geometric block "E" and the palette returns to the **original dark
`#071410` background** with a **`#0055ff`** blue glyph, now wrapped in a **white
contour halo** so the logo pops against the dark field. Frontend / static assets
only. **No `Code.gs` change, no Apps Script deploy.**

## What ships

1. **Icons** (`public/icons/`) — the 192, 512 and maskable-512 PNGs redrawn as a
   **bold geometric block "E"**, composed from four axis-aligned bars (a thick
   vertical spine plus top / middle / bottom arms):
   - stroke thickness ≈ **19% of the canvas height**, the E bounding box filling
     ≈ **68%** of the canvas (56% wide) and **centered**
   - background `#071410` (original dark, fully opaque), letter `#0055ff`
   - **white `#ffffff` contour halo** — the glyph's own coverage mask **dilated
     by ≈2% of the canvas** (≈10 px @512, ≈4 px @192) via a true **Euclidean
     distance field** to the union of the bars, painted beneath the blue glyph.
     It follows the letter's **exact contour** (rounded at corners,
     anti-aliased) — a real halo, not a rectangular box.
   - **every pixel fully opaque** — the maskable safe-zone padding is the dark
     background, so Android's circular/rounded mask never reveals a transparent
     (cropped-looking) border
   - rasterised with **6×6 supersampled anti-aliasing**; verified bold and
     readable, with the halo reading as a clean outline, when scaled to
     48 / 64 / 96 px
   - the maskable variant scales the glyph **and its halo** to ≈74% so both sit
     inside the mask safe zone.

2. **`public/manifest.json`** — `short_name` remains `"Dashboard"`, full `name`
   remains `"E-Zone Dashboard"` (unchanged).

3. **`public/sw.js`** — `CACHE_VERSION` bumped `v3` → `v4`
   (`ezone-dashboard-v4`), evicting the previous `#5b8bff` icons on `activate`.

## How the icons were generated

`tools/gen-icons.js` — a **self-contained Node script** using only built-ins
(`fs`, `zlib`), no `canvas` / `sharp` / new dependency. It composes the E from
four rectangles sized as fractions of the canvas; for each pixel it supersamples
(6×6) the **distance to the union of the bars**, deriving both the glyph
coverage (distance 0) and the halo coverage (distance ≤ ring width) so the white
outline follows the contour exactly; composites `bg → white·halo → blue·glyph`
at alpha `255`; and encodes with a hand-rolled PNG writer (CRC32 chunks +
`deflate` IDAT). Committed so the icons are reproducible. Run:
`node tools/gen-icons.js`.

## Tests (`test/pwa-foundation.test.js`)

- **cache version floor** — replaces the locked `=== 'v3'` check with a FLOOR:
  `CACHE_VERSION` must parse to `>= v4`, so a revert to an older version fails
  loudly while future bumps still pass.
- **palette** — asserts each icon contains `#071410` background, `#0055ff`
  letter, and white `#ffffff` halo pixels, and that no earlier mark remains
  (old green `#2dd47a`, previous blues `#5b8bff` / `#2962ff`).
- **opaque dark background** — the top-left corner is exactly `#071410` and
  fully opaque, and no pixel anywhere is even partially transparent.
- **boldness guard** — a built-in-only PNG decoder measures letter-ink coverage
  per icon and asserts it clears a floor (25% for 192/512, 14% for the shrunk
  maskable), so a thin / hairline glyph can never silently regress the bold
  block E.

Full suite: **140 passing** (`npm test` → `node --test`).
