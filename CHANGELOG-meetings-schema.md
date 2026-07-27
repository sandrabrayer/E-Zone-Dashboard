# Add `meetingWith` lead column and `HOUSE_MANAGERS` roster

Schema-only groundwork for lead meetings. Adds a `meetingWith` field to the
lead schema and a `HOUSE_MANAGERS` roster mapping each house to its manager
name. **No UI change** — no dropdown, nothing rendered. This lands the data
plumbing so a later change can surface it.

## What changed

### Backend — `apps-script/Code.gs`

- Appended `'meetingWith'` as the **last** entry of `LEAD_COLUMNS`. This is an
  **append-only** change: `readSheet_` maps sheet cells to keys **by position**,
  so existing columns must not be reordered or inserted mid-array. Because
  `IRRELEVANT_LEAD_COLUMNS` and `REMOVED_LEAD_COLUMNS` derive from
  `LEAD_COLUMNS.concat([...metadata])`, the new column is automatically present
  in both mirror sheets, positioned before their metadata fields.
- No write-path change was needed: `objectToRow_(merged, LEAD_COLUMNS)` projects
  onto the column list and defaults any missing key to `''`, so pre-existing
  rows write a blank `meetingWith` cell with **no backfill**.
- Added `HOUSE_MANAGERS`, keyed by patients-sheet house id (**names only, no
  phone numbers**):

  | house id | manager |
  | -------- | ------- |
  | `arfoni` | חנן     |
  | `rehab`  | רנטה    |
  | `asher`  | עידו    |
  | `ramot`  | אורן    |

- `getData_` now returns `houseManagers: HOUSE_MANAGERS` so the frontend can
  read the roster without a second round-trip.

> Note: lead normalization (`normalizeLead`) lives in the **frontend**
> (`public/app.js`), not in `Code.gs`. The Code.gs changes are the column
> append and the roster constant/export above.

### Frontend — `public/app.js`

- `normalizeLead` now reads `meetingWith` via the existing defensive `pickField`
  pattern (`['meetingWith', 'meeting_with', 'נפגש עם']`), defaulting to `''`
  when absent — matching the `assignedTo` / `originSheet` pass-through idiom, so
  existing leads stay present-but-blank. Nothing else in the UI reads or renders
  the field.

### Tests — `test/lead-meetingwith-schema.test.js`

- Asserts `LEAD_COLUMNS` keeps its existing columns in the same order and that
  `meetingWith` is the **last** column (append-only contract).
- Asserts `normalizeLead` defaults `meetingWith` to present-but-blank `''` on
  legacy rows (and carries a value through when present).
- Asserts `HOUSE_MANAGERS` covers **exactly** the four house keys and no others.
- Uses the repo's `node --test` harness and the same vm-sandbox load pattern as
  `lead-assignedto.test.js` (app.js) and `admitted-roster.test.js` (Code.gs).

## Not included

- **No UI.** No dropdown, no card rendering, no add-lead form field. This is
  schema + roster plumbing only.
- **No backfill** of existing leads — they remain blank by design.
- **No Apps Script deploy.** The dual deploy is handled manually after merge.
