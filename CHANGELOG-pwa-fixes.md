# PWA follow-up fixes — icon parity + RTL horizontal offset

Three small fixes on top of the PWA foundation. Frontend + static assets only.
**No `Code.gs` change, no Apps Script deploy.**

## Fix 1 — Icon parity with the ecosystem brand

The foundation shipped placeholder green letter-E icons. Replaced them with the
**byte-identical** ecosystem brand icons already in production on
`ezone-outpatient` (branch `claude/youthful-volta-laarnk`), where they live
flat in `public/` as `icon-v1-192.png` / `icon-v1-512.png` /
`icon-v1-maskable.png`.

- Mapped 1:1 by dimension into this repo's existing paths (filenames kept, so
  the manifest / `index.html` / `server.js` routes / `sw.js` precache list are
  unchanged):
  - `icon-v1-192.png` (192×192) → `public/icons/icon-192.png`
  - `icon-v1-512.png` (512×512) → `public/icons/icon-512.png`
  - `icon-v1-maskable.png` (512×512) → `public/icons/icon-maskable-512.png`
- **Byte-identity verified** via `sha256sum` (all three pairs match). Icons were
  copied, not regenerated.

## Fix 2 — RTL horizontal offset on open

**Investigation (Chromium at 480px / 360px):** the page scrolled sideways on
open — `documentElement.scrollWidth` was **870px** at both widths. The root
cause is the top navigation: `<nav class="tabs">` holds 8 Hebrew tabs in a
no-wrap flex row measuring **~707px**, which (with the brand + logout) forced
the whole layout to 870px. In RTL that overflow lands on the **left**, shifting
the page. Secondary offender: `.pin-box` is a fixed `340px` (428px with
padding), overflowing sub-428px phones.

**Fixes:**
- `html, body { overflow-x: hidden; }` — a global guard so no over-wide child
  can ever shift the page sideways (belt-and-suspenders).
- **Root cause fixed, not just clipped:** at `≤900px` the tab bar becomes a
  horizontally **scrollable strip** inside the topbar (`flex: 1 1 auto;
  min-width: 0; overflow-x: auto`, tabs `flex: 0 0 auto; white-space: nowrap`,
  scrollbar hidden). Tabs stay full-size and swipeable — nothing is clipped
  off-screen. The wordmark gets `white-space: nowrap` so it never wraps.
- `.pin-box` gains `max-width: calc(100vw - 24px)`.

**Verified after fix:** `scrollWidth` == viewport (overflow **0px**) at 480px
and 360px; the sticky topbar still sticks (`overflow-x: hidden` did not break
`position: sticky`); the tab bar scrolls internally.

## Fix 3 — Cache bust

Bumped the service-worker cache version **`v1` → `v2`**
(`ezone-dashboard-v1` → `ezone-dashboard-v2`). On activate the SW deletes every
cache whose name isn't the current one, so the previously cached placeholder
icons and any stale `style.css` are purged on the next load.

## Tests

`test/pwa-foundation.test.js`: added a test asserting the cache version was
bumped (`CACHE_VERSION === 'v2'`, `CACHE_NAME === 'ezone-dashboard-v2'`) so an
accidental revert to v1 fails loudly. Icon filenames/manifest paths were
unchanged, so the existing icon/manifest tests still apply unmodified.

Full suite: **110 passing** (`npm test` → `node --test`).
