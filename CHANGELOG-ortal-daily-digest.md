# Ortal's daily payments digest — one email each working morning

**Why:** Ortal checks every payment Vered records against the bank. Until now
she had to open the dashboard and work out what was new since she last looked.
This sends her the list instead: every payment **recorded** since the previous
digest, Sunday–Thursday at about 08:00 (Israel time).

**Apps Script only.** `public/`, `server.js` and the service worker are
untouched (no `CACHE_VERSION` bump). Nothing new is reachable over HTTP:
`handle_` names none of the new functions.

---

## For Sandra — setup

Do these once, in the Apps Script editor of the **Dashboard** project
(the one bound to the Dashboard spreadsheet), after this PR is merged and the
clasp CI has deployed it.

### 1. Script Properties

Project Settings (the gear icon) → **Script Properties** → *Add script property*:

| Property | Value | Notes |
|---|---|---|
| `DIGEST_TO` | Ortal's email address | **Required.** Missing or malformed → nothing is ever sent, and the run logs a warning. Several addresses: separate with `,`. |
| `DIGEST_CC` | your email address | Used for the trial-week CC and for `sendDigestTestNow`. |
| `DIGEST_CC_UNTIL` | last day of the trial week, `YYYY-MM-DD` (e.g. `2026-10-08`) | You are CC'd while today ≤ this date; after it, Ortal only. Leave it out (or delete it) to stop the CC immediately. |

Do **not** create `DIGEST_LAST_AT`, `DIGEST_LAST_SENT_DAY` or any
`DIGEST_LEDGER_*` property. The digest writes those itself.

### 2. Run, in this order

In the editor's function dropdown, pick each function and press **Run**:

1. **`authorizeDigestNow`** — opens Google's consent dialog. **Tick every
   permission** (Google may show checkboxes; a partial grant will make this
   run fail on purpose). The execution log ends with the remaining daily mail
   quota.
2. **`previewDigestNow`** — builds today's mail and writes it to the
   execution log. **Sends nothing, changes nothing.** Check the recipients
   line and the rows.
3. **`sendDigestTestNow`** — sends the same mail, subject prefixed
   `[בדיקה]`, to **`DIGEST_CC` only** (you). Ortal gets nothing. Changes
   nothing.
4. **`installDigestTriggerNow`** — installs the daily 08:00 trigger. Safe to
   run again: it removes any earlier digest trigger first, so there is always
   exactly one.

The first real mail goes out at the next working-day 08:00. It covers the
last **7 days** (there is no previous digest yet) and says so in its header;
from then on each mail covers exactly what was recorded since the previous
one.

### 3. To stop it

Triggers (the clock icon) → delete the `paymentsDigestJob` trigger. Or delete
`DIGEST_TO` — the run then sends nothing.

---

## What the mail contains

**Subject:** `תשלומים שנרשמו — DD/MM/YYYY` (today, Israel date).

**Body:** a right-to-left HTML table (inline styles only — mail clients strip
`<style>`), with a plain-text alternative of the same content:

| column | source |
|---|---|
| מטופל | `Payments.patientName` |
| בית | the Hebrew house label (`DIGEST_HOUSE_NAME_TO_INTERNAL`, i.e. `HOUSES` in `app.js`) |
| סכום (כולל מע״מ) | `amountPaid` — what was reported received; for a `paid` row with no `amountPaid`, its `amount`. **VAT-inclusive, as stored; no conversion.** |
| תאריך תשלום | `dueDate`, as DD/MM/YYYY (see "Choices", below) |
| אמצעי | the optional hand-added `אמצעי תשלום` column on Payments, else `—` |
| נרשם ע״י | `chargedBy` (from the signed session cookie, PR #139) |
| נרשם ב- | `chargedAt`, Israel time, DD/MM/YYYY HH:mm |
| *(mark)* | `עודכן` when the row was in an earlier digest and has been re-recorded since — with `(נשלח קודם: ₪X)` when the amount changed |

Then a **per-house summary** (count and ₪) and an **overall total**, a
one-line reminder that «נרשם» means *reported paid*, not *seen in the bank*,
and a link to https://ezone-dashboard.up.railway.app.

**No new payments →** a short heartbeat, `אין תשלומים חדשים`, with the window,
so silence always means something is wrong rather than "nothing happened".

**Never in the mail:** anything clinical, any phone number, any id — not the
row `id`, the billing triple `patientId`, `paymentUid` or `patientUid`. Each
row is projected onto an explicit allow-list (`digestRow_`) before anything is
rendered, and **every value is HTML-escaped** (`digestEsc_`); the plain-text
part has control characters and line breaks flattened (`digestPlain_`), so a
name cannot forge a line.

---

## The rules, and where each one lives

### What counts as "recorded"

The charge stamp from PR #139 (`CHANGELOG-accounting-source-feed.md`):
`chargedAt` is set when a row becomes `paid`/`partial`, and **set again when
its `amountPaid` moves**. The digest lists rows that are `paid`/`partial`,
**not void**, and whose `chargedAt` falls in the window. Historical rows (blank
stamp) are never listed — nobody recorded who reported them.

**Void rows (PR #144, `void` / `מבוטל`) are excluded** explicitly, even if a
stamp survived on one.

### The window: `(DIGEST_LAST_AT, now]`

Compared as **instants** (each stamp carries its own offset), so the October
DST switch cannot reorder anything. A row stamped at exactly `DIGEST_LAST_AT`
was in the previous mail; a row stamped after the run started goes in the next
one.

`DIGEST_LAST_AT` is advanced **only after `MailApp.sendEmail` returns**, inside
the script lock (`tryLock` result checked), and set to the moment the run
started. So:

- a **failed send** moves nothing — the next run covers the gap. The trigger
  execution is also marked **Failed** (the job re-throws after logging), so
  Google's failure notice reaches the trigger owner;
- **Sunday's mail covers Thursday-after-send through Saturday** with no special
  case: Friday's and Saturday's runs exit before touching anything;
- `previewDigestNow` and `sendDigestTestNow` **never** move it.

### Weekday gating

The handler itself checks the **Jerusalem** weekday (`Utilities.formatDate`
with `Asia/Jerusalem`, pattern `u`) and exits on Friday and Saturday, taking no
lock and writing nothing. It never relies on the runtime's or the
spreadsheet's timezone. Tested at the 23:30 UTC edges on both sides of the DST
switch (e.g. Thursday 23:30 UTC is already Friday 02:30 in Israel → skip;
Saturday 23:30 UTC is Sunday → send).

### Once per day

A second scheduled run on the same Israel date (a duplicated trigger, a manual
re-run) sends nothing: `DIGEST_LAST_SENT_DAY` records the day of the last
successful scheduled send.

### «עודכן» — the ledger

The sheet cannot say "this row was already sent": `chargedAt` is overwritten,
not versioned. So after each successful send the digest records, per row, the
amount it sent (`DIGEST_LEDGER_*` Script Properties, JSON split into 8,000-char
chunks, entries older than **180 days** pruned). A listed row found in the
ledger is marked `עודכן`, with the previously sent amount when it differs.

The ledger key is the row's `paymentUid` (or its `id` if it has none). It lives
**only** in Script Properties; it is never rendered. An unreadable ledger
degrades to "nothing marked", never to an error or a missed row.

### Recipients — Script Properties only

`DIGEST_TO`, `DIGEST_CC`, `DIGEST_CC_UNTIL`. No address is written in
`Code.gs` (a test scans the section for one).

- `DIGEST_TO` missing, blank or **malformed** → nothing sent, a `WARNING` is
  logged (fail closed). A list with one bad entry is refused whole, never
  half-sent.
- Addresses must not contain whitespace, line breaks, quotes, brackets or `;:,`
  inside an address, so a property value cannot inject a mail header.
- `DIGEST_CC` is added only while today (Israel date) ≤ `DIGEST_CC_UNTIL`.
  Missing or malformed `DIGEST_CC_UNTIL` → no CC. A malformed `DIGEST_CC` drops
  the CC; it never blocks Ortal's mail.

### Read-only

The digest reads Payments with `recReadSheet_` (header-aware, so the optional
method column is seen) via `getSheetByName` — never `getOrCreateSheet_`. The
test runs it against a spreadsheet whose every non-read method throws, and
records zero attempts. It writes nothing but its own Script Properties.

---

## Functions

| function | kind | what it does |
|---|---|---|
| `paymentsDigestJob()` | **trigger handler** | runs the scheduled digest. Public because a trigger cannot call a `_` function; not reachable over HTTP. |
| `authorizeDigestNow()` | editor-run | **first statement** `ScriptApp.requireAllScopes(ScriptApp.AuthMode.FULL)`, uncaught, so the consent dialog appears and a partial grant fails loudly here, not at 08:00 in a trigger nobody watches. Then logs `MailApp.getRemainingDailyQuota()`. |
| `previewDigestNow()` | editor-run | builds the mail for now and logs it — to/cc/subject/rows/text/HTML. No send, no lock, no property write. Works on any day. |
| `sendDigestTestNow()` | editor-run | sends to `DIGEST_CC` only, subject `[בדיקה] …`. No property write. |
| `installDigestTriggerNow()` | editor-run | idempotent: deletes every `paymentsDigestJob` trigger, then creates one: `everyDays(1).atHour(8).nearMinute(0).inTimezone('Asia/Jerusalem')` (falls back to plain `atHour(8)` if `nearMinute` is rejected). Other triggers are untouched. |
| `paymentsDigestRun_(mode, now)` | private | the core, for `'scheduled'` / `'preview'` / `'test'`. |
| `digestJerusalemParts_`, `digestIsWorkday_`, `digestRecipients_`, `digestCcActive_`, `digestInstant_`, `digestDmyFromIso_`, `digestMoney_`, `digestHouseLabel_`, `digestMethod_`, `digestRowKey_`, `digestAmount_`, `digestRow_`, `digestSelect_`, `digestTotals_`, `digestCompose_`, `digestEsc_`, `digestPlain_`, `digestLedgerLoad_`, `digestLedgerNext_`, `digestReadPayments_`, `digestBuild_`, `digestLockBusy_` | private | pure helpers and the two reads. |

## Script Properties

| property | written by | meaning |
|---|---|---|
| `DIGEST_TO` | **Sandra** | Ortal's address (required) |
| `DIGEST_CC` | **Sandra** | Sandra's address |
| `DIGEST_CC_UNTIL` | **Sandra** | last day of the CC, `YYYY-MM-DD` |
| `DIGEST_LAST_AT` | the digest | the window's start: the instant the last successful scheduled run began (ISO, with offset) |
| `DIGEST_LAST_SENT_DAY` | the digest | Israel date of the last successful scheduled send |
| `DIGEST_LEDGER_CHUNKS`, `DIGEST_LEDGER_0…n` | the digest | the «עודכן» ledger |

## OAuth scopes (`appsscript.json`)

Scopes are pinned in this project. The digest needs exactly two, and **both
were already pinned**, so `appsscript.json` is **unchanged**:

- `https://www.googleapis.com/auth/script.send_mail` — `MailApp.sendEmail`,
  `MailApp.getRemainingDailyQuota` (already used by the nightly integrity alert);
- `https://www.googleapis.com/auth/script.scriptapp` — the trigger
  (`ScriptApp.newTrigger` / `getProjectTriggers` / `deleteTrigger`).

Reading Payments uses the existing `spreadsheets` scope. A test pins all of the
above.

## Choices made (ambiguities resolved the safe way)

1. **«תאריך תשלום» = the row's `dueDate`.** Payments has no paid-on date (the
   `paidOn` field belongs to the planned `PaymentReports` of the billing-control
   plan, not built yet). `dueDate` is the cycle date the row was recorded
   against; the moment it was *recorded* is in its own column.
2. **«אמצעי» comes from the optional hand-added `אמצעי תשלום` column** (the
   same lookup `recPayment_` uses). Payments has no method column of its own;
   without one the cell reads `—`. Nothing was added to the sheet.
3. **Amount = `amountPaid`** (what was reported received), falling back to
   `amount` only for a `paid` row with no `amountPaid`. A partial payment is
   listed at the part received.
4. **«עודכן» needs memory the sheet does not keep**, so the digest keeps a
   small ledger of what it sent (Script Properties, 180 days). A re-recorded
   row is marked even if its amount ended up unchanged (it was touched after
   Ortal saw it); the previous amount is shown only when it differs. A row
   first recorded before the digest existed and edited later is not marked —
   there is nothing to compare it with.
5. **First run = the last 7 days**, labelled as such in the mail.
6. **Once per Israel day** for scheduled runs, so a duplicated trigger cannot
   send twice.
7. **A failed send re-throws from the trigger handler** after logging, so the
   execution shows as Failed and Google notifies the trigger owner. Nothing has
   advanced; the next run covers the window.
8. **Totals include `עודכן` rows** at their current amount (the mail explains
   what the mark means). They are what was recorded in the window.
9. **The new section sits before the missing-patient diagnostic section**, not
   at the end of `Code.gs`: that section's and the reconciliation report's
   guard tests treat everything from their banner to the end of the file as
   theirs (functions only), and this section has `const`s.

## Tests

`test/ortal-daily-digest.test.js` — **32 tests**, running the real `Code.gs` in
a `vm` sandbox: weekday gating (incl. the 23:30 UTC edges, summer and winter),
the window and its boundaries, the first run, Sunday covering Thu→Sat, once per
day, void/unpaid/historical excluded, `עודכן`, totals, the row fields, the
heartbeat, CC on/before/after `DIGEST_CC_UNTIL`, missing/malformed/injected
`DIGEST_TO`, the watermark on send failure / busy lock / preview / test send,
HTML escaping, line-forging in plain text, no phone and no id, the allow-list,
read-only against the spreadsheet, the ledger's chunking and pruning, trigger
idempotency, `authorizeDigestNow`'s first statement, no HTTP route, the scopes,
and the section's declarations.

Full suite: **1745 / 1745**.

## Files

| file | change |
|---|---|
| `apps-script/Code.gs` | new section "Ortal's daily payments digest" (constants + functions only; no existing function changed) |
| `test/ortal-daily-digest.test.js` | new |
| `CHANGELOG-ortal-daily-digest.md` | this file |
| `EZONE-ECOSYSTEM-STATUS.md` | a short section listing the new Script Properties and setup order |
