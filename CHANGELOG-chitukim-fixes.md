# «חתכי מטופלים» — dead buttons, the list behind a number, reconciled numbers, spinners

**What:** fixes the «חתכי מטופלים» panel built in #258–#260. One PR.

Base: `claude/build-ezone-dashboard-QOg5s` at `7474343` (after #260).
Code.gs is **unchanged**. No new route. SW `v80` → `v81` (live `/sw.js` read
v80 on 20/10/2026; v17 never reused).

## 1. Root cause of the dead buttons

Reproduced in real Chromium (the Playwright harness the other browser suites
use), clicking every control of the panel:

- With a freshly rendered panel every handler fired — nothing was unwired and
  no error was thrown.
- **After typing in «לתקופה מסוימת (ימים)» or «סף נוסף (ימים)», the next tap
  on ANY control did nothing** — every bucket card, «עדיין בטיפול» chip,
  continuity card, cross-table cell, completion count and every «ייצוא»
  button (mouse and touch).
- Why: `renderPatientRetention` wired each input with
  `onchange = () => { …; renderPatientRetention(); }` and the whole panel is
  `innerHTML`. A number input fires `change` on **blur**, and the blur happens
  on the *mousedown* of the control being tapped (measured: `pointerdown →
  mousedown → change (activeElement = BODY) → mouseup → click`). The panel was
  replaced between mousedown and mouseup, the press and the release landed on
  different nodes, and the browser fired **no click at all**.
- Second, smaller cause of "nothing happens": a click that did fire only
  redrew the list at the very bottom of the panel (below the completion
  section), off screen, and the «עדיין בטיפול» chips / «נתונים חסרים» had no
  pressed state — no visible change.

**Fix (`public/app.js`):**
- ONE delegated listener per panel element, bound once
  (`bindPatientRetentionPanel`) — it survives every re-render; no per-render
  `onclick` / `onchange`.
- Inputs only **store** their value (`input` event). A `change` that comes
  from a blur never re-renders under a press: the pressed control's own action
  renders with the stored value; if nothing was pressed, the value is applied
  through «החל» once no pointer is down (`PR_FLUSH_MS`, re-checked). A
  committed change (date picker / Enter — focus still on the input) applies at
  once. New «החל» buttons next to both thresholds; Enter applies too.
- Focus is kept on the same control across a re-render (stable control key).

## 2. Click-a-count opens the list behind it

- No list until a number is clicked. The list opens **right under the section
  of the number** (length / continuity / cross table / completion), gets focus
  and is scrolled into view; the clicked number is `aria-pressed="true"`.
- Columns: שם, בית, טלפון, תאריך כניסה, תאריך שחרור, ימים, המשך טיפול (+ חסר
  for «נתונים חסרים»). A «סגירה ✕» button, and the list's own «ייצוא CSV» and
  «ייצוא לאקסל».
- A stale / hostile selection closes the list (it used to fall back to
  «שוחררו · עד 30 יום»).

## 3. The numbers reconcile

- Each bucket card (עד 30 / 31–60 / 61+) keeps its **discharged** count as the
  big number and adds a sub-line **«+N עדיין בטיפול»** — the still-in-treatment
  stays whose days so far fall in that bucket. Big number → the discharged
  list; sub-line → the active list. The «עדיין בטיפול» card and its chips stay.
- One pure table feeds the screen, the Excel and the CSV:
  `PatientRetention.bucketSummary(report)` →
  `{ rows: [{ key, label, discharged, still, total }], discharged, still, cohort }`.
  Σ discharged + Σ still = the cohort; Σ sub-lines = the «עדיין בטיפול» card.
- **Excel** (`lib/report-xlsx.js`): «סיכום» shows each bucket's sub-line right
  under it («עדיין בטיפול · <bucket>») plus a check row «שוחררו + עדיין בטיפול
  = נכנסו בתקופה»; «שהות – חתך» adds the card table (משך שהות / שוחררו /
  עדיין בטיפול / סה״כ) with a total row. Numbers are number cells.
- **CSV**: new «ייצוא CSV» on «משך שהות» — `summaryToCsv` (the same table, the
  total row and «נתונים חסרים»; same formula guard / BOM / CRLF).

## 4. Spinners, double clicks, errors

Every action — opening / closing a list, a period preset, «החל» (period and
both thresholds), every Excel and CSV export — runs through
`patientRetentionAction`:
- the existing `busyButton` spinner (`.is-busy` ring, `aria-busy="true"`,
  `disabled`) on the clicked control, with one paint before the work so it is
  actually seen;
- a double click is ignored (aria-busy guard + one action at a time per panel);
- a card is handed back with its markup (number / percent / label) when an
  action fails — `busyButton` alone restores a plain-text label;
- a failure shows a Hebrew error toast (`#retry-toast`, `role="alert"`, text
  only) with «נסו שוב» that re-runs the same control's action;
- an export first re-renders when an input holds a value the screen does not
  show yet, so the file always equals the screen.
- Every control in the panel and the toast buttons are ≥ 44px.

## Tests

- `test/chitukim-fixes-browser.test.js` (15, real Chromium): one regression per
  control family — bucket cards, sub-lines, «עדיין בטיפול» card + chips,
  continuity cards, all 12 cross cells, all completion counts + «נתונים
  חסרים», every «ייצוא» button — each typing a threshold first, then one
  click; **all fail on the code before this fix** (verified) and pass after.
  Plus: blur-apply, the list (columns, escaping, placement, focus, close, own
  export), screen reconciliation, spinners painted on every action, double
  click = one file, error toast + retry, 44px at 360px, touch tap.
- `test/chitukim-fixes.test.js` (16, vm + exceljs, runs in CI):
  `bucketSummary`, sub-line label, summary CSV, Excel «סיכום» and «שהות – חתך»
  reconcile, the screen model (sub-lines, list placement, phone, escaping),
  the change logic (no re-render under a press), action guard, retry toast,
  wiring. 15 of 16 fail on the old code.
- Updated: `completion-view.test.js` (stale selection now closes the list;
  SW ≥ v80), `dashboard-perf-assets.test.js` (v81).
- Full suite: 3239 pass, 0 fail.

## Security

No server change, no new input reaches the backend, Code.gs untouched. Every
rendered value goes through `escapeHtml` (selection JSON included); the toast
uses `textContent`; `data-sel` is parsed in a try/catch and checked with
`validSelection` before anything runs. CSV/Excel cells keep the formula guard.
`npm audit`: 0 high / 0 critical (1 moderate, pre-existing).
