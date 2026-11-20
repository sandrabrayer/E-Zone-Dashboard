# CRM — optional patient name / phone on first-call intake

Sandra, 20/11/2026: on the first call, the person reaching out is usually calling on
behalf of someone else. They often won't give their own full name, won't always give the
patient's name, and won't give the patient's phone. Until now all three were required
fields, so Vered couldn't log the call. These are now **optional at intake** — the lead
can be created with whatever little is known and enriched later.

## What changed

**New-lead form (`leadFormErrors`, `renderNewLeadForm`)**
- Patient **name** is optional; the old "full name — two words" rule is gone (a first
  name, or nothing, is accepted).
- Patient **phone** is optional; a phone that IS typed must still be a valid Israeli
  number (10 digits) — the format guard is kept.
- A **contact name** no longer forces a «קשר למטופל»; the relation stays available but
  optional.
- Still required (Vered's own fields, always known): **מקור הליד**, **בית** (unless the
  meeting is «אמבולטורי»), **משוייך ל**. So a lead is never a fully empty row.

**Lead edit (`leadEditPlan`)** — the same relaxation: a partial name or a blank name/phone
can be saved; a typed-but-invalid phone is still refused.

**Admission (`admissionErrors`, `admitLead`, admit form)** — the name becomes **required
here instead**. The admit form now carries a «שם מלא» field, pre-filled from the lead; a
lead that was created without a name must get one before it is admitted, and the name is
written back onto the lead. **No nameless patient row is ever created** — the integrity
invariant moves from intake to admission, it is not dropped.

**Display (`leadLabel`)** — a lead with a blank name renders as **«(ליד ללא שם)»** on the
board cards, the drawer heads, the list rows and the search results, so it stays visible
and clickable.

**Server (`apps-script/Code.gs`, `leadRequiredViolations_`)** — the intake save path
(`saveAll`) was relaxed to match: a lead name is optional, a phone is optional, and only a
**present-and-invalid** phone (changed) refuses the save. The `createLeadFromTherapists_`
handoff path keeps its own name rule, unchanged. Deploys automatically via clasp CI on
merge.

## Tests

- `test/crm-optional-lead-fields.test.js` (new, 6 tests): the relaxed `leadFormErrors`,
  the form markup, `leadLabel`, the admission name requirement, `admissionRow` name
  precedence, and the documented server relaxation.
- `test/lead-name-phone-required.test.js`: server tests rewritten to the relaxed behavior
  (nameless / phoneless / one-word-name leads save; a typed junk phone still refused).
- `test/crm-lead-full-edit.test.js`, `test/crm-shell-ui.test.js`, `test/crm-kpi-tab.test.js`,
  `test/crm-not-relevant-column.test.js`: assertions updated to the relaxed rules and the
  `leadLabel` render.
- SW cache bumped **v154 → v155** (`test/crm-pwa.test.js`, `test/dashboard-perf-assets.test.js`).

## Security

No new endpoint, action or secret. A phone, when provided, is still format-validated on
both the client and the server (fail-closed on a malformed number). Every rendered value
stays escaped (`leadLabel` output passes through `esc`). The name invariant is preserved
at admission, so no nameless patient record can be written. `npm audit`: 0 high / critical.
