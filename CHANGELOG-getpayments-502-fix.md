# getPayments 502 — diagnostics preview crash in the GET handler

Branch off `claude/build-ezone-dashboard-QOg5s` (Railway deploy branch).
**Server-only fix** — `public/app.js` and `apps-script/Code.gs` are untouched,
so **no Apps Script redeploy** is required. A Railway deploy of `server.js`
ships the fix.

## Symptom

Marking a payment as paid in the גבייה (collection) tab appeared to be lost
after a reload: the tab reloaded to an empty payments list. In the browser
network panel, `GET /api/sheets?action=getPayments` returned **502**
`{ ok:false, error:"sheets_unreachable" }`, and the frontend fell back to
`state.payments = []`.

The underlying data was never lost — it was safe in the Payments sheet the
whole time. Only the read path 502'd.

## Root cause

The `GET /api/sheets` handler in `server.js` builds a `lastLoad` diagnostics
object for **every** action (used by `/api/debug/last-load`). Two of its fields
were built unconditionally:

```js
patientsPreview: data && typeof data === 'object'
  ? JSON.stringify(data.patients).slice(0, 4000)
  : null,
leadsPreview: data && typeof data === 'object'
  ? JSON.stringify(data.leads).slice(0, 1500)
  : null,
```

The getPayments response is `{ ok:true, payments:[...] }` — it has **no**
`patients` or `leads` field. `JSON.stringify(undefined)` returns `undefined`
(not a string), so `.slice()` threw `Cannot read properties of undefined
(reading 'slice')`. The throw was caught by the handler's `catch`, which
returns **502**. So a purely diagnostic preview — data the endpoint doesn't
even need — took down a healthy read.

## Fix

`server.js` only. The preview construction is extracted into a small pure
helper, `buildLoadPreviews(data)`, that guards each field on `!== undefined`
so a missing field yields `null` instead of throwing:

```js
function buildLoadPreviews(data) {
  const isObj = data && typeof data === 'object';
  return {
    patientsPreview: isObj && data.patients !== undefined
      ? JSON.stringify(data.patients).slice(0, 4000)
      : null,
    leadsPreview: isObj && data.leads !== undefined
      ? JSON.stringify(data.leads).slice(0, 1500)
      : null,
  };
}
```

The handler now spreads `...buildLoadPreviews(data)` into `lastLoad`. Behavior
for getData responses is unchanged (both previews still populated and
truncated to 4000 / 1500 chars); getPayments (and any other preview-less
action) now records `null` previews and returns its real payload.

To make the helper testable without opening a socket, `app.listen(PORT, …)` is
now guarded by `if (require.main === module)` and the helper is exported via
`module.exports`. Running `node server.js` (the Procfile `web` process) is
unaffected — it is still the main module, so it still listens.

## Test coverage

New `test/getpayments-502-fix.test.js` (existing `node:test` pattern; requires
the real `buildLoadPreviews` from `server.js`, which no longer listens on
require):

- getPayments-shaped response (`{ok:true, payments:[]}`, no patients/leads) —
  does **not** throw; both previews are `null` (the regression).
- getData-shaped response — both previews are populated and round-trip back to
  the original `patients` / `leads`.
- Oversized inputs — previews truncate to exactly 1500 / 4000 chars.
- Present-but-empty field (`leads:[]`, `patients:{}`) — yields `"[]"` / `"{}"`,
  confirming the guard keys on `undefined`, not on truthiness.
- Non-object responses (`null`, `undefined`, string, number) — `null` previews,
  no throw.

Full suite: **160 tests, 0 failures** (`npm test`).
