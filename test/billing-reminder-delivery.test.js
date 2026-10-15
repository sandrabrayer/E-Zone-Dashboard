'use strict';

// No real recipients, external services, source writes or triggers in these tests.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadGs, richSheet } = require('./helpers/gs-sandbox');
const M = require('../lib/billing-reminder-mail');
const { build } = require('../scripts/build-billing-reminder-core');
const ROOT = path.join(__dirname, '..');
const CORE = fs.readFileSync(path.join(ROOT, 'apps-script/BillingReminderCore.gs'), 'utf8');
const ADAPTER = fs.readFileSync(path.join(ROOT, 'apps-script/BillingReminders.gs'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const props = () => ({ BILLING_REMINDER_ENABLED: 'true', BILLING_REMINDER_REPLACES_DIGEST: 'true',
  BILLING_REMINDER_HOUR: '8', BILLING_REMINDER_POLICY: 'all_open',
  BILLING_ALERT_EMAIL_VERED: 'vered@example.test', BILLING_ALERT_EMAIL_ORTAL: 'OrtalT@example.test' });
function data(day = '2026-10-14') {
  return { ok: true, today: day, receipts: [{ id: 'receipt-secret', amount: 9000, receivedDate: '2026-10-01', confirmStatus: 'partial', confirmedAmount: 3000,
    patientName: 'PRIVATE PATIENT <img src=x>', payer: 'PRIVATE PAYER', reference: 'PRIVATE REF', controlNote: 'PRIVATE NOTE' }],
  followup: { complete: true, receiptRecordedDates: { 'receipt-secret': '2026-10-01' },
    cycles: [{ kind: 'recorded', amount: 5000, houseId: 'house-secret', patientName: 'PRIVATE CYCLE', originalDueDate: '2026-10-01' }] } };
}
function plan(q = data(), overrides = {}, clock = { day: q.today, hour: 8 }) {
  const parsed = M.configFromProperties({ ...props(), ...overrides });
  assert.equal(parsed.ok, true, parsed.error);
  return M.plan(q, parsed.config, clock);
}
function world(overrides = {}) {
  const g = loadGs({ props: { ...props(), ...overrides } });
  g.run(CORE + '\n' + ADAPTER);
  g.sandbox.Intl = undefined; // the generated core cannot depend on GAS Intl.
  const effects = { sends: [], writes: [], reads: 0, releases: 0, quota: 100, lock: true };
  let day = '2026-10-14';
  g.sandbox.__queue = data(day);
  g.sandbox.__read = () => { effects.reads++; return g.sandbox.__queue; };
  g.run('billingControlQueue_ = () => __read()');
  g.sandbox.Utilities.formatDate = (d, tz, format) => {
    assert.equal(tz, 'Asia/Jerusalem');
    const parts = {};
    new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(d)).forEach(p => { parts[p.type] = p.value; });
    return format === 'HH' ? parts.hour : `${parts.year}-${parts.month}-${parts.day}`;
  };
  g.sandbox.PropertiesService.getScriptProperties = () => ({
    getProperty: key => g.sandbox.__props[key] ?? null,
    setProperty: (key, value) => { effects.writes.push({ key, value }); if (effects.onWrite) effects.onWrite(key, value); g.sandbox.__props[key] = value; },
  });
  g.sandbox.MailApp = {
    getRemainingDailyQuota: () => effects.quota,
    sendEmail: mail => { effects.sends.push(plain(mail)); if (effects.onSend) effects.onSend(mail); },
  };
  g.sandbox.LockService = { getScriptLock: () => ({
    tryLock: ms => { assert.equal(ms, 5000); if (effects.onLock) effects.onLock(); return effects.lock; },
    releaseLock: () => effects.releases++,
  }) };
  const run = (iso = day + 'T05:10:00Z', preview = false, legacy = false) => plain(g.run(legacy
    ? `paymentsDigestRun_('scheduled', new Date(${JSON.stringify(iso)}))`
    : `billingReminderRun_(new Date(${JSON.stringify(iso)}), ${preview})`));
  return { g, effects, run };
}

test('configuration requires exact separate recipients, explicit hour, policy and digest transition', () => {
  for (const [key, value, error] of [
    ['BILLING_ALERT_EMAIL_VERED', 'x@example.test\r\nBcc: attacker@example.test', 'invalid_recipients'],
    ['BILLING_ALERT_EMAIL_VERED', 'x@example.test,y@example.test', 'invalid_recipients'],
    ['BILLING_ALERT_EMAIL_VERED', 'ortalt@EXAMPLE.test', 'invalid_recipients'],
    ['BILLING_REMINDER_HOUR', '', 'missing_hour'], ['BILLING_REMINDER_HOUR', '8oops', 'missing_hour'],
    ['BILLING_REMINDER_POLICY', '', 'missing_policy'], ['BILLING_REMINDER_REPLACES_DIGEST', 'false', 'digest_transition_unconfirmed'],
  ]) assert.equal(M.configFromProperties({ ...props(), [key]: value }).error, error);
  assert.equal(M.configFromProperties(props()).config.to.ortal, 'OrtalT@example.test');
});

test('both audiences use the deployed queue, names/money/notes never enter the mail, with Hebrew text and HTML', () => {
  const p = plan();
  assert.deepEqual(p.messages.map(m => m.owner), ['vered', 'ortal']);
  assert.match(p.messages[0].mail.body, /יתרות מחזורים רשומים: 1/);
  assert.doesNotMatch(p.messages[0].mail.body, /הפרשים באימות חלקי/);
  assert.match(p.messages[1].mail.body, /הפרשים באימות חלקי: 1/);
  assert.match(p.messages[1].mail.body, /מעקב אחר משימות ורד/);
  for (const m of p.messages) {
    for (const secret of ['PRIVATE', 'receipt-secret', 'house-secret', '9000', '5000', '3000', '<img']) assert.ok(!JSON.stringify(m.mail).includes(secret), secret);
    assert.match(m.mail.htmlBody, /<html lang="he" dir="rtl">/);
    assert.match(m.mail.htmlBody, /role="presentation"/);
    assert.match(m.mail.body, /https:\/\/ezone-dashboard.up.railway.app\/#billing-control/);
    assert.ok(!/[\r\n]/.test(m.mail.subject));
    assert.equal(m.mail.cc, undefined);
  }
});

test('Thursday sends only Ortal; weekends, holiday eves and holidays send neither; unknown calendar fails closed', () => {
  assert.deepEqual(plan(data('2026-10-15')).messages.map(m => m.owner), ['ortal']);
  for (const day of ['2026-10-16', '2026-10-17', '2026-09-11', '2026-09-20', '2026-09-21']) assert.equal(plan(data(day)).messages.length, 0, day);
  assert.equal(plan(data('2036-01-06')).error, 'calendar_unavailable');
});

test('source failure, incomplete/unknown work or stale date cannot send an all-clear message', () => {
  const q = data();
  for (const d of [{ ...q, ok: false }, { ...q, followup: { ...q.followup, complete: false } },
    { ...q, followup: { ...q.followup, cycles: [{ kind: 'future_kind', amount: 5 }] } }]) assert.equal(plan(d).error, 'source_incomplete');
  assert.equal(plan(q, {}, { day: '2026-10-15', hour: 8 }).error, 'source_incomplete');
  assert.equal(plan(q, {}, { day: q.today, hour: 7 }).skipped, 'outside_hour');
});

test('confirmation closes receipt work immediately; funder waiting alone never triggers a mail', () => {
  const q = data();
  q.receipts[0].confirmStatus = 'confirmed';
  q.followup.cycles[0].funderGrace = true;
  assert.equal(plan(q).messages.length, 0);
  q.receipts[0].confirmStatus = 'reported';
  const p = plan(q);
  assert.deepEqual(p.messages.map(m => m.owner), ['ortal']);
  assert.match(p.messages[0].mail.body, /בהמתנה למממן: 1/);
});

test('age policy has no defaults; explicitly supplied inclusive thresholds gate delivery, unknown dates remain visible', () => {
  const settings = { BILLING_REMINDER_POLICY: 'aged', BILLING_REMINDER_MIN_DAYS: JSON.stringify({ reported: 365, partial: 365, flagged: 365, recorded: 365, unrecorded: 365 }) };
  assert.equal(M.configFromProperties({ ...props(), BILLING_REMINDER_POLICY: 'aged' }).error, 'invalid_thresholds');
  assert.equal(plan(data(), settings).messages.length, 0);
  const q = data(); q.followup.receiptRecordedDates = {};
  const p = plan(q, settings);
  assert.deepEqual(p.messages.map(m => m.owner), ['ortal']);
  assert.match(p.messages[0].mail.body, /גיל לא זמין עבור 1/);
  assert.equal(plan(data(), { ...settings, BILLING_REMINDER_MIN_DAYS: JSON.stringify({ reported: 0, partial: 0, flagged: 0, recorded: 0, unrecorded: 0 }) }).messages.length, 2);
});

test('generated Apps Script bundle is current; calendar matches every validated date without Intl', () => {
  assert.equal(CORE, build());
  const context = vm.createContext({ Intl: undefined });
  vm.runInContext(CORE, context);
  const C = context.BillingReminderCore;
  for (let n = Date.UTC(2020, 0, 1); n < Date.UTC(2036, 0, 1); n += 86400000) {
    const day = new Date(n).toISOString().slice(0, 10);
    for (const owner of ['vered', 'ortal']) {
      assert.equal(C.calendar.isBusinessDay(day, owner), M.calendar.isBusinessDay(day, owner), day);
      assert.equal(C.calendar.businessDaysBetween(day.slice(0, 4) + '-01-01', day, owner), M.calendar.businessDaysBetween(day.slice(0, 4) + '-01-01', day, owner), day);
    }
  }
  for (const owner of ['vered', 'ortal']) assert.equal(C.calendar.businessDaysBetween('2020-12-24', '2026-10-14', owner), M.calendar.businessDaysBetween('2020-12-24', '2026-10-14', owner));
  assert.deepEqual(plain(C.plan(data(), C.configFromProperties(props()).config, { day: '2026-10-14', hour: 8 })), plan());
});

test('default off, missing config, wrong hour and lock contention do not read source, write state or send', () => {
  for (const settings of [{ BILLING_REMINDER_ENABLED: '' }, { BILLING_REMINDER_HOUR: '' }, { BILLING_REMINDER_POLICY: '' }, { BILLING_REMINDER_HOUR: '9' }]) {
    const w = world(settings); w.run();
    assert.equal(w.effects.reads, 0); assert.equal(w.effects.writes.length, 0); assert.equal(w.effects.sends.length, 0);
  }
  const w = world(); w.effects.lock = false;
  assert.equal(w.run().error, 'lock_busy'); assert.equal(w.effects.reads, 0); assert.equal(w.effects.releases, 0);
});

test('preview returns only projected mail; no lock, state write, send or trigger', () => {
  const w = world({ BILLING_REMINDER_ENABLED: '' });
  const p = w.run('2026-10-14T15:00:00Z', true);
  assert.equal(p.previewOnly, true); assert.equal(p.messages.length, 2);
  assert.equal(w.effects.sends.length, 0); assert.equal(w.effects.writes.length, 0); assert.equal(w.effects.releases, 0);
  assert.ok(!JSON.stringify(p).includes('PRIVATE'));
});

test('only successful mail returns mark SENT; repeat and surviving old trigger use the same ledger', () => {
  const w = world();
  assert.equal(w.run().sent, 2); assert.equal(w.effects.sends.length, 2);
  assert.ok(w.effects.writes.every(x => !x.value.includes('@')));
  assert.equal(w.run().sent, 0);
  assert.equal(w.run(undefined, false, true).sent, 0);
  assert.equal(w.effects.sends.length, 2);
  assert.ok(w.g.logs.every(line => !/PRIVATE|@|9000/.test(line)));
});

test('simultaneous invocation cannot pass the script lock while the first mail is in flight', () => {
  const w = world(); let nested;
  w.effects.onSend = () => { w.effects.lock = false; nested = w.run(); w.effects.lock = true; };
  assert.equal(w.run().sent, 2); assert.equal(nested.error, 'lock_busy'); assert.equal(w.effects.sends.length, 2);
});

test('ambiguous provider exception is not success and is not resent by either trigger that day', () => {
  const w = world();
  w.effects.onSend = () => { throw new Error('PRIVATE provider detail'); };
  const r = w.run(); assert.equal(r.ok, false); assert.equal(r.sent, 0);
  assert.ok(r.results.every(x => x.status === 'uncertain'));
  assert.ok(!JSON.stringify(w.g.logs).includes('PRIVATE'));
  assert.equal(w.run().sent, 0); assert.equal(w.effects.sends.length, 2);
  assert.throws(() => w.run(undefined, false, true), /Billing reminder failed/);
  assert.equal(w.effects.sends.length, 2);
});

test('write-before-send failure sends nothing; failure to record success leaves an attempt that prevents duplicates', () => {
  const before = world(); before.effects.onWrite = () => { throw new Error('storage unavailable'); };
  assert.equal(before.run().sent, 0); assert.equal(before.effects.sends.length, 0);
  const after = world(); after.effects.onWrite = (_, value) => { if (JSON.parse(value).status === 'sent') throw new Error('storage unavailable'); };
  assert.equal(after.run().sent, 0); assert.equal(after.effects.sends.length, 2);
  assert.equal(after.run().sent, 0); assert.equal(after.effects.sends.length, 2);
  assert.equal(JSON.parse(after.g.sandbox.__props.BILLING_REMINDER_STATE_VERED).status, 'attempting');
});

test('known pre-send quota failure is retryable, partial audience success is retained', () => {
  const w = world(); w.effects.quota = 0;
  assert.equal(w.run().sent, 0); assert.equal(w.effects.writes.length, 0);
  w.effects.quota = 1; w.effects.onSend = () => { w.effects.quota = 0; };
  assert.equal(w.run().sent, 1);
  w.effects.quota = 1;
  assert.equal(w.run().sent, 1); assert.equal(w.effects.sends.length, 2);
});

test('corrupt or future sender state blocks sending rather than resets the duplicate guard', () => {
  for (const raw of ['oops', 'null', '0', '[]', '{}', '{"day":"bad","status":"sent"}', '{"day":"2026-10-15","status":"sent"}']) {
    const w = world({ BILLING_REMINDER_STATE_VERED: raw });
    const r = w.run(); assert.equal(r.ok, false, raw); assert.equal(r.sent, 1);
    assert.ok(r.results[0].status.startsWith('blocked_')); assert.equal(w.effects.sends[0].to, 'OrtalT@example.test');
  }
});

test('configuration is refreshed under the lock; disabling or changing recipient takes effect', () => {
  const off = world(); off.effects.onLock = () => { off.g.sandbox.__props.BILLING_REMINDER_ENABLED = ''; };
  assert.equal(off.run().skipped, 'disabled'); assert.equal(off.effects.reads, 0);
  const changed = world(); changed.effects.onLock = () => { changed.g.sandbox.__props.BILLING_ALERT_EMAIL_VERED = 'new@example.test'; };
  changed.run(); assert.equal(changed.effects.sends[0].to, 'new@example.test');
});

test('clock follows Israel DST, not server UTC; next workday is a new daily reminder', () => {
  const w = world();
  w.g.sandbox.__queue = data('2026-10-25');
  assert.equal(w.run('2026-10-25T05:10:00Z').skipped, 'outside_hour');
  assert.equal(w.run('2026-10-25T06:10:00Z').sent, 2);
  w.g.sandbox.__queue = data('2026-10-26');
  assert.equal(w.run('2026-10-26T06:10:00Z').sent, 2);
});

test('real queue and debt aging feed the sender without modifying any sheet', () => {
  const w = world();
  // Restore the production queue rather than returning the synthetic projection.
  const source = fs.readFileSync(path.join(ROOT, 'apps-script/Code.gs'), 'utf8');
  const start = source.indexOf('function billingControlQueue_(opts) {');
  const end = source.indexOf('\n/**', start);
  w.g.run(source.slice(start, end));
  w.g.run('paymentReportToday_ = () => "2026-10-14"');
  const name = 'SYNTHETIC PRIVATE', pid = `arfoni::${name}::2026-10-01`;
  const add = (sheet, columns, rows) => {
    const cols = Array.from(w.g.run(columns)), sh = richSheet(sheet, cols);
    rows.forEach(r => sh.appendRow(cols.map(c => r[c] ?? '')));
    sh.appendRow = () => { throw new Error('unexpected sheet write'); };
    const original = sh.getRange;
    sh.getRange = (...args) => { const range = original(...args); for (const method of ['setValue', 'setValues', 'clearContent', 'setNumberFormat']) range[method] = () => { throw new Error('unexpected sheet write'); }; return range; };
    w.g.sandbox.__sheets[sheet] = sh;
  };
  add('Patients', 'PATIENT_COLUMNS', [{ id: 'synthetic-p', houseId: 'arfoni', name, date: '2026-10-01', pay: 10000, status: 'active' }]);
  add('Payments', 'PAYMENT_COLUMNS', [
    { id: `pay::${pid}::2026-10-01`, patientId: pid, patientName: name, houseId: 'arfoni', dueDate: '2026-10-01', amount: 10000, amountPaid: 6000, balance: 4000, status: 'partial', coverageStart: '2026-10-01', coverageEnd: '2026-10-31' },
    { id: 'rcpt-private', patientId: pid, patientName: name, houseId: 'arfoni', dueDate: '2026-10-01', amount: 6000, amountPaid: 6000, balance: 0, status: 'paid', coverageStart: '2026-10-01', coverageEnd: '2026-10-31', receivedDate: '2026-10-02', recordedAt: '2026-10-03T10:00:00+03:00', confirmStatus: 'partial', confirmedAmount: 4000 },
  ]);
  const before = JSON.stringify(w.g.sandbox.__sheets);
  assert.equal(w.run().sent, 2);
  assert.equal(JSON.stringify(w.g.sandbox.__sheets), before);
  assert.ok(!JSON.stringify(w.effects.sends).includes(name));
});

test('editor installer is disabled without activation, creates before deleting only the two reminder handlers', () => {
  const off = world({ BILLING_REMINDER_ENABLED: '' });
  assert.throws(() => off.g.run('installBillingReminderTriggerNow()'), /disabled/);
  const w = world(), events = [];
  const trigger = (id, handler) => ({ getUniqueId: () => id, getHandlerFunction: () => handler });
  const created = trigger('new', 'billingRemindersJob');
  const builder = { timeBased() { return this; }, everyDays(n) { assert.equal(n, 1); return this; }, atHour(n) { assert.equal(n, 8); return this; }, inTimezone(tz) { assert.equal(tz, 'Asia/Jerusalem'); return this; }, create() { events.push('create'); return created; } };
  w.g.sandbox.ScriptApp = { AuthMode: { FULL: 'FULL' }, requireAllScopes: () => events.push('consent'),
    newTrigger: handler => { assert.equal(handler, 'billingRemindersJob'); return builder; },
    getProjectTriggers: () => [created, trigger('old1', 'paymentsDigestJob'), trigger('old2', 'billingRemindersJob'), trigger('other', 'unrelatedJob')],
    deleteTrigger: t => events.push('delete:' + t.getUniqueId()) };
  assert.equal(w.g.run('installBillingReminderTriggerNow()').ok, true);
  assert.deepEqual(events, ['consent', 'create', 'delete:old1', 'delete:old2']);
  assert.equal(w.effects.sends.length, 0);
});

test('reminder entry points are not exposed through the HTTP action dispatcher', () => {
  const g = loadGs({ props: { PROXY_SECRET_MODE: 'enforce', PROXY_SECRET: 'synthetic-secret' } });
  g.run(CORE + '\n' + ADAPTER);
  for (const action of ['billingRemindersJob', 'previewBillingRemindersNow', 'installBillingReminderTriggerNow', 'billingReminderRun_']) {
    const r = g.post({ action, proxySecret: 'synthetic-secret', proxyAuth: 'personal', proxyUserId: 'sandra', proxyUser: 'sandra', user: 'sandra', proxyRoles: ['admin', 'approver'], proxyCaps: ['billingControl', 'finance'] });
    assert.equal(r.ok, false); assert.equal(r.error, 'unknown_action'); assert.ok(!r.previewOnly);
  }
});
