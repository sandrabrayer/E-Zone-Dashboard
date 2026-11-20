# CRM — «החזרה לפעיל» on the released-patient card

Sandra, 20/11/2026. Re-activating a released patient already worked in the CRM from the
**«משוחררים»** tab; the released-patient **card** only said "do it in the classic dashboard".
That note is now replaced with a real **«החזרה לפעיל»** action on the card.

## What changed

- `releasedEditBlock(p, discharge)` now renders a sibling **«↩︎ החזרה לפעיל»** block
  (`reactivateBlock`) under the edit form — never inside it, because the restore UI is itself
  a `<form>` and forms cannot nest.
- The button reuses the **existing, tested** restore flow: `openRestoreChoice(id, sel)` (now
  parametrised with a target container) renders the same restore form — prior-status vs.
  new-lead — into the card's own `#crm-card-restore`, and submit goes through the unchanged
  `submitRestore`.
- `submitRestore` is unchanged in substance: it still flips the row back to its prior status
  (פעיל/ניסיון/בהמתנה), clears the exit date, and — the integrity guard — flags **every** open
  discharge-audit row of the stay `restored='TRUE'` (`openAuditsOf` → `restoreFlagBody`). Miss
  one and the heal-on-load would re-release the patient. It now also `closeDrawer()` on success
  (a no-op from the list, clean from the card).
- An **auditless** legacy release (no linked discharge row) still points to the classic
  dashboard; **controllers** (verification-only) get no re-activate action.

## Why it's safe (nothing lost)

No new restore/ledger logic — the card button opens the same path the «משוחררים» tab already
uses, so the discharge-audit and credit links by stable `patientId` are untouched. The
"flag every open audit" invariant is reused, not re-implemented.

## Tests

- `test/crm-released-stay-edit.test.js`: the card now exposes «החזרה לפעיל» (not a status field);
  a second test pins the reuse (shared `openRestoreChoice`/`submitRestore`, the container
  wiring, the audit-flag + `closeDrawer`).
- `test/crm-shell-browser.test.js` **C17b** (new): open a released patient's card → «החזרה
  לפעיל» → the restore form in `#crm-card-restore` → submit → house-as-read `saveAll` (status
  active, exit cleared) + `restorePatientToActive` with `restored='TRUE'`, then the drawer closes.
- Full suite green (4026 unit + 57 browser). SW cache **v155 → v156**. `npm audit` 0 high/critical.

## Security

No new endpoint, action or secret; reuses `restorePatientToActive` / `saveAll`. Server stays the
fail-closed authority on who may write. Rendered values escaped.
