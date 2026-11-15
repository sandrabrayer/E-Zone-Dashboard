# Managers CRM backend — talk threads, committee notes, per-worker house cost (14 Nov 2026)

## Why

Sandra, 14 Nov 2026, for the Managers app redesign:

- «בשיחות עם עובדים צריך גם אפשרות לשיחה שניה או תוצאה»;
- «בועדות אפשרות לרשום מה היה בועדה»;
- «לכל מנהל צריך תקציב כוח אדם עם רשימה מעודכנת של העובדים שלו ומה עלות השכר שלהם».

## What

All through the existing `managersWork` action and its fail-closed `MANAGERS_WORK_SECRET` gate. No new Script Property, no new action, no Railway change.

### Staff-talk threads (`staffTalks`)

- Four columns **appended after the stamp columns** of `ManagersStaffTalks` (append-only header; `getOrCreateSheet_` adds the header cells on the first write): `talkKind` (`first` / `followup` / `outcome`), `parentId`, `outcome`, `agreedActions`.
- A follow-up or an outcome must point at a **first** talk of the same house and the same employee that the caller can see (its author or an admin) — else `not_found` / `forbidden` / `bad_request`. An outcome needs an allowlisted value: `improved`, `no_change`, `warning`, `hr`, `termination`, `closed`.
- Rows written before today have an empty `talkKind` and read as first talks. Privacy is unchanged: author + admins only.

### «מה היה בוועדה» (`committeeNotes`)

- A new log, sheet `ManagersCommitteeNotes` (created on the first write): `committeeId` (the coordinators' id when picked from the list, validated), `patientName`, `heldDate`, `participants`, `summary`, `decision` (allowlist `continue` / `extend` / `discharge` / `outpatient` / `other`), `nextDate`, plus the usual stamps and follow-up.
- Visible to the house (not private), so a new manager inherits the history. Committees are still SET only by the coordinators.

### `houseStaffCost`

- `managersWork` op `houseStaffCost { month }` → the staffing feed `getHouseWorkerCostsForManagers` (staffing PR, same `STAFFING_SHEETS_URL` + `STAFFING_COST_SECRET` as `houseCost`).
- Returns only the caller's house: `{ available, month, hasActuals, stale, generatedAt, total, budget, workers: [{ name, roles, cost, estimated }], budgetLines: [{ key, label, budget, cost }] }`. Every value is re-cleaned; any other key from upstream is dropped. `pardes` + `hapardes` merge per person and per line.
- Not configured / bad URL / down / unauthorized / older staffing (`not_deployed`) / junk / no house → `{ available:false, reason }`, never a 0. Cached 10 minutes per month.

## Tests

`test/managers-crm-backend.test.js` (10): appended columns, a full thread, the thread validation, privacy across managers and houses, legacy rows, committee notes (allowlist, cleaning, house scope, follow-up), houseStaffCost (scoping, cleaning, merge, cache, every failure, the secret gate).
