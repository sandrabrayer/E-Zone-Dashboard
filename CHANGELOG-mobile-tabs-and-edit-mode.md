# Mobile tabs fix + edit-mode label removal

Two frontend fixes, one PR. **No `Code.gs` change, no Apps Script deploy.**

## Fix 1 — All top-nav tabs reachable on mobile

**Bug:** on phones/PWA only 2 of the 8 top tabs were visible, with no way to
tell the rest existed.

**Root cause (confirmed in Chromium at 360/390/480px, RTL):** the PWA-fixes pass
had turned `.tabs` into an internally-scrollable strip *inside* the single
topbar row. Wedged between the brand and the `user-mode` block, that strip was
only **187px wide at 390px**, so just 2 tabs showed. The scrollbar was hidden
and there was no fade, so the other 6 tabs were undiscoverable (they were
technically reachable by swipe, but nothing signalled that).

**Fix:** on `≤900px` the topbar now **wraps** — brand + logout stay on row 1 and
the tab bar drops to its own **full-width row** and **wraps** (`flex: 1 0 100%;
flex-wrap: wrap`), so every tab is visible with no horizontal scroll and no
RTL scroll-position quirk. The page still never scrolls sideways (wrapping stays
within width; the `html/body { overflow-x: hidden }` guard remains).

Desktop (>900px) is unchanged — all edits live inside the mobile media query.

**Verified:** 8/8 tabs fully visible at 360, 390, and 480px; page overflow 0px.

## Fix 2 — Remove the "מצב עריכה" / "מצב צפייה" label (Option A)

Removed the topbar mode **indicator** only:
- deleted `<span id="mode-label">` from `index.html`;
- deleted the two lines in `enterApp()` that set its text.

**The edit/viewer access control it labelled is deliberately kept intact** — the
PIN gate, the `viewer-mode` body class, the `edit-only` hiding, and all ~18
`state.mode` gates on mutations remain. This was the low-risk reading confirmed
before implementing; the alternative (removing access control entirely so
viewers could edit) was explicitly **not** taken. Smoke-tested: entering viewer
mode still works with no JS error (previously `enterApp` referenced the removed
span).

## Tests

`test/mobile-tabs-and-edit-mode.test.js` (source guards, same style as the PWA
tests):
- Fix 1: a `≤900px` media query exists; `.tabs` uses `flex-wrap: wrap` +
  `flex: 1 0 100%`; `.tabs` is **not** `overflow-x: auto` (the regression that
  hid tabs); all 8 tab buttons present.
- Fix 2: `mode-label` and both label strings are gone; access control preserved
  (viewer-mode toggle, pin-viewer path, `edit-only` hiding, and ≥15 `state.mode`
  gates all still present).

Full suite: **120 passing** (`npm test` → `node --test`).
