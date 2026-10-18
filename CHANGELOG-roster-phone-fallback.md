# Roster phone recovery — retroactive fix (2026-10-18)

Problem: house patients with no usable `fromLead` link shipped an empty phone in `getAdmittedRoster` / `getDischargedRoster`, so the Therapists app listed them as «ללא טלפון תקין» and could not link them to OUT or the alumni list (28 of 37 active patients).

Fix (read-only, applies to every existing patient at once): when the lead link yields no valid phone, use the phone of the Leads row with the SAME NAME — only if that name's rows carry exactly ONE distinct valid phone (duplicates of one person agree). Two different phones = ambiguous → stays blank. A `fromLead` phone always wins.

- No sheet/column change, nothing written. Projection of both feeds unchanged.
- Tests: `admitted-roster.test.js`, `discharged-roster.test.js`.
- Remaining blanks need the phone added to the patient's lead in the Dashboard.
