# Browser tests wait for the write to reach the stub server (test-only)

## Known flake (fixed here)

`test/duplicate-payment-void-browser.test.js` failed now and then with
`Cannot read properties of undefined (reading 'payment')`. The cause was in
the test, not the app: `savePayment` updates `state.payments` **optimistically**,
before the POST has gone out. The test waited on that state change
(`page.waitForFunction(... status === 'void')`) and then read the stub
server's `state.posts` straight away. On a slow run the request had not
reached the server yet, so the log was empty.

## The fix

Each affected file gets a small `waitForSaves(state, n)` helper. It polls
the server's own POST log until at least `n` `savePayment` bodies have
arrived, or fails with a clear message after 5 s. The asserts read the log
only after that wait.

| File | Sites |
|---|---|
| `test/duplicate-payment-void-browser.test.js` | void confirm (1 write), Sandra's un-void (2 writes) |
| `test/detached-payments-browser.test.js` | link, "not a patient", backfill |
| `test/payment-coverage-period-browser.test.js` | period edit |

No runtime file changed (`public/app.js`, `server.js` and `apps-script/` were
not touched).

I checked the rest of the `*-browser.test.js` files for the same pattern.
None of them needed a change:

- `coordinators-roster`: the intake form closes only after the round trip,
  and the `appendFunder` check already polls. A forced 300 ms request delay
  still passes on the old code.
- `debt-aging-ui` and `billing-tab-section-colors`: the wait is on DOM that
  is built from the server's response, so the request had already been
  logged.
- `payment-coverage-period` reset: it already waits on the post-round-trip
  re-render (see the comment in that test).
- The `nothing sent` assertions in `billing-control-tab`,
  `ortal-verification-status` and `payment-report-form` assert that a log
  is empty. They are not affected.

## Proof

- **Forced race:** a temporary `page.route('**/api/**')` that holds every
  API request for 300 ms (not committed). On the old code it fails 2/6 tests
  in duplicate-payment-void (the same `reading 'payment'` error), 3/5 in
  detached-payments and 1/7 in payment-coverage-period. With the fix every
  file passes.
- **Repetition:** `duplicate-payment-void-browser.test.js` ran 20 times in a
  row with 6/6 passing and 0 skipped each time. The other two fixed files
  also ran 20 times each, all green.
- **Full suite:** `npm test` ran twice, all green, with the browser suites
  running (Playwright + `/opt/pw-browsers/chromium`).
