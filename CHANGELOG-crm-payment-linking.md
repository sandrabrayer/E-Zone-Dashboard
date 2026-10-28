# C18 — «שיוך תשלומים» in the CRM — 2026-10-28

CRM restructure. Flag-gated. No Code.gs, no server change, no SW bump. Classic contract reused.

- «גבייה» gets a «שיוך תשלומים» block: the payment rows that match no current patient and carry
  no decision — `debtAging.detachedPayments.rows` with reason `unmatched` (rows already marked
  «לא מטופל/ת» stay out). Name as stored, house, due date, amount, received.
- **שייך** → a candidate list of every patient (released included), ranked: same house, look-alike
  name (exact after trimming invisible marks, prefix, or a shared word), entered before the payment,
  in-house first; the top candidate is preselected only when house + name both match. Saves the row
  **as read from getPayments** with `linkPatientUid = <uid>`, `linkStatus = 'linked'`,
  `linkNote = ''` through `savePayment` (Code.gs `upsertPayment_` validates, stamps linkedBy /
  linkedAt, refuses a link without a uid). Accepted only when the server echoes the row with the
  status asked for.
- **לא מטופל/ת** → `linkStatus = 'not_a_patient'` + a required reason (2–120), same `savePayment`.
- After either decision the three billing reads refresh. Voiding a duplicate row and the advanced
  reconnect screen stay classic (link renamed «כפילויות ותיקוני שורות»).

Tests: `test/crm-shell-ui.test.js` +1 (rows, name matching, candidates + reasons, bodies, errors,
acceptance); `test/crm-shell-browser.test.js` +1 Chromium scenario (preselection, link body with the
row as read, reads refresh, reason required for «לא מטופל/ת»).
Files: `public/crm/crm.js`, tests, ESS, `docs/crm/ROLLOUT.md`.
