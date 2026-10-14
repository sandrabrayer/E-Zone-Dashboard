# CRM pilot preparation — 2026-10-14

- Add a non-deployed, read-only source preflight helper: headers/ID columns only,
  aggregate counts, archive existence, blank/invalid/duplicate IDs and capacity.
- Add an explicit operator-only encrypted-checkpoint preflight returning total,
  open and closed counts under a database-enforced read-only transaction.
- Add real-PostgreSQL tests using a dedicated runtime role with SELECT plus
  column-limited UPDATE; reject DDL, destructive DML, other-table/owner access,
  and generation/key changes.
- Add a CI pg_dump/pg_restore drill into a different disposable database, with
  separately held random key, ciphertext/cursor verification, wrong-key refusal,
  fencing, retained dates/open work and closed-task suppression after recovery.
- No runtime, Code.gs, source projection, UI or production settings changed.
- Results and exact tested head are recorded in PR #220. Synthetic recovery does
  not establish production backup or activation readiness.
