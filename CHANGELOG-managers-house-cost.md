# Changelog — managers work tool, stage 3: house manpower cost (2026-10-14)

## What
New `managersWork` op `houseCost` `{ house, month }` →
`{ cost: { available, total, confirmed, estimated, missingData, instructors, budget, hasActuals, stale, generatedAt } }`
for the caller's house only.

## Why
Sandra, 14 Oct 2026: every house manager sees the manpower cost of their own house.

## How
- It calls the staffing Apps Script feed `getHouseCostsForManagers`
  (sandrabrayer/ezone-staffing#96), which returns house totals only and never a worker.
- New Script Properties:
  - **`STAFFING_SHEETS_URL`**: the staffing `/exec` URL; only a `script.google.com/macros/s/…/exec`
    URL is accepted.
  - **`STAFFING_COST_SECRET`**: the same value as staffing's `MANAGERS_COST_READ_SECRET`.
- Staffing house ids are mapped: `asher` → raanana, `ofroni` → efroni, `pardes` + `hapardes` →
  pardes.
- The whole month is cached for 10 minutes, and only the caller's house leaves.
- Unset, unreachable, unauthorized or junk answers, or a missing house, return
  `available:false` with a reason, never 0.
- It is a separate op, so the house page never waits on staffing.

## Tests
2765 → 2769 (`test/managers-work-tool.test.js`).
