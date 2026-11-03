# E-ZONE One v0.2 — platform architecture discovery (2026-10-31)

**Proposal/draft documentation only; nothing deployed or merged.** Architecture decision record: Dashboard issue #331. The user wants a more integrated product and reuse of existing code rather than a portal of unrelated apps or a risky all-at-once rewrite.

New documents:
- `docs/architecture/EZONE-ONE-ARCHITECTURE-v0.2.md` — candidate modular platform, shared customer-service core, identity/finance/role boundaries, staged transition and unapproved decisions.
- `docs/architecture/APPLICATION-CAPABILITY-INVENTORY.md` — ten active domain repositories plus the demo-only finance-control repository, current features vs potential integration and unknown user adoption.
- `docs/architecture/OUTPATIENT-CRM-REUSE-AND-GAPS.md` — live vs existing draft CRM functionality, business capabilities still needing specification, protection against duplicate CRM task ledgers, and acceptance examples.

Current Outpatient CRM PRs #142–#148, care-continuum PRs #137/#138/#329/#330, and OP03 PRs #125/#139/#140 are **not merged or deployed by this draft**. Separate Outpatient deep product audit owned by Claude: issue #149. Existing Dashboard CRM D1–D17 decisions preserved. No production code, Apps Script, schemas, secrets, Railway services, source records or data were changed. This documentation does **not** approve a PostgreSQL migration, wholesale codebase consolidation, rollout or any business decision.

CI on the exact docs-only PR head will be checked separately if available.