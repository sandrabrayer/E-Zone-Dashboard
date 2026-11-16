'use strict';

/* Managers CRM backend (CHANGELOG-managers-crm-backend.md, 14 Nov 2026):
 *   - staff-talk THREADS: a follow-up talk / an outcome on a first talk
 *     (columns appended after the stamps — headers append-only);
 *   - «מה היה בוועדה»: the committeeNotes log;
 *   - houseStaffCost: per-worker month cost of the CALLER's house from the
 *     staffing feed getHouseWorkerCostsForManagers.
 * Real apps-script/Code.gs in the shared vm sandbox. */

const { test } = require('node:test');
const assert = require('node:assert');
const { richSheet, loadGs } = require('./helpers/gs-sandbox');

const SECRET = 'mw-secret-123';
const arr = (x) => JSON.parse(JSON.stringify(x));

function boot({ today = '2026-11-14', props = {} } = {}) {
  const g = loadGs({ props: Object.assign({ MANAGERS_WORK_SECRET: SECRET }, props) });
  g.sandbox.Session = { getScriptTimeZone: () => 'Asia/Jerusalem' };
  g.sandbox.Utilities.formatDate = (d, tz, fmt) => {
    const x = new Date(d); const p = (n) => (n < 10 ? '0' + n : '' + n);
    if (fmt === 'HH:mm') return `${p(x.getHours())}:${p(x.getMinutes())}`;
    if (fmt === 'yyyy-MM') return `${x.getFullYear()}-${p(x.getMonth() + 1)}`;
    return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
  };
  g.run(`todayISODate_ = function () { return '${today}'; }`);
  const cols = Array.from(g.run('PATIENT_COLUMNS'));
  const sh = richSheet('Patients', cols);
  [{ houseId: 'ramot', name: 'דנה', date: '2026-09-01', status: 'active', id: 'p1' }]
    .forEach((r) => sh.grid.push(cols.map((c) => r[c] ?? '')));
  g.sandbox.__sheets.Patients = sh;
  const call = (body) => arr(g.post({ action: 'managersWork', secret: SECRET, ...body }));
  return { g, call };
}
const ORAN = { house: 'ramot', role: 'manager', actor: 'אורן', actorId: 'person-oran' };
const SHAHAR = { house: 'ramot', role: 'manager', actor: 'שחר', actorId: 'person-shahar' };
const SANDRA = { house: 'ramot', role: 'admin', actor: 'סנדרה', actorId: 'person-sandra' };
const add = (call, who, log, entry) => call({ op: 'logAdd', log, entry: JSON.stringify(entry), ...who });

/* ---- staff-talk threads ---- */

test('talks: the thread columns are APPENDED after the stamp columns (append-only header)', () => {
  const { g } = boot();
  const cols = Array.from(g.run("mwColumns_('staffTalks')"));
  assert.deepStrictEqual(cols, ['id', 'house', 'employeeName', 'talkDate', 'talkTime', 'summary',
    'followUpDate', 'followUpDone', 'author', 'createdAt', 'deletedAt', 'deletedBy', 'authorId',
    'talkKind', 'parentId', 'outcome', 'agreedActions']);
  assert.deepStrictEqual(Array.from(g.run("mwColumns_('events')")).slice(-1), ['authorId'], 'events unchanged');
});

test('talks: a first talk, a follow-up and an outcome form one thread; read back with their kinds', () => {
  const { call } = boot();
  const first = add(call, ORAN, 'staffTalks', { employeeName: 'רינה', talkDate: '2026-11-01', summary: 'איחורים', agreedActions: 'להגיע בזמן', followUpDate: '2026-11-10' });
  assert.strictEqual(first.ok, true);
  const second = add(call, ORAN, 'staffTalks', { employeeName: 'רינה', talkDate: '2026-11-10', summary: 'שיפור חלקי', talkKind: 'followup', parentId: first.id });
  assert.strictEqual(second.ok, true);
  const outcome = add(call, ORAN, 'staffTalks', { employeeName: 'רינה', talkDate: '2026-11-14', summary: 'הסתדר', talkKind: 'outcome', parentId: first.id, outcome: 'improved' });
  assert.strictEqual(outcome.ok, true);
  const talks = call({ op: 'houseData', ...ORAN }).logs.staffTalks;
  const byId = Object.fromEntries(talks.map((t) => [t.id, t]));
  assert.deepStrictEqual([byId[first.id].talkKind, byId[first.id].parentId, byId[first.id].agreedActions], ['first', '', 'להגיע בזמן']);
  assert.deepStrictEqual([byId[second.id].talkKind, byId[second.id].parentId, byId[second.id].outcome], ['followup', first.id, '']);
  assert.deepStrictEqual([byId[outcome.id].talkKind, byId[outcome.id].outcome], ['outcome', 'improved']);
});

test('talks: an outcome needs an allowed outcome; a follow-up needs an existing FIRST talk of the same employee', () => {
  const { call } = boot();
  const first = add(call, ORAN, 'staffTalks', { employeeName: 'רינה', talkDate: '2026-11-01', summary: 'x' });
  assert.deepStrictEqual(add(call, ORAN, 'staffTalks', { employeeName: 'רינה', talkDate: '2026-11-02', summary: 'y', talkKind: 'outcome', parentId: first.id, outcome: 'fired!!' }).fields, ['outcome']);
  assert.deepStrictEqual(add(call, ORAN, 'staffTalks', { employeeName: 'רינה', talkDate: '2026-11-02', summary: 'y', talkKind: 'followup' }).fields, ['parentId']);
  assert.strictEqual(add(call, ORAN, 'staffTalks', { employeeName: 'רינה', talkDate: '2026-11-02', summary: 'y', talkKind: 'followup', parentId: 'nope' }).error, 'not_found');
  assert.strictEqual(add(call, ORAN, 'staffTalks', { employeeName: 'אחר', talkDate: '2026-11-02', summary: 'y', talkKind: 'followup', parentId: first.id }).error, 'bad_request', 'another employee');
  const f2 = add(call, ORAN, 'staffTalks', { employeeName: 'רינה', talkDate: '2026-11-02', summary: 'y', talkKind: 'followup', parentId: first.id });
  assert.strictEqual(add(call, ORAN, 'staffTalks', { employeeName: 'רינה', talkDate: '2026-11-03', summary: 'z', talkKind: 'followup', parentId: f2.id }).error, 'not_found', 'the parent must be a FIRST talk');
  const junk = add(call, ORAN, 'staffTalks', { employeeName: 'רינה', talkDate: '2026-11-03', summary: 'z', talkKind: 'weird' });
  const row = call({ op: 'houseData', ...ORAN }).logs.staffTalks.find((t) => t.id === junk.id);
  assert.strictEqual(row.talkKind, 'first', 'an unknown kind is a first talk');
});

test('talks: a thread stays PRIVATE — another manager can neither see nor extend it; an admin can; never across houses', () => {
  const { call } = boot();
  const first = add(call, ORAN, 'staffTalks', { employeeName: 'רינה', talkDate: '2026-11-01', summary: 'פרטי' });
  assert.strictEqual(add(call, SHAHAR, 'staffTalks', { employeeName: 'רינה', talkDate: '2026-11-02', summary: 'y', talkKind: 'followup', parentId: first.id }).error, 'not_found', 'invisible to another manager');
  assert.strictEqual(add(call, SANDRA, 'staffTalks', { employeeName: 'רינה', talkDate: '2026-11-02', summary: 'y', talkKind: 'outcome', parentId: first.id, outcome: 'hr' }).ok, true, 'an admin may');
  const elsewhere = { house: 'efroni', role: 'admin', actor: 'סנדרה', actorId: 'person-sandra' };
  assert.strictEqual(add(call, elsewhere, 'staffTalks', { employeeName: 'רינה', talkDate: '2026-11-02', summary: 'y', talkKind: 'followup', parentId: first.id }).error, 'not_found', 'never across houses');
});

test('talks: a legacy row (no talkKind) reads as a first talk and can be extended', () => {
  const { call, g } = boot();
  const first = add(call, ORAN, 'staffTalks', { employeeName: 'רינה', talkDate: '2026-11-01', summary: 'x' });
  // Simulate a row written before the columns existed: blank the appended cells.
  const sh = g.sandbox.__sheets.ManagersStaffTalks;
  const cols = Array.from(g.run("mwColumns_('staffTalks')"));
  const r = sh.grid.find((row) => row[0] === first.id);
  r[cols.indexOf('talkKind')] = '';
  assert.strictEqual(call({ op: 'houseData', ...ORAN }).logs.staffTalks[0].talkKind, '');
  assert.strictEqual(add(call, ORAN, 'staffTalks', { employeeName: 'רינה', talkDate: '2026-11-05', summary: 'y', talkKind: 'followup', parentId: first.id }).ok, true);
});

/* ---- «מה היה בוועדה» ---- */

test('committee notes: recorded and read back for the house; decision allowlisted; text cleaned; follow-up via nextDate stays separate', () => {
  const { call } = boot();
  const bad = add(call, ORAN, 'committeeNotes', { patientName: 'דנה' });
  assert.deepStrictEqual(bad.fields, ['heldDate', 'summary']);
  const ok = add(call, ORAN, 'committeeNotes', { committeeId: 'c-17', patientName: 'דנה', heldDate: '2026-11-12', participants: 'פסיכיאטר, רכזת',
    summary: '=המשך <b>טיפול</b>', decision: 'extend', nextDate: '2026-12-12', followUpDate: '2026-11-14' });
  assert.strictEqual(ok.ok, true);
  const d = call({ op: 'houseData', ...SHAHAR });
  const row = d.logs.committeeNotes[0];
  assert.deepStrictEqual([row.committeeId, row.patientName, row.heldDate, row.decision, row.nextDate, row.author], ['c-17', 'דנה', '2026-11-12', 'extend', '2026-12-12', 'אורן']);
  assert.strictEqual(row.summary, 'המשך bטיפול/b', 'formula lead-in and angle brackets stripped');
  assert.strictEqual(row.canEdit, false, 'another manager of the house sees it but cannot edit');
  assert.ok(d.followUps.some((f) => f.log === 'committeeNotes' && f.id === ok.id));
  const off = add(call, ORAN, 'committeeNotes', { committeeId: 'bad id!', patientName: 'דנה', heldDate: '2026-11-12', summary: 'x', decision: 'teleport' });
  const r2 = call({ op: 'houseData', ...ORAN }).logs.committeeNotes.find((n) => n.id === off.id);
  assert.deepStrictEqual([r2.committeeId, r2.decision], ['', '']);
  const efroni = call({ op: 'houseData', house: 'efroni', role: 'admin', actor: 'סנדרה', actorId: 'person-sandra' });
  assert.strictEqual(efroni.logs.committeeNotes.length, 0, 'never another house');
});

/* ---- houseStaffCost ---- */

const STAFFING_URL = 'https://script.google.com/macros/s/AKfycbTESTstaffing123/exec';
function withStaff(feed, props = {}) {
  const t = boot({ props: Object.assign({ STAFFING_SHEETS_URL: STAFFING_URL, STAFFING_COST_SECRET: 'cost-secret-123' }, props) });
  t.fetches = [];
  t.g.sandbox.UrlFetchApp = { fetch: (url) => {
    t.fetches.push(url);
    if (feed instanceof Error) throw feed;
    return { getResponseCode: () => 200, getContentText: () => (typeof feed === 'string' ? feed : JSON.stringify(feed)) };
  } };
  return t;
}
const SFEED = { month: '2026-11', hasActuals: false, feedGeneratedAt: '2026-11-14T10:00:00.000Z', houses: {
  ramot: { projectedTotal: 17000.4, budget: 265000, workers: [
    { name: 'מדריכה ותיקה', roles: ['מדריך/ה'], cost: 10000.4, estimated: true },
    { name: '<b>שני</b>', roles: ['מדריך/ה', '=x'], cost: 7000, estimated: false, workerId: 'w9', salary: 1 }],
    budgetLines: [{ key: 'instructors', label: 'מדריכים', budget: 120000, cost: 17000 }] },
  asher: { projectedTotal: 5000, budget: null, workers: [{ name: 'סוד של אשר', roles: [], cost: 5000, estimated: true }], budgetLines: [] },
  pardes: { projectedTotal: 3000, budget: 150000, workers: [{ name: 'טבחית', roles: ['טבח/ית'], cost: 1500, estimated: true }], budgetLines: [{ key: 'cook', label: 'טבחים', budget: 10000, cost: 1500 }] },
  hapardes: { projectedTotal: 1500, budget: null, workers: [{ name: 'טבחית', roles: ['טבח/ית'], cost: 1500, estimated: false }], budgetLines: [{ key: 'cook', label: 'טבחים', budget: null, cost: 1500 }] },
} };

test('houseStaffCost: only the caller\'s house leaves — workers cleaned, rounded, sorted; no extra keys', () => {
  const t = withStaff(SFEED);
  const r = t.call({ op: 'houseStaffCost', month: '2026-11', ...ORAN });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.house, 'ramot');
  assert.deepStrictEqual(r.staff.workers, [
    { name: 'מדריכה ותיקה', roles: ['מדריך/ה'], cost: 10000, estimated: true, endDate: '' },
    { name: 'bשני/b', roles: ['מדריך/ה', 'x'], cost: 7000, estimated: false, endDate: '' }]);
  assert.strictEqual(r.staff.ending, null, 'a staffing feed without `ending` is null, never a made-up 0');
  assert.deepStrictEqual([r.staff.total, r.staff.budget, r.staff.available], [17000, 265000, true]);
  assert.deepStrictEqual(r.staff.budgetLines, [{ key: 'instructors', label: 'מדריכים', budget: 120000, cost: 17000 }]);
  const text = JSON.stringify(r);
  for (const leak of ['סוד של אשר', 'w9', 'salary']) assert.ok(!text.includes(leak), 'leaked ' + leak);
  assert.match(t.fetches[0], /\?action=getHouseWorkerCostsForManagers&month=2026-11&secret=cost-secret-123$/);
});

test('houseStaffCost: pardes + hapardes merge per person and per budget line; cached per month', () => {
  const t = withStaff(SFEED);
  const r = t.call({ op: 'houseStaffCost', month: '2026-11', house: 'pardes', role: 'manager', actor: 'חן', actorId: 'person-chen' });
  assert.deepStrictEqual(r.staff.workers, [{ name: 'טבחית', roles: ['טבח/ית'], cost: 3000, estimated: true, endDate: '' }]);
  assert.deepStrictEqual(r.staff.budgetLines, [{ key: 'cook', label: 'טבחים', budget: 10000, cost: 3000 }]);
  assert.strictEqual(r.staff.total, 4500);
  t.call({ op: 'houseStaffCost', month: '2026-11', ...ORAN });
  assert.strictEqual(t.fetches.length, 1, 'one staffing call per month');
});

test('houseStaffCost: ends of employment (16 Nov 2026) — the end date per worker and the house saving; cleaned, summed, own house only', () => {
  const feed = JSON.parse(JSON.stringify(SFEED));
  feed.houses.ramot.workers[0].endDate = '2026-11-20';
  feed.houses.ramot.workers[1].endDate = '2026-02-30';          // not a date → ''
  feed.houses.ramot.ending = { count: 1, monthlySaving: 10000.4, savingThisMonth: 3333.3, savingNextMonth: 10000.4, items: [{ salary: 1 }] };
  feed.houses.asher.ending = { count: 3, monthlySaving: 99999, savingThisMonth: 1, savingNextMonth: 2 };
  // one person in both pardes ids: ends in one, stays in the other → no end date
  feed.houses.pardes.workers[0].endDate = '2026-11-30';
  feed.houses.pardes.ending = { count: 1, monthlySaving: 1500, savingThisMonth: 0, savingNextMonth: 1500 };
  feed.houses.hapardes.ending = { count: '=2', monthlySaving: -5, savingThisMonth: 'x', savingNextMonth: 250.6 };
  const t = withStaff(feed);
  const ramot = t.call({ op: 'houseStaffCost', month: '2026-11', ...ORAN }).staff;
  assert.deepStrictEqual(ramot.ending, { count: 1, monthlySaving: 10000, savingThisMonth: 3333, savingNextMonth: 10000 });
  assert.deepStrictEqual(ramot.workers.map((w) => [w.name, w.endDate]), [['מדריכה ותיקה', '2026-11-20'], ['bשני/b', '']]);
  assert.ok(!JSON.stringify(ramot).includes('99999') && !JSON.stringify(ramot).includes('salary'), 'no other house, no extra key');
  const pardes = t.call({ op: 'houseStaffCost', month: '2026-11', house: 'pardes', role: 'manager', actor: 'חן', actorId: 'person-chen' }).staff;
  assert.deepStrictEqual(pardes.ending, { count: 1, monthlySaving: 1500, savingThisMonth: 0, savingNextMonth: 1751 }, 'summed; junk and negatives count as 0');
  assert.strictEqual(pardes.workers[0].endDate, '', 'still placed under the other id');
  // both ids end → the later date
  feed.houses.hapardes.workers[0].endDate = '2026-12-15';
  const both = withStaff(feed).call({ op: 'houseStaffCost', month: '2026-11', house: 'pardes', role: 'manager', actor: 'חן', actorId: 'person-chen' }).staff;
  assert.strictEqual(both.workers[0].endDate, '2026-12-15');
});

test('houseStaffCost: every finishing person is named with the end date — the count is the list (16 Nov 2026)', () => {
  const feed = JSON.parse(JSON.stringify(SFEED));
  feed.houses.ramot.ending = { count: 9, monthlySaving: 12000, savingThisMonth: 7500, savingNextMonth: 12000, people: [
    { name: 'פרילנסרית', endDate: '2026-11-15', monthlySaving: 3000.4, workerId: 'w1', salary: 5 },
    { name: '<b>מדריכה</b>', endDate: '2026-11-10', monthlySaving: 9000 },
    { name: 'בלי תאריך', endDate: '2026-02-30', monthlySaving: 1 },
    { name: '', endDate: '2026-11-10', monthlySaving: 1 }, null, 'x'] };
  feed.houses.asher.ending = { count: 1, monthlySaving: 1, savingThisMonth: 1, savingNextMonth: 1, people: [{ name: 'סוד של אשר', endDate: '2026-11-01', monthlySaving: 1 }] };
  feed.houses.pardes.ending = { count: 1, monthlySaving: 1500, savingThisMonth: 0, savingNextMonth: 1500, people: [{ name: 'טבחית', endDate: '2026-11-30', monthlySaving: 1500 }] };
  feed.houses.hapardes.ending = { count: 1, monthlySaving: 1500, savingThisMonth: 0, savingNextMonth: 1500, people: [{ name: 'טבחית', endDate: '2026-12-15', monthlySaving: 1500 }] };
  const t = withStaff(feed);
  const ramot = t.call({ op: 'houseStaffCost', month: '2026-11', ...ORAN }).staff.ending;
  assert.deepStrictEqual(ramot.people, [
    { name: 'bמדריכה/b', endDate: '2026-11-10', monthlySaving: 9000 },
    { name: 'פרילנסרית', endDate: '2026-11-15', monthlySaving: 3000 }], 'cleaned, soonest first; no name or no real date → not listed; no extra key');
  assert.strictEqual(ramot.count, 2, 'the count is the list, whatever number came');
  assert.ok(!JSON.stringify(ramot).includes('סוד של אשר'), 'never another house');
  const pardes = t.call({ op: 'houseStaffCost', month: '2026-11', house: 'pardes', role: 'manager', actor: 'חן', actorId: 'person-chen' }).staff.ending;
  assert.deepStrictEqual(pardes.people, [{ name: 'טבחית', endDate: '2026-12-15', monthlySaving: 3000 }], 'one person under both ids: once, the later date, the sum');
  assert.strictEqual(pardes.count, 1);
  // a staffing feed that sends no list keeps its own count and gets no list
  const old = JSON.parse(JSON.stringify(SFEED));
  old.houses.ramot.ending = { count: 2, monthlySaving: 1, savingThisMonth: 1, savingNextMonth: 1 };
  const o = withStaff(old).call({ op: 'houseStaffCost', month: '2026-11', ...ORAN }).staff.ending;
  assert.deepStrictEqual(o, { count: 2, monthlySaving: 1, savingThisMonth: 1, savingNextMonth: 1 });
});

test('houseStaffCost: not configured / bad URL / down / unauthorized / older staffing / junk / no house → available:false', () => {
  const nc = withStaff(SFEED, { STAFFING_COST_SECRET: '' });
  assert.deepStrictEqual(nc.call({ op: 'houseStaffCost', month: '2026-11', ...ORAN }).staff, { available: false, reason: 'not_configured' });
  assert.strictEqual(nc.fetches.length, 0);
  const evil = withStaff(SFEED, { STAFFING_SHEETS_URL: 'https://evil.example/exec' });
  assert.strictEqual(evil.call({ op: 'houseStaffCost', month: '2026-11', ...ORAN }).staff.reason, 'not_configured');
  assert.strictEqual(evil.fetches.length, 0);
  assert.strictEqual(withStaff(new Error('x')).call({ op: 'houseStaffCost', month: '2026-11', ...ORAN }).staff.reason, 'unreachable');
  assert.strictEqual(withStaff({ error: 'unauthorized' }).call({ op: 'houseStaffCost', month: '2026-11', ...ORAN }).staff.reason, 'unauthorized');
  assert.strictEqual(withStaff({ error: 'unknown action: getHouseWorkerCostsForManagers' }).call({ op: 'houseStaffCost', month: '2026-11', ...ORAN }).staff.reason, 'not_deployed');
  assert.strictEqual(withStaff('<html>').call({ op: 'houseStaffCost', month: '2026-11', ...ORAN }).staff.reason, 'unreadable');
  assert.strictEqual(withStaff({ month: '2026-11', houses: {} }).call({ op: 'houseStaffCost', month: '2026-11', ...ORAN }).staff.reason, 'no_house');
});

test('houseStaffCost: behind the managersWork secret; a bad caller is refused before any fetch', () => {
  const t = withStaff(SFEED);
  assert.deepStrictEqual(arr(t.g.post({ action: 'managersWork', secret: 'wrong', op: 'houseStaffCost', ...ORAN })), { ok: false, error: 'unauthorized' });
  assert.strictEqual(t.call({ op: 'houseStaffCost', ...ORAN, house: 'arfoni' }).error, 'bad_request');
  assert.strictEqual(t.fetches.length, 0);
});
