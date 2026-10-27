# B2 — system events dual-written into `Activity`, behind a kill switch — 2026-10-27

CRM restructure, Session B (`docs/crm/ROLLOUT.md` §B2). **Default OFF**: until the Script Property
`ACTIVITY_WRITES` is set to `on`, nothing changes in production.

## Design: one hook, one allow-list
Every state change in the Dashboard already audits itself through `logAudit_` — after its primary
write, inside its own script lock. B2 adds ONE hook there: `activityFromAuditBestEffort_` maps the
audit action through `ACTIVITY_AUDIT_MAP` and appends the event. Unmapped actions (edits, refusals,
repairs, dedupes) write nothing — the map is the allow-list.

| Audit action | Activity kind | Links | eventId |
| --- | --- | --- | --- |
| `lead_moved_irrelevant` / `lead_restored` / `lead_removed` | `lead_closed` / `lead_restored` / `lead_removed` | leadId | kind:leadId(:disposition):second |
| `lead_created_from_therapists` | `lead_created` (`app:therapists`) | leadId | kind:leadId |
| `patient_discharged` | `patient_discharged` | patientId, leadId, houseId | kind:patientId:disposition:second |
| `patient_discharged_by_coordinators` | `patient_discharged` (`app:coordinators`, actorId = session actor) | patientId, leadId, houseId, dischargeId | kind:patientId:dischargeDate |
| `patient_restored_to_lead` / `patient_restored_active` | same names | patientId, leadId | kind:patientId:newLeadId / :second |
| `patient_moved_house` | `patient_moved_house` | patientId, houseId (= to) | kind:patientId:from:to |
| `payment_reported` | `payment_reported` | paymentUid, patientId | kind:receiptId |
| `payment_confirm_confirmed` / `_flagged` / `_reported` | `payment_confirmed` / `payment_flagged` / `payment_unconfirmed` | paymentUid, patientId | kind:paymentId(:second) |
| `payment_void_reversed` | `payment_void_reversed` | paymentUid, patientId | kind:paymentId:second |
| `credit_auto_created` / `credit_paid` / `credit_exception_approved` | `refund_auto_created` / `refund_paid` / `refund_exception_approved` | patientId | kind:patientId:ids / :id |

- `source` = `system:<writer fn>` unless the map names a sibling app. `actorName` = the audit actor
  (else `updatedBy` / `by`). `details` keeps ids and codes only — never names, notes, amounts.
- **Idempotent:** a retry with the same identity adds no duplicate. Actions with no natural identity
  (a restore, a reversal, a close) key on the audit second — a same-second replay dedupes.
- **Best-effort:** a failing Activity write (or a failing PropertiesService) is logged
  `[activity] …` and never fails, delays or reverts the primary write or its answer. The hook runs
  after the audit row, outside its try, and uses the writer's lock (no re-entrant lock).

## Kill switch
Script Property **`ACTIVITY_WRITES`** — exactly `on` enables; unset / anything else = zero writes.
Click-steps in `DEPLOY.md`. Instant rollback: delete the property.

## Files
`apps-script/Code.gs` (clasp CI on merge), `test/activity-system-events.test.js` (10),
`test/activity-foundation.test.js` (wiring guard updated), `EZONE-ECOSYSTEM-STATUS.md`,
`DEPLOY.md`, `docs/crm/ROLLOUT.md` §B2. No frontend, no SW bump, no schema change, no Railway
variable, no sibling-app contract change.
