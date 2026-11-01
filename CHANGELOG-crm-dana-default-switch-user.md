# CHANGELOG — Dana on the CRM without collections + «החלפת משתמש» — 2026-11-01

Branch `claude/determined-wozniak-sgvol0` → base `claude/build-ezone-dashboard-QOg5s`.
Code.gs untouched (no Apps Script deploy). SW `CACHE_VERSION` v106 → **v107** (from the live v106).

## 1. Dana lands on the CRM, with no collections
- **Routing — already live, verified, unchanged.** `lib/crm-shell-flag.js` `CRM_DEFAULT_VIEWS = ['full', 'ops']`
  (PR #327, `CHANGELOG-crm-default-ops.md`): with `CRM_ENABLED` + `CRM_DEFAULT`, Dana / Vered / Sandra get the
  CRM at `/`, Ortal the classic page, and `/?view=classic` is classic for everyone. New tests pin it again.
- **Dana's role is operational, not read-only.** PR #303 made her read-only; CRM Stage 1b
  (`CHANGELOG-crm-tasks-contact-log.md`, spec §2: «לדנה יש הרשאה תפעולית מלאה … הכסף מוחרג») replaced that.
  This PR keeps the spec decision: her operational writes (leads, admission, patient edit / move / discharge,
  tasks, contact log) stay; **everything money stays closed**. Turning her back to read-only is a one-rule
  follow-up if Sandra wants it — see the PR.
- **UI:** no «גבייה» area (`areasFor`, unchanged) and now **no «חשבון» tab or pane** in the patient drawer
  (`accountTabVisible(me)`: finance or the controller's read access only; never the ops view). With the area
  and the pane gone, none of the money write controls («דווח תשלום», discount, «שנה סכום», credits,
  «סמן כשולם», receipt edit / void, payment linking) can render for her.
- **Server — audited, nothing missing.** Every money action the CRM calls (`getPayments, debtAging,
  getCredits, billingControlQueue, reportPayment, savePayment, setBillingDiscount, upsertBillingOverride,
  settleRefund, editReceipt, appendFunder`), every `FINANCE_ACTIONS` entry, `confirmPayment`,
  `voidUnpaidClaim`, the money exports and the debug stores already answer her session **403 + a Hebrew
  message** before the proxy (`lib/finance-scope.js`, `lib/role-scope.js`); Code.gs refuses them again and
  projects her getData / Activity / Tasks. A new test enumerates them (GET and POST) so a new money route
  cannot slip past.

## 2. «החלפת משתמש» (CRM + classic)
- **Header:** the current user's name + a «החלפת משתמש» button — CRM `#crm-switch-user` (the name now
  also shows on phones), classic `#switch-user` inside `#whoami` (replaces the small «החלף» link).
  RTL, ≥ 44px tap target, wraps at 360px without horizontal scroll. The name is HTML-escaped on the
  server (`__USER__`) and set as text in the page.
- **Server logout ends the session:** `POST /api/logout` (existing route) now **revokes the token**
  (`lib/session-revocation.js`: in-memory, SHA-256 key, kept until the token's own expiry, bounded
  10 000) and expires the cookie. Every session check (`readLiveSession`) refuses a revoked token → the
  old cookie gets **401** everywhere. **Same-origin check** (new `isSameOriginRequest`: `Sec-Fetch-Site`
  must be same-origin / none, `Origin` must match the host) → 403 `forbidden_origin` otherwise; the
  session cookie is also `SameSite=Strict`. Logged as `[logout] session ended user=<id>` — no name, PIN
  or token.
- **Client:** after the logout the page empties its data (CRM state, areas, drawer, header name; classic
  screens), forgets the remembered login name, deletes the offline copies of `/` from the service-worker
  cache, and goes to `/` → the PIN screen. «יציאה» (classic) does the same but keeps the remembered name.
- **Next login lands on that user's default:** `/api/me` gains `landing: 'crm' | 'classic'` (the same
  `serveCrmShell` rule as `/`); after a PIN login the classic page reloads into the CRM when
  `landing === 'crm'` (unless the URL says `?view=classic`) — `loginShouldReload`.

## Tests (`npm test`)
- `test/crm-dana-default-switch-user.test.js` (10): routing per user + `?view=classic` + `landing`;
  Dana 403 + Hebrew on every money action / route (GET + POST), nothing proxied, operational getData
  still projected; no «גבייה» / «חשבון» for her; logout → old cookie 401 on `/api/me`, `/api/sheets`,
  exports, `/` = PIN page, other sessions untouched; cross-origin logout 403 and nothing revoked; no PIN /
  token / name in the logs; the revocation store; the header controls; `clearCachedPages`; the login rule.
- `test/crm-switch-user-browser.test.js` (1, real Chromium at 360px): Vered (CRM, «גבייה» open) →
  «החלפת משתמש» → PIN screen with none of her data, old cookie 401 → Dana's PIN → CRM, her name, no
  «גבייה» / «חשבון», no money read, none of Vered's figures → Ortal → classic → name list; 44px, no
  horizontal scroll.
- Updated: `/api/me` deep-equals (+`landing`), the whoami text («החלפת משתמש»), SW v107 guards.

## Security
No secrets or PII in code or logs; fail-closed (a revoked or unknown token → 401); logout is POST +
same-origin; the name is escaped / a text node; `npm audit`: 0 high / critical.

## Limits
The revocation list is per process and in memory: a restart forgets it. The browser's cookie is cleared
at logout anyway, so this only matters for a copied token, which then lives until its normal 7-day expiry.

## Files
`server.js`, `lib/session-revocation.js` (new), `public/app.js`, `public/style.css`, `public/crm/crm.js`,
`public/crm/crm.html`, `public/crm/crm.css`, `public/sw.js`, tests above, `DEPLOY.md`,
`EZONE-ECOSYSTEM-STATUS.md`. Rollback: revert (no data, sheet or variable change).
