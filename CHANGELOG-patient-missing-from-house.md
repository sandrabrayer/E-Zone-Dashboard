# CHANGELOG — active patient missing from every house tab (תפוסה)

**Branch:** `feat/patient-missing-from-house` · **Base:** `claude/build-ezone-dashboard-QOg5s`
(deployed branch, verified in `railway.json` / `EZONE-ECOSYSTEM-STATUS.md`; PR #278 merged as
`dad57b4`, live `/api/version` = `dad57b4`, live SW = `v92`).

## The report

A patient (house רעננה הפרדס, entry 22/09/2026, funder פרטי) is active in «מטופלים» but
Vered cannot find him in any house tab, so she cannot discharge him or press
«העבר לאמבולטורי». He is the only such case she knows of. The live sheet was not read; the
trace below uses fixtures (`test/patient-missing-from-house.test.js`).

## Trace — «מטופלים» vs a house's תפוסה tab

Both views read the same `state.patients`: getData groups the Patients rows by the raw
`houseId` cell (rows with a blank house are skipped), and `parsePatients` →
`normalizePatient` runs every row through `resolveHouseId`.

| Step | «מטופלים» (`patientListRows`) | תפוסה (`renderHouseTabs` / `visibleOccupancyRows`) | Can it drop him from the house view only? |
| --- | --- | --- | --- |
| **House** | Optional filter `unadmittedHouseId(p.houseId) !== f.house`; default «כל הבתים» = no house filter at all. The «בית» cell shows `HOUSES.find(id) ? name : p.houseId` — the raw value when unknown. | `p.houseId === houseId`, an EXACT compare, and only for the tabs in `HOUSES`. A value no rule resolves has no tab at all. | **YES — the root cause.** |
| `resolveHouseId` | trim → exact id → exact Hebrew label → case-insensitive id → else the raw string. | same | **YES** for anything else: another app's id (`hapardes` — the staffing id of pardes, already mapped in `MW_STAFFING_HOUSES`; `raanana`, `efroni`, `ofroni`), an invisible bidi / zero-width mark (WhatsApp paste), an NBSP or a doubled inner space. The «בית» cell then shows e.g. «רעננה הפרדס» with an invisible mark — it looks right, but it is not `pardes`. |
| pardes / hapardes alias | not handled | not handled | **YES** (above). |
| **Status** | `released` excluded; everything else is active (`normalizeStatus`: blank / unknown → `active`). | `released` excluded unless «הצג משוחררים». | No — the two use the same status. |
| **Dates / month** | none (days-in-house is display only). | none. | No — תפוסה has no date or month filter. A future or unreadable entry date does not hide a row. |
| **Closed house** | — | `sde` (closed) gets no tab while it holds 0 non-released patients — but the count uses the same exact compare. | No for pardes (open). |
| **Name** | search via `normalizeNameForMatch` (invisible marks, spaces). | search via `toLowerCase().includes` — no normalization. | Only while a search is typed (secondary; fixed too). |
| **Save path** (server) | — | `replaceHousePatients_` picked a house's rows with `cell === houseId`. | Not a display cause, but it blocks the obvious repair: once the client resolves the row to `pardes`, a save under `pardes` would not find the `hapardes` row (id held elsewhere → re-minted, or the lead-linked row refused as a duplicate promotion). |

### Most likely causes, in order

1. **The Patients `houseId` cell holds a value the client cannot resolve, most likely the
   staffing id `hapardes`, or `רעננה הפרדס` / `pardes` carrying an invisible mark or NBSP.**
   «מטופלים» still lists him (no house filter by default) and prints the raw value in the
   «בית» cell. תפוסה compares exactly, so no tab matches.
2. **No fallback tab.** A patient whose house matches no tab simply had no place in תפוסה,
   and «מטופלים» had no «שחרר», so nothing on screen could discharge him.
3. Ruled out: status, entry date / month filters, the closed-house rule, the name (outside
   a typed search).

## Fixes

### `public/app.js`
- `resolveHouseId` also resolves after reducing invisible marks / NBSP / whitespace runs /
  case (`houseMatchText`), and another app's id through `HOUSE_ID_ALIASES`
  (`hapardes → pardes`, `raanana → asher`, `efroni`/`ofroni → arfoni`). An id is unchanged.
- `unadmittedHouseId` (the «מטופלים» house filter) is now `resolveHouseId` — one rule.
- `visibleOccupancyRows` / `houseOccupancyCount` match through `occupancyHouseMatches`
  (no raw compare left). The תפוסה search uses the same normalized name match.
- New «בית לא מזוהה» תפוסה tab, shown only while an active patient's house resolves to no
  house. Never counted in any KPI. The intake form never defaults to it.
- «מטופלים» rows: a «בית לא מזוהה» chip next to an unresolved house; **«שחרר»** on every
  active row in edit mode → the same `dischargePatient` flow (modal, both writes,
  «משוחרר לטיפול חוץ» → Outpatient), under `busyButton`. No new write, no new action.

### `apps-script/Code.gs` (clasp CI on merge)
- `diagClientHouseId_` = the new `resolveHouseId` (parity test), alias table in
  `patientHouseIdAliases_()`. Own-key lookup only (`'toString'` is not a house).
- `saveAll_`: payload house keys go through the rule (`canonicalPatientHouseKeys_`).
- `replaceHousePatients_`: a house's rows = the rows whose house RESOLVES to it. A row
  stored as `hapardes` is matched by id in place, and the write heals its cell to `pardes`.
  A deliberate move's source house and `collectHouseMoves_`'s `movedFrom` resolve too.
- `deletePatientRow_`: id and key matching resolve the stored house.
- `canonicalDigestHouse_`: falls back to the rule (the coordinators digest).
- `patientKey_` is unchanged, so stored integrity / payment keys never churn.
- New editor report **`patientsMissingFromHousesReportNow()`**: every active Patients row
  no house tab showed, with its reason (`no_house`, `unknown_house` with a «looks like»
  hint, `house_variant` = shown since this fix and healed on the next save). It is
  read-only on the spreadsheet, writes one private Google Doc, and logs counts and the URL
  only (no names). It is not reachable over HTTP.

### `public/style.css`, `public/sw.js`
- Red «בית לא מזוהה» tab. SW **v92 → v93** (live v92 verified 26/10/2026; v17 never reused).

## Security
- No secret, no new endpoint, no new Script Property, no schema change (Sheets headers
  untouched). The report is editor-only and not reachable over HTTP. Its log carries no
  names. Every rendered value goes through `escapeHtml` / `textContent`; the tab label is
  fixed text plus a number.
- `npm audit`: 0 high / critical (1 pre-existing moderate in transitive `qs`).

## Tests
- New `test/patient-missing-from-house.test.js` (19): every pardes form resolves; the
  patient is in «מטופלים» and in the pardes tab; the unknown-house tab; search; «שחרר»
  (edit only, active only, same flow, busy guard); Code.gs parity and alias table; the
  in-place save + heal (`hapardes`, label, RLM, NBSP); alias payload keys; moves; delete;
  digest; the report (rows, read-only, no names in the log, not over HTTP); SW v93.
- `test/missing-patient-diagnostic.test.js`: rows whose house carries an invisible mark or a
  doubled space are VISIBLE now (they were pinned as hidden — that was this bug).
- SW pins moved to v93 (`dashboard-perf-assets`, `ortal-billing-ui`) or made monotonic
  (`discharge-outpatient-handoff`).
- Full suite: 3439 tests, 0 failures.

## After merge (Sandra)
- Run `patientsMissingFromHousesReportNow` once from the Apps Script editor and open the Doc.
- Rows with «יתוקן בשמירה הבאה» heal on the next save. For «בית לא מזוהה» rows: «מטופלים» →
  ✏️ → the right house, or «שחרר» straight from «מטופלים».
