# Quarter-hour time steps + meetings-board visual pass

Two UI changes to the meetings flow.

## 1. Quarter-hour visitTime steps

Both `visitTime` inputs now carry `step="900"` so the native time picker offers
only `:00 / :15 / :30 / :45`:

- **Lead-card inline input** (`buildLeadCard`, visit stage) —
  `<input type="time" step="900" …>`.
- **Edit-lead modal** — the `visitTime` field gains `step: 900`, threaded
  through `showModal`'s generic input renderer (new optional `f.step`
  passthrough; other fields are unaffected).

The add-lead modal has no time field, so nothing else changed. `step` only
constrains the picker UI — it does **not** validate or reject a stored value, and
`isoTime` still returns any `HH:MM` string unchanged (its `^(\d\d):(\d\d)` branch),
so existing rows on a non-quarter minute (e.g. `08:18`) keep displaying and are
never blanked. The Sheets epoch artifact (`1899-12-30T…Z`) still normalizes to
`HH:MM` as before.

## 2. Meetings-board visual pass — `public/style.css`

All colors come from existing CSS custom properties; no new hex values, no
bespoke font (the board inherits the app's Heebo stack).

- **Typography match.** `.mtg-day-head` is an `<h3>`, so `.screen h3` was
  bleeding in `text-transform: uppercase` + `letter-spacing: 1.5px` + muted
  color — washing the Hebrew header out. Now explicitly overridden to
  `text-transform: none`, normal tracking, `color: var(--text)`, matching the
  lead-card size scale.
- **Time anchors the row.** `.mtg-time` is bold (`700`), brighter
  (`var(--text)`), 14px, tabular-nums.
- **Day-header accent.** A 4px `var(--primary)` bar on the leading (RTL: right)
  edge via `border-inline-start`.
- **Row hover + day separation.** `.mtg-row:hover { background: var(--surface-3) }`;
  larger `.mtg-list` gap and a `var(--shadow-sm)` per day card.
- **Today stands out.** `renderMeetings` adds an `mtg-today` class (and a "היום"
  badge) to the day whose date equals `todayISO()`. Styled with a
  `var(--primary)` border + glow ring and a brighter header band; the badge uses
  `var(--primary)` on `var(--primary-glow)`.
- **Phone width.** A `max-width: 560px` media query reflows each row to
  time-column + stacked name/house/manager + inline WhatsApp, keeping it readable
  and RTL-correct.

## Tests — `test/meetings-polish.test.js`
- `step="900"` is present on the rendered lead-card inline input and the edit-modal
  `visitTime` input.
- `isoTime` round-trips non-quarter values (`08:18`, `13:07`, `23:59`) unchanged,
  and still normalizes the epoch artifact.
- The `mtg-today` class **and** the "היום" badge land on today's section only;
  the other in-week day section stays plain `mtg-day`.

## Not included
- No backend / Apps Script change.
- No change to the meetings bucketing or the WhatsApp link behavior.
