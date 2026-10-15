'use strict';

/* «שחרורים צפויים» on the dashboard (Task F) —
 * CHANGELOG-dashboard-expected-discharges.md.
 *   A. the shared rule (lib/discharge-alerts.js) against the fixture that
 *      ezone-managers runs against its own copy;
 *   B. the view model + text-only card;
 *   C. Code.gs action `expectedDischarges` (real Code.gs, vm sandbox);
 *   D. server.js gate (real server, stubbed Apps Script);
 *   E. wiring (index.html, sw.js, app.js). */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const http = require('node:http');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const DA = require('../lib/discharge-alerts.js');
const { richSheet, loadGs } = require('./helpers/gs-sandbox');
const pinHash = require('../lib/pin-hash');
const users = require('../lib/users');
const roleScope = require('../lib/role-scope');
const { createSessionToken } = require('../lib/session');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'discharge-alert-cases.json');
const FIXTURE = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
/* The SAME hash is pinned in ezone-managers test/discharge-alerts-shared.test.js:
 * editing the fixture in one repo only fails that repo's CI. */
const SHARED_FIXTURE_SHA256 = 'ccac89c92f7b4f0c31909ecbb2b5f517c3fe41bf4d27579752a494aafce19522';

/* ===================================================================== */
/* A. the shared rule                                                     */
/* ===================================================================== */

test('A: the shared fixture is byte-identical to the one ezone-managers pins', () => {
  const h = crypto.createHash('sha256').update(fs.readFileSync(FIXTURE_PATH)).digest('hex');
  assert.strictEqual(h, SHARED_FIXTURE_SHA256);
});

test('A: constants — ALERT_LEAD_DAYS = 14, Israel time, one definition', () => {
  assert.strictEqual(DA.ALERT_LEAD_DAYS, FIXTURE.ALERT_LEAD_DAYS);
  assert.strictEqual(DA.TIME_ZONE, FIXTURE.TIME_ZONE);
  assert.strictEqual((read('lib', 'discharge-alerts.js').match(/var ALERT_LEAD_DAYS = 14;/g) || []).length, 1);
});

test('A: boundary days from the shared fixture (14 in, 15 out, 0, 1, -1, -3, year / leap edges, bad dates)', () => {
  for (const c of FIXTURE.alerts) {
    const got = DA.classify(c.date, c.today);
    assert.deepStrictEqual(got && { days: got.days, kind: got.kind, whenText: got.whenText }, c.expect, c.today + ' → ' + c.date);
  }
});

test('A: timezone / midnight from the shared fixture — "today" is the calendar day in Israel', () => {
  for (const c of FIXTURE.israelToday) assert.strictEqual(DA.israelToday(new Date(c.utc)), c.today, c.utc);
  for (const c of FIXTURE.noDateText) assert.strictEqual(DA.noDateText(c.n), c.text);
});

/* ===================================================================== */
/* B. view model + card                                                   */
/* ===================================================================== */

const TODAY = '2026-10-15';
const ED = (date, by, at) => ({ date, editedAt: at || '2026-10-10T09:00:00.000Z', editedBy: by || 'אורן' });
const P = (name, ed) => ({ name, entryDate: '2026-09-01', expectedDischarge: ed || null });
const FEED = () => ({
  ok: true, today: TODAY, expectedDischargeSupported: true,
  houses: [
    { house: 'ramot', label: 'רמות השבים', patients: [
      P('ארבע-עשרה', ED('2026-10-29')), P('חמש-עשרה', ED('2026-10-30')), P('היום', ED('2026-10-15')),
      P('אתמול', ED('2026-10-14', 'סנדרה', '2026-10-01T21:30:00.000Z')), P('ללא 1'), P('ללא 2'),
    ] },
    { house: 'efroni', label: 'קיסריה עפרוני', patients: [P('מחר', ED('2026-10-16', 'חנן')), P('ללא 3')] },
    { house: 'rehab', label: 'שיקום', patients: [P('רחוק', ED('2027-01-01'))] },
  ],
});

test('B: soon (0..14) and overdue lists, sorted by date then name, with house and who-set-it', () => {
  const m = DA.dashboardModel(FEED(), TODAY);
  assert.deepStrictEqual(m.soon.map((a) => [a.name, a.houseLabel, a.days, a.whenText]), [
    ['היום', 'רמות השבים', 0, 'היום'],
    ['מחר', 'קיסריה עפרוני', 1, 'מחר'],
    ['ארבע-עשרה', 'רמות השבים', 14, 'בעוד 14 ימים'],
  ]);
  assert.deepStrictEqual(m.overdue.map((a) => [a.name, a.days, a.kind, a.whenText]), [['אתמול', -1, 'overdue', 'התאריך עבר אתמול']]);
  assert.strictEqual(m.count, 4);
  assert.strictEqual(m.soon[1].setBy, 'נקבע ע״י חנן ב-10/10/26');
  // 21:30Z on 1 Oct is already 2 Oct in Israel (UTC+3).
  assert.strictEqual(m.overdue[0].setBy, 'נקבע ע״י סנדרה ב-2/10/26');
  assert.strictEqual(m.overdue[0].dateText, '14/10/26');
});

test('B: no-date summary — one quiet line per house, only for houses with missing dates', () => {
  const m = DA.dashboardModel(FEED(), TODAY);
  assert.deepStrictEqual(m.noDate, [
    { house: 'ramot', label: 'רמות השבים', count: 2 },
    { house: 'efroni', label: 'קיסריה עפרוני', count: 1 },
  ]);
});

test('B: midnight in Israel flips «מחר» to «היום» whatever the device timezone', () => {
  const feed = FEED();
  const before = DA.dashboardModel(feed, DA.israelToday(new Date('2026-10-15T20:59:00Z')));
  const after = DA.dashboardModel(feed, DA.israelToday(new Date('2026-10-15T21:00:00Z')));
  assert.strictEqual(before.soon.find((a) => a.name === 'מחר').whenText, 'מחר');
  assert.strictEqual(after.soon.find((a) => a.name === 'מחר').whenText, 'היום');
  assert.strictEqual(after.overdue.find((a) => a.name === 'היום').whenText, 'התאריך עבר אתמול');
});

test('B: unsupported / empty / malformed feeds never throw', () => {
  assert.deepStrictEqual(DA.dashboardModel(null, TODAY), { supported: false, soon: [], overdue: [], noDate: [], count: 0 });
  assert.strictEqual(DA.dashboardModel({ expectedDischargeSupported: true, houses: [null, { patients: [null, 5] }] }, TODAY).count, 0);
  assert.strictEqual(DA.setByText({ editedBy: '', editedAt: 'garbage' }), '');
  assert.strictEqual(DA.setByText({ editedBy: 'אורן', editedAt: '' }), 'נקבע ע״י אורן');
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

test('B: the card — title, read-only hint, red «דורש עדכון» list, rows, no-date lines; text-only', () => {
  const doc = fakeDoc();
  const card = doc.createElement('div');
  DA.renderCard(doc, card, DA.dashboardModel(FEED(), TODAY));
  assert.strictEqual(byClass(card, 'xd-title')[0].textContent, 'שחרורים צפויים');
  assert.strictEqual(byClass(card, 'xd-count')[0].textContent, '4');
  assert.match(byClass(card, 'xd-hint')[0].textContent, /באפליקציית המנהלים/);
  const red = byClass(card, 'xd-overdue')[0];
  assert.strictEqual(byClass(red, 'xd-section-title')[0].textContent, 'דורש עדכון (1)');
  assert.match(byClass(red, 'xd-row')[0].className, /is-overdue/);
  assert.strictEqual(byClass(red, 'xd-tag')[0].textContent, 'דורש עדכון');
  const rows = byClass(card, 'xd-row');
  assert.strictEqual(rows.length, 4);
  assert.strictEqual(byClass(rows[1], 'xd-when')[0].textContent, 'שחרור משוער: 15/10/26 · היום');
  assert.strictEqual(byClass(rows[1], 'xd-setby')[0].textContent, 'נקבע ע״י אורן ב-10/10/26');
  assert.deepStrictEqual(byClass(card, 'xd-nodate').map((n) => n.textContent),
    ['רמות השבים: 2 מטופלים ללא תאריך שחרור משוער', 'קיסריה עפרוני: מטופל/ת אחד/ת ללא תאריך שחרור משוער']);
  // Read-only: no input, select, or button at all (nothing to edit here).
  assert.deepStrictEqual(all(card, (n) => /^(INPUT|SELECT|BUTTON|TEXTAREA)$/.test(n.tagName)), []);
});

test('B: a hostile name renders as TEXT (no markup path), and a re-render replaces the content', () => {
  const doc = fakeDoc();
  const card = doc.createElement('div');
  const feed = { expectedDischargeSupported: true, houses: [{ house: 'ramot', label: 'רמות', patients: [P('<img src=x onerror=alert(1)>', ED(TODAY, '<b>x</b>'))] }] };
  DA.renderCard(doc, card, DA.dashboardModel(feed, TODAY));
  DA.renderCard(doc, card, DA.dashboardModel(feed, TODAY));
  assert.strictEqual(byClass(card, 'xd-row').length, 1, 'cleared before redraw');
  assert.strictEqual(byClass(card, 'xd-name')[0].textContent, '<img src=x onerror=alert(1)>');
  assert.strictEqual(byClass(card, 'xd-name')[0].children.length, 0);
});

test('B: loading / error (with a 44px retry button) / empty / unsupported states', () => {
  const doc = fakeDoc();
  const card = doc.createElement('div');
  DA.renderCard(doc, card, null, { state: 'loading' });
  assert.match(card.textContent, /טוען/);
  DA.renderCard(doc, card, null, { state: 'error' });
  const btn = all(card, (n) => n.tagName === 'BUTTON')[0];
  assert.ok(btn && 'data-xd-retry' in btn.attrs && btn.type === 'button');
  DA.renderCard(doc, card, DA.dashboardModel({ expectedDischargeSupported: true, houses: [] }, TODAY));
  assert.match(card.textContent, /אין שחרורים צפויים ב-14 הימים הקרובים/);
  DA.renderCard(doc, card, DA.dashboardModel({ ok: true }, TODAY));
  assert.match(card.textContent, /אחרי עדכון השרת/);
});

/* ===================================================================== */
/* C. Code.gs — action expectedDischarges                                */
/* ===================================================================== */

const PROXY_SECRET = 'proxy-secret-TEST-expected-discharges-0123456789';
const MW_SECRET = 'mw-secret-TEST-expected-discharges';
const arr = (x) => JSON.parse(JSON.stringify(x));

function bootGs({ mode = 'enforce', today = TODAY } = {}) {
  const g = loadGs({ props: { PROXY_SECRET, PROXY_SECRET_MODE: mode, MANAGERS_WORK_SECRET: MW_SECRET } });
  g.sandbox.Session = { getScriptTimeZone: () => 'Asia/Jerusalem' };
  const tzSeen = [];
  g.sandbox.Utilities.formatDate = (d, tz, fmt) => {
    tzSeen.push(tz);
    const x = new Date(d); const p = (n) => (n < 10 ? '0' + n : '' + n);
    if (fmt === 'HH:mm') return `${p(x.getHours())}:${p(x.getMinutes())}`;
    if (fmt === 'yyyy-MM') return `${x.getFullYear()}-${p(x.getMonth() + 1)}`;
    return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
  };
  g.run(`todayISODate_ = function () { return '${today}'; }`);
  g.run(`expectedDischargesToday_ = function () { return '${today}'; }`);
  const cols = Array.from(g.run('PATIENT_COLUMNS'));
  const sh = richSheet('Patients', cols);
  [
    { houseId: 'ramot', name: 'דנה  לוי', date: '2026-09-01', status: 'active', id: 'p1' },
    { houseId: 'ramot', name: 'בלי תאריך', date: '2026-10-01', status: 'active', id: 'p2' },
    { houseId: 'ramot', name: 'עזב', date: '2026-08-01', exitDate: '2026-10-01', status: 'released', id: 'p3' },
    { houseId: 'arfoni', name: 'יוסי כהן', date: '2026-09-10', status: 'active', id: 'p4' },
  ].forEach((r) => sh.grid.push(cols.map((c) => r[c] ?? '')));
  g.sandbox.__sheets.Patients = sh;
  const mw = (body) => arr(g.post({ action: 'managersWork', secret: MW_SECRET, ...body }));
  return { g, mw, tzSeen };
}
const MW_ORAN = { house: 'ramot', role: 'manager', actor: 'אורן', actorId: 'person-oran' };
const MW_SANDRA = { house: 'efroni', role: 'admin', actor: 'סנדרה', actorId: 'person-sandra' };
const gsActor = (id, user, roles, auth) => ({
  proxySecret: PROXY_SECRET, proxyUser: user, user, proxyAuth: auth || 'personal', proxyUserId: id, proxyRoles: roles,
});
const VERED = () => gsActor('vered', 'ורד', ['staff', 'reporter', 'deleter']);
const SHIRAN = () => gsActor('shiran', 'שירן', ['staff', 'reporter']);
const ORTAL = () => gsActor('ortal', 'אורטל', ['controller']);
const read_ = (g, who) => arr(g.post({ action: 'expectedDischarges', ...who }));

test('C: a verified staff session gets every house, in-house patients only, the LATEST row per stay with who/when', () => {
  const { g, mw } = bootGs();
  mw({ op: 'dischargeSet', ...MW_ORAN, patientName: 'דנה לוי', entryDate: '2026-09-01', expectedDate: '2026-10-20', previousDate: '' });
  mw({ op: 'dischargeSet', ...MW_ORAN, patientName: 'דנה לוי', entryDate: '2026-09-01', expectedDate: '2026-10-25', previousDate: '2026-10-20' });
  mw({ op: 'dischargeSet', ...MW_SANDRA, patientName: 'יוסי כהן', entryDate: '2026-09-10', expectedDate: '2026-10-14', previousDate: '' });
  const rowsBefore = g.sandbox.__sheets.ManagersExpectedDischarge.grid.length;
  const r = read_(g, VERED());
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.today, TODAY);
  assert.strictEqual(r.expectedDischargeSupported, true);
  assert.deepStrictEqual(r.houses.map((h) => h.house), ['raanana', 'ramot', 'efroni', 'rehab', 'pardes']);
  assert.ok(!('patients' in r), 'no top-level patients array (the proxy summary log would print one)');
  const ramot = r.houses.find((h) => h.house === 'ramot');
  assert.strictEqual(ramot.label, 'רמות השבים');
  assert.deepStrictEqual(ramot.patients.map((p) => p.name), ['דנה  לוי', 'בלי תאריך'], 'the discharged patient is not listed');
  assert.deepStrictEqual([ramot.patients[0].expectedDischarge.date, ramot.patients[0].expectedDischarge.editedBy], ['2026-10-25', 'אורן'], 'last row wins');
  assert.strictEqual(ramot.patients[1].expectedDischarge, null);
  assert.deepStrictEqual(Object.keys(ramot.patients[0]).sort(), ['entryDate', 'expectedDischarge', 'name'], 'no phone / money / notes');
  const efroni = r.houses.find((h) => h.house === 'efroni');
  assert.deepStrictEqual([efroni.patients[0].name, efroni.patients[0].expectedDischarge.date], ['יוסי כהן', '2026-10-14'], 'efroni ↔ arfoni');
  assert.strictEqual(g.sandbox.__sheets.ManagersExpectedDischarge.grid.length, rowsBefore, 'read-only: nothing appended');
  // The same feed drives the card: Dana soon (10 days), Yossi overdue.
  const m = DA.dashboardModel(r, r.today);
  assert.deepStrictEqual(m.soon.map((a) => [a.name, a.days]), [['דנה  לוי', 10]]);
  assert.deepStrictEqual(m.overdue.map((a) => [a.name, a.days]), [['יוסי כהן', -1]]);
  assert.deepStrictEqual(m.noDate.map((h) => [h.house, h.count]), [['ramot', 1]]);
});

test('C: same source of truth — the Dashboard read equals Managers houseData for the house', () => {
  const { g, mw } = bootGs();
  mw({ op: 'dischargeSet', ...MW_ORAN, patientName: 'דנה לוי', entryDate: '2026-09-01', expectedDate: '2026-11-02', previousDate: '' });
  const hd = mw({ op: 'houseData', ...MW_ORAN });
  const ramot = read_(g, SHIRAN()).houses.find((h) => h.house === 'ramot');
  assert.deepStrictEqual(ramot.patients.map((p) => [p.name, p.entryDate, p.expectedDischarge]),
    hd.patients.map((p) => [p.name, p.entryDate, p.expectedDischarge]));
});

test('C: a read never creates the ManagersExpectedDischarge sheet', () => {
  const { g } = bootGs();
  const r = read_(g, VERED());
  assert.strictEqual(r.ok, true);
  assert.ok(!g.sandbox.__sheets.ManagersExpectedDischarge);
});

test('C: authorization — no / wrong PROXY_SECRET, the controller view, a non-personal or role-less session → refused, nothing read', () => {
  for (const mode of ['enforce', 'log']) {
    const { g } = bootGs({ mode });
    // Fail-closed even in 'log' mode: no verified actor → unauthorized.
    assert.deepStrictEqual(read_(g, {}), { ok: false, error: 'unauthorized' }, mode + ' no secret');
    assert.deepStrictEqual(read_(g, { ...VERED(), proxySecret: 'wrong' }), { ok: false, error: 'unauthorized' }, mode + ' wrong secret');
    assert.strictEqual(read_(g, ORTAL()).error, 'forbidden', mode + ' controller view');
    assert.strictEqual(read_(g, gsActor('', '', [], 'none')).error, 'forbidden', mode + ' meeting-report (no personal session)');
    assert.strictEqual(read_(g, gsActor('vered', 'ורד', ['reporter'])).error, 'forbidden', mode + ' no staff role');
    // Not reachable as a Managers "open" action with the Managers secret either.
    assert.deepStrictEqual(arr(g.post({ action: 'expectedDischarges', secret: MW_SECRET })), { ok: false, error: 'unauthorized' });
  }
  const { g } = bootGs();
  assert.ok(Array.from(g.run('OPEN_ACTIONS')).indexOf('expectedDischarges') < 0, 'not an open action');
  assert.ok(Array.from(g.run('PROXY_KNOWN_ACTIONS')).indexOf('expectedDischarges') >= 0);
});

test('C: "today" is taken in Asia/Jerusalem', () => {
  const g = loadGs({ props: { PROXY_SECRET } });
  const seen = [];
  g.sandbox.Utilities.formatDate = (_d, tz) => { seen.push(tz); return '2026-10-15'; };
  assert.strictEqual(g.run('expectedDischargesToday_()'), '2026-10-15');
  assert.deepStrictEqual(seen, ['Asia/Jerusalem']);
  assert.strictEqual(g.run('EXPECTED_DISCHARGES_TZ'), 'Asia/Jerusalem');
});

test('C: append-only sheet untouched — header pinned, and the action writes / logs no patient name', () => {
  const { g, mw } = bootGs();
  assert.deepStrictEqual(Array.from(g.run('MW_DISCHARGE_COLUMNS')),
    ['id', 'house', 'patientName', 'entryDate', 'expectedDate', 'previousDate', 'editedAt', 'editedBy', 'editedById']);
  mw({ op: 'dischargeSet', ...MW_ORAN, patientName: 'דנה לוי', entryDate: '2026-09-01', expectedDate: '2026-10-20', previousDate: '' });
  const before = JSON.stringify(g.sandbox.__sheets);
  g.logs.length = 0;
  read_(g, VERED());
  assert.strictEqual(JSON.stringify(g.sandbox.__sheets), before, 'no sheet, cell or tab changed');
  assert.ok(!g.logs.some((l) => /דנה|יוסי|בלי תאריך/.test(l)), 'no patient name in logs');
  const src = read('apps-script', 'Code.gs');
  const block = src.slice(src.indexOf('function expectedDischargesRefused_'), src.indexOf('function mwLogAdd_'));
  assert.doesNotMatch(block, /appendRow|setValues|setValue\(|getOrCreateSheet_|insertSheet|LockService|console\.|Logger\./);
});

/* ===================================================================== */
/* D. server.js gate                                                      */
/* ===================================================================== */

test('D: canViewExpectedDischarges — personal staff sessions yes; Ortal, role-less, non-personal no', () => {
  const p = (id, roles, auth) => ({ auth: auth || 'personal', id, user: '', roles });
  assert.strictEqual(roleScope.EXPECTED_DISCHARGES_ACTION, 'expectedDischarges');
  assert.strictEqual(roleScope.canViewExpectedDischarges(p('sandra', ['staff', 'deleter', 'approver', 'viewer'])), true);
  assert.strictEqual(roleScope.canViewExpectedDischarges(p('vered', ['staff'])), true);
  assert.strictEqual(roleScope.canViewExpectedDischarges(p('shiran', ['staff', 'reporter'])), true);
  assert.strictEqual(roleScope.canViewExpectedDischarges(p('ortal', ['controller'])), false);
  assert.strictEqual(roleScope.canViewExpectedDischarges(p('ortal', ['staff'])), false, 'controller id never, whatever the roles');
  assert.strictEqual(roleScope.canViewExpectedDischarges(p('yael', ['reporter'])), false);
  assert.strictEqual(roleScope.canViewExpectedDischarges(p('', ['staff'], 'none')), false);
  assert.strictEqual(roleScope.canViewExpectedDischarges(null), false);
});

const SERVER_PATH = require.resolve('../server');
const SESSION_SECRET = 'session-secret-TEST-expected-discharges-0123456789';
const SHEETS_URL = 'https://script.google.com/macros/s/TEST/exec';
const PEPPER = 'pepper-TEST-expected-discharges-a1b2c3d4e5f60718293a';
const ENV_KEYS = ['PROXY_SECRET', 'SESSION_SECRET', 'SHEETS_URL', 'APP_PIN', 'USER_PIN_HASHES', 'PIN_PEPPER',
  'BOOTSTRAP_TOKEN', 'TRUST_PROXY_HOPS', 'MEETING_REPORT_PIN', 'MEETING_REPORT_SECRET', 'APP_PIN_UNTIL'];
const NAMES = { vered: 'ורד', sandra: 'סנדרה', shiran: 'שירן', yael: 'יעל', ortal: 'אורטל' };
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

test('D: GET /api/sheets?action=expectedDischarges — staff served (secret + principal forwarded), Ortal 403, no session 401; no name in logs', async () => {
  const hash = await pinHash.hashPin('583920', PEPPER);
  const recs = ['vered', 'sandra', 'shiran', 'yael', 'ortal'].map((id) => JSON.parse(users.recordLine(id, hash, 1)));
  const mod = freshServer({ PROXY_SECRET, SESSION_SECRET, SHEETS_URL, PIN_PEPPER: PEPPER, USER_PIN_HASHES: JSON.stringify(recs) });
  const feed = { ok: true, today: TODAY, expectedDischargeSupported: true, houses: [{ house: 'ramot', label: 'רמות', patients: [P('דנה לוי', ED('2026-10-20'))] }] };
  const stub = stubHttps(() => feed);
  const lines = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (...a) => lines.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  const srv = await new Promise((r) => { const s = mod.app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const port = srv.address().port;
    const ok = await get(port, '/api/sheets?action=expectedDischarges', cookie('shiran'));
    assert.strictEqual(ok.status, 200);
    assert.deepStrictEqual(ok.json, feed);
    assert.strictEqual(stub.calls.length, 1);
    const sent = JSON.parse(stub.calls[0].body);
    assert.strictEqual(sent.action, 'expectedDischarges');
    assert.strictEqual(sent.proxySecret, PROXY_SECRET);
    assert.deepStrictEqual([sent.proxyAuth, sent.proxyUserId], ['personal', 'shiran']);
    const no = await get(port, '/api/sheets?action=expectedDischarges', cookie('ortal'));
    assert.strictEqual(no.status, 403);
    const none = await get(port, '/api/sheets?action=expectedDischarges');
    assert.strictEqual(none.status, 401);
    assert.strictEqual(stub.calls.length, 1, 'refusals never reach Apps Script');
  } finally {
    srv.close(); stub.restore(); Object.assign(console, saved);
  }
  assert.ok(!lines.some((l) => l.includes('דנה')), 'no patient name in server logs');
});

test('D: the gate runs on BOTH /api/sheets routes, before the proxy secret is attached', () => {
  const src = read('server.js');
  const routes = src.match(/app\.(get|post)\('\/api\/sheets',[^\n]*/g);
  assert.strictEqual(routes.length, 2);
  routes.forEach((r) => assert.match(r, /requireRoleForAction, requireExpectedDischargesView, requireProxySecret/));
});

/* ===================================================================== */
/* E. wiring                                                              */
/* ===================================================================== */

test('E: served like the other lib rules, loaded before app.js, hashed by the SW; SW v65 or later', () => {
  const server = read('server.js'); const index = read('public', 'index.html'); const sw = read('public', 'sw.js');
  assert.match(server, /'\/discharge-alerts\.js': \{ file: path\.join\(__dirname, 'lib', 'discharge-alerts\.js'\)/);
  assert.match(server, /app\.get\('\/discharge-alerts\.js', sendLibAsset\('\/discharge-alerts\.js'\)\);/);
  assert.ok(index.indexOf('discharge-alerts.js?v=__BUILD__') > 0);
  assert.ok(index.indexOf('discharge-alerts.js?v=__BUILD__') < index.indexOf('app.js?v=__BUILD__'));
  assert.match(index, /<div class="card xd-card" id="expected-discharges"/);
  assert.doesNotMatch(index.match(/<div class="card xd-card"[^>]*>/)[0], /data-finance/, 'not a money widget');
  assert.match(sw, /var BUNDLE_PATHS = \[[^\]]*'\/discharge-alerts\.js'[^\]]*\]/);
  assert.ok(Number(sw.match(/var CACHE_VERSION = 'v(\d+)';/)[1]) >= 65);
});

test('E: app.js — one cached GET, rendered via DischargeAlerts only, no innerHTML / no logging in the block', () => {
  const app = read('public', 'app.js');
  const block = app.slice(app.indexOf('const EXPECTED_DISCHARGES_TTL_MS'), app.indexOf('/* Dashboard renewal alert'));
  assert.ok(block.length > 200);
  assert.match(block, /apiGet\(\{ action: 'expectedDischarges' \}\)/);
  assert.match(block, /DA\.renderCard\(document, card, DA\.dashboardModel\(expectedDischarges\.data, DA\.israelToday\(\)\)\)/);
  assert.match(block, /EXPECTED_DISCHARGES_TTL_MS = 60 \* 1000/);
  assert.doesNotMatch(block, /innerHTML|insertAdjacentHTML|console\./);
  assert.doesNotMatch(block, /\b14\b/, 'the window lives in lib/discharge-alerts.js only');
  assert.match(app, /fitAllStatText\(\);[^\n]*\n  renderExpectedDischarges\(\);/);
  // Read-only: the Dashboard never calls the write op.
  assert.doesNotMatch(app, /dischargeSet/);
});

test('E: lib/discharge-alerts.js — no I/O, no innerHTML, no logging', () => {
  const src = read('lib', 'discharge-alerts.js');
  assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\//g, ''), /fetch\(|require\(|innerHTML|insertAdjacentHTML|console\.|XMLHttpRequest/);
});

test('E: CSS — 16px text and 44px targets for the card', () => {
  const css = read('public', 'style.css');
  const block = css.slice(css.indexOf('.xd-card {'));
  assert.match(block, /\.xd-card \{[^}]*font-size: 16px/);
  assert.match(block, /\.xd-row \{[^}]*min-height: 44px/);
  assert.match(block, /\.xd-retry \{[^}]*min-height: 44px/);
  assert.doesNotMatch(block, /font-size: 1[0-5](\.\d+)?px/, 'nothing under 16px');
});
