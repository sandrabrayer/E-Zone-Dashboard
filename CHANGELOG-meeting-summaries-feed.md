# CHANGELOG — «סיכומי ישיבות» for the Managers app (October 20, 2026)

## What

- `managersWork` op **`meetingSummaries`** `{ month: 'YYYY-MM' }` returns `{ ok, house, month, summaries }`, where `summaries` is one of:
  - `{ available: true, items: [{ id, date, title, attendees, generalNotes, finalizedAt, rows: [{ patientName, weeklyUpdate, goals }] }] }`;
  - `{ available: false, reason }`.
- Source: the coordinators Apps Script's read-only `getMeetingSummariesForManagers`. Only FINAL meetings come back (drafts are typed live).
- The house sent upstream is the **caller's** (`mwCaller_`), decided by the Managers server from the session — never a client value. An invalid month falls back to the current month.

## Safety

- The contract is fail-closed. Any of these makes the answer `bad_contract`, with nothing shown:
  - an extra key, a missing key, a wrong type or an over-long text;
  - a meeting outside the month;
  - a patient id in a row.
- The answer must name the same house and month as the request, otherwise `bad_response`.
- Cache per house + month: 5 minutes when OK, 60 seconds after a failure. «Not configured» is not cached.
- One log line, `[mw] meetingsFeed reason=… status=… count=… ms=…`. It never holds text, a name or the secret.

## Setup

No new Script Property: the committees feed's `COORDINATORS_SHEETS_URL` + `COORDINATORS_MANAGERS_SECRET` are reused (coordinators side: `MANAGERS_READ_SECRET`). The coordinators `Code.gs` must be redeployed first (manual «Deploy Apps Script»).

## Tests

`test/meeting-summaries-feed.test.js`:

- the transport, and that the caller's house is used;
- every refusal reason;
- the contract guard;
- the cache per house + month;
- safe logs.
