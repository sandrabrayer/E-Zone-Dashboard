# Date / month picker icon — the calendar glyph was drawn black on a black field

Reported against **הכנסות חודשיות**: the month picker's calendar icon is nearly
invisible. The same defect was present on every other native picker in the app —
the **גבייה** date field, the **לידים** date fields, and the תקופת כיסוי start/end
pair added in PR #135 — so all of them are fixed together.

CSS only. No JS, no markup, no new class. `public/style.css` and the service
worker's cache version are the entire diff.

---

## 1. Root cause

Nothing in this repo drew that icon. **Chromium** did.

A native `<input type="date">` / `<input type="month">` renders its own calendar
glyph, and it picks the glyph's colour from the element's `color-scheme`. Nothing
in `style.css` ever declared one, so the computed value was `normal` — which for
form controls means **light**. Chromium duly painted a glyph for a light theme:

```
glyph ink  #000000          ← measured, Chromium, deviceScaleFactor 3
field       #182142         ← --surface, what the shared `input` rule gives it
peak channel distance  66/255
```

Black ink on a near-black field. The icon was fully present and fully
rasterized — it simply had nothing to contrast against. That is why the report
reads "nearly invisible" rather than "missing": there were pixels there, 728 of
them, all of them the wrong colour.

The app's dark theme is declared entirely in CSS custom properties. The browser
never saw it, because `color-scheme` is the only channel through which a page
tells an engine what a *UA-rendered* control is sitting on, and the app had never
used it.

## 2. The fix

Two declarations, scoped to the two picker types. They are not redundant — they
cover different surfaces.

### `color-scheme: dark`

```css
input[type="date"],
input[type="month"] { color-scheme: dark; }
```

This is the only handle that exists on the **dropdown calendar panel**, which is
drawn by the UA and cannot be styled at all — no selector reaches inside it. It
is also what fixes **Firefox**, which has no stylable picker-indicator
pseudo-element, and it is the fallback anywhere the WebKit rule below is
unsupported. On its own it already makes the glyph legible (Chromium switches to
a light glyph), so it is the safety net under the accent repaint.

It is deliberately **not** declared on `:root`/`body`. A page-level
`color-scheme: dark` would also repaint scrollbars and every other UA widget —
far wider than this one-icon bug asked for. `test/date-picker-icon.test.js` holds
that line.

### The accent repaint

```css
input[type="date"]::-webkit-calendar-picker-indicator,
input[type="month"]::-webkit-calendar-picker-indicator {
  background-image: none;              /* drop the UA glyph outright */
  background-color: var(--primary);    /* …and paint ours in the screen accent */
  mask-image: url("data:image/svg+xml,…");
  /* + -webkit- twins, mask-repeat / -position / -size */
}
```

The brief asked for the accent colours already on those screens, so the icon is
`--primary` `#5b8bff` at rest and lifts to `--text` `#f1f5ff` on hover/focus —
the same "accent → --text" lift `.bill-cov-edit-btn:hover` already uses two rows
below it on גבייה.

**Masked, not filtered.** The obvious alternative is to leave the UA glyph in
place and recolour it with a `filter: invert(…) sepia(…) hue-rotate(…)` chain.
That was rejected: a filter matrix freezes today's hex into the stylesheet in a
form nobody can read or re-derive, and it silently stops matching the moment
`--primary` is retuned. With a mask, the glyph's paint is a real
`background-color`, so it is **literally `var(--primary)`** and keeps following
the token. (The data URI itself cannot carry the var — CSS does not substitute
custom properties inside a `url()` token — so the SVG is a plain silhouette and
the colour comes from the element. A test asserts no `var(` leaks into the URI.)

### Geometry: the repaint costs the layout nothing

The indicator box is `18px`, carrying a `16px` glyph. 18 is the width Chromium's
own indicator already occupies, so replacing it moves nothing:

| control | before | after |
| --- | --- | --- |
| גבייה date field | 156px | **156px** |
| הכנסות חודשיות month field | 176px | **176px** |

Sizing the box to the glyph instead (16px) narrowed both by 2px for no gain, so
it does not.

### What is deliberately absent

No `:disabled` variant. Chromium hides the picker indicator entirely on a
disabled date/month field (verified in-browser), and the app never disables one
anyway — the billing row freeze disables a `<select>` and a number input. A rule
for it would be dead code that reads like coverage.

## 3. Coverage

Every native picker in the app, found by searching for the types rather than by
working from the three fields named in the report. The rules are type-selectors,
so all twelve are covered by construction:

| screen | field | type | source |
| --- | --- | --- | --- |
| הכנסות חודשיות | `#revenue-month` *(reported)* | `month` | `index.html:257` |
| גבייה | `#billing-date` | `date` | `index.html:190` |
| גבייה | תקופת כיסוי start / end (PR #135) | `date` ×2 | `app.js:6945-6946` |
| לידים | lead `visitDate` (card, edit mode) | `date` | `app.js:3288` |
| לידים | lead `created` (card, edit mode) | `date` | `app.js:3311` |
| לידים | עריכת פגישה modal — תאריך | `date` | `app.js:2792` |
| לידים | disposition modal's optional date row | `date` | `app.js:4505` |
| זיכויים | `allocationMonth` (new "אחר" credit) | `month` | `app.js:5856` |
| זיכויים | `decidedDate` / `paidDate` | `date` ×2 | `app.js:5882, 5892` |
| זיכויים | תאריך תשלום (סימון כשולם) | `date` | `app.js:6083` |

`public/meeting-report.html` has no date or month input, so
`meeting-report.css` is untouched.

## 4. Measured result

Real Chromium, the same control, same page, same scale:

| | before | after |
| --- | --- | --- |
| glyph ink | `rgb(0, 0, 0)` | `rgb(91, 139, 255)` |
| peak distance from the field | **66**/255 | **189**/255 |
| hover ink | — | `rgb(241, 245, 255)` (217/255) |
| pixels the glyph paints | 728 | 728 |
| control width | 156 / 176px | 156 / 176px |

Same glyph, same pixel count, same layout — a repaint and nothing else.

## 5. Tests

**`test/date-picker-icon.test.js`** — 18 tests, runs in CI. Resolves the
stylesheet with `tools/css-cascade.js` rather than grepping it, so a later rule
that out-specifies this block, or a token edit that walks `--primary` back toward
the field colour, fails here instead of shipping. Covers: the contrast floor
(≥120 channel distance) for both types; `color-scheme: dark` present per-type and
absent on `html`/`body`; the UA glyph replaced rather than tinted; no `filter`
recolour and no `var(` inside the data URI; the mask fully described
(size/repeat/position, `-webkit-` twins in agreement); the 18px/16px geometry;
hover and focus both lifting *brighter* and staying above the floor; the selector
scoped so `<input list>` datalist arrows are never repainted as calendars; and a
sweep of `app.js` + `index.html` that fails if a future field arrives as `time`,
`datetime-local` or `week` — a type these rules do not name, which would ship
with exactly this bug.

Run against the pre-fix stylesheet, **14 of the 18 fail**. The four that pass are
the scope/coverage/service-worker guards, which are independent by design.

**`test/date-picker-icon-browser.test.js`** — 3 tests, the real-Chromium
cross-check, in the shape `test/spinner-glyph-browser.test.js` established.
Skipped unless both `playwright` resolves and a Chromium binary is present, so it
is inert under `npm ci` and runs wherever a browser is available. It loads the
real stylesheet, and the stylesheet with this block **stripped back out**, then
diffs screenshots: it asserts the bug still reproduces on the pre-fix sheet
(peak < 110), that the fix clears the floor at exactly `#5b8bff`, that the
control's width is unchanged between the two, and — by forcing the icon's paint
to the field colour and diffing — that the glyph paints real pixels rather than
merely computing a colour.

Two things that file learned the hard way, both recorded in comments so the next
person does not re-debug them: Chromium's *first* rasterization of a given string
differs slightly from every later paint (each control is warmed with a throwaway
shot, or the glyph diff reads 2486 pixels of text noise instead of 728), and a
navigation does not move the mouse (the pointer is parked before the resting
shot, or the second iteration's "rest" is really a hover and the diff is zero).

Full suite: **1288 passing**, 0 failing.

## 6. Service worker

`CACHE_VERSION` `v13` → `v14`. `style.css` is the offline fallback for any device
that installed v13; without the bump those phones keep serving the copy where the
גבייה and הכנסות חודשיות pickers still have an invisible icon.

## 7. Files

| file | change |
| --- | --- |
| `public/style.css` | +76, a pure addition — the picker block, after the shared `input:focus` rule |
| `public/sw.js` | `CACHE_VERSION` v13 → v14, with the usual note |
| `test/date-picker-icon.test.js` | new — cascade-resolved guard, runs in CI |
| `test/date-picker-icon-browser.test.js` | new — Chromium cross-check, skipped in CI |
| `CHANGELOG-date-picker-icon-contrast.md` | this file |
