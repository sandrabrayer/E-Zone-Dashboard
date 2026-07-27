# Meetings tab shell + tab reorder + dashboard spacing

Three front-end-only changes (no `apps-script/Code.gs`, no backend, no data).

## 1. Tighter דשבורד בתים spacing (above the fold on 1366×768)

The nav bar and the KPI card row carried excessive vertical padding, pushing the
first stat-card row below the fold on a 1366×768 laptop. Reduced, RTL untouched
(only direction-neutral properties changed) — `public/style.css`:

| Rule | Before | After |
| ---- | ------ | ----- |
| `.topbar` height | `64px` | `54px` |
| `.tabs .tab` padding | `22px 22px` | `14px 20px` |
| `.screen` top padding | `28px` (all sides) | `16px` top (sides/bottom `28px`) |
| `.screen h2` margin-bottom | `22px` | `14px` |
| `.cards-row` gap | `18px` | `14px` |
| KPI card padding | `.card` `22px` | scoped `.cards-row .card` `16px` |

The card padding change is **scoped to `.cards-row .card`** so content cards
elsewhere (billing, break-even, houses) keep their original `22px`. Mobile
overrides (`.topbar` / `.tabs` in the ≤ breakpoint media query) are unchanged.

## 2. Tab reorder — שימור לידים moves to LAST

`שימור לידים` (retention) was the third tab; it is now the last tab. The nav
button order in `public/index.html`, the `SCREENS` router array in
`public/app.js`, and the DOM section order were all updated together so they
stay in lockstep.

## 3. New tab לוח פגישות (meetings) — empty shell only

Inserted directly after `לידים` (leads):

- `public/index.html` — a new `<button data-screen="meetings">לוח פגישות</button>`
  in the nav, and a `<section id="screen-meetings">` rendering the `לוח פגישות`
  heading plus an empty `#meetings-board` placeholder container.
- `public/app.js` — `meetings` registered in the `SCREENS` router array so the
  existing tab handler shows/hides it like any other screen.
- `public/style.css` — a minimal `.meetings-board` dashed-box placeholder style.

No render function, no data fetch, no logic, no `Code.gs` change. The screen is a
shell for future work.

## Final tab order

`דשבורד → לידים → לוח פגישות → תפוסה → מטופלים משוחררים → גבייה → נקודת איזון → גרף צמיחה → שימור לידים`

## Tests

`test/meetings-tab-shell.test.js` (7 new): locks the tab order (leads →
meetings → … → retention last) from the index.html nav, asserts `meetings` is
registered in the app.js router (`SCREENS`), that the router mirrors the nav
order, and that every router screen id has a matching `<section>` in the HTML.

`node --test` — full suite: **188 passing, 0 failing** (7 new).
