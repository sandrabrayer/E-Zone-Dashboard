# CRM «משימה חדשה»: date + time only, a reminder before it is due (2026-11-05)

Sandra, 05/11/2026: «כפתור יצירת משימה לא עובד, להוריד את הלמה עכשיו, לא צריך מועד וגם תאריך וגם לא
מובן מה זה שבוע, רק תאריך ושעה ושהמשימה תשלח התרעה לפני שצריך לבצע אותה ושזה יופיע ביום שלי.»

## Root cause of "the button doesn't work"
With «מועד: במהלך שבוע» selected (as in the screenshot) the form demanded the separate «שבוע» field, so
«יצירת משימה» was refused and the only hint was a small error under that last field — the date that was
filled in was ignored. The create path itself (createTask) works.

## What changed (CRM only — `public/crm/crm.js`)
- **The form**: סוג, מה לעשות *, אחראי, תאריך * (today by default, not in the past), שעה *. Removed:
  «למה עכשיו», «מועד», «שבוע». Validation `newTaskErrors` — each missing field is marked; nothing is sent.
- **Reschedule**: date + time only (the week option is gone); a reason is still required for a date
  promised in a contact.
- **Reminder**: while the CRM is open, every minute it checks MY open tasks (assigned to me, or
  unassigned) due today; each one due within **30 minutes** is announced once — a toast
  «⏰ בעוד N דק׳ (HH:MM): …» and, when the browser allows notifications (asked on the first task
  created), a system notification. Pure rule: `dueSoonTasks`.
- **«היום שלי»**: a dated task is already listed on its day (calls under «שיחות ומעקבים», others under
  their domain); Vered's 08:00 mail already counts today's tasks (CHANGELOG-crm-reminder-hook.md).

## Limits
The reminder needs an open CRM tab (no push server). Existing week-window tasks are still shown and
still count; they just cannot be created any more.

## Tests
New `test/crm-task-date-time.test.js` (4); Chromium: the tasks-tab flow now requires a time and has no
week / reason field; a new test announces a task due in ~10 minutes and shows it on «היום שלי».
`npm test` green except the pre-existing local-only `chitukim-fixes-browser` download test.

## Files
`public/crm/crm.js`, `public/sw.js` (v117 → v118), `EZONE-ECOSYSTEM-STATUS.md`, tests above.
No Code.gs, no server change.
