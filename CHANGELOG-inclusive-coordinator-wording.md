# Inclusive coordinator wording

October 9, 2026. Coordinators include men, so no user-facing text may call them
by the feminine-only «רכזת» / «רכזות». The rule: «רכז/ת» in the singular (verbs
and adjectives in slash form too, e.g. «הרכז/ת שלח/ה») and «רכזים» in the
plural.

**Railway only** (`public/index.html`, `public/sw.js`). Code.gs not touched. No
column, sheet, Script Property or env var. SW `CACHE_VERSION` v56 → **v57**
(live was v56, no open PR; v17 stays burned).

## Sweep

**Files checked:** `public/**`, the string literals in
`apps-script/Code.gs`, `docs/**`, `EZONE-ECOSYSTEM-STATUS.md` and `DEPLOY.md`.

**Search:** every prefixed form of «רכזת» / «רכזות», such as «הרכזות»,
«לרכזת» and «מהרכזות».

| Where | Before | After |
| --- | --- | --- |
| `public/index.html:188` (the «🚪 שחרורים מהבתים» subtitle on the dashboard) | «שחרורים שדווחו ע״י **הרכזות** ב־30 הימים האחרונים …» | «שחרורים שדווחו ע״י **הרכזים** ב־30 הימים האחרונים …» |

### Kept on purpose

- `apps-script/Code.gs:6995`: `'רכזות · ' + v.by`.
  - This is the `updatedBy` stamp the coordinators feed writes into the
    Patients sheet, so it is a stored value.
  - Existing rows already carry it, and the rule is never to rewrite stored
    values.
  - `test/coordinators-roster.test.js` pins it.
  - The comment at `Code.gs:6833` describes the same stamp.
- `docs/**`, `EZONE-ECOSYSTEM-STATUS.md` and `DEPLOY.md` had no feminine-only
  coordinator wording.
- Past `CHANGELOG-*.md` files are history and were not rewritten.

## Guard

`test/inclusive-coordinator-wording.test.js` fails the build when «רכזת» /
«רכזות» appears as a standalone word, prefixes included. It does not match
inside longer words: «מרכזות» does not match.

- **`public/**`:** every text file, whole content.
- **`apps-script/Code.gs`:** every string literal; comments are skipped.

The stored stamp `'רכזות · '` is the one allowed literal. Another test asserts
it still exists, so the exception is dropped once the stamp is gone. Against
the old `index.html` the guard fails on line 188.

## Convention

`EZONE-ECOSYSTEM-STATUS.md` gets a «Conventions» section: "Gendered roles: use
slash form (רכז/ת, מטפל/ת) in the singular and the masculine plural (רכזים) as
inclusive. Never feminine-only for a role."

## Role-group findings (reported only, nothing changed)

**Masculine plural, already inclusive under the convention:**
- «מטפלים» in `EZONE-ECOSYSTEM-STATUS.md:109` / `:154`.
- «המדריכים» in `:106`.
- «מטופלים» throughout the app.

**Masculine singular «מנהל» for the house-manager role:** these are labels for
a role that can be held by a woman.
- «דיווח מנהל» (`app.js:3477`, `:3671`).
- «דיווח המנהל» (`app.js:3564`, `:3735`).
- «ללא מנהל» (`app.js:3897`; also the conversion strip's bucket key).
- «המרת פגישות למנהל» (`app.js:3954`).
- «דיווח מנהלי בתים» (`meeting-report.html:14`).

The convention's slash form would be «מנהל/ת». These were not changed (out of
scope).

**Feminine forms that refer to a named woman, so they are not a role group:**
- «ורד מטפלת: …» (`index.html:407`).
- «אורטל … מטפלת …» (`docs/billing-control-plan.md:334`).
- «מנהלת המערכת» (Sandra).

**Not roles:**
- «אח/אחות» is a relation option and is already in slash form.
- «עובדות» in `docs/billing-control-plan.md:519` means "facts".

Full suite: 2652 / 2652. `npm audit`: 0 high / critical (1 moderate,
pre-existing).
