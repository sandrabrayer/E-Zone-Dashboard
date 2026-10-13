'use strict';

/* Intake-meeting bonus feed (CHANGELOG-intake-meeting-bonus-feed.md).
 *
 * managersOverview_ / managersHouse_ carry, per Managers house and per month
 * of ADMISSION, the admissions whose intake meeting that house's manager held
 * (Leads.meetingWith), where the patient was the admitted house's 7th patient
 * or later and stayed (or has so far stayed) 30+ days. Amount and effective
 * month live in the Managers app — this feed supplies raw facts only.
 *
 * Real apps-script/Code.gs in the shared vm sandbox. Clock pinned via
 * intakeToday_. */

const { test } = require('node:test');
const assert = require('node:assert');
const { richSheet, loadGs } = require('./helpers/gs-sandbox');

const arr = (x) => JSON.parse(JSON.stringify(x));

/* Six long-stay patients already in a house before October. */
const base6 = (houseId) => Array.from({ length: 6 }, (_, i) =>
  ({ houseId, name: `${houseId}-base-${i}`, date: '2026-08-01', fromLead: '', exitDate: '' }));

function boot({ patients, leads, managers, today = '2026-11-20', withLeadsTab = true }) {
  const g = loadGs({});
  g.sandbox.Session = { getScriptTimeZone: () => 'Asia/Jerusalem' };
  g.sandbox.Utilities.formatDate = (d) => {
    const x = new Date(d);
    const m = x.getMonth() + 1, day = x.getDate();
    return `${x.getFullYear()}-${m < 10 ? '0' + m : m}-${day < 10 ? '0' + day : day}`;
  };
  const pcols = Array.from(g.run('PATIENT_COLUMNS'));
  const psh = richSheet('Patients', pcols);
  patients.forEach((p, i) => psh.grid.push(pcols.map((c) => (c === 'id' ? `p${i}` : c === 'status' ? (p.exitDate ? 'released' : 'active') : (p[c] ?? '')))));
  g.sandbox.__sheets.Patients = psh;
  if (withLeadsTab) {
    const lcols = Array.from(g.run('LEAD_COLUMNS'));
    const lsh = richSheet('Leads', lcols);
    (leads || []).forEach((l) => lsh.grid.push(lcols.map((c) => l[c] ?? '')));
    g.sandbox.__sheets.Leads = lsh;
  }
  const mcols = Array.from(g.run('MANAGER_COLUMNS'));
  const msh = richSheet('Managers', mcols);
  (managers || [
    { house: 'raanana', manager_name: 'שחר', start_date: '2026-08-24', end_date: '' },
    { house: 'ramot', manager_name: 'שחר', start_date: '2026-01-01', end_date: '2026-08-24' },
    { house: 'ramot', manager_name: 'אורן', start_date: '2026-08-25', end_date: '' },
    { house: 'efroni', manager_name: 'חנן', start_date: '2026-01-01', end_date: '' },
    { house: 'rehab', manager_name: 'רנטה', start_date: '2026-01-01', end_date: '' },
    { house: 'pardes', manager_name: 'חן', start_date: '2026-08-24', end_date: '' }
  ]).forEach((m) => msh.grid.push(mcols.map((c) => m[c] ?? '')));
  g.sandbox.__sheets.Managers = msh;
  g.run(`intakeToday_ = function () { return parseDate_('${today}'); }`);
  return g;
}
const ov = (g, ym) => arr(g.sandbox.managersOverview_(ym));
const houseOf = (o, key) => o.houses.find((h) => h.key === key);

test('7th patient + meeting held by the house manager + 30 days → confirmed, credited to the meeting manager\'s house', () => {
  const g = boot({
    patients: [...base6('ramot'), { houseId: 'ramot', name: 'דנה', date: '2026-10-05', fromLead: 'L1' }],
    leads: [{ id: 'L1', name: 'דנה', meetingWith: 'אורן', stage: 'admitted' }]
  });
  const r = houseOf(ov(g, '2026-10'), 'ramot').intakeMeetings;
  assert.deepStrictEqual([r.confirmed, r.pending], [1, 0]);
  assert.deepStrictEqual(r.items, [{ date: '2026-10-05', name: 'דנה', house: 'ramot', status: 'confirmed' }]);
  // Other houses get nothing; the month of admission is what counts.
  assert.strictEqual(houseOf(ov(g, '2026-10'), 'efroni').intakeMeetings.confirmed, 0);
  assert.strictEqual(houseOf(ov(g, '2026-11'), 'ramot').intakeMeetings.confirmed, 0);
});

test('6th patient does not count; 7th does', () => {
  const five = base6('arfoni').slice(0, 5);
  const g = boot({
    patients: [...five, { houseId: 'arfoni', name: 'שישי', date: '2026-10-02', fromLead: 'L6' },
      { houseId: 'arfoni', name: 'שביעי', date: '2026-10-03', fromLead: 'L7' }],
    leads: [{ id: 'L6', meetingWith: 'חנן' }, { id: 'L7', meetingWith: 'חנן' }]
  });
  const r = houseOf(ov(g, '2026-10'), 'efroni').intakeMeetings;
  assert.strictEqual(r.confirmed, 1);
  assert.strictEqual(r.items[0].name, 'שביעי');
});

test('same-day admissions are ranked by sheet order', () => {
  const g = boot({
    patients: [...base6('rehab').slice(0, 5),
      { houseId: 'rehab', name: 'א', date: '2026-10-10', fromLead: 'A' },
      { houseId: 'rehab', name: 'ב', date: '2026-10-10', fromLead: 'B' }],
    leads: [{ id: 'A', meetingWith: 'רנטה' }, { id: 'B', meetingWith: 'רנטה' }]
  });
  const r = houseOf(ov(g, '2026-10'), 'rehab').intakeMeetings;
  assert.deepStrictEqual(r.items.map((i) => i.name), ['ב'], 'א is the 6th, ב the 7th');
});

test('a patient who left before entry day does not count toward the 6; one leaving ON entry day does', () => {
  const pts = base6('pardes');
  pts[0] = { ...pts[0], exitDate: '2026-10-09' };   // left the day before
  pts[1] = { ...pts[1], exitDate: '2026-10-10' };   // leaves on entry day — still present
  const g = boot({ patients: [...pts, { houseId: 'pardes', name: 'ג', date: '2026-10-10', fromLead: 'C' }], leads: [{ id: 'C', meetingWith: 'חן' }] });
  assert.strictEqual(houseOf(ov(g, '2026-10'), 'pardes').intakeMeetings.confirmed, 0, 'only 5 present that day');
});

test('30-day stay: discharged after 29 days → not counted; 30 days → confirmed; still in after 12 days → pending', () => {
  const g = boot({
    patients: [...base6('asher'),
      { houseId: 'asher', name: 'קצר', date: '2026-10-01', exitDate: '2026-10-30', fromLead: 'S' },
      { houseId: 'asher', name: 'חודש', date: '2026-10-01', exitDate: '2026-10-31', fromLead: 'M' },
      { houseId: 'asher', name: 'חדש', date: '2026-10-20', fromLead: 'N' }],
    leads: [{ id: 'S', meetingWith: 'שחר' }, { id: 'M', meetingWith: 'שחר' }, { id: 'N', meetingWith: 'שחר' }],
    today: '2026-11-01'
  });
  const r = houseOf(ov(g, '2026-10'), 'raanana').intakeMeetings;
  assert.deepStrictEqual([r.confirmed, r.pending], [1, 1]);
  assert.deepStrictEqual(r.items.map((i) => [i.name, i.status]), [['חדש', 'pending'], ['חודש', 'confirmed']]);
  // Later, the pending one confirms.
  g.run("intakeToday_ = function () { return parseDate_('2026-11-19'); }");
  const later = houseOf(ov(g, '2026-10'), 'raanana').intakeMeetings;
  assert.deepStrictEqual([later.confirmed, later.pending], [2, 0]);
});

test('credit follows the MEETING manager, matched on the admission date — even into another house', () => {
  // Chen (pardes) held the meeting; the patient was admitted to Ramot.
  const g = boot({
    patients: [...base6('ramot'), { houseId: 'ramot', name: 'ד', date: '2026-10-07', fromLead: 'X' }],
    leads: [{ id: 'X', meetingWith: ' חן ' }]
  });
  const o = ov(g, '2026-10');
  assert.strictEqual(houseOf(o, 'pardes').intakeMeetings.confirmed, 1);
  assert.strictEqual(houseOf(o, 'pardes').intakeMeetings.items[0].house, 'ramot', 'admitted house is reported');
  assert.strictEqual(houseOf(o, 'ramot').intakeMeetings.confirmed, 0);
});

test('two managers named שחר: the one active on the admission date gets the credit', () => {
  const g = boot({
    patients: [...base6('ramot'), { houseId: 'ramot', name: 'ה', date: '2026-10-07', fromLead: 'Y' }],
    leads: [{ id: 'Y', meetingWith: 'שחר' }]
  });
  const o = ov(g, '2026-10');
  assert.strictEqual(houseOf(o, 'raanana').intakeMeetings.confirmed, 1, "Ra'anana's שחר (active since Aug 24)");
  assert.strictEqual(houseOf(o, 'ramot').intakeMeetings.confirmed, 0, "Ramot's former שחר ended Aug 24");
});

test('not counted: no fromLead, lead without meetingWith, unknown manager name', () => {
  const g = boot({
    patients: [...base6('ramot'),
      { houseId: 'ramot', name: 'ללא ליד', date: '2026-10-03', fromLead: '' },
      { houseId: 'ramot', name: 'ללא פגישה', date: '2026-10-04', fromLead: 'E' },
      { houseId: 'ramot', name: 'זר', date: '2026-10-05', fromLead: 'U' }],
    leads: [{ id: 'E', meetingWith: '' }, { id: 'U', meetingWith: 'מישהו אחר' }]
  });
  const o = ov(g, '2026-10');
  for (const h of o.houses) assert.deepStrictEqual([h.intakeMeetings.confirmed, h.intakeMeetings.pending], [0, 0], h.key);
});

test('a lead moved to the removed tab is still found', () => {
  const g = boot({
    patients: [...base6('ramot'), { houseId: 'ramot', name: 'ו', date: '2026-10-02', fromLead: 'R' }],
    leads: []
  });
  const rcols = Array.from(g.run('REMOVED_LEAD_COLUMNS'));
  const sh = richSheet('לידים שהוסרו', rcols);
  sh.grid.push(rcols.map((c) => ({ id: 'R', meetingWith: 'אורן' }[c] ?? '')));
  g.sandbox.__sheets['לידים שהוסרו'] = sh;
  assert.strictEqual(houseOf(ov(g, '2026-10'), 'ramot').intakeMeetings.confirmed, 1);
});

test('managersHouse carries the same intakeMeetings as the overview', () => {
  const g = boot({
    patients: [...base6('ramot'), { houseId: 'ramot', name: 'ז', date: '2026-10-05', fromLead: 'L1' }],
    leads: [{ id: 'L1', meetingWith: 'אורן' }]
  });
  const h = arr(g.sandbox.managersHouse_('ramot', '2026-10'));
  assert.deepStrictEqual(h.intakeMeetings, houseOf(ov(g, '2026-10'), 'ramot').intakeMeetings);
});

test('read-only: no Leads tab → zero counts, and no tab is created or written', () => {
  const g = boot({ patients: [...base6('ramot')], withLeadsTab: false });
  const before = Object.keys(g.sandbox.__sheets).sort();
  const o = ov(g, '2026-10');
  assert.strictEqual(houseOf(o, 'ramot').intakeMeetings.confirmed, 0);
  assert.ok(!('Leads' in g.sandbox.__sheets), 'Leads tab not created');
  assert.deepStrictEqual(Object.keys(g.sandbox.__sheets).sort().filter((n) => !before.includes(n)).filter((n) => /ליד|Lead/.test(n)), []);
});

test('the other payload fields are unchanged by the intake feed', () => {
  const pts = [...base6('ramot'), { houseId: 'ramot', name: 'ח', date: '2026-10-05', fromLead: 'L1' }];
  const withLead = ov(boot({ patients: pts, leads: [{ id: 'L1', meetingWith: 'אורן' }] }), '2026-10');
  const without = ov(boot({ patients: pts, leads: [] }), '2026-10');
  const strip = (o) => o.houses.map(({ intakeMeetings, ...rest }) => rest);
  assert.deepStrictEqual(strip(withLead), strip(without));
  assert.deepStrictEqual(withLead.totals, without.totals);
});
