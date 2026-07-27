# Add-lead meetingWith autofill on house change

In the **add-lead** modal, changing the **בית מועדף** (house) select now
auto-fills **נפגש עם** (meetingWith) with that house's manager — unless the user
has already picked a manager themselves. Houses with no manager
(pardes/sde/external) clear the field. The **edit-lead** modal is unchanged.

## Why

meetingWith already defaulted to the house's manager when the modal opened, but
in the add flow no house is chosen at open time, so the default was always
blank. Vered then had to set the house *and* the manager separately. Wiring the
house select to fill the manager removes that second step while still letting
her override.

## What changed

### `public/app.js`

- **`showModal` — opt-in per-field `onChange` hook.** After the form is built,
  any field declaring `onChange(value, form)` gets a native `'change'` listener.
  Fields without one are untouched, so every existing modal is unaffected.
  Programmatic `.value =` assignments do **not** dispatch `'change'`, so a
  handler that updates a sibling field can't loop back on itself.
- **`autofillMeetingWith(newHouse, dirty, managers)`** (new, pure) — the
  decision behind the wiring:
  - `dirty` (user already set meetingWith) → returns `null` = leave as-is;
  - otherwise returns `managerForHouse(newHouse, managers)`, which is the
    matching manager or `''` for houses with no manager (pardes/sde/external),
    clearing the field.
  Roster is injected, so the rule is unit-tested without a DOM.
- **`openAddLeadModal`** — a `meetingDirty` closure flag (false initially):
  - the **house** field's `onChange` applies `autofillMeetingWith(...)` to the
    meetingWith `<select>` (skipping when the result is `null`);
  - the **meetingWith** field's `onChange` sets `meetingDirty = true`, so a
    manual pick is never overwritten by a later house change.
  Options still come from `state.houseManagers` — no names hardcoded.

`openEditLeadModal` is untouched (it already pre-selects from the lead's house
or existing value at open time; no reactive behaviour was requested there).

### Tests — `test/meetingwith-autofill.test.js`

- House change sets the matching manager for all four keys (by id **and** by
  Hebrew label).
- A manually-set meetingWith (`dirty`) survives a subsequent house change —
  returns `null` for every house, including blank-resolving ones.
- Blank-resolving houses (pardes/sde/external/no-house) clear meetingWith (`''`,
  a real overwrite — distinct from `null`).
- Same `node --test` + vm-sandbox pattern as `meetings-board.test.js`.

## Not included

- **No edit-modal change** — behaviour there is unchanged by request.
- **No Apps Script / backend change** — frontend only; `meetingWith` and
  `HOUSE_MANAGERS` already shipped.
- **No Apps Script deploy** — dual deploy is handled manually after merge.
