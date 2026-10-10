# Inclusive role wording — the coordinator stamp and house-manager labels

October 10, 2026. This finishes the convention set in
`CHANGELOG-inclusive-coordinator-wording.md` (EZONE-ECOSYSTEM-STATUS.md,
«Conventions»): a role takes the slash form in the singular and the masculine
plural as inclusive, and is never feminine-only.

**Railway + Code.gs** (clasp CI on merge). Code.gs is in its own commit. No
column, sheet, Script Property, env var or trigger. SW `CACHE_VERSION` v57 →
**v58** (live was v57, no open PR; v17 stays burned).

## 1. The coordinators-feed `updatedBy` stamp

| Where | Before | After |
| --- | --- | --- |
| `apps-script/Code.gs` `recordDischargeFromCoordinators_` (`stampBy`) | `'רכזות · ' + v.by` | `'רכזים · ' + v.by` |

- **What the stamp is written to:** the Patients row's `updatedBy`, the
  discharged-audit row's `updatedBy`, and the audit-log actor.
- **Old rows keep «רכזות · …».** Nothing rewrites them: a replayed discharge
  writes nothing, and every other save carries the row's stored value through.
- **Every reader accepts both forms**, because nothing parses the stamp.
  - The server never reads it back. Its only use is to pass through
    `sheetUpdatedBy` into a stale-save conflict.
  - The Dashboard normalizes it as a plain string (`public/app.js:575`, `:747`,
    `:3028`, `:8245`) and displays it in exactly one place: the stale-save
    conflict banner, `conflictsMessage` (`public/app.js:664`–`669`) / the house-move
    refusal (`public/app.js:688`). It shows the stored stamp verbatim, so an old
    row reads «רכזות · שירה עדכן/ה קודם» and a new one «רכזים · שירה …».
  - The «🚪 שחרורים מהבתים» panel shows `dischargedBy`, the coordinator's own
    name, not `updatedBy`.
- **Comment:** the `Code.gs` comment describing the stamp now names both forms.

## 2. House-manager labels (display text only)

| Where | Before | After |
| --- | --- | --- |
| `public/app.js` report block title (lead card / meetings board) | «דיווח מנהל» | «דיווח מנהל/ת» |
| `public/app.js` delete-report confirm | «למחוק את דיווח המנהל? …» | «למחוק את דיווח המנהל/ת? …» |
| `public/app.js` edit-report modal heading | «עריכת דיווח מנהל» | «עריכת דיווח מנהל/ת» |
| `public/app.js` edit-report race error | «דיווח המנהל השתנה בזמן העריכה …» | «דיווח המנהל/ת השתנה בזמן העריכה …» |
| `public/app.js` conversion strip head | «המרת פגישות למנהל» | «המרת פגישות למנהל/ת» |
| `public/app.js` unassigned bucket **label** (new `MANAGER_CONVERSION_UNASSIGNED_LABEL`) | «ללא מנהל» | «ללא מנהל/ת» |
| `public/meeting-report.html` page subtitle | «E-Zone — דיווח מנהלי בתים» | «E-Zone — דיווח מנהלי הבתים» |

**The page subtitle** uses «מנהלי הבתים» rather than «מנהלי/ות בתים». The
masculine plural is the inclusive form under the convention, and it reads
better than a slash inside a construct form.

**«ללא מנהל»:**
- The bucket key `MANAGER_CONVERSION_UNASSIGNED` stays byte-identical, «ללא
  מנהל». `computeManagerConversion` groups by it and `meetingsSummaryHTML`
  filters on it.
- Only what a screen shows changed: `managerConversionLabel()` maps the key to
  «ללא מנהל/ת», and the strip renders names through it.
- The strip still hides that bucket, as before, so today the label is never
  shown.

**Sweep:**
- `public/**`, `meeting-report.html` included, has no other singular «מנהל»
  meaning the house-manager role.
- «מנהלת המערכת» (Sandra) and named people are untouched.

## Tests

- **`test/inclusive-role-wording.test.js`, 7 tests:**
  - the bucket key is byte-identical;
  - bucketing is unchanged: same rows and counts for blank, whitespace and
    named meetingWith;
  - the unassigned label maps to «ללא מנהל/ת»;
  - the strip still hides the bucket, under the new head;
  - the report block title on a lead card;
  - every changed label is in the source, and no bare singular «מנהל» label
    is left outside comments, apart from the key;
  - the conflict banner shows both stamp forms verbatim.
- **`test/coordinators-roster.test.js`:**
  - new discharges stamp «רכזים · …»;
  - a new test: a row stamped «רכזות · …» before the change is replayed with
    nothing written, keeps its stamp, and the feed still reports it
    discharged.
- **`test/inclusive-coordinator-wording.test.js`:** the `ALLOWED` exception is
  removed, so the guard runs with zero exceptions. It now also asserts that
  the stamp literal is «רכזים · ». Against the old Code.gs it fails.
- **`test/dashboard-perf-assets.test.js`:** SW version pin v57 → v58.

Full suite: 2660 / 2660. `npm audit`: 0 high / critical (1 moderate,
pre-existing).
