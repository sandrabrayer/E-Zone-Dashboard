# Meeting-report form: picker dates as DD/MM with RTL isolation

## הבעיה

ה‑dropdown לבחירת ליד בטופס `/meeting-report` הציג את תאריך הביקור בפורמט
ISO גולמי (`2026-08-20`) בתוך תווית עברית RTL — אלגוריתם ה‑bidi מערבב את רצף
הספרות ה‑LTR עם הטקסט העברי והתאריך נראה משובש.

## התיקון

עוזר טהור חדש `mrPickerDate`:

- `YYYY-MM-DD` (או timestamp שמתחיל בו) → `DD/MM`;
- עטוף ב‑Unicode LTR isolate‏ (`U+2066 LRI … U+2069 PDI`) כך שהקטע לעולם לא
  יסודר מחדש בתוך התווית ה‑RTL;
- ערך ריק → `''` (התווית מוותרת על מקטע התאריך);
- ערך legacy שאינו ISO מוצג כמו שהוא, אבל עדיין מבודד.

`renderLeads` משתמש בעוזר בבניית תוויות ה‑options.

## קבצים

- `public/meeting-report.js` — `mrPickerDate` + השימוש ב‑`renderLeads`.
- `test/meeting-report-picker-date.test.js` — פורמט, timestamp, ריק,
  legacy, ואיזון תווי הבידוד.
