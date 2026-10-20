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
const ORAN = { house: 'ramot', role: 'manager', actor: 'אורן', actorId: 'person-oran' };
const SANDRA = { house: 'ramot', role: 'admin', actor: 'סנדרה', actorId: 'person-sandra' };

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
  assert.deepStrictEqual(d.patients[0], { name: 'דנה', entryDate: '2026-09-01', days: 43, status: 'active', expectedDischarge: null });
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
  const other = { house: 'ramot', role: 'manager', actor: 'שחר', actorId: 'person-shahar' };
  assert.strictEqual(call({ op: 'houseData', ...other }).logs.staffTalks.length, 0, 'another manager does not');
  assert.strictEqual(call({ op: 'houseData', ...SANDRA }).logs.staffTalks.length, 1, 'an admin does');
  const elsewhere = { house: 'efroni', role: 'admin', actor: 'סנדרה', actorId: 'person-sandra' };
  assert.strictEqual(call({ op: 'houseData', ...elsewhere }).logs.staffTalks.length, 0, 'never another house');
});

test('logUpdate: mark a follow-up done, soft-delete; only the author or an admin; never across houses', () => {
  const { call } = boot();
  const id = call({ op: 'logAdd', log: 'events', ...ORAN, entry: JSON.stringify({ eventDate: '2026-10-12', patientName: 'דנה', whatHappened: 'נפילה', actionTaken: 'בדיקת אחות', followUpDate: '2026-10-12' }) }).id;
  assert.strictEqual(call({ op: 'logUpdate', log: 'events', id, patch: JSON.stringify({ followUpDone: true }), house: 'efroni', role: 'admin', actor: 'סנדרה', actorId: 'person-sandra' }).error, 'not_found', 'other house');
  assert.strictEqual(call({ op: 'logUpdate', log: 'events', id, patch: JSON.stringify({ followUpDone: true }), house: 'ramot', role: 'manager', actor: 'שחר', actorId: 'person-shahar' }).error, 'forbidden', 'not the author');
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

test('same-name accounts cannot read or update each other; display-name changes preserve ownership', () => {
  const { call } = boot();
  const id = call({ op: 'logAdd', log: 'staffTalks', ...ORAN, entry: JSON.stringify({ employeeName: 'Test', talkDate: '2026-10-10', summary: 'private', followUpDate: '2026-10-10', authorId: 'forged' }) }).id;
  const other = { ...ORAN, actorId: 'person-other' };
  const hidden = call({ op: 'houseData', ...other });
  assert.deepStrictEqual(hidden.logs.staffTalks, []);
  assert.deepStrictEqual(hidden.followUps, []);
  assert.strictEqual(call({ op: 'logUpdate', log: 'staffTalks', id, patch: '{"deleted":true}', ...other }).error, 'forbidden');
  const mine = call({ op: 'houseData', ...ORAN, actor: 'Renamed' }).logs.staffTalks;
  assert.strictEqual(mine.length, 1);
  assert.strictEqual(mine[0].canEdit, true);
  assert.strictEqual(call({ op: 'logUpdate', log: 'staffTalks', id, patch: '{"followUpDone":true}', ...ORAN, actor: 'Renamed' }).ok, true);
});

test('legacy private records without authorId are admin-only and never claimed by matching a name', () => {
  const { g, call } = boot();
  const cols = Array.from(g.run("mwColumns_('staffTalks')"));
  assert.strictEqual(cols.at(-1), 'authorId', 'schema appends the new field');
  const oldCols = cols.slice(0, -1);
  const sh = richSheet('ManagersStaffTalks', oldCols);
  const row = { id: 'legacy', house: 'ramot', author: ORAN.actor, employeeName: 'Test', summary: 'legacy private', talkDate: '2026-10-10', followUpDate: '2026-10-10' };
  sh.grid.push(oldCols.map(c => row[c] || ''));
  g.sandbox.__sheets.ManagersStaffTalks = sh;
  const before = JSON.stringify(sh.grid);
  assert.deepStrictEqual(call({ op: 'houseData', ...ORAN }).logs.staffTalks, []);
  assert.strictEqual(call({ op: 'logUpdate', log: 'staffTalks', id: 'legacy', patch: '{"deleted":true}', ...ORAN }).error, 'forbidden');
  assert.strictEqual(call({ op: 'houseData', ...SANDRA }).logs.staffTalks[0].canEdit, true);
  assert.strictEqual(JSON.stringify(sh.grid), before, 'reads and denied updates never migrate or change the legacy row');
  call({ op: 'logAdd', log: 'staffTalks', ...ORAN, entry: JSON.stringify({ employeeName: 'New', talkDate: '2026-10-10', summary: 'new' }) });
  assert.deepStrictEqual(sh.grid[0], cols);
  assert.deepStrictEqual(sh.grid[1], oldCols.map(c => row[c] || ''), 'adding a row leaves historical cells untouched');
  assert.strictEqual(call({ op: 'houseData', ...ORAN }).logs.staffTalks.length, 1, 'only the new owned row');
});

test('capabilities is authenticated, versioned, and performs no spreadsheet/cache/log/lock access', () => {
  const { g } = boot();
  for (const service of ['SpreadsheetApp', 'LockService', 'CacheService', 'Logger']) {
    g.sandbox[service] = new Proxy({}, { get() { throw Error('unexpected service access: ' + service); } });
  }
  const good = arr(g.post({ action: 'managersWork', op: 'capabilities', secret: SECRET }));
  assert.deepStrictEqual(good, { ok: true, protocol: 2, capabilities: ['stableActorId', 'scopedReads', 'privateLegacyAdminOnly'] });
  assert.strictEqual(g.post({ action: 'managersWork', op: 'capabilities', secret: 'wrong' }).error, 'unauthorized');
});

test('all manager actions refuse direct GET and missing/wrong/bodyless secrets in log and enforce modes, before reading or writing', () => {
  for (const mode of ['log', 'enforce']) {
    const g = loadGs({ props: { MANAGERS_WORK_SECRET: SECRET, PROXY_SECRET_MODE: mode } });
    g.sandbox.SpreadsheetApp = new Proxy({}, { get() { throw Error('unexpected sheet access'); } });
    for (const action of ['managersOverview', 'managersHouse', 'occupancySnapshots', 'managersWork']) {
      for (const sent of ['', 'wrong']) assert.strictEqual(g.post({ action, secret: sent, ...ORAN }).error, 'unauthorized');
      assert.strictEqual(g.sandbox.doGet({ parameter: { action, secret: SECRET, ...ORAN } }).json.error, 'unauthorized');
      const event = { parameter: { action, secret: SECRET, ...ORAN }, postData: { contents: JSON.stringify({ action }) } };
      assert.strictEqual(g.sandbox.doPost(event).json.error, 'unauthorized', 'query secret cannot authenticate a POST');
    }
  }
});

test('authenticated overview/house/history feeds enforce caller scope, including the efroni alias', () => {
  const { g } = boot();
  g.run(`managersOverview_ = function () { return { ok:true, houses:[{key:'ramot',patientsNow:4},{key:'efroni',patientsNow:3}], totals:{activePatients:7} }; };
    managersHouse_ = function (house) { return {ok:true,house:house}; };
    occupancySnapshots_ = function () { return {ok:true,rows:[{houseId:'ramot'},{houseId:'arfoni'}]}; };`);
  const feed = (action, caller = ORAN) => arr(g.post({ action, secret: SECRET, ...caller }));
  assert.deepStrictEqual(feed('managersOverview'), { ok:true, houses:[{key:'ramot',patientsNow:4}], totals:{activePatients:4} });
  assert.deepStrictEqual(feed('managersHouse'), { ok:true, house:'ramot' });
  assert.deepStrictEqual(feed('occupancySnapshots', { ...ORAN, house:'efroni' }).rows, [{houseId:'arfoni'}]);
  assert.strictEqual(feed('managersOverview', {...SANDRA,house:''}).houses.length, 2);
  assert.strictEqual(feed('managersOverview', {...ORAN,house:''}).error, 'bad_request');
  assert.strictEqual(feed('managersOverview', {...ORAN,actorId:''}).error, 'bad_request');
});

test('cross-house intake credit preserves bonus counts but removes foreign patient details for managers', () => {
  const { g } = boot();
  g.run(`managersHouse_ = function () { return { ok:true, intakeMeetings:{confirmed:2,pending:0,items:[
    {house:'ramot',name:'Own'},{house:'efroni',name:'Foreign'}]} }; };
    managersOverview_ = function () { return { ok:true, houses:[Object.assign({key:'ramot'},managersHouse_())] }; };`);
  for (const action of ['managersHouse', 'managersOverview']) {
    const data = arr(g.post({ action, secret: SECRET, ...ORAN }));
    const house = data.houses ? data.houses[0] : data;
    assert.strictEqual(house.intakeMeetings.confirmed, 2);
    assert.deepStrictEqual(house.intakeMeetings.items, [{house:'ramot',name:'Own'}]);
    assert.ok(!JSON.stringify(data).includes('Foreign'));
    assert.ok(JSON.stringify(g.post({ action, secret: SECRET, ...SANDRA })).includes('Foreign'));
  }
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
    { name: 'אבי', kind: 'guide', role: 'מדריך/ה', phone: '0501234567', onLeave: false, workdays: [], startDate: '' },
    { name: 'ד"ר כהן', kind: 'therapist', role: 'פסיכיאטר/ית', phone: '', onLeave: true, workdays: [0, 2], startDate: '' },
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

/* ---- Stage 3: the house manpower cost (staffing feed) ---- */
const STAFFING_URL = 'https://script.google.com/macros/s/AKfycbTESTstaffing123/exec';
function withCost(feed, props = {}) {
  const t = boot();
  Object.assign(t.g.sandbox.__props, { STAFFING_SHEETS_URL: STAFFING_URL, STAFFING_COST_SECRET: 'cost-secret-123' }, props);
  t.fetches = [];
  t.g.sandbox.UrlFetchApp = { fetch: (url) => {
    t.fetches.push(url);
    if (feed instanceof Error) throw feed;
    return { getResponseCode: () => 200, getContentText: () => (typeof feed === 'string' ? feed : JSON.stringify(feed)) };
  } };
  return t;
}
const FEED = { month: '2026-10', hasActuals: true, feedGeneratedAt: '2026-10-14T10:00:00.000Z', houses: {
  ramot: { projectedTotal: 182345.6, actualConfirmed: 150000, estimated: 32345.6, missingDataCost: 0, instructorsCost: 98000, budget: 186400 },
  asher: { projectedTotal: 140000, actualConfirmed: 0, estimated: 140000, missingDataCost: 0, instructorsCost: 80000, budget: null },
  pardes: { projectedTotal: 50000, actualConfirmed: 0, estimated: 50000, missingDataCost: 0, instructorsCost: 30000, budget: 60000 },
  hapardes: { projectedTotal: 1000, actualConfirmed: 0, estimated: 1000, missingDataCost: 0, instructorsCost: 0, budget: null },
} };

test('houseCost: only the caller\'s house leaves — rounded totals, budget, no other house', () => {
  const t = withCost(FEED);
  const r = t.call({ op: 'houseCost', month: '2026-10', ...ORAN });
  assert.deepStrictEqual(r, { ok: true, house: 'ramot', month: '2026-10', cost: {
    available: true, month: '2026-10', hasActuals: true, stale: false, generatedAt: '2026-10-14T10:00:00.000Z',
    total: 182346, confirmed: 150000, estimated: 32346, missingData: 0, instructors: 98000, budget: 186400 } });
  assert.ok(!JSON.stringify(r).includes('140000'), 'no other house');
  assert.match(t.fetches[0], /^https:\/\/script\.google\.com\/macros\/s\/AKfycbTESTstaffing123\/exec\?action=getHouseCostsForManagers&month=2026-10&secret=cost-secret-123$/);
});

test('houseCost: staffing ids map to manager houses (asher → raanana, pardes + hapardes → pardes); cached per month', () => {
  const t = withCost(FEED);
  const raanana = t.call({ op: 'houseCost', month: '2026-10', house: 'raanana', role: 'manager', actor: 'שחר', actorId: 'person-shahar' });
  assert.strictEqual(raanana.cost.total, 140000);
  assert.strictEqual(raanana.cost.budget, null);
  const pardes = t.call({ op: 'houseCost', month: '2026-10', house: 'pardes', role: 'manager', actor: 'חן', actorId: 'person-chen' });
  assert.strictEqual(pardes.cost.total, 51000);
  assert.strictEqual(pardes.cost.budget, 60000);
  assert.strictEqual(t.fetches.length, 1, 'one staffing call for the whole month');
});

test('houseCost: not configured / unreachable / unauthorized / junk / house missing → available:false, never a 0', () => {
  const nc = withCost(FEED, { STAFFING_COST_SECRET: '' });
  assert.deepStrictEqual(nc.call({ op: 'houseCost', month: '2026-10', ...ORAN }).cost, { available: false, reason: 'not_configured' });
  assert.strictEqual(nc.fetches.length, 0);
  const badUrl = withCost(FEED, { STAFFING_SHEETS_URL: 'https://evil.example/exec' });
  assert.deepStrictEqual(badUrl.call({ op: 'houseCost', month: '2026-10', ...ORAN }).cost, { available: false, reason: 'not_configured' });
  assert.strictEqual(badUrl.fetches.length, 0, 'never calls a non-Apps-Script URL');
  assert.deepStrictEqual(withCost(new Error('down')).call({ op: 'houseCost', month: '2026-10', ...ORAN }).cost, { available: false, reason: 'unreachable' });
  assert.deepStrictEqual(withCost({ error: 'unauthorized' }).call({ op: 'houseCost', month: '2026-10', ...ORAN }).cost, { available: false, reason: 'unauthorized' });
  assert.deepStrictEqual(withCost('<html>').call({ op: 'houseCost', month: '2026-10', ...ORAN }).cost, { available: false, reason: 'unreadable' });
  assert.deepStrictEqual(withCost({ month: '2026-10', houses: {} }).call({ op: 'houseCost', month: '2026-10', ...ORAN }).cost, { available: false, reason: 'no_house' });
});

test('houseCost: still behind the managersWork secret', () => {
  const t = withCost(FEED);
  assert.deepStrictEqual(arr(t.g.post({ action: 'managersWork', secret: 'wrong', op: 'houseCost', ...ORAN })), { ok: false, error: 'unauthorized' });
  assert.strictEqual(t.fetches.length, 0);
});

/* ---- Half-yearly feedback «משוב» (CHANGELOG-feedback-reminders.md) ---- */
function withStartDates(rows, withCol = true) {
  const saved = DIGEST_COLS.ManagersStaff;
  DIGEST_COLS.ManagersStaff = withCol ? saved.concat('startDate') : saved;
  try { return withDigest(rows); } finally { DIGEST_COLS.ManagersStaff = saved; }
}
const SROWS = JSON.parse(JSON.stringify(ROWS));
SROWS.ManagersStaff[0].startDate = '2025-03-01';
SROWS.ManagersStaff[1].startDate = '2025-02-30';

test('feedback: the digest startDate is OPTIONAL — read when present (real dates only), "" for an older digest', () => {
  const staff = withStartDates(SROWS).call({ op: 'houseData', ...ORAN }).team.staff;
  assert.deepStrictEqual(staff.map((s) => [s.name, s.startDate]), [['אבי', '2025-03-01'], ['ד"ר כהן', '']]);
  const old = withStartDates(SROWS, false).call({ op: 'houseData', ...ORAN }).team;
  assert.strictEqual(old.available, true, 'an older digest without the column still reads');
  assert.deepStrictEqual(old.staff.map((s) => s.startDate), ['', '']);
});

test('feedback: feedbackDone appends ONE row (house / author from the caller); houseData.feedback shows the house\'s rows only', () => {
  const t = withStartDates(SROWS);
  assert.deepStrictEqual(Array.from(t.g.run('MW_FEEDBACK_COLUMNS')), ['id', 'house', 'employee', 'doneAt', 'doneBy', 'doneById', 'createdAt']);
  const r = t.call({ op: 'feedbackDone', ...ORAN, employee: ' אבי ', doneAt: '2026-10-10', doneBy: 'forged', house: 'ramot' });
  assert.deepStrictEqual(r, { ok: true, feedback: { employee: 'אבי', doneAt: '2026-10-10' } });
  const sh = t.g.sandbox.__sheets.ManagersFeedbackLog;
  assert.strictEqual(sh.grid.length, 2, 'header + one row');
  const row = sh.grid[1];
  assert.deepStrictEqual([row[1], row[2], row[3], row[4], row[5]], ['ramot', 'אבי', '2026-10-10', 'אורן', 'person-oran']);
  t.call({ op: 'feedbackDone', ...ORAN, employee: 'אבי', doneAt: '2026-10-12' });
  assert.strictEqual(sh.grid.length, 3, 'a second «בוצע» is a NEW row (append-only)');
  assert.deepStrictEqual(t.call({ op: 'houseData', ...ORAN }).feedback, { supported: true, rows: [{ employee: 'אבי', doneAt: '2026-10-10' }, { employee: 'אבי', doneAt: '2026-10-12' }] });
  const HANAN = { house: 'efroni', role: 'manager', actor: 'חנן', actorId: 'person-hanan' };
  assert.deepStrictEqual(t.call({ op: 'houseData', ...HANAN }).feedback.rows, [], 'another house sees nothing');
});

test('feedback: refused — not on the house staff, another house\'s employee, a future / invalid date, roster unavailable', () => {
  const t = withStartDates(SROWS);
  assert.strictEqual(t.call({ op: 'feedbackDone', ...ORAN, employee: 'מישהו', doneAt: '2026-10-10' }).error, 'not_found');
  assert.strictEqual(t.call({ op: 'feedbackDone', ...ORAN, employee: 'של עפרוני', doneAt: '2026-10-10' }).error, 'not_found', 'efroni\'s guide is not ramot staff');
  t.g.run(`committeeToday_ = function () { return '2026-10-13'; }`);
  assert.strictEqual(t.call({ op: 'feedbackDone', ...ORAN, employee: 'אבי', doneAt: '2026-10-14' }).error, 'bad_date', 'future');
  assert.strictEqual(t.call({ op: 'feedbackDone', ...ORAN, employee: 'אבי', doneAt: '2026-02-30' }).error, 'bad_date');
  assert.strictEqual(t.call({ op: 'feedbackDone', ...ORAN, employee: 'אבי', doneAt: '1999-12-31' }).error, 'bad_date');
  assert.strictEqual(t.call({ op: 'feedbackDone', ...ORAN, employee: '', doneAt: '2026-10-10' }).error, 'bad_request');
  assert.ok(!t.g.sandbox.__sheets.ManagersFeedbackLog, 'nothing written');
  const none = withDigest(ROWS, { id: '' });
  assert.strictEqual(none.call({ op: 'feedbackDone', ...ORAN, employee: 'אבי', doneAt: '2026-10-10' }).error, 'roster_unavailable', 'fail-closed without the roster');
});
