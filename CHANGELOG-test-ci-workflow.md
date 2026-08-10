# CI: GitHub Actions test workflow (`npm test` on every PR + deploy-branch push)

## Read-only review (done first)

- **Deploy branch confirmed:** `claude/build-ezone-dashboard-QOg5s` — hardcoded
  in `deploy-apps-script.yml` and documented in `EZONE-ECOSYSTEM-STATUS.md`.
  **This repo has no `main` branch**; the workflow never references one.
- **Existing workflows:** `deploy-apps-script.yml` (clasp deploy — untouched)
  and `validate-workflows.yml` (YAML sanity on workflow changes — it will
  validate the new file automatically).
- **Core-path coverage check:** the auth gate is already covered
  (`api-auth.test.js`). The **`getData_` feed had no direct test** — only
  indirect exercise — so the permitted minimal test was added (below). No
  winback tests (that code is not on HEAD).

## What changed

### `.github/workflows/test.yml` (new)

- Triggers: **every `pull_request`** + **push to
  `claude/build-ezone-dashboard-QOg5s`**.
- Steps: `actions/checkout@v5` → `actions/setup-node@v5` (Node 22, npm cache,
  matching the repo's existing toolchain) → `npm ci` → `npm test`
  (`node --test`).
- `permissions: contents: read`; concurrency group cancels superseded runs on
  the same ref. **No secrets needed** — the suite is fully mocked
  (vm-sandboxed `Code.gs`/`app.js`, `server.js` helpers), no live calls.
- The clasp deploy workflow is not touched, gated, or referenced.

### `test/getdata-feed.test.js` (new — the one permitted minimal addition)

Locks the `getData_` response contract both consumers (Dashboard +
ezone-managers) depend on: full key set
(`ok, leads, patients, irrelevantLeads, removedLeads, dischargedPatients,
billingOverrides, houseManagers, managerPhones`) on a fresh empty spreadsheet;
patients grouped by `houseId`; leads passed through with clean `visitTime`
intact; rows with trailing blank columns not dropped. 3 tests.

## Tests

Full suite: `npm test` — **428 pass, 0 fail** (425 + 3 new; nothing else
added, no framework, no test changes).

## What a green check means (exactly)

A green **Tests** check on a PR or on the deploy branch means: **on a clean
Ubuntu runner with Node 22, `npm ci` succeeded and all ~428 `node --test`
tests passed** — i.e. the vm-sandboxed contracts over `apps-script/Code.gs`
(column orders, write semantics, digest/feed shapes incl. `getData_`),
`public/app.js` (normalizers, billing/renewal/restore logic, modal routing),
and `server.js` (session-auth gate, diagnostics, redaction) all hold for that
commit. It does **not** mean: the Apps Script deployed (that's the separate
clasp workflow), Railway deployed, live Sheets data is healthy, or any
end-to-end network path works — the suite is fully mocked by design.
