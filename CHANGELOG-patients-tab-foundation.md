# «מטופלים» — the patient list, PR 1: the foundation

This PR builds the groundwork for a new **«מטופלים»** tab. That tab is the
patient list the app lacks today: only **תפוסה** exists. The tab itself comes
in PR 2 (`CHANGELOG-patients-tab-ui.md`).

**Nothing changes on screen.** This PR adds pure helpers to `public/app.js`
and their tests. No render function calls them yet. `apps-script/Code.gs`,
`server.js`, `index.html`, `style.css` and `sw.js` are not touched. It adds no
new action, column, sheet, Script Property, env var or trigger, and writes
nothing.

## The lead travels with the patient — a display join

A patient row will show its lead's details: phone, source, visit date,
advance, notes, and who handled it (`assignedTo` / `meetingWith`). **No lead
field is copied onto the Patients sheet.** The details are joined at render
time, so the lead stays the one source of truth. A test checks that building
the list leaves the Patients rows untouched.

### `patientLeadInfo(patient, leads, patients)` → `{ lead, via, ambiguous }`

`leads` is every lead the app holds: the board (including `admitted`), the
closed list and the removed list (`patientLeadPool`).

| The patient | What happens | `via` |
|---|---|---|
| `fromLead` is set and its lead is in any list | that lead | `fromLead` |
| `fromLead` is set but the lead is gone | no lead. It is **not** re-guessed by name | `fromLead_missing` |
| `fromLead` is blank | the #192 match (`unadmittedLeadPatient`), read from the patient's side | `name_house` |
| that match is ambiguous | no lead, and never flagged | `ambiguous` |
| nothing matches | no lead (shown as «ללא ליד») | `none` |

With a blank `fromLead`, the only #192 tier that can reach a patient is
**name + house**. The phone tier joins through the patient's own `fromLead`,
and the fromLead tier needs a set `fromLead`. A lead is a candidate only when
the #192 match lands on it through the name + house tier. So a lead that is
already linked to another patient by `fromLead` is never claimed by name.

**Ambiguous** means two or more candidate leads, or a name + house tier that
hits more than one patient. The same lead id appearing twice counts as one
lead.

## The problem chips — `patientProblems(patient, leadInfo, payments, funders, todayIso)`

The result is `[{ code, label }]`, always in this order:

| code | chip | When |
|---|---|---|
| `no_funder` | ללא גורם מממן | the funder on today (`currentFunderFor` rules via `funder.js`) is unset: no row, an unknown label, or only a future row. **Finance only** |
| `no_payment` | לא דווח תשלום | today (Asia/Jerusalem) is 3 or more days after entry and no Payments row records money for the patient. **Finance only** |
| `house_mismatch` | בית שונה מהליד | the lead names a house and it is not the patient's house |
| `no_lead` | ללא ליד | `fromLead` is blank and nothing matches. Never when the match is ambiguous |

- **«לא דווח תשלום»:** "money recorded" means a non-void row that is paid,
  partial, or has `amountPaid` > 0. The row is the patient's by the
  server-owned uid (`paymentPatientUid`) or by the matcher's
  `house::name::entryDate` reduction (`patientMatchKey`). A pro-bono
  patient is not flagged (nothing is owed). Day 2 is not flagged; day 3 is.
- **Released patients** have no problems. The list is about who is in a house.
- **Without finance** (`payments` / `funders` passed as `null`), the two
  finance chips are not computed. `patientListRows` passes `null` whenever
  `state.finance !== true`, even if an array is present.
- A **house move** made through ✏️ does not update the lead's house (see
  `CHANGELOG-house-move-lead-linked.md`), so such a patient shows «בית שונה
  מהליד». That is the locked rule: the chip asks someone to look.

## The other helpers

- **`patientPaymentState(patient, payments, funders, todayIso)`**: the
  current cycle through the existing billing helpers
  (`lastBillingDayOnOrBefore` → `paymentId` → the row's derived status). It
  returns `paid` / `partial` / `unpaid` / `void` (מבוטל) / `probono` /
  `not_due` (טרם חויב), or `null` for a released patient or one with no
  entry date.
- **`patientListRows(state, filters, todayIso)`**: one row per patient.
  - The filters are `{ house, status: 'active' | 'released' | 'all',
    problemsOnly, q }`. The default (`PATIENT_LIST_DEFAULT_FILTERS`) is active
    patients in every house.
  - The name search uses `normalizeNameForMatch`.
  - Sorted by entry date, newest first.
  - Each row is `{ patient, leadInfo, lead (patientLeadDetails),
    problems, days (patientDaysInHouse), payment }`.
  - `payment` is `null` without finance.
- **`patientProblemSummary(state, todayIso)`**: patients with at least one
  problem, and a count per chip, over the active list. This feeds the summary
  line and the tab badge.
- **`pendingAdmissionRows(leads, patients, payments, todayIso, allLeads)`**:
  the «ממתינים לקליטה» section. These are board leads that are paid or
  entering treatment (`unadmittedLeadEligible`) with no patient record
  (`unadmittedLeadPatient`). It is the #192 rule **without** its 3-day
  threshold. `chipDays` carries the #192 chip (`unadmittedLeadDays`) from
  day 3. Ambiguous matches, admitted leads and an unloaded patient list are
  never listed.

## Admission sets `fromLead` and stage `admitted` (requirement 7)

Checked: both admission paths already do this. **No write-path change was
needed.** The tests pin it.

- **«כניסה לבית»** (`openEntryModal`, the paid lead's admit action) builds the
  patient with `fromLead: lead.id` and sets `lead.stage = 'admitted'` in the
  same `saveAll`. A failed save rolls both back.
- **The load-time path** works the same way. `promoteEnteredLeads` creates
  the patient with `fromLead`, and `retireAdmittedLeads` moves the lead to
  `admitted`.
- `normalizeLead` always gives a lead an id, so `fromLead` is never blank on
  an admission from a lead.

## Visibility — verified, not duplicated

`server.js` already answers 403 for `getPayments` (which carries Payments,
Funders and receipts), `reportPayment` and `appendFunder` to a session without
`finance` (`lib/finance-scope.js`). The tests re-check that list. The client
side is only `state.finance === true` inside `patientListRows`.

## Tests

`test/patients-tab-foundation.test.js` has 28 tests and runs in CI. The device
clock is set to UTC.

- `patientLeadInfo`:
  - `fromLead` in each of the three lists;
  - a missing lead is not re-guessed;
  - the name + house fallback (Hebrew house name or id; another house or
    name misses);
  - ambiguity, both ways; a duplicate id counts once;
  - a lead owned by another patient is not claimed.
- `patientProblems`:
  - a clean patient;
  - each funder case;
  - the day 2 / day 3 boundary, a future entry, no entry date;
  - paid / partial / void / unpaid / another patient's row;
  - a match by uid and by the normalized triple;
  - pro-bono;
  - house mismatch (id or name; a blank lead house is not flagged);
  - «ללא ליד» vs ambiguous vs a missing `fromLead`;
  - no finance data; released; the chip order.
- `patientPaymentState`: every key, and the cycle moving with the month.
- `patientListRows`:
  - the default filter, house, released, all, problems only, search;
  - the display join, including a removed lead;
  - the Patients rows are untouched;
  - days in the house, including entry → exit for a released patient;
  - no payment state or finance chips for `finance` false / null /
    undefined.
- `patientProblemSummary`.
- `pendingAdmissionRows`: the order, days, the chip from day 3, no entry
  date, ambiguous, admitted, plain visit, patients not loaded.
- Admission: «כניסה לבית» sets `fromLead` and `admitted` in one save; a
  failed save rolls both back; promote + retire.
- Scope:
  - the helper block has no fetch, save, `innerHTML` or state assignment;
  - Code.gs never mentions the helpers;
  - `FINANCE_ACTIONS` still guards the money reads and writes;
  - no tab or screen yet.
- Mutation checks, each caught:
  - the ambiguity guard removed;
  - the threshold changed 3 → 2;
  - a void row counted as money;
  - the finance gate dropped.

Full suite: **2421 / 2421** passing.
