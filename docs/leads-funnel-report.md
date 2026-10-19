# «חתכים בלידים» — exact counting rules

Source: `lib/leads-funnel.js` (`funnel`). Data: the existing getData payload, with no extra read.

## Population
- The leads on the board (any stage, incl. `admitted`) plus the closed leads (לידים לא רלוונטיים). When the same id appears twice, the first copy wins (board before closed).
- Out: soft-removed leads (הסרה) and `source: 'direct_admin'` rows (the intake phone records, which are not leads).
- **Period:** `created` (YYYY-MM-DD, or the first 10 chars of a timestamp) is in `[from, to]`, both inclusive. A lead with no valid `created` is never counted; the panel shows how many there are.

## Buckets (mutually exclusive, first match wins)
| # | Bucket | Rule |
|---|---|---|
| 1 | נכנסו לבית | some Patients row or discharged-audit row has `fromLead === lead.id` (any status), or `stage ∈ {admitted, entered, entry}` |
| 2 | לא רלוונטי | a closed lead with `computeDisposition(lead) === 'not_relevant'` (legacy rows: an empty disposition maps through `not_relevant_reason`) |
| 3 | הגיעו לפגישה ולא נכנסו | not 1 or 2, and any of: `visitDate` set, `stage ∈ {visit, waitlist, paid}`, `meetingReportedAt` set |

A lead that matches none of the three (e.g. a new lead with no meeting yet, or one closed as `stopped_early` without a meeting) counts only in the period's population.

Why «entered» comes first: a patient record is ground truth. A lead later closed for any reason was still admitted.

## Presets
- החודש: the 1st of this month → today.
- החודש הקודם: the whole previous calendar month.
- 3 חודשים אחרונים: the 1st of the month two months back → today.

"Today" is the Asia/Jerusalem date.
