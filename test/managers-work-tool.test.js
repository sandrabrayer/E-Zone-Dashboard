'use strict';

/* Managers work tool (CHANGELOG-managers-work-tool.md) — `managersWork`,
 * called by the ezone-managers server only, gated by its own fail-closed
 * MANAGERS_WORK_SECRET. Real apps-script/Code.gs in the shared vm sandbox. */

const { test } = require('node:test');
const assert = require('node:assert');
const { richSheet, loadGs } = require('./helpers/gs-sandbox');

const SECRET = 'mw-secret-123';
const arr = (x) => JSON.parse(JSON.stringify(x));

function boot({ secret = SECRET, today = '2026-10-13' } = {}) {
  const g = loadGs({ props: secret ? { MANAGERS_WORK_SECRET: secret } : {} });
  g.sandbox.Session = { getScriptTimeZone: () => 'Asia/Jerusalem' };
  g.sandbox.Utilities.formatDate = (d, tz, fmt) => {
    const x = new Date(d); const p = (n) => (n < 10 ? '0' + n : '' + n);
    if (fmt === 'HH:mm') return `${p(x.getHours())}:${p(x.getMinutes())}`;
    if (fmt === 'yyyy-MM') return `${x.getFullYear()}-${p(x.getMonth() + 1)}`;
    return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
  };
  g.run(`todayISODate_ = function () { return '${today}'; }`);
  const put = (name, colsExpr, rows) => {
    const cols = Array.from(g.run(colsExpr));
    const sh = richSheet(name, cols);
    rows.forEach((r) => sh.grid.push(cols.map((c) => r[c] ?? '')));
    g.sandbox.__sheets[name] = sh;
  };
  put('Patients', 'PATIENT_COLUMNS', [
    { houseId: 'ramot', name: 'דנה', date: '2026-09-01', status: 'active', id: 'p1' },
    { houseId: 'ramot', name: 'יוסי', date: '2026-10-05', status: 'trial', id: 'p2' },
    { houseId: 'ramot', name: 'עזב', date: '2026-08-01', exitDate: '2026-10-01', status: 'released', id: 'p3' },
    { houseId: 'arfoni', name: 'בבית אחר', date: '2026-09-01', status: 'active', id: 'p4' }
  ]);
  put('Outpatients', 'OUTPATIENT_COLUMNS', [
    { patient_name: 'מיכל', house_of_origin: 'ramot', therapy_type: 'day_2x', start_date: '2026-09-15' },
    { patient_name: 'סיים', house_of_origin: 'ramot', therapy_type: 'maintenance', start_date: '2026-06-01', end_date: '2026-09-30' },
    { patient_name: 'אחר', house_of_origin: 'efroni', therapy_type: 'day_daily', start_date: '2026-09-01' }
  ]);
  put('Leads', 'LEAD_COLUMNS', [
    { id: 'L1', name: 'ביקור א', house: 'רמות השבים', visitDate: '2026-10-08', visitTime: '10:30', meetingWith: 'אורן', meetingOutcome: 'entered' },
    { id: 'L2', name: 'ביקור ב', house: 'ramot', visitDate: '2026-10-11', visitTime: '', meetingWith: 'אורן', meetingOutcome: 'thinking' },
    { id: 'L3', name: 'ספטמבר', house: 'רמות השבים', visitDate: '2026-09-20', meetingWith: 'אורן' },
    { id: 'L4', name: 'בית אחר', house: 'קיסריה עפרוני', visitDate: '2026-10-08', meetingWith: 'חנן' }
  ]);
  const call = (body) => arr(g.post({ action: 'managersWork', secret: SECRET, ...body }));
  return { g, call };
}
const ORAN = { house: 'ramot', role: 'manager', actor: 'אורן' };
const SANDRA = { house: 'ramot', role: 'admin', actor: 'סנדרה' };

test('fail-closed: no secret configured, no secret sent, or a wrong secret → refused, nothing read', () => {
  const unset = boot({ secret: '' });
  assert.deepStrictEqual(arr(unset.g.post({ action: 'managersWork', secret: SECRET, op: 'houseData', ...ORAN })), { ok: false, error: 'unauthorized' });
  const { g } = boot();
  assert.deepStrictEqual(arr(g.post({ action: 'managersWork', op: 'houseData', ...ORAN })), { ok: false, error: 'unauthorized' });
  assert.deepStrictEqual(arr(g.post({ action: 'managersWork', secret: SECRET + 'x', op: 'houseData', ...ORAN })), { ok: false, error: 'unauthorized' });
});

test('caller is validated: unknown house, unknown role or no actor → bad_request', () => {
  const { call } = boot();
  assert.strictEqual(call({ op: 'houseData', ...ORAN, house: 'arfoni' }).error, 'bad_request', 'backend id, not a Managers key');
  assert.strictEqual(call({ op: 'houseData', ...ORAN, role: 'superuser' }).error, 'bad_request');
  assert.strictEqual(call({ op: 'houseData', ...ORAN, actor: '' }).error, 'bad_request');
  assert.strictEqual(call({ op: 'nope', ...ORAN }).error, 'unknown_op');
});

test('houseData: patients in the house today, outpatients from the house, visits and admissions this month — this house only', () => {
  const { call } = boot();
  const d = call({ op: 'houseData', month: '2026-10', ...ORAN });
  assert.strictEqual(d.ok, true);
  assert.deepStrictEqual(d.patients.map((p) => p.name), ['דנה', 'יוסי']);
  assert.deepStrictEqual(d.patients[0], { name: 'דנה', entryDate: '2026-09-01', days: 43, status: 'active' });
  assert.deepStrictEqual(d.outpatients, [{ name: 'מיכל', therapy: 'טיפול יום — פעמיים בשבוע', startDate: '2026-09-15' }]);
  assert.deepStrictEqual(d.visits.map((v) => [v.name, v.date, v.time, v.outcome]), [['ביקור ב', '2026-10-11', '', 'thinking'], ['ביקור א', '2026-10-08', '10:30', 'entered']]);
  assert.deepStrictEqual(d.admissions, [{ name: 'יוסי', date: '2026-10-05' }]);
});

test('logs: add a family call, read it back; required fields enforced; text cleaned', () => {
  const { call, g } = boot();
  const bad = call({ op: 'logAdd', log: 'familyCalls', entry: JSON.stringify({ patientName: 'דנה' }), ...ORAN });
  assert.deepStrictEqual([bad.ok, bad.error, bad.fields], [false, 'missing_fields', ['contactName', 'callDate', 'summary']]);
  const ok = call({ op: 'logAdd', log: 'familyCalls', ...ORAN, entry: JSON.stringify({
    patientName: 'דנה', contactName: '=HYPERLINK("x")', relation: 'אמא', callDate: '2026-10-12', callTime: '18:05',
    summary: 'עדכון <b>מצב</b>\nשורה שנייה', followUpDate: '2026-10-13' }) });
  assert.strictEqual(ok.ok, true);
  const d = call({ op: 'houseData', ...ORAN });
  const row = d.logs.familyCalls[0];
  assert.strictEqual(row.contactName, 'HYPERLINK("x")', 'formula lead-in stripped');
  assert.strictEqual(row.summary, 'עדכון bמצב/b שורה שנייה', 'angle brackets and control characters removed');
  assert.deepStrictEqual([row.callDate, row.callTime, row.author, row.followUpDone], ['2026-10-12', '18:05', 'אורן', false]);
  assert.deepStrictEqual(d.followUps, [{ log: 'familyCalls', id: row.id, date: '2026-10-13' }], 'due today');
  // Stored as text cells.
  assert.ok(g.sandbox.__sheets.ManagersFamilyCalls, 'sheet created on first write');
});

test('staff talks are PRIVATE: another manager of the same house never sees them; an admin does', () => {
  const { call } = boot();
  call({ op: 'logAdd', log: 'staffTalks', ...ORAN, entry: JSON.stringify({ employeeName: 'רינה', talkDate: '2026-10-10', summary: 'שיחה אישית' }) });
  assert.strictEqual(call({ op: 'houseData', ...ORAN }).logs.staffTalks.length, 1, 'the author sees it');
  const other = { house: 'ramot', role: 'manager', actor: 'שחר' };
  assert.strictEqual(call({ op: 'houseData', ...other }).logs.staffTalks.length, 0, 'another manager does not');
  assert.strictEqual(call({ op: 'houseData', ...SANDRA }).logs.staffTalks.length, 1, 'an admin does');
  const elsewhere = { house: 'efroni', role: 'admin', actor: 'סנדרה' };
  assert.strictEqual(call({ op: 'houseData', ...elsewhere }).logs.staffTalks.length, 0, 'never another house');
});

test('logUpdate: mark a follow-up done, soft-delete; only the author or an admin; never across houses', () => {
  const { call } = boot();
  const id = call({ op: 'logAdd', log: 'events', ...ORAN, entry: JSON.stringify({ eventDate: '2026-10-12', patientName: 'דנה', whatHappened: 'נפילה', actionTaken: 'בדיקת אחות', followUpDate: '2026-10-12' }) }).id;
  assert.strictEqual(call({ op: 'logUpdate', log: 'events', id, patch: JSON.stringify({ followUpDone: true }), house: 'efroni', role: 'admin', actor: 'סנדרה' }).error, 'not_found', 'other house');
  assert.strictEqual(call({ op: 'logUpdate', log: 'events', id, patch: JSON.stringify({ followUpDone: true }), house: 'ramot', role: 'manager', actor: 'שחר' }).error, 'forbidden', 'not the author');
  assert.strictEqual(call({ op: 'logUpdate', log: 'events', id, patch: JSON.stringify({ followUpDone: true }), ...ORAN }).ok, true);
  let d = call({ op: 'houseData', ...ORAN });
  assert.strictEqual(d.logs.events[0].followUpDone, true);
  assert.deepStrictEqual(d.followUps, [], 'done → no longer due');
  assert.strictEqual(call({ op: 'logUpdate', log: 'events', id, patch: JSON.stringify({ deleted: true }), ...SANDRA }).ok, true, 'an admin may delete');
  d = call({ op: 'houseData', ...ORAN });
  assert.strictEqual(d.logs.events.length, 0, 'soft-deleted rows are hidden');
  assert.strictEqual(call({ op: 'logUpdate', log: 'events', id, patch: JSON.stringify({ deleted: true }), ...SANDRA }).error, 'not_found', 'already deleted');
});

test('invalid dates and times are rejected, not stored', () => {
  const { call } = boot();
  const r = call({ op: 'logAdd', log: 'events', ...ORAN, entry: JSON.stringify({ eventDate: '2026-02-30', whatHappened: 'x', eventTime: '25:00' }) });
  assert.deepStrictEqual(r.fields, ['eventDate']);
  const id = call({ op: 'logAdd', log: 'events', ...ORAN, entry: JSON.stringify({ eventDate: '2026-10-01', whatHappened: 'x', eventTime: '25:00', followUpDate: 'tomorrow' }) }).id;
  const row = call({ op: 'houseData', ...ORAN }).logs.events.find((e) => e.id === id);
  assert.deepStrictEqual([row.eventTime, row.followUpDate], ['', '']);
  assert.strictEqual(call({ op: 'logAdd', log: 'salaries', ...ORAN, entry: '{}' }).error, 'unknown_log');
});

test('the other payloads are untouched: managersHouse / managersOverview carry no log data', () => {
  const { g, call } = boot();
  call({ op: 'logAdd', log: 'familyCalls', ...ORAN, entry: JSON.stringify({ patientName: 'דנה', contactName: 'אמא', callDate: '2026-10-12', summary: 'סוד' }) });
  const h = JSON.stringify(g.sandbox.managersHouse_('ramot', '2026-10'));
  const o = JSON.stringify(g.sandbox.managersOverview_('2026-10'));
  assert.ok(!h.includes('סוד') && !o.includes('סוד'));
});

/* ---- Stage 2: the house team from the Coordinators ManagersHouse digest ---- */
const { richSheet: digestSheet } = require('./helpers/gs-sandbox');
const DIGEST_COLS = {
  ManagersShifts: ['house', 'date', 'shift', 'guideName', 'scheduleStatus', 'updatedAt'],
  ManagersStaff: ['house', 'name', 'kind', 'role', 'phone', 'onLeave', 'workdays', 'updatedAt'],
  ManagersTherapistWeek: ['house', 'dayOfWeek', 'time', 'therapistName', 'patientName', 'updatedAt'],
};
function withDigest(rows, { id = 'digest-1', drop = null, missingTab = null } = {}) {
  const t = boot();
  if (id) t.g.sandbox.__props.MANAGERS_DIGEST_SHEET_ID = id;
  const book = {};
  Object.keys(DIGEST_COLS).forEach((tab) => {
    if (tab === missingTab) return;
    const cols = DIGEST_COLS[tab].filter((c) => c !== drop);
    const sh = digestSheet(tab, cols);
    (rows[tab] || []).forEach((r) => sh.grid.push(cols.map((c) => r[c] ?? '')));
    book[tab] = sh;
  });
  t.opened = [];
  t.g.sandbox.SpreadsheetApp.openById = (x) => { t.opened.push(x); return { getSheetByName: (n) => book[n] || null }; };
  return t;
}
const NOW = new Date().toISOString();
const ROWS = {
  ManagersShifts: [
    { house: 'ramot-hashavim', date: '2026-10-13', shift: 'בוקר', guideName: 'אבי', scheduleStatus: 'published', updatedAt: NOW },
    { house: 'ramot-hashavim', date: '2026-10-13', shift: 'אחר צהריים', guideName: '=evil()', scheduleStatus: 'published', updatedAt: NOW },
    { house: 'ramot-hashavim', date: '2026-10-14', shift: 'לילה', guideName: 'גל', scheduleStatus: 'draft', updatedAt: NOW },
    { house: 'ramot-hashavim', date: '2026-10-14', shift: 'xx', guideName: 'גל', scheduleStatus: 'draft', updatedAt: NOW },
    { house: 'caesarea-ofroni', date: '2026-10-13', shift: 'בוקר', guideName: 'של עפרוני', scheduleStatus: 'published', updatedAt: NOW },
  ],
  ManagersStaff: [
    { house: 'ramot-hashavim', name: 'אבי', kind: 'guide', role: 'מדריך/ה', phone: '0501234567', updatedAt: NOW },
    { house: 'ramot-hashavim', name: 'ד"ר כהן', kind: 'therapist', role: 'פסיכיאטר/ית', phone: 'not-a-phone', onLeave: 'true', workdays: '0,2,9', updatedAt: NOW },
    { house: 'caesarea-ofroni', name: 'של עפרוני', kind: 'guide', role: 'מדריך/ה', updatedAt: NOW },
  ],
  ManagersTherapistWeek: [
    { house: 'ramot-hashavim', dayOfWeek: '2', time: '10:00', therapistName: 'ד"ר כהן', patientName: 'דנה', updatedAt: NOW },
    { house: 'ramot-hashavim', dayOfWeek: '8', time: '10:00', therapistName: 'ד"ר כהן', patientName: 'דנה', updatedAt: NOW },
    { house: 'caesarea-ofroni', dayOfWeek: '1', time: '09:00', therapistName: 'אחר', patientName: 'אחר', updatedAt: NOW },
  ],
};

test('team: no MANAGERS_DIGEST_SHEET_ID → honest not_configured, nothing opened, the rest of houseData intact', () => {
  const t = withDigest(ROWS, { id: '' });
  const r = t.call({ op: 'houseData', ...ORAN });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.team, { available: false, reason: 'not_configured' });
  assert.strictEqual(t.opened.length, 0);
  assert.ok(r.patients.length > 0);
});

test('team: a tab not filled yet → pending; a missing column → contract_mismatch (never an empty team)', () => {
  assert.deepStrictEqual(withDigest(ROWS, { missingTab: 'ManagersStaff' }).call({ op: 'houseData', ...ORAN }).team, { available: false, reason: 'pending' });
  assert.deepStrictEqual(withDigest(ROWS, { drop: 'guideName' }).call({ op: 'houseData', ...ORAN }).team, { available: false, reason: 'contract_mismatch' });
  const t = withDigest(ROWS);
  t.g.sandbox.SpreadsheetApp.openById = () => { throw new Error('no access'); };
  assert.deepStrictEqual(t.call({ op: 'houseData', ...ORAN }).team, { available: false, reason: 'unreadable' });
});

test('team: only the caller\'s house; today\'s shifts, staff, therapist week — cleaned and validated', () => {
  const t = withDigest(ROWS);
  const team = t.call({ op: 'houseData', ...ORAN }).team;
  assert.strictEqual(team.available, true);
  assert.strictEqual(team.stale, false);
  assert.deepStrictEqual(team.today, [
    { date: '2026-10-13', shift: 'בוקר', guideName: 'אבי', draft: false },
    { date: '2026-10-13', shift: 'ערב', guideName: 'evil()', draft: false },
  ]);
  assert.deepStrictEqual(team.shifts.map((s) => s.guideName), ['אבי', 'evil()', 'גל']);
  assert.strictEqual(team.shifts[2].draft, true);
  assert.deepStrictEqual(team.staff, [
    { name: 'אבי', kind: 'guide', role: 'מדריך/ה', phone: '0501234567', onLeave: false, workdays: [] },
    { name: 'ד"ר כהן', kind: 'therapist', role: 'פסיכיאטר/ית', phone: '', onLeave: true, workdays: [0, 2] },
  ]);
  assert.deepStrictEqual(team.therapistWeek, [{ dayOfWeek: 2, time: '10:00', therapistName: 'ד"ר כהן', patientName: 'דנה' }]);
  assert.ok(!JSON.stringify(team).includes('עפרוני'), 'no other house leaks');
});

test('team: an old refresh is flagged stale; the digest is cached (one openById for repeated reads)', () => {
  const old = JSON.parse(JSON.stringify(ROWS));
  Object.values(old).forEach((rows) => rows.forEach((r) => { r.updatedAt = '2026-10-01T00:00:00.000Z'; }));
  const t = withDigest(old);
  assert.strictEqual(t.call({ op: 'houseData', ...ORAN }).team.stale, true);
  t.call({ op: 'houseData', ...SANDRA });
  assert.strictEqual(t.opened.length, 1);
});

test('houseData: expected admissions = open leads of THIS house with a planned entry today..+13 days, minimal fields', () => {
  const t = boot();
  const cols = Array.from(t.g.run('LEAD_COLUMNS'));
  const sh = t.g.sandbox.__sheets.Leads;
  [
    { id: 'E1', name: 'נכנס מחר', house: 'רמות השבים', entryDate: '2026-10-14', stage: 'paid', meetingWith: 'אורן', phone: '0501234567' },
    { id: 'E2', name: 'בעוד שבוע', house: 'ramot', entryDate: '2026-10-20', stage: 'entry' },
    { id: 'E3', name: 'כבר נקלט', house: 'רמות השבים', entryDate: '2026-10-15', stage: 'admitted' },
    { id: 'E4', name: 'לא רלוונטי', house: 'רמות השבים', entryDate: '2026-10-15', stage: 'irrelevant' },
    { id: 'E5', name: 'רחוק מדי', house: 'רמות השבים', entryDate: '2026-11-20', stage: 'paid' },
    { id: 'E6', name: 'אתמול', house: 'רמות השבים', entryDate: '2026-10-12', stage: 'paid' },
    { id: 'E7', name: 'בית אחר', house: 'קיסריה עפרוני', entryDate: '2026-10-15', stage: 'paid' },
    { id: 'E8', name: '=bad<b>', house: 'רמות השבים', entryDate: '2026-10-13', stage: '' }
  ].forEach((r) => sh.grid.push(cols.map((c) => r[c] ?? '')));
  const r = t.call({ op: 'houseData', ...ORAN });
  assert.deepStrictEqual(r.expectedAdmissions, [
    { name: 'badb', date: '2026-10-13', stage: 'new', meetingWith: '' },
    { name: 'נכנס מחר', date: '2026-10-14', stage: 'paid', meetingWith: 'אורן' },
    { name: 'בעוד שבוע', date: '2026-10-20', stage: 'entry', meetingWith: '' }
  ]);
  assert.ok(!JSON.stringify(r.expectedAdmissions).includes('0501234567'), 'no phone');
});
