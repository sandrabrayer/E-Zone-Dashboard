# Backfill: a «פנייה ישירה» lead for every direct patient without one

**What:** `migrateDirectPatientLeadsNow(dryRun)` in `apps-script/Code.gs` gives each already-saved
direct patient a lead. These are patients with source `direct_admin` and no valid `fromLead`: the link
is blank, or it points to a lead id on none of Leads / closed / removed. Each gets the same lead
`saveAll_` builds for a new direct add (CHANGELOG-direct-add-auto-lead.md), using the same builder,
`buildDirectApproachLead_`.

Stacked on PR A (`claude/relaxed-feynman-nh5y37`). PR base: `claude/build-ezone-dashboard-QOg5s`.

## Behavior

**Dry run is the default.**
- `migrateDirectPatientLeadsNow()` (or `(true)`) logs one line per patient: patient id, name, house,
  entry date, the phone that would be used, and the lead id.
- It writes nothing and creates no sheet.
- The phone is the one the rosters already recover (`rosterPhoneFor_`: a name match on Leads, or the
  PatientPhones book), normalized through `leadHandoffPhone_`. A missing phone still gets a lead, with
  the phone blank.

**Writes only with `false`.** Use `migrateDirectPatientLeadsNow(false)`, or
`migrateDirectPatientLeadsApplyNow()` from the editor's Run dropdown, which passes no argument.
- It runs under `LockService`. A busy lock returns `lock_busy` and does nothing.
- It goes **one row at a time**:
  1. upsert the lead `dl-<patient id>`, with `created` = the patient's entry date;
  2. verify the lead landed;
  3. write that patient's `fromLead` cell, after re-checking the row's id.
- Each row gets an AuditLog entry `direct_lead_backfilled`.
- A row that fails is logged (`direct_lead_backfill_failed`) and skipped. That patient is never linked
  to a lead that did not land.
- A returning stay (`personId`) gets the returning note. `personId` is untouched.

**Idempotent by patient id.**
- A `dl-<id>` lead that already exists is linked, not written again.
- A second run finds no candidates and writes nothing.
- A patient without an id is skipped and logged. Opening the dashboard once mints the missing ids.

## Scope

- Patients that already have a valid lead are not touched. That includes old phone-record leads with
  source `direct_admin`: they keep their `direct_admin` source.
- No new route or action: `handle_` never dispatches either function.
- No sheet header change. No `public/` change, no SW bump.

## Tests

3295 → 3301 (`npm test`, all green). `test/direct-lead-backfill.test.js` adds 6 tests:
- the dry run makes zero writes (whole-workbook snapshot) and logs entry date / house / phone;
- the real run uses the same builder as `saveAll_`, sets `created` = entry date, gives a phone-less
  patient a lead, and links only the leadless rows;
- an idempotent second run (zero writes), and a pre-existing `dl-` lead that is linked, not duplicated;
- a per-row failure is skipped and logged;
- the lock; not reachable from `handle_`;
- the apply wrapper.

## Deploy

- Code.gs deploys automatically on merge (clasp CI). Merge it after PR A.
- Then, in the Apps Script editor:
  1. Run `migrateDirectPatientLeadsNow` (dry run) and read the Executions log.
  2. Run `migrateDirectPatientLeadsApplyNow`.
- `DEPLOY.md` has the steps.
