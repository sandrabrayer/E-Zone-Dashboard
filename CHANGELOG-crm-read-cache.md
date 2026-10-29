# CHANGELOG — Server read cache (speed) + «מטופלים» in the Monday look

Date: 2026-10-29 · Branch `claude/read-cache-clients-look` → base `claude/build-ezone-dashboard-QOg5s`
Sandra: «האפליקציה איטית מאוד, גם נתוני גבייה ובקרה» · «גם את הלשונית הזו תשנה באותו האופן».

## 1. Speed — a 30-second read-through cache in the server (`lib/read-cache.js`)

Apps Script is the slow part (2–8 s per read); every CRM area re-asked it. Now a READ answered in
the last 30 s for the **same key** is served from Railway's memory, and two identical reads in
flight share **one** upstream call.

- Cached actions: `getData, getTasks, contactIndex, getActivity, debtAging, getPayments,
  getCredits, billingControlQueue, expectedDischarges, upcomingCommittees, refundPayoutForecast,
  cleanupReport`. **Writes are never cached.**
- Key = the whole upstream body **minus the secret**: action, every parameter and the verified
  actor (id, auth, roles, caps). Dana's money-less `getData` and Ortal's money-only tasks can never
  be served to anyone else.
- **Every write through this server busts the whole cache** (`POST /api/sheets`,
  `/api/outpatient-lead`, `/api/meeting-report/submit`) — nobody re-reads a stale answer after a
  save. Failures are never cached. A write made by *another app* directly in Sheets can be up to
  30 s late on the CRM — acceptable (the classic page polls slower than that).
- `SHEETS_READ_CACHE_MS` (optional Railway variable): tune the TTL; `0` disables. **Nothing to
  set** for the default.
- Effect: switching areas, the second tab, «גבייה» after «היום שלי» (debt + payments already in
  memory), every re-render after a task write → one upstream round-trip instead of 3–6.

## 2. «מטופלים» tab + the card head (Monday look)

- Table: bold name, **house tag** with a per-house colour stripe, **status as a word** in a filled
  label (פעיל / תקופת ניסיון / בהמתנה — never the raw `active`), entry date, days in house,
  **open tasks** count, **last documented contact**, «תיעוד שיחה» + «כרטיס» in the row.
- Card head: status / stage, house tag and owner avatar as labels; the patient overview reads
  «הגיע/ה: מפנייה / הוספה ישירה», the original inquiry by name (never a raw lead id), days in
  house next to the entry date.

## Files

- `lib/read-cache.js` (new), `server.js` (`READ_CACHE`, `sheetsGet`, three bust points),
  `public/crm/crm.js`, `public/crm/crm.css`, `public/sw.js` (v103).
- Tests: `test/read-cache.test.js` (3: rules, single flight / expiry / bust, server wiring),
  browser assertions for the clients tab; SW guards.

## Security

The cache key carries the verified actor, so scope never leaks between users; the secret is not
part of the key and never stored; a cached answer is the same bytes the same actor would have
received. `npm audit`: 0 high / critical.
