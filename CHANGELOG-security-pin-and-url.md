# Security: move the edit PIN and the Apps Script URL out of source

## What

Two secrets that were hardcoded in the codebase are now read from environment
variables and, in the PIN's case, verified entirely server-side.

### A. Apps Script `/exec` URL (`server.js`)

- The `SHEETS_URL` constant no longer contains a literal
  `https://script.google.com/macros/s/.../exec` value.
- It is now `process.env.SHEETS_URL || ''`.
- If `SHEETS_URL` is unset the server logs a `console.error` at startup and
  every `/api/sheets` call fails-closed (an empty URL cannot be reached) rather
  than silently talking to the old, now-public deployment.

### B. Edit PIN (`lib/pin.js`, `server.js`, `public/app.js`)

- The edit PIN was compared in the browser (`public/app.js` `tryPin()`
  checked `input.value === '2107'`), which shipped the PIN to every visitor.
  That literal is removed entirely.
- New `lib/pin.js` exports `checkPin(candidate, expected)`:
  - constant-time via `crypto.timingSafeEqual` over SHA-256 digests (length of
    the comparison is independent of the inputs);
  - fail-closed — any empty or non-string argument returns `false`, so an unset
    PIN can never match.
- `server.js` reads `APP_PIN` from the environment (`console.warn` if unset)
  and exposes `POST /api/verify-pin`:
  - rate-limited to **10 attempts per 15 minutes per client IP**;
  - `200 { ok: true }` on a match, and that IP's attempt counter is reset;
  - `401 { ok: false, error: 'invalid_pin' }` on a mismatch (counts against
    the limit);
  - `429 { ok: false, error: 'rate_limited' }` with a `Retry-After` header once
    the window is exhausted.
- `public/app.js` `tryPin()` is now an async `fetch` to `/api/verify-pin`; the
  submit button is disabled while the request is in flight, and edit mode is
  entered only on a `200`.

## Why

Both values were readable by anyone with the client bundle or the git history:
the PIN was in the served JavaScript, and the Apps Script URL was in
`server.js`. Moving them to env vars and verifying the PIN server-side removes
them from anything the browser or a repository clone can see.

## Tests

- New `test/pin.test.js` (`node:test`) covers `checkPin`: match, mismatch,
  differing length, fail-closed on an unset (empty) PIN, empty candidate, and
  non-string inputs on both sides. It uses a throwaway test PIN, never the
  retired value.
- The existing suite (~93 tests) stays green.

## Deploy steps (required — old values are burned in git history)

The previous PIN and Apps Script URL are permanently visible in the git
history and must be treated as compromised. Rotate both:

1. **Issue a NEW edit PIN** and set it as the `APP_PIN` environment variable on
   the host (Railway). Do not reuse the old value.
2. **Create a NEW Apps Script deployment** (new deployment → new `/exec` URL)
   and set that URL as the `SHEETS_URL` environment variable. Do not reuse the
   old deployment URL — it is public.
3. Redeploy. Until both env vars are set, `/api/sheets` calls fail-closed and
   edit-mode PIN verification rejects every attempt (by design).
