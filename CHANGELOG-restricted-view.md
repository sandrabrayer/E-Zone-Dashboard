# Restricted view for Shiran and Yael (the `finance` capability)

Decided by Sandra on 2026-10-03. Plan: `docs/billing-control-plan.md` §11.5
(new row 7). Builds on personal PINs (#162, #168). Branch
`feat/restricted-view-shiran-yael` → base `claude/build-ezone-dashboard-QOg5s`.
`apps-script/Code.gs` changes in its own commit (clasp CI deploys it on
merge). Service worker `CACHE_VERSION` v26 → **v27**.

**Sandra needs to do nothing in Railway.** No new variable, and no change to
`USER_PIN_HASHES`: the capability comes from the stable user id, so the live
Sandra and Vered lines keep full access exactly as pasted.

## Who sees what

| Session | View |
|---|---|
| **Sandra, Vered** (personal code) | Unchanged: every tab. |
| **Shiran, Yael** (personal code) | Every tab **except** גבייה, הכנסות חודשיות, שיוך תשלומים and גרף צמיחה, and no billing widget anywhere. They edit what they see as staff, and still cannot delete: delete enforcement is still the later PR, as already modelled. |
| **Shared `APP_PIN`** (dual window) | Unchanged: every tab, as before, so nobody is cut off before they have a code. It ends with the window anyway. |

## The map (read-only investigation, 2026-10-03)

### The four tabs → server actions and routes

| Tab | Reads | Writes |
|---|---|---|
| **גבייה** (`screen-billing`) | `getPayments`, `getCredits`, the getData key `billingOverrides`, `refundPayoutForecast` («זיכויים ממתינים לתשלום»), `debtAging` («חובות פתוחים»); `/api/export/refund-forecast.xlsx`, `/api/export/debt-aging.xlsx` | `savePayment` (a row, the coverage period), `upsertBillingOverride` / `deleteBillingOverride` («סכום חודשי») |
| **הכנסות חודשיות** (`screen-revenue`) | computed in the browser from `getPayments` + `getCredits` + `billingOverrides` | — |
| **שיוך תשלומים** (`screen-reconnect`) | `getPayments` (detached payments, duplicates, voided) | `savePayment` (linking, «לא מטופל», duplicate void, un-void = Sandra) |
| **גרף צמיחה** (`screen-growth`) | computed from `getPayments` + `getCredits` + `billingOverrides` (`revMoney`) | — |

### Billing used OUTSIDE the four tabs

| Where | What | Restricted session |
|---|---|---|
| **דשבורד** — «חידושי תפוסה» renewal alert (`#renewal-alert`) | `getPayments` + `billingOverrides`; writes `savePayment` (חידוש) | **removed** |
| **דשבורד** — «מטופלים ממתינים לתשלום» strip (`#overdue-alert`, links to גבייה) | `getPayments` + `billingOverrides` | **removed** |
| **מטופלים משוחררים** — the «זיכויים (N)» button on every row | `getCredits`; opens the credits modal → `suggestRefunds`, `saveCredit` | **removed** («שחזר» stays) |
| **The discharge flow** — the credits / refund modal after a discharge | `suggestRefunds`, `saveCredit`, `getCredits` | **skipped**. The discharge itself is unchanged. Sandra or Vered create the refund later from מטופלים משוחררים → «זיכויים». |
| `loadAll` | `getPayments`, `getCredits` on every load | **not requested** |
| `/api/debug/last-save`, `/api/debug/last-load` | the last request and response previews, which can be a `getPayments` answer loaded by Sandra | **403** |

### In getData

- `billingOverrides` is the only billing-only key. The tabs that read it are
  גבייה, הכנסות חודשיות and גרף צמיחה, plus the two dashboard widgets above.
  No tab a restricted session can see reads it, so **it is omitted for
  Shiran and Yael**. Every key stays for full view.
- The patient fields `pay` / `adv` (and the lead `advance`) are kept, because
  visible tabs need them: תפוסה (the patient cards), נקודת איזון, the
  דשבורד KPI «הכנסות חודשיות», and לידים. See "Choices I made" 1.

### Also mapped, and blocked for completeness

`updatePayment` (an alias of `savePayment`) and `accountingPayments` /
`accountingCredits` (the accounting feed). The feed has its own secret and
no dashboard UI. It keeps working, because its caller is not the proxy.

## What changed

### `lib/`

- **`lib/users.js`:**
  - `FINANCE_USER_IDS = ['vered', 'sandra']`.
  - `principalCapabilities(principal)` and `hasFinance(principal)`.
  - A shared session gets `['finance']` (dual window). A personal session is
    judged **by stable id only**: a record's roles cannot narrow it, and
    `USER_PIN_HASHES` has no field that could grant it (an extra key is a
    startup failure).
- **New: `lib/finance-scope.js`.** The single list of the mapped actions and
  routes (`FINANCE_ACTIONS`, `FINANCE_ROUTES`), plus `GETDATA_FINANCE_KEYS`,
  the Hebrew message and `stripFinanceKeys`.

### `server.js` — the real lock

- **`requireFinanceForAction`** on GET and POST `/api/sheets`.
  - It runs after `requireSession` and before anything is proxied.
  - Any `FINANCE_ACTIONS` action from a session without `finance` gets:
    **`403 {ok:false, error:'forbidden', message:'אין הרשאה לצפות בנתוני גבייה'}`**.
- **`requireFinance`** on `/api/export/refund-forecast.xlsx`,
  `/api/export/debt-aging.xlsx`, `/api/debug/last-save` and
  `/api/debug/last-load`.
- **Logging:** each refusal is logged as
  `[finance] 403 user=<id> action=<name>` (or `route=<path>`). The user id and
  the action only, never data.
- **getData** (GET or POST) for a restricted session drops
  `GETDATA_FINANCE_KEYS`.
- **`proxyCaps`** (`['finance']` or `[]`) is sent to Apps Script from the
  session only. A client-sent copy is dropped, like the other proxy-owned
  fields.
- **`/api/me`** adds `finance: true|false`.
- **`index.html`** is served with `<body class="view-restricted">` to a
  restricted session, so the money tabs never paint, not even for a moment.

### `apps-script/Code.gs` — the second lock (own commit)

- **The lists:** `FINANCE_ACTIONS`, `FINANCE_USER_IDS` and
  `GETDATA_FINANCE_KEYS`, pinned equal to `lib/` by a test.
- **`proxyCaps`** joins `PROXY_ONLY_FIELDS`. It is stripped by `proxyGate_`
  and by `collectParams_`.
- **The actor gains `caps`, derived here:**
  - Code.gs computes the capability itself from `proxyAuth` + `proxyUserId`
    (shared → finance; personal → by id).
  - It then **intersects** that with the server's `proxyCaps`. So a buggy or
    forged `proxyCaps` cannot widen it, and the server can only narrow it.
  - A verified proxy body without `proxyAuth` (a server older than PR A) is a
    legacy full-view caller.
- **`handle_`** refuses every `FINANCE_ACTIONS` action for a verified actor
  without `finance`: `{ok:false, error:'forbidden', message}`, before anything
  is read or written.
  - A call without a valid `PROXY_SECRET` has no actor, so it is not refused
    *here*. Enforce mode (live) already refuses it at the gate, and the
    accounting feed keeps working.
- **getData** for a restricted actor omits `billingOverrides`. Every key stays
  for full view.
- New helpers: `actorCaps_`, `hasCapability_`, `financeRefused_`,
  `getDataForActor_`.

### Client (`public/index.html`, `public/app.js`, `public/style.css`)

- **`data-finance` tags** mark the four tab buttons, their four `<section>`s,
  `#renewal-alert` and `#overdue-alert`: 10 elements in all.
- **For a restricted session, `applyView(false)`:**
  - **removes them from the DOM.** They are not only hidden.
  - clears any billing data in memory
  - moves off a money tab
- **When the view is known:**
  - on a page load, at startup, from the server's `body.view-restricted`
  - after a login, before the app is revealed

  Either way `loadAll` never asks for `getPayments` / `getCredits`.
- **Deep links:** `#billing` (or `#screen-billing`) and a current tab pointing
  at a money tab **fall back to the first allowed tab** (דשבורד). For full view
  the deep link opens that tab. Note: no deep link or remembered tab existed
  before this PR (verified); the fallback covers the new hash handling and
  `state.currentScreen`.
- **The billing renders are no-ops** for a restricted session: renewal,
  overdue, גבייה, payouts, the forecast load, הכנסות חודשיות, שיוך תשלומים,
  גרף צמיחה.
- **Guarded:** the «זיכויים» button and the post-discharge credits modal.
- **A full-view login on a page that a restricted session already pruned**
  reloads to get the tabs back.
- **Service worker** v26 → v27.

## Tests

- **New: `test/restricted-view.test.js`**, 19 tests:
  - **The model:** finance by id, shared = full, and no record field can
    grant it.
  - **Live-shaped Sandra and Vered records** (exactly the `recordLine` output,
    and Vered narrowed to `['staff']`) keep full access.
  - **Every mapped action → 403 for Shiran and Yael**, GET and POST:
    - nothing is proxied
    - the log has the id and the action only, no data
  - **Every mapped action → 200 for Vered, Sandra and a shared session inside
    the window**, and each is proxied.
  - **Every mapped route → 403 for Shiran and Yael.** For full-view sessions
    it passes the gate.
  - Non-billing work (getData, saveAll, discharge, leads) is unchanged for
    them.
  - **getData:** no `billingOverrides` for a restricted session, every key for
    full view (GET and POST).
  - `proxyCaps` comes from the session only.
  - `body.view-restricted` is served only to a restricted session.
  - A shared cookie after the window still gets 401.
  - **Code.gs:**
    - the lists are equal to `lib/`
    - **it refuses every mapped action for a verified Shiran or Yael, even with
      a forged `proxyCaps`**, in log and enforce mode, and nothing is written
    - it serves Vered, Sandra, a shared session and a legacy proxy body
    - the server can narrow (an empty `proxyCaps` → refused)
    - the meeting-report principal has no finance
    - getData keys per actor
  - **Client:**
    - **exactly 7 tabs for Shiran and Yael, all 11 for full view**
    - **a deep link falls back**
    - `applyView` removes the nodes
    - every billing render is a no-op
    - no billing leaks (the `loadAll`, «זיכויים» and discharge guards; exactly
      10 tagged elements)
  - SW v27.
- **New: `test/restricted-view-browser.test.js`**, real Chromium at 360px:
  - **Shiran** opens on `#billing`:
    - exactly 7 tabs and zero `[data-finance]` nodes; the screens are gone
    - the page fell back to דשבורד
    - no renewal or overdue widget
    - מטופלים משוחררים has «שחזר» and no «זיכויים»
    - the page never requested `getPayments` / `getCredits`
    - a direct `fetch` gets the 403
  - **Vered and a shared session:**
    - all 11 tabs; `#billing` opens גבייה
    - the same data **does** raise the overdue strip for them, so its absence
      for Shiran is the restriction and not empty data
  - Screenshots: `docs/screenshots/restricted-view/`.
- **Updated** (each one pinned exact markup that now carries `data-finance`,
  or the old router line):
  - `test/monthly-revenue.test.js`
  - `test/payment-coverage-period.test.js`
  - `test/personal-pins-login.test.js`: `/api/me` now has `finance`, and the
    SW version is "v26 or later".
- **Full suite: 1914 / 1914** (1894 on the base `9c1b979` + 20 new), with
  every browser test running.
- **A pre-existing intermittent failure:**
  `test/duplicate-payment-void-browser.test.js` («confirming voids the row …»)
  sometimes fails when several Chromium suites run at once.
  - It also fails on the **base** under the same load: 3 of 8 runs, against 1
    of 8 on this branch.
  - It passes alone, and it passed in the final full run.
  - Not changed here.

## Choices I made (ambiguous points — the safest reasonable option)

1. **Patient money fields stay visible:** `pay` / `adv` on patients, the lead
   `advance`, and the **דשבורד KPI «הכנסות חודשיות»** (the sum of the active
   patients' monthly fees). They are patient data, and Sandra kept נקודת
   איזון, which shows the same figure. Removing the KPI is a one-line
   `data-finance` if she wants it gone.
2. **The discharge refund step is skipped** for Shiran and Yael, since credits
   are billing data. The discharge itself works as before. The refund is
   created later by Sandra or Vered from מטופלים משוחררים → «זיכויים».
3. **The dashboard renewal alert and the overdue strip are removed** for them.
   Both are payment data, and the renewal alert writes a payment.
4. **`/api/debug/last-save` and `/api/debug/last-load` need finance.** They can
   hold a response loaded by Sandra.
5. **The accounting feed actions are in the list too**, for completeness. Its
   real caller has its own secret and is not the proxy, so it is unaffected.
6. **Finance is by id, not by role.**
   - It needs no `USER_PIN_HASHES` change, and a record cannot grant it.
   - Ortal has no finance yet (inactive until Phase 4), so Phase 4 decides her
     view.
7. **Code.gs re-derives the capability and intersects it with the server's.**
   A verified proxy body without `proxyAuth` (pre-PR-A) counts as legacy full
   view, so the Apps Script / Railway deploy order on merge cannot cut Sandra
   off.
8. **Code.gs does not refuse unverified callers.** They have no actor; enforce
   mode (live) already refuses them at the gate, and the accounting feed must
   keep working.
9. **An `/api/me` without `finance`** (an older server, test stubs) keeps the
   full view. The live server always sends a boolean, and the server refuses
   the data either way.
10. **The view is applied before the app is revealed:** `body.view-restricted`
    on a page load, and `/api/me` right after a login. A restricted user never
    sees a money tab, not even for a moment.

## For Sandra

**Nothing to do.** No Railway variable and no `USER_PIN_HASHES` change. After
the merge (Railway + the Apps Script CI deploy):

- Shiran and Yael see 7 tabs.
- You and Vered see all 11, exactly as before.
- Anyone still on the shared code during the window also sees all 11.
