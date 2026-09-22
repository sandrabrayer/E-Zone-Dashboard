# Accounting source feed — stable payment identity, a charge stamp, a read-only endpoint

**Why:** an external accounting-control app has to reconcile what Vered
reported as collected against what actually reached the bank. To do that it
needs three things this repo did not have: a key on each payment that survives
every legitimate edit, a record of **who reported it paid and when**, and a way
to pull the data incrementally.

**Vered's workflow is unchanged.** She marks a payment paid, exactly as before.
There is no new screen, no confirmation step, no queue, no invoice, no accounting
state in Dashboard at all — Ortal's verification lives entirely in the accounting
app. `public/app.js`, `public/index.html`, `public/style.css` and `server.js` are
**untouched by this change**.

---

## 1. The problem with the keys we had

`Payments.id` is `pay::<houseId>::<name>::<entryDate>::<dueDate>`. It is a good
in-app key — the same monthly payment always upserts into the same row — but it
is a **derived** key: correcting a patient's name or re-dating a cycle produces
a *different* id for the *same money*. An accounting app that had already
verified that payment would see a new record and a vanished one.

`Payments.patientId` is the billing triple `houseId::name::entryDate` — same
problem. `Credits.id` is `credit::<patientId>::<allocationMonth>::<seq>`, a
composite of mutable inputs plus a mint-time row count.

And nothing on a payment row said who reported it or when. `timestamp` is the
**client's** clock and is rewritten on every save, including saves that change
nothing.

## 2. What shipped

### A. Schema — append-only, seven columns on Payments, one on Credits

`PAYMENT_COLUMNS` (position IS the data contract — `readSheet_` maps by
position, so the twelve existing columns are untouched and the new ones go at
the END):

| column | meaning |
|---|---|
| `paymentUid` | `pmt-<uuid>`. **Minted once, then permanent.** Never derived at read time, never re-minted, never disturbed by a name / date / amount / status change. |
| `patientUid` | the **persisted Patients `id`**. Resolved once by an EXACT match of this row's billing triple against the same triple computed from the Patients sheet. Never a name lookup. Unresolvable → **blank**, never guessed. |
| `payerUid` | **reserved, always blank** — see §4. |
| `chargedAt` | server-generated Israel-time timestamp with an explicit offset. See §3. |
| `chargedBy` | the authenticated user from the **signed session cookie**. |
| `sourceUpdatedAt` | server Israel-time stamp of the last write that actually **changed** the row. |
| `sourceVersion` | integer, incremented by that same write. |

`CREDIT_COLUMNS` gains `creditUid` (`crd-<uuid>`) at the END, same rules.
**The existing `id` schemes are unchanged** — billing overrides, the
orphan-payments reconcile, the nightly integrity job and the client all still
key on them, and a keyed migration is a separate change.

A new sheet, `PaymentsTombstones`, records deleted payment rows (§5).

### B. Backfill — the locked pattern from PR #112, to the letter

`backfillPaymentIdentityLocked_` / `backfillCreditUidsLocked_` follow
`backfillPatientIdsLocked_` exactly:

- **pre-scan without the lock**; if nothing is missing it performs **zero
  writes and takes no lock** — the steady state after the first read;
- only when something is missing does it take the **script lock** and re-read
  inside it, so a concurrent upsert cannot shift rows under the writes;
- **per-cell writes**, never a whole-sheet rewrite;
- **idempotent** — a second run fills 0, and a value already present is never
  overwritten;
- fully-empty trailing rows are skipped.

It runs on the read paths (`getPayments_`, `getCredits_`, and the accounting
endpoint) — the same place `getData_` heals the Patients `id` column. It mints
identity and **nothing else**: it never touches an amount, a status, a date or
a charge stamp.

**One deliberate addition to the pattern: the mint is bounded at
`IDENTITY_BACKFILL_MAX_PER_RUN` (1000) cells per invocation.** The Patients
backfill needs no such bound — that sheet holds tens of rows — but Payments
holds a row per patient per month for years, and the per-cell writes this
pattern mandates are ~20ms each. An unbounded first read after deploy could run
into the Apps Script 6-minute execution limit, and `getPayments_` is the read
behind Vered's גבייה tab: a timeout there looks exactly like an outage.
Bounded, it converges over the next few reads and then performs zero writes
forever. The feed reports `identityPending` so a caller can tell (see §3).

It is deliberately **not** run inside `runOrphanPaymentsReconcile_`: that
manual repair guarantees "single-cell writes to the three identity cells only"
and "a dry run performs zero writes", and minting inside it would widen both.
*Operational note: open the dashboard once before running that repair, so every
row already carries its uid.*

### C. `chargedAt` / `chargedBy` — the PR #113 stamping rule, applied to money

Stamped by `stampPaymentRow_` (pure, and unit-tested on its own) when the row
is `paid`/`partial` **and** either

- it was not `paid`/`partial` before — a real report event; or
- `amountPaid` **moved** — a correction the accounting app must re-verify.

Otherwise the sheet's values are **carried unchanged**. Everything the server
owns is decided against the **sheet row**, never the payload: a hand-built POST
cannot set its own uid, its own charge stamp or its own version
(`PAYMENT_SERVER_COLUMNS` are deleted from the payload before anything reads
it), and `chargedBy` comes from `requestUser_`, i.e. the name inside the signed
session cookie that the Railway proxy injects. A client-supplied name never
reaches the sheet.

Consequences, all locked by tests:

- **historical rows stay blank.** A legacy paid row's stamp is `''` on the
  sheet; a later edit that reports the same figure carries that `''` forward.
  No stamp is ever derived from `timestamp`, `dueDate` or anything else —
  nobody recorded who reported those rows, and inventing an answer would be a
  lie an accountant would act on.
- **reads never stamp.**
- reverting a row to `unpaid` **clears** the stamps (a row reverted to unpaid
  was not reported paid, and "stamped but unpaid" is a state no reader should
  have to interpret). The `sourceVersion` bump is what tells the accounting app
  the record changed after it confirmed.
- the legacy Hebrew status labels (`שולם`, `שולם חלקית`) are normalized
  server-side by `paymentStatus_` — without that, an unrelated edit to a legacy
  row would have read as "not previously paid" and stamped it.

> ### `chargedAt` means **"reported paid by Vered"** — NOT "confirmed in the bank".
>
> It is the moment a dashboard user set the row to paid/partial. Dashboard
> stores no bank confirmation and never will; that is the accounting app's
> half of the job. Treat `chargedAt` as a claim to be verified, not as proof.

### D. `sourceUpdatedAt` / `sourceVersion`

Both move together, and only on a real content change (or an insert).
`PAYMENT_VERSION_IGNORED_COLUMNS` excludes the bookkeeping columns **and the
client's `timestamp`** — a version that ticked on every no-op save would hand
the accounting app a queue full of rows that did not move. `patientUid` is
deliberately *not* excluded: healing a blank patient link is a change the
accounting app must see.

---

## 3. The endpoint

### URL and actions

The Dashboard Apps Script web app `/exec` URL (the same one the Railway proxy
uses; ask Sandra — it is not in this repo). Two **read-only** actions:

| action | returns |
|---|---|
| `accountingPayments` | source payment records + deletion tombstones |
| `accountingCredits`  | the authoritative credit list |

`GET` or `POST`; `doGet`/`doPost` both route through `handle_`.

### Authentication

A **single shared secret in its own Script Property, `ACCOUNTING_SECRET`**,
passed as `secret`. It is separate from `ADMITTED_ROSTER_SECRET` and
`MEETING_REPORT_SECRET`, so it unlocks nothing else and can be rotated on its
own. **Fail-closed**: unset or mismatched → `{ "ok": false, "error":
"unauthorized" }`, never data — the discipline every authenticated endpoint in
this repo follows.

Set it once, in the Apps Script editor → Project Settings → Script Properties.
Send it in the **POST body**, not the query string, wherever the caller can:
a URL lands in logs.

### Example request

```bash
# Full sync, first page
curl -sS -L \
  -X POST "$DASHBOARD_EXEC_URL" \
  -H 'Content-Type: application/json' \
  -d '{"action":"accountingPayments","secret":"'"$ACCOUNTING_SECRET"'","limit":200}'

# Incremental, from the previous sync's watermark
curl -sS -L \
  -X POST "$DASHBOARD_EXEC_URL" \
  -H 'Content-Type: application/json' \
  -d '{"action":"accountingPayments","secret":"'"$ACCOUNTING_SECRET"'",
       "updatedSince":"2026-09-21T00:00:00+03:00","limit":200}'

# Next page
curl -sS -L \
  -X POST "$DASHBOARD_EXEC_URL" \
  -H 'Content-Type: application/json' \
  -d '{"action":"accountingPayments","secret":"'"$ACCOUNTING_SECRET"'",
       "cursor":"1789030800000|pmt-8f2c…","limit":200}'
```

`-L` matters: Apps Script `/exec` answers with a redirect to
`script.googleusercontent.com`.

### Parameters

| name | default | meaning |
|---|---|---|
| `secret` | — | required; see above |
| `updatedSince` | absent = **full sync** | ISO-8601 with an offset. **Inclusive.** Rows whose `sourceUpdatedAt` is at or after it. Historical rows (blank `sourceUpdatedAt`) are **excluded**. A value that cannot be parsed is **refused**, never silently treated as a full sync. |
| `cursor` | absent = first page | **opaque** — do not parse it. Pass back `page.nextCursor` verbatim. |
| `limit` | 200 | clamped to 1…500. |

### Example response

```json
{
  "ok": true,
  "sourceApp": "ezone-dashboard",
  "schemaVersion": 1,
  "serverTime": "2026-09-22T14:03:11+03:00",
  "payments": [
    {
      "sourceApp": "ezone-dashboard",
      "sourceRecordId": "pay::arfoni::דנה כהן::2025-06-20::2026-04-20",
      "paymentUid": "pmt-8f2c…",
      "patientUid": "id-dana…",
      "payerUid": null,
      "patientName": "דנה כהן",
      "house": "arfoni",
      "dueDate": "2026-04-20",
      "amount": 3000,
      "amountPaid": 3000,
      "balance": 0,
      "currency": "ILS",
      "vatInclusive": true,
      "status": "paid",
      "statusRaw": "paid",
      "chargedAt": "2026-09-04T10:00:00+03:00",
      "chargedBy": "ורד",
      "coverageStart": "2026-04-20",
      "coverageEnd": "2026-05-19",
      "coverageSource": "inferred",
      "coverageDays": 30,
      "coverageAllocation": [
        { "month": "2026-04", "days": 11, "share": 0.366667, "amount": 1100, "amountPaid": 1100 },
        { "month": "2026-05", "days": 19, "share": 0.633333, "amount": 1900, "amountPaid": 1900 }
      ],
      "sourceUpdatedAt": "2026-09-04T10:00:00+03:00",
      "sourceVersion": 1,
      "historical": false,
      "deleted": false,
      "creditLinkBasis": "derived:patientKey+allocationMonth==dueDateMonth",
      "credits": []
    }
  ],
  "identityPending": 0,
  "tombstones": [],
  "tombstonesTruncated": false,
  "page": {
    "limit": 200,
    "count": 1,
    "hasMore": false,
    "nextCursor": null,
    "updatedSince": "2026-09-01T00:00:00+03:00"
  }
}
```

Field notes:

- **`coverageSource`** — `recorded` when the row carries an explicit
  `coverageStart`/`coverageEnd` (PR #135), `inferred` when the window is the
  default cycle `[dueDate, dueDate + 1 month − 1 day]`. Say which; do not imply
  a precision the row lacks.
- **`coverageAllocation`** — the existing day-by-day month split (the same rule
  the הכנסות חודשיות screen uses, PR #133). Shares sum to 1; the per-month
  amounts sum to the row total up to 2dp rounding.
- **`credits`** — a **derived** link, not a stored one: Dashboard has no
  payment↔credit foreign key. A credit is attached when its `patientKey`
  matches this row's billing key *and* its `allocationMonth` is this row's
  due-date month. A credit matching no payment row is still returned in full by
  `accountingCredits`, which is the **authoritative** list — dedupe on
  `creditUid`.
- **`historical`** — see §6.
- **`identityPending`** (top level) — rows still awaiting their permanent
  `paymentUid` because the bounded backfill has not converged yet (see §2B).
  **Non-zero means: do not treat this sync as complete.** Such rows come back
  with `paymentUid: null` and must not be imported under a substitute key —
  read again until it reaches 0, which it then stays at forever. In practice it
  is 0 from the first call on any sheet under ~1000 payment rows, and within a
  few calls on larger ones.

`accountingCredits` returns `credits: [...]` with the same `page` block:
`sourceRecordId`, `creditUid`, `patientUid`, `patientKey`, `payerUid`, `house`,
`creditType`, `allocationMonth`, `calculatedAmount`, `amount`, `currency`,
`vatInclusive`, `status`, `decidedDate`, `payoutDate`, `paidDate`,
`sourceUpdatedAt`, `sourceCreatedAt`.

### VAT

**Every amount is VAT-inclusive at the source** — `pay`, `Payments.amount`,
every credit, the allocation buckets. That is this repo's convention
throughout; displays divide by 1.18 locally. The feed performs **no** VAT
conversion and marks each record `vatInclusive: true`. **Do not apply a second
VAT conversion downstream.**

### Errors and retries

| response | meaning | what the caller should do |
|---|---|---|
| `{"ok":false,"error":"unauthorized"}` | secret unset or wrong | stop; alert a human. Do **not** retry in a loop — this is a configuration fault, not a transient one. |
| `{"ok":false,"error":"bad_updatedSince"}` | unparseable watermark | fix the caller. Do not fall back to a full sync — that is exactly how a queue gets flooded. |
| `{"ok":false,"error":"bad_cursor"}` | cursor not from this endpoint | restart the sync from `updatedSince` (the last good watermark). |
| `{"ok":false,"error":"unknown_action"}` | action typo | fix the caller. |
| `{"ok":false,"error":"exception","message":…}` | an Apps Script error | **retryable.** |
| HTTP 5xx / timeout / an HTML body | Apps Script quota, cold start or a transient Google error | **retryable.** |

Retry policy: exponential backoff, 2s → 4s → 8s → 16s, at most 4 attempts,
then stop and alert. Apps Script has per-day execution quotas — a tight retry
loop burns them and takes the dashboard down with it. Reads are idempotent, so
a retried page is always safe.

Every response is `application/json` and every error carries `ok:false`, so
check `ok` before `payments` — a 200 with `ok:false` is the normal refusal
shape here.

### Pagination and watermarks

Records are ordered by `(sourceUpdatedAt, uid)` ascending, with the timestamp
compared as an **instant**, not as a string (the autumn DST switch makes two
same-day Israel stamps sort wrongly as text). Walk pages until
`page.nextCursor` is `null`.

**Take the watermark for the next sync from the `serverTime` of the sync's
FIRST page, and apply it only after the last page succeeds.** A row edited
while you are paging moves to the end of the ordering and would otherwise be
missed; with that watermark it simply arrives in the next incremental run.
`updatedSince` is inclusive, so the boundary row may repeat — dedupe on
`(paymentUid, sourceVersion)`.

Deletion tombstones ride the **first page only** (no `cursor`), filtered by the
same `updatedSince`, capped at 500 with `tombstonesTruncated` if the cap is hit.
Deletions are rare, so they are not paginated.

### What is NOT in the feed

The projection is an explicit **allow-list**, not a filtered copy of the row.
Nothing from `Patients.notes`, the discharge note, the disposition, a meeting
report or a lead note can reach it. The credit projection deliberately drops
the free-text `reason`, `overrideReason`, `notes` and `basis` — they are
financial justification, but they are free text staff type, and free text is
where clinical detail leaks; the structured `creditType` says *why* without the
prose. A tombstone's `values` (the recovery copy of the deleted row) is never
served. `test/accounting-source-feed.test.js` seeds a clinical string into
`Patients.notes` and the credit free-text fields and asserts it appears nowhere
in either response.

`patientName` **is** included: accounting cannot match a payment to a party
without it, and it is administrative, not clinical. The admitted-roster
endpoint already exposes names under the same shared-secret discipline.

---

## 4. `payerUid`: nullable, and the accounting app owes a crosswalk

**Dashboard has no payer or billing-party entity.** Nothing in any sheet
records who actually pays for a resident — a parent, a fund, a municipality, an
insurer. There is no field to expose and no honest way to derive one; inferring
a payer from a patient's name would be a guess presented as a fact.

So `payerUid` is present in the contract and **always `null`**. The accounting
app needs its **own explicit crosswalk** from `patientUid` → billing party,
maintained on its side. If Dashboard ever grows a payer entity, this field is
where it lands — the contract does not have to change.

---

## 5. Deletions

Nothing in the dashboard UI deletes a payment. The single delete path in the
whole repo is `runOrphanPaymentsReconcile_`'s stray-twin removal — a manual
repair run from the Apps Script editor (PR #119). Until now that delete left
only an `AuditLog` entry, which no external reader can page through.

Every such delete now also appends to **`PaymentsTombstones`** *before* the row
is removed: `paymentUid`, `sourceRecordId`, `patientUid`, `houseId`, `dueDate`,
`amount`, `amountPaid`, `status`, `deletedAt` (Israel time), `deletedBy`,
`deletedByFn`, `reason`, and `values` — a recoverable JSON copy of the whole
row, which the endpoint never serves. `deletedBy` is blank for an editor-run
repair: there is no signed session behind it, and a blank is honest where a
name would not be.

The sheet is created lazily. **No deletions ever → the sheet does not exist and
the feed simply reports none.** A read never creates it.

---

## 6. Telling the four cases apart

The accounting app must distinguish:

| case | how the feed says it |
|---|---|
| **new source payment, reported after activation** | `historical: false`, and `sourceUpdatedAt` ≥ the activation watermark. It appears in an incremental read. |
| **historical payment** | `historical: true`, `sourceUpdatedAt: null`, `sourceVersion: null`, `chargedAt: null`. It appears **only** in a full sync. |
| **source record changed after confirmation** | same `paymentUid`, a **higher** `sourceVersion` and a newer `sourceUpdatedAt` than the one you confirmed. A re-stamped `chargedAt`/`chargedBy` means the reported figure itself moved. |
| **deleted source record** | it appears in `tombstones` with `deleted: true`. (A record that is merely outside your `updatedSince` window is not deleted — it is simply unchanged.) |

**No accounting confirmation state is stored in Dashboard.** Which records have
been verified, by whom, and against which bank line, lives entirely in the
accounting app.

### How to avoid flooding the queue with historical rows

This is the failure mode to design against: activate the integration, pull
everything, and hand Ortal several years of already-settled payments to
"confirm".

**Do this, once, at activation:**

0. Call the endpoint once and check **`identityPending` is 0**. If it is not,
   call again until it is — the uid backfill is still converging, and importing
   a row whose `paymentUid` is null would defeat the entire point.
1. Run a **full sync** (no `updatedSince`) and store every record.
2. Import every record with `historical: true` **directly into a settled /
   opening-balance state**. Do not enqueue it for confirmation. These rows
   carry `chargedAt: null` precisely because nobody recorded who reported them
   or when — there is nothing for a human to verify against.
3. Record the `serverTime` of that sync as the **activation watermark**.

**Thereafter:** poll with `updatedSince=<watermark>`. Historical rows are
excluded from an incremental read *by construction* — a blank `sourceUpdatedAt`
is never ≥ any watermark — so only payments actually reported (or corrected)
since activation ever enter the queue. Advance the watermark from each sync's
`serverTime`, after its last page succeeds.

**Never fall back to a full sync on an error.** `bad_updatedSince` means the
caller is wrong; fix the caller. A full sync is an activation-time operation
(and a periodic reconciliation one), not a retry strategy.

A sensible poll interval is 15–60 minutes. Apps Script has daily execution
quotas shared with the dashboard itself; polling every minute buys nothing —
Vered reports payments a handful of times a day.

---

## 7. Conservative decisions, stated

1. **The existing `id` schemes are untouched.** Billing overrides, the
   reconcile, the integrity job and the client all still key on them. The uids
   are *additional* identity, not a replacement.
2. **`patientUid` joins on the full billing triple, never on a name.** That
   triple is the persisted billing identity a payment row already stores; the
   match is exact and whole. An **ambiguous** triple (two Patients rows, one
   key) links to **neither** — an ambiguous link is worse than none. No fuzzy
   match, no fallback, no partial match. Unresolved stays blank.
3. **`payerUid` is exposed and always null** rather than invented (§4).
4. **The charge stamp is never derived for historical rows** (§2C).
5. **A no-op save does not bump `sourceVersion`**, so the accounting app is not
   woken by saves that changed nothing.
6. **Two read actions, not one.** Credits also need a stable uid and an
   authoritative list, and nesting them only under payments would hide the ones
   that match no payment row. Both sit behind the one secret.
7. **The feed may mint identity, and nothing else.** That is the one write a
   read can cause; it is idempotent, locked, and does zero writes at rest. The
   alternative — serving blank uids until someone opened the dashboard — would
   have made the contract unreliable at exactly the wrong moment.
8. **Free-text credit fields are dropped** (§3), even though they are
   financial: free text is where clinical detail leaks.
9. **The identity mint is bounded per invocation**, and the feed reports how
   far it has left to go, rather than risking an execution-limit timeout on
   the read Vered's billing tab depends on.
10. **Tombstones are not paginated.** One manual delete path in the whole repo
   means the list is tiny; a cap plus a truncation flag is honest and simpler
   than a second cursor.
11. **`server.js` is untouched.** The accounting app talks to Apps Script
    directly, like the outpatient roster integration, rather than through the
    session-gated Railway proxy — the proxy exists for *browser* sessions.

### Known limitation (pre-existing, deliberately not changed here)

The Apps Script web app is deployed `ANYONE_ANONYMOUS`, so **anyone holding the
`/exec` URL can already reach the write actions** — true today of every
cross-app integration in this repo (ezone-outpatient holds the same URL for
`getAdmittedRoster`). This change adds **no write surface and no new
exposure**, but handing the URL to one more app widens who holds it. The proper
fix is a **separate deployment for cross-app reads**, whose script exposes only
the read actions. That is a deployment migration, not a column, and it is
follow-up work — not something to smuggle into this PR.

Also pre-existing and unchanged: the secret comparison is a plain string
compare, like every other secret check here, not a constant-time one.

---

## 8. Tests

`test/accounting-source-feed.test.js` — 56 tests, vm-sandboxed on the **real
shipped `Code.gs`**, TZ pinned to `Asia/Jerusalem`, with a fake clock so the
offset assertions mean what they say:

- **A** append-only columns on both sheets; the new text columns force-formatted
  at ensure and the original ten left alone; the server-owned set.
- **B** `paymentUid` backfill: mints one per content row, skips empty rows,
  **idempotent**, **zero writes and no lock** at rest, exactly one lock when
  needed, **single-cell writes only**, **bounded per run and converging**;
  the uid survives a name / due-date / amount / status change; a client may not
  choose its own uid or stamps; the same for `creditUid`, with credit behaviour
  unchanged.
- **C** `patientUid` persisted into the cell (not derived on read); unresolvable
  → blank; **same name, different house or entry date does not link**;
  ambiguous → neither; immutable once set; `payerUid` always null.
- **D** the Israel-offset stamp on both sides of the DST switch; stamping on
  paid and partial; blank on unpaid; **no re-stamp** for the same figure;
  **re-stamp when `amountPaid` moves**; a **historical row stays blank** even
  after a later edit; reverting to unpaid clears; **reads never stamp**; the
  pure rule tested on its own.
- **E** `sourceVersion` starts at 1, holds on a no-op save, ticks on a real
  change; healing `patientUid` counts as a change.
- **F** fail-closed with no secret; wrong / blank / missing refused with no data
  leak; the secret unlocks nothing else; **no write action is reachable** and
  neither endpoint function contains a write call; an authenticated read
  performs no business write.
- **G** paging visits every row exactly once; `updatedSince` inclusive;
  historical rows excluded from incremental reads; malformed watermark and
  cursor refused; `limit` defaulted and clamped; credits page independently.
- **H** exact allow-lists for both projections; VAT-inclusive and no VAT
  arithmetic in the feed; **a clinical string seeded into `Patients.notes` and
  the credit free-text fields appears nowhere**; linked credits and the stated
  link basis.
- **I** recorded coverage wins, inferred fallback, the straddling-window month
  split adds back up.
- **J** tombstone exposure, `values` never leaks, `updatedSince` honoured,
  first page only, the writer records and names the delete, and no sheet is
  created when there is nothing to record.

Guard tests updated for the appended columns (all still assert the original
positions are unmoved): `test/credits-ledger.test.js`,
`test/payment-coverage-period.test.js`, `test/orphan-payments-reconcile.test.js`.

**Full suite: 1344 tests, 0 failures.**

### Smoke test

```
npm run smoke:accounting
```

`scripts/accounting-smoke.js` runs the real shipped `Code.gs` against an
in-memory spreadsheet and drives the endpoint the way the accounting app will —
unauthenticated call, full sync paged three at a time, one record printed in
full, an incremental sync from a watermark, and a repeat read proving it writes
nothing. It exits non-zero if any of that breaks. (A live smoke needs the
`/exec` URL and `ACCOUNTING_SECRET`, neither of which is in this repo — use the
curl in §3.)

---

## 9. Deployment

1. Merge, then run the manual **Deploy Apps Script** workflow (repo policy —
   no auto-deploy trigger).
2. In the Apps Script editor → **Project Settings → Script Properties**, add
   `ACCOUNTING_SECRET` with a freshly generated value. Until it is set the
   endpoint refuses every request (fail-closed), which is the safe default.
3. Hand the accounting app the `/exec` URL and that secret — **not** the
   `ADMITTED_ROSTER_SECRET` or `MEETING_REPORT_SECRET`.
4. The first dashboard load (or the first authenticated feed call) after deploy
   mints every `paymentUid` / `patientUid` / `creditUid` under the script lock,
   up to 1000 cells per call. On a large Payments sheet it converges over the
   next few reads; `accountingPayments`' `identityPending` says how many are
   left. Every later read does zero writes.
   **Tell the accounting app to wait for `identityPending: 0` before its
   activation full sync.**
5. No Railway variable, no `server.js` change, no client change, no SW bump.
