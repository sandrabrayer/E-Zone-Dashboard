# Header: drop the "E-ZONE" wordmark — show the app emblem + Hebrew name

The topbar brand showed only the Latin wordmark **"E-ZONE"** and no emblem.
It now shows the app's existing emblem (the PWA icon) next to the Hebrew app
name **"דשבורד בתים"**, matching the rest of the ecosystem (e.g. Logistics
shows its emblem + "לוגיסטיקה"). Colors and the icon are unchanged — no
recolor, no new icon set.

Frontend / static assets only. **No `Code.gs` change, no Apps Script deploy.**

## What ships

1. **`public/index.html`** — the header `.brand` container replaces the plain
   `E-ZONE` text with:
   - `<img class="brand-logo" src="/icons/icon-192.png" alt="">` — the app's
     existing PWA icon (the recoloured E-Zone brand logo), reused as-is. The
     `alt` is empty (decorative) because the app name sits right next to it, so
     screen readers don't announce it twice.
   - `<span class="brand-name">דשבורד בתים</span>` — the Hebrew app name.

2. **`public/style.css`**
   - `.brand` is now a `display:flex` row (`align-items:center; gap:10px`) that
     is `flex:0 0 auto` and `white-space:nowrap`, so the emblem and name stay on
     one line and never crowd or push into the nav.
   - `.brand-logo` — the emblem is **30px** square on desktop and **28px** on
     phones (override inside the existing `@media (max-width:900px)` block),
     `flex:0 0 auto` so it never squashes.
   - `.brand-name` carries the **exact** type/color the old `.brand` text had —
     the same `#5b8bff → #a779ff` gradient text fill, `font-weight:800`,
     `font-size:22px` — so the wordmark's look is unchanged, only the glyphs
     changed from Latin to Hebrew.
   - RTL is inherited from `<html dir="rtl">`; the flex row places the emblem at
     the RTL start (right) with the name beside it — verified in-browser.

The PIN-gate heading and the document `<title>` are intentionally left alone —
this is a topbar-only change.

## Screenshots

Before/after captured with Playwright at desktop (1280px) and mobile (390px),
committed under `docs/header-brand/` and shown in the PR description.

## Tests

New `test/header-brand.test.js` (source-read guards, same style as the PWA /
mobile-tabs tests — no browser needed):

- the `.brand` container no longer contains the `E-ZONE` wordmark;
- the header renders the emblem `img` pointing at `/icons/icon-192.png` with an
  empty (decorative) `alt`;
- the header renders the Hebrew name `דשבורד בתים`;
- `.brand` is a no-wrap, non-growing flex row (won't crowd the nav);
- the emblem is 30px on desktop and 28px inside the mobile media query;
- the brand-name gradient/color is unchanged (no recolor).

Full suite: `npm test` → all header tests pass; the only pre-existing red is
`test/getpayments-502-fix.test.js`, unrelated to and untouched by this change.
