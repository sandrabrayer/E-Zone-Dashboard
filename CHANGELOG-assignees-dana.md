# Phase 2b — lead owners: Dana and Sandra in, Shiran and Yael out — 2026-10-28

Follows Phase 2a (`CHANGELOG-readonly-role-dana.md`). Sandra 2026-10-27: Shiran left, Yael moved
role, Dana replaces Yael. Code.gs changed (clasp CI deploys on merge). No SW bump, no env var.

- Classic add-lead form `ASSIGNEE_OPTIONS` and the CRM `ASSIGNEES` are now the same list:
  `['ורד', 'דנה', 'סנדרה']`. Existing leads keep the name they carry (display only — nothing is
  rewritten; `normalizeLead` passes any stored name through).
- Code.gs `CREATE_LEAD_ASSIGNEES` (the Therapists alumnus → lead allow-list): the current three
  first, the two legacy names still ACCEPTED (append-only) so an older Therapists build that still
  sends them is not downgraded to blank. Follow-up in ezone-therapists: offer דנה / סנדרה there.
- Login records: unchanged here — Shiran / Yael are retired by setting `"status": "revoked"` on
  their `USER_PIN_HASHES` records (DEPLOY.md, Phase 2a); their `USER_MODEL` entries stay so a live
  revoked record keeps validating.

Tests: `test/assignees-dana.test.js` (+2: list parity classic / CRM, Code.gs allow-list), two
expectations updated. Files: `public/app.js`, `apps-script/Code.gs`, tests, ESS.
