'use strict';

/* getDischargedRoster — CHANGELOG-discharged-roster-endpoint.md.
 * The read-only alumni feed for the E-Zone Therapists app, behind its own
 * fail-closed ALUMNI_SOURCE_SECRET. Real Code.gs in the vm sandbox. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { richSheet, loadGs } = require('./helpers/gs-sandbox');

const SECRET = 'alumni-source-secret-TEST-0123456789';
const arr = (x) => JSON.parse(JSON.stringify(x));
const src = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
const NOW = new Date('2026-10-18T09:00:00Z').getTime();

function boot({ secret = SECRET, patients, leads } = {}) {
  const props = { PROXY_SECRET_MODE: 'enforce', PROXY_SECRET: 'proxy-secret-TEST-alumni-feed-0000000000' };
  if (secret !== null) props.ALUMNI_SOURCE_SECRET = secret;
  const g = loadGs({ props });
  g.sandbox.Utilities.formatDate = (d) => {
    const x = new Date(d); const p = (n) => (n < 10 ? '0' + n : '' + n);
    return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
  };
  g.sandbox.Date = class extends Date { static now() { return NOW; } };
  const pc = Array.from(g.run('PATIENT_COLUMNS')), lc = Array.from(g.run('LEAD_COLUMNS'));
  const ps = richSheet('Patients', pc), ls = richSheet('Leads', lc);
  (patients || []).forEach((r) => ps.grid.push(pc.map((c) => r[c] ?? '')));
  (leads || []).forEach((r) => ls.grid.push(lc.map((c) => r[c] ?? '')));
  g.sandbox.__sheets.Patients = ps;
  g.sandbox.__sheets.Leads = ls;
  const feed = (s = SECRET) => arr(g.post({ action: 'getDischargedRoster', secret: s }));
  return { g, feed };
}

const PATIENTS = [
  { houseId: 'asher', name: 'יוצא לאחרונה', fromLead: 'L1', date: '2026-05-01', exitDate: '2026-10-01', status: 'released',
    pay: 30000, adv: 5000, notes: 'sensitive note', source: 'lead', id: 'pid-1', personId: 'person-root-1' },
  { houseId: 'ramot', name: 'ללא ליד', fromLead: '', date: '2026-06-01', exitDate: '2026-09-01', status: 'released', id: 'pid-2', personId: '' },
  { houseId: 'ramot', name: 'ישן מדי', fromLead: 'L1', date: '2022-01-01', exitDate: '2023-01-01', status: 'released' },
  { houseId: 'ramot', name: 'עדיין בבית', fromLead: 'L1', date: '2026-09-01', exitDate: '', status: 'active' },
  { houseId: 'ramot', name: 'שוחרר בלי תאריך', fromLead: 'L1', date: '2026-09-01', exitDate: '', status: 'released' },
];
const LEADS = [{ id: 'L1', phone: '+972-52-765-4321', note: 'private', stage: 'x' }];

test('fail-closed: unset / blank / missing / wrong / another secret → unauthorized, nothing read', () => {
  assert.deepStrictEqual(boot({ secret: null, patients: PATIENTS, leads: LEADS }).feed(SECRET), { ok: false, error: 'unauthorized' });
  assert.deepStrictEqual(boot({ secret: '', patients: PATIENTS, leads: LEADS }).feed(SECRET), { ok: false, error: 'unauthorized' });
  const { feed, g } = boot({ patients: PATIENTS, leads: LEADS });
  assert.deepStrictEqual(feed(''), { ok: false, error: 'unauthorized' });
  assert.deepStrictEqual(feed('wrong'), { ok: false, error: 'unauthorized' });
  assert.deepStrictEqual(arr(g.post({ action: 'getDischargedRoster' })), { ok: false, error: 'unauthorized' });
  assert.deepStrictEqual(arr(g.post({ action: 'getDischargedRoster', secret: 'proxy-secret-TEST-alumni-feed-0000000000' })), { ok: false, error: 'unauthorized' }, 'PROXY_SECRET is not this secret');
});

test('contract: stable stay/person identity plus the existing alumni allow-list — nothing else leaks', () => {
  const { feed } = boot({ patients: PATIENTS, leads: LEADS });
  const r = feed();
  assert.strictEqual(r.ok, true);
  const by = (n) => r.patients.find((p) => p.name === n);
  assert.deepStrictEqual(by('יוצא לאחרונה'), {
    sourceApp: 'ezone-dashboard', id: 'pid-1', personId: 'person-root-1',
    name: 'יוצא לאחרונה', phone: '0527654321', house: 'asher', entryDate: '2026-05-01', exitDate: '2026-10-01'
  });
  assert.strictEqual(by('ללא ליד').id, 'pid-2');
  assert.strictEqual(by('ללא ליד').personId, '');
  r.patients.forEach((p) => assert.deepStrictEqual(Object.keys(p).sort(),
    ['entryDate', 'exitDate', 'house', 'id', 'name', 'personId', 'phone', 'sourceApp']));
});

test('selection: released inside the window only; no phone without a lead link; admitted / dateless / old excluded', () => {
  const { feed } = boot({ patients: PATIENTS, leads: LEADS });
  const names = feed().patients.map((p) => p.name).sort();
  assert.deepStrictEqual(names, ['ללא ליד', 'יוצא לאחרונה'].sort());
  assert.strictEqual(feed().patients.find((p) => p.name === 'ללא ליד').phone, '');
});

test('wiring: open action, known action, dispatched behind its own secret, read-only', () => {
  const { g } = boot();
  assert.ok(Array.from(g.run('OPEN_ACTIONS')).includes('getDischargedRoster'));
  assert.ok(Array.from(g.run('PROXY_KNOWN_ACTIONS')).includes('getDischargedRoster'));
  assert.match(src, /if \(action === 'getDischargedRoster'\) \{\n\s*\/\/[^\n]*\n\s*if \(!alumniSourceAuthOk_\(params\)\) return jsonOut_\(\{ ok: false, error: 'unauthorized' \}\);/);
  const fn = src.slice(src.indexOf('function getDischargedRoster_'), src.indexOf('/* Normalize a phone to canonical'));
  assert.ok(!/setValues|appendRow|deleteRow|clearContent|setValue\(/.test(fn), 'no write surface');
  const auth = src.slice(src.indexOf('function alumniSourceAuthOk_'), src.indexOf('function getDischargedRoster_'));
  assert.ok(/constantTimeEquals_/.test(auth) && /if \(!expected\) return false/.test(auth));
});

/* ===== retroactive phone recovery (CHANGELOG-roster-phone-fallback.md) ===== */
test('phone fallback: no fromLead → the unique same-name lead phone is used (admitted + discharged); read-only', () => {
  const leads = [{ id: 'L2', name: 'דנה  כהן', phone: '052-111-2222' }, { id: 'L3', name: 'דנה כהן', phone: '+972521112222' }];
  const patients = [
    { houseId: 'asher', name: 'דנה כהן', fromLead: '', date: '2026-05-01', exitDate: '2026-10-01', status: 'released' },
    { houseId: 'asher', name: 'אין התאמה', fromLead: '', date: '2026-05-01', exitDate: '2026-10-02', status: 'released' },
  ];
  const { feed, g } = boot({ patients, leads });
  const r = feed();
  assert.strictEqual(r.patients.find((p) => p.name === 'דנה כהן').phone, '0521112222');   // duplicates agree → recovered
  assert.strictEqual(r.patients.find((p) => p.name === 'אין התאמה').phone, '');            // no match → stays blank
  const rowsAfter = g.sandbox.__sheets.Leads.grid.length;
  assert.strictEqual(rowsAfter, leads.length + 1, 'nothing written to Leads');
});

test('phone fallback: ambiguous name (two different phones) stays blank; a fromLead phone always wins', () => {
  const leads = [
    { id: 'A', name: 'רון לוי', phone: '0501111111' }, { id: 'B', name: 'רון לוי', phone: '0502222222' },
    { id: 'C', name: 'שרה בר', phone: '0503333333' }, { id: 'D', name: 'שרה בר', phone: '0504444444' },
  ];
  const patients = [
    { houseId: 'asher', name: 'רון לוי', fromLead: '', date: '2026-05-01', exitDate: '2026-10-01', status: 'released' },
    { houseId: 'asher', name: 'שרה בר', fromLead: 'C', date: '2026-05-01', exitDate: '2026-10-02', status: 'released' },
  ];
  const r = boot({ patients, leads }).feed();
  assert.strictEqual(r.patients.find((p) => p.name === 'רון לוי').phone, '');
  assert.strictEqual(r.patients.find((p) => p.name === 'שרה בר').phone, '0503333333');
});
