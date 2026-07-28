# Service-worker cache strategy + WhatsApp standalone-PWA fallback

Two fixes for why the meetings-board WhatsApp buttons render correctly but do
nothing when clicked in the installed app — and why a fix wouldn't have reached
users anyway.

## 1. `public/sw.js` — app.js/style.css: cache-first → network-first

Previously `/app.js` and `/style.css` were **cache-first** and matched with
`ignoreSearch: true`, which **ignores the `?v=__BUILD__` cache-bust**. Once a
client cached a bundle, the service worker kept serving that exact bundle across
every deploy until `CACHE_VERSION` was bumped — pinning users to stale code.

- Introduced **`cacheStrategy(url)`** as the single routing source of truth,
  returning `'network-only' | 'network-first' | 'cache-first' | 'network'`:
  - **network-only** — anything containing `sheets` or under `/api/` (unchanged:
    clinical data is never cached).
  - **network-first** — the shell (`/`, `/index.html`) **and now `/app.js` +
    `/style.css`**. Always try the network; the cache is an **offline-only**
    fallback (matched with `ignoreSearch` only when the network is gone).
  - **cache-first** — versioned-by-filename assets: `/manifest.json` and
    `/icons/*` (evicted wholesale by `CACHE_VERSION`).
  - **network** — everything else, passthrough.
- `shouldCache(url)` is kept as the derived `cacheStrategy(url) === 'cache-first'`
  boolean (still exported).
- The fetch handler now routes via `cacheStrategy` with small `networkFirst` /
  `cacheFirst` helpers; the shell keeps its `'/'` cache key.
- **`CACHE_VERSION` v4 → v5** so any bundle pinned in a v4 cache is evicted on
  activate.

## 2. `public/app.js` — WhatsApp click works in a standalone PWA

In an installed `display: standalone` PWA, a plain `<a target="_blank">` to an
external origin is silently dropped — the tap does nothing, no new tab. The
enabled button is a valid anchor, so nothing local was "broken"; the standalone
shell just won't open the `_blank` navigation.

- New **`openWhatsAppLink(url, opener, setHref)`** — tries
  `window.open(url, '_blank', 'noopener')` and, when it returns `null` (blocked
  or standalone), falls back to `location.href = url`. `opener`/`setHref` are
  injectable so the rule is unit-tested without a real window.
- `renderMeetings` now attaches a click handler to each `a.mtg-wa` that
  `preventDefault()`s and routes through `openWhatsAppLink`. The `<a href>` stays
  in the markup, so hover-preview and right-click-copy still work — the handler
  only supplements the click; it does not replace the anchor with a button.

## Tests
- **`test/sw-cache-strategy.test.js`** — `cacheStrategy` routing (app.js/style.css
  + shell → network-first, API/Sheets → network-only, icons/manifest →
  cache-first, unknown → network); `shouldCache` derived boolean; `CACHE_VERSION`
  differs from the previous `v4` and moved forward; the click fallback sets
  `location.href` when `window.open` returns null and does **not** when it returns
  a window (and passes `_blank`/`noopener`).
- **`test/pwa-foundation.test.js`** — updated the cache-first assertion: icons +
  manifest stay `true`; `app.js`/`style.css` are now `false` (network-first).

## Not included
- No backend / Apps Script change.
- The `?v=__BUILD__` markup and network-only data policy are unchanged.
