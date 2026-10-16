# FIN-01 document requests and issuance evidence

October 16, 2026. Source baseline: `2a2f9b5fa2ffe7e8c4cd1f3059cbcb0b71c0c983`.

## Current behavior and the missing link

The `Payments` receipt is an internal **payment report**, not an accounting
receipt issued by Hashavshevet. `invoiceWanted` and `invoiceTo` record a request
and addressee. `reference` is the payment's transfer/reference value. Neither
it nor `confirmStatus`, `controlNote`, the row ID or `paymentUid` proves that an
accounting document was issued.

| Existing boundary | Current evidence | Consequence |
| --- | --- | --- |
| `reportPayment_`, `editReceipt_`, invoice field helpers | Explicit yes/no request and addressee; edits validated | A request may change; it is not a document record |
| `billingControlReceipt_` | Allow-listed request fields and verification status, without stable internal UIDs | Display existing requests without expanding access |
| `confirmPayment_` | Bank/credit verification, including partial and flagged states | Confirmation must not close a document request |
| `accountingInvoice_` and `accountingPayments` | Request/addressee only | No present issued-document source or evidence reader |
| `followupRows` and reminder delivery | Collection/verification work | No document reminders added by this change |

## Review surface in this change

Billing Control gains a collapsed Hebrew RTL section, **בדיקת בקשות חשבונית**.
It reads the existing queue with no new data call or source write:

- `yes`: requested; display addressee and payment verification separately.
- Blank or invalid choice: unknown; visible through a separate filter and
  always counted in the section's overall unknown count.
- `no`: outside this invoice-request list. This is **not** an exemption from
  issuing a receipt or another accounting document.
- Issuance status is **not recorded in this app** for every displayed row.
  Do not label the document missing, overdue, issued or unnecessary.
- Include all report periods, independent of the verified-month filter.
  House and request-kind filters narrow the list, not the overall counts.
- A confirmed payment remains in the list. A void/duplicate report is not an
  active request. Unknown dates remain visible; no deadline is invented.
- Stale/unavailable/malformed data is visible and cannot produce an all-clear
  claim. Duplicate report IDs are excluded with an incomplete-data warning.

This is review support, **not completed issuance tracking**. Ortal checks the
accounting source; this screen does not yet record that check. No request is
automatically closed and no old report is backfilled as issued. User access,
bank verification, money calculations, exports and outgoing mail are unchanged.

## Completion contract for the next write-enabled increment

The following is a proposed implementation contract, not a live schema or an
assertion about accounting obligations. Hashavshevet remains the authoritative
accounting record. Do not implement an issuance action inside the Dashboard.

1. Record source, issuing entity/book, document type, exact number (text,
   preserving leading zeros), issue date, and the source payment/report links.
   A document number alone is not a globally unique key.
2. Bind to stable source identity. Resolve `paymentUid` server-side from the
   existing report under authorization; do not trust a client-supplied UID or
   silently fall back to patient name, amount or row position. Missing or
   ambiguous identity blocks the write and remains visible for investigation.
3. Support more than one document per report and a document linked to more
   than one report. Linking is not a financial allocation and does not alter
   balances or verified revenue. Partial coverage remains explicit.
4. Separate source-verified evidence from a manual staff attestation. If manual
   entry is selected, label it as Ortal's recorded check, with server actor/time;
   do not claim an independent Hashavshevet match. A bank reference or free-text
   note is insufficient. No attachment upload or retention is introduced.
5. Reuse the existing controller/approver authorization boundary; Vered may see
   permitted work but cannot verify issuance. Narrow the new server operation
   explicitly in both authorization layers before exposing a control.
6. Record immutable evidence events with idempotency and an expected revision.
   Corrections/revocations reference prior events and preserve history. Validate
   before writing; ambiguous save responses reconcile by request ID before a
   retry. No silent last-write-wins or destructive document cancellation.
7. Editing an invoice request/addressee, voiding a payment report, revoking a
   linked document, partial coverage or conflicting evidence requires review;
   none automatically alters or cancels an accounting document. Request
   completion never closes collection/verification work or resets its date.
8. Completion requires the agreed evidence source plus an authorized explicit
   check of the linked request. Legacy rows remain unknown until checked.

### Source decision before the write-enabled increment

The evidence-capture source remains open: an agreed Hashavshevet export/API,
or explicitly labelled manual recording by Ortal from that system. The current
repository contains neither an issued-document feed nor an approved mapping of
document type/entity/number. No accounting credentials or private documents are
needed to deploy the read-only review surface. A manual/source choice is required
before claiming completed document tracking, not before this review surface.

### Acceptance cases for that increment

Requested/legacy/no-choice reports; full/partial/flagged verification; repeated
numbers across entity/type/year; leading zeros; multiple links; incomplete
coverage; stale concurrent edits; lost save response; append failure; unauthorized
attempts; request edits after evidence; void/reversal; conflicting/missing source
identity; source unavailable; no retrospective completion; unchanged money and
reminder behavior. Use synthetic data until a separately authorized live check.

## Release scope

This candidate changes the frontend and its static asset route only. Cache v71
is based on verified live v70 on October 16. No Apps Script deployment, migration,
trigger or new flag is required. It remains a draft until separately approved.
The existing reminder activation in #242 remains in effect; first eligible mail
date is October 18, conditional on actionable work. Inbox arrival is unverified.
CRM #220 remains draft at `a63c477`; its numeric-ID compatibility issue is open.
Broader security, speed, backup/recovery and FIN-02–04 work remain separate.
