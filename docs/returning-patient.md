# «מטופל חוזר» — identity and matching rules

Source: `lib/returning-patient.js`.

## Person = records joined by ids only
| Record | Joins the person of… |
|---|---|
| Patients row | `personId` if set, else its own `id` (the root) |
| Discharge row (not soft-deleted) | the Patients row with `id = patientId`, else the Patients row with the same stay key (house + name + entry date), else its own person (one per stay) |
| Closed lead | the person whose stay or discharge has `fromLead = lead.id`, else its own person |

Phones come from discharge rows, linked leads (board, closed, removed) and closed leads. They are normalized to local `0…`, 9–10 digits.

A person with **any** non-released Patients row is active and never offered.

## Matching (fail closed)
1. A typed phone matches exactly one person:
   - with no typed name, or a typed name that is one of that person's names → **unique**;
   - with a typed name that is not one of that person's names → **conflict** (manual pick).
2. A typed phone matches several people → **multiple**.
3. Otherwise, a full-name match (whitespace-collapsed, case-folded): one person → **unique**, several → **multiple**.
4. Otherwise → **none**. Suggestions are offered for a manual pick: people who share a name token or the last 7 phone digits, at most 10.

Only **unique** offers «המשך» directly. Every other outcome requires a person to pick, and nothing is linked without that pick.

## What confirming writes
- One new Patients row:
  - `status: active`, `source: direct_admin`;
  - `personId` = the person's root id;
  - `fromLead` = blank, except a closed-lead-only person (no Patients row), whose closed lead is used.
- A phone-record lead only when the typed phone is not already known for the person.
- `restored='TRUE'` on each of the person's open discharge rows, after the save is proven.
