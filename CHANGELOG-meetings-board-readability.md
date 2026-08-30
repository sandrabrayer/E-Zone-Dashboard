# Meetings board readability pass

CSS-only fix from Sandra's screenshot review of the לוח פגישות tab on real
production data: the board's core identifiers were too faint against the dark
background.

## Changes (`public/style.css` only)

- **Meeting row** — lead name (`.mtg-name`) is now the row anchor alongside
  the time: 14px / weight 700 / primary text color. House (`.mtg-house`) and
  manager (`.mtg-with`) move from `--text-muted` to the primary text color at
  weight 500, keeping the hierarchy: time + name strongest, house/manager
  next, controls last.
- **דיווח מנהל block body** — `.mrv-detail` (הגיע/ה עם, פירוט lines) moves
  from `--text-muted` to the primary text color; `.mrv-label` field labels
  move from near-invisible `--text-dim` to `--text-muted`; new `.mrv-byline`
  rule keeps the reporter/timestamp metadata line muted at 13px. Line-height
  stays 1.7 for multi-line Hebrew paragraphs. Applies identically on the
  board and on the lead-card rendering (shared markup).
- Everything else untouched: outcome badge colors, card accents, unseen
  amber treatment, edit/delete buttons, RTL, mobile layout.

No `app.js`, `Code.gs`, or `server.js` changes; no behavior change.
