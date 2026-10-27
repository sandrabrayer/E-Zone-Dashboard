# C5 — lead lifecycle inside the CRM: new lead, close, remove, restore — 2026-10-27

CRM restructure, Session C (write actions, second PR). Flag-gated (`CRM_ENABLED` + `/?view=crm`).
No server change, no Code.gs, no SW bump (hashed assets).

## Actions (same backend actions as the classic app, same payloads)
- **«+ פנייה חדשה»** — a drawer form mirroring the classic add-lead modal: patient name + phone
  (two words; 10-digit local phone — `localPhone`), referrer name / phone / relation (the classic
  preset list + «אחר» free text), billing phone selector (מטופל / פונה / אחר), house, source
  (datalist), «משוייך ל» (required), «נפגש/ת עם», note. Client-side validation with inline
  messages (`novalidate`); duplicate-phone warning (`confirm`) as in the classic flow. Saved with
  the C4 one-lead `saveAll` (`stage: 'new'`, `created` = today, id `id-<16 hex>`), proven or
  rolled back; the card appears in «ליד חדש».
- **סגירת ליד** (drawer → «סגירת ליד / הסרה»): disposition (the four `LEAD_CLOSE_DISPOSITIONS`)
  + reason → `moveLeadIrrelevant` with the classic record (`stage: 'irrelevant'`, `originSheet`,
  `movedAt`, `disposition`, `not_relevant_note`). The lead leaves the board and joins
  «לידים סגורים».
- **הסר (טעות)** → `removeLead` after a confirm.
- **«לידים סגורים»** — third view of «פניות» (closed leads from `getData.irrelevantLeads`, newest
  first) with **שחזור ל«<origin stage>»** → `restoreLead`.
- Every action is optimistic with rollback and a toast; refusals show the server's message.

## Files
`public/crm/crm.js`, `public/crm/crm.css`, `test/crm-shell-ui.test.js` (+2 incl. the write-action
allow-list guard), `test/crm-shell-browser.test.js` (+1 real-Chromium scenario), ESS.
Rollback: flag off, or revert.
