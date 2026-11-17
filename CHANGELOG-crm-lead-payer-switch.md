# CRM — «מסלול» פרטי ⇄ מכבי: a private lead moves to the «מכבי» list

Vered, 17/11/2026: a lead that came in as private and goes through קופ״ח מכבי must
be switchable to מכבי, and then appear in the «מכבי» list. CRM only — **no Code.gs
change, no new column, no new action.** Builds on `CHANGELOG-crm-lead-full-edit.md`
and `CHANGELOG-maccabi-leads.md`.

## What is new

«עריכת פרטי הליד» (the lead card) has **«מסלול»**: «פרטי» / «מכבי — ברשימת «מכבי»».

- **פרטי → מכבי:** after «שמירת שינויים» the lead is in «לידים» → «מכבי» at once (no
  reload) with its five documents as «חסר». The toast says «הליד עבר לרשימת «מכבי»».
- **מכבי → פרטי:** the lead leaves the list. Documents already ticked are **kept**
  (parked) and come back, as they were, if the lead returns to מכבי.
- The card's details show **«מסלול: מכבי · מסמכים n/5»** on a Maccabi lead.
- The form's «הערות» box no longer shows the documents line, so it cannot be damaged
  by hand; it is written back on every save.

## How it is stored

The «מכבי» list's rule is unchanged: a lead is a Maccabi lead when its source or name
says מכבי, or its note carries the documents line. The switch only writes that line:

    מסמכי מכבי: ✗ הפניה מפסיכיאטר | ✗ בדיקות דם | …            ← in the list
    מסמכי מכבי (לא פעיל): ✓ הפניה מפסיכיאטר | ◐ בדיקות דם | …   ← parked (private)

- **The source is not rewritten.** «מקור» keeps saying where the lead really came
  from (e.g. «בית חולים»), so the leads funnel and the lead bonus are not affected.
- A line with nothing ticked is removed instead of parked.
- A lead whose **source or name says מכבי** stays a Maccabi lead until that text is
  changed: choosing «פרטי» alone is refused with the reason under the field; changing
  «מקור הליד» in the same save lets it leave. Typing «מכבי» as the source is enough
  by itself to enter the list, as «+ ליד מכבי» does.
- A lead that is מכבי by its source alone gets no line written just for being opened
  and saved.

## Not changed

- An admitted **patient's** funder («גורם מממן» — פרטי / מכבי / …) is a billing
  record with its own history and is not touched by this; this change is about leads.
- No separate audit row: a lead save has none today. The line in the note is the
  record, and it is visible wherever the note is shown.
- `Code.gs`, the Leads columns, the classic page, the managers' app.

## Security

Saved through the existing proven one-lead write (`saveAll`, one lead, `prove.leads`);
same roles as any lead edit. Values escaped on render. A hand-edited or unreadable
line never becomes a received document. `npm audit`: 0 high / critical.

## Tests

- `test/crm-lead-payer-switch.test.js` (new, 7): the track of a lead, private → מכבי,
  the line kept out of the note box, מכבי → private and back with the ticks, the
  source / name rule, unreadable lines, the card wiring and no server change.
- `test/crm-shell-browser.test.js`: one scenario on the real page (switch in, tick a
  document, edit the note, switch out, switch back, the source rule, a 390 px phone).
- `test/crm-lead-full-edit.test.js`: the starting values now carry `track`.

## Files

`public/crm/crm.js`, `public/sw.js` (v144 → v145), `test/crm-lead-payer-switch.test.js`
(new), `test/crm-shell-browser.test.js`, `test/crm-lead-full-edit.test.js`,
`test/crm-pwa.test.js`, `test/dashboard-perf-assets.test.js`,
`EZONE-ECOSYSTEM-STATUS.md`.

## Deploy

Railway only (auto-deploy of the deployed branch). No Apps Script deploy.
