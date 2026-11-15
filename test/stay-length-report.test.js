'use strict';
/* CHANGELOG-stay-length-report.md — «משך שהייה»: one line per stay with house, referrer,
 * dates, days, status and continuity; cuts and group summaries. Synthetic names. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../public/crm/crm.js');
const R = require('../lib/patient-retention.js');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'crm', 'crm.js'), 'utf8');

const TODAY = '2026-11-15';
const P = [
  { id: 'p1', houseId: 'ramot', name: 'דנה כהן', date: '2026-10-01', status: 'active', source: 'עו"ס' },                          // active, 45 days
  { id: 'p2', houseId: 'ramot', name: 'אבי לוי', date: '2026-08-01', status: 'released', exitDate: '2026-08-21', fromLead: 'L2' },  // 20 days, referrer via the lead
  { id: 'p3', houseId: 'rehab', name: 'גל רון', date: '2026-06-01', status: 'released', exitDate: '2026-09-09', source: 'קופת חולים' },   // 100 days
  { id: 'p4', houseId: 'rehab', name: 'נועה שגב', date: '2026-09-01', status: 'released', exitDate: '2026-10-16', source: 'direct_approach' },   // 45 days, no referrer
  { id: 'p5', houseId: 'ramot', name: 'רון אביב', date: '2025-12-01', status: 'released', exitDate: '2026-02-09', source: 'עו"ס' },   // 70 days
];
const D = [{ id: 'd3', patientId: 'p3', houseId: 'rehab', name: 'גל רון', date: '2026-06-01', exitDate: '2026-09-09', continuity: 'continued_outpatient' }];
const LEADS = [{ id: 'L2', name: 'אבי לוי', source: 'גוגל' }];
const rr = R.computeRetention({ patients: P, discharged: D, from: '2000-01-01', to: '2999-12-31', customThreshold: null, today: TODAY });
const lines = core.stayLines(rr, P, LEADS, [], R.CONTINUITY_LABELS);
const by = Object.fromEntries(lines.map((l) => [l.id, l]));

test('one line per stay: days, house, referrer (own source, else the lead\'s, else «לא צוין»), continuity', () => {
  assert.equal(lines.length, 5);
  assert.deepEqual([by.p1.days, by.p1.status, by.p1.exitDate, by.p1.source, by.p1.bucket], [45, 'active', '', 'עו"ס', 'd31to60']);
  assert.deepEqual([by.p2.days, by.p2.status, by.p2.source, by.p2.bucket], [20, 'discharged', 'גוגל', 'upTo30'], 'the referrer comes from the lead');
  assert.deepEqual([by.p3.days, by.p3.bucket, by.p3.continuity, by.p3.continuityLabel], [100, 'over90', 'continued_outpatient', 'המשיך באמבולטורי (E-ZONE)']);
  assert.deepEqual([by.p4.days, by.p4.source], [45, 'לא צוין'], 'an internal source code is not a referrer');
  assert.deepEqual([by.p5.days, by.p5.bucket], [70, 'd61to90']);
  assert.ok(by.p1.houseName && by.p1.houseName !== 'ramot', 'the house by its name');
  assert.deepEqual(core.stayLines(null, P, LEADS), []); assert.deepEqual(core.stayLines({ ok: false }, P, LEADS), []);
});

test('who is listed: discharged in / entered in / present in the period / all', () => {
  const ids = (o) => core.stayReport(lines, o, TODAY).rows.map((r) => r.id).sort();
  assert.deepEqual(ids({ mode: 'discharged', from: '2026-08-01', to: '2026-10-31' }), ['p2', 'p3', 'p4']);
  assert.deepEqual(ids({ mode: 'entered', from: '2026-08-01', to: '2026-10-31' }), ['p1', 'p2', 'p4']);
  assert.deepEqual(ids({ mode: 'present', from: '2026-09-05', to: '2026-09-08' }), ['p3', 'p4'], 'in a house on any day of the period');
  assert.deepEqual(ids({ mode: 'present', from: '2026-11-01', to: '2026-11-30' }), ['p1'], 'an active stay is present up to today');
  assert.deepEqual(ids({ mode: 'all' }), ['p1', 'p2', 'p3', 'p4', 'p5']);
  assert.deepEqual(ids({ from: '2026-01-01', to: '2026-12-31' }), ['p2', 'p3', 'p4', 'p5'], 'the default mode is «שוחררו בתקופה»');
  const bad = core.stayReport(lines, { mode: 'entered', from: '2026-10-31', to: '2026-08-01' }, TODAY);
  assert.deepEqual([bad.ok, bad.rows.length], [false, 0], 'a reversed range lists nothing');
});

test('the cuts and the numbers', () => {
  const all = core.stayReport(lines, { mode: 'all' }, TODAY);
  assert.deepEqual([all.stats.count, all.stats.avg, all.stats.median, all.stats.min, all.stats.max, all.stats.totalDays], [5, 56, 45, 20, 100, 280]);
  assert.deepEqual([all.discharged.count, all.discharged.avg, all.active.count, all.active.avg], [4, 58.8, 1, 45]);
  assert.deepEqual(all.buckets, { upTo30: 1, d31to60: 2, d61to90: 1, over90: 1 });
  assert.deepEqual(all.sources, ['גוגל', 'לא צוין', 'עו"ס', 'קופת חולים'].sort((a, b) => a.localeCompare(b, 'he')));
  assert.deepEqual(core.stayReport(lines, { mode: 'all', house: 'rehab' }, TODAY).rows.map((r) => r.id).sort(), ['p3', 'p4']);
  assert.deepEqual(core.stayReport(lines, { mode: 'all', source: 'עו"ס' }, TODAY).rows.map((r) => r.id).sort(), ['p1', 'p5']);
  assert.deepEqual(core.stayReport(lines, { mode: 'all', status: 'active' }, TODAY).rows.map((r) => r.id), ['p1']);
  assert.deepEqual(core.stayReport(lines, { mode: 'all', bucket: 'over90' }, TODAY).rows.map((r) => r.id), ['p3']);
  assert.deepEqual(core.stayReport(lines, { mode: 'all', q: 'קופת' }, TODAY).rows.map((r) => r.id), ['p3'], 'search by referrer');
  assert.deepEqual(core.stayStats([]), { count: 0, avg: null, median: null, min: null, max: null, totalDays: 0 });
});

test('«חתך לפי»: a summary line per house / referrer / length / status', () => {
  const g = (group) => core.stayReport(lines, { mode: 'all', group }, TODAY).groups;
  assert.deepEqual(g('source').map((x) => [x.label, x.count, x.avg]), [['עו"ס', 2, 57.5], ['גוגל', 1, 20], ['לא צוין', 1, 45], ['קופת חולים', 1, 100]]);
  assert.deepEqual(g('house').map((x) => [x.count, x.avg, x.totalDays]), [[3, 45, 135], [2, 72.5, 145]]);
  assert.deepEqual(g('bucket').map((x) => [x.label, x.count]), [['עד 30 יום', 1], ['31 עד 60 יום', 2], ['61 עד 90 יום', 1], ['91 יום ומעלה', 1]]);
  assert.deepEqual(g('status').map((x) => [x.label, x.count]), [['שוחררו', 4], ['עדיין בטיפול', 1]]);
  assert.deepEqual(g('continuity').map((x) => x.label).includes('עדיין בטיפול'), true);
  assert.deepEqual(g(''), []); assert.deepEqual(g('nonsense'), []);
});

test('the CSV: quoted, and a formula-looking cell is defused', () => {
  const csv = core.stayCsv([Object.assign({}, by.p3, { name: '=HYPERLINK("x")' }), by.p1]);
  const rows = csv.split('\r\n');
  assert.equal(rows.length, 3);
  assert.match(rows[0], /^"מטופל\/ת","בית","גורם מפנה","כניסה","יציאה","ימי שהייה","סטטוס","המשך טיפול"/);
  assert.ok(rows[1].startsWith('"\'=HYPERLINK(""x"")"'), 'no live formula in Excel');
  assert.match(rows[2], /"דנה כהן",.*"45","עדיין בטיפול"/);
});

test('who sees it and how it is wired: not the controller; no request; no money', () => {
  assert.ok(core.areasFor({ view: 'full', finance: true }).includes('stays'));
  assert.ok(core.areasFor({ view: 'ops', ops: true, finance: false }).includes('stays'));
  assert.ok(!core.areasFor({ view: 'controller' }).includes('stays'));
  const fn = SRC.slice(SRC.indexOf('function renderStays()'), SRC.indexOf('/* «בונוס» (CHANGELOG-dana-bonus-tab.md): where Dana stands'));
  assert.ok(!/fetch\(|api\(|\.pay\b|fmtMoney/.test(fn), 'display only, no price');
  assert.ok(!/'<td>' \+ r\.(name|houseName|source)\b/.test(fn), 'text cells escaped');
  assert.match(SRC, /\['mode', 'from', 'to', 'status', 'house', 'source', 'bucket', 'group', 'q'\]\.indexOf\(k\) < 0\) return;/, 'only known filter keys are accepted');
});
