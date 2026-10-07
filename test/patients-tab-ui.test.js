/* «מטופלים» — the patient list, PR 2 (the UI). CHANGELOG-patients-tab-ui.md.
 *
 * Locked here (the browser proves the layout at 360px in
 * test/patients-tab-ui-browser.test.js):
 *   1. Placement: the tab sits right after «לידים», with a red badge; the
 *      router knows it; restricted sessions keep it, the controller view
 *      (Ortal) never has it.
 *   2. A row: name, house, entry date, days in the house; for a finance
 *      session the funder (with «הגדר גורם מממן») and the payment status
 *      (with «דווח תשלום» on an unpaid / partial cycle, edit mode only).
 *   3. Restricted (Shiran, Yael): no payment column, no funder cell or chip,
 *      no «דווח תשלום» — even when money data is in memory.
 *   4. «פרטי הליד»: the lead's phone, source, visit date, advance, notes,
 *      who handled it; «ללא ליד» / missing / ambiguous wording.
 *   5. «ממתינים לקליטה»: the #192 rows with «קלוט כמטופל» (edit mode) and
 *      the #192 chip from day 3.
 *   6. Everything is escaped (lead notes are free text).
 *   7. Summary + badge; the controller early return.
 *   8. Scope: existing flows only, no new action; SW v45.
 * All names, ids and phone numbers are SYNTHETIC. */

process.env.TZ = 'UTC';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const APP_SRC = read('public', 'app.js');
const HTML_SRC = read('public', 'index.html');
const CSS_SRC = read('public', 'style.css');
const SW_SRC = read('public', 'sw.js');
const GS_SRC = read('apps-script', 'Code.gs');
const RULES_SRC = read('lib', 'payment-report-rules.js');
const FUNDER_SRC = read('public', 'funder.js');
const plain = (v) => JSON.parse(JSON.stringify(v));

function fakeEl(id) {
  return {
    id: id || '', _html: '', textContent: '', value: '', checked: false, children: [], style: {}, dataset: {},
    classList: {
      _c: new Set(),
      add(c) { this._c.add(c); }, remove(c) { this._c.delete(c); },
      toggle(c, on) { if (on === undefined ? !this._c.has(c) : on) this._c.add(c); else this._c.delete(c); },
      contains(c) { return this._c.has(c); },
    },
    set innerHTML(v) { this._html = String(v); this.children = []; }, get innerHTML() { return this._html; },
    set className(v) { this._cls = v; }, get className() { return this._cls || ''; },
    appendChild(c) { this.children.push(c); return c; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    addEventListener() {}, setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    remove() {}, closest() { return null; },
  };
}

function loadApp() {
  const els = {};
  const noop = () => {};
  const calls = [];
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/', hash: '', reload: noop },
    document: {
      addEventListener: noop, body: fakeEl('body'),
      getElementById: (id) => (els[id] || (els[id] = fakeEl(id))),
      createElement: () => fakeEl(), querySelector: () => null, querySelectorAll: () => [],
    },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    setTimeout: () => 0, clearTimeout: noop,
    URL, URLSearchParams, Intl, Math, Date, JSON, Number, String, Array, Object, RegExp, Set, Map, Promise,
    isNaN, isFinite, parseInt, parseFloat,
    fetch: (url, init) => { calls.push({ url, init }); return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) }); },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(RULES_SRC, sandbox);
  vm.runInContext(FUNDER_SRC, sandbox);
  vm.runInContext(APP_SRC + `
    globalThis.__app = {
      get state() { return state; },
      SCREENS, allowedScreens, patientListRows, patientListRowHtml, pendingAdmissionRowHtml, patientLeadDetailsHtml,
      patientProblemChipsHtml, renderPatientsTab, pendingAdmissionRows, patientLeadPool, debtAgingTodayIso,
      normalizeLead, normalizePatient, normalizePayment, normalizeFunderRow, paymentId,
      PATIENT_LIST_DEFAULT_FILTERS,
    };`, sandbox);
  return { app: sandbox.__app, els, calls };
}

const { app } = loadApp();
const TODAY = app.debtAgingTodayIso();
const ago = (n) => { const d = new Date(TODAY + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
const EVIL = '<img src=x onerror=alert(1)>';

function seed(a, over) {
  const s = a.state;
  s.mode = 'edit';
  s.finance = true;
  s.view = 'full';
  s.leads = [
    a.normalizeLead({ id: 'L-A', name: 'אבי אלף', phone: '0501112233', house: 'רמות השבים', stage: 'admitted', source: 'גוגל',
      note: EVIL + '\nשורה שנייה', visitDate: ago(40), advance: 5000, assignedTo: 'ורד', meetingWith: 'מנהל' }),
    a.normalizeLead({ id: 'L-W', name: 'ממתין' + EVIL, phone: '0509998877', house: 'רעננה אשר', stage: 'paid', entryDate: ago(5), advance: 2000, source: 'חבר' }),
  ];
  s.irrelevantLeads = []; s.removedLeads = [];
  s.patients = [
    a.normalizePatient({ id: 'P-A', houseId: 'ramot', name: 'אבי אלף', date: ago(30), pay: 30000, status: 'active', fromLead: 'L-A' }),
    a.normalizePatient({ id: 'P-B', houseId: 'asher', name: 'בני' + EVIL, date: ago(10), pay: 30000, status: 'active', fromLead: '' }),
    a.normalizePatient({ id: 'P-C', houseId: 'ramot', name: 'גלי', date: ago(90), status: 'released', exitDate: ago(20), fromLead: '' }),
  ];
  s.payments = [];
  s.funders = [a.normalizeFunderRow({ patientId: 'P-A', funder: 'פרטי', effectiveFrom: ago(30), setBy: 'ורד', setAt: '2026-01-01T00:00:00Z' })];
  s.dischargedPatients = [];
  s.ptFilters = null;
  Object.assign(s, over || {});
}

/* ---------- 1. placement ---------- */

test('placement: «מטופלים» is the tab right after «לידים», with a red badge; no data-finance on it', () => {
  const tabs = [...HTML_SRC.matchAll(/<button class="tab[^"]*" data-screen="([^"]+)"([^>]*)>/g)].map((m) => ({ screen: m[1], attrs: m[2] }));
  const i = tabs.findIndex((t) => t.screen === 'leads');
  assert.equal(tabs[i + 1].screen, 'patients');
  assert.ok(!/data-finance|data-billing-control/.test(tabs[i + 1].attrs));
  assert.match(HTML_SRC, /data-screen="patients">מטופלים<span id="patients-problems-badge" class="tab-badge tab-badge-danger hidden"/);
  assert.match(HTML_SRC, /<section id="screen-patients" class="screen hidden">/);
  for (const id of ['plist-search', 'plist-house', 'plist-status', 'plist-problems', 'plist-summary', 'plist-pending', 'plist-list']) {
    assert.ok(HTML_SRC.includes(`id="${id}"`), id);
  }
  assert.match(HTML_SRC, /<option value="active">פעילים<\/option>\s*<option value="released">משוחררים<\/option>/);
  // «מטופלים משוחררים» stays as it is
  assert.match(HTML_SRC, /data-screen="discharged-patients">מטופלים משוחררים</);
});

test('router: SCREENS has «patients» after «leads»; restricted keeps it, the controller view never has it', () => {
  assert.deepEqual(plain(app.SCREENS).slice(0, 3), ['dashboard', 'leads', 'patients']);
  assert.ok(plain(app.allowedScreens(false, 'restricted')).includes('patients'));
  assert.ok(plain(app.allowedScreens(true, 'full')).includes('patients'));
  assert.ok(!plain(app.allowedScreens(false, 'controller')).includes('patients'));
  assert.ok(!plain(app.allowedScreens(false, 'controller', true)).includes('patients'));
});

/* ---------- 2/3. the row, finance vs restricted ---------- */

function rowsOf(a, filters) { return a.patientListRows(a.state, filters || {}, TODAY); }

test('finance + edit: funder cell with «הגדר גורם מממן», payment cell with «דווח תשלום» on an unpaid cycle', () => {
  const { app: a } = loadApp();
  seed(a);
  const rowA = rowsOf(a).find((r) => r.patient.id === 'P-A');
  const html = a.patientListRowHtml(rowA, true, true);
  assert.match(html, /<div class="plist-funder" data-finance><span class="p-label">גורם מממן<\/span><span class="p-val">פרטי<\/span>/);
  assert.ok(html.includes('הגדר גורם מממן'));
  assert.match(html, /class="plist-pay" data-finance/);
  assert.match(html, /pay-state-unpaid">לא שולם</);
  assert.ok(html.includes('class="btn small primary plist-report-btn">דווח תשלום</button>'));
  // view mode: no action buttons
  const view = a.patientListRowHtml(rowA, true, false);
  assert.ok(!view.includes('plist-report-btn') && !view.includes('plist-funder-btn'));
  // a paid cycle offers no report
  a.state.payments = [a.normalizePayment({ id: rowA.payment.dueISO && a.paymentId(rowA.patient, rowA.payment.dueISO),
    patientId: `ramot::אבי אלף::${rowA.patient.date}`, dueDate: rowA.payment.dueISO, amount: 30000, amountPaid: 30000, status: 'paid' })];
  const paid = a.patientListRowHtml(rowsOf(a).find((r) => r.patient.id === 'P-A'), true, true);
  assert.match(paid, /pay-state-paid">שולם</);
  assert.ok(!paid.includes('plist-report-btn'));
});

test('finance: an unset funder shows the amber «לא הוגדר» and the red «ללא גורם מממן» chip', () => {
  const { app: a } = loadApp();
  seed(a);
  const rowB = rowsOf(a).find((r) => r.patient.id === 'P-B');
  const html = a.patientListRowHtml(rowB, true, true);
  assert.match(html, /funder-chip funder-unset" data-funder="unset">לא הוגדר</);
  assert.match(html, /<span class="plist-chip" data-problem="no_funder">ללא גורם מממן<\/span>/);
  assert.match(html, /data-problem="no_payment">לא דווח תשלום</);
  assert.match(html, /data-problem="no_lead">ללא ליד</);
});

test('restricted (Shiran / Yael): no payment column, no funder cell or chip, no «דווח תשלום» — money data in memory or not', () => {
  for (const finance of [false, null]) {
    const { app: a } = loadApp();
    seed(a, { finance });
    a.state.payments = [a.normalizePayment({ id: 'x', patientId: 'asher::x::2026-01-01', status: 'paid', amountPaid: 1 })];
    rowsOf(a, { status: 'all' }).forEach((r) => {
      const html = a.patientListRowHtml(r, a.state.finance === true, true);
      for (const banned of ['data-finance', 'plist-report-btn', 'plist-funder-btn', 'גורם מממן', 'funder-chip', 'pay-state', 'plist-pay', 'לא דווח תשלום', 'no_funder', 'no_payment']) {
        assert.ok(!html.includes(banned), `finance=${finance} ${r.patient.id}: ${banned}`);
      }
    });
    // the non-finance chips still show
    assert.match(a.patientListRowHtml(rowsOf(a).find((r) => r.patient.id === 'P-B'), false, true), /data-problem="no_lead"/);
  }
});

test('a row: name, house (Hebrew), entry date, days in the house; ✏️ always, «שחזר» only on a released row', () => {
  const { app: a } = loadApp();
  seed(a);
  const all = rowsOf(a, { status: 'all' });
  const A = a.patientListRowHtml(all.find((r) => r.patient.id === 'P-A'), true, true);
  assert.ok(A.includes('אבי אלף') && A.includes('רמות השבים') && A.includes('ימים בבית'));
  assert.match(A, /<span class="p-label">ימים בבית<\/span><span class="p-val">30<\/span>/);
  assert.ok(A.includes('plist-edit-btn') && !A.includes('plist-restore-btn'));
  const C = a.patientListRowHtml(all.find((r) => r.patient.id === 'P-C'), true, true);
  assert.ok(C.includes('plist-restore-btn') && C.includes('>שחזר<'));
  assert.match(C, /<span class="p-label">ימים בבית<\/span><span class="p-val">70<\/span>/, 'entry → exit');
  assert.ok(C.includes('badge released'));
});

/* ---------- 4. «פרטי הליד» ---------- */

test('«פרטי הליד»: the lead travels with the patient — every field, notes escaped, inside a closed <details>', () => {
  const { app: a } = loadApp();
  seed(a);
  const html = a.patientLeadDetailsHtml(rowsOf(a).find((r) => r.patient.id === 'P-A'));
  assert.match(html, /^<details class="plist-lead"><summary>פרטי הליד<\/summary>/);
  for (const v of ['0501112233', 'גוגל', '₪ 5,000', 'ורד', 'מנהל', 'רמות השבים', 'משוייך ל', 'נפגש עם', 'הערות הליד', 'תאריך ביקור']) {
    assert.ok(html.includes(v), v);
  }
  assert.ok(!html.includes('<img'), 'the note is escaped');
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;\nשורה שנייה'));
});

test('«פרטי הליד»: «ללא ליד», a missing lead and an ambiguous match each say so', () => {
  const none = app.patientLeadDetailsHtml({ lead: null, leadInfo: { via: 'none' } });
  assert.match(none, /<summary>פרטי הליד · ללא ליד<\/summary><div class="plist-lead-none">ללא ליד<\/div>/);
  assert.match(app.patientLeadDetailsHtml({ lead: null, leadInfo: { via: 'fromLead_missing' } }), /הליד המקושר לא נמצא/);
  assert.match(app.patientLeadDetailsHtml({ lead: null, leadInfo: { via: 'ambiguous' } }), /נמצאו כמה לידים תואמים/);
});

/* ---------- 5. «ממתינים לקליטה» ---------- */

test('«ממתינים לקליטה»: name, house, entry date, days, phone, source, advance; #192 chip; «קלוט כמטופל» in edit only', () => {
  const { app: a } = loadApp();
  seed(a);
  const rows = a.pendingAdmissionRows(a.state.leads, a.state.patients, [], TODAY, a.patientLeadPool(a.state));
  assert.equal(rows.length, 1);
  const html = a.pendingAdmissionRowHtml(rows[0], true);
  for (const v of ['רעננה אשר', '0509998877', 'חבר', '₪ 2,000', 'ימים מהכניסה', 'קלוט כמטופל']) assert.ok(html.includes(v), v);
  assert.ok(html.includes('<span class="plist-chip">לא נקלט כמטופל · 5 ימים</span>'));
  assert.ok(!html.includes('<img'), 'the lead name is escaped');
  assert.ok(!a.pendingAdmissionRowHtml(rows[0], false).includes('קלוט כמטופל'), 'view mode');
});

/* ---------- 6/7. renderPatientsTab ---------- */

test('renderPatientsTab: summary, badge, count, pending section and the list (default: active only)', () => {
  const { app: a, els } = loadApp();
  seed(a);
  a.renderPatientsTab();
  // P-B: no funder, no payment, no lead. P-A: no payment reported in 30 days.
  assert.equal(els['patients-problems-badge'].textContent, '2');
  assert.equal(els['patients-problems-badge'].classList.contains('hidden'), false);
  assert.equal(els['plist-count'].textContent, '2');
  assert.equal(els['plist-list'].children.length, 2);
  assert.match(els['plist-summary'].innerHTML, /2 מטופלים פעילים עם בעיות פתוחות/);
  assert.match(els['plist-summary'].innerHTML, /ללא גורם מממן · 1/);
  assert.equal(els['plist-pending'].children.length, 2, 'the heading + one row');
  assert.equal(els['plist-pending'].children[0].textContent, 'ממתינים לקליטה (1)');
  assert.match(els['plist-house'].innerHTML, /<option value="">כל הבתים<\/option>/);
  els['plist-list'].children.forEach((c) => assert.ok(!c.innerHTML.includes('<img'), 'escaped'));
  // the filters
  a.state.ptFilters = { house: '', status: 'released', problemsOnly: false, q: '' };
  a.renderPatientsTab();
  assert.equal(els['plist-list'].children.length, 1);
  a.state.ptFilters = { house: 'ramot', status: 'active', problemsOnly: false, q: '' };
  a.renderPatientsTab();
  assert.equal(els['plist-list'].children.length, 1);
  assert.equal(els['plist-pending'].children.length, 0, 'pending follows the house filter');
});

test('renderPatientsTab: zero problems → badge hidden and the «אין בעיות פתוחות» line', () => {
  const { app: a, els } = loadApp();
  seed(a, { finance: false });
  a.state.patients = a.state.patients.filter((p) => p.id === 'P-A');
  a.renderPatientsTab();
  assert.equal(els['patients-problems-badge'].textContent, '0');
  assert.equal(els['patients-problems-badge'].classList.contains('hidden'), true);
  assert.match(els['plist-summary'].innerHTML, /אין בעיות פתוחות/);
});

test('renderPatientsTab: the controller view (Ortal) renders nothing', () => {
  const { app: a, els } = loadApp();
  seed(a, { view: 'controller', finance: false });
  a.renderPatientsTab();
  assert.equal(els['plist-list'], undefined);
  assert.equal(els['patients-problems-badge'], undefined);
});

/* ---------- 8. scope ---------- */

function uiBlock() {
  const start = APP_SRC.indexOf('/* ===== «מטופלים» — the patient list tab');
  const end = APP_SRC.indexOf('/* Build the discharged-patient audit row (pure');
  assert.ok(start > 0 && end > start);
  return APP_SRC.slice(start, end);
}

test('scope: the UI uses existing flows only — no new action, no write, no fetch', () => {
  const block = uiBlock();
  for (const banned of ['fetch(', 'apiPost', 'apiCall', 'saveAll', 'localStorage', 'action:']) assert.ok(!block.includes(banned), banned);
  for (const flow of ['openEditPatientModal(p)', 'openFunderModal(p)', 'openPaymentReportModal(p, paymentForPatientOnDate(p, due), due)',
    'openEntryModal(r.lead)', 'showRestorePatientChoiceModal(auditRowForReleasedPatient(p, state.dischargedPatients))']) {
    assert.ok(block.includes(flow), flow);
  }
  assert.ok(!GS_SRC.includes('renderPatientsTab') && !GS_SRC.includes('plist-'), 'Code.gs untouched');
  assert.match(APP_SRC, /renderKanban\(\);\n  renderPatientsTab\(\);/, 'renderAll draws it');
  assert.match(APP_SRC, /initPatientsTabFilters\(\);/);
});

test('scope: every interpolation in the UI block is escaped or a number/fixed label', () => {
  const block = uiBlock();
  const raw = [...block.matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1].trim())
    // an expression that routes its value through escapeHtml (incl. a ternary with a literal fallback) is fine
    .filter((e) => !/escapeHtml\(/.test(e) && !/^(patientLeadDetailsHtml|patientProblemChipsHtml|item|cells\.join|parts\.join|value|chips|body)\b/.test(e)
      && !/^(released|edit|L \?|r\.chipDays|summary\.byCode|pending\.length|canReport|chips \?)/.test(e));
  assert.deepEqual(raw, [], 'un-escaped interpolations: ' + raw.join(' | '));
});

test('styles: the plist rules exist, wrap at phone width, 44px targets; SW v45', () => {
  assert.match(CSS_SRC, /\.plist-row \{[\s\S]*?flex-direction: column;/);
  assert.match(CSS_SRC, /\.plist-chip \{[\s\S]*?color: var\(--danger\);/);
  assert.match(CSS_SRC, /\.plist-lead-note \.p-val \{[^}]*white-space: pre-wrap;/);
  assert.match(CSS_SRC, /@media \(max-width: 480px\) \{\n  \.plist-main \{ grid-template-columns: 1fr 1fr; \}/);
  assert.match(CSS_SRC, /\.plist-lead summary \{[\s\S]*?min-height: 44px;/);
  // v46: refund rule v2 (CHANGELOG-refund-rule-v2.md) bumped past it.
  const v = /var CACHE_VERSION = '(v\d+)';/.exec(SW_SRC)[1];
  assert.ok(Number(v.slice(1)) >= 45 && v !== 'v17', v);
});
