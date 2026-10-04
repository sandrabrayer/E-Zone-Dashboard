/* Patient funder (גורם מממן) on the Funders sheet. See
 * CHANGELOG-patient-funder-on-funders.md.
 *
 * Locked here:
 *   - NO default funder: Code.gs currentFunder_ / currentFunderFrom_ and the
 *     page answer 'unset' («לא הוגדר») for no row or an unrecognized label on
 *     the effective row — never 'פרטי'; a payment save that would have relied
 *     on the default is refused (funder_unset) — see also
 *     test/payment-report-foundation.test.js. Guard: no 'פרטי' literal in
 *     Code.gs outside PAYMENT_FUNDERS, none in app.js, no DEFAULT_FUNDER.
 *   - public/funder.js: LABEL_TO_KEY (== Code.gs PAYMENT_FUNDERS, exact
 *     strings), keyFromLabel, funderAt (== Code.gs currentFunderFrom_),
 *     debtByFunder — the five buckets sum to a REAL debtAging_ report's
 *     totals, per figure and per house
 *   - app.js, finance view only: the amber «לא הוגדר» on #176's card field;
 *     admission BLOCKED without a funder (direct add + admit-from-lead),
 *     appendFunder from the entry date, a failed write keeps the patient;
 *     the fill screen (non-released unset + released unset WITH open debt,
 *     tagged «שוחרר/ה · יתרה פתוחה», default effectiveFrom = entry date);
 *     the funder filter; the funder × house strip = the aging totals
 *   - restricted session: zero funder DOM, never appendFunder, admission allowed
 *   - SW v32 (v31 is taken by open PR #177), funder.js precached network-first, server.js route
 *
 * vm sandboxes on the real Code.gs, app.js, funder.js and the payment-report
 * rules. TZ pinned to Israel. All names are SYNTHETIC. */

process.env.TZ = 'Asia/Jerusalem';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadGs } = require('./helpers/gs-sandbox');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const GS_SRC = read('apps-script', 'Code.gs');
const APP_SRC = read('public', 'app.js');
const SW_SRC = read('public', 'sw.js');
const HTML_SRC = read('public', 'index.html');
const CSS_SRC = read('public', 'style.css');
const SERVER_SRC = read('server.js');
const RULES_SRC = read('lib', 'payment-report-rules.js');
const FUNDER_SRC = read('public', 'funder.js');
const Funder = require('../public/funder.js');
const rules = require('../lib/payment-report-rules.js');
const plain = (v) => JSON.parse(JSON.stringify(v));
const TODAY = '2026-09-30';
const LABELS = ['פרטי', 'ביטוח לאומי', 'משרד הביטחון', 'מכבי'];
const KEYS = ['private', 'btl', 'mod', 'maccabi'];
const FUNDERS = KEYS.concat(['unset']);
const KINDS = ['recorded_debt', 'unrecorded_cycles'];
const r2 = (n) => Math.round(n * 100) / 100;

const GS = loadGs();
const frow = (patientId, funder, effectiveFrom, setAt) => ({ patientId, funder, effectiveFrom, setBy: 'ורד', setAt: setAt || '2026-08-01T09:00:00+03:00' });

/* ============================ no default funder ============================ */

test('no default: Code.gs answers unset (never פרטי) for no row, before the first row, and for an unrecognized effective label', () => {
  assert.equal(GS.run('FUNDER_UNSET'), 'unset');
  assert.equal(GS.run('typeof DEFAULT_FUNDER'), 'undefined', 'DEFAULT_FUNDER is gone');
  const rows = [frow('p1', 'ביטוח לאומי', '2026-08-01'), frow('p1', 'כללית', '2026-09-10'), frow('p2', ' מכבי ', '2026-01-01')];
  const at = (id, d) => plain(GS.sandbox.currentFunderFrom_(rows, id, d));
  assert.deepEqual(at('p9', TODAY), { funder: 'unset', effectiveFrom: '', unset: true });
  assert.equal(at('p1', '2026-07-31').funder, 'unset');
  assert.equal(at('p1', '2026-09-01').funder, 'ביטוח לאומי');
  assert.equal(at('p1', '2026-09-10').funder, 'unset', 'the typo wins its date and reads as «לא הוגדר»');
  assert.equal(at('p2', TODAY).funder, 'מכבי', 'stored text is trimmed (paymentReportText_)');
  assert.equal(GS.sandbox.currentFunder_('p1', TODAY), 'unset', 'no Funders tab → unset');
});

test('guard: no \'פרטי\' fallback anywhere — Code.gs only in PAYMENT_FUNDERS, app.js not at all; no DEFAULT_FUNDER', () => {
  const quoted = /['"`]פרטי['"`]/g;
  const gsHits = GS_SRC.split('\n').filter((l) => quoted.test(l) && (quoted.lastIndex = 0, true));
  assert.deepEqual(gsHits, ["const PAYMENT_FUNDERS = ['פרטי', 'ביטוח לאומי', 'משרד הביטחון', 'מכבי'];"]);
  assert.equal((APP_SRC.match(quoted) || []).length, 0, 'app.js carries no funder label literal at all');
  for (const [name, src] of [['Code.gs', GS_SRC], ['app.js', APP_SRC], ['payment-report-rules.js', RULES_SRC]]) {
    assert.ok(!/\bDEFAULT_FUNDER\b/.test(src), name);
    assert.ok(!/ברירת מחדל\)/.test(src) || name !== 'app.js', name + ': no «(ברירת מחדל)» funder label');
  }
  assert.equal(rules.FUNDER_UNSET, 'unset');
});

test('guard: Code.gs PAYMENT_FUNDERS == funder.js LABEL_TO_KEY keys == the shared rules, exact strings, in order', () => {
  const gs = Array.from(GS.run('PAYMENT_FUNDERS'));
  assert.deepEqual(gs, LABELS);
  assert.deepEqual(Object.keys(Funder.LABEL_TO_KEY), gs);
  assert.deepEqual(Array.from(rules.PAYMENT_FUNDERS), gs);
  assert.deepEqual(Object.values(Funder.LABEL_TO_KEY), KEYS);
  assert.deepEqual([...Funder.FUNDER_KEYS], KEYS);
});

/* ============================ funder.js ============================ */

test('keyFromLabel: exact labels only; anything else → unset', () => {
  LABELS.forEach((l, i) => assert.equal(Funder.keyFromLabel(l), KEYS[i]));
  for (const bad of ['', ' פרטי', 'פרטי ', 'private', 'BTL', 'כללית', 'לא הוגדר', null, undefined, 0, {}, ['פרטי'], 'toString', '__proto__']) {
    assert.equal(Funder.keyFromLabel(bad), 'unset', JSON.stringify(bad));
  }
  assert.equal(Funder.labelFor('btl'), 'ביטוח לאומי');
  assert.equal(Funder.labelFor('unset'), 'לא הוגדר');
  assert.equal(Funder.labelFor('nope'), 'לא הוגדר');
});

test('funderAt: no row → unset; future ignored; mid-month switch; same day → later setAt, then later row; Date cell', () => {
  assert.equal(Funder.funderAt([], 'p1', TODAY), 'unset');
  assert.equal(Funder.funderAt(undefined, 'p1', TODAY), 'unset');
  const rows = [
    frow('p1', 'פרטי', '2026-07-01'),
    frow('p1', 'מכבי', '2026-08-15'),                                              // switch mid-month
    frow('p1', 'משרד הביטחון', '2026-12-01'),                                      // future
    frow('p2', 'ביטוח לאומי', '2026-08-01', '2026-08-03T10:00:00+03:00'),          // the correction…
    frow('p2', 'פרטי', '2026-08-01', '2026-08-02T10:00:00+03:00'),                 // …listed after the mistake
    frow('p3', 'פרטי', '2026-08-01', 'same'), frow('p3', 'מכבי', '2026-08-01', 'same'),   // tie → later row
    { patientId: 'p4', funder: 'מכבי', effectiveFrom: new Date(2026, 7, 15) },      // Sheets Date cell, 15/08 Israel
  ];
  assert.equal(Funder.funderAt(rows, 'p1', '2026-06-30'), 'unset');
  assert.equal(Funder.funderAt(rows, 'p1', '2026-08-14'), 'private');
  assert.equal(Funder.funderAt(rows, 'p1', '2026-08-15'), 'maccabi');
  assert.equal(Funder.funderAt(rows, 'p1', TODAY), 'maccabi', 'the December row is future');
  assert.equal(Funder.funderAt(rows, 'p2', '2026-08-01'), 'btl', 'later setAt wins');
  assert.equal(Funder.funderAt(rows, 'p3', '2026-08-01'), 'maccabi', 'same setAt → the later row');
  assert.equal(Funder.funderAt(rows, 'p4', '2026-08-14'), 'unset');
  assert.equal(Funder.funderAt(rows, 'p4', '2026-08-15'), 'maccabi');
  assert.equal(Funder.funderAt(rows.concat([frow('p1', 'כללית', '2026-09-01')]), 'p1', TODAY), 'unset', 'an unrecognized effective label');
});

test('funderAt == Code.gs currentFunderFrom_ on every day of a mixed history (labels → keys)', () => {
  const rows = [
    frow('p1', 'פרטי', '2026-07-01'), frow('p1', 'מכבי', '2026-08-15'), frow('p1', 'כללית', '2026-09-05'),
    frow('p1', 'ביטוח לאומי', '2026-09-20'), frow('p1', 'משרד הביטחון', '2026-09-20', '2026-09-21T08:00:00+03:00'),
    frow('p2', 'מכבי', 'לא תאריך'),
  ];
  for (let d = new Date(Date.UTC(2026, 5, 25)); d <= new Date(Date.UTC(2026, 9, 5)); d.setUTCDate(d.getUTCDate() + 1)) {
    const iso = d.toISOString().slice(0, 10);
    for (const id of ['p1', 'p2', 'p3']) {
      const gs = plain(GS.sandbox.currentFunderFrom_(rows, id, iso)).funder;
      assert.equal(Funder.funderAt(rows, id, iso), gs === 'unset' ? 'unset' : Funder.keyFromLabel(gs), id + ' ' + iso);
    }
  }
});

/* ---- a REAL debtAging_ report ---- */
const AVI = 'ramot::אבי בדיקה::2026-07-10';
const GAL = 'rehab::גל בדיקה::2026-08-05';
const AGING_PATIENTS = [
  { id: 'id-p1', houseId: 'ramot', name: 'אבי בדיקה', date: '2026-07-10', pay: 30000, status: 'active' },
  { id: 'id-p2', houseId: 'rehab', name: 'גל בדיקה', date: '2026-08-05', pay: 20000, status: 'active' },
  { id: 'id-p7', houseId: 'arfoni', name: 'בת בדיקה', date: '2026-06-20', pay: 35000, status: 'active' },
  { id: 'id-p8', houseId: 'pardes', name: 'נועה בדיקה', date: '2026-07-15', pay: 28000, status: 'released', exitDate: '2026-08-20' },
  { id: 'id-p9', houseId: 'ramot', name: 'הדס בדיקה', date: '2026-07-01', pay: 30000, status: 'active' },
  { id: '', houseId: 'asher', name: 'בלי מזהה', date: '2026-08-10', pay: 12000, status: 'active' },
];
const pay = (pid, due, f) => Object.assign({ id: 'pay::' + pid + '::' + due, patientId: pid, patientName: pid.split('::')[1], houseId: pid.split('::')[0], dueDate: due }, f);
const AGING_PAYMENTS = [
  pay(AVI, '2026-07-10', { amount: 30000, status: 'paid', amountPaid: 30000, chargedAt: '2026-07-12T10:00:00+03:00' }),
  pay(AVI, '2026-09-10', { amount: 30000, status: 'unpaid', amountPaid: 0 }),
  pay(GAL, '2026-09-05', { amount: 20000, status: 'partial', amountPaid: 12000, chargedAt: '2026-09-06T09:00:00+03:00' }),
];
function realAging(asOf) {
  const rows = (l) => ({ rows: l.map((obj, i) => ({ rowNumber: i + 2, obj: Object.assign({}, obj) })) });
  return plain(GS.sandbox.debtAging_(asOf, { patients: rows(AGING_PATIENTS), payments: rows(AGING_PAYMENTS), credits: rows([]), overrides: rows([]) }));
}
const HIST = [
  frow('id-p1', 'פרטי', '2026-07-01'), frow('id-p1', 'ביטוח לאומי', '2026-09-01'),   // switch mid-stay
  frow('id-p7', 'מכבי', '2026-06-01'),
  frow('id-p8', 'משרד הביטחון', '2026-08-01'),                                       // from mid-stay
  frow('id-p9', 'כללית', '2026-07-01'),                                               // unrecognized → unset
];

test('debtByFunder: per figure the five buckets sum EXACTLY to the report totals and per house to byHouse (3 as-of dates, history and none)', () => {
  for (const asOf of ['2026-08-31', '2026-09-15', TODAY]) {
    const report = realAging(asOf);
    assert.equal(report.ok, true);
    for (const hist of [HIST, []]) {
      const split = Funder.debtByFunder(report, hist, asOf);
      assert.deepEqual(Object.keys(split).sort(), [...FUNDERS].sort());
      for (const k of KINDS) {
        assert.equal(r2(FUNDERS.reduce((s, f) => s + split[f][k].total, 0)), report.totals[k].total, asOf + ' ' + k);
        assert.equal(FUNDERS.reduce((s, f) => s + split[f][k].count, 0), report.totals[k].count);
        for (const h of report.byHouse) {
          assert.equal(r2(FUNDERS.reduce((s, f) => s + (((split[f].byHouse[h.houseId] || {})[k]) || { total: 0 }).total, 0)), h[k].total, h.houseId);
        }
        for (const f of FUNDERS) assert.deepEqual(Object.keys(split[f]).sort(), ['byHouse', 'recorded_debt', 'unrecorded_cycles'], 'never one summed figure');
      }
      if (!hist.length) for (const k of KINDS) assert.equal(split.unset[k].total, report.totals[k].total, 'no history → all unset');
    }
  }
  const s = Funder.debtByFunder(realAging(TODAY), HIST);
  assert.ok(s.btl.recorded_debt.total > 0, 'id-p1 10/09 → ביטוח לאומי');
  assert.ok(s.maccabi.unrecorded_cycles.total > 0);
  assert.ok(s.unset.unrecorded_cycles.total > 0, 'id-p9 (unrecognized), id-p2 and the id-less patient');
  assert.throws(() => Funder.debtByFunder(null, []), TypeError);
  assert.throws(() => Funder.debtByFunder(realAging(TODAY), [], '2026-09-29'), RangeError);
});

/* ============================ app.js harness ============================ */

function fakeEl(id) {
  return {
    id: id || '', _html: '', textContent: '', value: '', children: [], style: {}, dataset: {},
    classList: {
      _c: new Set(['hidden']),
      add(c) { this._c.add(c); }, remove(c) { this._c.delete(c); },
      toggle(c, on) { if (on === undefined ? !this._c.has(c) : on) this._c.add(c); else this._c.delete(c); },
      contains(c) { return this._c.has(c); },
    },
    set innerHTML(v) { this._html = String(v); this.children = []; }, get innerHTML() { return this._html; },
    appendChild(c) { this.children.push(c); return c; },
    querySelector() { return fakeEl(); }, querySelectorAll() { return []; },
    addEventListener() {}, setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    remove() {}, closest() { return null; },
  };
}

function loadApp(opts) {
  const o = opts || {};
  const els = {};
  const calls = [];
  const noop = () => {};
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
    URL, URLSearchParams, Math, Date, JSON, Number, String, Array, Object, RegExp, Promise, Set, Map, Intl,
    fetch: (url, init) => {
      const body = init && init.body ? JSON.parse(init.body) : null;
      calls.push({ url, body });
      const payload = o.answer ? o.answer(body) : { ok: true };
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) });
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(RULES_SRC, sandbox);
  if (o.funder !== false) vm.runInContext(FUNDER_SRC, sandbox);
  vm.runInContext(APP_SRC + `
    globalThis.__errors = []; globalThis.__modal = null; globalThis.__saves = 0;
    showError = (m) => { globalThis.__errors.push(String(m)); };
    showToast = () => {};
    lockBusyDelay = () => Promise.resolve();
    renderAll = () => {};
    showModal = (m) => { globalThis.__modal = m; };
    saveAll = async () => { globalThis.__saves++; if (globalThis.__saveFails) throw new Error('boom'); return { ok: true }; };
    todayISO = () => '${TODAY}';
    globalThis.__test = {
      get state() { return state; },
      funderView, funderLib, currentFunderFor, funderLabel, patientFunderCellHtml, patientFunderKey,
      admissionFunderError, admissionFunderFields, funderEffectiveFromEntry, saveAdmissionFunder, saveFunder,
      openDebtPatientIds, funderFillRows, funderFillHtml, renderFunderFill, funderFilterMatch, billingRowFunderKey,
      filterDebtReportByFunder, debtFunderStrip, debtFunderStripHtml, debtAgingView, renderDebtAging,
      renderPatients, openDirectAddPatientModal, openEntryModal, openFunderModal, paymentReportDefaults,
      applyView, normalizePatient, normalizePayment, normalizeFunderRow,
      stubShowScreen(fn) { showScreen = fn; },
      modal: () => globalThis.__modal, errors: () => globalThis.__errors, saves: () => globalThis.__saves,
      setSaveFails(v) { globalThis.__saveFails = v; },
    };`, sandbox);
  const app = sandbox.__test;
  app.state.finance = o.finance === undefined ? true : o.finance;
  app.state.mode = 'edit';
  app.state.leads = []; app.state.patients = []; app.state.payments = [];
  app.state.funders = (o.funders || []).map(app.normalizeFunderRow);
  const sent = (action) => calls.filter((c) => c.body && c.body.action === action);
  return { app, els, calls, sent };
}

const P1 = { id: 'id-p1', houseId: 'ramot', name: 'אבי בדיקה', date: '2026-07-10', pay: 30000, adv: 0, status: 'active' };
const P2 = { id: 'id-p2', houseId: 'ramot', name: 'גל בדיקה', date: '2026-08-05', pay: 20000, adv: 0, status: 'trial' };
const P3 = { id: 'id-p3', houseId: 'asher', name: 'רון בדיקה', date: '2026-06-01', pay: 15000, adv: 0, status: 'released', exitDate: '2026-08-31' };

function patientsHtml(h) {
  h.app.state.currentHouseTab = 'ramot';
  h.app.state.showReleasedPatients = true;
  h.app.state.patientSearch = '';
  h.app.renderPatients();
  return h.els['patients-list'].children.map((c) => c.innerHTML).join('\n');
}

/* ============================ restricted ============================ */

for (const finance of [false, null]) {
  test(`restricted (finance=${finance}): zero funder DOM, never appendFunder, admission allowed`, async () => {
    const h = loadApp({ finance, funders: [frow('id-p1', 'ביטוח לאומי', '2026-07-01')] });
    h.app.state.patients = [P1, P2].map(h.app.normalizePatient);
    assert.equal(h.app.funderView(), false);
    const html = patientsHtml(h);
    assert.ok(html.includes('אבי בדיקה'), 'the card renders');
    assert.ok(!/funder|גורם מממן|לא הוגדר|ביטוח לאומי/.test(html), html);
    assert.equal(h.app.patientFunderCellHtml(h.app.state.patients[0]), '');
    assert.deepEqual(plain(h.app.admissionFunderFields()), []);
    h.app.renderFunderFill();
    assert.equal(h.els['funder-fill'].innerHTML, '');
    assert.equal(h.els['funder-fill'].classList.contains('hidden'), true);
    h.app.state.debtAging = { status: 'ok', asOf: TODAY, house: 'all', statusFilter: 'all', data: realAging(TODAY), error: '', seq: 1 };
    h.app.state.billingFunder = 'btl';
    h.app.renderDebtAging();
    assert.ok(!/funder/.test(h.els['debt-aging'].innerHTML), 'no strip, no funder filter');
    h.app.openDirectAddPatientModal();
    assert.ok(!h.app.modal().fields.some((f) => f.name === 'funder'));
    assert.equal(await h.app.modal().onSubmit({ name: 'חדש', houseId: 'ramot', date: '2026-09-29', pay: '1000', status: 'active', notes: '' }), true);
    assert.equal(h.app.saves(), 1, 'admitted without a funder');
    h.app.openFunderModal(h.app.state.patients[0]);
    await assert.rejects(h.app.saveFunder(h.app.state.patients[0], 'מכבי', '2026-09-01'));
    assert.equal(h.sent('appendFunder').length, 0, 'never appendFunder');
  });
}

test('restricted: applyView(false) drops the funders from memory', () => {
  const h = loadApp({ funders: [frow('id-p1', 'מכבי', '2026-07-01')] });
  h.app.stubShowScreen(() => {});
  h.app.applyView(false);
  assert.deepEqual(plain(h.app.state.funders), []);
  assert.equal(h.app.funderView(), false);
});

/* ============================ finance: card ============================ */

test('card (#176 field): «לא הוגדר» amber when unset — never «פרטי (ברירת מחדל)»; the label when set; no second chip/editor', () => {
  const h = loadApp({ funders: [frow('id-p1', 'ביטוח לאומי', '2026-07-01')] });
  h.app.state.patients = [P1, P2].map(h.app.normalizePatient);
  const html = patientsHtml(h);
  assert.equal((html.match(/class="patient-funder"/g) || []).length, 2, 'one funder field per card');
  assert.equal((html.match(/funder-edit-btn/g) || []).length, 2, 'one editor button per card');
  assert.match(html, /ביטוח לאומי/);
  assert.match(html, /<span class="funder-chip funder-unset" data-funder="unset">לא הוגדר<\/span>/);
  assert.ok(!/ברירת מחדל/.test(html));
  const none = h.app.currentFunderFor('id-p2');
  assert.deepEqual(plain(none), { funder: 'unset', effectiveFrom: '', unset: true });
  assert.equal(h.app.funderLabel(none), 'לא הוגדר');
  // the report form: an unset patient's funder starts EMPTY (the report must name one)
  const d = h.app.paymentReportDefaults(h.app.state.patients[1], h.app.normalizePayment({ id: 'c1', dueDate: '2026-09-05', amount: 20000 }), '2026-09-05', TODAY);
  assert.equal(d.report.funder, '');
  assert.match(CSS_SRC, /\.funder-chip\.funder-unset \{\s*background: rgba\(255,176,32,\.18\)/);
});

/* ============================ finance: admission ============================ */

test('admission: BLOCKED without a funder (direct add + admit-from-lead); values are the stored labels', async () => {
  const h = loadApp();
  h.app.openDirectAddPatientModal();
  const f = h.app.modal().fields.find((x) => x.name === 'funder');
  assert.ok(f && f.required === true);
  assert.deepEqual(Array.from(f.options, (o) => o.value), [''].concat(LABELS));
  for (const bad of ['', 'private', 'כללית', ' פרטי']) {
    assert.equal(await h.app.modal().onSubmit({ name: 'חדש', houseId: 'ramot', date: '2026-09-29', pay: '1000', status: 'active', notes: '', funder: bad }), false, bad);
  }
  assert.ok(h.app.errors().includes('יש לבחור גורם מממן'));
  const lead = { id: 'L1', name: 'ליד', house: 'רמות השבים', stage: 'entry', advance: 0, entryDate: '2026-09-28' };
  h.app.state.leads = [lead];
  h.app.openEntryModal(lead);
  assert.ok(h.app.modal().fields.some((x) => x.name === 'funder' && x.required));
  assert.equal(await h.app.modal().onSubmit({ houseId: 'ramot', date: '2026-09-28', pay: '1000', adv: '0', status: 'trial', funder: '' }), false);
  assert.equal(h.app.saves(), 0, 'nothing saved');
  assert.equal(h.sent('appendFunder').length, 0);
  assert.equal(h.app.admissionFunderError(false, ''), '', 'restricted: allowed');
  assert.equal(h.app.admissionFunderError(null, ''), '', 'unknown: allowed');
});

test('admission with a funder → saveAll, then appendFunder from the ENTRY date (both paths)', async () => {
  const h = loadApp({ answer: (b) => (b.action === 'appendFunder'
    ? { ok: true, row: Object.assign({ setBy: 'ורד', setAt: '2026-09-30T12:00:00+03:00' }, b.funder) } : { ok: true }) });
  h.app.openDirectAddPatientModal();
  assert.equal(await h.app.modal().onSubmit({ name: 'חדש', houseId: 'ramot', date: '2026-07-15', pay: '1000', status: 'active', notes: '', funder: 'משרד הביטחון' }), true);
  const pid = h.app.state.patients[0].id;
  assert.deepEqual(h.sent('appendFunder')[0].body.funder, { patientId: pid, funder: 'משרד הביטחון', effectiveFrom: '2026-07-15' });
  assert.equal(h.app.currentFunderFor(pid).funder, 'משרד הביטחון');
  const lead = { id: 'L2', name: 'ליד', house: 'רמות השבים', stage: 'entry', advance: 0, entryDate: '2026-10-02' };
  h.app.state.leads = [lead];
  h.app.openEntryModal(lead);
  assert.equal(await h.app.modal().onSubmit({ houseId: 'ramot', date: '2026-10-02', pay: '1000', adv: '0', status: 'trial', funder: 'מכבי' }), true);
  assert.equal(h.sent('appendFunder')[1].body.funder.effectiveFrom, '2026-10-02', 'appendFunder_ has no future limit: the entry date as is');
});

test('admission: patient saved, funder write fails → patient kept, Hebrew error, «לא הוגדר» + on the fill screen', async () => {
  const h = loadApp({ answer: (b) => (b.action === 'appendFunder' ? { ok: false, error: 'patient_id_invalid', message: 'מטופל לא מזוהה — יש לשמור את המטופל קודם' } : { ok: true }) });
  h.app.openDirectAddPatientModal();
  assert.equal(await h.app.modal().onSubmit({ name: 'חדש', houseId: 'ramot', date: '2026-09-01', pay: '1000', status: 'active', notes: '', funder: 'מכבי' }), true);
  assert.equal(h.app.state.patients.length, 1);
  assert.ok(h.app.errors().some((e) => e === 'המטופל נשמר, אך שמירת הגורם המממן נכשלה — מטופל לא מזוהה — יש לשמור את המטופל קודם'), h.app.errors().join('|'));
  assert.equal(h.app.currentFunderFor(h.app.state.patients[0].id).unset, true);
  h.app.renderFunderFill();
  assert.match(h.els['funder-fill'].innerHTML, /data-funder-fill-count>1</);
  // a failed patient save never sends the funder
  const g = loadApp();
  g.app.setSaveFails(true);
  g.app.openDirectAddPatientModal();
  assert.equal(await g.app.modal().onSubmit({ name: 'חדש', houseId: 'ramot', date: '2026-09-01', pay: '1000', status: 'active', notes: '', funder: 'מכבי' }), false);
  assert.equal(g.sent('appendFunder').length, 0);
});

/* ============================ fill screen ============================ */

test('fill screen: non-released unset + released unset WITH open debt (aging report or «יתרות פתוחות»), tagged; default = entry date', () => {
  const h = loadApp({ funders: [frow('id-p2', 'מכבי', '2026-08-05')] });
  const P4 = { id: 'id-p4', houseId: 'arfoni', name: '<b>שם</b>', date: '2026-09-01', pay: 1, adv: 0, status: 'wait' };
  const R1 = { id: 'id-r1', houseId: 'ramot', name: 'שוחרר עם חוב', date: '2026-07-01', pay: 1, status: 'released', exitDate: '2026-08-20' };
  const R2 = { id: 'id-r2', houseId: 'ramot', name: 'שוחרר יתרה', date: '2026-06-01', pay: 1, status: 'released', exitDate: '2026-08-01' };
  const R3 = { id: 'id-r3', houseId: 'ramot', name: 'שוחרר בלי חוב', date: '2026-06-01', pay: 1, status: 'released', exitDate: '2026-07-01' };
  h.app.state.patients = [P1, P2, P3, P4, R1, R2, R3].map(h.app.normalizePatient);
  const report = { ok: true, asOf: TODAY, byPatient: [{ patientId: 'id-r1', houseId: 'ramot', cycles: [{ start: '2026-08-01', balance: 5000, kind: 'unrecorded' }] },
    { patientId: 'id-r3', houseId: 'ramot', cycles: [{ start: '2026-06-01', balance: 0, kind: 'recorded' }] }] };
  const payments = [
    h.app.normalizePayment({ id: 'x1', patientUid: 'id-r2', patientId: 'ramot::שוחרר יתרה::2026-06-01', houseId: 'ramot', dueDate: '2026-07-01', amount: 100, status: 'partial', amountPaid: 50 }),
    h.app.normalizePayment({ id: 'x2', patientUid: 'id-r3', dueDate: '2026-06-01', amount: 100, status: 'paid', amountPaid: 100 }),
    h.app.normalizePayment({ id: 'x3', patientUid: 'id-r3', dueDate: '2026-06-01', amount: 100, status: 'void', amountPaid: 0 }),
  ];
  const ids = plain(h.app.openDebtPatientIds(report, payments, h.app.state.patients, TODAY));
  assert.deepEqual(Array.from(Object.keys(ids)).sort(), ['id-r1', 'id-r2']);
  const rows = h.app.funderFillRows(h.app.state.patients, h.app.state.funders, TODAY, ids);
  assert.deepEqual(Array.from(rows, (r) => r.patient.id), ['id-p4', 'id-p1', 'id-r2', 'id-r1'],
    'unset only (id-p2 has מכבי); P3 / R3 released without debt are out; HOUSES order then name');
  assert.deepEqual(Array.from(rows, (r) => r.released), [false, false, true, true]);
  assert.equal(rows.find((r) => r.patient.id === 'id-p1').defaultFrom, '2026-07-10', 'the entry date');
  assert.equal(rows.find((r) => r.patient.id === 'id-r2').defaultFrom, '2026-06-01');
  const html = h.app.funderFillHtml(rows);
  assert.match(html, /השלמת גורם מממן — <span class="count-pill" data-funder-fill-count>4<\/span> נותרו/);
  assert.equal((html.match(/שוחרר\/ה · יתרה פתוחה/g) || []).length, 2);
  assert.ok(html.includes('&lt;b&gt;שם&lt;/b&gt;') && !html.includes('<b>שם</b>'), 'escaped');
  assert.match(html, /<input type="date" data-fill-from value="2026-07-10" \/>/);
  // the page reads the loaded aging report + payments itself
  h.app.state.payments = payments;
  h.app.state.debtAging = { status: 'ok', asOf: TODAY, data: report };
  h.app.renderFunderFill();
  assert.match(h.els['funder-fill'].innerHTML, /data-funder-fill-count>4</);
  assert.equal(h.els['funder-fill'].classList.contains('hidden'), false);
  // everyone set → hidden
  h.app.state.funders = ['id-p1', 'id-p4', 'id-r1', 'id-r2'].map((id) => h.app.normalizeFunderRow(frow(id, 'פרטי', '2026-01-01'))).concat(h.app.state.funders);
  h.app.renderFunderFill();
  assert.equal(h.els['funder-fill'].innerHTML, '');
  assert.equal(h.els['funder-fill'].classList.contains('hidden'), true);
});

/* ============================ filter + strip ============================ */

test('strip: funder × house totals EQUAL the aging totals — per figure, per house, with house / status filters', () => {
  const h = loadApp({ funders: HIST });
  for (const asOf of ['2026-09-15', TODAY]) {
    const data = realAging(asOf);
    for (const filters of [{ house: 'all', status: 'all' }, { house: 'ramot', status: 'all' }, { house: 'all', status: 'discharged' }]) {
      const strip = h.app.debtFunderStrip(data, h.app.state.funders, filters);
      const view = h.app.debtAgingView(data, filters);
      for (const k of KINDS) {
        assert.equal(strip[k].totals.total, view.tables[k].totals.total, asOf + ' ' + JSON.stringify(filters) + ' ' + k);
        for (const r of view.tables[k].rows) assert.equal(strip[k].totals.byHouse[r.houseId], r.total, r.houseId);
        assert.deepEqual(Array.from(strip[k].rows, (r) => r.funder), FUNDERS);
      }
      if (filters.house === 'all' && filters.status === 'all') for (const k of KINDS) assert.equal(strip[k].totals.total, data.totals[k].total);
    }
  }
  const html = h.app.debtFunderStripHtml(h.app.debtFunderStrip(realAging(TODAY), h.app.state.funders, {}));
  assert.equal((html.match(/class="funder-strip-block"/g) || []).length, 2, 'two tables, never one summed figure');
  assert.ok(html.includes('<span class="funder-chip funder-unset">לא הוגדר</span>'));
});

test('filter: keeps exactly that funder\'s cycles; the five filtered views add up to the whole; billing rows by due date', () => {
  const h = loadApp({ funders: HIST });
  const data = realAging(TODAY);
  const strip = h.app.debtFunderStrip(data, h.app.state.funders, {});
  const all = h.app.debtAgingView(data, {});
  assert.equal(h.app.filterDebtReportByFunder(data, h.app.state.funders, 'all'), data);
  const sum = { recorded_debt: 0, unrecorded_cycles: 0 };
  for (const f of FUNDERS) {
    const v = h.app.debtAgingView(h.app.filterDebtReportByFunder(data, h.app.state.funders, f), {});
    for (const k of KINDS) {
      assert.equal(v.tables[k].totals.total, strip[k].rows.find((r) => r.funder === f).total, f + ' ' + k);
      sum[k] = r2(sum[k] + v.tables[k].totals.total);
    }
  }
  for (const k of KINDS) assert.equal(sum[k], all.tables[k].totals.total);
  const p = h.app.normalizePatient(P1);
  assert.equal(h.app.billingRowFunderKey(p, '2026-08-10'), 'private');
  assert.equal(h.app.billingRowFunderKey(p, '2026-09-10'), 'btl');
  assert.equal(h.app.billingRowFunderKey({ name: 'בלי מזהה', houseId: 'ramot' }, '2026-09-10'), 'unset');
  assert.equal(h.app.funderFilterMatch('unset', 'unset'), true);
  assert.equal(h.app.funderFilterMatch('btl', 'mod'), false);
  assert.match(APP_SRC, /funderFilterMatch\(funderFilter, billingRowFunderKey\(d\.patient, selected\)\)/);
  assert.match(APP_SRC, /funderFilterMatch\(funderFilter, billingRowFunderKey\(o\.patient, o\.pay\.dueDate\)\)/);
  // the debt view: strip on top, blocks follow the filter
  h.app.state.debtAging = { status: 'ok', asOf: TODAY, house: 'all', statusFilter: 'all', data, error: '', seq: 1 };
  h.app.state.billingFunder = 'maccabi';
  h.app.renderDebtAging();
  const out = h.els['debt-aging'].innerHTML;
  assert.equal(out.indexOf('<div class="funder-strip" data-finance>'), 0);
  assert.ok(out.includes('data-patient="id-p7"') && !out.includes('data-patient="id-p1"'), 'only מכבי cycles below');
});

/* ============================ wiring ============================ */

test('wiring: funder.js before app.js, server route; filter + fill inside the finance-only screen; no new data-finance node', () => {
  const f = HTML_SRC.indexOf('<script src="funder.js?v=__BUILD__"></script>');
  assert.ok(f > 0 && f < HTML_SRC.indexOf('<script src="app.js?v=__BUILD__"></script>'));
  assert.match(SERVER_SRC, /app\.get\('\/funder\.js', sendStatic\('funder\.js', 'application\/javascript'\)\)/);
  const billing = HTML_SRC.indexOf('<section id="screen-billing" class="screen hidden" data-finance>');
  const end = HTML_SRC.indexOf('</section>', billing);
  for (const id of ['id="billing-funder"', 'id="funder-fill"']) {
    const at = HTML_SRC.indexOf(id);
    assert.ok(at > billing && at < end, id);
  }
  assert.equal((HTML_SRC.match(/ data-finance[ >]/g) || []).length, 10);
  assert.ok(!/setPatientFunder|FunderHistory/.test(GS_SRC + APP_SRC + SERVER_SRC), 'no second funder model');
});

test('SW: v32 or later (from v30; v31 belongs to #177, never v17); funder.js precached and network-first', () => {
  // v32 shipped this change; PR #179 («בקרת גבייה») bumped it to v33 on top.
  assert.ok(Number((SW_SRC.match(/var CACHE_VERSION = 'v(\d+)';/) || [])[1]) >= 32);
  assert.ok(SW_SRC.includes('v31 → v32:'));
  assert.ok(/var PRECACHE_URLS = \[[\s\S]*?'\/funder\.js'[\s\S]*?\];/.test(SW_SRC));
  const sandbox = { self: { addEventListener() {} }, module: { exports: {} }, URL, caches: {}, fetch() {} };
  vm.createContext(sandbox);
  vm.runInContext(SW_SRC, sandbox);
  assert.equal(sandbox.module.exports.cacheStrategy('/funder.js?v=abc'), 'network-first');
  assert.equal(sandbox.module.exports.cacheStrategy('/api/sheets'), 'network-only');
});

test('CSS: ≥ 44px funder controls and a 360px wrap; every funder render escapes', () => {
  assert.match(CSS_SRC, /#billing-funder,\s*\.funder-fill select, \.funder-fill input\[type="date"\], \.funder-fill \.btn,\s*\.funder-edit-btn \{\s*min-height: 44px;/);
  assert.match(CSS_SRC, /@media \(max-width: 480px\) \{\s*\.billing-row\.funder-fill-row > div,\s*\.funder-fill-row \.funder-field \{ min-width: 100%; \}/);
  const block = APP_SRC.slice(APP_SRC.indexOf('/* ===== Patient funder (גורם מממן) on the Funders sheet ====='), APP_SRC.indexOf('function initFunderControls()'));
  const raw = [...block.matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1].trim())
    .filter((e) => !/^esc\(|^escapeHtml\(|^o\.(label|value)$|^opts$|^table\(|^\(released \?|^\(r\.funder === FUNDER_UNSET_KEY/.test(e));
  assert.deepEqual(raw, []);
});
