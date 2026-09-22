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

## A. Prevention

### 1. `patientUid` — a link that is not made of editable facts

The **persisted Patients-sheet id** (`PATIENT_COLUMNS.id`) is now appended to
`PAYMENT_COLUMNS` and written on every new payment row. It is matched **first**.
A rename cannot break it and neither can a house transfer, because it is made
of neither.

Five columns are appended (append-only is the standing contract — `readSheet_`
maps by **position**, so inserting or reordering silently re-reads every
historical row against the wrong field):

| Column | Meaning |
| --- | --- |
| `patientUid` | the persisted patient id this row belongs to. **Blank is legal** and is what every historical row carries |
| `linkStatus` | `''` (nobody has reviewed this row) · `linked` · `not_a_patient` |
| `linkNote` | the reason a row was marked `not_a_patient`. **Required** for it |
| `linkedBy` | **who** decided — server-stamped from the signed session cookie |
| `linkedAt` | **when** — server-stamped from the server clock |

All five are **text-forced**. A persisted id is an opaque string; left to
Sheets, one that looks like a date or a long number is coerced — the same
corruption class the coverage columns are forced against, and here it would
silently re-point money at nobody.

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
writes nothing. A row is in the plan only when its triple names **exactly one**
current patient: tiers 1–3, and each of those already refuses on ambiguity.

The `house_name` tier is **excluded**. It has no date in it; it is good enough
to keep a row *readable* on screen, and not good enough to write a permanent
identity from, because two admissions of the same person are exactly what it
cannot tell apart. Everything it does not cover goes to the reconnect screen.

The same rule runs at write time: `withPatientUid()` stamps a uid onto a
payment being saved only under those same conditions, and **never overwrites**
a uid the row already has — that was somebody's decision, and only the
reconnect screen may change it.

### Conservative choices, flagged

1. **The backfill runs on demand, never on load.** A write that fires when a
   screen opens is a write nobody chose, and this one touches every historical
   payment row. The button states the count before it changes anything.
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
  sanitizes before the lock is taken: `patientUid` must be a plain id (≤100
  chars, no control characters) or it is dropped; `linkStatus` must be on the
  enum or it is dropped; `linkNote` is stripped of control characters and of a
  leading `=`/`+`/`@`/`-` and capped at 300. `not_a_patient` without a note is
  **refused outright**, with the reason returned verbatim.
* **`linkedBy` / `linkedAt` are never read off the request.** They are
  overwritten from `requestUser_(params)` — the signed session cookie the proxy
  injects — and from the server clock. A client that can post a payment can
  post any name and any date it likes.
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
| `apps-script/Code.gs` | five appended `PAYMENT_COLUMNS` + text-forcing; `paymentUidClean_` / `paymentLinkNoteClean_` / `paymentLinkStatusClean_`; sanitization, the `not_a_patient` refusal and the server stamps in `upsertPayment_`; `forcePaymentLinkTextCells_`; `logPaymentLink_`; the dispatcher passes `requestUser_`; names trimmed in `replaceHousePatients_` |
| `test/detached-payments.test.js` | **new** — 26 tests |
| `test/detached-payments-browser.test.js` | **new** — 5 Playwright/Chromium tests |
| `test/orphan-payments-reconcile.test.js`, `test/payment-coverage-period.test.js` | the pinned column lists gain the append |
| `test/meetings-tab-shell.test.js`, `test/monthly-revenue.test.js` | the nav/router order gains `reconnect` |

## Tests

`test/detached-payments.test.js` — 26 tests, vm-sandboxed on the real shipped
`app.js` **and** `Code.gs`, TZ pinned to `Asia/Jerusalem`:

* **A** trimming, client and server, and the two `patientKey` implementations
  proven to agree.
* **B** the durable link — the schema append and text-forcing, a new row born
  with its uid, a **rename** and a **house transfer** (נועם אשבל) that no longer
  detach, the **trailing-space** row (שחר חיון) and the **invisible-character**
  row (אביב שבתאי) still matching, the four tiers in order, ambiguity refused,
  and one matching rule shared by both screens.
* **C** the reconnect tool — the detached list, candidate ranking with a bare
  house match excluded, the single-word rows (ערן, עדי) finding their owners,
  the **עמית יעקובי / עמית בורנשטיין** pair warned about and not resolved,
  nothing reconnecting automatically, and the required reason.
* **D** the writes — the uid written and no money touched, who/when stamped
  server-side and never from the body, the audit row, and the sanitizer driven
  with a control character, an off-enum status and a formula.
* **E** the backfill — only unambiguous rows planned, `house_name` never
  backfilled, on demand only, never overwriting.
* **F** scope + security — no new endpoint, everything escaped, the screen
  registered, inputs byte-identical afterwards.

`test/detached-payments-browser.test.js` — 5 Chromium tests: the worklist and
the nav badge, the candidate's reasons and the amber double-entry warning
(still clickable), linking asserted on the actual **POST body** with no money
moved, "not a patient" refused without a reason and recorded with one, and the
backfill button stating its count and only writing on a click.

Full suite: **1,335 passing**.

## Deploy note

`apps-script/Code.gs` changed, so the Apps Script backend **must deploy** (CI
does this on push to the configured branch — see `DEPLOY.md`). The five columns
are added to the `Payments` sheet automatically on the next
`getOrCreateSheet_` call. **No migration and no backfill runs by itself** —
existing rows keep blank link columns and read exactly as they did before.
