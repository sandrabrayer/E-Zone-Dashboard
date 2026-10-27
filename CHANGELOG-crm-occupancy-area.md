# C3a — «תפוסה» area, «מטופלים» label, DD/MM/YYYY dates, created date on cards — 2026-10-27

Sandra's first review of the live shell (CRM_ENABLED on, 2026-10-27 20:25). Flag-gated as before.

- **«תפוסה» area** (after פניות): per-house cards — in house / capacity / free beds / %, colour by
  free beds (0 red, ≤2 amber, else green), closed houses only when occupied, «בית לא מזוהה» counted
  apart; totals strip (בטיפול היום / מיטות פנויות / קיבולת). A card opens «מטופלים» filtered to the
  house. In-house = `status !== 'released'` — the SAME rule as `app.js houseOccupancyCount`
  (the «מטופלים» list now uses it too; previously it also dropped rows with an exitDate).
  House ids resolve aliases (`hapardes`, `ofroni`, `efroni`, `raanana`) and Hebrew names.
  Admission / discharge / transfer stay in the classic תפוסה tab (the note says so).
- **«לקוחות» → «מטופלים».**
- **Dates** are shown as DD/MM/YYYY everywhere (cards, tables, queue, calendar, drawer, timeline);
  internals stay ISO. `fmtDate` pure + tested; the browser test asserts no ISO date is rendered.
- **Lead cards** show «נוצר DD/MM/YYYY» and, when set, the meeting date/time.
- **גבייה** still links to the classic screens — by design until Phases 4–6; recorded.

Files: `public/crm/crm.js`, `test/crm-shell-ui.test.js` (+2), `test/crm-shell-browser.test.js`,
ESS. No server, no Code.gs, no SW bump (the asset is hashed). Rollback: flag off, or revert.
