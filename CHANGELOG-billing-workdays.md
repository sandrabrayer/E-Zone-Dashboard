# FIN-01.3 — owner workday age (review candidate, October 15, 2026)

Calendar age alone can make holiday eves and Vered's usual Thursday absence look
like working time. The read-only follow-up queue now shows both calendar days
and workdays for the responsible person, preserving the source dates and money.

Sandra clarified that neither colleague works holidays or holiday eves, and
Vered normally does not work Thursdays but can connect from home to handle work.
The implementation uses Ortal Sunday–Thursday and Vered Sunday–Wednesday.
Thursday remains available for remote actions and immediate completion echoes;
this calendar never grants permissions or disables actions on any day.

## Counting contract

- Count civil dates in `(openedDate, today]`, not working hours; same/future date
  gives zero. Receipt dates are already normalized to Israel time by the server.
- Use the existing original date when responsibility changes; no age reset.
- Exclude Fridays/Saturdays and the owner's nonworking weekdays, Rosh Hashanah
  (both days), Yom Kippur, Sukkot, Shemini Atzeret/Simchat Torah (Israel), first and
  seventh Pesach, Shavuot, observed Independence Day, and their preceding civil
  dates. Holiday eves are excluded in full.
- Chol HaMoed, minor holidays and fasts remain ordinary weekdays in this initial
  calendar. This is a company workflow calendar, not an employment-law rule.
- Supported and verified Gregorian range: 2020–2035. Missing/invalid dates,
  unknown owners, unsupported Hebrew Intl or dates outside the range return
  unknown and display an explicit unavailable label, never a false zero.
- Native Hebrew Intl avoids a new dependency or runtime network calls. Bounded
  per-year prefix counts cache only dates and counts, never customer data.

## Scope and verification

No Apps Script, finance totals, debt aging, source records, permissions, flags,
recipient settings, emails or triggers change. Funder waiting remains neutral;
work age does not activate an overdue threshold or escalation. Delivery time,
recipients and alert thresholds remain separate release work.

The independent golden fixture contains Hebcal Israel holiday dates for
2020–2035 (144 dates), retrieved October 15, 2026; attribution/source URLs are in
`test/fixtures/israel-work-holidays.json`. Every supported civil date for both
owners is compared against those dates and their eves, including Independence
Day shifts. API documentation: https://www.hebcal.com/home/195/jewish-calendar-rest-api
(Hebcal calendar data, CC BY 4.0). Further cases cover leap years, year boundaries,
DST, missing Intl, invalid dates, owner reassignment and Thursday completion.

The browser regression checks actual work-age labels, both Thursday counts,
source navigation, confirmation echo, neutral waiting, contrast and both RTL
bounds at 360px/1280px using synthetic data. Results are recorded in the PR.

Base: deployed branch `e85c8124b8a2cb2f6dd8e8915b0fad6e4491b055` (includes #233).
Live `/sw.js` was v65; candidate is v66 with the new calendar asset in the same
hashed/network-first asset pipeline. No production deployment is part of this PR.
