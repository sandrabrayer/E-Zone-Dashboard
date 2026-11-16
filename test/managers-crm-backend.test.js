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
    { name: 'מדריכה ותיקה', roles: ['מדריך/ה'], cost: 10000, estimated: true },
    { name: 'bשני/b', roles: ['מדריך/ה', 'x'], cost: 7000, estimated: false }]);
  assert.deepStrictEqual([r.staff.total, r.staff.budget, r.staff.available], [17000, 265000, true]);
  assert.deepStrictEqual(r.staff.budgetLines, [{ key: 'instructors', label: 'מדריכים', budget: 120000, cost: 17000 }]);
  const text = JSON.stringify(r);
  for (const leak of ['סוד של אשר', 'w9', 'salary']) assert.ok(!text.includes(leak), 'leaked ' + leak);
  assert.match(t.fetches[0], /\?action=getHouseWorkerCostsForManagers&month=2026-11&secret=cost-secret-123$/);
});

test('houseStaffCost: pardes + hapardes merge per person and per budget line; cached per month', () => {
  const t = withStaff(SFEED);
  const r = t.call({ op: 'houseStaffCost', month: '2026-11', house: 'pardes', role: 'manager', actor: 'חן', actorId: 'person-chen' });
  assert.deepStrictEqual(r.staff.workers, [{ name: 'טבחית', roles: ['טבח/ית'], cost: 3000, estimated: true }]);
  assert.deepStrictEqual(r.staff.budgetLines, [{ key: 'cook', label: 'טבחים', budget: 10000, cost: 3000 }]);
  assert.strictEqual(r.staff.total, 4500);
  t.call({ op: 'houseStaffCost', month: '2026-11', ...ORAN });
  assert.strictEqual(t.fetches.length, 1, 'one staffing call per month');
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

/* ---- 16 Nov 2026: the patient's contact person in houseData; a worker's end date ---- */

function withLeads(leads, patients) {
  const t = boot();
  const g = t.g;
  const pcols = Array.from(g.run('PATIENT_COLUMNS'));
  const psh = richSheet('Patients', pcols);
  patients.forEach((r) => psh.grid.push(pcols.map((c) => r[c] ?? '')));
  g.sandbox.__sheets.Patients = psh;
  const lcols = Array.from(g.run('LEAD_COLUMNS'));
  const lsh = richSheet(g.run('LEADS_SHEET'), lcols);
  leads.forEach((r) => lsh.grid.push(lcols.map((c) => r[c] ?? '')));
  g.sandbox.__sheets[g.run('LEADS_SHEET')] = lsh;
  return t;
}

test('houseData: each patient carries the contact person of the lead it came from — four cleaned values, by the lead id only', () => {
  const t = withLeads([
    { id: 'L1', name: 'דנה', phone: '0509999999', house: 'ramot', contactName: '=רות <b>כהן</b>', contactRelation: 'אמא', contactPhone: '050-123-4567', billingPhone: '521234567', notes: 'SECRET-NOTE', advance: 5000 },
    { id: 'L2', name: 'יוסי', phone: '0508888888', house: 'ramot', contactName: 'אבא של יוסי', contactRelation: 'אבא', contactPhone: '0501111111' },
    { id: 'L3', name: 'נועה', phone: '0507777777', house: 'ramot', contactName: '', contactRelation: '', contactPhone: 'not a phone', billingPhone: '' },
  ], [
    { houseId: 'ramot', name: 'דנה', date: '2026-09-01', status: 'active', id: 'p1', fromLead: 'L1' },
    { houseId: 'ramot', name: 'יוסי', date: '2026-10-01', status: 'active', id: 'p2', fromLead: '' },       // same name as a lead, NOT linked
    { houseId: 'ramot', name: 'נועה', date: '2026-10-05', status: 'active', id: 'p3', fromLead: 'L3' },   // linked, nothing usable
    { houseId: 'ramot', name: 'גל', date: '2026-10-07', status: 'active', id: 'p4', fromLead: 'GONE' },   // the lead no longer exists
    { houseId: 'arfoni', name: 'אחר', date: '2026-10-07', status: 'active', id: 'p5', fromLead: 'L2' },
  ]);
  const d = t.call({ op: 'houseData', ...ORAN });
  assert.strictEqual(d.contactsSupported, true);
  const by = Object.fromEntries(d.patients.map((p) => [p.name, p]));
  assert.deepStrictEqual(by['דנה'].contact, { name: 'רות bכהן/b', relation: 'אמא', phone: '0501234567', updatesPhone: '0521234567' }, 'cleaned; phones normalised');
  assert.strictEqual(by['יוסי'].contact, null, 'never by a name match — only the lead the patient came from');
  assert.strictEqual(by['נועה'].contact, null, 'a lead with nothing usable is no contact');
  assert.strictEqual(by['גל'].contact, null);
  assert.deepStrictEqual(Object.keys(by['דנה']).sort(), ['contact', 'days', 'entryDate', 'expectedDischarge', 'name', 'status'], 'no lead id on the patient');
  const text = JSON.stringify(d.patients);
  for (const leak of ['SECRET-NOTE', '0509999999', 'L1', 'fromLead', '5000', 'אבא של יוסי']) assert.ok(!text.includes(leak), 'leaked ' + leak);
  // Another house's manager never sees this house's patients or contacts.
  const other = t.call({ op: 'houseData', house: 'efroni', role: 'manager', actor: 'חנן', actorId: 'person-hanan' });
  assert.deepStrictEqual(other.patients.map((p) => [p.name, p.contact && p.contact.name]), [['אחר', 'אבא של יוסי']]);
  assert.ok(!JSON.stringify(other).includes('רות'));
  // Behind the same secret as everything else.
  assert.strictEqual(arr(t.g.post({ action: 'managersWork', secret: 'wrong', op: 'houseData', ...ORAN })).error, 'unauthorized');
});

test('houseData: the family-calls log is written and read back for the house («שיחות עם משפחה»)', () => {
  const t = withLeads([], [{ houseId: 'ramot', name: 'דנה', date: '2026-09-01', status: 'active', id: 'p1' }]);
  assert.deepStrictEqual(add(t.call, ORAN, 'familyCalls', { patientName: 'דנה' }).fields, ['contactName', 'callDate', 'summary']);
  const ok = add(t.call, ORAN, 'familyCalls', { patientName: 'דנה', contactName: 'רות', relation: 'אמא', callDate: '2026-11-12', callTime: '18:00', summary: '=עדכון <i>שבועי</i>', followUpDate: '2026-11-13' });
  assert.strictEqual(ok.ok, true);
  const d = t.call({ op: 'houseData', ...SHAHAR });
  const row = d.logs.familyCalls[0];
  assert.deepStrictEqual([row.patientName, row.contactName, row.relation, row.callDate, row.callTime, row.summary, row.author, row.canEdit],
    ['דנה', 'רות', 'אמא', '2026-11-12', '18:00', 'עדכון iשבועי/i', 'אורן', false], 'the house sees it; only the author (or an admin) edits');
  assert.ok(d.followUps.some((f) => f.log === 'familyCalls' && f.id === ok.id));
  const efroni = t.call({ op: 'houseData', house: 'efroni', role: 'admin', actor: 'סנדרה', actorId: 'person-sandra' });
  assert.strictEqual(efroni.logs.familyCalls.length, 0, 'never another house');
});

test('houseStaffCost: a worker\'s endDate passes only when it is a real date — and, for a merged worker, only when every entry has one', () => {
  const feed = { month: '2026-11', hasActuals: false, houses: {
    ramot: { projectedTotal: 300, budget: 1000, workers: [
      { name: 'מסיימת', roles: ['מדריך/ה'], cost: 100, estimated: true, endDate: '2026-11-30' },
      { name: 'תאריך רע', roles: [], cost: 100, estimated: true, endDate: '<b>30/11</b>' },
      { name: 'נשארת', roles: [], cost: 100, estimated: true }], budgetLines: [] },
    pardes: { projectedTotal: 300, budget: null, workers: [
      { name: 'שני הבתים', roles: [], cost: 100, estimated: true, endDate: '2026-11-20' },
      { name: 'רק באחד', roles: [], cost: 100, estimated: true, endDate: '2026-11-20' },
      { name: '', roles: [], cost: 100, estimated: true, endDate: '2026-11-20' }], budgetLines: [] },
    hapardes: { projectedTotal: 200, budget: null, workers: [
      { name: 'שני הבתים', roles: [], cost: 100, estimated: true, endDate: '2026-12-10' },
      { name: 'רק באחד', roles: [], cost: 100, estimated: true }], budgetLines: [] },
  } };
  const t = withStaff(feed);
  const ramot = Object.fromEntries(t.call({ op: 'houseStaffCost', month: '2026-11', ...ORAN }).staff.workers.map((w) => [w.name, w]));
  assert.strictEqual(ramot['מסיימת'].endDate, '2026-11-30');
  assert.ok(!('endDate' in ramot['תאריך רע']), 'a value that is not a date is dropped');
  assert.ok(!('endDate' in ramot['נשארת']), 'no key when staffing has no end date');
  const pardes = Object.fromEntries(t.call({ op: 'houseStaffCost', month: '2026-11', house: 'pardes', role: 'admin', actor: 'סנדרה', actorId: 'person-sandra' }).staff.workers.map((w) => [w.name, w]));
  assert.strictEqual(pardes['שני הבתים'].endDate, '2026-12-10', 'the later date — the day the person really stops');
  assert.ok(!('endDate' in pardes['רק באחד']), 'still placed under the other id → not leaving');
  assert.ok(!('endDate' in pardes['']), 'the unnamed remainder never has an end date');
});
