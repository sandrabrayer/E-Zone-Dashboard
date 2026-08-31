# Meetings visual pass: fuchsia accent, bigger badge, stronger headers, banded conversion %

Sandra's screenshot feedback: purple was still too weak on the dark-blue
surfaces. CSS in `public/style.css` plus one presentation-only hook in
`public/app.js` (a `rate-*` band class on the conversion pill).

1. **Fuchsia accent.** New `--fuchsia` (#e040fb) + `--fuchsia-tint`/`--fuchsia-glow`
   variables. The דיווח מנהל block's accent bar, border tint and background
   move from `--purple` to fuchsia. The amber unseen treatment is unchanged
   (still the contrasting state). `--purple` itself stays (used by the stat
   bar gradient).
2. **Outcome badge bigger.** `.mrv-outcome-badge`: 14px → 16px, padding
   4px 12px → 6px 14px, weight 800. Still wraps cleanly on mobile
   (`flex-wrap` on `.mrv-head` + `overflow-wrap: anywhere` unchanged).
3. **Headers bigger and white.** `.mrv-title` (דיווח מנהל): 14px → 16px, and
   from purple text to white (`--text`) — the fuchsia identity lives in the
   accent bar/border/tint, not in the type; unseen still turns it amber.
   Row identifiers: `.mtg-time` and `.mtg-name` → 15px (strongest),
   `.mtg-house`/`.mtg-with` → 14px / weight 600 (next), all white. Mobile
   (≤560px) house/manager 12px → 13px; layout unchanged, no overflow.
4. **Conversion percentages prominent.** `.mtg-sum-rate`: 15px / weight 800 /
   more padding, color-coded by band — ≥80% green (`--success`), 50–79% amber
   (`--warning`), <50% red (`--danger`) — via a `rate-high/mid/low` class
   added in `meetingsSummaryHTML` (pure presentation, rate math untouched).
   `.mtg-sum-mgr` (manager name) → 14px / weight 800 / white.

Applies on the meetings board and the lead card alike (shared block markup).
No behavior change, RTL intact, badge colors and edit/delete untouched.
