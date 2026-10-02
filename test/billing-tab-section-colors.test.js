/* The גבייה tab's colour-coded groups, and the coloured, auto-sized exports.
 * See CHANGELOG-billing-tab-section-colors.md.
 *
 * Locked contracts:
 *   A. ONE colour per group, defined once: the CSS tokens (--grp-*) on :root
 *      equal lib/report-colors.js GROUP_COLORS; each group wrapper sets its
 *      token; the heading is bold 1.15rem with a 4px start-side bar; every
 *      heading passes WCAG AA over its tinted panel.
 *   B. The headings render with the new labels; the refund view has NO
 *      missing-payment section — one muted, linked count line instead, which
 *      opens «חובות פתוחים»; the export button reads «ייצוא זיכויים לאקסל».
 *   C. Cross-check: every missing_payment_data discharge from the real
 *      refundPayoutForecastFor_ is in the real debtAging_ «מחזורים ללא רישום»
 *      as of the same day; and every patient in the «משוחררים ללא תשלום רשום»
 *      line is somewhere in debtAging_ (recorded or unrecorded), with no
 *      exceptions (CHANGELOG-forecast-missing-pre-cutoff.md).
 *   D. xlsx (both exports): per-section fills (heading / header row / total
 *      row), merged headings and titles, widths ≥ the longest value, no
 *      oversized rows, and no "איזון" / "E-ZONE" anywhere in the file.
 *   E. The service worker is v25. */

process.env.TZ = 'Asia/Jerusalem';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ExcelJS = require('exceljs');
const JSZip = require('jszip');

const ROOT = path.join(__dirname, '..');
const CSS = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const GS_SRC = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');
const SW_SRC = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');
const colors = require('../lib/report-colors');
const report = require('../lib/xlsx-report');
const refundXlsx = require('../lib/refund-forecast-xlsx');
const debtXlsx = require('../lib/debt-aging-xlsx');
const plain = (v) => JSON.parse(JSON.stringify(v));
const BANNED = ['איזון', 'E-ZONE'];

/* ======================= A. one colour per group ======================= */

const rootBlock = CSS.slice(CSS.indexOf(':root {'), CSS.indexOf('}', CSS.indexOf(':root {')));
const token = (name) => { const m = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(rootBlock); return m && m[1].toLowerCase(); };
const GROUPS = {
  due: 'לגבייה בתאריך הנבחר',
  open: 'יתרות פתוחות מתאריכים קודמים',
  credits: 'זיכויים ממתינים לתשלום',
  awaiting: 'ממתין להחלטה — לא לתשלום',
  unresolved: 'לא ניתן לחשב — לבדוק',
  debt: 'חובות פתוחים',
};

test('A: the CSS tokens on :root equal lib/report-colors.js — the colours are defined once', () => {
  for (const [key, hex] of Object.entries(colors.GROUP_COLORS)) {
    assert.equal(token('grp-' + key), hex.toLowerCase(), key);
  }
  // the group rules read the tokens only — no colour is written out in them
  const groupRules = CSS.split('}').filter((r) => /\.bill-group|\.debt-block-(recorded|unrecorded)/.test(r));
  assert.ok(groupRules.length >= 8);
  for (const r of groupRules) assert.ok(!/#[0-9a-fA-F]{3,6}\b/.test(r), 'hard-coded colour in: ' + r.trim().slice(0, 80));
});

test('A: each group modifier sets --grp from its token; the heading is bold 1.15rem with a 4px start bar; tinted panel; chip in colour', () => {
  for (const key of Object.keys(GROUPS)) {
    assert.ok(new RegExp(`\\.bill-group--${key}\\s*\\{\\s*--grp:\\s*var\\(--grp-${key}\\);\\s*\\}`).test(CSS), key);
  }
  const rule = (sel) => { const i = CSS.indexOf(sel + ' {'); assert.ok(i >= 0, sel); return CSS.slice(i, CSS.indexOf('}', i)); };
  const title = rule('.bill-group .bill-group-title');
  assert.match(title, /font-weight:\s*700/);
  assert.match(title, /font-size:\s*1\.15rem/);
  assert.match(title, /border-inline-start:\s*4px solid var\(--grp\)/);
  assert.match(title, /color:\s*var\(--grp\)/);
  assert.match(title, /overflow-wrap:\s*anywhere/, 'long headings wrap on a phone');
  assert.match(title, /text-transform:\s*none/, 'undoes the .screen h3 uppercase');
  assert.match(title, /letter-spacing:\s*0/);
  assert.match(rule('.bill-group'), /background:\s*color-mix\(in srgb, var\(--grp\) 9%, var\(--surface\)\)/);
  const chip = rule('.bill-group .bill-group-title .count-pill');
  assert.match(chip, /color:\s*var\(--grp\)/);
});

test('A: every heading colour passes WCAG AA (4.5:1) over its tinted panel', () => {
  const surface = token('surface');
  assert.ok(surface);
  for (const [key, hex] of Object.entries(colors.GROUP_COLORS)) {
    const ratio = colors.contrast(colors.hexToRgb(hex), colors.mix(hex, surface, 0.09));
    assert.ok(ratio >= 4.5, `${key}: ${ratio.toFixed(2)}`);
  }
});

/* ======================= B. headings, labels, the line ======================= */

function fakeEl(id) {
  const listeners = {};
  return {
    id, open: false, value: '', _html: '', scrolled: 0, dataset: {}, style: {}, children: [],
    set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; },
    addEventListener(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
    fire(ev, e) { (listeners[ev] || []).forEach((fn) => fn(e)); },
    scrollIntoView() { this.scrolled++; }, appendChild() {}, remove() {}, setAttribute() {}, removeAttribute() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  };
}
function loadApp() {
  const els = {};
  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/' },
    document: { addEventListener: noop, querySelector: () => null, querySelectorAll: () => [], body: fakeEl('body'),
      getElementById: (id) => (els[id] = els[id] || fakeEl(id)), createElement: () => fakeEl('') },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    URLSearchParams, Math, Date, JSON, Number, String, Array, Object, RegExp, isNaN, isFinite, parseInt, parseFloat, Promise, Intl,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }),
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(APP_SRC + `
    showError = () => {};
    globalThis.__t = { payoutForecastHtml, initPayoutForecastControls, openDebtAgingSection, PAYOUT_FORECAST_MISSING_LINE };`, sandbox);
  return { t: sandbox.__t, els };
}

test('B: index.html — every group wrapper carries its colour class and the bold heading with its label', () => {
  for (const key of ['due', 'open', 'credits']) {
    const at = HTML.indexOf(`<div class="bill-group bill-group--${key}" data-group="${key}">`);
    assert.ok(at > 0, key);
    assert.ok(HTML.slice(at, at + 300).includes(`<h3 class="bill-group-title">${GROUPS[key]}`), key);
  }
  assert.ok(HTML.includes('<details id="debt-aging-view" class="debt-aging-view bill-group bill-group--debt" data-group="debt">'));
  assert.ok(HTML.includes('<summary><h3 class="bill-group-title">חובות פתוחים</h3></summary>'));
  // the lists inside are unchanged
  for (const id of ['billing-due-list', 'billing-open-list', 'credits-payout-list', 'credits-pending-total', 'credits-forecast']) {
    assert.equal(HTML.split(`id="${id}"`).length, 2, id);
  }
  // the order on the tab
  const order = ['bill-group--due', 'bill-group--open', 'bill-group--credits', 'id="credits-forecast"', 'bill-group--debt', '<h3>סיכום חודשי</h3>'];
  order.reduce((prev, s) => { const i = HTML.indexOf(s); assert.ok(i > prev, s); return i; }, -1);
});

test('B: the renamed export button; no «ייצוא להנהלת חשבונות» or «חסרים נתוני תשלום» left in the UI', () => {
  assert.ok(HTML.includes('<button type="button" class="btn small primary" id="credits-forecast-export">ייצוא זיכויים לאקסל</button>'));
  for (const gone of ['ייצוא להנהלת חשבונות', 'חסרים נתוני תשלום']) {
    assert.ok(!HTML.includes(gone), 'index.html: ' + gone);
    assert.ok(!APP_SRC.includes(gone), 'app.js: ' + gone);
  }
});

const FORECAST = {
  ok: true, recordsCutoff: '2026-07-01',
  decided: { count: 0, total: 0, byPayoutDate: [], byHouse: [] },
  awaiting_decision: { count: 1, total: 2000, byPayoutDate: [{ payoutDate: '2026-10-15', count: 1, total: 2000,
    rows: [{ patientName: 'דנה', houseId: 'ramot', exitDate: '2026-09-20', suggestedAmount: 2000, rule: 'residential_prorata', payoutDate: '2026-10-15' }] }],
  byHouse: [{ houseId: 'ramot', count: 1, total: 2000 }] },
  missing_payment_data: { count: 3, rows: [{ patientName: '<b>x</b>' }, { patientName: 'b' }, { patientName: 'c' }] },
  unresolved: { count: 1, rows: [{ patientName: 'יוסי', houseId: 'mars', exitDate: '2026-09-01', error: 'unknown_house' }] },
};

test('B: the forecast renders the purple and grey groups, and one muted linked line for the no-payment discharges', () => {
  const app = loadApp();
  const html = app.t.payoutForecastHtml(FORECAST);
  assert.ok(html.includes('<div class="bill-group bill-group--awaiting" data-group="awaiting"><h4 class="bill-group-title forecast-title forecast-awaiting">ממתין להחלטה — לא לתשלום'));
  assert.ok(html.includes('<div class="bill-group bill-group--unresolved" data-group="unresolved"><h4 class="bill-group-title forecast-title forecast-unresolved">לא ניתן לחשב — לבדוק'));
  assert.equal((html.match(/<div class="bill-group /g) || []).length, (html.match(/data-group=/g) || []).length);
  assert.ok(html.includes('<p class="forecast-missing-line"><a href="#debt-aging-view" data-open-debt-aging>3 משוחררים ללא תשלום רשום — מופיעים ב״חובות פתוחים״</a></p>'));
  assert.ok(!html.includes('&lt;b&gt;x') && !html.includes('<b>x'), 'the no-payment patients are not listed');
  assert.ok(!html.includes('bill-group--missing'), 'no colour and no section for them');
  // only when count > 0
  const zero = app.t.payoutForecastHtml(Object.assign({}, FORECAST, { missing_payment_data: { count: 0, rows: [] } }));
  assert.ok(!zero.includes('forecast-missing-line'));
  // no unresolved → no grey group
  const noUn = app.t.payoutForecastHtml(Object.assign({}, FORECAST, { unresolved: { count: 0, rows: [] } }));
  assert.ok(!noUn.includes('bill-group--unresolved'));
  // same text as the xlsx line
  assert.equal(app.t.PAYOUT_FORECAST_MISSING_LINE, refundXlsx.MISSING_LINE);
});

test('B: clicking the line opens «חובות פתוחים» and scrolls to it; other clicks do nothing', () => {
  const app = loadApp();
  app.t.initPayoutForecastControls();
  const box = app.els['credits-forecast'];
  const view = app.els['debt-aging-view'] = fakeEl('debt-aging-view');
  let prevented = 0;
  box.fire('click', { target: { closest: () => null }, preventDefault: () => { prevented++; } });
  assert.equal(view.open, false);
  box.fire('click', { target: { closest: (sel) => (sel === '[data-open-debt-aging]' ? {} : null) }, preventDefault: () => { prevented++; } });
  assert.equal(view.open, true, 'opened — its toggle handler loads the data');
  assert.equal(view.scrolled, 1);
  assert.equal(prevented, 1);
});

/* ======================= C. the cross-check ======================= */

function formatDate(d, tz, fmt) {
  const p = {};
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(d).forEach((x) => { p[x.type] = x.value; });
  return fmt.replace('yyyy', p.year).replace('MM', p.month).replace('dd', p.day).replace('HH', p.hour).replace('mm', p.minute);
}
function loadGs(nowIso) {
  const fixed = new Date(nowIso).getTime();
  class FrozenDate extends Date {
    constructor(...a) { if (a.length === 0) super(fixed); else super(...a); }
    static now() { return fixed; }
  }
  const sb = {
    console: { log() {}, warn() {}, error() {}, info() {} },
    JSON, Math, Date: FrozenDate, Number, String, Array, Object, RegExp, Error, isFinite, isNaN,
    Logger: { log() {} }, Utilities: { formatDate }, PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
  };
  sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(GS_SRC, sb);
  return sb;
}
/* One world, read by both engines: the Patients rows (debtAging_) and the
 * discharged-tab rows (refundPayoutForecastFor_) are the same people. */
function world(people) {
  const patients = [], discharged = [], payments = [];
  people.forEach(([houseId, name, entry, exit, pays], i) => {
    patients.push({ id: 'pt-' + i, houseId, name, date: entry, pay: 30000, status: 'released', exitDate: exit });
    discharged.push({ id: 'dis-' + i, houseId, name, date: entry, exitDate: exit, status: 'released', restored: '' });
    (pays || []).forEach(([due, status, paid]) => payments.push({
      id: `pay-${i}-${due}`, patientId: `${houseId}::${name}::${entry}`, patientName: name, houseId, dueDate: due,
      amount: 30000, status, amountPaid: paid, balance: 30000 - paid, chargedAt: paid ? due + 'T10:00:00+03:00' : '',
    }));
  });
  return { patients, discharged, payments };
}
const rowsOf = (list) => ({ rows: list.map((obj, i) => ({ rowNumber: i + 2, obj: Object.assign({}, obj) })) });
function both(people, today) {
  const gs = loadGs(today + 'T09:00:00.000Z');
  const w = world(people);
  const forecast = plain(gs.refundPayoutForecastFor_(w.discharged, [], w.payments, today));
  const aging = plain(gs.debtAging_(today, { patients: rowsOf(w.patients), payments: rowsOf(w.payments), credits: rowsOf([]), overrides: rowsOf([]) }));
  return { forecast, aging };
}
const kindsOf = (aging, row) => {
  const p = aging.byPatient.find((x) => x.name === row.patientName && x.houseId === row.houseId && x.entryDate === row.entryDate);
  return p ? p.cycles.map((c) => c.kind) : [];
};

test('C: every missing_payment_data discharge is in debtAging «מחזורים ללא רישום» as of today', () => {
  const { forecast, aging } = both([
    ['rehab', 'אין תשלום בכלל', '2026-09-01', '2026-09-05', []],
    ['asher', 'רק מחזור קודם שולם', '2026-07-05', '2026-08-20', [['2026-07-05', 'paid', 30000]]],
    ['arfoni', 'רק שורה מבוטלת', '2026-09-09', '2026-09-12', [['2026-09-09', 'void', 30000]]],
    ['sde', 'שני מחזורים בלי רישום', '2026-07-15', '2026-09-25', [['2026-07-15', 'paid', 30000]]],
  ], '2026-10-02');
  const missing = forecast.missing_payment_data.rows;
  assert.equal(missing.length, 4, 'all four are missing payment data');
  for (const row of missing) {
    assert.ok(kindsOf(aging, row).includes('unrecorded'), `${row.patientName} is under «מחזורים ללא רישום»`);
  }
  // and the screen's line count is that same number
  const app = loadApp();
  assert.ok(app.t.payoutForecastHtml(Object.assign({}, FORECAST, { missing_payment_data: forecast.missing_payment_data }))
    .includes('>4 משוחררים ללא תשלום רשום'));
});

test('C (case 1): an unpaid ₪0 row for the exit cycle is counted, and is «חוב רשום» in debt aging', () => {
  const { forecast, aging } = both([
    // a Payments row exists for the exit cycle but nothing was paid
    ['ramot', 'שורה שלא שולמה', '2026-08-10', '2026-09-20', [['2026-08-10', 'paid', 30000], ['2026-09-10', 'unpaid', 0]]],
  ], '2026-10-02');
  const byName = (n) => forecast.missing_payment_data.rows.find((r) => r.patientName === n);
  // counted as missing payment data by the refund forecast …
  assert.ok(byName('שורה שלא שולמה'));
  // … and it IS in «חובות פתוחים», under «חוב רשום» (a row exists).
  assert.deepEqual(kindsOf(aging, byName('שורה שלא שולמה')), ['recorded']);
});

test('C (case 2, fixed): an exit cycle that started before 01/07/2026 is neither counted nor listed', () => {
  const { forecast, aging } = both([
    // the exit cycle started 20/06, before the records cutoff; the exit is after it
    ['pardes', 'מחזור יציאה לפני הסף', '2026-06-20', '2026-07-05', []],
  ], '2026-10-02');
  // not listed and not counted in the «משוחררים ללא תשלום רשום» line …
  assert.equal(forecast.missing_payment_data.count, 0);
  assert.equal(forecast.missing_payment_data.rows.length, 0);
  // … only in the transparency counter (never shown in the UI) …
  assert.equal(forecast.preCutoffExcludedCount, 1);
  // … and not in any other section either;
  assert.equal(forecast.awaiting_decision.count + forecast.unresolved.count, 0);
  // debt aging agrees: records before 01/07 were never entered, so no debt.
  assert.equal(aging.byPatient.find((p) => p.name === 'מחזור יציאה לפני הסף'), undefined);
});

test('C: every patient in the «משוחררים ללא תשלום רשום» line is in debt aging (recorded or unrecorded) — no exceptions', () => {
  const people = [
    ['rehab', 'אין תשלום בכלל', '2026-09-01', '2026-09-05', []],
    ['asher', 'רק מחזור קודם שולם', '2026-07-05', '2026-08-20', [['2026-07-05', 'paid', 30000]]],
    ['arfoni', 'רק שורה מבוטלת', '2026-09-09', '2026-09-12', [['2026-09-09', 'void', 30000]]],
    ['sde', 'שני מחזורים בלי רישום', '2026-07-15', '2026-09-25', [['2026-07-15', 'paid', 30000]]],
    ['ramot', 'שורה שלא שולמה', '2026-08-10', '2026-09-20', [['2026-08-10', 'paid', 30000], ['2026-09-10', 'unpaid', 0]]],
    // pre-cutoff entries: excluded when the exit cycle starts before 01/07 …
    ['pardes', 'מחזור יציאה לפני הסף', '2026-06-20', '2026-07-05', []],
    // … counted when the exit cycle starts on the cutoff …
    ['pardes', 'מחזור יציאה ביום הסף', '2026-06-01', '2026-07-05', []],
    // … or after it.
    ['rehab', 'מחזור יציאה אחרי הסף', '2026-06-15', '2026-07-20', []],
  ];
  const { forecast, aging } = both(people, '2026-10-02');
  const missing = forecast.missing_payment_data.rows;
  assert.equal(forecast.missing_payment_data.count, 7);
  assert.equal(forecast.preCutoffExcludedCount, 1);
  assert.ok(!missing.some((r) => r.patientName === 'מחזור יציאה לפני הסף'));
  for (const row of missing) {
    const kinds = kindsOf(aging, row);
    assert.ok(kinds.includes('recorded') || kinds.includes('unrecorded'), `${row.patientName} is in «חובות פתוחים»`);
  }
});

/* ======================= D. the workbooks ======================= */

const NOW = new Date('2026-10-02T07:05:00Z');
async function open(buf) { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf); return { wb, buf }; }
const refundData = {
  ok: true, recordsCutoff: '2026-07-01', zeroByPolicyCount: 2,
  decided: { count: 1, total: 1500, byPayoutDate: [{ payoutDate: '2026-10-15', count: 1, total: 1500,
    rows: [{ patientName: 'שם ארוך מאוד של מטופלת לבדיקת רוחב העמודה בגיליון', houseId: 'ramot', amount: 1500, decidedDate: '2026-10-01',
      payoutDate: '2026-10-15', rule: 'residential_prorata', overrideReason: '' }] }],
  byHouse: [{ houseId: 'ramot', count: 1, total: 1500 }] },
  awaiting_decision: { count: 1, total: 2345, byPayoutDate: [{ payoutDate: '2026-11-15', count: 1, total: 2345,
    rows: [{ patientName: 'דנה', houseId: 'rehab', entryDate: '2026-08-01', exitDate: '2026-09-20', suggestedAmount: 2345, rule: 'residential_prorata', payoutDate: '2026-11-15' }] }],
  byHouse: [{ houseId: 'rehab', count: 1, total: 2345 }] },
  missing_payment_data: { count: 2, rows: [{ patientName: 'x' }, { patientName: 'y' }] },
  unresolved: { count: 1, rows: [{ patientName: 'יוסי', houseId: 'mars', entryDate: '2026-08-01', exitDate: '2026-09-01', error: 'unknown_house' }] },
};
const debtData = (() => {
  const gs = loadGs('2026-10-02T09:00:00.000Z');
  const w = world([
    ['rehab', 'גל', '2026-08-05', '', [['2026-08-05', 'paid', 30000], ['2026-09-05', 'partial', 12000]]],
    ['ramot', 'אבי', '2026-07-10', '', []],
    ['pardes', 'נועה', '2026-07-15', '2026-08-20', [['2026-07-15', 'paid', 30000], ['2026-09-15', 'unpaid', 0]]],
  ]);
  w.patients.forEach((p) => { if (!p.exitDate) p.status = 'active'; });
  w.payments.push({ id: 'det', patientId: 'arfoni::ערן::2026-08-09', patientName: 'ערן', houseId: 'arfoni', dueDate: '2026-08-09', amount: 35000, status: 'paid', amountPaid: 35000, chargedAt: '2026-08-09T09:00:00+03:00' });
  return plain(gs.debtAging_('2026-10-02', { patients: rowsOf(w.patients), payments: rowsOf(w.payments), credits: rowsOf([]), overrides: rowsOf([]) }));
})();
const refundBook = () => report.buildXlsxReport(refundXlsx.buildRefundForecastSpec(refundData, NOW)).then(open);
const debtBook = () => report.buildXlsxReport(debtXlsx.buildDebtAgingSpec(debtData, {}, NOW, '2026-10-02')).then(open);

const argb = (cell) => cell.fill && cell.fill.fgColor && cell.fill.fgColor.argb;
const findRow = (ws, v) => { let f = null; ws.eachRow((row, r) => { if (!f && row.getCell(1).value === v) f = { row, r }; }); return f; };
const mergesOf = (ws) => (ws.model.merges || []);

/* Check one coloured section: heading row (merged, white bold on the dark
 * shade), header row (light tint), total rows (bold, medium tint). */
function assertSection(ws, heading, colorKey, ncols, totalLabels) {
  const s = colors.xlsxShades(colorKey);
  const h = findRow(ws, heading);
  assert.ok(h, `${ws.name}: heading «${heading}»`);
  assert.equal(argb(h.row.getCell(1)), s.heading, `${ws.name}: heading fill`);
  assert.equal(h.row.getCell(1).font.bold, true);
  assert.equal(h.row.getCell(1).font.color.argb, 'FFFFFFFF', 'white text');
  if (ncols > 1) assert.ok(mergesOf(ws).includes(`A${h.r}:${String.fromCharCode(64 + ncols)}${h.r}`), `${ws.name}: heading merged across ${ncols}`);
  const header = ws.getRow(h.r + 1);
  for (let c = 1; c <= ncols; c++) assert.equal(argb(header.getCell(c)), s.header, `${ws.name}: header fill col ${c}`);
  (totalLabels || []).forEach((label) => {
    let t = null;
    ws.eachRow((row, r) => { if (!t && r > h.r && row.getCell(1).value === label) t = row; });
    assert.ok(t, `${ws.name}: total «${label}»`);
    for (let c = 1; c <= ncols; c++) {
      assert.equal(argb(t.getCell(c)), s.total, `${ws.name}: total fill col ${c}`);
      assert.equal(t.getCell(c).font.bold, true);
    }
  });
}

test('D: the shades — white headings pass AA; the tints are light and medium', () => {
  for (const key of Object.keys(colors.GROUP_COLORS)) {
    const s = colors.xlsxShades(key);
    const rgb = (a) => [1, 3, 5].map((i) => parseInt(a.slice(i + 1, i + 3), 16));
    assert.ok(colors.contrast([255, 255, 255], rgb(s.heading)) >= 4.5, key);
    assert.ok(colors.luminance(rgb(s.header)) > colors.luminance(rgb(s.total)), key + ': header lighter than total');
  }
  assert.throws(() => colors.xlsxShades('nope'));
});

test('D: refund xlsx — הוחלט green, ממתין להחלטה purple, the rest grey; one-table sheets colour their title', async () => {
  const { wb } = await refundBook();
  const sum = wb.getWorksheet('סיכום');
  assertSection(sum, 'הוחלט — ממתין לתשלום — לפי תאריך תשלום', 'credits', 3, ['סה"כ הוחלט']);
  assertSection(sum, 'הוחלט — ממתין לתשלום — לפי בית', 'credits', 3, ['סה"כ הוחלט']);
  assertSection(sum, 'ממתין להחלטה — לא לתשלום — לפי תאריך תשלום אם יוחלט היום (הצעה בלבד)', 'awaiting', 3, ['סה"כ ממתין להחלטה (הצעה בלבד)']);
  assertSection(sum, 'ממתין להחלטה — לא לתשלום — לפי בית (הצעה בלבד)', 'awaiting', 3, ['סה"כ ממתין להחלטה (הצעה בלבד)']);
  assertSection(sum, 'לבדיקה — ספירה בלבד, ללא סכום', 'unresolved', 2, []);
  for (const [name, key] of [['הוחלט', 'credits'], ['ממתין להחלטה', 'awaiting'], ['לא ניתן לחשב', 'unresolved']]) {
    const ws = wb.getWorksheet(name);
    const s = colors.xlsxShades(key);
    assert.equal(argb(ws.getCell('A1')), s.heading, name + ': title fill');
    assert.equal(ws.getCell('A1').font.color.argb, 'FFFFFFFF');
    const header = ws.getRow(ws.views[0].ySplit);
    assert.equal(argb(header.getCell(1)), s.header, name + ': header tint');
  }
  assert.deepEqual(wb.worksheets.map((w) => w.name), ['סיכום', 'הוחלט', 'ממתין להחלטה', 'לא ניתן לחשב']);
});

test('D: debt xlsx — חוב רשום red, מחזורים ללא רישום orange, credits green, separate lists grey', async () => {
  const { wb } = await debtBook();
  const sum = wb.getWorksheet('סיכום');
  assertSection(sum, 'חוב רשום — שורות תשלום שלא שולמו או שולמו חלקית', 'debt', 6, ['סה"כ חוב רשום']);
  assertSection(sum, 'מחזורים ללא רישום — לא שולם או שולם ולא נרשם', 'unrecorded', 6, ['סה"כ מחזורים ללא רישום']);
  assertSection(sum, 'זיכויים ממתינים — לא מקוזזים מהחוב', 'credits', 3, ['סה"כ זיכויים ממתינים']);
  assertSection(sum, 'לבדיקה — לא נכלל בחוב (כל שורה בנפרד, ללא סה"כ)', 'unresolved', 3, []);
  for (const [name, key] of [['חוב רשום', 'debt'], ['מחזורים ללא רישום', 'unrecorded'], ['תשלומים לא משויכים', 'unresolved'],
    ['תשלומים אחרי יציאה', 'unresolved'], ['חסרי תאריך יציאה', 'unresolved']]) {
    const ws = wb.getWorksheet(name);
    assert.equal(argb(ws.getCell('A1')), colors.xlsxShades(key).heading, name);
  }
  const rec = wb.getWorksheet('חוב רשום');
  const t = findRow(rec, 'סה"כ חוב רשום');
  assert.equal(argb(t.row.getCell(8)), colors.xlsxShades('debt').total);
});

/* The text a cell shows, recomputed here independently of the helper. */
function shown(cell) {
  const v = cell.value;
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return 'dd/mm/yyyy';
  if (typeof v === 'number') return cell.numFmt && cell.numFmt.includes('₪') ? '₪' + Math.round(v).toLocaleString('en-US') : String(v);
  return String(v);
}

async function assertLayout(wb) {
  for (const ws of wb.worksheets) {
    const merged = new Set();
    mergesOf(ws).forEach((m) => { const [a] = m.split(':'); merged.add(Number(a.replace(/[A-Z]+/, ''))); });
    // the title (and the generated-at line) merge across the table when it is wider than one column
    const span = ws.columnCount;
    if (span > 1) {
      assert.ok(merged.has(1), ws.name + ': title merged');
      assert.ok(merged.has(2), ws.name + ': generated-at merged');
    }
    // widths: ≥ the longest value in each column (unmerged rows), 12..60
    const longest = [];
    ws.eachRow((row, r) => {
      if (merged.has(r)) return;
      row.eachCell((cell, c) => { longest[c] = Math.max(longest[c] || 0, shown(cell).length); });
    });
    for (let c = 1; c <= span; c++) {
      const w = ws.getColumn(c).width;
      assert.ok(w >= 12 && w <= 60, `${ws.name} col ${c}: ${w}`);
      assert.ok(w >= Math.min(60, longest[c] || 0), `${ws.name} col ${c}: width ${w} < longest ${longest[c]}`);
    }
    // no wrapped headers, no oversized rows
    ws.eachRow({ includeEmpty: true }, (row, r) => {
      assert.ok(row.height === undefined || row.height <= 26, `${ws.name} row ${r}: height ${row.height}`);
      const empty = !row.values.some((v) => v !== undefined && v !== null && v !== '');
      if (empty) assert.ok(row.height === undefined || row.height <= 8, `${ws.name} empty row ${r}: ${row.height}`);
      row.eachCell((cell) => assert.ok(!(cell.alignment && cell.alignment.wrapText), `${ws.name}!${cell.address} wraps`));
    });
    // a merged line never needs more room than its merged columns give it
    mergesOf(ws).forEach((m) => {
      const [a, b] = m.split(':');
      const r = Number(a.replace(/[A-Z]+/, ''));
      const cols = b.charCodeAt(0) - 64;
      let total = 0;
      for (let c = 1; c <= cols; c++) total += ws.getColumn(c).width;
      const text = String(ws.getCell(a).value || '');
      assert.ok(total >= Math.min(text.length, 60 * cols), `${ws.name} ${m}: «${text}» needs ${text.length}, has ${total}`);
      assert.equal(ws.getRow(r).getCell(1).value, ws.getCell(a).value);
    });
  }
}

test('D: widths fit the longest value (Hebrew too), merged headings span the table, rows are compact — refund xlsx', async () => {
  const { wb } = await refundBook();
  await assertLayout(wb);
  const decided = wb.getWorksheet('הוחלט');
  assert.ok(decided.getColumn(2).width >= 'שם ארוך מאוד של מטופלת לבדיקת רוחב העמודה בגיליון'.length);
});

test('D: the same layout rules — debt xlsx', async () => {
  const { wb } = await debtBook();
  await assertLayout(wb);
});

async function assertNoBanned(wb, buf, label) {
  for (const ws of wb.worksheets) {
    assert.ok(!BANNED.some((b) => ws.name.includes(b)), `${label}: sheet name ${ws.name}`);
    ws.eachRow({ includeEmpty: true }, (row) => row.eachCell({ includeEmpty: true }, (cell) => {
      const v = typeof cell.value === 'string' ? cell.value : JSON.stringify(cell.value || '');
      for (const b of BANNED) assert.ok(!v.includes(b), `${label}: ${ws.name}!${cell.address} has «${b}»`);
    }));
    const hf = JSON.stringify(ws.headerFooter || {});
    for (const b of BANNED) assert.ok(!hf.includes(b), `${label}: header/footer of ${ws.name}`);
  }
  for (const prop of ['creator', 'lastModifiedBy', 'company', 'manager', 'title', 'subject', 'keywords', 'category', 'description']) {
    const v = String(wb[prop] || '');
    for (const b of BANNED) assert.ok(!v.includes(b), `${label}: workbook ${prop} = ${v}`);
  }
  // and the raw file: every XML part (docProps/core.xml, app.xml, sheets, shared strings)
  const zip = await JSZip.loadAsync(buf);
  for (const name of Object.keys(zip.files)) {
    if (zip.files[name].dir) continue;
    const xml = await zip.files[name].async('string');
    for (const b of BANNED) assert.ok(!xml.includes(b), `${label}: ${name} contains «${b}»`);
  }
}

test('D: no "איזון" and no "E-ZONE" anywhere — cells, sheet names, headers/footers, properties, raw XML, filenames', async () => {
  const r = await refundBook();
  await assertNoBanned(r.wb, r.buf, 'refund');
  const d = await debtBook();
  await assertNoBanned(d.wb, d.buf, 'debt');
  // the download names: server headers and the browser's a.download
  const names = [refundXlsx.contentDisposition('2026-10-02'), decodeURIComponent(refundXlsx.contentDisposition('2026-10-02')),
    debtXlsx.debtAgingContentDisposition('2026-10-02'), decodeURIComponent(debtXlsx.debtAgingContentDisposition('2026-10-02'))];
  const downloads = [...APP_SRC.matchAll(/a\.download = `([^`]*)`/g)].map((m) => m[1]);
  assert.ok(downloads.length >= 2);
  for (const n of names.concat(downloads)) for (const b of BANNED) assert.ok(!n.includes(b), n);
  // and the app.js download names are the ones the server sends
  assert.ok(downloads.includes('זיכויים-לתשלום-${todayISO()}.xlsx'));
  assert.ok(downloads.includes('חובות-${s.asOf}.xlsx'));
});

test('D: a section with no colour keeps the neutral look; an unknown colour is refused', async () => {
  const { wb } = await open(await report.buildXlsxReport({ generatedAt: NOW, sheets: [{ name: 'x', title: 't', sections: [
    { heading: 'ניטרלי', columns: [{ header: 'a', key: 'a' }, { header: 'b', key: 'b' }], rows: [{ a: 1, b: 2 }], totals: [{ label: 'סה"כ', values: { b: 2 } }] },
  ] }] }));
  const ws = wb.getWorksheet('x');
  const h = findRow(ws, 'ניטרלי');
  assert.ok(!argb(h.row.getCell(1)), 'no fill on a neutral heading');
  assert.equal(argb(ws.getRow(h.r + 1).getCell(1)), 'FFD9E2F3');
  assert.equal(argb(findRow(ws, 'סה"כ').row.getCell(1)), 'FFF2F2F2');
  await assert.rejects(report.buildXlsxReport({ generatedAt: NOW, sheets: [{ name: 'x', color: 'nope', columns: [{ header: 'a', key: 'a' }], rows: [] }] }));
});

/* ======================= E. the service worker ======================= */

test('E: CACHE_VERSION is v25', () => {
  const m = /var CACHE_VERSION = '(v\d+)';/.exec(SW_SRC);
  assert.equal(m && m[1], 'v25');
});
