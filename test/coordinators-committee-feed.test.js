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
  const feed = (secretSent = CC_SECRET, extra) => arr(g.post({ action: 'getCommitteesForCoordinators', secret: secretSent, ...(extra || {}) }));
  G = g;
  return { g, mw, feed };
}
const who = (house, role = 'manager') => ({ house, role, actor: 'מנהל', actorId: 'person-' + house });
/* Seeds ManagersCommittee through the retained write function — the HTTP op
 * `committeeSet` is refused since 20 Oct 2026 (CHANGELOG-committees-from-coordinators.md). */
let G = null;
const cmDirect = (body) => arr(G.sandbox.mwCommitteeSet_(G.sandbox.mwCaller_(body), body));
const cm = (mw, house, patientName, entryDate, committeeDate, label = '', correction) =>
  cmDirect({ ...who(house, correction ? 'admin' : 'manager'), patientName, entryDate, committeeDate, label, previousDate: '', previousLabel: '' });

test('fail-closed: no secret configured / missing / wrong → unauthorized, nothing read', () => {
  const unset = boot({ secret: '' });
  assert.deepStrictEqual(unset.feed(CC_SECRET), { ok: false, error: 'unauthorized', reason: 'not_configured' });
  assert.deepStrictEqual(boot({ secret: '   ' }).feed(CC_SECRET), { ok: false, error: 'unauthorized', reason: 'not_configured' }, 'blank = unset');
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
  cmDirect({ ...who('raanana'), mode: 'clear', patientName: 'אתמול', entryDate: '2026-09-10', committeeDate: '', previousDate: '2026-10-16', previousLabel: '' });
  assert.deepStrictEqual(feed().committees, []);
  G = g;
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
  assert.match(src, /if \(action === 'getCommitteesForCoordinators'\) \{\n\s*const committeesAuth = coordinatorsCommitteesAuth_\(params\);\n\s*if \(committeesAuth !== 'ok'\) return jsonOut_\(coordinatorsCommitteesRefusal_\(committeesAuth\)\);/);
});

/* CHANGELOG-committee-feed-diagnostics.md */
test('diagnostics: a secret pasted with whitespace (either side) still matches; a mismatch never says not_configured', () => {
  const padded = boot({ secret: CC_SECRET + '\n' });
  assert.strictEqual(padded.feed(CC_SECRET).ok, true, 'trailing newline in our Script Property');
  const { feed } = boot();
  assert.strictEqual(feed('  ' + CC_SECRET + ' ').ok, true, 'spaces around the value sent');
  assert.deepStrictEqual(feed(CC_SECRET.slice(0, -1)), { ok: false, error: 'unauthorized' });
  assert.deepStrictEqual(feed('   '), { ok: false, error: 'unauthorized' }, 'blank sent = missing');
  assert.deepStrictEqual(feed(CC_SECRET + 'x'), { ok: false, error: 'unauthorized' });
});

test('diagnostics: a refusal reads nothing and carries no data beyond the reason', () => {
  const unset = boot({ secret: '' });
  const r = unset.feed(CC_SECRET);
  assert.deepStrictEqual(Object.keys(r).sort(), ['error', 'ok', 'reason']);
  const src = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
  const fn = src.slice(src.indexOf('function coordinatorsCommitteesAuth_'), src.indexOf('function getCommitteesForCoordinators_'));
  assert.match(fn, /constantTimeEquals_\(got, expected\)/, 'constant-time compare kept');
  assert.doesNotMatch(fn, /console\.|Logger\./, 'the secret is never logged');
});

/* CHANGELOG-committees-from-coordinators.md — the one-time import */
test('range=future: every current committee dated today or later (no +3 cap), same keys; default unchanged', () => {
  const { mw, feed } = boot();
  cm(mw, 'ramot', 'דנה לוי', '2026-09-01', '2026-10-17', 'ועדת השמה');
  cm(mw, 'ramot', 'ארבעה ימים', '2026-09-03', '2027-03-01');
  cm(mw, 'efroni', 'יוסי כהן', '2026-09-10', '2026-10-15');
  assert.deepStrictEqual(feed().committees.map((c) => c.date), ['2026-10-15', '2026-10-17'], 'default: today..+3');
  const all = feed(CC_SECRET, { range: 'future' });
  assert.deepStrictEqual(all.committees.map((c) => [c.name, c.date]), [['יוסי כהן', '2026-10-15'], ['דנה לוי', '2026-10-17'], ['ארבעה ימים', '2027-03-01']]);
  for (const c of all.committees) assert.deepStrictEqual(Object.keys(c).sort(), ['date', 'house', 'id', 'label', 'name']);
  assert.deepStrictEqual(feed(CC_SECRET, { range: 'all' }).committees.length, 2, 'any other value = default');
  assert.deepStrictEqual(feed('wrong', { range: 'future' }), { ok: false, error: 'unauthorized' }, 'same gate');
  const sheet = G.sandbox.__sheets.ManagersCommittee;
  const later = boot({ today: '2026-10-16' });
  later.g.sandbox.__sheets.ManagersCommittee = sheet;
  assert.deepStrictEqual(later.feed(CC_SECRET, { range: 'future' }).committees.map((c) => c.date), ['2026-10-17', '2027-03-01'], 'yesterday is never sent');
});
