# Phase 2a — Dana's read-only login — 2026-10-28

Phase 2 of the CRM plan (docs/crm/PERMISSIONS-MATRIX.md D5 / D16; Sandra 2026-10-27:
"דנה מחליפה את יעל ויכולה לראות נתונים אבל לא גבייה"). Code.gs changed (clasp CI deploys on merge).
No SW bump. Nothing changes for anyone until Sandra creates Dana's code (below).

## The rule (decided BY STABLE ID, like `finance` / the controller view)
- `lib/users.js`: new user `dana` («דנה»), roles `['staff']`, active; `READONLY_USER_IDS = ['dana']`,
  `isReadonlyView(p)`, `principalView` → `'readonly'`. No capability. A record can only narrow her.
- `lib/readonly-scope.js` (pure, tested): a read-only session may call ONLY
  `READONLY_GET_ACTIONS = ['getData', 'expectedDischarges', 'upcomingCommittees', 'getActivity']`
  as GET; **every non-GET `/api` request is refused** (403 `forbidden_readonly`,
  «הרשאת צפייה בלבד — אין אפשרות לשנות») except `POST /api/logout`. `readonlyGetDataView` projects
  the one read: the finance-only keys go, and every lead / patient / discharge row loses its money
  fields (`pay`, `adv`, `advance`, `price`) — on the server, so no page ever receives them.
- `server.js`: `requireReadonlyScope` mounted on `/api` right after the body parser (before every
  gate; a non-read-only session passes untouched); `viewFilteredResponse` projects getData;
  `/api/me` adds `readonly: true` and `view: 'readonly'`; the page is served
  `<body class="view-restricted view-readonly">`. Logged with the user id only.
- `apps-script/Code.gs`: the second lock — `READONLY_USER_IDS` / `READONLY_ACTIONS` mirror the
  server (guard test); `viewRefused_` refuses her verified session for any other action before
  any read or write.
- Pages: the classic app stays in `view` mode for her (`readonlyView()` — the same mode the
  controller view uses; `.edit-only` hidden) and keeps the restricted layout (no money tabs).
  The CRM gives her five read areas (היום שלי / פניות / תפוסה / מטופלים / יומן) and hides every
  action (`.crm.readonly`); `CRM_DEFAULT` does not switch her — `/` stays classic, `/?view=crm` works.

## Sandra's one step after the merge
«קוד אישי חדש» (your button) → דנה → paste the line into `USER_PIN_HASHES` in Railway. Until then
Dana is not on the login screen. To retire Shiran and Yael: in the same variable set their records'
`"status"` to `"revoked"` (no code change needed; their model entries stay until a later cleanup PR).

## Tests
`test/readonly-role-dana.test.js` (5): model; scope rule + projection; the REAL server — every
write and every non-read action 403 before the proxy, getData projected, `/api/me`, page class,
Vered / Shiran unchanged, CRM shell for her; the REAL Code.gs second lock + list parity; page hooks.
Existing `/api/me` deep-equals and the user-model / PIN-admin lists updated for the new field and user.

## Files
`lib/users.js`, `lib/readonly-scope.js` (new), `server.js`, `apps-script/Code.gs`, `public/app.js`,
`public/style.css`, `public/crm/crm.js`, `public/crm/crm.css`, tests, `DEPLOY.md`, ESS,
`docs/crm/PERMISSIONS-MATRIX.md`. Rollback: revert (Dana's record then fails startup validation
only if it names a role outside the model — a plain revoke of her line is the safe order).
