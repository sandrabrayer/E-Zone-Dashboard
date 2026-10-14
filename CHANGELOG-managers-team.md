# Changelog — managers work tool, stage 2: the house team (2026-10-14)

## What
`managersWork` op `houseData` now returns `team` for the caller's house:
- **today:** who is on shift today;
- **shifts:** today through +13 days;
- **staff:** guides and therapists, with role, phone, on leave and workdays;
- **therapistWeek:** the weekly therapist visits.

## Why
Stage 2 of the house-manager work tool (ezone-managers): who is on shift today, the staff list and
the therapists' schedule, as in the coordinators app.

## How
- Source: the Coordinators-owned **ManagersHouse** digest (`DIGEST-CONTRACT.md` «ManagersHouse»).
  It is read with `openById` from the new Script Property **`MANAGERS_DIGEST_SHEET_ID`** (the same
  id as on the Coordinators Apps Script), **by header name**. The raw rows are cached for 5 minutes.
- Honest states: `not_configured` / `unreadable` / `pending` (tab not filled yet) /
  `contract_mismatch` → `{ available:false, reason }`. A failed read is never an empty team.
  `stale:true` when the last refresh is older than 2 h.
- Scoped to the one house the managers server decided. Every value is cleaned with
  `coordTextClean_` (control chars, `< >` and formula lead-ins removed). Phones and times are
  validated, and shifts are mapped to `בוקר / ערב / לילה`. No financial fields.
- No new action, no new secret, no sheet in the main spreadsheet.

## Tests
2726 → 2730 (+4 in `test/managers-work-tool.test.js`).

## Setup
Add Script Property `MANAGERS_DIGEST_SHEET_ID` (see ezone-coordinators
`docs/managers-house-digest.md`). Until then `team.available` is `false` and nothing else changes.
