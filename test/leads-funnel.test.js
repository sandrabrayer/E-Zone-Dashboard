'use strict';

/* «חתכים בלידים» — the leads funnel report (CHANGELOG-leads-funnel-report.md).
 * A. lib/leads-funnel.js: presets, the period (by creation date, inclusive),
 *    the three buckets and their precedence, edge cases, CSV safety.
 * B. app.js: the view over the REAL module + escaping.
 * C. wiring: served like the other lib assets, cached, loaded before app.js.
 * Names / phones are SYNTHETIC. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const F = require('../lib/leads-funnel.js');
const { loadPage } = require('./helpers/app-sandbox');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const L = (id, over) => Object.assign({ id, name: 'ליד ' + id, phone: '0520000000', created: '2026-09-15', stage: 'new' }, over || {});
const ids = (rows) => rows.map((r) => r.id);
const run = (o) => F.funnel(Object.assign({ from: '2026-09-01', to: '2026-09-30' }, o));

/* ---------------- A. presets ---------------- */

test('A: presets — this month, last month (incl. Feb / leap year), last 3 months across a year boundary', () => {
  assert.deepEqual(F.presetRange('this_month', '2026-10-19'), { from: '2026-10-01', to: '2026-10-19' });
  assert.deepEqual(F.presetRange('last_month', '2026-10-19'), { from: '2026-09-01', to: '2026-09-30' });
  assert.deepEqual(F.presetRange('last_month', '2028-03-01'), { from: '2028-02-01', to: '2028-02-29' });
  assert.deepEqual(F.presetRange('last_month', '2026-01-05'), { from: '2025-12-01', to: '2025-12-31' });
  assert.deepEqual(F.presetRange('last_3_months', '2026-02-10'), { from: '2025-12-01', to: '2026-02-10' });
  assert.equal(F.presetRange('nope', '2026-10-19'), null);
  assert.equal(F.presetRange('this_month', '2026-13-01'), null);
});

/* ---------------- A. period ---------------- */

test('A: the period is by creation date, both ends INCLUSIVE; outside → not counted', () => {
  const r = run({ leads: [
    L('a', { created: '2026-08-31', stage: 'admitted' }),
    L('b', { created: '2026-09-01', stage: 'admitted' }),
    L('c', { created: '2026-09-30', stage: 'admitted' }),
    L('d', { created: '2026-10-01', stage: 'admitted' }),
    L('e', { created: '2026-09-30T21:30:00.000Z', stage: 'admitted' }),
  ] });
  assert.deepEqual(ids(r.rows.entered).sort(), ['b', 'c', 'e']);
  assert.equal(r.population, 3);
});

test('A: a lead without a creation date is counted apart, never in a bucket', () => {
  const r = run({ leads: [L('x', { created: '', stage: 'admitted' }), L('y', { created: 'garbage', visitDate: '2026-09-02' })] });
  assert.equal(r.noCreated, 2);
  assert.equal(r.population, 0);
  assert.deepEqual(r.counts, { notRelevant: 0, visitedNotEntered: 0, entered: 0 });
});

test('A: a bad or reversed range fails closed', () => {
  assert.deepEqual(F.funnel({ from: '2026-09-30', to: '2026-09-01' }), { ok: false, error: 'bad_range' });
  assert.deepEqual(F.funnel({ from: '', to: '2026-09-01' }), { ok: false, error: 'bad_range' });
  assert.deepEqual(F.funnel({ from: '2026-02-30', to: '2026-03-01' }), { ok: false, error: 'bad_range' });
  const one = F.funnel({ from: '2026-09-15', to: '2026-09-15', leads: [L('a', { stage: 'admitted' })] });
  assert.equal(one.counts.entered, 1, 'a one-day period works');
});

/* ---------------- A. buckets ---------------- */

test('A: entered — a Patients or discharged row with fromLead, or an admitted stage', () => {
  const r = run({
    leads: [L('p1', { stage: 'paid' }), L('p2', { stage: 'admitted' }), L('p3', { stage: 'visit' })],
    irrelevantLeads: [L('p4', { stage: 'irrelevant', disposition: 'completed' })],
    patients: [{ fromLead: 'p1', status: 'active' }],
    dischargedPatients: [{ fromLead: 'p4', status: 'released' }],
  });
  assert.deepEqual(ids(r.rows.entered).sort(), ['p1', 'p2', 'p4']);
  assert.deepEqual(ids(r.rows.visitedNotEntered), ['p3']);
});

test('A: not relevant — closed with disposition not_relevant (via the disposition fn)', () => {
  const disposition = (l) => (l.not_relevant_reason === 'never_relevant' || !l.disposition ? 'not_relevant' : l.disposition);
  const r = run({
    irrelevantLeads: [
      L('n1', { stage: 'irrelevant', not_relevant_reason: 'never_relevant' }),
      L('n2', { stage: 'irrelevant', disposition: 'stopped_early', visitDate: '2026-09-20' }),
      L('n3', { stage: 'irrelevant', disposition: 'stopped_early' }),
      L('n4', { stage: 'irrelevant', disposition: 'not_relevant', visitDate: '2026-09-20' }),
    ],
    disposition,
  });
  assert.deepEqual(ids(r.rows.notRelevant).sort(), ['n1', 'n4'], 'not_relevant wins over a visit');
  assert.deepEqual(ids(r.rows.visitedNotEntered), ['n2'], 'stopped_early with a meeting = visited, not entered');
  assert.equal(r.population, 4, 'n3 (no meeting, not not_relevant) counts in the population only');
});

test('A: entered wins over not_relevant (a patient record is the ground truth)', () => {
  const r = run({ irrelevantLeads: [L('z', { stage: 'irrelevant', disposition: 'not_relevant' })], patients: [{ fromLead: 'z' }] });
  assert.deepEqual(ids(r.rows.entered), ['z']);
  assert.equal(r.counts.notRelevant, 0);
});

test('A: visited — a visitDate, a visit-or-later stage, or a meeting report; a plain new lead is none', () => {
  const r = run({ leads: [
    L('v1', { visitDate: '2026-11-02' }),
    L('v2', { stage: 'waitlist' }),
    L('v3', { stage: 'paid' }),
    L('v4', { meetingReportedAt: '2026-09-21T10:00:00Z' }),
    L('n0', {}),
  ] });
  assert.deepEqual(ids(r.rows.visitedNotEntered).sort(), ['v1', 'v2', 'v3', 'v4']);
  assert.equal(r.population, 5);
});

test('A: duplicates (first copy wins), direct_admin intake rows and junk are ignored', () => {
  const r = run({
    leads: [L('d1', { stage: 'visit' }), null, 'junk', L('i1', { source: 'direct_admin', stage: 'admitted' })],
    irrelevantLeads: [L('d1', { stage: 'irrelevant', disposition: 'not_relevant' })],
  });
  assert.deepEqual(ids(r.rows.visitedNotEntered), ['d1']);
  assert.equal(r.counts.notRelevant, 0);
  assert.equal(r.counts.entered, 0);
  assert.equal(r.population, 1);
});

test('A: empty / missing inputs → zero counts, ok', () => {
  const r = F.funnel({ from: '2026-09-01', to: '2026-09-30' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.counts, { notRelevant: 0, visitedNotEntered: 0, entered: 0 });
});

/* ---------------- A. CSV ---------------- */

test('A: CSV — BOM, Hebrew header, quoting and formula neutralization', () => {
  const csv = F.toCsv([{ bucket: 'entered', name: '=HYPERLINK("x")', phone: '+972520000000', created: '2026-09-01', house: 'בית "א"', source: '@x', visitDate: '' }]);
  assert.ok(csv.startsWith('﻿"קטגוריה","שם"'));
  assert.match(csv, /"נכנסו לבית","'=HYPERLINK\(""x""\)","'\+972520000000","2026-09-01","בית ""א""","'@x",""\r\n$/);
  assert.equal(F.csvFilename('2026-09-01', '2026-09-30', 'entered'), 'חתכים-בלידים-2026-09-01-2026-09-30-entered.csv');
  assert.equal(F.csvFilename('../x', '<b>', 'a/b'), 'חתכים-בלידים-x-b-ab.csv', 'filename is sanitized');
});

test('A: the module is pure — no I/O, no DOM, no logging', () => {
  const src = read('lib', 'leads-funnel.js').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(src, /fetch\(|require\(|innerHTML|document\.|console\.|XMLHttpRequest|localStorage/);
});

/* ---------------- B. the view ---------------- */

function page() {
  const pg = loadPage({ src: read('lib', 'leads-funnel.js') + '\n' + read('public', 'app.js') });
  return pg;
}

test('B: leadsFunnelReport uses the page state + computeDisposition (legacy reason → not_relevant)', () => {
  const pg = page();
  pg.set({
    leads: [L('a', { stage: 'visit' })],
    irrelevantLeads: [pg.run('normalizeIrrelevantLead')(L('b', { not_relevant_reason: 'never_relevant' }))],
    patients: [], dischargedPatients: [],
  });
  const r = pg.run("leadsFunnelReport(state, '2026-09-01', '2026-09-30')");
  assert.equal(r.counts.notRelevant, 1);
  assert.equal(r.counts.visitedNotEntered, 1);
});

test('B: the panel says it counts by creation date, escapes every value, offers CSV', () => {
  const pg = page();
  pg.set({ leads: [L('a', { stage: 'visit', name: '<img src=x onerror=alert(1)>', house: '<b>' })], irrelevantLeads: [], patients: [], dischargedPatients: [] });
  const html = pg.run("leadsFunnelHtml(leadsFunnelReport(state, '2026-09-01', '2026-09-30'), { from: '2026-09-01', to: '2026-09-30', bucket: 'visitedNotEntered' })");
  assert.match(html, /לפי תאריך יצירת הליד/);
  assert.match(html, /לא רלוונטי/);
  assert.match(html, /הגיעו לפגישה ולא נכנסו/);
  assert.match(html, /נכנסו לבית/);
  assert.match(html, /ייצוא CSV/);
  assert.ok(!html.includes('<img'), 'name escaped');
  assert.ok(html.includes('&lt;img'));
  assert.ok(!html.includes('<b>'));
});

test('B: a bad range or a missing module shows a Hebrew message, not a crash', () => {
  const pg = page();
  pg.set({ leads: [], irrelevantLeads: [], patients: [], dischargedPatients: [] });
  assert.match(pg.run("leadsFunnelHtml(leadsFunnelReport(state, '2026-09-30', '2026-09-01'), {})"), /טווח תאריכים תקין/);
  const bare = loadPage();
  assert.match(bare.run("leadsFunnelHtml(leadsFunnelReport(state, '2026-09-01', '2026-09-30'), {})"), /הדוח לא נטען/);
});

/* ---------------- C. wiring ---------------- */

test('C: served, cached and loaded before app.js like the other lib assets; no new data route', () => {
  const server = read('server.js');
  assert.match(server, /'\/leads-funnel\.js': \{ file: path\.join\(__dirname, 'lib', 'leads-funnel\.js'\)/);
  assert.match(server, /app\.get\('\/leads-funnel\.js', sendLibAsset\('\/leads-funnel\.js'\)\);/);
  const index = read('public', 'index.html');
  assert.ok(index.indexOf('leads-funnel.js?v=__BUILD__') > 0 && index.indexOf('leads-funnel.js?v=__BUILD__') < index.indexOf('app.js?v=__BUILD__'));
  assert.ok(index.includes('id="leads-funnel-btn"') && index.includes('id="leads-funnel"'));
  const sw = read('public', 'sw.js');
  assert.match(sw, /var BUNDLE_PATHS = \[[^\]]*'\/leads-funnel\.js'[^\]]*\]/);
  assert.ok(!read('apps-script', 'Code.gs').includes('leads-funnel'), 'no Code.gs change');
});
