# Meetings board — WhatsApp button per row

Adds a **WhatsApp** button to each meetings-board row that opens a pre-filled
message to the meeting's manager (נפגש עם). Builds on the merged meetings board
(PR #53) and the `meetingWith` / `HOUSE_MANAGERS` groundwork.

## What changed

### `apps-script/Code.gs`
- **`MANAGER_PHONES`** (new) — WhatsApp numbers keyed by **manager name**, not
  house, because `meetingWith` stores the name and Vered can override it to any
  manager. Values are E.164 without the `+` (wa.me format):
  חנן → 972527046671, רנטה → 972526765261, עידו → 972524669814, אורן → 972507580152.
- **`managerPhones_()`** (new) — resolves the map, letting a Script Property
  `MANAGER_PHONE_<name>` override each default so a number can be fixed without a
  code deploy. Falls back to the constants (and never throws if
  `PropertiesService` is unavailable).
- **`getData_`** now returns `managerPhones: managerPhones_()`.

### `public/app.js`
- **`state.managerPhones`** (new) — threaded in `loadAll` from
  `data.managerPhones`, same object-guarded pattern as `houseManagers`. Missing
  on older deploys → `{}` (button disabled).
- New pure helpers (map injectable, unit-tested without a DOM):
  - `phoneForManager(name, phones)` — wa.me digits for a manager name; `''` when
    the name is empty or unknown.
  - `meetingWhatsappMessage(m)` — the Hebrew body
    `נקבעה פגישה: <שם>, <בית>, <תאריך>` + ` בשעה <שעה>`, where the time clause is
    **dropped entirely** when the meeting has no time. Date via
    `formatDateDDMMYYYY`; time is already `isoTime`-normalized in
    `meetingsForWeek` (so the Sheets epoch artifact `1899-12-30T07:18:20.000Z`
    renders as `07:18`).
  - `meetingWhatsappUrl(m, phones)` — `https://wa.me/<phone>?text=<encoded>`, or
    `''` when the button must be disabled.
- `meetingsForWeek` now carries each meeting's `date` (the bucket key) so the
  message is self-contained per row.
- `meetingRowHTML` renders a 5th cell: an `<a … target="_blank"
  rel="noopener noreferrer">` when a phone resolves, otherwise a **disabled**
  `<button>` — when `meetingWith` is empty (incl. blank-house leads) or no phone
  resolves for that name, so it never links to nobody. The board stays
  read-only — clicking only opens WhatsApp, never writes.

### `public/style.css`
- `.mtg-row` grid widened to 5 columns; added `.mtg-wa` (link + `[disabled]`
  button share the same box so the column stays aligned).

### Tests — `test/meetings-whatsapp.test.js`
- URL construction for all four managers (correct phone per name).
- The Hebrew message is exact and URL-encodes losslessly (round-trips through
  `decodeURIComponent`; no raw Hebrew/space left in the query).
- No-time variant omits the ` בשעה` clause (message and URL).
- Epoch-artifact `visitTime` renders as `07:18`, end-to-end through
  `meetingsForWeek` into the message.
- Disabled state for empty `meetingWith`, an unknown name, an empty phone map,
  and a blank-house lead.
- Same `node --test` + vm-sandbox pattern as `meetings-board.test.js`.

## Not included
- **No write path** — the board is read-only; the button only opens WhatsApp.
- **No Apps Script deploy** — the `MANAGER_PHONES` / `getData_` change ships in
  Code.gs; the dual deploy is handled manually after merge. Until the Apps
  Script is redeployed, `managerPhones` is absent from the live response and the
  buttons render disabled (fail-safe).
