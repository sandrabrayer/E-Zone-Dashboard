# EXE-A — מילון KPI ומבחני קבלה לשכבת הנהלה (Draft v0.1, 02.11.2026)

**סטטוס:** הגדרות מוצעות ותוכנית בדיקות — לא תוצר live ולא חישוב כספי מאושר. פרויקט E-ZONE One, [Issue #347](https://github.com/sandrabrayer/E-Zone-Dashboard/issues/347) / [ARCH-01](https://github.com/sandrabrayer/E-Zone-Dashboard/issues/331). לקריאת מקורות ומגבלות: [EXE-A Feed Inventory](EXE-A-FEED-SECURITY-INVENTORY-20261102.md) ו־[EXE-01](EXE-01-READMODEL-CONTRACT-20261101.md).

## 1. חוקים רוחביים

1. מדד מחויב ל־`metricId, label, ownerApp, sourceVersion, periodStart, periodEnd, asOf, unit, timezone, status, reason, scope, definitionVersion`. נתון פיננסי מוסיף `currency, vatBasis, recognitionBasis`; יחס מוסיף `numerator/denominator`. כל count מבהיר אילו סטטוסים נספרים ומהו מזהה הישות.
2. `available` הוא רק מקור מאומת; `partial` אם חלק מהמקורות תקינים; `stale` עם זמן אחרון מוצלח; `unavailable` לאחר כשל; `not_implemented` כשאין חוזה; `unauthorized` אינו 0. ה־UI מציג "לא זמין" ולא 0 גם כאשר כל שדות payload חסרים.
3. כל כרטיס מאפשר Drill-down למקור המוסמך לפי הרשאת שרת וזהות אישית. אף גיליון או export לא יוגשו ישירות ללא מסנן הרשאות. מידע קליני נשאר מחוץ למרחב הנהלה, למעט מדדים מצרפיים מורשים.
4. סנדרה ורון רואים **אותם כרטיסים, אותן רשומות ופירוט** ב־EXE; לחיצה "אישור/הנחה/זיכוי/שינוי מחיר" תתאפשר רק לבעלי הרשאת פעולה עצמאית. היעדר פעולה בממשק אינו הוכחת חסימה בשרת.
5. הכנסות מגורים ו־Outpatient נשארות גם במסכי המקור הקיימים; מסך הנהלה קבוצתי רק משקף אותן עם הגדרות התחשבנות חופפות ומניעת כפל. בבדיקה, סך אינו מחושב אם בסיסי תקופה/מע״מ/הכרה שונים.
6. ברירת מחדל לשעון: `Asia/Jerusalem`, יום עסקי מסונכרן למקור, כולל שעון קיץ. ב־CRM יש להבדיל בין "תאריך הבא לשיחה" לבין תאריך הפעילות המקורי.

## 2. מילון מדדים — הגדרת מוצר, owner וגייט

| metricId | תיאור מדד מוצע | הגדרה/נוסחה שניתנת לבדיקה | בעל מקור | תנאי וסטטוס מימוש |
|---|---|---|---|---|
| RES_CAPACITY | קיבולת בתים פעילים | סכום מיטות מורשות ומופעלות, לפי סטטוס בית ותאריך תחולה; אין לספור אשר כסגור אוטומטית בלי רשומת סטטוס | Dashboard + החלטת Master Houses | **PROPOSED**: להכריע dormant/licensed מול actively accepting |
| RES_OCCUPANCY | תפוסת מגורים | מספר שהיות `active` בתאריך חתך / קיבולת פעילה באותו תאריך; `stayId` ולא `personId`; לא לכלול `preopening` | Dashboard | נוסחת מוצר מוצעת; התאמה למסך המקור חובה |
| RES_ADMISSIONS | קבלות בתקופה | count distinct stayId עם admissionDate בתקופה; הפניה נשלחה ≠ התקבלה | Dashboard | PROPOSED; לזהות קליטה ישירה מ־CRM ושיוך Lead |
| RES_DISCHARGES | שחרורים בתקופה | count distinct stayId עם dischargeDate בתקופה, כולל תאריך שחרור מקור | Dashboard | PROPOSED; להשוות ללוח שחרורים |
| RES_REVENUE | הכנסה ממגורים | סכום מקור לפי הגדרת הכרה מאושרת, רק תקופה/מע״מ אחידים, בפילוח בית | Dashboard / חשבשבת לפי בסיס מסמך | **BUSINESS SIGNOFF**: חיוב מול הכנסה מול תקבול אינם זהים |
| RES_REPORTED_PAY | תשלומים שדווחו | סכום paymentUid סטטוס reported בתקופה, מסומן `unverified` | Dashboard | קיימת ישות; KPI מוצע, אין לקרוא "נגבה" |
| RES_VERIFIED_PAY | תקבולים מאומתים | סכום paymentUid מאומת לפי מועד אימות או מועד תשלום (החלטת הגדרה נדרשת) | Dashboard | **BUSINESS SIGNOFF** על ציר תאריך; לא לכלול void/flagged |
| RES_DEBT_AGING | חוב לפי גיל | סיכום debtAging ממקור Dashboard, buckets ומועדים כפי שמוגדרים במקור | Dashboard | CODE קיים; אין להסיק חוב 0 כש־feed אינו נטען |
| OP_ACTIVE_EPISODES | תוכניות/מטופלים פעילים | count distinct serviceEpisodeId סטטוס active; **לא** מספר בני אדם אם יש כמה תוכניות | Outpatient | **BUSINESS SIGNOFF** האם למדוד אנשים או תוכניות |
| OP_SESSIONS_DONE | מפגשים שהתקיימו | count sessionId עם attendance=occurred, לפי מועד מפגש | Therapists / Outpatient מקור שנקבע | **OWNERSHIP HOLD**: לקבוע מי מוסמך למפגש/השלמה |
| OP_MISSING_SESSIONS | ביטול/אי־הגעה | count unique sessionId no-show/cancelled לפי סיבת מקור; rescheduled נשאר מקושר | Outpatient/Therapists | PROPOSED אחרי בעלות יחידה |
| OP_REVENUE | הכנסה אמבולטורית | מקור Outpatient לפי חודש ותאריך כיסוי/הכרה כספית מאושרת | Outpatient / חשבשבת לנתוני מסמכים | **BUSINESS SIGNOFF / OP-03**. #155 הוא DRAFT בלבד |
| OP_COLLECT_DUE | תשלומים לגבייה | count distinct billing obligation שנדרש תשלום וטרם אומת; לא לשכפל תשלומים | Outpatient | PROPOSED; מדיניות תאריך חיוב #155 טרם יושמה |
| CRM_NEW_UNTOUCHED | פניות חדשות ללא קשר | count unique inquiryId ללא Activity קשר מתועדת; אם contact index חסר -> unavailable | Dashboard + Outpatient בנפרד | חלקי ב־Dashboard #346 DRAFT; cross-service requires IDs |
| CRM_CALLS_OVERDUE | שיחות לביצוע באיחור | count `ownerApp+taskId` with dueAt<now, unresolved/acknowledged, כולל תאריך נדחה/היסטוריה | Dashboard & Outpatient Task/Activity | Outpatient #142–148 DRAFT, no third task engine |
| CRM_MEETINGS_PENDING | פגישות ללא תוצאה | count meetingId עם happened/expected אך ללא result verified; no-show נפרד | Dashboard/Outpatient | PROPOSED, להשוות Calendar; לא לספור פגישה שלא נקבעה כנתונה |
| CRM_HANDOFF_PENDING | המשכי טיפול שלא אומתו | count handoffId עם sent/offered/accepted אך לא `treatment_started` מוכח; לא פג לאחר 14 ימים | Dashboard + Outpatient acknowledged statuses | Dashboard #346 DRAFT; Outpatient feed #145 DRAFT, E2E ack not verified |
| MGR_REPORT_MISSING | דוחות מנהלים שחסרים | count report obligation לפי מחזור/בית בלי דו״ח שהתקבל בפועל; מקור אחד | Managers (עם אירועי Dashboard רלוונטיים) | PROPOSED; דרוש מחזור דיווח מאושר |
| CO_UNFILLED_SHIFTS | משמרות לא מאוישות | count shiftId unfilled בלוח מפורסם/טיוטה בנפרד; נדרש reason | Coordinators | G1/G3 טיוטות; אין לחשב "שובצו" מעמודת היתכנות בלבד |
| CO_BLOCK_VIOLATIONS | חריגי אילוצים | count distinct rejected/violating placement across 7-day checks, מפריד infeasible from invalid | Coordinators | PROPOSED; להתאים לכללי 6/7 ימים ולפי בית |
| HR_ACTIVE_WORKERS | מספר עובדים פעילים | count distinct employeeId with active employment asOf, לא sum שורות שיוך בתים | Staffing | PROPOSED; read scope executive vs roster price-free |
| HR_COST_TOTAL | עלות כוח אדם | actual confirmed + estimated separated, keyed to payroll month, employer cost, house allocation | Staffing | **FINANCE SIGNOFF**; no double-count assignments |
| HR_TRAINING_OVERDUE | הדרכות חסרות | count employeeId/requirementId overdue על פי תפקיד ותאריך | Hadrachot + Staffing roster | CODE fed; לא להציג כאשר הדרכות לא בשימוש כאילו הושלם |
| OPS_REQUESTS_OPEN | בקשות פתוחות | count Logistics requestId nonclosed by house + urgency/status; duplicate request must not double count | Logistics | **AUTH HOLD**; no login personal identity in default code |
| OPS_REQUESTS_AGED | בקשות באיחור | count open requestId past approved target due date; missing due != overdue | Logistics | PROPOSED, אישור SLA נדרש |
| KITCHEN_STOCK_ISSUES | חריגי מלאי | count ingredient+house+date below min par, רק אם יש audit/auth/חומרה תקינים | Kitchen | **NOT READY**; open/no login, no user adoption |
| HELP_OPEN_CASES | תקלות פתוחות | count caseId unresolved לפי מערכת/חומרה/מועד, כולל confirmed vs unconfirmed | Helpdesk | CODE; לא לפתח repairs אוטומטיים אגב המסך |
| FIN_PNL_HOUSE | רווחיות לבית | income - matched operating + HR + approved allocations, exact period and recognition basis | מקורות + חשבשבת | **NOT IMPLEMENTED**; Finance Control demo, לא לחשב חי |
| FIN_CASH_RUNWAY | תזרים/יתרת מזומן | settled opening balance + bank-verified movements + forecast explicitly separated | חשבשבת/בנק מקורות לא מחוברים | **NOT IMPLEMENTED**. אין לקחת ערכים מאב־טיפוס |

**הכרעות עסקיות שטרם התקבלו:** הכנסה כהכנסה חשבונאית/חשבוניות/חיובים/גבייה; תאריך ייחוס תקבול; יחס תפוסה וקיבולת על בית שאינו קולט; אדם מול תוכנית מול טיפול; הגדרת איחור; SLA רכש. עד אישורן, המדדים מסומנים `proposed` ולא מחייבים שינוי בבקרים קיימים.

## 3. מבחני קבלה סינתטיים לשער EXE-A (שמות בדיקות מוצעים בלבד — לא בוצעו)

| ID | Given | Expected |
|---|---|---|
| EXE-T01 | Sandra ו־Ron עם זהויות אישיות מאומתות ושתי שהיות שונות לאותו אדם | אותן הרשאות **קריאה**, אותם רשומות/ייצוא/פירוט; count stays אינו מאחד אותן אוטומטית |
| EXE-T02 | Ron מנסה `approveRefundException` בלי הרשאת פעולה | Server 403; Sandra לפי המנגנון הקיים בלבד; אין שיתוף credential |
| EXE-T03 | Dana מבצעת GET, download, search, details כאשר החוב קיים | אף שדה `pay/adv/price/payment/debt/salary` אינו מגיע ב־payload, גם כאשר ה־UI מוסתר |
| EXE-T04 | מנהל בית א' מנסה פילטר בית ב' דרך query ודרך export | 403/מסונן על בסיס session; אין row דולף או cache cross-user |
| EXE-T05 | מטפל שויך רק לתיק X, מבקש תיק Y | אין פרטים או פרטי חבילות/כסף, גם אם מניפולציית query |
| EXE-T06 | `getData` מ־Outpatient timeout, Dashboard תקין | כרטיס Outpatient `unavailable`, מגורים `available`; אין network-revenue total מזויף |
| EXE-T07 | חלופת cache 72h ב־Managers ו־stale Outpatient | `status=stale`, `asOf` מקור נכון; HTTP 200 אינו `fresh` |
| EXE-T08 | שתי פניות לאותו טלפון/שם | לא נוצר personId משותף אלא לאחר exact verified identity link |
| EXE-T09 | Handoff במצב `sent` ללא `accepted/contacted/treatment_started` | סיבת המשך טיפול נשארת פתוחה גם אחרי 14 יום; אין סגירה אוטומטית |
| EXE-T10 | שיחה עברה מ־Vered לדנה, חובת מעקב עדיין קיימת | `ownerApp+taskId` יחיד, actor שונה מבעל אחריות; לא task duplicate |
| EXE-T11 | income sources עם VAT basis או period שונים | כרטיס סך קבוצתי `partial`/"cannot aggregate" ולא חיבור מספרים |
| EXE-T12 | Staffing משייך עובד לשני בתים | HEADCOUNT distinct employeeId, עלות מחולקת לפי מקור מוסמך ולא פעמיים |
| EXE-T13 | Logistics נפתחת ללא login ומייצרת session role Roy | סימון `security_hold`; פורטל הנהלה אינו משתמש ב־role הזה בשם Ron/Sandra; write actions לא מופעלות |
| EXE-T14 | Kitchen request ללא login מנסה write בין בתים | חיבור חי חסום עד auth policy; לא להסיק סוד proxy כ־user identity |
| EXE-T15 | Hadrachot feed אינו מוגדר/נופל | `not_implemented/unavailable` ולא `0 employees overdue` |
| EXE-T16 | Backup OP-03 חסר תיעוד Tasks/Activity או אינו משחזר checksum | Gate G1 נכשל; אין הפעלת Outpatient CRM חדש |
| EXE-T17 | עלות HR shadow ונתוני Finance demo בלבד | רווחיות = unavailable, ולא מספר שנראה רשמי |
| EXE-T18 | Desktop/Mobile חודש חוצה 31.10–01.11 ושעון קיץ | period מסונכרן ב־Asia/Jerusalem, אין תשלום/משימה ביום שגוי |
| EXE-T19 | יצוא XLSX דרך route פנימי עם role מוגבל | אותם שדות/בתים מורשים כמו במסך, ללא פיננסים לדנה |
| EXE-T20 | GET source אחרי 503 עם הנתונים הישנים בתור | לממשק חיווי stale והחלפת נתון רק אחרי successful authorized refresh; לא `0` |
| EXE-T21 | source returns non-JSON / partial header / unknown schema | fail-closed + reason + request trace לא מזהה, no raw upstream leakage |
| EXE-T22 | תיבת KPI/חיפוש קושרת לפירוט במקור | ה־deep-link דורש session חדש במקור, 403 למי שאין scope, ולא token ב־URL |

## 4. מסלול חיתום מקצועי
- **תנאי EXE-A לפני UI:** לכל מדד צילום evidence מהמקור/אישור formula+unit+period; לכל endpoint תיעוד auth+scoping+version; לכל source חסר ערך `not_implemented`.
- **תנאי EXE-B לפני read-only pilot:** synthetic tests על endpoints ייעודיים ורול-לבלים. לעולם לא לשאוב את `Staffing /api/data` עם שכר אל דפדפן של manager/coord.
- **תנאי EXE-C לפני release:** התאמה של 2–3 תקופות לכל KPI מול מקורות, including missing source; Sandra/Ron parity, Dana negative money tests, false-zero tests, rollback; שירות ה־CRM בתהליך פעיל לא יכול להיפגע.
- **G6 owner:** סנדרה מאשרת בנפרד **כל** merge, deploy, שינוי הזדהות/הרשאות, שינוי פיננסי או migration. המסמך עצמו אינו הרשאה.

## 5. חלוקת ביצוע
**ChatGPT**: source evidence, KPI definitions, read model/protocol, test plan, issue coordination. **Claude**: *רק* תיקון קוד הנובע מממצא מגובה, ענף מבודד, בדיקה ונוהל rollback. אין לפתוח מחדש עבודות Dashboard #346, Outpatient #142–148, #155 או Coordinators #349/#350/#351 ממסמך זה. **אין עבודה אוטומטית ברקע**.
