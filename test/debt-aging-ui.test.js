/* «חובות פתוחים» — the debt-aging screen on the גבייה tab and its .xlsx export.
 * See CHANGELOG-debt-aging-ui.md.
 *
 * Locked contracts:
 *   - no new math: with no filter, the house × bucket tables equal the
 *     server's own totals / byHouse (the REAL Code.gs debtAging_ is run here);
 *   - «חוב רשום» and «מחזורים ללא רישום» are NEVER added together — not in
 *     the view object, not in the DOM, not in any xlsx cell;
 *   - the bucket tables' row and column totals are consistent;
 *   - the house and patient-status filters;
 *   - the drill-down: house → patients → cycles;
 *   - the separate lists (detached, after exit, discharged without exit,
 *     zero-amount) are never part of the debt figures;
 *   - the caveats show only when relevant;
 *   - everything is escaped; loading and error states are explicit; the fetch
 *     happens only when the section is opened or the as-of date changes;
 *   - GET /api/export/debt-aging.xlsx: 401 without a session, 400 on a bad
 *     asOf / house / status, the as-of filename, no-store, six RTL sheets;
 *   - the service worker never caches the export; CACHE_VERSION is v24;
 *   - the browser copy (app.js) and the server copy (lib/debt-aging-xlsx.js)
 *     of the view and its labels never drift.
 *
 * vm sandbox on the REAL shipped Code.gs / app.js, per repo convention.
 * SESSION_SECRET is set before server.js is required; PROXY_SECRET is left
 * unset so the real app never reaches the network. */

process.env.TZ = 'Asia/Jerusalem';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const express = require('express');
const ExcelJS = require('exceljs');

const SECRET = 'test-session-secret-debt-aging-0123456789abcdef0123';
process.env.SESSION_SECRET = SECRET;
// PR C: every session is personal — a real USER_PIN_HASHES record per user.
const { applyPersonalEnv, personalToken } = require('./helpers/personal-session');
applyPersonalEnv();
const ID_BY_NAME = { 'ורד': 'vered', 'סנדרה': 'sandra', 'שירן': 'shiran', 'יעל': 'yael' };
delete process.env.PROXY_SECRET;

const report = require('../lib/xlsx-report');
const debtXlsx = require('../lib/debt-aging-xlsx');
const server = require('../server');

const ROOT = path.join(__dirname, '..');
const GS_SRC = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const SW_SRC = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');
const HTML_SRC = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const plain = (v) => JSON.parse(JSON.stringify(v));
const NOW_ISO = '2026-09-30T09:00:00.000Z';   // 12:00 in Israel
const TODAY = '2026-09-30';
const BUCKETS = ['d0_7', 'd8_30', 'd31_60', 'd61_plus'];

/* ======================= the real Code.gs ======================= */

function formatDate(d, tz, fmt) {
  const parts = {};
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(d).forEach((p) => { parts[p.type] = p.value; });
  return fmt.replace('yyyy', parts.year).replace('MM', parts.month).replace('dd', parts.day)
    .replace('HH', parts.hour).replace('mm', parts.minute);
}
function frozenDate(iso) {
  const fixed = new Date(iso).getTime();
  return class FrozenDate extends Date {
    constructor(...a) { if (a.length === 0) super(fixed); else super(...a); }
    static now() { return fixed; }
  };
}
function loadGs() {
  const sandbox = {
    console: { log() {}, warn() {}, error() {}, info() {} },
    JSON, Math, Date: frozenDate(NOW_ISO), Number, String, Array, Object, RegExp, isFinite, isNaN,
    Logger: { log() {} },
    Utilities: { formatDate },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(GS_SRC, sandbox);
  return sandbox;
}

/* ---------- the synthetic world (synthetic names) ---------- */
const AVI = 'ramot::אבי כהן::2026-07-10';
const GAL = 'rehab::גל דוד::2026-08-05';
const NOA = 'pardes::נועה ים::2026-07-15';
const HADAS = 'ramot::הדס שמעוני::2026-07-01';
const EVIL = '<img src=x onerror=alert(1)>';
const PATIENTS = [
  { id: 'pt-1', houseId: 'ramot', name: 'אבי כהן', date: '2026-07-10', pay: 30000, status: 'active' },
  { id: 'pt-2', houseId: 'rehab', name: 'גל דוד', date: '2026-08-05', pay: 20000, status: 'active' },
  { id: 'pt-4', houseId: 'pardes', name: 'נועה ים', date: '2026-07-15', pay: 28000, status: 'released', exitDate: '2026-08-20' },
  { id: 'pt-5', houseId: 'ramot', name: 'הדס שמעוני', date: '2026-07-01', pay: 30000, status: 'active' },
  { id: 'pt-6', houseId: 'asher', name: EVIL, date: '2026-07-31', pay: 15000, status: 'trial' },
  { id: 'pt-7', houseId: 'rehab', name: 'שי בלי יציאה', date: '2026-07-03', pay: 18000, status: 'released' },
  { id: 'pt-8', houseId: 'sde', name: 'אפס סכום', date: '2026-08-01', pay: 0, status: 'active' },
];
const pay = (pid, due, f) => Object.assign({
  id: 'pay::' + pid + '::' + due, patientId: pid, patientName: pid.split('::')[1], houseId: pid.split('::')[0], dueDate: due,
}, f);
const PAYMENTS = [
  pay(AVI, '2026-07-10', { amount: 30000, status: 'paid', amountPaid: 30000, chargedAt: '2026-07-12T10:00:00+03:00' }),
  pay(AVI, '2026-08-10', { amount: 30000, status: 'paid', amountPaid: 30000, chargedAt: '2026-09-02T10:00:00+03:00' }),
  pay(AVI, '2026-09-10', { amount: 30000, status: 'unpaid', amountPaid: 0 }),
  pay(GAL, '2026-08-05', { amount: 20000, status: 'paid', amountPaid: 20000, chargedAt: '2026-08-05T09:00:00+03:00' }),
  pay(GAL, '2026-09-05', { amount: 20000, status: 'partial', amountPaid: 12000, chargedAt: '2026-09-06T09:00:00+03:00' }),
  pay(NOA, '2026-07-15', { amount: 28000, status: 'paid', amountPaid: 28000, chargedAt: '2026-07-15T09:00:00+03:00' }),
  pay(NOA, '2026-09-15', { amount: 28000, status: 'unpaid', amountPaid: 0 }),                // after the exit
  pay(HADAS, '2026-07-01', { amount: 30000, status: 'paid', amountPaid: 30000 }),             // no chargedAt
  { id: 'p-eran', patientId: 'arfoni::ערן::2026-08-09', patientName: 'ערן', houseId: 'arfoni', dueDate: '2026-08-09',
    amount: 35000, status: 'paid', amountPaid: 35000, chargedAt: '2026-08-09T09:00:00+03:00' },   // detached
];
const CREDITS = [
  { id: 'c1', patientKey: NOA, patientName: 'נועה ים', houseId: 'pardes', amount: 5000, status: 'pending', createdAt: '2026-08-25T10:00:00+03:00' },
  { id: 'c3', patientKey: GAL, patientName: 'גל דוד', houseId: 'rehab', amount: 2000, status: 'pending', createdAt: '2026-09-10T10:00:00+03:00' },
];
const OVERRIDES = [{ id: 'ovr::' + AVI + '::2026-09', patientId: AVI, month: '2026-09', amount: 25000 }];
function tabsOf(f) {
  const rows = (list) => ({ rows: (list || []).map((o, i) => ({ rowNumber: i + 2, obj: Object.assign({}, o) })) });
  return { patients: rows(f.patients), payments: rows(f.payments), credits: rows(f.credits), overrides: rows(f.overrides) };
}
const WORLD = { patients: PATIENTS, payments: PAYMENTS, credits: CREDITS, overrides: OVERRIDES };
const GS = loadGs();
const aging = (asOf, world) => plain(GS.debtAging_(asOf, tabsOf(world || WORLD)));
const DATA = aging(TODAY);
const PAST = aging('2026-08-31');

/* ======================= app.js ======================= */

function fakeEl(id) {
  const listeners = {};
  return {
    id, value: '', open: false, _html: '', dataset: {}, style: {}, children: [], download: '', href: '',
    set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; },
    addEventListener(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
    fire(ev) { (listeners[ev] || []).forEach((fn) => fn()); },
    appendChild(c) { this.children.push(c); }, remove() {}, click() { this.clicked = true; },
    setAttribute() {}, removeAttribute() {}, querySelector() { return null; }, querySelectorAll() { return []; },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  };
}
function loadApp(opts) {
  const o = opts || {};
  const els = {};
  const created = [];
  const calls = [];
  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/' },
    document: {
      addEventListener: noop, querySelector: () => null, querySelectorAll: () => [],
      getElementById: (id) => (o.dom === false ? null : (els[id] = els[id] || fakeEl(id))),
      createElement: () => { const e = fakeEl(''); created.push(e); return e; },
      body: fakeEl('body'),
    },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    URL: Object.assign(function () {}, { createObjectURL: () => 'blob:x', revokeObjectURL: noop }),
    URLSearchParams, Math, Date, JSON, Number, String, Array, Object, RegExp, isNaN, isFinite, parseInt, parseFloat, Promise, Intl,
    setTimeout: (fn) => { fn(); return 0; }, clearTimeout: noop,
    fetch: async (url, init) => {
      const body = init && init.body ? JSON.parse(init.body) : null;
      calls.push({ url, init, body });
      const r = o.fetch ? await o.fetch(url, init, body) : { ok: true, json: { ok: true } };
      return {
        ok: r.ok !== false, status: r.status || 200,
        json: async () => (typeof r.json === 'function' ? r.json() : r.json),
        blob: async () => ({ size: 3 }),
      };
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(APP_SRC + `
    globalThis.__errors = []; globalThis.__pin = 0;
    showError = (m) => { globalThis.__errors.push(String(m)); };
    showPinScreen = () => { globalThis.__pin++; };
    globalThis.__t = { state, debtAgingView, debtAgingHtml, debtAgingCaveats, debtAgingTodayIso, debtAgingPrevMonthEnd,
      debtAgingIsRealDay, debtAgingExportUrl, exportDebtAgingXlsx, loadDebtAging, renderDebtAging, initDebtAgingControls,
      fmtShekel, escapeHtml,
      DEBT_AGING_BUCKETS, DEBT_AGING_BLOCK_LABELS, DEBT_AGING_UNRECORDED_NOTE, DEBT_AGING_CREDITS_LABEL,
      DEBT_AGING_STATUS_LABELS, DEBT_AGING_PATIENT_STATUS_LABELS, DEBT_AGING_KIND_LABELS,
      DEBT_AGING_DETACHED_REASON_LABELS, DEBT_AGING_LIST_LABELS, DEBT_AGING_XLSX_URL };`, sandbox);
  return { t: sandbox.__t, els, created, calls, errors: () => sandbox.__errors, pin: () => sandbox.__pin };
}
const APP = loadApp({ dom: false });
const shekel = (n) => APP.t.fmtShekel(n);
const html = (data, f, today) => APP.t.debtAgingHtml(data, f || {}, today || TODAY);

/* ======================= fixture sanity ======================= */

test('fixture: the real debtAging_ answers with both figures, credits and every separate list', () => {
  assert.equal(DATA.ok, true);
  assert.ok(DATA.totals.recorded_debt.total > 0);
  assert.ok(DATA.totals.unrecorded_cycles.total > 0);
  assert.notEqual(DATA.totals.recorded_debt.total, DATA.totals.unrecorded_cycles.total);
  assert.equal(DATA.detachedPayments.count, 1);
  assert.equal(DATA.outsideStay.count, 1);
  assert.equal(DATA.releasedWithoutExit.count, 1);
  assert.equal(DATA.receivedDateUnknown.count, 1);
  assert.equal(DATA.pendingCredits.count, 2);
  assert.ok(DATA.byPatient.some((p) => p.name === 'אפס סכום'), 'the zero-amount patient comes back from the server');
});

/* ======================= the view: no new math ======================= */

test('no new math: with no filter the tables equal the server totals and byHouse, bucket by bucket', () => {
  for (const mod of [debtXlsx, APP.t]) {
    const v = plain(mod.debtAgingView(DATA, {}));
    for (const k of ['recorded_debt', 'unrecorded_cycles']) {
      for (const b of BUCKETS.concat(['total'])) assert.equal(v.tables[k].totals[b], DATA.totals[k][b], `${k}.${b}`);
      DATA.byHouse.forEach((h) => {
        const row = v.tables[k].rows.find((r) => r.houseId === h.houseId);
        for (const b of BUCKETS.concat(['total'])) assert.equal(row[b], h[k][b], `${h.houseId} ${k}.${b}`);
      });
    }
    assert.equal(v.credits.total, DATA.pendingCredits.total);
    assert.equal(v.lists.detached.total, DATA.detachedPayments.amount);
  }
  // and against a past date too
  const p = debtXlsx.debtAgingView(PAST, {});
  for (const k of ['recorded_debt', 'unrecorded_cycles']) assert.equal(p.tables[k].totals.total, PAST.totals[k].total);
});

test('bucket tables: each row total = its buckets, each column total = its rows, all six houses listed', () => {
  const v = debtXlsx.debtAgingView(DATA, {});
  const r2 = (n) => Math.round(n * 100) / 100;
  for (const k of ['recorded_debt', 'unrecorded_cycles']) {
    const t = v.tables[k];
    assert.deepEqual(t.rows.map((r) => r.houseId), ['arfoni', 'rehab', 'asher', 'pardes', 'ramot', 'sde']);
    t.rows.forEach((r) => assert.equal(r.total, r2(BUCKETS.reduce((s, b) => s + r[b], 0)), r.houseId));
    BUCKETS.concat(['total']).forEach((b) => assert.equal(t.totals[b], r2(t.rows.reduce((s, r) => s + r[b], 0)), b));
  }
  // exact figures from the fixture (as of 30/09/2026)
  const rec = v.tables.recorded_debt;
  assert.equal(rec.rows.find((r) => r.houseId === 'ramot').d8_30, 25000, 'אבי: override 25,000, 20 days old');
  assert.equal(rec.rows.find((r) => r.houseId === 'rehab').d8_30, 8000, 'גל: 20,000 − 12,000');
  assert.equal(rec.totals.total, 33000);
});

test('never summed (view): no key holds recorded + unrecorded, at any level', () => {
  const v = plain(debtXlsx.debtAgingView(DATA, {}));
  const sum = DATA.totals.recorded_debt.total + DATA.totals.unrecorded_cycles.total;
  const walk = (o, p) => {
    if (typeof o === 'number') assert.notEqual(o, sum, 'summed figure at ' + p);
    else if (o && typeof o === 'object') Object.keys(o).forEach((k) => walk(o[k], p + '.' + k));
  };
  walk(v, 'view');
  assert.ok(!JSON.stringify(Object.keys(v.tables)).includes('grand'));
  assert.deepEqual(Object.keys(v.tables).sort(), ['recorded_debt', 'unrecorded_cycles']);
});

test('never summed (DOM): two blocks, each with its own total; the sum appears nowhere', () => {
  const h = html(DATA);
  const rec = DATA.totals.recorded_debt.total, unr = DATA.totals.unrecorded_cycles.total;
  assert.equal((h.match(/class="debt-block /g) || []).length, 2);
  assert.ok(h.includes(`data-block="recorded_debt"`) && h.includes(`data-block="unrecorded_cycles"`));
  assert.ok(h.includes(`<span class="count-pill debt-block-total">${shekel(rec)}</span>`));
  assert.ok(h.includes(`<span class="count-pill debt-block-total">${shekel(unr)}</span>`));
  assert.ok(!h.includes(shekel(rec + unr)), 'the two figures are never added');
  assert.ok(h.includes('שני הגושים אינם מסתכמים יחד'));
  assert.ok(h.includes('לא שולם או שולם ולא נרשם'));
});

test('filters: house', () => {
  const v = debtXlsx.debtAgingView(DATA, { house: 'rehab' });
  for (const k of ['recorded_debt', 'unrecorded_cycles']) {
    assert.deepEqual(v.tables[k].rows.map((r) => r.houseId), ['rehab']);
    const server = DATA.byHouse.find((h) => h.houseId === 'rehab')[k];
    assert.equal(v.tables[k].totals.total, server.total);
  }
  assert.ok(v.patients.every((p) => p.houseId === 'rehab'));
  assert.deepEqual(v.credits.rows.map((r) => r.houseId), ['rehab']);
  assert.equal(v.credits.total, 2000);
  assert.equal(v.lists.detached.count, 0, 'the detached row is in arfoni');
  assert.equal(v.lists.releasedNoExit.count, 1);
  assert.equal(debtXlsx.debtAgingView(DATA, { house: 'arfoni' }).lists.detached.count, 1);
  const h = html(DATA, { house: 'rehab' });
  assert.ok(!h.includes('data-house="ramot"'));
  assert.ok(h.includes('data-house="rehab"'));
});

test('filters: patient status (active / discharged)', () => {
  const act = debtXlsx.debtAgingView(DATA, { status: 'active' });
  const dis = debtXlsx.debtAgingView(DATA, { status: 'discharged' });
  assert.ok(act.patients.length > 0 && act.patients.every((p) => p.status !== 'released'));
  assert.ok(act.patients.some((p) => p.status === 'trial'), 'trial counts as active');
  assert.ok(dis.patients.every((p) => p.status === 'released'));
  for (const k of ['recorded_debt', 'unrecorded_cycles']) {
    assert.equal(Math.round((act.tables[k].totals.total + dis.tables[k].totals.total) * 100) / 100, DATA.totals[k].total,
      'active + discharged partition each block (each block alone)');
  }
  assert.equal(act.lists.releasedNoExit.count, 0);
  assert.equal(dis.lists.releasedNoExit.count, 1);
  assert.equal(act.lists.outsideStay.count, 0, 'the after-exit row belongs to a discharged patient');
  assert.equal(dis.lists.outsideStay.count, 1);
  assert.equal(act.lists.detached.count, 1, 'detached rows have no patient, so no status');
  assert.equal(dis.lists.detached.count, 1);
});

test('drill-down render: house → patients (name, status, balances, oldest bucket) → cycles', () => {
  const v = debtXlsx.debtAgingView(DATA, {});
  const avi = v.patients.find((p) => p.name === 'אבי כהן');
  assert.equal(avi.recordedBalance, 25000);
  assert.equal(avi.statusGroup, 'active');
  const h = html(DATA);
  assert.ok(h.includes('<details class="debt-house" data-house="ramot">'));
  const house = h.slice(h.indexOf('data-house="ramot"><summary>'), h.indexOf('</details></details>', h.indexOf('data-house="ramot"><summary>')));
  assert.ok(house.includes('רמות השבים · 2 מטופלים'));
  const pat = h.slice(h.indexOf('data-patient="pt-1"'), h.indexOf('</details>', h.indexOf('data-patient="pt-1"')));
  assert.ok(pat.includes('<span class="p-name">אבי כהן</span>'));
  assert.ok(pat.includes('<span class="p-val">פעיל</span>'));
  assert.ok(pat.includes(shekel(25000)));
  assert.ok(pat.includes('<span class="p-val"><span dir="ltr">8–30</span> ימים</span>'), 'oldest bucket');
  for (const th of ['תחילה', 'סוף', 'צפוי', 'התקבל', 'יתרה', 'תקופת חוב (ימים)', 'סוג']) assert.ok(pat.includes(`<th>${th}</th>`), th);
  assert.ok(pat.includes('<tr class="debt-cycle" data-kind="recorded"><td><bdi>10/09/2026</bdi></td><td><bdi>09/10/2026</bdi></td>'));
  assert.ok(pat.includes(`<td>${shekel(25000)}</td><td>${shekel(0)}</td><td>${shekel(25000)}</td><td><span dir="ltr">8–30</span></td><td>חוב רשום</td>`));
  // an unrecorded cycle shows its kind
  assert.ok(h.includes('data-kind="unrecorded"') && h.includes('<td>ללא רישום</td>'));
  // the discharged patient's status
  assert.ok(h.includes('data-patient="pt-4"'), 'the discharged patient owes the 15/08 cycle');
  const noa = h.slice(h.indexOf('data-patient="pt-4"'), h.indexOf('</details>', h.indexOf('data-patient="pt-4"')));
  assert.ok(noa.includes('<span class="p-val">משוחרר</span>'));
  assert.ok(noa.includes('<td><bdi>15/08/2026</bdi></td><td><bdi>20/08/2026</bdi></td>'), 'the exit cycle ends on the exit day');
  // a filter with nothing owed says so — never a silent empty view
  const none = aging(TODAY, { patients: [], payments: [], credits: [], overrides: [] });
  assert.ok(html(none).includes('אין חוב פתוח בסינון זה'));
});

test('separate lists: own count and total, collapsible, never in the debt figures', () => {
  const v = debtXlsx.debtAgingView(DATA, {});
  assert.equal(v.lists.detached.count, 1);
  assert.equal(v.lists.detached.total, 35000);
  assert.equal(v.lists.zeroAmount.count, 1);
  assert.equal(v.lists.zeroAmount.rows[0].name, 'אפס סכום');
  assert.ok(!v.patients.some((p) => p.name === 'אפס סכום'), 'a zero-amount patient is not in the drill-down');
  assert.ok(!v.patients.some((p) => p.name === 'שי בלי יציאה'));
  assert.ok(!v.patients.some((p) => p.cycles.some((c) => c.paymentId === 'pay::' + NOA + '::2026-09-15')), 'the after-exit row is not a cycle');
  // a huge detached payment moves no debt figure
  const more = aging(TODAY, Object.assign({}, WORLD, { payments: PAYMENTS.concat([{ id: 'p-x', patientId: 'ramot::זר::2026-08-01',
    patientName: 'זר', houseId: 'ramot', dueDate: '2026-08-01', amount: 999999, status: 'unpaid', amountPaid: 0 }]) }));
  const v2 = debtXlsx.debtAgingView(more, {});
  for (const k of ['recorded_debt', 'unrecorded_cycles']) assert.deepEqual(v2.tables[k], v.tables[k]);
  assert.equal(v2.lists.detached.total, 35000 + 999999);
  const h = html(DATA);
  for (const id of ['detached', 'outsideStay', 'releasedNoExit', 'zeroAmount']) {
    assert.ok(h.includes(`<details class="debt-list" data-list="${id}">`), id);
  }
  assert.ok(h.includes(`תשלומים לא משויכים <span class="count-pill">1</span> <span class="count-pill">${shekel(35000)}</span>`));
  assert.ok(h.includes('תשלומים אחרי יציאה <span class="count-pill">1</span>'));
  assert.ok(h.includes('משוחררים ללא תאריך יציאה <span class="count-pill">1</span>'));
  assert.ok(h.includes(`מטופלים בסכום אפס <span class="count-pill">1</span> <span class="count-pill">${shekel(0)}</span>`));
  // the credits line is beside the debt, never subtracted
  assert.ok(h.includes('זיכויים ממתינים — לא מקוזזים מהחוב'));
  assert.ok(h.includes(`רעננה הפרדס: <b>${shekel(5000)}</b> (1)`));
});

test('caveats: only when relevant', () => {
  const unknown = '1 תשלומים ללא תאריך קבלה — הוערכו לפי תחילת המחזור';
  const past = 'בתאריך עבר, תשלום שהושלם מאוחר יותר עלול להופיע כחוב';
  assert.deepEqual(plain(APP.t.debtAgingCaveats(DATA, TODAY)), [unknown]);
  assert.deepEqual(plain(APP.t.debtAgingCaveats(PAST, TODAY)), [unknown, past]);
  const clean = Object.assign({}, DATA, { receivedDateUnknown: { count: 0, amount: 0 } });
  assert.deepEqual(plain(APP.t.debtAgingCaveats(clean, TODAY)), []);
  assert.ok(!html(clean).includes('debt-caveat'));
  assert.ok(html(DATA).includes(unknown) && !html(DATA).includes(past));
  assert.ok(html(PAST).includes(past));
  assert.deepEqual(debtXlsx.debtAgingCaveats(PAST, TODAY), plain(APP.t.debtAgingCaveats(PAST, TODAY)));
});

test('every value is escaped', () => {
  const h = html(DATA);
  assert.ok(!h.includes(EVIL));
  assert.ok(h.includes('&lt;img src=x onerror=alert(1)&gt;'));
  const evilHouse = plain(DATA);
  evilHouse.byPatient[0].houseId = '"><script>x</script>';
  assert.ok(!html(evilHouse).includes('<script>x</script>'));
});

/* ======================= the browser state machine ======================= */

const okAging = (data) => async (_url, _init, body) => (body && body.action === 'debtAging'
  ? { json: Object.assign({}, data, { asOf: body.asOf }) } : { json: { ok: true } });

test('fetch only when the section is opened or the as-of date changes — never on init, a filter or a re-render', async () => {
  const app = loadApp({ fetch: okAging(DATA) });
  app.t.initDebtAgingControls();
  const debtCalls = () => app.calls.filter((c) => c.body && c.body.action === 'debtAging');
  assert.equal(debtCalls().length, 0, 'not fetched on init');
  assert.ok(app.els['debt-aging'].innerHTML.includes('פתחו את הסעיף כדי לטעון'));
  // the as-of date defaults to today in Israel
  assert.equal(app.els['debt-asof'].value, app.t.debtAgingTodayIso());
  // a date change while closed: no fetch
  app.els['debt-asof'].value = '2026-08-31';
  app.els['debt-asof'].onchange();
  assert.equal(debtCalls().length, 0);
  // opening fetches, with the chosen date
  app.els['debt-aging-view'].open = true;
  app.els['debt-aging-view'].fire('toggle');
  await new Promise((r) => setImmediate(r));
  assert.equal(debtCalls().length, 1);
  assert.deepEqual(debtCalls()[0].body.asOf, '2026-08-31');
  assert.equal(debtCalls()[0].init.method, 'POST');
  assert.ok(app.els['debt-aging'].innerHTML.includes('data-block="recorded_debt"'));
  // a filter change re-renders without fetching
  app.els['debt-house'].value = 'rehab';
  app.els['debt-house'].onchange();
  app.els['debt-status'].value = 'discharged';
  app.els['debt-status'].onchange();
  assert.equal(debtCalls().length, 1);
  assert.ok(!app.els['debt-aging'].innerHTML.includes('data-house="ramot"'));
  // «סוף חודש קודם» while open: fetches the previous month end
  app.els['debt-asof-prev-month'].onclick();
  await new Promise((r) => setImmediate(r));
  assert.equal(debtCalls().length, 2);
  assert.equal(debtCalls()[1].body.asOf, app.t.debtAgingPrevMonthEnd(app.t.debtAgingTodayIso()));
  // the house select carries Hebrew labels
  assert.ok(app.els['debt-house'].innerHTML.includes('<option value="all">כל הבתים</option>'));
  assert.ok(app.els['debt-house'].innerHTML.includes('<option value="sde">שדה אליעזר</option>'));
  assert.ok(app.els['debt-status'].innerHTML.includes('<option value="discharged">משוחררים</option>'));
});

test('loading, error and stale states are explicit — never a silent empty view', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const app = loadApp({ fetch: async (u, i, body) => { await gate; return okAging(DATA)(u, i, body); } });
  app.t.state.debtAging = { status: 'idle', asOf: '2026-09-30', house: 'all', statusFilter: 'all', data: null, error: '', seq: 0 };
  const p = app.t.loadDebtAging();
  assert.ok(app.els['debt-aging'].innerHTML.includes('טוען חובות פתוחים…'));
  release(); await p;
  assert.equal(app.t.state.debtAging.status, 'ok');

  const bad = loadApp({ fetch: async () => ({ json: { ok: false, error: 'unauthorized' } }) });
  bad.t.state.debtAging = { status: 'idle', asOf: '2026-09-30', house: 'all', statusFilter: 'all', data: null, error: '', seq: 0 };
  await bad.t.loadDebtAging();
  assert.equal(bad.t.state.debtAging.status, 'error');
  assert.ok(bad.els['debt-aging'].innerHTML.includes('טעינת החובות הפתוחים נכשלה'));
  assert.ok(bad.els['debt-aging'].innerHTML.includes('אין להסיק שאין חוב'));
  assert.ok(bad.errors().some((e) => e.startsWith('טעינת החובות הפתוחים נכשלה')));

  // a response for another date (or a malformed one) is an error, not data
  const wrong = loadApp({ fetch: async () => ({ json: Object.assign({}, DATA, { asOf: '2020-01-01' }) }) });
  wrong.t.state.debtAging = { status: 'idle', asOf: '2026-09-30', house: 'all', statusFilter: 'all', data: null, error: '', seq: 0 };
  await wrong.t.loadDebtAging();
  assert.equal(wrong.t.state.debtAging.status, 'error');

  // an invalid date never reaches the server
  const inv = loadApp({ fetch: okAging(DATA) });
  inv.t.state.debtAging = { status: 'idle', asOf: '2026-02-30', house: 'all', statusFilter: 'all', data: null, error: '', seq: 0 };
  await inv.t.loadDebtAging();
  assert.equal(inv.calls.length, 0);
  assert.equal(inv.t.state.debtAging.status, 'error');

  // an older response arriving after a newer request is dropped
  const order = [];
  const slow = loadApp({ fetch: async (u, i, body) => {
    if (body.asOf === '2026-08-31') await new Promise((r) => setImmediate(() => setImmediate(r)));
    order.push(body.asOf);
    return okAging(body.asOf === '2026-08-31' ? PAST : DATA)(u, i, body);
  } });
  const s = slow.t.state.debtAging = { status: 'idle', asOf: '2026-08-31', house: 'all', statusFilter: 'all', data: null, error: '', seq: 0 };
  const first = slow.t.loadDebtAging();
  s.asOf = '2026-09-30';
  await slow.t.loadDebtAging();
  await first;
  assert.deepEqual(order, ['2026-09-30', '2026-08-31']);
  assert.equal(s.data.asOf, '2026-09-30', 'the stale 31/08 answer did not overwrite the newer one');
});

test('dates: today in Israel, «סוף חודש קודם», real-day check', () => {
  assert.equal(APP.t.debtAgingTodayIso(new Date('2026-09-30T22:30:00Z')), '2026-10-01', 'after midnight in Israel');
  assert.equal(APP.t.debtAgingTodayIso(new Date('2026-09-30T20:30:00Z')), '2026-09-30');
  assert.equal(APP.t.debtAgingPrevMonthEnd('2026-10-02'), '2026-09-30');
  assert.equal(APP.t.debtAgingPrevMonthEnd('2026-03-15'), '2026-02-28');
  assert.equal(APP.t.debtAgingPrevMonthEnd('2028-03-01'), '2028-02-29');
  assert.equal(APP.t.debtAgingPrevMonthEnd('2026-01-05'), '2025-12-31');
  assert.equal(APP.t.debtAgingIsRealDay('2026-02-30'), false);
  assert.equal(APP.t.debtAgingIsRealDay('2026-02-28'), true);
});

test('export button: GETs the route with the controls (no-store) and downloads חובות-<asOf>.xlsx; Hebrew errors', async () => {
  const app = loadApp({ fetch: async () => ({ ok: true, status: 200 }) });
  app.t.state.debtAging = { status: 'ok', asOf: '2026-08-31', house: 'rehab', statusFilter: 'active', data: null, error: '', seq: 0 };
  await app.t.exportDebtAgingXlsx();
  assert.equal(app.calls.length, 1);
  assert.equal(app.calls[0].url, '/api/export/debt-aging.xlsx?asOf=2026-08-31&house=rehab&status=active');
  assert.equal(app.calls[0].init.cache, 'no-store');
  assert.equal(app.calls[0].init.method, 'GET');
  const a = app.created.find((e) => e.download);
  assert.equal(a.download, 'חובות-2026-08-31.xlsx');
  assert.ok(a.clicked);
  const fail = (status, error) => loadApp({ fetch: async () => ({ ok: false, status, json: { ok: false, error } }) });
  for (const [status, error, re] of [[400, 'bad_asOf', /תאריך לא תקין/], [503, 'lock_busy', /המערכת עסוקה, נסו שוב/],
    [502, 'sheets_unreachable', /אין חיבור לגיליון הנתונים/], [500, 'weird', /השרת החזיר שגיאה 500/], [401, 'unauthorized', /נדרשת התחברות מחדש/]]) {
    const f = fail(status, error);
    f.t.state.debtAging = { status: 'ok', asOf: '2026-08-31', house: 'all', statusFilter: 'all', data: null, error: '', seq: 0 };
    await assert.rejects(f.t.exportDebtAgingXlsx(), re, error);
    if (status === 401) assert.equal(f.pin(), 1);
  }
  assert.ok(APP_SRC.includes("if (exp) exp.onclick = () => busyButton(exp, 'load', exportDebtAgingXlsx)"));
  // a query value is encoded, never spliced raw
  assert.equal(APP.t.debtAgingExportUrl('2026-08-31', 'a&b=c', 'all'), '/api/export/debt-aging.xlsx?asOf=2026-08-31&house=a%26b%3Dc&status=all');
});

test('index.html: the section sits inside the גבייה tab, right after the payout section, before «סיכום חודשי»', () => {
  const billing = HTML_SRC.slice(HTML_SRC.indexOf('<section id="screen-billing"'), HTML_SRC.indexOf('</section>', HTML_SRC.indexOf('<section id="screen-billing"')));
  const at = billing.indexOf('<details id="debt-aging-view"');
  assert.ok(at > billing.indexOf('id="credits-forecast"'));
  assert.ok(at < billing.indexOf('<h3>סיכום חודשי</h3>'));
  for (const id of ['debt-asof', 'debt-asof-prev-month', 'debt-house', 'debt-status', 'debt-refresh', 'debt-export', 'debt-aging']) {
    assert.ok(billing.includes(`id="${id}"`), id);
  }
  assert.ok(billing.includes('>חובות פתוחים<') && billing.includes('>סוף חודש קודם<') && billing.includes('>ייצוא לאקסל<'));
  assert.ok(!/<details id="debt-aging-view"[^>]*\bopen\b/.test(billing), 'collapsed by default, so nothing is fetched until opened');
});

/* ======================= drift between the two copies ======================= */

test('drift: app.js and lib/debt-aging-xlsx.js agree on the labels and on the view', () => {
  const pairs = [
    ['DEBT_AGING_BUCKETS', 'DEBT_BUCKETS'], ['DEBT_AGING_BLOCK_LABELS', 'BLOCK_LABELS'],
    ['DEBT_AGING_UNRECORDED_NOTE', 'UNRECORDED_NOTE'], ['DEBT_AGING_CREDITS_LABEL', 'CREDITS_LABEL'],
    ['DEBT_AGING_STATUS_LABELS', 'STATUS_LABELS'], ['DEBT_AGING_PATIENT_STATUS_LABELS', 'PATIENT_STATUS_LABELS'],
    ['DEBT_AGING_KIND_LABELS', 'KIND_LABELS'], ['DEBT_AGING_DETACHED_REASON_LABELS', 'DETACHED_REASON_LABELS'],
    ['DEBT_AGING_LIST_LABELS', 'LIST_LABELS'],
  ];
  for (const [a, l] of pairs) assert.deepEqual(plain(APP.t[a]), plain(debtXlsx[l]), a);
  for (const f of [{}, { house: 'ramot' }, { house: 'pardes', status: 'discharged' }, { status: 'active' }, { house: 'sde' }]) {
    assert.deepEqual(plain(APP.t.debtAgingView(DATA, f)), plain(debtXlsx.debtAgingView(DATA, f)), JSON.stringify(f));
    assert.deepEqual(plain(APP.t.debtAgingView(PAST, f)), plain(debtXlsx.debtAgingView(PAST, f)), JSON.stringify(f));
  }
});

/* ======================= the workbook ======================= */

const NOW = new Date('2026-10-02T07:05:00Z');
async function openBook(buf) { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf); return wb; }
function rowsOf(ws) { const out = []; ws.eachRow((row, r) => out.push({ r, row, values: row.values.slice(1) })); return out; }
function findRow(ws, first) { let f = null; ws.eachRow((row) => { if (!f && row.getCell(1).value === first) f = row; }); return f; }
const book = (data, filters) => report.buildXlsxReport(debtXlsx.buildDebtAgingSpec(data, filters || {}, NOW, '2026-10-02')).then(openBook);

test('xlsx: six sheets, RTL, frozen header, ₪ / date / int formats', async () => {
  const wb = await book(DATA);
  assert.deepEqual(wb.worksheets.map((w) => w.name), ['סיכום', 'חוב רשום', 'מחזורים ללא רישום', 'תשלומים לא משויכים', 'תשלומים אחרי יציאה', 'חסרי תאריך יציאה']);
  for (const ws of wb.worksheets) {
    assert.equal(ws.views[0].rightToLeft, true, ws.name);
    assert.equal(ws.views[0].state, 'frozen', ws.name);
    assert.ok(ws.views[0].ySplit > 0, ws.name);
    assert.ok(ws.autoFilter, ws.name);
    assert.ok(String(ws.getRow(2).getCell(1).value).startsWith('הופק ב־'), ws.name);
  }
  const rec = wb.getWorksheet('חוב רשום');
  const header = findRow(rec, 'מטופל');
  assert.deepEqual(header.values.slice(1), ['מטופל', 'בית', 'סטטוס', 'תחילת מחזור', 'סוף מחזור', 'צפוי', 'התקבל עד התאריך', 'יתרה', 'ימים', 'תקופת חוב (ימים)']);
  assert.ok(header.getCell(1).font.bold);
  const avi = findRow(rec, 'אבי כהן');
  assert.ok(avi.getCell(4).value instanceof Date);
  assert.equal(avi.getCell(4).numFmt, report.DATE_FORMAT);
  assert.equal(avi.getCell(4).value.toISOString().slice(0, 10), '2026-09-10');
  assert.equal(avi.getCell(8).value, 25000);
  assert.equal(avi.getCell(8).numFmt, report.MONEY_FORMAT);
  assert.equal(avi.getCell(9).numFmt, report.INT_FORMAT);
  const tot = findRow(rec, 'סה"כ חוב רשום');
  assert.equal(tot.getCell(8).value, DATA.totals.recorded_debt.total);
  assert.ok(tot.getCell(1).font.bold);
  const unr = wb.getWorksheet('מחזורים ללא רישום');
  assert.equal(findRow(unr, 'סה"כ מחזורים ללא רישום').getCell(6).value, DATA.totals.unrecorded_cycles.total);
  // a guarded name, never a formula
  const evil = wb.getWorksheet('מחזורים ללא רישום');
  let formulas = 0;
  wb.worksheets.forEach((ws) => ws.eachRow((row) => row.eachCell((c) => { if (c.formula || (c.value && c.value.formula)) formulas++; })));
  assert.equal(formulas, 0);
  assert.ok(findRow(evil, EVIL), 'the name is written as text, as-is');
  // detached / after exit / no exit
  const det = wb.getWorksheet('תשלומים לא משויכים');
  assert.equal(findRow(det, 'ערן').getCell(4).value, 35000);
  assert.equal(findRow(det, 'ערן').getCell(6).value, 'לא נמצא מטופל תואם');
  assert.equal(findRow(det, 'סה"כ תשלומים לא משויכים (1)').getCell(4).value, 35000);
  assert.ok(findRow(wb.getWorksheet('תשלומים אחרי יציאה'), 'נועה ים'));
  assert.ok(findRow(wb.getWorksheet('חסרי תאריך יציאה'), 'שי בלי יציאה'));
});

test('xlsx: «סיכום» — both blocks × buckets × houses, credits line, never summed', async () => {
  const wb = await book(DATA);
  const ws = wb.getWorksheet('סיכום');
  assert.ok(String(ws.getRow(1).getCell(1).value).includes('30/09/2026'), 'the title names the as-of date');
  assert.ok(String(ws.getRow(3).getCell(1).value).includes('שני הגושים אינם מסתכמים יחד'));
  const hdr = findRow(ws, 'בית');
  assert.deepEqual(hdr.values.slice(1), ['בית', '0–7 ימים', '8–30 ימים', '31–60 ימים', '61+ ימים', 'סה"כ']);
  const recTot = findRow(ws, 'סה"כ חוב רשום');
  const unrTot = findRow(ws, 'סה"כ מחזורים ללא רישום');
  BUCKETS.forEach((b, i) => {
    assert.equal(recTot.getCell(i + 2).value, DATA.totals.recorded_debt[b]);
    assert.equal(unrTot.getCell(i + 2).value, DATA.totals.unrecorded_cycles[b]);
  });
  assert.equal(recTot.getCell(6).value, DATA.totals.recorded_debt.total);
  assert.equal(unrTot.getCell(6).value, DATA.totals.unrecorded_cycles.total);
  assert.ok(findRow(ws, 'זיכויים ממתינים — לא מקוזזים מהחוב'));
  assert.equal(findRow(ws, 'סה"כ זיכויים ממתינים').getCell(3).value, 7000);
  // never summed: no numeric cell anywhere equals recorded + unrecorded (also per bucket)
  const sum = DATA.totals.recorded_debt.total + DATA.totals.unrecorded_cycles.total;
  wb.worksheets.forEach((w) => w.eachRow((row) => row.eachCell((c) => assert.notEqual(c.value, sum, `${w.name}!${c.address}`))));
  // and no label combines them
  wb.worksheets.forEach((w) => w.eachRow((row) => row.eachCell((c) => {
    if (typeof c.value === 'string') assert.ok(!/סה"כ חוב כולל|סה"כ כללי/.test(c.value), c.value);
  })));
  // the review table has counts, never a total row
  const review = findRow(ws, 'רשימה');
  assert.ok(review);
  assert.ok(!findRow(ws, 'סה"כ לבדיקה'));
  // the caveat rides along as a note line under the title
  assert.ok(rowsOf(ws).some((r) => r.values.includes('1 תשלומים ללא תאריך קבלה — הוערכו לפי תחילת המחזור')));
});

test('xlsx: the house filter applies to every sheet', async () => {
  const wb = await book(DATA, { house: 'rehab', status: 'all' });
  const ws = wb.getWorksheet('סיכום');
  assert.ok(findRow(ws, 'קיסריה ריהאב'));
  assert.ok(!findRow(ws, 'רמות השבים'));
  assert.ok(!findRow(wb.getWorksheet('חוב רשום'), 'אבי כהן'));
  assert.ok(findRow(wb.getWorksheet('חוב רשום'), 'גל דוד'));
  assert.ok(!findRow(wb.getWorksheet('תשלומים לא משויכים'), 'ערן'));
});

/* ======================= the route ======================= */

function listen(app) { return new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); }); }
function get(port, urlPath, headers) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: urlPath, headers: headers || {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}
const ROUTE = '/api/export/debt-aging.xlsx';
// A finance user's personal cookie (Shiran / Yael get 403 on these routes — restricted view).
const cookie = (user) => ({ Cookie: `ezone_session=${personalToken(SECRET, ID_BY_NAME[user])}` });
function captureLogs() {
  const lines = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  ['log', 'error', 'warn'].forEach((k) => { console[k] = (...a) => lines.push(a.map(String).join(' ')); });
  return { lines, restore: () => Object.assign(console, orig) };
}
const enc = (s) => encodeURIComponent(s);

test('route (real app): 401 without a session; 400 on a bad asOf / house / status; 503 without PROXY_SECRET', async () => {
  const s = await listen(server.app);
  try {
    const port = s.address().port;
    const none = await get(port, ROUTE + '?asOf=2026-08-31');
    assert.equal(none.status, 401);
    assert.deepEqual(JSON.parse(none.body.toString()), { error: 'unauthorized' });
    assert.equal((await get(port, ROUTE + '?asOf=2026-08-31', { Cookie: 'ezone_session=1.bad' })).status, 401);
    const bad = [
      ['', 'bad_asOf'], ['?asOf=', 'bad_asOf'], ['?asOf=2026-02-30', 'bad_asOf'], ['?asOf=30%2F09%2F2026', 'bad_asOf'],
      ['?asOf=2026-08-31T00:00', 'bad_asOf'], ['?asOf=2026-08-31&asOf=2026-08-30', 'bad_asOf'], ['?asOf[x]=1', 'bad_asOf'],
      ['?asOf=2026-08-31&house=nope', 'bad_house'], ['?asOf=2026-08-31&house=' + enc('<script>'), 'bad_house'],
      ['?asOf=2026-08-31&house=ramot&house=sde', 'bad_house'],
      ['?asOf=2026-08-31&status=released', 'bad_status'], ['?asOf=2026-08-31&status=ALL', 'bad_status'],
    ];
    for (const [qs, error] of bad) {
      const r = await get(port, ROUTE + qs, cookie('ורד'));
      assert.equal(r.status, 400, qs);
      assert.deepEqual(JSON.parse(r.body.toString()), { ok: false, error }, qs);
      assert.equal(r.headers['cache-control'], 'no-store');
      assert.ok(!r.headers['content-disposition']);
    }
    const ok = await get(port, ROUTE + '?asOf=2026-08-31&house=ramot&status=active', cookie('ורד'));
    assert.equal(ok.status, 503, 'valid params reach requireProxySecret (fail-closed)');
  } finally { s.close(); }
});

function stubApp(fetchAging) {
  const app = express();
  app.get(ROUTE, server.requireSession, server.validateDebtAgingExportQuery, server.debtAgingXlsxHandler({ fetchAging, now: () => NOW }));
  return app;
}

test('route: success — xlsx, the as-of filename, no-store, nosniff; asOf and the session user forwarded; no patient data in logs', async () => {
  const seen = [];
  const s = await listen(stubApp(async (asOf, user) => { seen.push([asOf, user]); return Object.assign({}, PAST, { generatedAt: 'x' }); }));
  const logs = captureLogs();
  let res;
  try { res = await get(s.address().port, ROUTE + '?asOf=2026-08-31&house=all&status=all', cookie('סנדרה')); } finally { logs.restore(); s.close(); }
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], report.XLSX_MIME);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  const cd = res.headers['content-disposition'];
  assert.equal(cd, `attachment; filename="debt-aging-2026-08-31.xlsx"; filename*=UTF-8''${enc('חובות-2026-08-31.xlsx')}`);
  assert.ok(/^[\x20-\x7e]+$/.test(cd));
  assert.equal(Number(res.headers['content-length']), res.body.length);
  assert.deepEqual(seen, [['2026-08-31', 'סנדרה']]);
  const wb = await openBook(res.body);
  assert.equal(wb.worksheets.length, 6);
  // the past-date caveat (exported 02/10, as of 31/08)
  assert.ok(rowsOf(wb.getWorksheet('סיכום')).some((r) => r.values.includes('בתאריך עבר, תשלום שהושלם מאוחר יותר עלול להופיע כחוב')));
  const joined = logs.lines.join('\n');
  for (const p of ['אבי', 'גל דוד', 'ערן', '25000', '35000', 'onerror']) assert.ok(!joined.includes(p), 'log leaked ' + p);
  // house omitted → all houses
  const s2 = await listen(stubApp(async () => DATA));
  try { assert.equal((await get(s2.address().port, ROUTE + '?asOf=2026-09-30', cookie('ורד'))).status, 200); } finally { s2.close(); }
});

test('route: failures answer JSON with no-store', async () => {
  const cases = [
    [async () => ({ ok: false, error: 'lock_busy' }), 503, 'lock_busy'],
    [async () => ({ ok: false, error: 'unauthorized' }), 502, 'unauthorized'],
    [async () => ({ ok: true, totals: {} }), 502, 'bad_response'],
    [async () => Object.assign({}, DATA, { asOf: '2026-09-30' }), 502, 'bad_response'],   // asked 31/08, got 30/09
    [async () => { throw new Error('ECONNRESET אבי'); }, 502, 'sheets_unreachable'],
  ];
  for (const [fn, status, error] of cases) {
    const s = await listen(stubApp(fn));
    const logs = captureLogs();
    let res;
    try { res = await get(s.address().port, ROUTE + '?asOf=2026-08-31', cookie('סנדרה')); } finally { logs.restore(); s.close(); }
    assert.equal(res.status, status, error);
    assert.deepEqual(JSON.parse(res.body.toString()), { ok: false, error });
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.ok(!logs.lines.join('\n').includes('אבי'));
  }
  // the handler alone (no validation middleware in front) still refuses a bad query
  const app = express();
  app.get(ROUTE, server.debtAgingXlsxHandler({ fetchAging: async () => DATA, now: () => NOW }));
  const s = await listen(app);
  try { assert.equal((await get(s.address().port, ROUTE + '?asOf=nope')).status, 400); } finally { s.close(); }
});

test('validateDebtAgingQuery + content disposition: strict, and nothing from the request reaches a header', () => {
  const v = debtXlsx.validateDebtAgingQuery;
  assert.deepEqual(v({ asOf: '2026-08-31' }), { ok: true, asOf: '2026-08-31', house: 'all', status: 'all' });
  assert.deepEqual(v({ asOf: '2026-08-31', house: 'pardes', status: 'discharged' }), { ok: true, asOf: '2026-08-31', house: 'pardes', status: 'discharged' });
  assert.equal(v({ asOf: ['2026-08-31'] }).error, 'bad_asOf');
  assert.equal(v({ asOf: 20260831 }).error, 'bad_asOf');
  assert.equal(v({ asOf: '2026-08-31', house: '__proto__' }).error, 'bad_house');
  assert.equal(v({ asOf: '2026-08-31', status: 'constructor' }).error, 'bad_status');
  assert.equal(v(null).error, 'bad_asOf');
  const injected = debtXlsx.debtAgingContentDisposition('2026-01-31"\r\nSet-Cookie: x=1');
  assert.ok(!/Set-Cookie|[\r\n]/.test(injected));
  assert.ok(injected.includes('unknown-date'));
});

/* ======================= the service worker ======================= */

function loadSw() {
  const handlers = {};
  const puts = [];
  const moduleObj = { exports: {} };
  const sandbox = {
    module: moduleObj, console: { log() {}, warn() {}, error() {} }, URL, Promise,
    self: { addEventListener: (ev, fn) => { handlers[ev] = fn; }, skipWaiting: () => Promise.resolve(), clients: { claim: () => Promise.resolve() } },
    caches: { open: async () => ({ put: async (...a) => { puts.push(a); }, addAll: async () => {}, match: async () => undefined }),
      keys: async () => [], delete: async () => true, match: async () => undefined },
    fetch: async () => ({ ok: true, clone() { return this; } }),
  };
  vm.createContext(sandbox);
  vm.runInContext(SW_SRC, sandbox);
  return { handlers, puts, exports: moduleObj.exports };
}

test('SW: v24 or later, and /api/export/debt-aging.xlsx is never intercepted or cached', async () => {
  const sw = loadSw();
  // v24 shipped with this screen; later PRs bump it again (v25: section colours).
  assert.ok(Number(String(sw.exports.CACHE_VERSION).slice(1)) >= 24, sw.exports.CACHE_VERSION);
  for (const u of ['/api/export/debt-aging.xlsx?asOf=2026-08-31&house=all&status=all', 'https://ezone.example/api/export/debt-aging.xlsx']) {
    assert.equal(sw.exports.cacheStrategy(u), 'network-only', u);
    assert.equal(sw.exports.shouldCache(u), false, u);
    let intercepted = false;
    sw.handlers.fetch({ request: { method: 'GET', url: u }, respondWith: () => { intercepted = true; } });
    assert.equal(intercepted, false, u);
  }
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(sw.puts, []);
});
