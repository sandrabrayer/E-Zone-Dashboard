# Add `assignedTo` (משוייך ל) field to lead entry

Adds a required **"משוייך ל"** (assigned-to) field to lead creation. The owner
is chosen from three fixed options — **ורד / שירן / יעל** — and is shown on the
kanban lead card. Existing leads are **not** backfilled: they stay blank.

## Why

Leads had no owner field, so there was no record of who is responsible for each
lead in the pipeline. This adds that ownership at creation time and surfaces it
on the board.

## What changed

### Backend — `apps-script/Code.gs`

- Appended `'assignedTo'` as the **last** entry of `LEAD_COLUMNS`. Because
  `IRRELEVANT_LEAD_COLUMNS` and `REMOVED_LEAD_COLUMNS` are derived via
  `LEAD_COLUMNS.concat([...metadata])`, the new column is automatically present
  in both mirror sheets — positioned before their metadata fields, so existing
  column order is preserved.
- No write-path change was needed: `mergeLeads_` copies every incoming key into
  `merged` and `objectToRow_(merged, LEAD_COLUMNS)` projects onto the column
  list, defaulting any missing key to `''`. Pre-existing rows therefore write a
  blank `assignedTo` cell with no backfill.

> Note: lead normalization (`normalizeLead`) lives in the **frontend**
> (`public/app.js`), not in `Code.gs`. The only Code.gs change is the column
> append above.

### Frontend — `public/app.js`

- New `ASSIGNEE_OPTIONS = ['ורד', 'שירן', 'יעל']` constant (fixed list, no free
  text).
- `normalizeLead` now reads `assignedTo` via the existing defensive `pickField`
  pattern (`['assignedTo', 'assigned_to', 'משוייך ל', 'משויך ל']`), defaulting
  to `''` when absent — matching the `originSheet` / `movedAt` pass-through
  idiom, so existing leads stay blank.
- `openAddLeadModal` gained a required `<select>` field (`type: 'select'`,
  `required: true`) with an empty placeholder option `— בחר —`. The submit
  handler blocks creation with `if (!values.assignedTo) { showError('יש לבחור
  משוייך ל'); return false; }`, mirroring the existing `name` validation.
- `buildLeadCard` renders `assignedTo` under the card meta line when present; a
  blank value (existing leads) renders nothing.
- The value flows to the backend unchanged: `openAddLeadModal` spreads the form
  values into `normalizeLead`, and `saveAll` posts `state.leads` verbatim.

### Styles — `public/style.css`

- Added `.lc-assigned` / `.lc-assigned-label` rules for the card, matching
  existing lead-card styling and RTL layout.

### Tests — `test/lead-assignedto.test.js`

- New test covering `normalizeLead` **with** `assignedTo` (round-trips the
  chosen value, accepts all three fixed assignees, reads the Hebrew column
  alias) and **without** it (defaults to present-but-blank `''`, no backfill).
- Uses the repo's existing `node --test` harness and the same vm-sandbox load
  pattern as `remove-entry-column.test.js`.

## Not included

- **No Apps Script deploy.** The dual deploy is handled manually after merge.
- **No backfill** of existing leads — they remain blank by design.
