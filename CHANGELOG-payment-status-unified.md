# One payment status for «מטופלים» and גבייה

October 11, 2026. **Railway + Code.gs** (clasp CI on merge; Code.gs is in its
own commit). No column, sheet, Script Property, env var or trigger. No data is
written. SW `CACHE_VERSION` v59 → **v60** (live and base are v59 after the
tab-order PR, `CHANGELOG-tab-order.md`, merged; v17 stays burned).

## Symptom

Patients who had already paid still showed «דווח תשלום» / «שולם חלקית» on
«מטופלים», as if the payment never synced, while גבייה listed the money.

## Investigation (top to bottom, against the live sheet on 11/10/2026)

**How a payment is stored.** A Payments **cycle row** has the deterministic id
`pay::<houseId>::<name>::<entryDate>::<dueDate>` and `patientId` = the triple
`<houseId>::<name>::<entryDate>`. Since PR #139 it also carries `patientUid`
(the Patients row id, server-resolved from an exact triple match, blank when
that fails). Each «דווח תשלום» appends a **receipt row** (`rcpt-…`) and the
server re-derives the cycle's `amountPaid` / `balance` / `status` from its
receipts (`recomputeCycleFromReceipts_`). There is no phone on a payment row.

**How the client reads it.** `getPayments` → `state.payments` (the cycles,
derived) and `state.receipts`.

**Where the two tabs diverged.**

| Screen | How it found a patient's cycle |
| --- | --- |
| גבייה (open balances, revenue, reconnect) | `matchPatientForPayment`: uid → exact triple → normalized triple → house + name (each tier refuses ambiguity) |
| «מטופלים» card (`patientPaymentState`) | **only** `x.id === paymentId(patient, due)` — the id built from the patient's **current** triple |
| גבייה due list (`paymentForPatientOnDate`) | the same exact id, else an unpaid placeholder |

So any change to the triple after the row was written split the answers:

| Live case | Row | What happened |
| --- | --- | --- |
| נועם שני — moved הפרדס → עפרוני on 11/10 | Payments row 112 `pay::pardes::נועם שני::2026-09-02::2026-10-02` (uid `id-b5c25da3…`) | «מטופלים» built `pay::arfoni::…` → not found → «לא שולם» + «דווח תשלום»; a new report would have opened a **second** cycle |
| ערן → admitted as «ערן יצחק חונה» (lead `id-thozv9t9mseaelvd`) | Payments row 45 `arfoni::ערן::2026-08-09`, no uid | money reported under the **lead's** name; no tier could attach it (name ≠, house_name 0 hits) |
| עדי → admitted as «עדי עמית» (lead `id-pttfoqobmt9x5yzu`) | Payments row 86 `rehab::עדי::2026-09-14`, no uid | same |
| עמית יעקובי — lead admitted, **no Patients row** | Payments row 76 | truly unattached (one of the paid leads with no patient record) |

**Cross-check with the reconciliation findings.** Of the three unattached
rows (45, 86, 76), rows 45 and 86 are lead-name payments whose patient exists
and points back at that lead through `fromLead` — they now attach. Row 76
stays unattached: its lead (עמית יעקובי, admitted 07/09) has no patient. It is
also one of the 8 paid leads with no patient record (reconciliation section A).
Those 8 need an admission or a «לא רלוונטי» decision by a person; no code
change can invent their patient record.

**Not the cause here:** phone normalization (payments carry no phone), status
read from the lead (it never was). The «שולם חלקית» on אליהו חן is a
**different** root cause — the cycle's expected amount — see
`CHANGELOG-cycle-balance.md` (PR C).

## The fix

1. **Tier 5 — `lead_link`** in `matchPatientForPayment` (app.js) and
   `recMatchPatient_` (Code.gs, parity-tested). A row whose triple names
   **exactly one** lead (house + normalized name + entryDate, all exact)
   attaches to the **one** Patients row whose `fromLead` is that lead's id.
   Two leads, two patients, a different entry date → no match. fromLead
   uniqueness is checked over the full patient list, so a narrowed list cannot
   hide a second claimant. No fuzzy matching anywhere.
2. **ONE lookup for a patient's cycle** — `patientCycleRecord(patient, due)`:
   the exact id first, else every cycle row due that day that the matcher gives
   to this patient (live before void, own uid before a triple). Used by:
   - «מטופלים» — `patientPaymentState` (the badge and the «דווח תשלום» button)
     and `patientHasReportedPayment` (the «לא דווח תשלום» chip, via
     `paymentBelongsToPatient`);
   - גבייה — `paymentForPatientOnDate` (the due list, the renewal / overdue
     alerts, and the «דווח תשלום» target — a report now lands on the existing
     cycle row instead of opening a second one);
   - בקרת גבייה — its patient-level debt («חובות מעל 60 יום») is built by
     Code.gs `debtAging_` over `recModel_`'s `payOwner`, which now uses the
     same five tiers.
3. Fail-closed throughout: an ambiguous row belongs to nobody and stays on
   «שיוך תשלומים» for a person.

## Data

No repair function is needed and nothing was written. Rows 45 and 86 attach by
the new tier on the next load. Row 76 and the 8 paid-lead-without-patient
records need a human decision on «שיוך תשלומים» / the leads board.

## Tests

- New `test/payment-status-unified.test.js` (7): lead payment counted after
  admission; uid-linked row after a house move (and a report targets it);
  unmatched row stays unattached and is flagged; two leads / two patients /
  narrowed list / other entry date attach nothing; U+FFFD names crash nothing
  and never match a clean name; the one-function wiring; Code.gs parity.
  Six of the seven fail on the previous app.js.
- `test/detached-payments.test.js` — tier list now has five entries.
- `test/dashboard-perf-assets.test.js` — pins v60.
- `test/refund-logic-wiring.test.js` — unchanged here: the clock fix landed
  with the tab-order PR (#216).
