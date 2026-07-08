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

# PWA icon redesign — bold block E, letter #2962ff (follow-up)

Refines the rebrand above: same **bold block-E** approach, but the letter color
moves to **`#2962ff`** (a deeper, higher-contrast blue) and the boldness is now
enforced by a test so it can't silently regress. Frontend / static assets only —
**no `Code.gs` change, no Apps Script deploy.**

## What ships

1. **Icons** (`public/icons/`) — 192, 512 and maskable-512 redrawn from scratch
   as a **bold geometric block "E"** (thick vertical spine + three thick equal
   arms; stroke ≈ **19% of canvas height**, E filling ≈ **70%**, centered, 8×8
   supersampled AA). Background `#ffffff` (opaque), letter **`#2962ff`**. The
   maskable keeps the glyph inside the mask safe zone with white padding to the
   edge. Verified bold and readable at **48 / 64 / 96 px**. Measured ink
   coverage: ≈36% (192/512), ≈20% (maskable).

2. **`public/manifest.json`** — `short_name` stays `"Dashboard"` (`name`
   `"E-Zone Dashboard"` unchanged).

3. **`public/sw.js`** — `CACHE_VERSION` bumped `v3` → `v4`
   (`ezone-dashboard-v4`), so the interim `#5b8bff` icons are evicted on
   `activate`.

## Tests

`test/pwa-foundation.test.js`:

- **cache version floor** — the locked-value check becomes a *floor*: the
  version number must be `≥ 4` and `CACHE_NAME` must embed it, so the version
  can advance later but never regress below the redesign.
- **boldness guard (new)** — decodes each icon and asserts letter ink coverage
  stays above a floor (25% for 192/512, 13% for maskable), well below the
  measured actuals — a regression to a thin glyph fails loudly.
- **palette** — the letter-color check now requires `#2962ff` present and
  asserts **both** superseded colors (green `#2dd47a`, interim `#5b8bff`) are
  fully gone; opaque-white-background / no-transparent-maskable checks unchanged.

Full suite: **130 passing** (`npm test` → `node --test`).
