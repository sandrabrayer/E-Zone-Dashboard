# CI fix after PRs #161, #162, #163

**Branch:** `fix/ci-after-161-162-163` → base `claude/build-ezone-dashboard-QOg5s`
**Broken commit:** `318d3ff` (merge of PR #162) — `Tests` workflow (`npm test` = `node --test`):
1822 tests, 1819 pass, **3 fail**, reproducible. Railway skips deploys while CI is red.

## The 3 failures

| # | Test | File:line |
|---|------|-----------|
| 1 | `F: no new endpoint — the link rides the existing savePayment` | `test/detached-payments.test.js:679` |
| 2 | `H: no new endpoint, and nothing here moves money` | `test/duplicate-payment-void.test.js:632` |
| 3 | `H: no new endpoint, and server.js is untouched by this change` | `test/payment-coverage-period.test.js:683` |

All three failed on the same assertion (`assert.deepStrictEqual`):

```
  [
-   "action === 'accountingPayments'",
    "action === 'getPayments'",
    "action === 'savePayment'",
    "action === 'updatePayment'"
  ]
```

i.e. the test **expected** `accountingPayments` among the payment actions of the
`handle_` dispatcher, and **did not find it**.

## Root cause

The three tests did not scan the `handle_` dispatcher; they scanned a fixed
**6000-character prefix** of it:

```js
GS_SRC.slice(GS_SRC.indexOf('function handle_'), GS_SRC.indexOf('function handle_') + 6000)
```

Offset of `action === 'accountingPayments'` from `function handle_` in `apps-script/Code.gs`:

| Commit | Offset | In window? |
|---|---|---|
| before the three PRs (`553b8ab`) | 5695 | yes |
| PR #163 alone (Ortal digest) — no change to `handle_` | 5695 | yes |
| PR #161 alone (debt aging) — adds the `debtAging` dispatch line, +141 | 5836 | yes |
| PR #162 alone (personal PINs) — passes `actorLabel_` / `requestUser_` / `{actor, verified}` into the write calls in `handle_`, +228 | 5923 | yes |
| #163 + #161 + #162 merged (`318d3ff`) | **6064** | **no** |

Each PR passed alone; together #161 + #162 pushed `accountingPayments` (the
READ-only accounting feed from PR #139) past character 6000, so the test stopped
seeing it. #163 contributed nothing to the failure.

**Code.gs is correct** — the dispatcher still has exactly the four payment
actions (`getPayments`, `savePayment`, `updatePayment`, `accountingPayments`)
and nothing was added or removed. The bug was the tests' size assumption, so
**no Code.gs change** was made.

## Fix

In the three tests, the 6000-char window is replaced with the whole `handle_`
function — from `function handle_` to the next top-level `\nfunction ` — the
same pattern 7 other tests in the repo already use (e.g.
`test/audit-log-dedupe.test.js`, `test/occupancy-snapshots.test.js`). An
`assert.ok` now fails loudly if `handle_` can't be located.

The expected list is **unchanged**. This makes the guard **stricter**, not
weaker: the old window could not see an endpoint added after character 6000;
the new one sees the whole dispatcher. Verified by temporarily appending
`if (action === 'evilPayment') ...` to the end of `handle_`: all 3 tests fail
(reverted afterwards). No test was deleted or skipped.

## Verification

`npm ci` then `npm test` (exactly as `.github/workflows/test.yml`), 3 runs in a
row: 1822 tests, 1822 pass, 0 fail each time.
