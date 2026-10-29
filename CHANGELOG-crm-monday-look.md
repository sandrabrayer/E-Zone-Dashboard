# CHANGELOG — CRM Monday-style look

Date: 2026-10-29 · Branch `claude/crm-monday-look` → base `claude/build-ezone-dashboard-QOg5s`
Sandra: «תסדר את התצוגה של ה-CRM כך שתהיה דומה למאנדיי, יותר מודרנית ומעניינת».
Presentation only (`crm.css`, small markup in `crm.js`, logo in `crm.html`), SW v101 → v102.

- **Status labels** are filled, rounded Monday-style blocks: red «⚠ חריג / ⏰ באיחור», orange
  «● להיום», grey «◷ ממתין», green «אומת / הושלם»; stages carry their own colours (ליד חדש blue,
  ביקור נקבע purple, רשימת המתנה orange, בטיפול פעיל green). Every label still carries its word.
- **Board**: colour-coded column headers with counts, cards with shadow + hover lift, the source
  as a soft tag, the owner as an **avatar** (initial in a stable per-person colour) — the same
  avatar in the tables and in every work row.
- **Menu**: gradient logo, an icon per area, the active area in Monday blue with a side bar, blue
  count badges.
- **Tabs** (היום / השבוע / הושלמו, לוח / טבלה, בבית / משוחררים) as underlined tabs.
- **Summary cards** with a coloured top accent per domain (the same accent on the domain title);
  bigger numbers.
- **Tables**: sticky grey header, zebra rows, blue hover. Buttons in Monday blue.
- Board «ליצור קשר» is no longer red by lead age (spec §1) — lateness lives in «היום שלי» / triage.
- No remote font (the PWA stays offline-capable; the system Hebrew stack renders Heebo where
  installed).
- Tests: nav assertions ignore the icon; `nextActionFor` pin updated; SW guards. `npm audit`: 0
  high/critical. Nothing to set.
