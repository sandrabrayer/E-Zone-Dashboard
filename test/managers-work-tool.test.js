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
