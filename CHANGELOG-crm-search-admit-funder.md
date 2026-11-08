# CRM — search from anywhere + spinner, direct add admits the open lead, funder saved — 2026-11-01

Branch `claude/crm-search-admit-funder` → base `claude/build-ezone-dashboard-QOg5s`.
It is stacked on PR #337, which must be merged first.
Code.gs untouched. SW `CACHE_VERSION` v108 → **v109**.

## 1. The search "did not work" — and a spinner
- **Cause.** Typing in the top box from «היום שלי», «תפוסה», «יומן» or «בקרה» jumped to «פניות». That list shows
  only OPEN leads (new / visit / waitlist / paid). So a patient who was admitted or discharged (e.g. a lead
  already in a house) gave an empty board. «מטופלים» searched in-house patients only. There was also no button,
  and nothing showed while the page re-rendered.
- **Fix.**
  - From those areas the search opens a «חיפוש» results view, `globalSearch`. It covers every lead (any stage)
    and every patient (released included), by name, phone digits (the lead's own, or the patient's lead's) or
    house. A row opens its card.
  - «פניות» and «מטופלים» still filter their own list. When that list comes out empty, the global results show
    instead.
  - Typing is debounced (300 ms). Enter, or the new 🔍 button, searches at once.
  - The 🔍 button shows a spinner (`aria-busy`) while a search runs.
  - Clearing the box returns to the previous area.
  - «גבייה» search is unchanged.

## 2. A patient in a house whose lead is still «בטיפול פעיל» (e.g. מתן כחלון → ריהאב)
- **Cause.** «הוספת מטופל/ת ישירות» always created a NEW «פנייה ישירה» lead (`dl-<id>`). It never looked for
  the person's existing open lead, so that lead stayed «בטיפול פעיל» on the board next to the patient.
- **Fix (going forward).** The direct add first looks for the person's open lead: by phone when one is typed,
  else by full name.
  - Exactly one match: the add becomes that lead's admission, the same as «קליטה לבית». The lead becomes
    admitted, the patient's `fromLead` points to it, and no new lead is created.
  - Several matches: the form asks to admit from the right lead in «פניות».
- **Existing cases.** An open lead whose person is already in a house now shows «כבר בבית <בית>» on the board.
  Its card has «סגירת הפנייה כנקלטה»: ONE lead save (stage admitted, entry date and house from the patient).
  No patient row is touched.
  - The extra «פנייה ישירה» lead from the old add stays, so the funnel counts that person's entry twice. This
    affects only people added before this fix.

## 3. The funder was not saved
- **Cause.** The CRM's funder save sent `submissionId = randomId()…`, hex with no `sub-` prefix. Code.gs
  `appendFunder_` requires `/^sub-[A-Za-z0-9-]{8,64}$/` and refused the request with `bad_submission_id`. As a
  result, EVERY funder entered in a CRM admission or direct add (CRM default since 28/10/2026) was refused.
  The only sign was a red toast. Funders set in the classic dashboard were fine.
- **Fix.** The CRM now sends `newSubmissionId()` (`sub-` + 32 hex), the key the payment report already uses.
- **Existing patients** admitted in the CRM since 28/10 have no funder row. Set it on the patient card in the
  classic dashboard («גורם מממן»).

## 4. «אור זיו» shown as not transferred (fixed in PR #337)
A discharge «משוחרר לטיפול חוץ» produced «לעדכן המשך טיפול — שוחרר/ה ללא המשך טיפול», because «המשך טיפול»
was empty. After a CRM discharge, the משוחררים row also showed «לא נשלח» until a reload. PR #337 now treats an
outpatient discharge as continued outpatient treatment, and marks the send at once.

## Security
- No new route or action, and no Code.gs change.
- Every rendered value goes through `esc()`.
- The lead close is the existing one-lead `saveAll`. Dana (ops) may use it, as with any lead edit.
- The funder write stays finance-only; it is still gated on the server.

## Tests
`test/crm-search-admit-funder.test.js` (7):
- pure: `openLeadOfPerson`, `leadAlreadyInHouse`, `globalSearch`, and source guards (the funder key matches
  Code.gs `SUBMISSION_ID_RE`; the spinner hook);
- real server + Chromium:
  - search from «היום שלי» finds a released patient, with the spinner, Enter, 🔍 and clear;
  - «כבר בבית» → a one-lead admitted save;
  - a direct add admits the open lead and saves the funder, with the mock enforcing Code.gs's key rule.

SW pins updated.

## Files
`public/crm/crm.js`, `public/crm/crm.css`, `public/crm/crm.html`, `public/sw.js`,
`test/crm-search-admit-funder.test.js` (new), `test/crm-pwa.test.js`, `test/dashboard-perf-assets.test.js`,
`CHANGELOG-crm-search-admit-funder.md`.
