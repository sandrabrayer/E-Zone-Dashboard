# Shiran removed from the name list (no longer works at E-ZONE)

Sandra, 15/11/2026. Server only; no Code.gs change.

`lib/users.js`: Shiran's model line carries `former: true` →
- she is not in the name list (the login screen, which is also what
  «החלפת משתמש» shows);
- a new login as her is refused (`server.js`) with the same generic answer as a
  wrong code — whatever her live record says.

Her model line and her `USER_PIN_HASHES` record are kept on purpose: removing
the line would make the server refuse the whole variable at startup.

**Left for Sandra (Railway, recommended):** in the `USER_PIN_HASHES` variable
change Shiran's record from `"status":"active"` to `"status":"revoked"`. That
also ends a session she may still hold on a device.

Security: fail-closed refusal; no secret touched. `npm audit`: 0 high/critical.

Files: `lib/users.js`, `server.js`, `test/personal-pins-login.test.js` and
`test/personal-pins-login-browser.test.js` (the active example user is now
Yael; new test for the former-employee rule), `EZONE-ECOSYSTEM-STATUS.md`.
