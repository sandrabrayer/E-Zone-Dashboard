'use strict';

// Private server/editor module. No addresses, clock, persistence or mail I/O.
const R = require('./billing-control-rules');
const calendar = require('./billing-work-calendar');
const OWNERS = ['vered', 'ortal'];
const NAMES = { vered: 'ורד', ortal: 'אורטל' };
const KINDS = ['reported', 'partial', 'flagged', 'recorded', 'unrecorded'];
const LABELS = ['דיווחים ממתינים לאימות', 'הפרשים באימות חלקי', 'בעיות בדיווח', 'יתרות מחזורים רשומים', 'מחזורים ללא דיווח'];
const URL = 'https://ezone-dashboard.up.railway.app/#billing-control';
/* CRM Stage 4a (CHANGELOG-crm-reminder-hook.md, spec §9): the follow-ups of «היום שלי» ride the SAME
 * daily mail — aggregate counts only (no names, no money), with the CRM link. `extras[owner]` =
 * { callsToday, callsLate, meetingsToday, windowThisWeek, undated } computed by Apps Script from the
 * Tasks sheet; absent → the section is omitted and the mail is exactly the billing mail. */
const CRM_URL = 'https://ezone-dashboard.up.railway.app/?view=crm';
const EXTRA_KEYS = ['callsLate', 'callsToday', 'otherToday', 'meetingsToday', 'undated'];
const EXTRA_LABELS = { callsLate: 'שיחות ומעקבים באיחור', callsToday: 'שיחות ומעקבים להיום', otherToday: 'משימות אחרות להיום', meetingsToday: 'פגישות קבלה היום', undated: 'משימות ללא תאריך — לקבוע' };
function extraOf(extras, owner) {
  const e = extras && typeof extras === 'object' ? extras[owner] : null;
  if (!e || typeof e !== 'object') return null;
  const out = {}; let total = 0;
  EXTRA_KEYS.forEach(k => { const n = Number(e[k]); out[k] = Number.isInteger(n) && n >= 0 ? n : 0; total += out[k]; });
  out.total = total;
  return out;
}

function configFromProperties(p) {
  const address = value => {
    const s = String(value || '').trim();
    return /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/.test(s) ? s : '';
  };
  const config = {
    enabled: p.BILLING_REMINDER_ENABLED === 'true',
    replacesDigest: p.BILLING_REMINDER_REPLACES_DIGEST === 'true',
    hour: /^(?:[0-9]|1[0-9]|2[0-3])$/.test(p.BILLING_REMINDER_HOUR || '') ? Number(p.BILLING_REMINDER_HOUR) : null,
    policy: p.BILLING_REMINDER_POLICY,
    to: { vered: address(p.BILLING_ALERT_EMAIL_VERED), ortal: address(p.BILLING_ALERT_EMAIL_ORTAL) },
    thresholds: null,
  };
  try { config.thresholds = JSON.parse(p.BILLING_REMINDER_MIN_DAYS || 'null'); } catch (_) { /* invalid below */ }
  let error = '';
  if (!config.to.vered || !config.to.ortal || config.to.vered.toLowerCase() === config.to.ortal.toLowerCase()) error = 'invalid_recipients';
  else if (config.hour === null) error = 'missing_hour';
  else if (!['all_open', 'aged'].includes(config.policy)) error = 'missing_policy';
  else if (config.policy === 'aged' && (!config.thresholds || KINDS.some(k => !Number.isInteger(config.thresholds[k]) || config.thresholds[k] < 0 || config.thresholds[k] > 365))) error = 'invalid_thresholds';
  else if (!config.replacesDigest) error = 'digest_transition_unconfirmed';
  return { ok: !error, error, config };
}

const esc = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
function render(audience, day, extra) {
  const date = day.slice(8, 10) + '/' + day.slice(5, 7) + '/' + day.slice(0, 4);
  const title = 'תזכורת משימות — ' + NAMES[audience.owner];
  const intro = 'סיכום כל המשימות הפתוחות מכל הבתים. המספרים הם משימות, לא מספר מטופלים. הפירוט והטיפול נמצאים באפליקציה.';
  const sections = audience.groups.map(g => {
    const heading = audience.owner === 'ortal' && g.owner === 'vered' ? 'מעקב אחר משימות ורד' : 'בטיפול ' + NAMES[g.owner];
    const lines = ['משימות לטיפול: ' + g.count];
    KINDS.forEach((k, i) => { if (g.byKind[k]) lines.push(LABELS[i] + ': ' + g.byKind[k]); });
    if (g.oldestWorkAge !== null) lines.push('גיל המשימה הוותיקה בין התאריכים הידועים: ' + g.oldestWorkAge + ' ימי עבודה של ' + NAMES[g.owner] + '.');
    if (g.unknownAgeCount) lines.push('גיל לא זמין עבור ' + g.unknownAgeCount + ' משימות; יש לבדוק את המועד המקורי.');
    lines.push('בהמתנה למממן: ' + g.waitingCount + ' — בנפרד ממשימות הטיפול.');
    return { heading, lines };
  });
  const x = extra && typeof extra === 'object' ? (extra.total !== undefined ? extra : extraOf({ x: extra }, 'x')) : null;
  if (x && audience.owner === 'vered') {
    const lines = EXTRA_KEYS.filter(k => x[k]).map(k => EXTRA_LABELS[k] + ': ' + x[k]);
    sections.push({ heading: 'היום שלי — שיחות, מעקבים ופגישות', lines: lines.length ? lines.concat(['המספרים הם משימות; הפירוט, תיעוד השיחה ושינוי המועד — ב-CRM.']) : ['אין שיחות או מעקבים להיום.'], crm: true });
  }
  const footer = 'השלמת טיפול באפליקציה מעדכנת את התור מיד, בכל יום. הודעה זו היא תמונת מצב למועד הכנתה.';
  const body = [title, date, intro, ...sections.flatMap(s => [s.heading, ...s.lines].concat(s.crm ? ['פתיחת היום שלי: ' + CRM_URL] : [])), 'פתיחת בקרת גבייה: ' + URL, footer].join('\n\n');
  const htmlBody = '<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><title>' + esc(title) + '</title></head>' +
    '<body dir="rtl" style="margin:0;background:#f4f6fa;color:#17233a;font-family:Arial,sans-serif;font-size:16px;line-height:1.6">' +
    '<table role="presentation" dir="rtl" width="100%" cellspacing="0" cellpadding="0"><tr><td align="right" style="padding:24px">' +
    '<h1 style="font-size:24px">' + esc(title) + '</h1><p>נכון ל־<span dir="ltr">' + date + '</span></p><p>' + esc(intro) + '</p>' +
    sections.map(s => '<h2 style="font-size:20px;border-top:1px solid #8995a8;padding-top:16px">' + esc(s.heading) + '</h2>' + s.lines.map(line => '<p>' + esc(line) + '</p>').join('') + (s.crm ? '<p><a href="' + CRM_URL + '" style="display:inline-block;background:#0073EA;color:#ffffff;padding:12px 20px;text-decoration:underline">פתיחת היום שלי</a></p>' : '')).join('') +
    '<p><a href="' + URL + '" style="display:inline-block;background:#163d77;color:#ffffff;padding:12px 20px;text-decoration:underline">פתיחת בקרת גבייה</a></p><p>' + esc(footer) + '</p></td></tr></table></body></html>';
  return { subject: 'E-ZONE | ' + title + ' | ' + date, body, htmlBody, name: 'E-ZONE Dashboard' };
}

function plan(data, config, clock, extras) {
  if (!config.enabled) return { ok: true, skipped: 'disabled', messages: [] };
  if (!clock || !R.isIsoDay(clock.day) || !Number.isInteger(clock.hour) || clock.hour < 0 || clock.hour > 23) return { ok: false, error: 'invalid_clock', messages: [] };
  if (clock.hour !== config.hour) return { ok: true, skipped: 'outside_hour', messages: [] };
  const preview = R.reminderPreview(data);
  if (!preview.available || !preview.complete || preview.stale || preview.asOf !== clock.day) return { ok: false, error: 'source_incomplete', messages: [] };
  const days = OWNERS.map(owner => calendar.isBusinessDay(clock.day, owner));
  if (days.some(d => d === null)) return { ok: false, error: 'calendar_unavailable', messages: [] };
  const rows = R.followupRows(data);
  const eligible = row => !row.funderGrace && (config.policy === 'all_open' || row.workAgeDays === null || row.workAgeDays >= config.thresholds[row.kind]);
  // Vered's mail also goes out when only CRM follow-ups are due (spec §9: one mechanism, no duplicate).
  const crmDue = a => a.owner === 'vered' && (extraOf(extras, 'vered') || { total: 0 }).total > 0;
  const messages = preview.audiences.filter((a, i) => days[i] && (rows.some(r => (a.owner === 'ortal' || r.owner === a.owner) && eligible(r)) || crmDue(a)))
    .map(a => ({ owner: a.owner, day: clock.day, to: config.to[a.owner], mail: render(a, clock.day, extraOf(extras, a.owner)) }));
  return { ok: true, messages, skipped: messages.length ? '' : 'no_work_due' };
}

module.exports = { configFromProperties, plan, render, calendar, extraOf, EXTRA_KEYS };
