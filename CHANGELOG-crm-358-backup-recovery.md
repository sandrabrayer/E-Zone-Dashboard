# CRM #358 — preserve the prior backup during replacement

Date: 2026-11-03. Existing branch `codex/crm-single-rc-20261102`; no new PR.

A failed same-day backup could erase the previous copy because `integrityWriteSnapshot_` cleared it before writing. Reuse OP-03's temporary-sheet, readback-verification and publication protocol. Literal text and value types are verified before replacing the old name. Recovery remnants survive failure and strict retention. A failed source read prevents all publication/retention; a missing family preserves older proof.

Reuse #326's Dana export and CRM restore acceptance tests. Correct its fixture to check contact linkage on the completed task and the follow-up link in Activity details, matching the unchanged source contract. Add replacement/read/retention failure tests (12 failed before the correction; 14 pass after, plus the existing/reused focused checks).

Source changes are confined to the backup helper and nightly failure/retention gates. No frontend, cache version, permission, schema, production or financial-data change. This is per-sheet protection; native Google proof, a coherent capture, staff UAT and permission-policy decisions remain release gates.

See [the recovery checkpoint](docs/crm/CRM-358-RECOVERY-CHECKPOINT-20261103.md) and the final-head CI evidence in #358.
