# Visit-date guard — out-of-range lead dates are never saved; damaged rows are flagged

October 9, 2026. Before #211, typing a visit date into a desktop date input
saved every intermediate year. The input fires `change` at each complete-looking
date: 11/10/0002, then 11/10/0020, and so on. Rows saved with those years are
still on the Leads sheet and invisible on «לוח פגישות».

**Railway + Code.gs** (clasp CI on merge). No column, sheet, Script Property,
env var or trigger. SW `CACHE_VERSION` v55 → **v56** (live was v55, no open
PR; v17 stays burned).

## The range

A lead's `visitDate` / `entryDate` may be blank, or a bare `YYYY-MM-DD` with
a year from **2024** to **this year + 2**. Anything else (0002, 0020, 2031,
`11/10/2026`) is out of range. The client and the server apply the same rule:
`leadDateInRange` / `leadDateInRange_`.

## 1. Guard on save

**Client (`public/app.js`):** an out-of-range date is never sent, and no
`updateLead` / save call is made.

- **Inline lead-card date** (`saveInlineLeadField`): the field gets a quiet
  amber outline (`.date-invalid`, `aria-invalid`, tooltip) and waits for a
  complete date. No toast, because the user may still be typing.
- **Lead ✏️ modal** (`openEditLeadModal`):
  - The visit date gets the same amber state on change.
  - Submitting an out-of-range date shows one message (`LEAD_DATE_REFUSED_HE`),
    keeps the modal open and leaves the lead untouched.
  - The modal now also shows **תאריך כניסה**, but only on a lead that already
    has one, so a damaged entry date can be fixed here.
- **Board ✏️ modal** (`openMeetingEditModal`): amber on change. Submit refuses
  before `updateLead`.
- **Entry modal** (`openEntryModal`): its date becomes `lead.entryDate`, so the
  same rule applies.

**Server (`apps-script/Code.gs`, isolated commit):**

- `mergeLeads_` calls `leadDateViolations_` before building any row. An
  incoming out-of-range `visitDate` / `entryDate` is a violation **only when it
  differs from the stored value**. A new lead has no stored value, so a bad
  date on it counts.
- `saveAll_` then answers
  `{ ok: false, error: 'bad_lead_date', message, badLeadDates }` before any
  patient write, so nothing is written.
- The message is in Hebrew, for example «תאריך הביקור של תומר לא תקין
  (0002-10-11) — השנה חייבת להיות בין 2024 ל-2028. דבר לא נשמר.». The client
  turns it into the usual rollback and error banner.
- A lead whose damaged date is unchanged still saves its other fields. Every
  save sends every lead, so without this one damaged row would block all lead
  saves.

## 2. Damaged rows are surfaced (read-only)

Nothing is written to the sheet to repair them.

- **Card chip** (`leadDateChipsHTML`): any lead with an out-of-range date gets
  an amber chip, «תאריך ביקור לא תקין — יש לתקן» or «תאריך כניסה לא תקין — יש
  לתקן». The chip appears wherever the card renders.
- **«לוח פגישות» line** (`badLeadDatesBannerHTML`): «N לידים עם תאריך ביקור לא
  תקין», followed by the names. It counts leads in every stage, admitted
  included.
  - In edit mode each name is a button that opens that lead's ✏️ modal.
  - Viewers see the names only.
- **Fixing the date** through the normal edit (✏️ modal or the inline field)
  clears the chip and the line. Since #211 the board re-renders on that save.

## Tests

- `test/visit-date-guard.test.js`, 12 tests:
  - the range;
  - typing 0002 → 0020 → 0202 → 2026 sends only 2026, the field is amber
    meanwhile, and no toast appears;
  - the lead ✏️ modal and the board ✏️ modal refuse before any save;
  - the server refuses a changed out-of-range visitDate (sheet untouched,
    Hebrew message), a changed entryDate, and a new lead with a bad date;
  - the server accepts other-field saves on a lead whose bad date is
    unchanged, and accepts the fix;
  - damaged leads get the chip and the board line, in edit and view mode;
  - with no damaged lead there is no line;
  - a lead fixed through the ✏️ modal or the inline field leaves the list;
  - a damaged entry date can be fixed in the ✏️ modal.

  On the old Code.gs the two server-refusal tests fail.
- `test/meetings-board-rerender.test.js`: the dropped-change test (D) used
  0002 / 0020 as its in-flight values. Those are now never sent, so it uses
  in-range dates.
- `test/dashboard-perf-assets.test.js`: SW version pin v55 → v56.

Full suite: 2647 / 2647. `npm audit`: 0 high / critical (1 moderate,
pre-existing).

## How many production rows are affected

Unknown. This change cannot read the Leads sheet. The «לוח פגישות» line shows
the live count after deploy.
