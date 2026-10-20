'use strict';

/* Committees from the coordinators (CHANGELOG-committees-from-coordinators.md):
 * mwCoordinatorsCommittees_ reads the coordinators' read-only
 * `getCommitteesForManagers` (COORDINATORS_SHEETS_URL + COORDINATORS_MANAGERS_SECRET),
 * fail-closed on every reason and on ONE off-contract entry, cached; houseData
 * carries the CALLER's house only. Real Code.gs in the vm sandbox, UrlFetchApp stubbed. */

const { test } = require('node:test');
const assert = require('node:assert');
const { richSheet, loadGs } = require('./helpers/gs-sandbox');

const MW_SECRET = 'mw-secret-TEST-coord-committees';
const URL = 'https://script.google.com/macros/s/COORD-TEST_123/exec';
const SECRET = 'coord-managers-secret-TEST-0123456789';
const TODAY = '2026-10-20';
const arr = (x) => JSON.parse(JSON.stringify(x));

const E = (o) => ({ id: 'cm-0001', house: 'ramot', date: '2026-10-22', time: '10:30', type: 'ועדת השמה', participants: 'אורן, ד"ר כהן', patientName: 'דנה לוי', updatedAt: '2026-10-19T08:00:00.000Z', ...o });

function boot({ props = { COORDINATORS_SHEETS_URL: URL, COORDINATORS_MANAGERS_SECRET: SECRET }, respond } = {}) {
  const g = loadGs({ props: { MANAGERS_WORK_SECRET: MW_SECRET, ...props } });
  g.sandbox.Session = { getScriptTimeZone: () => 'Asia/Jerusalem' };
  g.sandbox.Utilities.formatDate = (d, tz, fmt) => {
    const x = new Date(d); const p = (n) => (n < 10 ? '0' + n : '' + n);
    if (fmt === 'HH:mm') return `${p(x.getHours())}:${p(x.getMinutes())}`;
    if (fmt === 'yyyy-MM') return `${x.getFullYear()}-${p(x.getMonth() + 1)}`;
    return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
  };
  g.run(`todayISODate_ = function () { return '${TODAY}'; }`);
  g.run(`committeeToday_ = function () { return '${TODAY}'; }`);
  const cols = Array.from(g.run('PATIENT_COLUMNS'));
  g.sandbox.__sheets.Patients = richSheet('Patients', cols);
  const calls = [];
  g.sandbox.UrlFetchApp = { fetch: (url, opts) => {
    calls.push({ url, opts });
    const r = respond ? respond(url, opts) : { body: { ok: true, today: TODAY, committees: [] } };
    if (r instanceof Error) throw r;
    return { getResponseCode: () => (r.status == null ? 200 : r.status), getContentText: () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)) };
  } };
  const feed = () => arr(g.sandbox.mwCoordinatorsCommittees_());
  const mw = (body) => arr(g.post({ action: 'managersWork', secret: MW_SECRET, ...body }));
  return { g, calls, feed, mw };
}
const ok = (committees) => () => ({ body: { ok: true, today: TODAY, committees } });

test('transport: ONE POST {action, secret} as JSON to the /exec URL, redirects followed, HTTP errors muted', () => {
  const { feed, calls } = boot({ respond: ok([E()]) });
  const r = feed();
  assert.strictEqual(r.available, true);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].url, URL);
  assert.deepStrictEqual([calls[0].opts.method, calls[0].opts.contentType, calls[0].opts.muteHttpExceptions, calls[0].opts.followRedirects], ['post', 'application/json', true, true]);
  assert.deepStrictEqual(JSON.parse(calls[0].opts.payload), { action: 'getCommitteesForManagers', secret: SECRET });
});

test('both Script Properties are trimmed; unset / blank / not an /exec URL → not_configured, no fetch, not cached', () => {
  const padded = boot({ props: { COORDINATORS_SHEETS_URL: ' ' + URL + '\n', COORDINATORS_MANAGERS_SECRET: SECRET + ' ' }, respond: ok([]) });
  assert.strictEqual(padded.feed().available, true);
  assert.strictEqual(JSON.parse(padded.calls[0].opts.payload).secret, SECRET);
  for (const props of [{}, { COORDINATORS_SHEETS_URL: URL }, { COORDINATORS_MANAGERS_SECRET: SECRET }, { COORDINATORS_SHEETS_URL: URL, COORDINATORS_MANAGERS_SECRET: '   ' },
    { COORDINATORS_SHEETS_URL: 'https://evil.example/exec', COORDINATORS_MANAGERS_SECRET: SECRET }, { COORDINATORS_SHEETS_URL: 'http://script.google.com/macros/s/X/exec', COORDINATORS_MANAGERS_SECRET: SECRET }]) {
    const b = boot({ props });
    assert.deepStrictEqual(b.feed(), { available: false, reason: 'not_configured' }, JSON.stringify(props));
    assert.strictEqual(b.calls.length, 0);
    assert.deepStrictEqual(b.g.sandbox.__cache, {}, 'setting the properties takes effect at once');
  }
});

test('every refusal / failure maps to ONE reason — never data', () => {
  const cases = [
    [() => ({ body: { ok: false, error: 'not_configured' } }), 'coordinators_not_configured'],
    [() => ({ body: { ok: false, error: 'unauthorized' } }), 'unauthorized'],
    [() => ({ body: { ok: false, error: 'unknown action: getCommitteesForManagers' } }), 'unknown_action'],
    [() => ({ body: { ok: false, error: 'boom' } }), 'bad_response'],
    [() => new Error('Exception: Address unavailable'), 'unreachable'],
    [() => ({ status: 500, body: { ok: true, today: TODAY, committees: [] } }), 'http_error'],
    [() => ({ status: 302, body: '<html>' }), 'http_error'],
    [() => ({ body: '<!doctype html><title>Sign in</title>' }), 'bad_response'],
    [() => ({ body: { ok: true, today: TODAY } }), 'bad_response'],
    [() => ({ body: { ok: true, today: '20/10/2026', committees: [] } }), 'bad_response'],
    [() => ({ body: 'null' }), 'bad_response'],
  ];
  for (const [respond, reason] of cases) assert.deepStrictEqual(boot({ respond }).feed(), { available: false, reason }, reason);
});

test('contract guard: ONE entry off the exact keys / types / houses / dates / times / lengths → bad_contract, nothing shown', () => {
  const { id, ...noId } = E();
  const bad = [
    { ...E(), phone: '0501234567' }, noId, E({ house: 'arfoni' }), E({ house: 'all' }), E({ date: '2026-02-30' }), E({ date: '22/10/2026' }),
    E({ time: '9:30' }), E({ time: '24:00' }), E({ id: 'a b' }), E({ id: '' }), E({ type: 'א'.repeat(121) }), E({ participants: 'א'.repeat(301) }),
    E({ patientName: 5 }), E({ updatedAt: null }), null, [], 'x',
  ];
  for (const b of bad) assert.deepStrictEqual(boot({ respond: ok([E(), b]) }).feed(), { available: false, reason: 'bad_contract' }, JSON.stringify(b));
  const edge = boot({ respond: ok([E({ time: '', type: 'א'.repeat(120), participants: 'א'.repeat(300), patientName: '' })]) }).feed();
  assert.strictEqual(edge.available, true, 'limits are inclusive, time and patient may be empty');
});

test('values are cleaned before they leave (formula lead-in and angle brackets stripped)', () => {
  const r = boot({ respond: ok([E({ type: '=HYPERLINK("x") <b>ועדה</b>', patientName: '<img src=x onerror=alert(1)>' })]) }).feed();
  assert.doesNotMatch(r.items[0].type, /^[=+@-]|[<>]/);
  assert.doesNotMatch(r.items[0].patientName, /[<>]/);
});

test('cache: an OK answer is reused (one fetch); a failure is held briefly too; the key is versioned', () => {
  const a = boot({ respond: ok([E()]) });
  a.feed(); a.feed(); a.feed();
  assert.strictEqual(a.calls.length, 1);
  assert.deepStrictEqual(Object.keys(a.g.sandbox.__cache), ['mw:coord-committees:v1']);
  assert.strictEqual(a.g.run('MW_CM_CACHE_OK_S'), 300);
  assert.strictEqual(a.g.run('MW_CM_CACHE_FAIL_S'), 60);
  const b = boot({ respond: () => new Error('down') });
  b.feed(); b.feed();
  assert.strictEqual(b.calls.length, 1, 'a down coordinators script is not called on every page open');
});

test('logs: one line per fetch — reason / status / count / ms; never the secret, a name, a type or the URL', () => {
  const a = boot({ respond: ok([E()]) });
  a.g.logs.length = 0;
  a.feed();
  const lines = a.g.logs.filter((l) => l.includes('committeesFeed'));
  assert.strictEqual(lines.length, 1);
  assert.match(lines[0], /^\[mw\] committeesFeed reason=ok status=200 count=1 ms=\d+$/);
  const b = boot({ respond: () => ({ body: { ok: false, error: 'unauthorized' } }) });
  b.feed();
  assert.ok(b.g.logs.some((l) => /reason=unauthorized status=200 count=0/.test(l)));
  for (const l of [...a.g.logs, ...b.g.logs]) {
    assert.ok(!l.includes(SECRET) && !l.includes(URL) && !l.includes('דנה') && !l.includes('ועדת') && !l.includes('אורן'), l);
  }
});

const ORAN = { house: 'ramot', role: 'manager', actor: 'אורן', actorId: 'person-oran' };
const HANAN = { house: 'efroni', role: 'manager', actor: 'חנן', actorId: 'person-hanan' };
const SANDRA = { house: 'efroni', role: 'admin', actor: 'סנדרה', actorId: 'person-sandra' };

test('houseData.committees: the CALLER\'s house only, today and later, by date then time (untimed last), exact keys', () => {
  const { mw } = boot({ respond: ok([
    E({ id: 'r-late', date: '2026-10-22', time: '14:00' }),
    E({ id: 'r-untimed', date: '2026-10-22', time: '' }),
    E({ id: 'r-early', date: '2026-10-22', time: '09:00' }),
    E({ id: 'r-today', date: TODAY, time: '' }),
    E({ id: 'r-past', date: '2026-10-19' }),
    E({ id: 'e-1', house: 'efroni', date: '2026-10-21' }),
  ]) });
  const d = mw({ op: 'houseData', ...ORAN });
  assert.strictEqual(d.committees.available, true);
  assert.strictEqual(d.committees.today, TODAY);
  assert.deepStrictEqual(d.committees.items.map((c) => c.id), ['r-today', 'r-early', 'r-late', 'r-untimed'], 'past dropped, other house never sent');
  assert.deepStrictEqual(Object.keys(d.committees.items[0]).sort(), ['date', 'id', 'participants', 'patientName', 'time', 'type']);
  assert.deepStrictEqual(mw({ op: 'houseData', ...HANAN }).committees.items.map((c) => c.id), ['e-1']);
  assert.deepStrictEqual(mw({ op: 'houseData', ...SANDRA }).committees.items.map((c) => c.id), ['e-1'], 'an admin reads the house the server named');
  // The client cannot widen it: an unknown house is refused before any read.
  assert.strictEqual(mw({ op: 'houseData', ...ORAN, house: 'all' }).error, 'bad_request');
});

test('houseData.committees: feed down → { available:false, reason } and the rest of houseData still answers', () => {
  const { mw } = boot({ respond: () => ({ body: { ok: false, error: 'unauthorized' } }) });
  const d = mw({ op: 'houseData', ...ORAN });
  assert.strictEqual(d.ok, true);
  assert.deepStrictEqual(d.committees, { available: false, reason: 'unauthorized' });
  assert.ok(Array.isArray(d.patients));
  const thrown = boot({ respond: ok([]) });
  thrown.g.run('mwCoordinatorsCommittees_ = function () { throw new Error("x"); }');
  assert.deepStrictEqual(thrown.mw({ op: 'houseData', ...ORAN }).committees, { available: false, reason: 'unreachable' });
});

test('committeeSet is refused for every caller and the reader never writes a sheet', () => {
  const { mw, g } = boot({ respond: ok([E()]) });
  for (const who of [ORAN, SANDRA]) assert.deepStrictEqual(mw({ op: 'committeeSet', ...who, committeeDate: '2026-10-22' }), { ok: false, error: 'committee_read_only' });
  mw({ op: 'houseData', ...ORAN });   // houseData provisions its own (unrelated) sheets once
  const before = JSON.stringify(g.sandbox.__sheets);
  g.sandbox.__cache = {};
  mw({ op: 'houseData', ...ORAN });
  assert.strictEqual(JSON.stringify(g.sandbox.__sheets), before, 'a fresh committees read writes nothing');
  assert.ok(!g.sandbox.__sheets.ManagersCommittee);
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
  const block = src.slice(src.indexOf('const COORD_MANAGERS_URL_PROP'), src.indexOf('/* ===== «סיכומי ישיבות» from the coordinators'));
  assert.ok(block.length > 500);
  assert.doesNotMatch(block, /appendRow|setValues|setValue\(|getOrCreateSheet_|insertSheet|LockService|Logger\./);
  assert.strictEqual((block.match(/console\.log\(/g) || []).length, 1, 'one log line, in mwCmLog_');
});
