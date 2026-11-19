# ONE-00 / GATES — מרשם תלויות וחסמי שחרור E-ZONE One

**תמונת GitHub שנבדקה 01.11.2026 בערב; docs-only checkpoint בענף PR #332.** סטטוס PR ו־CI נכון לבדיקה, לא הוכחת פרודקשן. מסמך זה משלים את [תוכנית 31.10](EZONE-ONE-EXECUTION-PLAN-v1-20261031.md), לא מחליף אותה.

## 1. מסלולים פעילים, סדר נכון וללא כפילות
| מסלול | ממצא/תוצר מאומת במאגר | תלות וחסם | הצעד הבא ללא שינוי פרודקשן |
|---|---|---|---|
| ARCH-01 / ONE-00 | [Issue #331](https://github.com/sandrabrayer/E-Zone-Dashboard/issues/331), [Draft #332](https://github.com/sandrabrayer/E-Zone-Dashboard/pull/332) | בחירת UI/נתיבים מדורגת; מיפוי 10/10 עם גרסה פרוסה לא הושלם | להשלים source/role/feed/usage matrix, ולהפריד code-present מ־deployed ומ־adopted |
| Dashboard CRM safety + Vered Today | [Draft #346](https://github.com/sandrabrayer/E-Zone-Dashboard/pull/346) ראש `248362bc`: identity/handoff P0 + F1–F4 ושיפור F5; ארבעה CI workflows עברו על head זה | UAT אמיתי, בדיקת גרסת פרודקשן ויכולת חזרה; ack אמיתי Outpatient טרם הוכח | בדיקת קבלה מול [חוזה 60 פעולות #340](https://github.com/sandrabrayer/E-Zone-Dashboard/pull/340) ו־[Issue #339](https://github.com/sandrabrayer/E-Zone-Dashboard/issues/339); **לא** למזג #334/#345 הישנים |
| Outpatient operational backup SAFE-01 | [#125](https://github.com/sandrabrayer/ezone-outpatient/pull/125), [#139](https://github.com/sandrabrayer/ezone-outpatient/pull/139), [#140](https://github.com/sandrabrayer/ezone-outpatient/pull/140) טיוטות | source witness, ניסוי restore עדכני, manifest ואישור נתיב פיזי חסרים לשחרור | להשלים evidence ל־Tasks/Activity ותרחיש שיקום מבודד; ללא התקנה/כתיבת Sheets |
| Outpatient CRM-01 | [#142–148](https://github.com/sandrabrayer/ezone-outpatient/pull/148) טיוטות; [Audit #149](https://github.com/sandrabrayer/ezone-outpatient/issues/149) פתוח | source ownership, auth, OP-03, no third task engine, UI acceptance | למפות חוזי read/handoff ולמנוע Task/Activity כפולים; לא לבקש קלוד לבנות מחדש |
| Outpatient billing OP-BILL-01 | [#153](https://github.com/sandrabrayer/ezone-outpatient/pull/153), [#154](https://github.com/sandrabrayer/ezone-outpatient/pull/154), [#155](https://github.com/sandrabrayer/ezone-outpatient/pull/155) טיוטות; CI ב־#155 ראש `dbbe6665` עבר | שינוי source financial מסוכן, מצריך restore, מיזוג מדורג, אימות דוגמאות עבר והכרעת מדיניות | לשמור טיוטה בלבד; אין לערבב עם תיקון CRM מגורים |
| Care identity / continuation | Dashboard [#329/#330](https://github.com/sandrabrayer/E-Zone-Dashboard/pull/330), Outpatient [#137/#138](https://github.com/sandrabrayer/ezone-outpatient/pull/138) טיוטות | person/stay/episode exact-ID, handoff acknowledgment, fail-safe, backup | להגדיר test contract end-to-end; לא לאחד אנשים לפי טלפון/שם |
| Coordinators usability CUX-01 | [Audit #345](https://github.com/sandrabrayer/ezone-coordinators/pull/345) טיוטה; G1 [#349](https://github.com/sandrabrayer/ezone-coordinators/pull/349) ו־G3 [#351](https://github.com/sandrabrayer/ezone-coordinators/pull/351) בטיוטה | בדיקות CI על שלושת הענפים נכשלו; חלק מהכשל עקב fixtures בתחילת נובמבר; אי אפשר להכריז release-ready | תחילה בידוד/הוכחת תיקון [CI-only #350](https://github.com/sandrabrayer/ezone-coordinators/pull/350) (גם רץ באדום ב־01.11), אחר כך integration משותף + בדיקות משתמש |
| Staffing HR-01 | [Audit #103](https://github.com/sandrabrayer/ezone-staffing/pull/103) docs-only; [issue #102](https://github.com/sandrabrayer/ezone-staffing/issues/102) | הקוד/אימוץ מורן לא אומתו לחלוטין; עלות שכר וקווי אישור רגישים | לאסוף 5–10 פערי מוצר ו־role read model; לא לפתוח מאגר עובדים שני |
| Managers MGR-01 | אפליקציה קיימת ונכנסה לאחרונה לשימוש | אישורי משתמשים/בית, מסלולי כתיבה קיימים ופיד ניהול; לא לפרקם בשילוב רכזים | פיילוט קטן עם read-after-write ו־house scoping |
| Executive layer EXE-01 | [חוזה הנהלה v0.1](EXE-01-READMODEL-CONTRACT-20261101.md) | אין הוכחת פידים והרשאות אחידים; Ron target read parity עדיין לא בפרודקשן | inventory של endpoints ו־KPI dictionary לפני UI; הכנסות נשארות בשני מודולים |
| Therapists CARE-01 | קוד טיפול ושיבוץ קיים; לפי סנדרה לא בשימוש ואינו מספק | שיוך מטופל/מטפל וסמכות clinical; overlap עם Outpatient | אפיון reuse, לא לבנות מנוע זימון חדש |
| Logistics / Kitchen OPS-01 | Logistics בשימוש חלקי; Kitchen לא בשימוש | חסרי משתמשים, הרשאה ומודל מלאי מקורי | audit בקשה→אישור→ביצוע; לא להכריז על הפעלת מטבח |
| Hadrachot LEARN-01 | לא בשימוש; סגל אמור להגיע מ־Staffing | הגדרת הדרכות/תוקף; אין שכר ב־feed | אפיון מוגבל, לא לפתוח ספר עובדים נוסף |
| Helpdesk SUP-01 | [PR #46](https://github.com/sandrabrayer/ezone-helpdesk/pull/46) מוזג, framework לפעולות בטוחות; טופס רכזים קיים בקוד | לפי סנדרה הצוות לא עובד מתוך אפליקציית Helpdesk; יש לבדוק delivery אמיתי וגבולות permission | טופס/קבלת מספר פנייה/התראה אדמינית; פעולה אוטומטית לא מורשית |
| Finance Control FIN-01 | אב־טיפוס נפרד, ללא מקור פיננסי מוכח | חשבשבת/תשלומים/שכר/תקציבים נדרשים להצלבה | רק הגדרת מקור ו־reconciliation; אין נתוני demo כנתוני הנהלה |

## 2. מניעת ענפים כפולים / החלטת release coordination
- **Dashboard #334 ו־#345** נסגרו **ללא מיזוג** אחרי שילוב העבודה ב־**#346**. אין להורות לקלוד "לתקן שוב" F1–F5 או לנסות למזג אותם. #346 אינו live; תיקון handoff במסך אינו acknowledgment אמיתי מ־Outpatient.
- **#346 head `248362bc`:** ריצות Tests, CRM synthetic browser acceptance, Validate Workflows, Billing follow-up browser **success**. זהו שער CI בלבד; לא בדיקת ורד/דנה/אורטל, לא שחזור, לא אישור פריסה.
- **Coordinators #349/#350/#351:** תוצאות workflow Tests הן **failure** בראש כל PR שנבדק. קיימת עדות לכשלי month rollover כבר על main מ־01.11; אין לייחס אוטומטית כל failure לקוד הפיתוח או לטעון שאין רגרסיות. קודם תמונת CI מסודרת ובדיקת baseline.
- **Outpatient #155 head `dbbe6665`:** workflow Test **success**, אך לא מעניק אישור לתקן נתוני לקוח או לשנות לוח גבייה בייצור. תלוי ב־OP-03 ובהכרעת מדיניות.
- **#332** טיוטת ארכיטקטורה בלבד. אין קוד מערכת, שינוי מקור אמת או שינוי הרשאות.

## 3. תלויות קריטיות וסדר הפעלה
`ONE-00 inventory` → `SAFE-01 verified restore + SAFE-02 server permissions` → `CRM identity/handoff contract` → `CRM/Outpatient read-only cross-service view` → `EXE-01 executive read view` → `module-by-module controlled pilots`.

אפשר לתכנן את EXE-01, את ה־KPI dictionary ואת בדיקות CUX/HR **במקביל**, אבל **לא** לחבר מודל פיננסי חדש לפני חיבור/התאמת ספרי מקור. שינויים קריטיים באפליקציה חיה (למשל זהות לקוח) דורשים מסלול עצמאי מבוקר, ולא ממתינים לאיחוד הממשק הכולל.

## 4. Gate שחרור לכל PR שמשפיע על משתמשים
1. **G0 base/versions:** SHA מדויק של ענף פרוס, שינויי חפיפה, תלות ב־SW ו־stacked PRs; לא להפעיל PR ישן על base שזז.
2. **G1 data safety:** snapshot/manifest, שחזור אמיתי מבודד ו־rollback; במקרה של תשלומים, בדיקות ledger, covered period ומקרים היסטוריים.
3. **G2 security:** session verified identity, cross-house negative cases, Dana no finance, Ron/Sandra equal read with separate write, no phone/name auto-link.
4. **G3 functionality:** green CI on exact integrated head, browser positive/negative, missing source, duplicate retry/idempotency, read-after-write.
5. **G4 end users:** ורד, אורטל, דנה, רכזים/מנהלים לפי מסלול; screenshot/notes לתוצאה עסקית, כולל מכשיר נייד היכן שרלוונטי.
6. **G5 owner:** **אישור מפורש, נפרד, של סנדרה לכל merge, deploy, שינוי הרשאות פרודקשן או מיגרציה**. אישור אפיון ≠ אישור הפעלה.

## 5. חלוקת עבודה חסכונית
**ChatGPT:** חוזים, מפת בעלות, סקירת PR/CI, KPI dictionary, בדיקות קבלה, בידוד כפילויות, תיעוד ושאלות החלטה ניהולית. **Claude:** רק תיקון קוד ממוקד עם מסלול משתמש ו־PR אחד, אם אכן דרוש; לא לבקש שוב סריקת 10 אפליקציות, תכנון Outpatient CRM מחדש או שינויי production ללא G5.

**מעקב הבא:** לבנות EXE-A feed inventory מול קוד אפליקציות פעילות; לזהות על איזה head #350 הופך לירוק (או איזה כשל נשאר); להשלים OP-03 restore evidence ולהכין UAT של #346. אין טענה של השלמת שלושת הגייטים בשלב זה.
