# The classic page no longer opens for a CRM user who arrives through an outside link (Sandra, 21/11/2026)

Sandra: "on the phone the previous version sometimes still comes up, even though I deleted and
reinstalled" — and, asked which: the **classic** dashboard.

## Cause

Not a cache. The session cookie is `SameSite=Strict` (server.js `buildSessionCookie`). A browser
does **not send** a Strict cookie on a top-level navigation that starts on another site — a link
in the daily reminder mail («פתיחת «היום»»), a link pasted in WhatsApp, a search result. So:

1. the link opens `https://ezone-dashboard.up.railway.app/` **without** the cookie;
2. the server sees no session → `serveCrmShell` is false → it answers with the classic page
   (the same HTML that holds the PIN screen);
3. the classic page starts and calls `/api/me` and `getData` — same-origin requests, which **do**
   carry the cookie — gets 200, and opens the **classic dashboard** for a signed-in CRM user.

Opening from the home-screen icon or a typed address has no "other site", the cookie is sent and
the CRM opens — which is why it was "sometimes", on the phone (where links are the usual way in),
and why reinstalling changed nothing. Reproduced in real Chromium before the fix
(`test/crm-cross-site-landing.test.js`: `localhost` → `127.0.0.1` is cross-site): direct → CRM;
through the link → classic page, `/api/me` 200, classic app visible.

## Fix

`public/app.js`, in the startup check that already reads `/api/me` (`checkSessionUser`): when the
session's `landing` is `crm` (the server's own rule, the one `/` uses) and the URL does not say
`?view=classic`, the page does `location.replace('/')` (or `/?view=crm` when that was asked).
A navigation the page itself starts is same-site, so it carries the cookie and the server answers
with the CRM. `replace` keeps the classic page out of the history.

- **Never a loop:** one hand-over per 30 seconds, kept in `sessionStorage`
  (`ezone:crm-bounce-at`). The CRM clears the marker when it starts, so the next outside link is
  handed over as well; the marker only ever blocks a hand-over that did **not** reach the CRM.
- **Unchanged:** `?view=classic` stays classic (every «בדשבורד הרגיל» link); a session that lands
  on the classic page stays there; a visitor with no session gets the PIN screen as before; the
  login flow is untouched.
- What is still visible: for a moment (one `/api/me` round trip, before any data is drawn) the
  classic frame shows, then the CRM opens.

## Security

- The cookie stays `SameSite=Strict` — the stronger setting was not relaxed to `Lax` to make this
  go away (a test pins it).
- The target is one of two literal same-origin paths (`/`, `/?view=crm`); nothing from the URL is
  concatenated into it (no open redirect).
- The decision uses only `/api/me` of the caller's own session; no new endpoint, no server change.

## Files

- `public/app.js` — `crmBounceTarget` (pure), `bounceToCrm`, one line in `checkSessionUser`.
- `public/crm/crm.js` — clears the marker in `boot`.
- `public/sw.js` — cache **v159 → v160** (from the live v159).

## Tests

`test/crm-cross-site-landing.test.js` (new, 4): the pure rule (targets, stays, the loop window,
corrupt values); source pins (order, literal targets, the shared key, `SameSite=Strict`); real
Chromium + the real server.js — a cross-site link with a Strict cookie ends on the CRM after
exactly two documents and «back» returns to the mail; `?view=classic` stays; `?view=crm` keeps
its query; with `CRM_DEFAULT` off nothing moves; no session → the PIN screen, one document.

## Rollback

Revert the PR (a later SW bump must still be > v160).
