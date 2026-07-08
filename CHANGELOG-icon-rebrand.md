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

# PWA icon redesign — original E-Zone brand logo, recoloured `#0055ff` + halo

Supersedes the block-letter "E" attempts above. The installed-app icon is now
the **original E-Zone brand logo** (the stylised "e" wordmark shared with
ezone-outpatient) — **not** a drawn-from-scratch letter — on the **original dark
`#071410` background**, **recoloured** from its green to **`#0055ff`** and
wrapped in a **white contour halo** so the mark pops against the dark field.
Frontend / static assets only. **No `Code.gs` change, no Apps Script deploy.**

## What ships

1. **Recovered source logos** (`tools/brand-logo/`) — the 192, 512 and
   maskable-512 PNGs are the **byte-exact copies recovered from git history**
   (commit `2b22fb4`, the PWA "icon parity" copies from ezone-outpatient: dark
   `#071410` background, `#29d488` green logo). They are the generator's input,
   committed so the build is reproducible.

2. **Icons** (`public/icons/`) — regenerated from those sources:
   - **recoloured** by pixel blend-remap — every pixel is a blend of the dark
     background and the green logo, so the logo coverage `t ∈ [0,1]` is recovered
     from the green channel and repainted as `bg·(1−t) + #0055ff·t`. **Shape and
     anti-aliasing are preserved exactly**; only the hue changes.
   - **white `#ffffff` contour halo** — the logo's own coverage mask **dilated by
     ≈2% of the canvas** (≈10 px @512, ≈4 px @192) via an **exact Euclidean
     distance transform** (Felzenszwalb & Huttenlocher), painted beneath the
     blue logo. It follows the logo's **exact contour** (anti-aliased, not a
     box).
   - background `#071410`; **every pixel fully opaque** (sources flattened over
     the dark background), so the maskable safe zone never reveals a transparent
     / cropped border.
   - verified legible with the halo reading as a clean outline when scaled to
     48 / 64 / 96 px.

3. **`public/manifest.json`** — `short_name` remains `"Dashboard"`, full `name`
   remains `"E-Zone Dashboard"` (unchanged).

4. **`public/sw.js`** — `CACHE_VERSION` stays **`v4`** (`ezone-dashboard-v4`);
   the icon bytes changed within the same unshipped bump, so no further bump is
   needed to evict the live `v3` icons.

## How the icons were generated

`tools/gen-icons.js` — a **self-contained Node script** using only built-ins
(`fs`, `zlib`), no `canvas` / `sharp` / new dependency. It **decodes** each
source PNG (hand-rolled reader, filters 0-4), flattens over the dark background,
recovers the logo coverage `t` per pixel and **recolours** green → `#0055ff`,
computes an **exact EDT** of the logo mask to add the white halo where the
distance ≤ the ring width, composites `bg → white·halo → blue·logo` at alpha
`255`, and **encodes** with a hand-rolled PNG writer (CRC32 chunks + `deflate`
IDAT). Run: `node tools/gen-icons.js`.

## Tests (`test/pwa-foundation.test.js`)

- **cache version floor** — `CACHE_VERSION` must parse to `>= v4` (a revert to an
  older version fails loudly; future bumps still pass).
- **palette** — asserts each icon contains `#071410` background, `#0055ff` logo,
  and white `#ffffff` halo pixels, and that no earlier mark remains (original
  green `#29d488`, block-E blues `#5b8bff` / `#2962ff`).
- **opaque dark background** — the top-left corner is exactly `#071410` and fully
  opaque, and no pixel anywhere is even partially transparent.
- **logo-presence guard** (replaces the block-E boldness guard) — measures
  colored-ink coverage per icon and asserts it is **> 5%**, so a blank
  regeneration or a mis-keyed recolour that leaves the logo invisible fails
  loudly. It deliberately does not constrain glyph weight. Measured ~10%
  (192/512) and ~7% (maskable).

Full suite: **140 passing** (`npm test` → `node --test`).
