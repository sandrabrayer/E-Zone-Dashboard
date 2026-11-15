# Independent Dashboard billing update acceptance — 15 November 2026

Baseline: deployed branch `claude/build-ezone-dashboard-QOg5s`, commit `f03a3b7bd38550521edf96f0d6948256ac8b159c`, merged #391/#392. Railway project af74cb91-0ea9-4d1f-918e-2c98055a58f2 / service dfb23ce1-a6d0-4249-b5c4-7ab2c4c45152, production deployment 2773905b-d148-486d-8563-3adecd11d2bb reports SUCCESS at this exact commit. Public URL belongs to this service. No signed-in production access or real payment verification performed.

TESTS/DOCS ONLY, not a release candidate. User requested independent verification of payment verification, debt-until-verified, full/partial/discount kinds, live search, Ortal account scope and nonblank reloads. No runtime, workflow, settings, credentials or patient/payment records changed. No browser subscription or new paid agent launched for this audit.

Original `crm-shell-browser.test.js` preserved byte-for-byte in `.billing-audit-baseline` (blob 0c93df5574853da7831cddb03e87cfc4e70f7a11). The test-only loader appends probes to its existing Chromium workflow without changing CI. Original happy-path browser tests remain; added tests exercise network/ordering failures, server permissions and search navigation. The browser upstream remains synthetic; this does not establish full Google persistence or live account correctness.

GAP tests characterize current faults: a passing GAP means reproduced, NOT fixed. Results pending exact-head CI and artifact inspection.

Review points: (1) missing receipt data must not prove zero pending debt; (2) a billing read started before confirmation must not overwrite the newer confirmation proof; (3) accepted save plus failed readback must visibly mark stale/unconfirmed data and avoid an unqualified old actionable balance; (4) refund search navigation is not implemented like debt/person results; (5) partial verification retains remaining debt despite the generic closed-debt toast. The model also probes inconsistent partial-confirmation/overpayment inputs, but reachability through actual source validation is not established and must not be reported as a live-record defect.

Known design boundary: debt-until-verified is a CRM overlay, not an Apps Script ledger change. Classic screens, exports, due-date collection, forecast AND aging buckets retain old reported-payment netting. The aging difference inside the same overview requires explicit wording/reconciliation; no silent engine-policy migration authorized.
