# CRM — permanent patient delete inside the CRM

Sandra, 20/11/2026: deleting a patient was one of the operations still only in the
classic page. It now lives on the CRM patient card. Migrating every classic-only
operation so `/?view=classic` can be dropped.

## What is new

The patient card — in-house and released — gains a **«מחיקת המטופל/ת»** section
(collapsed, marked danger) with a permanent-delete button.

- **Who:** finance **and** deleter only (ורד / סנדרה). The verifier (Ortal) and any
  restricted user never see it. The server enforces the same (`DELETE_ACTIONS`
  require the `deleter` role).
- **How:** the dedicated **`deletePatientRow`** backend action — the same one the
  classic page used — which tombstones the row (reason `user-delete`, written before
  the delete, fail-hard) and then removes it, and suppresses a stale tab's
  resurrection of the key for 24h. **Not** a saveAll omission.
- **Safety:** a native confirm; optimistic removal rolled back on any failure; the
  server names the row it deleted (`id`, or `key` for a pre-id row), and a lost-answer
  retry is accepted (`alreadyDeleted`).

## Security

Permission gated in the UI and enforced server-side; no patient data logged; the
action body carries only id / houseId / name / date. `npm audit`: 0 high / critical.

## Tests

- `test/crm-patient-delete.test.js` (new, 3): the permission gate, the dedicated-action
  contract (confirm, proven id, rollback, no saveAll), the wiring on both cards.
- `test/crm-shell-browser.test.js`: one scenario — a refused delete rolls back, a real
  delete posts the dedicated action and removes the row, declining the confirm posts
  nothing, and a restricted user (Dana) never sees the control.

## Files

`public/crm/crm.js`, `public/crm/crm.css`, `public/sw.js` (v149 → v150),
`test/crm-patient-delete.test.js` (new), `test/crm-shell-browser.test.js`,
`test/crm-pwa.test.js`, `test/dashboard-perf-assets.test.js`, `EZONE-ECOSYSTEM-STATUS.md`.

## Deploy

Railway only (auto-deploy of the deployed branch). No Apps Script deploy.
