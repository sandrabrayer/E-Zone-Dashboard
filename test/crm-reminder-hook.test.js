'use strict';

/* CRM Stage 4a — the follow-ups of «היום שלי» ride Vered's existing daily reminder
 * (CHANGELOG-crm-reminder-hook.md; spec §9: one mechanism, no duplicate). */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const M = require('../lib/billing-reminder-mail');
const { loadGs, richSheet } = require('./helpers/gs-sandbox');

const ROOT = path.join(__dirname, '..');
const CORE = fs.readFileSync(path.join(ROOT, 'apps-script/BillingReminderCore.gs'), 'utf8');
const ADAPTER = fs.readFileSync(path.join(ROOT, 'apps-script/BillingReminders.gs'), 'utf8');
const AUD = { owner: 'vered', groups: [{ owner: 'vered', count: 1, byKind: { reported: 1 }, oldestWorkAge: null, unknownAgeCount: 0, waitingCount: 0 }] };

test('render: with extras Vered\'s mail gains ONE «היום שלי» section — aggregate counts, labels, the CRM link; zero counts are omitted; no extras → the mail is byte-identical to the billing mail; Ortal never gets the section', () => {
  const plain = M.render(AUD, '2026-10-29');
  const withX = M.render(AUD, '2026-10-29', { callsLate: 2, callsToday: 1, otherToday: 0, meetingsToday: 1, undated: 3 });
  assert.match(withX.body, /היום שלי — שיחות, מעקבים ופגישות/); assert.match(withX.body, /שיחות ומעקבים באיחור: 2/); assert.match(withX.body, /פגישות קבלה היום: 1/); assert.match(withX.body, /ללא תאריך — לקבוע: 3/);
  assert.ok(!/משימות אחרות להיום/.test(withX.body), 'a zero line is omitted');
  assert.match(withX.body, /פתיחת היום שלי: https:\/\/ezone-dashboard\.up\.railway\.app\/\?view=crm/);
  assert.match(withX.htmlBody, /href="https:\/\/ezone-dashboard\.up\.railway\.app\/\?view=crm"/);
  assert.equal(withX.subject, plain.subject, 'same mail, same subject');
  assert.equal(M.render(AUD, '2026-10-29', null).body, plain.body); assert.equal(M.render(AUD, '2026-10-29', undefined).htmlBody, plain.htmlBody);
  const zero = M.render(AUD, '2026-10-29', { callsLate: 0, callsToday: 0, otherToday: 0, meetingsToday: 0, undated: 0 });
  assert.match(zero.body, /אין שיחות או מעקבים להיום/);
  const ortal = M.render({ owner: 'ortal', groups: [{ owner: 'vered', count: 1, byKind: {}, oldestWorkAge: null, unknownAgeCount: 0, waitingCount: 0 }] }, '2026-10-29', { callsLate: 5 });
  assert.ok(!/היום שלי/.test(ortal.body));
  assert.deepEqual(M.extraOf({ vered: { callsLate: '2', callsToday: -1, undated: 'x' } }, 'vered'), { callsLate: 2, callsToday: 0, otherToday: 0, meetingsToday: 0, undated: 0, total: 2 }, 'defensive normalisation');
  assert.equal(M.extraOf({}, 'vered'), null);
  assert.ok(!/₪|\d{3},\d{3}/.test(withX.body), 'no money');
});

test('generated Apps Script core is current with the lib (extras included)', () => {
  const build = require('../scripts/build-billing-reminder-core.js');
  assert.equal(CORE, build.build(), 'run: node scripts/build-billing-reminder-core.js');
});

test('Code.gs reminderExtras_: counts open non-money tasks of ורד (or unassigned) by state for the day — late / today / windows / undated — never money, never another owner; plus today\'s intake meetings; a failed read → null', () => {
  const g = loadGs({ props: {} });
  const tc = Array.from(g.run('TASK_COLUMNS')), lc = Array.from(g.run('LEAD_COLUMNS'));
  const ts = richSheet('Tasks', tc), ls = richSheet('Leads', lc);
  const T = (o) => ts.grid.push(tc.map((c) => (Object.assign({ status: 'open', kind: 'call', assignee: 'ורד' }, o))[c] ?? ''));
  T({ id: 'a', dueDate: '2026-10-20' });                                  // late call
  T({ id: 'b', dueDate: '2026-10-29', dueTime: '10:00' });                 // today call
  T({ id: 'c', dueDate: '2026-10-29', kind: 'review' });                   // other today
  T({ id: 'd' });                                                          // undated
  T({ id: 'e', windowStart: '2026-10-25', windowEnd: '2026-10-31' });       // window covering today → today
  T({ id: 'f', windowStart: '2026-10-11', windowEnd: '2026-10-17' });       // window passed → late
  T({ id: 'g', dueDate: '2026-11-05' });                                   // upcoming: not counted
  T({ id: 'h', dueDate: '2026-10-20', kind: 'collection', money: '1' });   // money: never
  T({ id: 'i', dueDate: '2026-10-20', assignee: 'דנה' });                   // another owner: not hers
  T({ id: 'j', dueDate: '2026-10-20', assignee: '' });                      // unassigned: counted
  T({ id: 'k', dueDate: '2026-10-20', status: 'done' });                    // closed: no
  ls.grid.push(lc.map((c) => ({ id: 'L1', name: 'x', stage: 'visit', visitDate: '2026-10-29' })[c] ?? ''));
  ls.grid.push(lc.map((c) => ({ id: 'L2', name: 'y', stage: 'visit', visitDate: '2026-10-30' })[c] ?? ''));
  ls.grid.push(lc.map((c) => ({ id: 'L3', name: 'z', stage: 'irrelevant', visitDate: '2026-10-29' })[c] ?? ''));
  g.sandbox.__sheets.Tasks = ts; g.sandbox.__sheets.Leads = ls;
  assert.deepEqual(JSON.parse(JSON.stringify(g.run("reminderExtras_('2026-10-29')"))), { vered: { callsLate: 3, callsToday: 2, otherToday: 1, meetingsToday: 1, undated: 1 } });
  g.run('tasksSheetRead_ = function () { throw new Error("boom"); }');
  assert.equal(g.run("reminderExtras_('2026-10-29')"), null, 'a failed read is null — the plain billing mail, never a fake all-clear');
});

test('the adapter passes the extras into plan: Vered\'s mail carries the section; with no billing work but CRM work due, her mail still goes out; the whole flow reads sheets only', () => {
  const g = loadGs({ props: { BILLING_REMINDER_ENABLED: 'true', BILLING_ALERT_EMAIL_VERED: 'v@example.com', BILLING_ALERT_EMAIL_ORTAL: 'o@example.com', BILLING_REMINDER_HOUR: '8', BILLING_REMINDER_POLICY: 'all_open', BILLING_REMINDER_REPLACES_DIGEST: 'true' } });
  g.run(CORE + '\n' + ADAPTER);
  g.sandbox.Intl = undefined;
  const day = '2026-10-14';   // a Wednesday
  // an empty but COMPLETE queue (no billing work at all)
  g.run('billingControlQueue_ = () => ({ ok: true, today: "' + day + '", receipts: [], counts: {}, followup: { complete: true, asOf: "' + day + '", cycles: [] } })');
  g.sandbox.Utilities.formatDate = (d, tz, format) => {
    const parts = {}; new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(d)).forEach((p) => { parts[p.type] = p.value; });
    return format === 'HH' ? parts.hour : `${parts.year}-${parts.month}-${parts.day}`;
  };
  const sends = [];
  g.sandbox.MailApp = { getRemainingDailyQuota: () => 100, sendEmail: (m) => sends.push(JSON.parse(JSON.stringify(m))) };
  g.sandbox.LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) };
  const tc = Array.from(g.run('TASK_COLUMNS')); const ts = richSheet('Tasks', tc);
  ts.grid.push(tc.map((c) => ({ id: 'a', status: 'open', kind: 'call', assignee: 'ורד', dueDate: '2026-10-10' })[c] ?? ''));
  g.sandbox.__sheets.Tasks = ts;
  const r = JSON.parse(JSON.stringify(g.run(`billingReminderRun_(new Date("${day}T05:10:00Z"), true)`)));
  assert.equal(r.ok, true, JSON.stringify(r));
  const vered = r.messages.filter((m) => m.owner === 'vered')[0];
  assert.ok(vered, 'Vered\'s mail goes out on CRM work alone');
  assert.match(vered.mail.body, /שיחות ומעקבים באיחור: 1/); assert.match(vered.mail.body, /view=crm/);
  assert.ok(!r.messages.some((m) => m.owner === 'ortal'), 'Ortal has no work');
});
