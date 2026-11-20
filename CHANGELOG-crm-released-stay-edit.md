# CRM — a released patient's stay date + pay are editable

Sandra, 20/11/2026: fixing a released patient's stay dates (to resolve overlaps) was
only possible in the classic page. It now lives on the released patient's card in the
CRM. Migrating the classic-only operations so `/?view=classic` can be dropped.

## What is new

«עריכת פרטי המטופל/ת» on a **released** patient now edits, beside name + notes:

- **תאריך כניסה** (entry date) — the stay date, to fix overlaps.
- **תשלום חודשי** (monthly pay).

Reuses the exact validated save the in-house «עריכה» already uses (`patientEditNext`
→ the proven `houseSaveBody` + `prove.patients`) — a field changes only when the form
carries it.

## Nothing is lost

The patient **stays released** — the card has **no status field**, so this edit never
re-activates the patient and never triggers discharge reopening
(`reopenedDischargeAudits` returns nothing while the status is `released`). Because of
that:

- the discharge audit row stays linked to the patient — it matches by the stable
  `patientId`, not by the entry-date key (`dischargeRowMatchesPatient`);
- the patient's credits stay linked — a credit is keyed by `patientId` (its id is
  `credit::<patientId>::…`), not by the entry-date key;
- every field the form does not carry (status, exit date, funder, …) is preserved from
  the stored row.

So changing the entry date re-keys nothing that a record depends on — the same
behavior as the classic edit, with no new loss.

## Still in the classic flow

**Re-activating** a released patient (status → פעיל / הפסקה זמנית) reopens the stay's
discharge rows and needs the discharge-restore reconciliation
(`reopenedDischargeAudits` / `persistAuditsRestored`); that stays in the classic page
for now and is the last patient operation not yet in the CRM.

## Security

Same permission and proven save as the existing patient edit; values escaped; inputs
validated server-side. `npm audit`: 0 high / critical.

## Tests

- `test/crm-released-stay-edit.test.js` (new, 3): status / exit date / other fields
  preserved on a date+pay edit; validation; the card exposes date + pay but not status.
- `test/crm-shell-browser.test.js`: one scenario — a released patient's entry date +
  pay are edited; the saved row keeps status `released` and the exit date.
- Updated `crm-native-patient-edit` for the added fields.

## Files

`public/crm/crm.js`, `public/sw.js` (v152 → v153),
`test/crm-released-stay-edit.test.js` (new), `test/crm-shell-browser.test.js`,
`test/crm-native-patient-edit.test.js`, `test/crm-pwa.test.js`,
`test/dashboard-perf-assets.test.js`, `EZONE-ECOSYSTEM-STATUS.md`.

## Deploy

Railway only (auto-deploy of the deployed branch). No Apps Script deploy.
