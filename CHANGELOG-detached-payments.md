# Detached payments — a durable link, and a tool for the ones already lost

A payment is attached to a patient by `houseId::name::entryDate`. **Any change
to any of the three detaches it** — silently, and for good. Nothing on either
row records that the link existed, so a detached payment is indistinguishable
from a payment that was never anyone's.

Six proofs, from the live sheet:

| Row | Why it detached |
| --- | --- |
| `"שחר חיון "` — 07/09, ₪35,000, עפרוני | a **trailing space** in the name |
| `"עמית יעקובי"` — 07/09, ₪30,000, עפרוני | attached to no patient. עמית בורנשטיין (עפרוני, entered 7.9) has his **own** ₪30,000 that day — a rename, or a double entry |
| `"אביב שבתאי"` — 13/07, ₪18,000, ריהאב | **invisible characters** in the name |
| `"ערן"` — 09/08, ₪35,000, עפרוני | a single-word name matching no patient row |
| `"עדי"` — 14/09, ₪35,000, ריהאב | the same |
| **נועם אשבל** | moved ריהאב → הפרדס; her payment stayed on the ריהאב record |

---

## What PR #139 already did, and where this picks up

**PR #139 (the accounting source feed) landed while this was being written**,
and it had already put `patientUid` — the persisted Patients-sheet id — on the
payment row. It resolves it **server-side**, from an **exact** match of the
row's `houseId::name::entryDate` triple against an index built from the
Patients sheet, on every write **and** through its own locked backfill over
the whole sheet. When the triple does not resolve, it leaves the cell **blank**
rather than guess.

That is the right default, and it is exactly right for every row whose triple
is intact. It is also, by construction, of no help to the six rows above: their
triples are *damaged*. An exact matcher will never place `"שחר חיון "`, and it
should not try.

So this change **reuses `patientUid` rather than adding a second one** — two
columns of the same name on a sheet read by position would be a data-contract
disaster — and adds what an exact matcher cannot supply: the normalized match,
and a person.

## A. Prevention

### 1. The manual link, beside the automatic one

Five columns are appended **after** PR #139's seven (append-only is the
standing contract — `readSheet_` maps by **position**, so inserting or
reordering silently re-reads every historical row against the wrong field):

| Column | Meaning |
| --- | --- |
| `linkPatientUid` | the patient a **person** (or the client's normalized-triple match) says this row belongs to. The **only client-writable input** to `patientUid`, and the only thing that may override an automatic resolution |
| `linkStatus` | `''` (nobody has reviewed this row) · `linked` · `not_a_patient` |
| `linkNote` | the reason a row was marked `not_a_patient`. **Required** for it |
| `linkedBy` | **who** decided — server-owned, from the signed session cookie |
| `linkedAt` | **when** — server-owned, from the server clock |

All five are **text-forced**, for the same reason `patientUid` is: a persisted
id left to Sheets can be coerced into a date or a number, on the one column
that decides whose money a row is.

`stampPaymentRow_` resolves `patientUid` in this order:

1. **the manual decision** (`linkStatus === 'linked'` with a validated
   `linkPatientUid`) — a person who looked at the row beats a triple that did
   not parse, and a correction nobody may apply is not a correction;
2. `linkStatus === 'not_a_patient'` → **cleared**. Leaving an automatic patient
   link on a row somebody declared is not a patient's money is exactly the
   wrong-ledger outcome these columns exist to prevent. This is the one case
   where `patientUid` is not immutable, and the decision that cleared it is
   recorded in the three columns beside it;
3. otherwise PR #139's rule, unchanged: the previous value if there is one,
   else the exact-triple resolution, else blank.

### 2. Names are trimmed at every write, client and server

`normalizePatient()` trims on the client — and because **every** patient object
in state goes through it, that covers the add form, the edit form, the lead
promotion and every `saveAll` echo at once. `replaceHousePatients_()` trims on
the server, which is the authority.

`patientKey_()` on the server has *always* trimmed while the client's
`patientKey()` did not — that disagreement is precisely how a payment row came
to hold `…::שחר חיון ::…` while the server's key for the same row was
`…::שחר חיון::…`. Both sides trim now. Only leading and trailing whitespace;
nothing inside a recorded name is touched.

### 3. Four matching tiers, and ambiguity is never guessed at

`matchPatientForPayment(pay, patients)` — **one rule**, read by the גבייה tab
and by `buildMonthlyRevenue` alike, so the two can no longer disagree about
whether a row is attached. The tier is **reported**, not just used:

| Tier | Matches on | Survives |
| --- | --- | --- |
| `patientUid` | the persisted id | a rename **and** a house transfer |
| `triple_exact` | `houseId::name::entryDate` as stored | nothing — but it is all a historical row has |
| `triple_loose` | the same triple with the name normalized (trimmed, invisibles stripped, inner runs collapsed, case folded) | a trailing space, a pasted zero-width character |
| `house_name` | house + normalized name, **no date** | a changed entry date |

At **every** tier, more than one candidate returns `null`. Two patients *can*
share a triple — a readmission on the same day, or a genuine namesake — and
`find()` would hand back whichever the array happened to hold first. That is a
coin flip deciding whose ledger a payment lands on.

A `patientUid` that names **nobody** also returns `null` rather than falling
through to a name match: the decision has gone stale (the patient row was
deleted), and silently re-linking the money to somebody else is the failure
mode this whole change exists to prevent.

---

## B. The reconnect tool — שיוך תשלומים

A new screen, between הכנסות חודשיות and נקודת איזון, listing every payment row
that matches no current patient. **Nothing reconnects automatically.** The
engine ranks, the screen presents, Sandra decides — a test asserts that none of
the five engine functions can reach a write path at all.

### Candidates, and why they are offered

`reconnectCandidates()` scores each patient and **reports the reasons**, so the
row shows *why* rather than a bare number:

| Signal | Weight | What it is |
| --- | --- | --- |
| `uid` | 100 | the row's `patientUid` names this patient, but a tier above rejected it — a stale decision |
| `name` | 40 | the names look alike (identical normalized · one a **prefix** of the other · a whole word in common) |
| `entry_date` | 30 | the due date is within **one day** of the entry date — a first payment is taken on admission |
| `same_house` | 10 | the payment's house is the patient's house |
| `in_house` | 5 | the patient's stay covered the due date (PR 1's rule) |

A candidate needs at least one of **name / entry_date / uid**. House alone
would offer every resident of עפרוני and teach Sandra to ignore the list.

The prefix rule is what finds the single-word rows: **ערן → ערן כהן**,
**עדי → עדי לוי**. The shared-word rule is what puts עמית בורנשטיין in front of
**עמית יעקובי**.

### Double entries are warned about, never blocked

Linking "עמית יעקובי" to עמית בורנשטיין would give one patient **two payments
for one cycle**. That is either a rename (one row is a duplicate to be removed
later) or a genuine double entry, and **only a person knows which**. The
candidate is marked amber, the collision's dates are named in the tooltip, and
the link button stays enabled.

"Same cycle" means the same **month**, not the same day — a stored due date that
drifted a day or two from the entry-day anchor is still that cycle, the rule
`buildMonthlyRevenue` already uses.

### "Not a patient" requires a reason

A refund, a supplier, a test row. Refused without a note **on both sides** — a
dismissal nobody can audit is indistinguishable next year from a row nobody
ever looked at, which is the state this screen exists to end.

Decided rows are **shown**, not archived out of sight, with who decided and
when, and a החזרה לבדיקה button: a row marked "not a patient" by mistake would
otherwise be unreachable.

### Every write goes through `savePayment()`

The one payment write path — optimistic upsert, rollback and the
`שמירת גבייה נכשלה` toast included. Only the link columns move: `amount`,
`status`, `amountPaid`, `balance` and the coverage period ride through
untouched, so **a reconnection can never move money**. Asserted twice, once on
the function source and once on the actual POST body in Chromium.

`savePayment()` now **adopts the server's echo**, which is what puts the real
server-stamped who-and-when on screen without a reload.

---

## C. The backfill

`planPatientUidBackfill(payments, patients)` — **pure**, returns a plan and
writes nothing. A row is in the plan only when the **normalized** triple places
it: same house, same entry date, and a name differing only by a stray space, an
invisible character or a case fold. `"שחר חיון "` is that row.

It deliberately does **not** re-do PR #139's work. A row whose triple is intact
is the server's to resolve — on write, and by its own locked backfill — and
planning it here would be a second writer racing the first for no gain. The
`house_name` tier is excluded too: no date in it, and two admissions of the
same person are exactly what it cannot tell apart.

The same rule runs at write time: `withPatientUid()` records the decision on a
payment being saved only under those same conditions, and **never overwrites**
a link the row already has — that was somebody's decision, and only the
reconnect screen may change it.

### Conservative choices, flagged

1. **The backfill runs on demand, never on load.** A write that fires when a
   screen opens is a write nobody chose, and this one touches every historical
   payment row. The button states the count before it changes anything.
1b. **`not_a_patient` clears `patientUid`**, which is the one place this change
   bends PR #139's "immutable once resolved". Leaving an automatic link on a
   row a person declared is not a patient's money is the worse of the two
   outcomes, and the clearing decision is recorded beside it with who and when.
   The accounting app now has `linkStatus` to read for exactly this case.
2. **No existing `patientId` is ever rewritten.** A house transfer leaves the
   triple on old payment rows stale; the uid is what keeps them attached. The
   alternative — rewriting historical triples — is a migration, and this is not
   one.
3. **`billingOverrides` are still keyed on the triple** and are NOT part of this
   change. A rename or transfer still detaches a per-month `סכום מותאם`
   override. Same disease, different sheet; it wants its own PR and its own
   backfill.
4. **`paymentId()` still derives from the triple**, so a payment recorded
   *after* a rename gets a different id than one recorded before. That is
   precisely what the double-entry warning is for.
5. **Invisible characters are stripped for MATCHING only.** What is stored keeps
   every character it had — removing characters from somebody's recorded name
   is a data edit, not a comparison.

---

## Security (PR #124 parity)

* **No new endpoint.** `getPayments` / `savePayment` / `updatePayment` remain
  the only actions that touch a payment row — asserted. `server.js` is
  unchanged and has never heard of `patientUid`.
* **The server is the authority on every link value.** `upsertPayment_()`
  sanitizes before the lock is taken: `linkPatientUid` must be a plain id (≤100
  chars, no control characters) or it is dropped; `linkStatus` must be on the
  enum or it is dropped; `linkNote` is stripped of control characters and of a
  leading `=`/`+`/`@`/`-` and capped at 300. **Two refusals**, both returned
  verbatim: `not_a_patient` without a note, and `linked` without a patient id —
  a link with nothing behind it is not a link, and downgrading it silently
  would let a caller believe it recorded a decision the sheet does not hold.
* **`linkedBy` / `linkedAt` are never read off the request.** They are in
  `PAYMENT_SERVER_COLUMNS`, so `stampPaymentRow_` deletes whatever the payload
  carried before anything looks at it, and writes them from
  `requestUser_(params)` — the signed session cookie — and `israelTimestamp_`,
  the same stamp PR #139 writes to `chargedAt`. They are re-stamped only when
  the **decision itself** changed: re-stamping on an unrelated save would turn
  the audit trail into a record of the last time anybody touched the row.
* **Every decision is audit-logged.** One `AuditLog` row per link decision
  (`payment_link_linked` / `payment_link_not_a_patient`) with the payment id,
  the triple, the house, the due date, the amount, the note, and who/when. The
  five columns on the row hold the *latest* decision; the log holds the history
  of them and survives the row being edited again. Fail-soft by the `logAudit_`
  contract — audit logging never breaks the operation it records. An ordinary
  payment save logs nothing.
* **Everything rendered is escaped**, the payment's own name included — it is
  printed **verbatim** on purpose, so a trailing space is visible, and a test
  asserts it never reaches `innerHTML` unescaped.

---

## Files

| File | Change |
| --- | --- |
| `public/app.js` | `trimName` / `normalizeNameForMatch` / `patientUid` / `paymentPatientUid` / `patientMatchKey*`; `patientKey` trims; `matchPatientForPayment` and the two finders that now delegate to it; the five link columns in `normalizePayment`; `withPatientUid` on the write path; `detachedPayments`, `namesLookAlike`, `reconnectCandidates`, `reconnectDoubleEntry`, `planPatientUidBackfill`; the three writes and the שיוך תשלומים screen; `savePayment` adopts the server echo |
| `public/index.html` | the nav tab (with an unplaced-rows badge) and the `screen-reconnect` section |
| `public/style.css` | the reconnect cards, candidate rows, the double-entry warning |
| `apps-script/Code.gs` | five appended `PAYMENT_COLUMNS` (after PR #139's seven) + text-forcing + `linkedBy`/`linkedAt` in `PAYMENT_SERVER_COLUMNS`; `paymentLinkUidClean_` / `paymentLinkNoteClean_` / `paymentLinkStatusClean_`; the two refusals in `upsertPayment_`; the decision-first `patientUid` resolution and the decision-only stamps in `stampPaymentRow_`; `logPaymentLink_`; names trimmed in `replaceHousePatients_` |
| `test/detached-payments.test.js` | **new** — 26 tests |
| `test/detached-payments-browser.test.js` | **new** — 5 Playwright/Chromium tests |
| `test/orphan-payments-reconcile.test.js`, `test/payment-coverage-period.test.js`, `test/accounting-source-feed.test.js` | the pinned column lists gain the append |
| `test/meetings-tab-shell.test.js`, `test/monthly-revenue.test.js` | the nav/router order gains `reconnect` |

## Tests

`test/detached-payments.test.js` — 26 tests, vm-sandboxed on the real shipped
`app.js` **and** `Code.gs`, TZ pinned to `Asia/Jerusalem`:

* **A** trimming, client and server, and the two `patientKey` implementations
  proven to agree.
* **B** the durable link — the schema append (with **exactly one**
  `patientUid`, PR #139's, reused rather than duplicated), text-forcing, a new
  row born with a trimmed triple and claiming no uid, a **rename** and a
  **house transfer** (נועם אשבל) that no longer detach, the
  **trailing-space** row (שחר חיון) and the **invisible-character** row
  (אביב שבתאי) still matching, the four tiers in order, ambiguity refused, and
  one matching rule shared by both screens.
* **C** the reconnect tool — the detached list, candidate ranking with a bare
  house match excluded, the single-word rows (ערן, עדי) finding their owners,
  the **עמית יעקובי / עמית בורנשטיין** pair warned about and not resolved,
  nothing reconnecting automatically, and the required reason.
* **D** the writes — the decision written and no money touched, the decision
  overruling the automatic resolution, `not_a_patient` clearing it, who/when
  stamped server-side and never from the body, the audit row, and the
  sanitizer driven with a control character, an off-enum status and a formula.
* **E** the backfill — only unambiguous rows planned, `house_name` never
  backfilled, on demand only, never overwriting.
* **F** scope + security — no new endpoint, everything escaped, the screen
  registered, inputs byte-identical afterwards.

`test/detached-payments-browser.test.js` — 5 Chromium tests: the worklist and
the nav badge, the candidate's reasons and the amber double-entry warning
(still clickable), linking asserted on the actual **POST body** with no money
moved, "not a patient" refused without a reason and recorded with one, and the
backfill button stating its count and only writing on a click.

Full suite: **1,391 passing**.

## Deploy note

`apps-script/Code.gs` changed, so the Apps Script backend **must deploy** (CI
does this on push to the configured branch — see `DEPLOY.md`). The five columns
are added to the `Payments` sheet automatically on the next
`getOrCreateSheet_` call. **No migration and no backfill runs by itself** —
existing rows keep blank link columns and read exactly as they did before.
(PR #139's own `patientUid` backfill is unchanged and keeps running as it
already does.)
