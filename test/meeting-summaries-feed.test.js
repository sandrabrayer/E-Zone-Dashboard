'use strict';

/* «סיכומי ישיבות» from the coordinators (CHANGELOG-meeting-summaries-feed.md):
 * managersWork op `meetingSummaries` reads the coordinators' read-only
 * `getMeetingSummariesForManagers` for the CALLER's house and one month;
 * fail-closed on every reason and on ONE off-contract meeting; cached per
 * house+month. Real Code.gs in the vm sandbox, UrlFetchApp stubbed. */

const { test } = require('node:test');
const assert = require('node:assert');
const { loadGs } = require('./helpers/gs-sandbox');

const MW_SECRET = 'mw-secret-TEST-meetings';
const URL = 'https://script.google.com/macros/s/COORD-TEST_123/exec';
const SECRET = 'coord-managers-secret-TEST-0123456789';
const arr = (x) => JSON.parse(JSON.stringify(x));
const ORAN = { house: 'ramot', role: 'manager', actor: 'אורן', actorId: 'person-oran' };
const SANDRA = { house: 'efroni', role: 'admin', actor: 'סנדרה', actorId: 'person-sandra' };

const ROW = (o) => ({ patientName: 'דנה', weeklyUpdate: 'שבוע טוב\nשורה 2', goals: 'מטרה', ...o });
const MEET = (o) => ({ id: 'meetingA00000001', date: '2026-10-12', title: 'ישיבת צוות', attendees: 'א, ב', generalNotes: 'סיכום', finalizedAt: '2026-10-12T12:00:00.000Z', rows: [ROW()], ...o });

function boot({ props = { COORDINATORS_SHEETS_URL: URL, COORDINATORS_MANAGERS_SECRET: SECRET }, respond } = {}) {
  const g = loadGs({ props: { MANAGERS_WORK_SECRET: MW_SECRET, ...props } });
  g.run(`defaultMonth_ = function () { return '2026-10'; }`);
  const calls = [];
  const logs = [];
  g.sandbox.console = { log: (m) => logs.push(String(m)), error: () => {}, warn: () => {} };
  g.sandbox.UrlFetchApp = { fetch: (url, opts) => {
    calls.push({ url, opts, body: JSON.parse(opts.payload) });
    const r = respond ? respond(JSON.parse(opts.payload)) : { body: { ok: true, house: 'ramot', month: '2026-10', meetings: [] } };
    if (r instanceof Error) throw r;
    return { getResponseCode: () => (r.status == null ? 200 : r.status), getContentText: () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)) };
  } };
  const mw = (body) => arr(g.post({ action: 'managersWork', secret: MW_SECRET, ...body }));
  return { g, calls, logs, mw };
}
const ok = (meetings) => (b) => ({ body: { ok: true, house: b.house, month: b.month, meetings } });

test('transport: ONE POST { action, secret, house = the CALLER\'s, month } — a client house is ignored', () => {
  const { mw, calls } = boot({ respond: ok([MEET()]) });
  const r = mw({ op: 'meetingSummaries', ...ORAN, month: '2026-10' });
  assert.deepStrictEqual([r.ok, r.house, r.month, r.summaries.available], [true, 'ramot', '2026-10', true]);
  assert.deepStrictEqual(calls[0].body, { action: 'getMeetingSummariesForManagers', secret: SECRET, house: 'ramot', month: '2026-10' });
  assert.strictEqual(calls[0].url, URL);
  const it = r.summaries.items[0];
  assert.deepStrictEqual(Object.keys(it).sort(), ['attendees', 'date', 'finalizedAt', 'generalNotes', 'id', 'rows', 'title']);
  assert.strictEqual(it.rows[0].weeklyUpdate, 'שבוע טוב\nשורה 2', 'line breaks kept');
  const admin = boot({ respond: ok([]) });
  admin.mw({ op: 'meetingSummaries', ...SANDRA, month: '2026-09' });
  assert.deepStrictEqual([admin.calls[0].body.house, admin.calls[0].body.month], ['efroni', '2026-09'], 'an admin reads the house the Managers server named');
  const bad = boot({ respond: ok([]) });
  assert.strictEqual(bad.mw({ op: 'meetingSummaries', ...ORAN, month: 'oct' }).month, '2026-10', 'invalid month → the current month');
});

test('fail-closed: every refusal is a reason, never a list; ONE off-contract meeting / row → bad_contract', () => {
  const cases = [
    [{ props: {} }, 'not_configured'],
    [{ props: { COORDINATORS_SHEETS_URL: 'https://evil.example/exec', COORDINATORS_MANAGERS_SECRET: SECRET } }, 'not_configured'],
    [{ respond: () => new Error('down') }, 'unreachable'],
    [{ respond: () => ({ status: 500, body: 'x' }) }, 'http_error'],
    [{ respond: () => ({ body: '<html>' }) }, 'bad_response'],
    [{ respond: () => ({ body: { ok: false, error: 'not_configured' } }) }, 'coordinators_not_configured'],
    [{ respond: () => ({ body: { ok: false, error: 'unauthorized' } }) }, 'unauthorized'],
    [{ respond: () => ({ body: { ok: false, error: 'unknown action: getMeetingSummariesForManagers' } }) }, 'unknown_action'],
    [{ respond: (b) => ({ body: { ok: true, house: 'efroni', month: b.month, meetings: [] } }) }, 'bad_response'],
    [{ respond: ok([MEET(), { ...MEET({ id: 'meetingB00000001' }), createdBy: 'x' }]) }, 'bad_contract'],
    [{ respond: ok([MEET({ rows: [{ ...ROW(), patientId: 'p1' }] })]) }, 'bad_contract'],
    [{ respond: ok([MEET({ date: '2026-09-30' })]) }, 'bad_contract'],
    [{ respond: ok([MEET({ generalNotes: 'א'.repeat(8001) })]) }, 'bad_contract'],
  ];
  for (const [opts, reason] of cases) {
    const r = boot(opts).mw({ op: 'meetingSummaries', ...ORAN, month: '2026-10' });
    assert.deepStrictEqual([r.ok, r.summaries.available, r.summaries.reason, r.summaries.items], [true, false, reason, undefined], reason);
  }
});

test('cache per house + month (OK and failure); logs carry reason / count only — never text, names or the secret', () => {
  const b = boot({ respond: ok([MEET()]) });
  b.mw({ op: 'meetingSummaries', ...ORAN, month: '2026-10' });
  b.mw({ op: 'meetingSummaries', ...ORAN, month: '2026-10' });
  assert.strictEqual(b.calls.length, 1, 'the second read is a cache hit');
  b.mw({ op: 'meetingSummaries', ...ORAN, month: '2026-09' });
  assert.strictEqual(b.calls.length, 2, 'another month is another key');
  const log = b.logs.join('\n');
  assert.match(log, /\[mw\] meetingsFeed reason=ok status=200 count=1 ms=\d+/);
  assert.doesNotMatch(log, /דנה|סיכום|שבוע טוב|coord-managers-secret/);
});
