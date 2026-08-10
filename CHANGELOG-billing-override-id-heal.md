# Billing override: patientId heal + single-identity-source workers

Fixes the second live bug after #81: a **due-list** unpaid row (מעיין אברהמי,
exact-day match, לא שולם) still showed no ✏️.

## Root cause (investigated first)

`amountEditable`'s inputs, checked one by one:
- `state.mode` timing — ruled out: `enterApp` sets `'edit'` before any load or
  render; no billing render precedes it.
- `payment.status` — ruled out: `normalizePayment` aliases every known status
  and defaults unknowns to `'unpaid'`.
- **`patientMatched` — the culprit.** The #81 guard required
  `patientKey(patient) === payment.patientId`, but live sheets contain records
  whose **id is well-formed while the `patientId` CELL is blank** — the
  codebase already knew this (`recompute()` backfills it on save;
  `findPatientForPayment` has fallbacks for it), yet the guard used strict
  equality against that unreliable field. Tests always populated it; live data
  didn't. Blank ≠ non-empty key → no pencil. Worse: for such records the
  override machinery was internally split — `hasOverride`/`applyBillingOverride`
  looked up by the (blank) `payment.patientId` while `saveBillingOverride`
  wrote under `patientKey(patient)` — a saved override could never overlay.

## The fix

1. **Heal at the normalization boundary** — `normalizePayment` derives a blank
   `patientId` from the deterministic id
   (`pay::<houseId>::<name>::<entryDate>::<dueDate>` → middle three parts).
   Non-blank cells are preserved verbatim; unparseable ids stay blank (true
   orphans). One heal fixes every consumer: the editor guard, the overlay
   lookup, the override write, and `findPatientForPayment`.
2. **Constructive due-row match** — `patientMatched = !isCarryForward || …`:
   a due-list payment was looked up (or built) from an id derived from that
   very patient; the equality check is redundant there. Carry rows keep the
   (now heal-assisted) equality guard, so true orphans still get no editor.
3. **Single identity source on WRITE (approved addition)** —
   `saveBillingOverride(payment, amount)` / `clearBillingOverride(payment)` now
   read **both** key parts from the normalized payment record itself:
   `payment.patientId` + `monthKey(payment.dueDate)` — the exact keys
   `applyBillingOverride` looks up with. The workers never recompute
   `patientKey(patient)`, so the save-key and the lookup-key **cannot diverge
   again** — even for a stale (non-blank, wrong) stored id, both sides use the
   same value by construction. A record with no resolvable identity is refused
   (no write).

## Tests — `test/billing-override-id-heal.test.js` (7 new)

- Heal: blank patientId derived from a well-formed id (Hebrew status still
  normalizes); non-blank preserved verbatim; malformed id stays blank.
- The live bug pinned: a due-list unpaid row backed by a blank-patientId
  record renders the ✏️ again.
- **The required round-trip: an override saved for a HEALED record overlays
  that record** (save-key = healed `payment.patientId`, month from
  `payment.dueDate`; the very next `paymentForPatientOnDate` shows the
  override; clear restores base through the same keys).
- Single-source pinned for STALE ids: the worker writes the record's own id
  verbatim and the overlay finds it — consistent by construction.
- Worker identity guard (no write without a resolvable id); malformed-id carry
  orphans still non-editable.

Signature updates in the two existing billing-override test files (workers now
take the payment record) — behavior assertions unchanged.

Full suite: `npm test` — **462 pass, 0 fail** (455 + 7).

## Deploy

Frontend only. After merge: מעיין אברהמי's due-list row shows the ✏️; editing
writes the override and the row immediately reflects it (badge + יתרה), ↩
restores base — including on records whose patientId cell was blank.
