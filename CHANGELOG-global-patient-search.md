# Global search — «🔍 חיפוש»

October 15, 2026. **Railway only** (`public/`). Code.gs not touched, so no
Apps Script deploy. No column, sheet, Script Property or env var. SW
`CACHE_VERSION` v62 → **v63** (live `/sw.js` read v62 on 15/10/2026, no open PR
touches `public/`; v17 stays burned).

## Why

Finding one person meant knowing which tab holds them (patients, leads, closed
leads, discharged) and typing the name into that tab's own box. Vered now has
one search over all of them.

## What changed

- **A floating «🔍 חיפוש» button** (bottom corner, every screen) and the **`/`
  key** open a panel under the top bar. It is NOT a top-bar item: the top bar
  has no spare width at laptop sizes (measured: a button there pushed «יציאה»
  off-screen at 1440 px).
- **Searches, by name or phone:** patients (every status), leads on the board,
  closed leads (שימור לידים) and discharged rows.
  - *Name:* every typed word must be inside the name, in any order;
    invisible characters, extra spaces and case are ignored (the same
    `normalizeNameForMatch` the patients tab uses).
  - *Phone:* digits and phone punctuation only, from 3 digits. `050-200 1003`,
    `0502001003`, `502001003` and `+972 50 200 1003` are one number
    (`searchPhoneDigits`). A lead is also found by its referrer or billing
    phone; the phone that matched is the one shown.
  - A patient row has no phone of its own, so a phone search reaches a patient
    through its linked lead (`patientLeadInfo`).
- **Each result** shows name, a tag (מטופל · פעיל / שוחרר / בהמתנה / תקופת ניסיון,
  ליד · <stage>, ליד סגור (שימור לידים), משוחרר), the house and the phone. At
  most 12 rows; «מוצגות N מתוך M» says when there are more.
  Order: active patients, leads, released patients, discharged rows, closed leads.
- **No double entries.** The lead a listed patient was admitted from is not
  repeated (the patient is that record now); a discharged row already shown as
  the released patient (same house + name) is not repeated. A lead whose
  patient does not match the query stays listed.
- **A pick opens the record where it already lives**, with that tab's OWN
  filter pre-filled with the name (patients: house filter cleared and status
  «הכל», so a released patient shows too), then scrolls to the card and outlines
  it for 3 seconds. No new card rendering — the record looks and behaves exactly
  as in its tab.
- Keyboard: `/` opens, ↑ ↓ move, Enter opens, Esc closes. Results refresh 120 ms
  after typing; Enter inside that window refreshes first.

## Security and scope

- **Read-only, client-side.** The search section makes no request and writes no
  storage (a test scans the code for `fetch`, storage and `saveAll`).
- **Text only.** Names, phones and houses are sheet data; every result is built
  with `textContent`. The section has no `innerHTML` / `insertAdjacentHTML` /
  `eval` (guard test), and a browser test seeds `<img onerror=…>` as a lead name
  and proves it renders as text and never runs.
- **The controller view (Ortal)** has the button and panel REMOVED from the DOM
  (`applyControllerView`), and `openGlobalSearchResult` refuses a tab the session
  may not open (`resolveScreen`) — nothing navigates, nothing changes. A
  restricted session (Shiran, Yael) may open all four tabs, as before; no
  billing data is searched or shown.

## Tests

- `test/global-patient-search.test.js` (vm sandbox, runs in CI): phone formats,
  query parsing, name tokens, phone through the linked lead, ranking, limit and
  total, closed/restored/soft-deleted/removed rows, both dedupe rules, opening
  each kind, the controller refusal, text-only rendering, the hints, markup
  (button outside the header, panel after it, not in `<nav class="tabs">`),
  z-index and print rules, no `offsetParent`, no innerHTML/network, SW v63.
- `test/global-patient-search-browser.test.js` (Chromium, skipped when absent;
  desktop and 360 px): panel under the top bar, a released patient opens with
  the widened status filter and only that row, every other kind opens its own
  tab, the hostile name, `/`, ↑ ↓ Enter, Esc, no write sent, no page error. It
  caught a real bug before merge: Enter re-ran the search and reset the arrow
  highlight, so the wrong person opened.
- `test/dashboard-perf-assets.test.js`: the SW pin moves v62 → v63 (repo
  convention, one line per PR).
