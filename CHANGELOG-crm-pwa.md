# C16 — the CRM as a PWA (phone / installed app) — 2026-10-28

CRM restructure. Sandra 2026-10-28 ("תתקדם" after the phone-pass proposal). Touches the SHARED
service worker, so the classic page is affected too (a cache bump only). No Code.gs, no server
change, no env var.

- `public/sw.js`: `CACHE_VERSION` **v93 → v94** (monotonic from the live v93 = deploy branch; v17
  never reused). `/crm/crm.js` and `/crm/crm.css` join `BUNDLE_PATHS`: cache-first at their content
  hash (what the shell links), network-first otherwise — the same rule as app.js. `/` stays
  network-first; data stays network-only; the shell HTML is not precached.
- `public/crm/crm.html`: links `/manifest.json` (unchanged — `start_url: "/"`, so an installed
  app opens the CRM after the switch and the classic page before it), theme colour, the iOS
  standalone tags, and the same guarded `/sw.js` registration as index.html (after load, non-fatal).
- Effect for Vered: on the phone, «הוסף למסך הבית» / «התקן» installs the Dashboard app as before;
  opening it lands on the CRM; the shell's assets load from the cache on repeat visits. Everyone's
  browser evicts the v93 cache on the next load (the usual bump).

Tests: `test/crm-pwa.test.js` (+2: strategy matrix, shell tags); the v93 pins moved to v94 / ≥93.
Files: `public/sw.js`, `public/crm/crm.html`, tests, DEPLOY.md, ESS, `docs/crm/ROLLOUT.md`.
Rollback: revert (a later bump must still be > v94).
