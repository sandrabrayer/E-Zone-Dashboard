# CHANGELOG — Discharged patients tab search

## What

Live search filter on the מטופלים משוחררים (discharged patients) tab: an RTL
search input (`חיפוש מטופל...`) in the screen header, filtering the audit-row
cards on every keystroke by patient name, phone, and house label.

## Behavior

- **Live filtering** — `input` event, no button; same immediate-on-input
  pattern as the leads / occupancy / retention tab searches.
- **Fields matched** — patient name and house label by lowercased substring;
  phone by raw as-displayed substring OR normalized-digit substring via the
  existing `normalizePhone` helper, so `050-111-2222`, `0501112222` and
  `+972-50-111-2222` all find the same row.
- **House label** — matches what the card displays: the resolved house name
  (`houseById(...).name`), falling back to the raw `houseId`. The `—`
  placeholder for a missing house intentionally never matches.
- **Count pill** — `discharged-patients-count` now shows the FILTERED count,
  matching what the list displays.
- **Empty states** — zero matches while searching → `לא נמצאו תוצאות`;
  genuinely no discharged rows → the existing `אין מטופלים משוחררים`.
- **Empty query** — shows all (unfiltered) rows, exactly as before.

## Implementation

- `public/index.html` — added the standard `.actions` + `input[type=search]`
  block (the exact markup pattern of the leads/retention searches) to the
  discharged screen-head. Placeholder: `חיפוש מטופל...`. No new CSS — the
  existing `.actions input[type=search]` rules (incl. mobile full-width) apply.
- `public/app.js`
  - `state.dischargedSearch` + input wiring (trim + lowercase, re-render on
    input), mirroring the retention-search wiring.
  - `dischargedHouseLabel(p)` — pure house-label resolver ('' fallback).
  - `dischargedPatientMatchesQuery(p, q, houseLabel)` — pure matcher
    mirroring `leadMatchesQuery`'s text/phone semantics.
  - `renderDischargedPatients()` — applies the filter after the existing
    restored-row filter; count pill + empty-state logic updated as above.
  - `normalizeDischargedPatient()` — now passes through a `phone` column
    (same aliases as `normalizeLead`) instead of dropping it, so audit rows
    that carry a phone are phone-searchable. Rows without a phone column are
    unaffected (`phone: ''`).
- **Zero `Code.gs` changes** — frontend only.

## Tests

- `test/discharged-search.test.js` — new, same vm-sandbox approach as
  `retention-search.test.js`. Covers: empty query (all rows), name match
  (case-insensitive substring), phone match across formatting via
  `normalizePhone` (raw partial, dashed↔plain, international `+972`, partial
  digit run), house match via resolved label + raw-id fallback + `—`
  never-matches, no-match, and nullish-row safety.
- Full suite: 507/507 pass.
