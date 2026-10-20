# Changelog — committees come from the coordinators (read-only here) — 2026-10-20

## Why
Sandra (20 Oct 2026, PR 3 of the managers series): committees are set by the **coordinators**
(date, time, type, participants, house), and house managers only view them. This reverses
15 Oct, when managers set a per-patient date here (`ManagersCommittee`). The source of truth moves
to the coordinators app.

## What (Code.gs — isolated commit)
- **New reader `mwCoordinatorsCommittees_()`**:
  - it POSTs `{ action:'getCommitteesForManagers', secret }` to the coordinators Apps Script;
  - two new Script Properties (trimmed, never in code): **`COORDINATORS_SHEETS_URL`** (must be a
    `https://script.google.com/macros/s/…/exec` URL) and **`COORDINATORS_MANAGERS_SECRET`** (= the
    coordinators' `MANAGERS_READ_SECRET`);
  - **fail-closed**: every failure is `{ available:false, reason }`:
    - `not_configured`;
    - `coordinators_not_configured`;
    - `unauthorized`;
    - `unknown_action` (an older coordinators deploy);
    - `unreachable`;
    - `http_error`;
    - `bad_response`;
    - `bad_contract`.
  - **ONE** entry off the exact contract (keys `id, house, date, time, type, participants,
    patientName, updatedAt`, all strings) fails the whole feed. It also fails on a bad house,
    date, time or id, or a length over the limits (type and name 120, participants 300);
  - values are cleaned (formula lead-in, angle brackets);
  - cache: OK answer 5 min, failure 60 s;
  - one log line `[mw] committeesFeed reason=… status=… count=… ms=…`, with no secret, URL or
    name.
- **`houseData`**:
  - new `committees: { available:true, today, items:[{ id, date, time, type, participants,
    patientName }] }`, or `{ available:false, reason }`;
  - it holds the caller's house only, decided by the server; today and later; sorted by date then
    time, untimed last;
  - `committeeSupported:false`, and `patients[].committee` is no longer sent;
  - a feed failure never fails houseData.
- **`managersWork` op `committeeSet` → `{ ok:false, error:'committee_read_only' }`**. Nothing is
  read, locked or written. `mwCommitteeSet_` and `ManagersCommittee` stay as history; the header is
  unchanged (append-only).
- **`upcomingCommittees`** (the dashboard card) now uses the same feed, today to +7.
  - `name` = the patient, or else the committee type;
  - `label` = type · time · participants; `editedAt` = updatedAt, `editedBy` = `''`.
  - Feed down → `available:false` + `reason`, `houses: []`.
- **`getCommitteesForCoordinators`** (legacy): optional `range:'future'` sends every current
  committee dated today or later. It is used once by the coordinators' import. The default
  (today to +3) is unchanged.

## What (frontend)
- `lib/committee-alerts.js`: `dashboardModel` carries `available` / `reason`.
- The card shows «הוועדות לא זמינות כרגע — הנתון מאפליקציית הרכזים לא התקבל» when the feed is
  down, never «אין ועדות».
- New hint «לקריאה בלבד · הוועדות נקבעות באפליקציית הרכזים». The shared fixture is unchanged.
- SW v80 → v81 (live v80).

## Setup
See `DEPLOY.md` → «Committees from the coordinators»:

- coordinators `MANAGERS_READ_SECRET`;
- Dashboard `COORDINATORS_SHEETS_URL` + `COORDINATORS_MANAGERS_SECRET` (same value).

The `script.external_request` scope is already in `appsscript.json`. No Railway variable.

## Order
1. ezone-coordinators PR (the action + the coordinators editor) → its manual «Deploy Apps Script».
2. This PR → automatic Apps Script deploy on merge.
3. Set the three Script Properties.
4. Coordinators editor: `importManagersCommitteesNow(true)` (dry run), then `(false)`.
5. ezone-managers PR (read-only UI).

## Tests
3208 → 3220.

- `test/committees-from-coordinators.test.js` (new, 10):
  - the transport, trimmed properties, `not_configured` with no fetch;
  - every reason, the contract guard, cleaning, the cache, safe logs;
  - houseData house isolation, ordering and down state;
  - `committeeSet` refused, no writes.
- `test/dashboard-committees.test.js`: upcomingCommittees from the feed, and the «לא זמין» state.
- `test/coordinators-committee-feed.test.js`: `range:'future'`.
- `test/managers-committee.test.js`: the HTTP op is refused; the retained function is still
  pinned.
- `test/managers-work-tool.test.js`: no `patients[].committee`.
- SW tests.
