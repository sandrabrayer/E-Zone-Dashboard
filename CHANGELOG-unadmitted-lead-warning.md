# «לא נקלט כמטופל» — leads that should have become patients but didn't

A lead that has paid, or is entering treatment, and still has no patient
record 3 days after its entry date now shows a red chip on its card:

> **לא נקלט כמטופל · N ימים**

The **לידים** tab shows how many leads carry that chip, as a red count badge.

**Railway only.** The change is `public/app.js`, `public/index.html`,
`public/style.css` and `public/sw.js`. `apps-script/Code.gs` is not touched.
It is display only and computed in the browser: there is no new action,
column, sheet, Script Property, env var or trigger, and nothing is written.

## The rule (locked)

A lead is flagged when **both** of these hold:

1. **It is paid or entering treatment.** Any one of these counts:
   - stage **בטיפול פעיל** (`paid`, which includes the alias מקדמה שולמה);
   - an advance (`advance` > 0) on the lead;
   - a non-void payment with money on it, recorded under the lead's own
     `house::name::entryDate`, using the same reduction the payment matcher
     uses (`patientMatchKey`);
   - meetingOutcome **«נכנסים לטיפול»** (`entered`).
2. **Today is 3 or more days after its `entryDate`, and no patient record
   matches it.** "Today" is the date in Asia/Jerusalem (`debtAgingTodayIso`),
   whatever time zone the device is set to. Day 2 is not flagged; day 3 is.

A lead is **never** flagged when:

- it has no `entryDate` (or one that can't be read), or the entry date is in
  the future;
- it is irrelevant, closed (has a `disposition`, including
  `released_outpatient`), removed (`removedAt`), or already `admitted`;
- the patient list is not loaded;
- the patient match is **ambiguous**. Such a lead is logged once per page
  load: `[E-ZONE] unadmitted-lead check: ambiguous patient match, not flagged`.

## The matching rule is reused, not new

The lead → patient match is **reconciliationReportNow's §A rule**
(PR #151, `apps-script/Code.gs` → `recLeadPatient_`, used by
`recSectionA_`). That rule exists only in Code.gs. Moving it to the browser
through the server would need a new action or response field, which is out of
scope. Instead it is ported verbatim into `public/app.js` as
`unadmittedLeadPatient`, and a **parity test** runs both on the same fixtures.
Code.gs stays unchanged. The tiers are tried in order, and the first tier with
a match decides:

1. **`fromLead`**: a Patients row whose `fromLead` is the lead's id.
2. **Phone**: a Patients row whose phone matches the lead's phone. A patient
   row has no phone of its own, so its phone is the phone of the lead it came
   from (the same join `getAdmittedRoster_` uses). Phones are compared with
   Code.gs `diagPhoneKey_` (ported as `unadmittedPhoneKey`).
3. **Name + house**: a Patients row with the same normalized name
   (`normalizeNameForMatch`, already parity-pinned to `recNameKey_`) in the
   same house (Code.gs `diagClientHouseId_`, ported as `unadmittedHouseId`).

Every Patients row counts, released ones included, exactly as in §A.
**Ambiguous** means the deciding tier found more than one row. Ambiguity can
only ever *suppress* a flag, so the check never fails open.

`promoteEnteredLeads` / `retireAdmittedLeads` in app.js use a narrower
variant (`fromLead` + exact name/house, no phone). This change uses the
report's rule because it is the one that defines "paid/admitted with no
patient record".

### Where it differs from report §A, and why

| §A | Here | Why |
|---|---|---|
| stage `paid` or `admitted`, or outcome `entered` | `paid`, an advance, a recorded payment, or outcome `entered`. `admitted` leads are excluded | The locked rule defines "paid" as an advance or payment being recorded. `admitted` leads have no card on the board, so there would be nothing to show |
| no date condition | `entryDate` 3+ days ago | The locked rule |

## UI

- **Chip:** `.lc-unadmitted` on the lead card, below the waitlist badge.
  `var(--danger)` red, wraps at phone width. The text goes through
  `escapeHtml`.
- **Tab badge:** `#leads-unadmitted-badge` (`.tab-badge.tab-badge-danger`) on
  לידים. It counts flagged leads **on the board** (the STAGES columns),
  ignores the search box, and is hidden at zero. `renderKanban` updates it, so
  every re-render keeps it current.
- **Who sees it:** everyone who sees the leads board, including the restricted
  view. The controller view (Ortal) has no leads: `renderAll` returns before
  `renderKanban`, so that view is untouched.
- **Sessions without finance** don't load Payments, so they miss only the
  "recorded payment" signal. Stage, advance and outcome still count. They can
  see fewer flags, never extra ones.

## Service worker

`CACHE_VERSION` v41 → **v42**. I checked all 156 remote branches and the
highest version on any of them is v41. v17 stays burned. The exact pin
(`test/dashboard-perf-assets.test.js` D) now expects v42. The reactivation
test's SW check reads "v41 or later".

## Tests

`test/unadmitted-lead-warning.test.js` (21 tests, runs in CI):

- paid vs stage: stage, Hebrew alias, advance, recorded / void / unpaid /
  other person's payment, outcome key and label, plain visit;
- the day 2 vs day 3 boundary, with the device clock in **UTC**. At 20:59Z
  vs 21:00Z on Oct 6 the Israel date changes from day 2 to day 3. Also
  across the end of DST;
- matched (each tier, released patient) vs unmatched vs ambiguous (not
  flagged, logged exactly once);
- no entryDate, unreadable entryDate, future entryDate;
- excluded stages: irrelevant, disposition, removed, admitted;
- patients not loaded;
- **parity**: phone key and house id against `diagPhoneKey_` /
  `diagClientHouseId_`, and `unadmittedLeadPatient` against `recLeadPatient_`
  on fixtures that hit every tier, a miss and multi-row tiers;
- the chip text and its escaping;
- the badge count (board only; hidden at 0; follows a fix);
- wiring and scope: Code.gs never mentions it, the helper block sends
  nothing, the controller early return is intact;
- **8 mutation checks**, each caught: threshold 3 → 2, `fromLead` tier
  removed, name + house tier removed, ambiguous fails open, irrelevant not
  excluded, no-entryDate guard removed, visit leads eligible, chip
  unescaped.

`test/unadmitted-lead-warning-browser.test.js` (Chromium, **360 px**):

- only the two flagged cards carry the chip, with the right day counts;
- a hostile `<img onerror>` name stays text;
- the badge reads 2 and is red;
- the chip stays inside its card and the page never scrolls sideways;
- adding the patient record clears that chip and drops the count to 1;
- no `/api/` POST is sent.

A temporary threshold-2 mutant fails this file too.

Full suite: **2329 / 2329** passing, 0 skipped (browser suites included).
