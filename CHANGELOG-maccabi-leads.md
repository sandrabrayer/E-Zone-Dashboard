# «לידים» → «מכבי» — Maccabi leads and their required documents

Sandra, 15/11/2026: leads that come through קופ״ח מכבי are managed differently —
five documents are required before treatment. Today Vered sends the family a
message; she needs the list per lead and to tick what was delivered, or what the
patient already has and is bringing. CRM only — **no Code.gs change, no new
column, no new action.**

## What is new

«לידים» has a new **«מכבי»** button (with the number of Maccabi leads) next to
«לידים סגורים». It opens a view of the Maccabi leads only:

- **«+ ליד מכבי»** — the new-lead form with «מקור הליד» already «מכבי».
- **The message** to the family (the five documents + `maccabi@ezone-house.co.il`,
  «סרוק וקריא»): shown in full, **«העתק את ההודעה למשפחה»**, and a **«וואטסאפ»**
  button per lead that opens the chat with the message ready.
- **A table**, one line per lead, one button per document. A click changes the
  state: **✗ חסר → ◐ אצל המטופל/ת (מעביר/ה) → ✓ התקבל**. Saved at once.
  «מצב» shows e.g. «2/5 · 1 בדרך». Leads still missing documents come first.
- The lead's name opens the lead as usual. The top search filters the list.

The five documents:
1. הפניה מפסיכיאטר של מכבי לתחלואה כפולה
2. בדיקות דם כלליות
3. סיכום פסיכיאטר אחרון
4. סיכום מצב בריאותי מרופא המשפחה
5. אק״ג ופענוח

## Which lead is a Maccabi lead

Its «מקור» or its name contains «מכבי», or it already carries the list.

## Where the ticks are kept

One line in the lead's own «הערות»:

    מסמכי מכבי: ✓ הפניה מפסיכיאטר | ◐ בדיקות דם | ✗ סיכום פסיכיאטר | ✗ סיכום רופא משפחה | ✗ אק״ג ופענוח

Why not a new column: the Leads header is mirrored by the closed-leads and
removed-leads sheets (`LEAD_COLUMNS.concat(...)`, read by position), so an append
would shift their own columns. The line is readable wherever the note is shown
(classic page, the managers' app) and moves with the lead. The rest of the note
is kept as typed. **Do not edit that line by hand** — a line that cannot be read
shows the document as missing (never as received).

## Security

Saved through the existing proven lead write (`saveAll`, one lead,
`prove.leads`); same roles as any lead edit. Cells escaped; the WhatsApp link
carries only the fixed message; external links `rel="noopener"`.
`npm audit`: 0 high / critical.

## Files

`public/crm/crm.js`, `public/crm/crm.css`, `public/sw.js` (v141 → v142, from the
live v141), `test/maccabi-leads.test.js` (new, 8), a browser scenario in
`test/crm-shell-browser.test.js`, `test/crm-pwa.test.js`,
`test/dashboard-perf-assets.test.js`, `EZONE-ECOSYSTEM-STATUS.md`.
