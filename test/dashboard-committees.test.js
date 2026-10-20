'use strict';

/* «ועדות קרובות» on the dashboard (PR 3) — CHANGELOG-dashboard-committees.md.
 *   A. the shared rule (lib/committee-alerts.js) against the fixture that
 *      ezone-managers runs against its own copy (sha256 pinned on both sides);
 *   B. the view model + text-only card (today first, empty / error states);
 *   C. Code.gs action `upcomingCommittees` (real Code.gs, vm sandbox);
 *   D. server.js gate (real server, stubbed Apps Script);
 *   E. wiring (index.html, sw.js, app.js, Ortal's «בקרת גבייה»). */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const http = require('node:http');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const CA = require('../lib/committee-alerts.js');
const { richSheet, loadGs } = require('./helpers/gs-sandbox');
const pinHash = require('../lib/pin-hash');
const users = require('../lib/users');
const roleScope = require('../lib/role-scope');
const { createSessionToken } = require('../lib/session');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'committee-alert-cases.json');
const FIXTURE = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
/* The SAME hash is pinned in ezone-managers test/committee.test.js. */
const SHARED_FIXTURE_SHA256 = '6cd48c587dcf3cd497286c0cad284fa179a9d65e3e13fb5af9061fec0e328f46';
const TODAY = '2026-10-15';

/* ===================================================================== */
/* A. the shared rule                                                     */
/* ===================================================================== */

test('A: the shared fixture is byte-identical to the one ezone-managers pins; one constant', () => {
  assert.strictEqual(crypto.createHash('sha256').update(fs.readFileSync(FIXTURE_PATH)).digest('hex'), SHARED_FIXTURE_SHA256);
  assert.strictEqual(CA.COMMITTEE_LEAD_DAYS, FIXTURE.COMMITTEE_LEAD_DAYS);
  assert.strictEqual(CA.TIME_ZONE, FIXTURE.TIME_ZONE);
  assert.strictEqual((read('lib', 'committee-alerts.js').match(/var COMMITTEE_LEAD_DAYS = 7;/g) || []).length, 1);
});

test('A: boundaries from the shared fixture (today, +1, +7 in; +8, -1 out; year / leap; bad dates)', () => {
  for (const c of FIXTURE.alerts) {
    const got = CA.classify(c.date, c.today);
    assert.deepStrictEqual(got && { days: got.days, kind: got.kind, whenText: got.whenText }, c.expect, c.today + ' → ' + c.date);
  }
});

test('A: timezone / midnight from the shared fixture — "today" is the calendar day in Israel', () => {
  for (const c of FIXTURE.israelToday) assert.strictEqual(CA.israelToday(new Date(c.utc)), c.today, c.utc);
});

/* ===================================================================== */
/* B. view model + card                                                   */
/* ===================================================================== */

const CM = (date, label, by, at) => ({ date, label: label || '', editedAt: at || '2026-10-10T09:00:00.000Z', editedBy: by || 'אורן' });
const P = (name, c) => ({ name, entryDate: '2026-09-01', committee: c || null });
const FEED = () => ({
  ok: true, today: TODAY, committeeSupported: true, leadDays: 7,
  houses: [
    { house: 'ramot', label: 'רמות השבים', patients: [P('שבע', CM('2026-10-22', 'ועדת השמה')), P('היום', CM('2026-10-15')), P('שמונה', CM('2026-10-23')), P('אתמול', CM('2026-10-14'))] },
    { house: 'efroni', label: 'קיסריה עפרוני', patients: [P('מחר', CM('2026-10-16', 'המשך טיפול', 'חנן', '2026-10-01T21:30:00.000Z'))] },
  ],
});

test('B: «היום» first, then the next 7 days; +8 and past never shown; sorted by date, with house, label, who-set-it', () => {
  const m = CA.dashboardModel(FEED(), TODAY);
  assert.deepStrictEqual(m.today.map((a) => [a.name, a.houseLabel, a.whenText]), [['היום', 'רמות השבים', 'היום']]);
  assert.deepStrictEqual(m.week.map((a) => [a.name, a.houseLabel, a.days, a.whenText, a.label]), [
    ['מחר', 'קיסריה עפרוני', 1, 'מחר', 'המשך טיפול'],
    ['שבע', 'רמות השבים', 7, 'בעוד 7 ימים', 'ועדת השמה'],
  ]);
  assert.strictEqual(m.count, 3);
  // 21:30Z on 1 Oct is already 2 Oct in Israel (UTC+3).
  assert.strictEqual(m.week[0].setBy, 'נקבע ע״י חנן ב-2/10/26');
  assert.strictEqual(m.today[0].setBy, 'נקבע ע״י אורן ב-10/10/26');
});

test('B: Israel midnight flips «מחר» to «היום» whatever the device timezone', () => {
  const before = CA.dashboardModel(FEED(), CA.israelToday(new Date('2026-10-15T20:59:00Z')));
  const after = CA.dashboardModel(FEED(), CA.israelToday(new Date('2026-10-15T21:00:00Z')));
  assert.strictEqual(before.week.find((a) => a.name === 'מחר').whenText, 'מחר');
  assert.strictEqual(after.today.find((a) => a.name === 'מחר').whenText, 'היום');
  assert.strictEqual(after.today.find((a) => a.name === 'היום'), undefined, 'yesterday is gone');
  assert.strictEqual(after.week.find((a) => a.name === 'שמונה').days, 7, '+8 enters at +7');
});

test('B: unsupported / empty / malformed feeds never throw', () => {
  assert.deepStrictEqual(CA.dashboardModel(null, TODAY), { supported: false, today: [], week: [], count: 0 });
  assert.strictEqual(CA.dashboardModel({ committeeSupported: true, houses: [null, { patients: [null, 5, { name: 'x', committee: 'bad' }] }] }, TODAY).count, 0);
  assert.strictEqual(CA.setByText({ editedBy: '', editedAt: 'garbage' }), '');
});

/* A minimal DOM: textContent only; innerHTML THROWS (text-only rendering). */
function fakeDoc() {
  function el(tag) {
    const e = {
      tagName: tag.toUpperCase(), children: [], attrs: {}, className: '', type: '', _text: '',
      get firstChild() { return this.children[0] || null; },
      appendChild(c) { this.children.push(c); return c; },
      removeChild(c) { this.children.splice(this.children.indexOf(c), 1); return c; },
      setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    };
    Object.defineProperty(e, 'textContent', {
      get() { return this._text + this.children.map((c) => c.textContent).join(' '); },
      set(v) { this._text = String(v); this.children = []; },
    });
    Object.defineProperty(e, 'innerHTML', { set() { throw new Error('innerHTML used'); }, get() { throw new Error('innerHTML used'); } });
    return e;
  }
  return { createElement: el };
}
const all = (n, pred, out = []) => { if (pred(n)) out.push(n); n.children.forEach((c) => all(c, pred, out)); return out; };
const byClass = (n, cls) => all(n, (x) => (' ' + x.className + ' ').includes(' ' + cls + ' '));

test('B: the card — title, count, read-only hint, «היום» section first, rows; no controls; text-only', () => {
  const doc = fakeDoc();
  const card = doc.createElement('div');
  CA.renderCard(doc, card, CA.dashboardModel(FEED(), TODAY));
  assert.strictEqual(byClass(card, 'cmt-title')[0].textContent, 'ועדות קרובות');
  assert.strictEqual(byClass(card, 'cmt-count')[0].textContent, '3');
  assert.match(byClass(card, 'cmt-hint')[0].textContent, /לקריאה בלבד/);
  const sections = byClass(card, 'cmt-section');
  assert.match(sections[0].className, /cmt-today/, '«היום» first');
  assert.strictEqual(byClass(sections[0], 'cmt-section-title')[0].textContent, 'היום (1)');
  assert.strictEqual(byClass(sections[1], 'cmt-section-title')[0].textContent, '7 הימים הקרובים (2)');
  const rows = byClass(card, 'cmt-row');
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(byClass(rows[0], 'cmt-tag')[0].textContent, 'ועדה היום');
  assert.strictEqual(byClass(rows[2], 'cmt-when')[0].textContent, 'ועדה: 22/10/26 · ועדת השמה · בעוד 7 ימים');
  assert.strictEqual(byClass(rows[2], 'cmt-house')[0].textContent, 'רמות השבים');
  assert.strictEqual(byClass(rows[2], 'cmt-setby')[0].textContent, 'נקבע ע״י אורן ב-10/10/26');
  assert.deepStrictEqual(all(card, (n) => /^(INPUT|SELECT|BUTTON|TEXTAREA)$/.test(n.tagName)), [], 'read-only');
});

test('B: a hostile name / label renders as TEXT; a re-render replaces the content', () => {
  const doc = fakeDoc();
  const card = doc.createElement('div');
  const feed = { committeeSupported: true, houses: [{ house: 'ramot', label: 'רמות', patients: [P('<img src=x onerror=alert(1)>', CM(TODAY, '<script>x</script>', '<b>x</b>'))] }] };
  CA.renderCard(doc, card, CA.dashboardModel(feed, TODAY));
  CA.renderCard(doc, card, CA.dashboardModel(feed, TODAY));
  assert.strictEqual(byClass(card, 'cmt-row').length, 1, 'cleared before redraw');
  assert.strictEqual(byClass(card, 'cmt-name')[0].textContent, '<img src=x onerror=alert(1)>');
  assert.strictEqual(byClass(card, 'cmt-name')[0].children.length, 0);
  assert.match(byClass(card, 'cmt-when')[0].textContent, /<script>x<\/script>/);
});

test('B: loading / error (44px retry) / empty / unsupported states are always visible', () => {
  const doc = fakeDoc();
  const card = doc.createElement('div');
  CA.renderCard(doc, card, null, { state: 'loading' });
  assert.match(card.textContent, /טוען ועדות/);
  CA.renderCard(doc, card, null, { state: 'error' });
  assert.match(card.textContent, /לא ניתן לטעון את הוועדות הקרובות כרגע/);
  const btn = all(card, (n) => n.tagName === 'BUTTON')[0];
  assert.ok(btn && 'data-cmt-retry' in btn.attrs && btn.type === 'button');
  CA.renderCard(doc, card, CA.dashboardModel({ committeeSupported: true, houses: [] }, TODAY));
  assert.match(card.textContent, /אין ועדות היום וב-7 הימים הקרובים/);
  assert.strictEqual(byClass(card, 'cmt-count')[0].textContent, '0');
  CA.renderCard(doc, card, CA.dashboardModel({ ok: true }, TODAY));
  assert.match(card.textContent, /אחרי עדכון השרת/);
});

/* ===================================================================== */
/* C. Code.gs — action upcomingCommittees                                 */
/* ===================================================================== */

const PROXY_SECRET = 'proxy-secret-TEST-committees-0123456789abcdef';
const MW_SECRET = 'mw-secret-TEST-committees';
const arr = (x) => JSON.parse(JSON.stringify(x));

function bootGs({ mode = 'enforce', today = TODAY } = {}) {
  const g = loadGs({ props: { PROXY_SECRET, PROXY_SECRET_MODE: mode, MANAGERS_WORK_SECRET: MW_SECRET } });
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
    { houseId: 'ramot', name: 'דנה לוי', date: '2026-09-01', status: 'active', id: 'p1' },
    { houseId: 'ramot', name: 'רחוק', date: '2026-10-01', status: 'active', id: 'p2' },
    { houseId: 'ramot', name: 'עזב', date: '2026-08-01', exitDate: '2026-10-14', status: 'released', id: 'p3' },
    { houseId: 'arfoni', name: 'יוסי כהן', date: '2026-09-10', status: 'active', id: 'p4' },
  ].forEach((r) => sh.grid.push(cols.map((c) => r[c] ?? '')));
  g.sandbox.__sheets.Patients = sh;
  const mw = (body) => arr(g.post({ action: 'managersWork', secret: MW_SECRET, ...body }));
  return { g, mw };
}
const MW_ORAN = { house: 'ramot', role: 'manager', actor: 'אורן', actorId: 'person-oran' };
const MW_SANDRA = { house: 'efroni', role: 'admin', actor: 'סנדרה', actorId: 'person-sandra' };
const gsActor = (id, user, roles, auth) => ({
  proxySecret: PROXY_SECRET, proxyUser: user, user, proxyAuth: auth || 'personal', proxyUserId: id, proxyRoles: roles,
});
const VERED = () => gsActor('vered', 'ורד', ['staff', 'reporter', 'deleter']);
const ORTAL = () => gsActor('ortal', 'אורטל', ['controller']);
const read_ = (g, who) => arr(g.post({ action: 'upcomingCommittees', ...who }));
const cmSet = (mw, who, body) => mw({ op: 'committeeSet', previousDate: '', previousLabel: '', ...who, ...body });

/* Since 20 Oct 2026 the coordinators set committees; upcomingCommittees reads
 * their feed (CHANGELOG-committees-from-coordinators.md). Stubbed UrlFetchApp. */
const COORD_URL = 'https://script.google.com/macros/s/COORD-TEST/exec';
const COORD_SECRET = 'coord-managers-secret-TEST-0123456789';
const FE = (o) => ({ id: 'c-' + Math.random().toString(36).slice(2, 10), house: 'ramot', date: TODAY, time: '', type: 'ועדת השמה', participants: '', patientName: '', updatedAt: '2026-10-10T09:00:00.000Z', ...o });
function withFeed(g, committees, extra) {
  g.sandbox.__props.COORDINATORS_SHEETS_URL = COORD_URL;
  g.sandbox.__props.COORDINATORS_MANAGERS_SECRET = COORD_SECRET;
  const calls = [];
  g.sandbox.UrlFetchApp = { fetch: (url, opts) => {
    calls.push({ url, opts });
    const body = extra && extra.body ? extra.body : { ok: true, today: TODAY, committees };
    return { getResponseCode: () => (extra && extra.status) || 200, getContentText: () => JSON.stringify(body) };
  } };
  return calls;
}

test('C: from the coordinators feed — every house; only today..+7; name = patient or type; label = type · time · participants', () => {
  const { g } = bootGs();
  const calls = withFeed(g, [
    FE({ house: 'ramot', date: '2026-10-22', time: '10:30', type: 'ועדת השמה', participants: 'אורן, ד"ר כהן', patientName: 'דנה לוי' }),
    FE({ house: 'ramot', date: '2026-10-23', patientName: 'רחוק' }),
    FE({ house: 'efroni', date: TODAY, type: 'ועדת המשך', patientName: '' }),
    FE({ house: 'ramot', date: '2026-10-14', patientName: 'אתמול' }),
  ]);
  const r = read_(g, VERED());
  assert.deepStrictEqual([r.ok, r.today, r.committeeSupported, r.leadDays, r.available], [true, TODAY, true, 7, true]);
  assert.deepStrictEqual(r.houses.map((h) => h.house), ['raanana', 'ramot', 'efroni', 'rehab', 'pardes']);
  const ramot = r.houses.find((h) => h.house === 'ramot');
  assert.strictEqual(ramot.label, 'רמות השבים');
  assert.deepStrictEqual(ramot.patients, [{ name: 'דנה לוי', committee: { date: '2026-10-22', label: 'ועדת השמה · 10:30 · אורן, ד"ר כהן', editedAt: '2026-10-10T09:00:00.000Z', editedBy: '' } }], '+8 and yesterday are not sent');
  assert.deepStrictEqual(r.houses.find((h) => h.house === 'efroni').patients.map((p) => p.name), ['ועדת המשך'], 'no patient → the type');
  assert.ok(!g.sandbox.__sheets.ManagersCommittee, 'never touches the old sheet');
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(JSON.parse(calls[0].opts.payload), { action: 'getCommitteesForManagers', secret: COORD_SECRET });
  const m = CA.dashboardModel(r, r.today);
  assert.deepStrictEqual([m.today.map((a) => a.name), m.week.map((a) => a.name)], [['ועדת המשך'], ['דנה לוי']]);
  assert.strictEqual(m.week[0].setBy, 'נקבע ב-10/10/26');
});

test('C: feed down → available:false + reason and NO houses (the card says «לא זמין», never an empty-looking list)', () => {
  const { g } = bootGs();
  const r = read_(g, VERED());
  assert.deepStrictEqual([r.ok, r.committeeSupported, r.available, r.reason, r.houses], [true, true, false, 'not_configured', []]);
  const m = CA.dashboardModel(r, r.today);
  assert.deepStrictEqual([m.supported, m.available, m.reason, m.count], [true, false, 'not_configured', 0]);
  const doc = fakeDoc();
  const card = doc.createElement('div');
  CA.renderCard(doc, card, m);
  assert.match(card.textContent, /הוועדות לא זמינות כרגע — הנתון מאפליקציית הרכזים לא התקבל/);
  assert.doesNotMatch(card.textContent, /אין ועדות/, 'never "no committees" when the data did not arrive');
  assert.match(byClass(card, 'cmt-hint')[0].textContent, /נקבעות באפליקציית הרכזים/);
});

test('C: authorization — every logged-in user (Ortal included); no / wrong secret or a non-personal session → refused, both modes', () => {
  for (const mode of ['enforce', 'log']) {
    const { g } = bootGs({ mode });
    for (const who of [VERED(), ORTAL(), gsActor('yael', 'יעל', [])]) assert.strictEqual(read_(g, who).ok, true, mode);
    assert.deepStrictEqual(read_(g, {}), { ok: false, error: 'unauthorized' }, mode);
    assert.deepStrictEqual(read_(g, { ...VERED(), proxySecret: 'wrong' }), { ok: false, error: 'unauthorized' }, mode);
    assert.strictEqual(read_(g, gsActor('', '', [], 'none')).error, 'forbidden', mode);
    assert.deepStrictEqual(arr(g.post({ action: 'upcomingCommittees', secret: MW_SECRET })), { ok: false, error: 'unauthorized' });
  }
  const { g } = bootGs();
  assert.ok(Array.from(g.run('OPEN_ACTIONS')).indexOf('upcomingCommittees') < 0, 'not an open action');
  assert.ok(Array.from(g.run('PROXY_KNOWN_ACTIONS')).indexOf('upcomingCommittees') >= 0);
  assert.ok(Array.from(g.run('CONTROLLER_ACTIONS')).indexOf('upcomingCommittees') >= 0);
  const scope = require('../lib/finance-scope');
  assert.deepStrictEqual(Array.from(g.run('CONTROLLER_ACTIONS')), [...scope.CONTROLLER_ACTIONS], 'server and Code.gs agree');
  assert.ok(!scope.FINANCE_ACTIONS.includes('upcomingCommittees'), 'not a billing action');
});

test('C: the action block never writes or logs', () => {
  const src = read('apps-script', 'Code.gs');
  const block = src.slice(src.indexOf('function upcomingCommitteesForDashboard_'), src.indexOf('function mwLogAdd_'));
  assert.ok(block.length > 200);
  assert.doesNotMatch(block, /appendRow|setValues|setValue\(|getOrCreateSheet_|insertSheet|LockService|console\.|Logger\./);
});

/* ===================================================================== */
/* D. server.js gate                                                      */
/* ===================================================================== */

const SERVER_PATH = require.resolve('../server');
const SESSION_SECRET = 'session-secret-TEST-committees-0123456789abcdef';
const SHEETS_URL = 'https://script.google.com/macros/s/TEST/exec';
const PEPPER = 'pepper-TEST-committees-a1b2c3d4e5f60718293a4b5c';
const ENV_KEYS = ['PROXY_SECRET', 'SESSION_SECRET', 'SHEETS_URL', 'APP_PIN', 'USER_PIN_HASHES', 'PIN_PEPPER',
  'BOOTSTRAP_TOKEN', 'TRUST_PROXY_HOPS', 'MEETING_REPORT_PIN', 'MEETING_REPORT_SECRET', 'APP_PIN_UNTIL'];
const NAMES = { vered: 'ורד', yael: 'יעל', ortal: 'אורטל' };
const cookie = (id) => 'ezone_session=' + createSessionToken(SESSION_SECRET, undefined, undefined, NAMES[id], { id, pinVersion: 1 });

function freshServer(env) {
  const saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  const orig = { error: console.error, warn: console.warn, log: console.log };
  console.error = console.warn = console.log = () => {};
  delete require.cache[SERVER_PATH];
  try { return require('../server'); } finally {
    Object.assign(console, orig);
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}
function stubHttps(respond) {
  const calls = [];
  const original = https.request;
  https.request = (url, opts, cb) => {
    const req = new EventEmitter();
    let body = '';
    req.write = (c) => { body += c; };
    req.end = () => {
      calls.push({ url: String(url), body });
      const r = respond(body);
      const res = new EventEmitter();
      res.statusCode = 200; res.headers = {}; res.setEncoding = () => {}; res.resume = () => {};
      setImmediate(() => { cb(res); res.emit('data', JSON.stringify(r)); res.emit('end'); });
    };
    return req;
  };
  return { calls, restore: () => { https.request = original; } };
}
function get(port, urlPath, ck) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: urlPath, headers: ck ? { Cookie: ck } : {} }, (res) => {
      let buf = ''; res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(buf); } catch (_) { return null; } })() }));
    });
    req.on('error', reject); req.end();
  });
}

test('D: the same all-users rule as «שחרורים צפויים»', () => {
  assert.strictEqual(roleScope.UPCOMING_COMMITTEES_ACTION, 'upcomingCommittees');
  assert.deepStrictEqual([...roleScope.ALL_USERS_READ_ACTIONS], ['expectedDischarges', 'upcomingCommittees']);
  assert.ok(Object.isFrozen(roleScope.ALL_USERS_READ_ACTIONS));
});

test('D: GET /api/sheets?action=upcomingCommittees — every logged-in user (Ortal too), no / bad session 401; no name in logs', async () => {
  const hash = await pinHash.hashPin('583920', PEPPER);
  const recs = ['vered', 'yael', 'ortal'].map((id) => JSON.parse(users.recordLine(id, hash, 1)));
  const mod = freshServer({ PROXY_SECRET, SESSION_SECRET, SHEETS_URL, PIN_PEPPER: PEPPER, USER_PIN_HASHES: JSON.stringify(recs) });
  const feed = { ok: true, today: TODAY, committeeSupported: true, houses: [{ house: 'ramot', label: 'רמות', patients: [P('דנה לוי', CM('2026-10-20'))] }] };
  const stub = stubHttps(() => feed);
  const lines = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (...a) => lines.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  const srv = await new Promise((r) => { const s = mod.app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const port = srv.address().port;
    for (const id of ['vered', 'yael', 'ortal']) {
      const ok = await get(port, '/api/sheets?action=upcomingCommittees', cookie(id));
      assert.strictEqual(ok.status, 200, id);
      assert.deepStrictEqual(ok.json, feed, id);
    }
    stub.calls.forEach((c) => {
      const sent = JSON.parse(c.body);
      assert.deepStrictEqual([sent.action, sent.proxySecret, sent.proxyAuth], ['upcomingCommittees', PROXY_SECRET, 'personal']);
    });
    const before = stub.calls.length;
    assert.strictEqual((await get(port, '/api/sheets?action=upcomingCommittees')).status, 401);
    assert.strictEqual((await get(port, '/api/sheets?action=upcomingCommittees', 'ezone_session=forged.token')).status, 401);
    assert.strictEqual(stub.calls.length, before, 'refusals never reach Apps Script');
  } finally {
    srv.close(); stub.restore(); Object.assign(console, saved);
  }
  assert.ok(!lines.some((l) => l.includes('דנה')), 'no patient name in server logs');
});

/* ===================================================================== */
/* E. wiring                                                              */
/* ===================================================================== */

test('E: served like the other lib rules, loaded before app.js, hashed by the SW; SW v70+', () => {
  const server = read('server.js'); const index = read('public', 'index.html'); const sw = read('public', 'sw.js');
  assert.match(server, /'\/committee-alerts\.js': \{ file: path\.join\(__dirname, 'lib', 'committee-alerts\.js'\)/);
  assert.match(server, /app\.get\('\/committee-alerts\.js', sendLibAsset\('\/committee-alerts\.js'\)\);/);
  assert.ok(index.indexOf('committee-alerts.js?v=__BUILD__') > 0 && index.indexOf('committee-alerts.js?v=__BUILD__') < index.indexOf('app.js?v=__BUILD__'));
  const div = index.match(/<div class="card cmt-card" id="upcoming-committees"[^>]*>/);
  assert.ok(div, 'the card is on «דשבורד»');
  assert.doesNotMatch(div[0], /data-finance|data-billing-control|edit-only/, 'no view removes it');
  assert.match(sw, /var BUNDLE_PATHS = \[[^\]]*'\/committee-alerts\.js'[^\]]*\]/);
  assert.ok(Number(sw.match(/var CACHE_VERSION = 'v(\d+)';/)[1]) >= 70);
});

test('E: app.js — one cached GET, CommitteeAlerts only, no innerHTML / logging / write op; every view paints it', () => {
  const app = read('public', 'app.js');
  const block = app.slice(app.indexOf('const UPCOMING_COMMITTEES_TTL_MS'), app.indexOf('function renderUpcomingCommittees'));
  assert.ok(block.length > 200);
  assert.match(block, /apiGet\(\{ action: 'upcomingCommittees' \}\)/);
  assert.match(block, /CA\.renderCard\(document, card, CA\.dashboardModel\(upcomingCommittees\.data, CA\.israelToday\(\)\)\)/);
  assert.doesNotMatch(block, /innerHTML|insertAdjacentHTML|console\.|\b7\b/);
  assert.doesNotMatch(app, /committeeSet/, 'read-only: never the write op');
  const ra = app.slice(app.indexOf('function renderAll()'), app.indexOf('renderDashboard();', app.indexOf('function renderAll()')));
  assert.match(ra, /renderUpcomingCommittees\(\);/, 'the controller view paints it');
  assert.match(app, /renderExpectedDischarges\(\);\n  renderUpcomingCommittees\(\);/, 'the dashboard paints it');
});

test('E: Ortal\'s «בקרת גבייה» — the card is moved right after «שחרורים צפויים», moved not copied', () => {
  const app = read('public', 'app.js');
  const start = app.indexOf('function moveExpectedDischargesToControllerScreen');
  const fnSrc = app.slice(start, app.indexOf('\nfunction renderExpectedDischarges', start));
  const node = (id, cls) => ({ id, className: cls || '', children: [], parentNode: null,
    insertBefore(n, ref) {
      if (n.parentNode) n.parentNode.children.splice(n.parentNode.children.indexOf(n), 1);
      const i = ref ? this.children.indexOf(ref) : -1;
      if (i < 0) this.children.push(n); else this.children.splice(i, 0, n);
      n.parentNode = this; return n;
    },
    get nextSibling() { const p = this.parentNode; return p ? p.children[p.children.indexOf(this) + 1] || null : null; },
    querySelector(sel) { return sel === '.screen-head' ? this.children.find((c) => c.className === 'screen-head') || null : null; },
  });
  const dash = node('screen-dashboard'); const bc = node('screen-billing-control');
  const xd = node('expected-discharges'); const cmt = node('upcoming-committees');
  dash.insertBefore(xd, null); dash.insertBefore(cmt, null);
  bc.insertBefore(node('', 'screen-head'), null); bc.insertBefore(node('bc-error'), null);
  const doc = { getElementById: (id) => ({ 'expected-discharges': xd, 'upcoming-committees': cmt, 'screen-billing-control': bc })[id] || null };
  const move = new Function('document', 'BILLING_CONTROL_SCREEN', fnSrc + '\nreturn moveExpectedDischargesToControllerScreen;')(doc, 'billing-control');
  move(); move();
  assert.deepStrictEqual(bc.children.map((c) => c.id || c.className), ['screen-head', 'expected-discharges', 'upcoming-committees', 'bc-error']);
  assert.deepStrictEqual(dash.children, []);
});

test('E: lib/committee-alerts.js — no I/O, no innerHTML, no logging; CSS 16px / 44px', () => {
  const src = read('lib', 'committee-alerts.js');
  assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\//g, ''), /fetch\(|require\(|innerHTML|insertAdjacentHTML|console\.|XMLHttpRequest/);
  const css = read('public', 'style.css');
  const block = css.slice(css.indexOf('.cmt-card {'));
  assert.match(block, /\.cmt-card \{[^}]*font-size: 16px/);
  assert.match(block, /\.cmt-row \{[^}]*min-height: 44px/);
  assert.match(block, /\.cmt-retry \{[^}]*min-height: 44px/);
  assert.doesNotMatch(block, /font-size: 1[0-5](\.\d+)?px/);
});
