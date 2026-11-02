# EXE-A — מפת פידים ואימות תכנון הנהלה, סבב קוד 1 (02.11.2026)

**סטטוס:** קוד מאומת ב-GitHub; **לא** נבדק מול פרודקשן עם הזדהות או נתוני אמת. מסמך תכנון בלבד בתוך [PR #332](https://github.com/sandrabrayer/E-Zone-Dashboard/pull/332), מול [Issue #347](https://github.com/sandrabrayer/E-Zone-Dashboard/issues/347). אישור מוצר ≠ שינוי הרשאות/פריסה.

## מתודולוגיה וגבולות הוכחה
- אומתו 11 מאגרי GitHub נגישים: 10 תחומיים + אבטיפוס Finance Control. לכל 11 נקרא `README.md` (למעט Dashboard: README.md לא נמצא בנתיב השורש), ולכל 11 נקראה כניסה בקוד `server.js` או `src/server.js`; קוד אינו ראיה שהענף נפרס בפועל. נבדקו קטעי middleware/handlers, לא נערכה הפעלה או קריאת לקוחות אמיתיים.
- `CODE` = endpoint/מודל נצפה בקוד ענף ברירת מחדל; `DRAFT` = PR לא ממוזג; `DEPLOYED UNKNOWN` = לא בוצע אימות `/api/version` מול השירות החי; `USED` = דיווח משתמש, לא טלמטריה. **שום endpoint ברשימה אינו מאושר אוטומטית לשימוש בסביבת הנהלה החדשה.**
- מעטפת הנהלה עתידית מקבלת רק feed מאושר, מצומצם, נושא מזהה מקור, source version, scope וחותמת זמן. שימוש ב-endpoint קיים ישירות דרך הדפדפן אינו חלופה לבקרת שרת.

## 1. מטריצת 10 אפליקציות + אבטיפוס

| מערכת | נקודת קריאה שקיימת בקוד (לא בהכרח interface להנהלה) | אימות/הגבלת scope בקוד | בעלות נתונים / שימוש | התאמה ל־EXE-01 ומצב |
|---|---|---|---|---|
| [Dashboard](https://github.com/sandrabrayer/E-Zone-Dashboard/blob/claude/build-ezone-dashboard-QOg5s/server.js#L1124) | `GET /api/sheets?action=...`; exports נפרדים ל־billing, debt, credits | `requireSession` + finance, role, proxy guards + response projections; Google Apps Script הוא מקור הישויות. המטריצה ההיסטורית מדווחת על סיכון bypass ישיר ב-`PROXY_SECRET_MODE=log`, **אימות מצב deployment נדרש** | פניות/שהיות/גבייה מגורים/תפוסה; בשימוש נרחב | CODE; שימור כרטיסי הכנסות. אין להסיק ש-Ron כבר מחובר ל-Dashboard. [מקור הרשאות](https://github.com/sandrabrayer/E-Zone-Dashboard/blob/claude/build-ezone-dashboard-QOg5s/docs/crm/PERMISSIONS-MATRIX.md) |
| [Outpatient](https://github.com/sandrabrayer/ezone-outpatient/blob/claude/youthful-volta-laarnk/server.js#L383) | `GET /api/sheets` bulk/action, `GET /api/continuation-roster`, `GET /api/me` | Session cookie ל-`/api/sheets`; קיימת cache + fallback ל־stale (חייבים לקרוא ולתייג asOf). CRM Tasks/Activity/‏`getHandoffStatus` החדשים [#142–148](https://github.com/sandrabrayer/ezone-outpatient/pull/148) **DRAFT** | שירותי חוץ, תוכניות/מפגשים וחיובים; בשימוש נרחב | CODE לבסיס, DRAFT ל־CRM חדש. הכנסות נשארות גם במסך הזה; לא לחשב יחד עם מגורים ללא הגדרה כספית |
| [Therapists](https://github.com/sandrabrayer/ezone-therapists/blob/claude/inspiring-tesla-jipobw/server.js#L1550) | `GET /api/treatment-plans`, `/api/debt-status`, `/api/packages/catalog`, `/api/admitted`, `/api/alumni` | קוד כניסה אישית למטפלים/רכזים; sessions והקצאות מטופל. פריטי חבילה דורשים בדיקת סינון פריטי מחיר במסגרת cross-app feed | שיוך מטפלים, דיווחי מפגש/נוכחות, alumni; לא בשימוש לפי סנדרה | CODE; אין להעתיק תוכן קליני או מחיר ל־EXE, רק אגרגטים מורשים ומוגדרים; אין מנוע שיבוץ כפול |
| [Coordinators](https://github.com/sandrabrayer/ezone-coordinators/blob/main/server.js#L3004) | `GET /api/house-bundle`, `GET /api/sheets`, `GET /api/constraints-window`, `GET /api/block-limits` | הגנות לפי זהות/בית שונות במסלולים — לא הוכחה אחידה לכל route; יש לאמת session/house על כל feed חדש | שיבוצים, מדריכים, מגבלות, קבוצות וקופה קטנה; פעיל עם קשיי UX | CODE; G1 [#349](https://github.com/sandrabrayer/ezone-coordinators/pull/349), G3 [#351](https://github.com/sandrabrayer/ezone-coordinators/pull/351), CI [#350](https://github.com/sandrabrayer/ezone-coordinators/pull/350) טיוטות. לא לחשוף שכר/מחירים |
| [Managers](https://github.com/sandrabrayer/ezone-managers/blob/main/server.js#L307) | `GET /api/sheets?action=managersOverview`, `...managersHouse`, `...occupancySnapshots`; `POST /api/work` לכתיבה (לא לשימוש ב־EXE) | `requireUser`; מנהל: `canSeeHouse`, תגובת `scopeForManager` ו־house מהסשן; admin רואה כלל הבתים. Cache fallback עד 72h מסומן `X-Data-Source: cache` | דוחות מנהלים, תפוסה, ביקורים, בונוסים/משימות; פיילוט שימוש | CODE. יש לשמר 5 מסלולי כתיבה קיימים; לא להפוך manager למנהל מערכת |
| [Staffing](https://github.com/sandrabrayer/ezone-staffing/blob/main/server.js#L665) | `GET /api/data`, `/api/data/hearings`, `/api/hadrachot-status` | `requireAuth` Bearer; bulk `/api/data` כולל מידע HR/שכר, ולכן **אסור** להעבירו לפורטל כללי/לרכזים; cache מסוג `STALE_ERROR` קיים | עובד, שיוך, שכר, היעדרויות, תקציב; בשימוש אך לא מספק | CODE; [HR audit #103](https://github.com/sandrabrayer/ezone-staffing/pull/103) DRAFT; ל־EXE נדרש server-side executive projection מופרד |
| [Hadrachot](https://github.com/sandrabrayer/ezone-hadrachot/blob/main/server.js#L140) | `GET /api/data`, `GET /api/guides`; `getFirstHadrachaStatus` מתועד כ-feed הפוך ל־Staffing | `requireAuth`; `/api/guides` מגיע מ-Staffing בסוד שרת, כשל 503/502 (לא רשימת מדריכים ריקה), ללא שכר | סופרוויז'ן/הדרכות; לא בשימוש | CODE. מקור אישויות העובדים Staffing; לא ליצור מאגר עובדים שני |
| [Logistics](https://github.com/sandrabrayer/sandrabrayer-ezone-logistics/blob/main/src/server.js#L53) | שער Node `/api/session`, `/api/data`, `/api/action` כמתועד ב־README וקוד gateway | **P0 REVIEW:** session נוצר אוטומטית ללא כניסה ומגדיר `name:'רועי',role:'ops_manager',scope:''`. קוד נפרד לאישור/דחייה נשמר, אך **פעולות תפעול אחרות ואי־שיוך actor אישי** מחייבים בדיקה. אין לייחס זאת למצב production ללא version proof | בקשה→אישור→ביצוע→סגירה, ספקים, תקציבי תפעול; בשימוש חלקי | CODE; **חסם הזדהות לממשקי EXE/פורטל**. אין לנתק או לשנות login ללא תכנון מעבר |
| [Kitchen](https://github.com/sandrabrayer/ezone-kitchen/blob/main/server.js#L166) | `POST /api/sheets` מעביר גם reads וגם writes ל־Apps Script; `GET /healthz/backend` | **P0 REVIEW לפני שימוש:** קוד מצהיר `No user auth: the app is open`. סוד ה־Apps Script מוזרק בשרת, אך אין אימות עובד/בית. לא אושרה גישה לפרודקשן | תפריטים, מלאי מזון, קניות, תקציב; לא בשימוש | CODE; מחייב login/scope ואישור נתוני אלרגנים לפני כל שילוב |
| [Helpdesk](https://github.com/sandrabrayer/ezone-helpdesk/blob/main/server.js#L320) | `GET /api/admin/cases`, `/api/admin/apps-health` עם `requireAuth`; טופס `/report`; Coordinators native intake מתועד | admin queue רק לסנדרה; סטטוסים לצוות מוגבלים ומנוטרים; סוד מנהל לא ייחשף למעטפת | ניטור, תקלות ותיעוד; הצוות משתמש בטופס בתוך Coordinators לפי התכנון, לא ב־Helpdesk עצמו | CODE; [PR #46](https://github.com/sandrabrayer/ezone-helpdesk/pull/46) מוזג. אין להניח פעולות תיקון אוטומטי פעילות |
| [Finance Control](https://github.com/sandrabrayer/ezone-finance-control/blob/main/README.md) | ממשק demo סטטי; לא קיים feed חשבונאי מוסמך | אין מערכת role/ledger פרודקשן | מודל תזרים/רווחיות ראשוני עם נתוני demo ו־local storage | **DEMO ONLY / NOT AUTHORIZED.** אין לחבר ל־EXE-01 עד source reconciliation |

**הערות מקור:** Logistics מאגר אמיתי `sandrabrayer/sandrabrayer-ezone-logistics`, למרות שה־README מתייחס לשם קצר אחר; זה לא מצדיק החלפת קוד. Dashboard `getData` ומסלולים רגישים מחייבים גם בדיקת bypass ישיר ל־Apps Script בתצורה הפרוסה; קוד Node בלבד אינו מוכיח את הגנת ה־backend המקורי. קישורי code line מפנים לענף ברירת המחדל כפי שנקרא בבדיקה, ויכולים להשתנות בהמשך.

## 2. מפת בעלות בין מודולים (מניעת כפילות)
| ישות עסקית | Owner | Consumer מאושר עקרונית | איסור / נדרש לאימות |
|---|---|---|---|
| Lead/ResidentialStay/Payment | Dashboard | CRM מאוחד, EXE, Managers/Coordinators באופן מצומצם | אין auto-merge לפי שם/טלפון; אין ספר תשלומי מגורים נוסף |
| OutpatientClient/Episode/TreatmentCharge | Outpatient | CRM מאוחד, EXE, Therapists דרך scopes | אין תור משימות שלישי; מפגש ≠ טיפול בוצע |
| Clinical assigned therapist/session outcome | Therapists / מקור טיפול לפי חוזה ספציפי | Outpatient מקבל תוצאה מוגדרת; EXE אגרגטים בלבד | נדרש להסדיר בעלות על session/status טרם כתיבה דו־כיוונית |
| Employee/payroll/assignment | Staffing | Coordinators/Hadrachot מקבלים roster price-free; EXE executive only | שכר לא נשלח לרכזים/מנהלי בתים |
| Shift result / constraints | Coordinators | Managers/EXE projection בלבד | כללי 6/7 ימי עבודה נשמרים; אין שיבוץ שני |
| Manager report/bonus | Managers/ממשק Dashboard קיים — לבדוק לפי entity | CRM/EXE read-projection | 5 מסלולי כתיבה של Managers לא יכבו לפני החלפה |
| Logistics request/budget | Logistics | EXE סטטוס/תקציב לאחר הרשאה | owner של אישור אולגה, לא אישור גורף מכל זהות מערכת |
| Hadracha event/validity | Hadrachot | Staffing / EXE aggregate | מדריכים מגיעים מ־Staffing, לא ספר עובדים מקביל |
| Kitchen stock/menu | Kitchen | EXE/OPS רק לאחר authentication | אלרגנים/מידע רגיש, ניהול בית, גישת open app |
| Helpdesk case | Helpdesk | הנהלה aggregate + Coordinators limited own-case | אין פרטי credentials, פרטי מטופלים או מערכת תיקון ללא whitelist |
| Accounting document | חשבשבת (מחוץ לאפליקציות) | Dashboard/Outpatient/EXE עם evidence מאומת | בקשה להנפקה ≠ מסמך שהונפק |
| Finance management projection | אין source חדש — נגזר מהמקורות | EXE בעתיד | Demo אינו אמת. הכנסות/הוצאות רק לאחר התאמה |

## 3. Minimum-feed contract: מה יש לחפש בהמשך
כל אפליקציה תוכל לפרסם Projection מורשה, בשלב ראשון בדיקות synthetic בלבד:
- `ownerApp`, `sourceEntity`, `sourceVersion`, `asOf`, `status` (available/partial/stale/unavailable/not_implemented), `scope` (server-verified), `period`, `timezone`, `schemaVersion`, `data`.
- מידע ממקורות אחרים: `sourceApp + sourceId` ותוצאה מאומתת; משימות `ownerApp + taskId` ללא write store חדש.
- Finance: `currency`, `vatBasis`, `recognitionBasis`, `isVerified` ונוסחה. Missing = null עם status/reason, **לא** אפס.
- Data access: account identity→server RBAC→field/record scope→projection→audit; reports/exports חייבים אותו filter. אין secret ב־URL ללקוח ואין bypass ישיר ל־Sheets/Code.gs. מעברי app יהיו session-bound עם חידוש הרשאה.
- `asOf` נשמר גם בזמן cache fallback; stale לא משודרג אוטומטית ל־available רק כי HTTP 200.

## 4. חסמים ופעולת ביקורת שמורה
**B1 (highest, active-partial): Logistics** — passwordless operational role stamped as Roy, while role can defer/assign/close. נדרש audit מבודד של permissions, source write, approval code, actor attribution, replay ו־deployment. אין לשנות כניסה ללא הסדר עבודה לרועי/אולגה; לא נבדק אירוע פריצה ואין לטעון שנחשף הציבור.
**B2 (before launch): Kitchen** — public no-login gateway allows reads/writes by design. נדרש האישרור הגדרת roles והגנת בית, לא לשלב במעטפת.
**B3 (before cross-app): Dashboard Apps Script** — מטריצת הרשאות היסטורית מתריעה על PROXY_SECRET_MODE=log; יש להוכיח תצורה פרוסה ונתיב bypass חסום **בלי** לקרוא או לשנות נתוני אמת.
**B4 (before finance): Outpatient OP-03** — שחזור מקור עדכני Tasks/Activity, finance policy #155 draft; אין שינוי גבייה חי ללא evidence.
**B5 (before executive parity):** Ron's complete read parity מחייב חשבון אישי בכל app; Managers בלבד כבר יודע Ron/admin. אין לגזור מכך גישה ל־Dashboard/Outpatient/Staffing.

## 5. מסקנה ניהולית לשלב הבא
אפשר לבנות UX prototype **עם נתוני הדגמה מסומנים** אבל **לא** להרכיב "מסך הנהלה חי" עדיין. הסדר הנכון: מקור/הרשאה/גרסה → KPI definitions → synthetic contract tests → read-only pilot → compare with originals → approval. נדרשת חתימה עסקית על KPI בעלי משמעות כספית; לכל פעולת merge/deploy/authorization נדרש אישור נפרד מסנדרה.
