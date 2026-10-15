'use strict';

/* getCommitteesForCoordinators (PR 4) — CHANGELOG-coordinators-committee-feed.md.
 * The coordinators' READ-ONLY view of ManagersCommittee, behind its own
 * fail-closed COORDINATORS_COMMITTEES_SECRET. Real Code.gs, vm sandbox. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { richSheet, loadGs } = require('./helpers/gs-sandbox');

const CC_SECRET = 'coord-committees-secret-TEST-0123456789';
const MW_SECRET = 'mw-secret-TEST-committee-feed';
const arr = (x) => JSON.parse(JSON.stringify(x));

function boot({ today = '2026-10-15', secret = CC_SECRET } = {}) {
  const props = { MANAGERS_WORK_SECRET: MW_SECRET, PROXY_SECRET_MODE: 'enforce', PROXY_SECRET: 'proxy-secret-TEST-committee-feed-000000' };
  if (secret) props.COORDINATORS_COMMITTEES_SECRET = secret;
  const g = loadGs({ props });
  g.sandbox.Session = { getScriptTimeZone: () => 'Asia/Jerusalem' };
  g.sandbox.Utilities.formatDate = (d, tz, fmt) => {
    const x = new Date(d); const p = (n) => (n < 10 ? '0' + n : '' + n);
    if (fmt === 'HH:mm') return `${p(x.getHours())}:${p(x.getMinutes())}`;
    if (fmt === 'yyyy-MM') return `${x.getFullYear()}-${p(x.getMonth() + 1)}`;
    return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
  };
  g.run(`todayISODate_ = function () { return '${today}'; }`);
  g.run(`committeeToday_ = function () { return '${today}'; }`);
  const cols = Array.from(g.run('PATIENT_COLUMNS'));
  const sh = richSheet('Patients', cols);
  [
    { houseId: 'ramot', name: 'דנה לוי', date: '2026-09-01', status: 'active', id: 'pid-dana', phone: '050-1234567' },
    { houseId: 'ramot', name: 'שלושה ימים', date: '2026-09-02', status: 'active', id: 'pid-3' },
    { houseId: 'ramot', name: 'ארבעה ימים', date: '2026-09-03', status: 'active', id: 'pid-4' },
    { houseId: 'arfoni', name: 'יוסי כהן', date: '2026-09-10', status: 'active', id: 'pid-yossi' },
    { houseId: 'asher', name: 'אתמול', date: '2026-09-10', status: 'active', id: 'pid-y' },
  ].forEach((r) => sh.grid.push(cols.map((c) => r[c] ?? '')));
  g.sandbox.__sheets.Patients = sh;
  const mw = (body) => arr(g.post({ action: 'managersWork', secret: MW_SECRET, ...body }));
  const feed = (secretSent = CC_SECRET) => arr(g.post({ action: 'getCommitteesForCoordinators', secret: secretSent }));
  return { g, mw, feed };
}
const who = (house, role = 'manager') => ({ house, role, actor: 'מנהל', actorId: 'person-' + house });
const cm = (mw, house, patientName, entryDate, committeeDate, label = '', correction) =>
  mw({ op: 'committeeSet', ...who(house, correction ? 'admin' : 'manager'), patientName, entryDate, committeeDate, label, previousDate: '', previousLabel: '' });

test('fail-closed: no secret configured / missing / wrong → unauthorized, nothing read', () => {
  const unset = boot({ secret: '' });
  assert.deepStrictEqual(unset.feed(CC_SECRET), { ok: false, error: 'unauthorized' });
  const { feed, g } = boot();
  assert.deepStrictEqual(feed(''), { ok: false, error: 'unauthorized' });
  assert.deepStrictEqual(feed('wrong'), { ok: false, error: 'unauthorized' });
  assert.deepStrictEqual(arr(g.post({ action: 'getCommitteesForCoordinators', secret: MW_SECRET })), { ok: false, error: 'unauthorized' }, 'another app\'s secret unlocks nothing');
  assert.deepStrictEqual(arr(g.post({ action: 'getCommitteesForCoordinators' })), { ok: false, error: 'unauthorized' });
});

test('contract: exactly id, name, house, date, label; canonical houses; window today..+3 only; sorted by date', () => {
  const { mw, feed, g } = boot();
  cm(mw, 'ramot', 'דנה לוי', '2026-09-01', '2026-10-17', 'ועדת השמה');
  cm(mw, 'ramot', 'שלושה ימים', '2026-09-02', '2026-10-18');
  cm(mw, 'ramot', 'ארבעה ימים', '2026-09-03', '2026-10-19');
  cm(mw, 'efroni', 'יוסי כהן', '2026-09-10', '2026-10-15', 'המשך');
  const rows = g.sandbox.__sheets.ManagersCommittee.grid.length;
  const r = feed();
  assert.deepStrictEqual([r.ok, r.today], [true, '2026-10-15']);
  assert.deepStrictEqual(r.committees, [
    { id: 'pid-yossi', name: 'יוסי כהן', house: 'efroni', date: '2026-10-15', label: 'המשך' },
    { id: 'pid-dana', name: 'דנה לוי', house: 'ramot', date: '2026-10-17', label: 'ועדת השמה' },
    { id: 'pid-3', name: 'שלושה ימים', house: 'ramot', date: '2026-10-18', label: '' },
  ], '+4 is not sent; efroni (not arfoni)');
  for (const c of r.committees) assert.deepStrictEqual(Object.keys(c).sort(), ['date', 'house', 'id', 'label', 'name'], 'no phone / money / notes / who');
  assert.ok(!JSON.stringify(r).includes('050-1234567'));
  assert.strictEqual(g.sandbox.__sheets.ManagersCommittee.grid.length, rows, 'read-only');
});

test('a past committee and a cleared one are never sent', () => {
  const { mw, feed, g } = boot();
  cm(mw, 'raanana', 'אתמול', '2026-09-10', '2026-10-16');
  mw({ op: 'committeeSet', ...who('raanana'), mode: 'clear', patientName: 'אתמול', entryDate: '2026-09-10', committeeDate: '', previousDate: '2026-10-16', previousLabel: '' });
  assert.deepStrictEqual(feed().committees, []);
  cm(mw, 'raanana', 'אתמול', '2026-09-10', '2026-10-16');
  const later = boot({ today: '2026-10-17' });
  later.g.sandbox.__sheets.ManagersCommittee = g.sandbox.__sheets.ManagersCommittee;
  assert.deepStrictEqual(later.feed().committees, [], 'yesterday is gone');
});

test('an id that is not uniquely resolvable is sent as "" (the coordinators then show the feed name)', () => {
  const { mw, feed, g } = boot();
  const cols = g.sandbox.__sheets.Patients.grid[0];
  g.sandbox.__sheets.Patients.grid.push(cols.map((c) => ({ houseId: 'ramot', name: 'דנה לוי', date: '2026-09-01', status: 'active', id: 'pid-dana-2' })[c] ?? ''));
  cm(mw, 'ramot', 'דנה לוי', '2026-09-01', '2026-10-16');
  assert.deepStrictEqual(feed().committees.map((c) => [c.id, c.name]), [['', 'דנה לוי']]);
});

test('gate wiring: open (own secret), known, never a PROXY_SECRET action; the block never writes or logs', () => {
  const { g } = boot();
  assert.ok(Array.from(g.run('OPEN_ACTIONS')).includes('getCommitteesForCoordinators'));
  assert.ok(Array.from(g.run('PROXY_KNOWN_ACTIONS')).includes('getCommitteesForCoordinators'));
  assert.deepStrictEqual(Array.from(g.run('COORD_COMMITTEE_FEED_KEYS')), ['id', 'name', 'house', 'date', 'label']);
  assert.strictEqual(g.run('COORD_COMMITTEE_FEED_DAYS'), 3);
  const src = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
  const block = src.slice(src.indexOf('function getCommitteesForCoordinators_'), src.indexOf('/* Validate the discharge payload'));
  assert.ok(block.length > 200);
  assert.doesNotMatch(block, /appendRow|setValues|setValue\(|insertSheet|LockService|console\.|Logger\./);
  assert.match(src, /if \(action === 'getCommitteesForCoordinators'\) \{\n\s*if \(!coordinatorsCommitteesAuthOk_\(params\)\) return jsonOut_\(\{ ok: false, error: 'unauthorized' \}\);/);
});
