# Acceptance-audit candidate — 6 November 2026

Prepared on `5349d75c0bf40ea276429ab3ff78a7470b968697` in isolated local branch
`codex/crm-audit-workflows-20261106`. Scope: R3 collection responsibility,
R4 cancellation follow-up, R7 exact control-card lists. Implementation details:
`CHANGELOG-crm-audit-workflows.md`.

No source financial amounts, patient records, stored tasks, permissions,
server endpoints or Apps Script code changed. No new issue or PR was opened.
The local candidate does not claim these corrections are already active.

## Validation

- `node --test test/crm-audit-workflows.test.js`: 7 pass, 0 fail.
- Initial `npm test`: 3,843 total, **3,713 pass, 0 fail, 130 skipped** before
  browser tooling was installed. Real browser validation is recorded below.
- Against the unmodified base source, the same focused suite yields 1 pass and
  6 expected failures: responsibility and cancellation regressions reproduce,
  and the exact control-list capability is absent. Candidate source was not
  replaced during this negative control (read interception only).
- `npm audit`: zero high/critical, one existing moderate transitive `qs` advisory.
  Dependencies were not changed in this narrowly approved batch.
- Real-browser focused acceptance passes at 1366px and 390px on the existing
  synthetic fixture. No production-write or native Google-runtime acceptance
  is claimed. Production remains read-only.
- `git diff --check` passes. The deployment branch still points to the stated
  base at the final read-only check.

Final full run with Chromium: **3,845 pass, 0 fail, 0 skipped**, including
132 browser cases. The companion Outpatient candidate passes all 2,235 tests,
including 75 browser cases. Combined: 6,080 pass, including 207 browser cases.
The prior empty-cohort export failure and fixture render race were corrected
in the test only; see the changelog. All original export assertions remain.

Reproduction uses isolated Playwright 1.51.1 / Chromium 134 headless shell,
outside the app dependency tree:

```sh
NODE_PATH=<isolated-tooling>/node_modules \
CHROMIUM_PATH=<chromium-headless-shell-executable> \
EZONE_CHROMIUM=<chromium-headless-shell-executable> \
node --test --test-concurrency=4
```

Use Chromium's headless-shell executable in environments that restrict desktop
Chrome's process-singleton IPC. No sandbox permissions or source app settings
were relaxed. These checks use local synthetic services, never production.

## Release gate

Review this delta alongside Dashboard #339 / E-ZONE One #331; do not create a
second task for it. Recheck the deployment head and SW version before integration
if other development advances. Obtain separate approval before merge/deploy;
synthetic browser acceptance is now complete. No Google deployment is needed for this
Dashboard-only browser change.

Measure after approved release: collection rows lost by owner filtering = 0;
cancelled active leads with no visible next action = 0; unread-report count and
opened-list length agree in 100% of sampled cases. These are targets, not measured
production improvements.
