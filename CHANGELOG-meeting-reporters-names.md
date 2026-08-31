# Real reporter names in the meeting-report form

The מדווח/ת dropdown on `/meeting-report` showed placeholder values
(`מנהל/ת <house>`). Replaced with the real house managers:

| house | reporter |
|---|---|
| `arfoni` (קיסריה עפרוני) | חנן |
| `rehab` (קיסריה ריהאב) | רנטה |
| `asher` (רעננה אשר) | שחר/אורן |
| `pardes` (רעננה הפרדס) | חן |
| `ramot` (רמות השבים) | אורן |

`sde` (שדה אליעזר) has no entry any more — the dropdown is a flat list of
names (not filtered by the selected lead's house), so this only removes one
option. The stored `meetingReporter` value is the display name, as before.

`test/meeting-report-form.test.js` no longer asserts one-reporter-per-house;
it now asserts the exact real-names map and that every key is a valid house
id. Frontend-only (`public/meeting-report.js`); no schema or behavior change.
