/* The institutional-funder grace period (Sandra, 07/10/2026).
 * CHANGELOG-funder-grace.md.
 *
 * Locked here:
 *   - FUNDER_GRACE_DAYS = 30; the funders ביטוח לאומי, מכבי, משרד הביטחון;
 *     today − due ≤ 30 → «ממתין לגורם מממן» (not a problem), 31 → normal;
 *   - private unchanged, pro-bono still excluded, unset unchanged;
 *   - lib/funder-grace.js ⇄ Code.gs isWithinFunderGrace_ parity;
 *   - debtAging_: grace cycles are FLAGGED (funderGrace / funderGraceUntil,
 *     funderGrace summary) — totals, byHouse, byPatient and buckets unchanged;
 *   - the page: «לא דווח תשלום» chip + problem count, the patient row's
 *     payment cell, the גבייה row status / colour, the overdue strip, the
 *     debt-aging column and the .xlsx column;
 *   - mutation checks.
 *
 * vm sandboxes on the real Code.gs, app.js, funder.js and lib. TZ pinned to
 * Israel. All names are SYNTHETIC. */

process.env.TZ = 'Asia/Jerusalem';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadGs, GS_SRC } = require('./helpers/gs-sandbox');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const APP_SRC = read('public', 'app.js');
const FUNDER_SRC = read('public', 'funder.js');
const RULES_SRC = read('lib', 'payment-report-rules.js');
const LIB_SRC = read('lib', 'funder-grace.js');
const SERVER_SRC = read('server.js');
const INDEX_SRC = read('public', 'index.html');
const SW_SRC = read('public', 'sw.js');
const CSS_SRC = read('public', 'style.css');
const lib = require('../lib/funder-grace.js');
const Funder = require('../public/funder.js');
const debtXlsx = require('../lib/debt-aging-xlsx.js');
const plain = (v) => JSON.parse(JSON.stringify(v));
const r2 = (n) => Math.round(n * 100) / 100;

const TODAY = '2026-10-07';
const GS = loadGs();
const GRACE_LABELS = ['ביטוח לאומי', 'מכבי', 'משרד הביטחון'];

/* Day n after (or before, n < 0) an ISO day. */
const plus = (iso, n) => new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) + n * 86400000).toISOString().slice(0, 10);

/* ============================ the rule ============================ */

test('guard: FUNDER_GRACE_DAYS = 30 and the three institutional funders — Code.gs == lib == funder.js keys', () => {
  assert.equal(GS.run('FUNDER_GRACE_DAYS'), 30);
  assert.equal(lib.FUNDER_GRACE_DAYS, 30);
  assert.deepEqual(Array.from(GS.run('FUNDER_GRACE_FUNDERS')), GRACE_LABELS);
  assert.deepEqual(Object.keys(lib.FUNDER_GRACE_SHEET_LABELS).sort(), GRACE_LABELS.slice().sort());
  // the labels are real PAYMENT_FUNDERS entries, and map to funder.js's keys
  for (const label of GRACE_LABELS) {
    assert.ok(Array.from(GS.run('PAYMENT_FUNDERS')).includes(label), label);
    assert.equal(lib.FUNDER_GRACE_SHEET_LABELS[label], Funder.keyFromLabel(label), label);
  }
  assert.deepEqual([...lib.FUNDER_GRACE_KEYS].sort(), ['btl', 'maccabi', 'mod']);
  assert.equal(lib.FUNDER_GRACE_LABEL, 'ממתין לגורם מממן');
  assert.equal(lib.FUNDER_GRACE_COLUMN_LABEL, 'בתוך תקופת גורם מממן');
  assert.match(APP_SRC, /const FUNDER_GRACE_STATUS_LABEL = 'ממתין לגורם מממן';/);
  assert.match(APP_SRC, /const FUNDER_GRACE_COLUMN_LABEL = 'בתוך תקופת גורם מממן';/);
});

test('day 29 / 30 → inside the grace window; day 31 → not — for each funder, as key and as label, in both runtimes', () => {
  const due = '2026-09-01';
  for (const [key, label] of [['btl', 'ביטוח לאומי'], ['maccabi', 'מכבי'], ['mod', 'משרד הביטחון']]) {
    for (const f of [key, label]) {
      for (const [n, want] of [[0, true], [29, true], [30, true], [31, false], [60, false]]) {
        const today = plus(due, n);
        assert.equal(lib.isWithinFunderGrace(due, f, today), want, `lib ${f} day ${n}`);
        assert.equal(GS.sandbox.isWithinFunderGrace_(due, f, today), want, `gs ${f} day ${n}`);
        assert.equal(lib.isWithinFunderGrace({ dueDate: due }, f, today), want, `lib {dueDate} ${f} day ${n}`);
      }
    }
  }
  assert.equal(lib.funderGraceUntil(due), '2026-10-01');
  assert.equal(GS.sandbox.funderGraceUntil_(due), '2026-10-01');
});

test('private, pro-bono, unset and anything else get NO grace; a bad date never passes silently', () => {
  for (const f of ['פרטי', 'private', 'פרו-בונו', 'probono', 'unset', 'לא הוגדר', '', null, undefined, ' מכבי', 'BTL']) {
    assert.equal(lib.isWithinFunderGrace('2026-10-01', f, TODAY), false, String(f));
    assert.equal(GS.sandbox.isWithinFunderGrace_('2026-10-01', f, TODAY), false, String(f));
  }
  for (const [due, today] of [['', TODAY], ['2026-02-30', TODAY], ['01/10/2026', TODAY], ['2026-10-01', ''], ['2026-10-01', '2026-13-01']]) {
    assert.equal(lib.isWithinFunderGrace(due, 'btl', today), false, due + ' / ' + today);
    assert.equal(GS.sandbox.isWithinFunderGrace_(due, 'btl', today), false, due + ' / ' + today);
  }
  // not yet due → inside (nothing to mark)
  assert.equal(lib.isWithinFunderGrace('2026-10-20', 'btl', TODAY), true);
});

function parityRun(L, isWithinGs) {
  const diffs = [];
  const funders = ['btl', 'maccabi', 'mod', 'private', 'probono', 'unset', 'ביטוח לאומי', 'מכבי', 'משרד הביטחון', 'פרטי', 'פרו-בונו', '', 'x'];
  for (const due of ['2026-01-31', '2026-02-28', '2026-09-07', '2026-12-15', '2028-02-29']) {
    for (let n = -3; n <= 40; n++) {
      const today = plus(due, n);
      for (const f of funders) {
        if (L.isWithinFunderGrace(due, f, today) !== isWithinGs(due, f, today)) diffs.push(`${f} ${due} +${n}`);
      }
    }
  }
  return diffs;
}

test('parity: lib/funder-grace.js and Code.gs isWithinFunderGrace_ agree on a grid of funders × due dates × days', () => {
  assert.deepEqual(parityRun(lib, (d, f, t) => GS.sandbox.isWithinFunderGrace_(d, f, t)).slice(0, 5), []);
  const sandbox = { Math, Date, Number, String, Object, Array, RegExp, JSON };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(LIB_SRC, sandbox);
  assert.deepEqual(parityRun(sandbox.FunderGrace, (d, f, t) => GS.sandbox.isWithinFunderGrace_(d, f, t)).slice(0, 5), [], 'browser build');
});

/* ============================ debtAging_ ============================ */

const frow = (patientId, funder, effectiveFrom) => ({ patientId, funder, effectiveFrom, setBy: 'ורד', setAt: '2026-08-01T09:00:00+03:00' });
const PATIENTS = [
  { id: 'id-btl', houseId: 'ramot', name: 'בטל בדיקה', date: '2026-09-07', pay: 30000, status: 'active' },   // due 07/09: day 30 at TODAY
  { id: 'id-mac', houseId: 'rehab', name: 'מכבי בדיקה', date: '2026-09-06', pay: 20000, status: 'active' },  // due 06/09: day 31
  { id: 'id-mod', houseId: 'asher', name: 'מודי בדיקה', date: '2026-09-08', pay: 25000, status: 'active' },  // due 08/09: day 29
  { id: 'id-pri', houseId: 'ramot', name: 'פרטי בדיקה', date: '2026-09-07', pay: 15000, status: 'active' },
  { id: 'id-pb',  houseId: 'ramot', name: 'פרו בדיקה',  date: '2026-09-07', pay: 10000, status: 'active' },
  { id: 'id-un',  houseId: 'pardes', name: 'ללא בדיקה', date: '2026-09-07', pay: 12000, status: 'active' },
];
const pkey = (p) => `${p.houseId}::${p.name}::${p.date}`;
const payRow = (p, due, f) => Object.assign({ id: 'pay::' + pkey(p) + '::' + due, patientId: pkey(p), patientName: p.name, houseId: p.houseId, dueDate: due }, f);
// btl has a RECORDED unpaid row for 07/09; the others are unrecorded cycles.
const PAYMENTS = [payRow(PATIENTS[0], '2026-09-07', { amount: 30000, status: 'unpaid', amountPaid: 0 })];
const HIST = [
  frow('id-btl', 'ביטוח לאומי', '2026-09-01'),
  frow('id-mac', 'מכבי', '2026-09-01'),
  frow('id-mod', 'משרד הביטחון', '2026-09-01'),
  frow('id-pri', 'פרטי', '2026-09-01'),
  frow('id-pb', 'פרו-בונו', '2026-09-01'),
];
const ALL_PRIVATE = HIST.map((r) => Object.assign({}, r, { funder: r.funder === 'פרו-בונו' ? r.funder : 'פרטי' }));
const rowsOf = (l) => ({ rows: l.map((obj, i) => ({ rowNumber: i + 2, obj: Object.assign({}, obj) })) });
function agingWith(gsSandbox, asOf, funders) {
  return plain(gsSandbox.debtAging_(asOf, {
    patients: rowsOf(PATIENTS), payments: rowsOf(PAYMENTS), credits: rowsOf([]), overrides: rowsOf([]), funders: rowsOf(funders),
  }));
}
const aging = (asOf, funders) => agingWith(GS.sandbox, asOf, funders);
const cyclesOf = (rep, id) => ((rep.byPatient.find((p) => p.patientId === id) || {}).cycles || []);

test('debtAging_: inside the grace window the cycle is FLAGGED, never removed — totals, byHouse and buckets unchanged', () => {
  const grace = aging(TODAY, HIST);
  const normal = aging(TODAY, ALL_PRIVATE);
  assert.equal(grace.ok, true);
  assert.deepEqual(grace.totals, normal.totals, 'totals unchanged');
  assert.deepEqual(grace.byHouse, normal.byHouse, 'byHouse unchanged');
  const strip = (rep) => rep.byPatient.map((p) => [p.patientId, p.cycles.map((c) => [c.start, c.balance, c.bucket, c.days, c.kind])]);
  assert.deepEqual(strip(grace), strip(normal), 'same cycles, balances and buckets');

  const first = (id) => cyclesOf(grace, id).find((c) => c.start === PATIENTS.find((p) => p.id === id).date);
  assert.equal(first('id-btl').funderGrace, true, 'ביטוח לאומי, day 30');
  assert.equal(first('id-btl').funderGraceUntil, '2026-10-07');
  assert.equal(first('id-btl').kind, 'recorded');
  assert.equal(first('id-mod').funderGrace, true, 'משרד הביטחון, day 29');
  assert.equal(first('id-mac').funderGrace, false, 'מכבי, day 31 → normal');
  assert.equal(first('id-mac').funderGraceUntil, '');
  assert.equal(first('id-pri').funderGrace, false, 'private unaffected');
  assert.equal(first('id-un').funderGrace, false, 'unset unaffected');
  assert.equal(cyclesOf(grace, 'id-pb').length, 0, 'pro-bono still excluded');
  assert.equal(grace.probonoExcluded.patients, 1);
  // mac's current cycle (06/10, day 1) IS inside
  assert.equal(cyclesOf(grace, 'id-mac').find((c) => c.start === '2026-10-06').funderGrace, true);

  const flagged = grace.byPatient.flatMap((p) => p.cycles.filter((c) => c.funderGrace));
  assert.equal(grace.funderGrace.count, flagged.length);
  assert.equal(grace.funderGrace.amount, r2(flagged.reduce((s, c) => s + c.balance, 0)));
  assert.equal(normal.funderGrace.count, 0);
  assert.equal(normal.byPatient.flatMap((p) => p.cycles).some((c) => c.funderGrace), false);
});

test('debtAging_: the window is judged at the as-of date — a day later the day-30 cycle is normal again', () => {
  const next = aging(plus(TODAY, 1), HIST);
  assert.equal(cyclesOf(next, 'id-btl').find((c) => c.start === '2026-09-07').funderGrace, false, 'day 31');
  assert.equal(cyclesOf(next, 'id-mod').find((c) => c.start === '2026-09-08').funderGrace, true, 'day 30');
  // a funder switch is read on the DUE date (history), not today
  const switched = aging(TODAY, HIST.concat([frow('id-btl', 'פרטי', '2026-10-01')]));
  assert.equal(cyclesOf(switched, 'id-btl').find((c) => c.start === '2026-09-07').funderGrace, true, 'still ביטוח לאומי on 07/09');
  assert.equal(cyclesOf(switched, 'id-btl').find((c) => c.start === '2026-10-07').funderGrace, false, 'private on 07/10');
});

/* ============================ the page ============================ */

function fakeEl(id) {
  return {
    id: id || '', _html: '', textContent: '', value: '', children: [], style: {}, dataset: {}, className: '',
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
    fetch: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) }),
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(RULES_SRC, sandbox);
  vm.runInContext(FUNDER_SRC, sandbox);
  if (o.lib !== false) vm.runInContext(LIB_SRC, sandbox);
  vm.runInContext((o.appSrc || APP_SRC) + `
    showError = () => {}; showToast = () => {}; renderAll = () => {};
    todayISO = () => '${o.today || TODAY}';
    globalThis.__test = {
      get state() { return state; },
      patientProblems, patientPaymentState, patientCycleInFunderGrace, isInFunderGraceOn, overduePatients,
      buildBillingRow, patientListRowHtml, debtAgingHtml, debtAgingGraceLine, paymentForPatientOnDate,
      normalizePatient, normalizePayment, normalizeFunderRow,
    };`, sandbox);
  const app = sandbox.__test;
  app.state.finance = o.finance === undefined ? true : o.finance;
  app.state.mode = 'edit';
  app.state.leads = [];
  app.state.patients = PATIENTS.map((p) => app.normalizePatient(Object.assign({ adv: 0 }, p)));
  app.state.payments = (o.payments || PAYMENTS).map(app.normalizePayment);
  app.state.billingOverrides = [];
  app.state.funders = (o.funders || HIST).map(app.normalizeFunderRow);
  return app;
}
const app = loadApp();
const P = (app2, id) => app2.state.patients.find((p) => p.id === id);
const NOINFO = { lead: { house: '' }, via: 'fromLead', ambiguous: false };   // no lead problems
const codes = (list) => plain(list).map((x) => x.code);

test('מטופלים: «לא דווח תשלום» waits for the grace window (day 29 / 30), returns on day 31; private / unset unaffected; pro-bono never', () => {
  const at = (a, id, today) => codes(a.patientProblems(P(a, id), NOINFO, [], a.state.funders, today));
  assert.deepEqual(at(app, 'id-btl', TODAY), [], 'ביטוח לאומי, day 30');
  assert.deepEqual(at(app, 'id-mod', TODAY), [], 'משרד הביטחון, day 29');
  assert.deepEqual(at(app, 'id-mac', TODAY), ['no_payment'], 'מכבי, day 31');
  assert.deepEqual(at(app, 'id-btl', plus(TODAY, 1)), ['no_payment'], 'ביטוח לאומי, day 31');
  assert.deepEqual(at(app, 'id-pri', TODAY), ['no_payment'], 'private: unchanged');
  assert.deepEqual(at(app, 'id-pb', TODAY), [], 'pro-bono: never');
  assert.deepEqual(at(app, 'id-un', TODAY), ['no_funder', 'no_payment'], 'unset: unchanged');
  // without the grace rules file nothing is deferred
  const bare = loadApp({ lib: false });
  assert.deepEqual(at(bare, 'id-btl', TODAY), ['no_payment']);
});

test('מטופלים: the payment cell reads «ממתין לגורם מממן» (grey) inside the window, still offers «דווח תשלום»; private reads «לא שולם»', () => {
  const st = (id, today) => plain(app.patientPaymentState(P(app, id), app.state.payments, app.state.funders, today));
  const btl = st('id-btl', TODAY);   // current cycle 07/10, day 0
  assert.equal(btl.key, 'funder_grace');
  assert.equal(btl.label, 'ממתין לגורם מממן');
  assert.equal(btl.owed, 'unpaid');
  assert.equal(st('id-pri', TODAY).key, 'unpaid');
  assert.equal(st('id-pb', TODAY).key, 'probono');
  const html = app.patientListRowHtml({ patient: P(app, 'id-btl'), problems: [], days: 30, payment: btl, leadInfo: NOINFO, lead: null }, true, true);
  assert.match(html, /<span class="badge pay-state pay-state-funder_grace">ממתין לגורם מממן<\/span>/);
  assert.match(html, /plist-report-btn/, '«דווח תשלום» still offered');
  assert.match(CSS_SRC, /\.pay-state-funder_grace \{[^}]*color: var\(--text-muted\)/);
});

test('גבייה: an unpaid institutional cycle inside the window is grey «ממתין לגורם מממן», not overdue; day 31 and private stay red', () => {
  const row = (a, id, due, carry) => {
    const p = P(a, id);
    return a.buildBillingRow(p, a.paymentForPatientOnDate(p, due), due, carry);
  };
  const btl = row(app, 'id-btl', '2026-10-07', false);
  assert.match(btl.className, /\bfunder-grace\b/);
  assert.doesNotMatch(btl.className, /\boverdue\b/);
  assert.match(btl.innerHTML, /pay-state-funder_grace">ממתין לגורם מממן</);
  const pri = row(app, 'id-pri', '2026-10-07', false);
  assert.match(pri.className, /\boverdue\b/);
  assert.doesNotMatch(pri.className, /funder-grace/);
  assert.match(pri.innerHTML, /pay-state-unpaid/);
  // carry-forward rows: day 30 grey, day 31 keeps the amber carry marking
  const btlCarry = row(app, 'id-btl', '2026-09-07', true);
  assert.match(btlCarry.className, /\bfunder-grace\b/);
  const macCarry = row(app, 'id-mac', '2026-09-06', true);
  assert.match(macCarry.className, /\bcarry\b/);
  assert.doesNotMatch(macCarry.className, /funder-grace/);
  assert.match(macCarry.innerHTML, /pay-state-unpaid/);
  // the amount on the row is unchanged
  assert.match(btl.innerHTML, /30,000/);
});

test('dashboard alert: the overdue strip skips a cycle inside the window — private, unset and day-31 cycles stay', () => {
  const names = (a, today) => Array.from(a.overduePatients(today), (x) => x.patient.id).sort();
  assert.deepEqual(names(app, TODAY), ['id-pri', 'id-un']);
  assert.deepEqual(names(loadApp({ lib: false }), TODAY), ['id-btl', 'id-mac', 'id-mod', 'id-pri', 'id-un'], 'no rules file → unchanged');
  // a restricted session gets no funder data → no grace logic at all
  assert.equal(loadApp({ finance: false }).isInFunderGraceOn(PATIENTS[0], '2026-10-07'), false);
});

test('חובות פתוחים: the «בתוך תקופת גורם מממן» column and summary line; the blocks and totals are the server\'s', () => {
  const rep = aging(TODAY, HIST);
  const html = app.debtAgingHtml(rep, { house: 'all', status: 'all' }, TODAY);
  assert.match(html, /<th>בתוך תקופת גורם מממן<\/th>/);
  assert.match(html, /<tr class="debt-cycle funder-grace" data-kind="recorded">/);
  assert.match(html, /ממתין לגורם מממן · עד 07\/10\/2026/);
  assert.match(html, new RegExp(`${rep.funderGrace.count} מחזורים \\(₪ [\\d,]+\\) בתוך תקופת גורם מממן — נכללים בחוב, לא מסומנים כבעיה`));
  const normalHtml = app.debtAgingHtml(aging(TODAY, ALL_PRIVATE), { house: 'all', status: 'all' }, TODAY);
  assert.doesNotMatch(normalHtml, /debt-grace-line/);
  // the two block totals are identical with and without the grace funders
  const totals = (h) => (h.match(/debt-block-total">[^<]+/g) || []);
  assert.deepEqual(totals(html), totals(normalHtml));
});

test('xlsx: both cycle sheets carry the «בתוך תקופת גורם מממן» column; the totals row is unchanged', () => {
  const rep = aging(TODAY, HIST);
  const build = debtXlsx.buildDebtAgingSpec;
  const out = build(rep, { house: 'all', status: 'all' }, new Date('2026-10-07T09:00:00+03:00'));
  const sheets = out.sheets || out;
  const rec = sheets.find((s) => s.name === 'חוב רשום');
  const unr = sheets.find((s) => s.name === 'מחזורים ללא רישום');
  for (const sh of [rec, unr]) assert.equal(sh.columns[sh.columns.length - 1].header, 'בתוך תקופת גורם מממן');
  const btlRow = rec.rows.find((r) => r.name === 'בטל בדיקה' && r.start === '2026-09-07');
  assert.equal(btlRow.funderGrace, 'ממתין לגורם מממן · עד 07/10/2026');
  assert.equal(unr.rows.find((r) => r.name === 'פרטי בדיקה').funderGrace, '');
  const normal = build(aging(TODAY, ALL_PRIVATE), { house: 'all', status: 'all' }, new Date('2026-10-07T09:00:00+03:00'));
  const ns = normal.sheets || normal;
  assert.deepEqual(rec.totals, ns.find((s) => s.name === 'חוב רשום').totals);
  assert.deepEqual(unr.totals, ns.find((s) => s.name === 'מחזורים ללא רישום').totals);
});

test('wiring: /funder-grace.js is served like the other lib rules, loaded before app.js, hashed by the SW; SW v47+', () => {
  assert.match(SERVER_SRC, /'\/funder-grace\.js': \{ file: path\.join\(__dirname, 'lib', 'funder-grace\.js'\)/);
  assert.match(SERVER_SRC, /app\.get\('\/funder-grace\.js', sendLibAsset\('\/funder-grace\.js'\)\);/);
  assert.ok(INDEX_SRC.indexOf('funder-grace.js?v=__BUILD__') > 0);
  assert.ok(INDEX_SRC.indexOf('funder-grace.js?v=__BUILD__') < INDEX_SRC.indexOf('app.js?v=__BUILD__'));
  assert.match(SW_SRC, /var BUNDLE_PATHS = \[[^\]]*'\/funder-grace\.js'\]/);
  // v47 shipped funder-grace; later PRs bump it (v48: CHANGELOG-payment-report-persistence.md).
  assert.ok(Number(/var CACHE_VERSION = 'v(\d+)';/.exec(SW_SRC)[1]) >= 47);
  assert.doesNotMatch(LIB_SRC, /fetch\(|require\(|Date\.now|new Date\(\)/, 'pure: no I/O, no clock');
});

/* ============================ partly paid inside the window ============================ */

// mod: a PARTLY paid recorded cycle (08/09, day 29) — ₪5,000 of ₪25,000 received 10/09.
const MOD = PATIENTS.find((p) => p.id === 'id-mod');
const BTL = PATIENTS.find((p) => p.id === 'id-btl');
const PRI = PATIENTS.find((p) => p.id === 'id-pri');
const PARTIAL_PAYMENTS = PAYMENTS.concat([
  payRow(MOD, '2026-09-08', { amount: 25000, status: 'partial', amountPaid: 5000, receivedDate: '2026-09-10' }),
  payRow(BTL, '2026-10-07', { amount: 30000, status: 'partial', amountPaid: 10000, receivedDate: '2026-10-07' }),
  payRow(PRI, '2026-10-07', { amount: 15000, status: 'partial', amountPaid: 1000, receivedDate: '2026-10-07' }),
]);

test('partly paid inside the window: «שולם חלקית · ממתין לגורם מממן» — patient cell, גבייה row, debt aging, .xlsx; private keeps «שולם חלקית»', () => {
  const a = loadApp({ payments: PARTIAL_PAYMENTS });
  const st = plain(a.patientPaymentState(P(a, 'id-btl'), a.state.payments, a.state.funders, TODAY));
  assert.equal(st.key, 'funder_grace');
  assert.equal(st.owed, 'partial');
  assert.equal(st.label, 'שולם חלקית · ממתין לגורם מממן');
  assert.equal(plain(a.patientPaymentState(P(a, 'id-pri'), a.state.payments, a.state.funders, TODAY)).label, 'שולם חלקית');
  const html = a.patientListRowHtml({ patient: P(a, 'id-btl'), problems: [], days: 30, payment: st, leadInfo: NOINFO, lead: null }, true, true);
  assert.match(html, /pay-state-funder_grace">שולם חלקית · ממתין לגורם מממן</);
  assert.match(html, /plist-report-btn/, 'the rest can still be reported');

  const row = (id, due) => { const p = P(a, id); return a.buildBillingRow(p, a.paymentForPatientOnDate(p, due), due, false); };
  const btlRow = row('id-btl', '2026-10-07');
  assert.match(btlRow.className, /\bfunder-grace\b/);
  assert.match(btlRow.innerHTML, /pay-state-funder_grace">שולם חלקית · ממתין לגורם מממן</);
  const priRow = row('id-pri', '2026-10-07');
  assert.doesNotMatch(priRow.className, /funder-grace/);
  assert.match(priRow.innerHTML, /pay-state-partial">שולם חלקית</);
  // an UNPAID cycle in the window keeps the plain grace label
  assert.match(row('id-mac', '2026-10-06').innerHTML, /pay-state-funder_grace">ממתין לגורם מממן</);

  const rep = plain(GS.sandbox.debtAging_(TODAY, {
    patients: rowsOf(PATIENTS), payments: rowsOf(PARTIAL_PAYMENTS), credits: rowsOf([]), overrides: rowsOf([]), funders: rowsOf(HIST),
  }));
  const modCycle = cyclesOf(rep, 'id-mod').find((c) => c.start === '2026-09-08');
  assert.equal(modCycle.funderGrace, true);
  assert.equal(modCycle.received, 5000);
  assert.equal(modCycle.balance, 20000, 'still owed in full');
  const dhtml = a.debtAgingHtml(rep, { house: 'all', status: 'all' }, TODAY);
  assert.match(dhtml, /שולם חלקית · ממתין לגורם מממן · עד 08\/10\/2026/);
  assert.match(dhtml, /pay-state-funder_grace">ממתין לגורם מממן · עד 07\/10\/2026</, 'the unpaid ביטוח לאומי cycle keeps the plain label');
  const spec = debtXlsx.buildDebtAgingSpec(rep, { house: 'all', status: 'all' }, new Date('2026-10-07T09:00:00+03:00'));
  const rec = (spec.sheets || spec).find((sh) => sh.name === 'חוב רשום');
  assert.equal(rec.rows.find((r) => r.name === 'מודי בדיקה').funderGrace, 'שולם חלקית · ממתין לגורם מממן · עד 08/10/2026');
  assert.equal(rec.rows.find((r) => r.name === 'בטל בדיקה' && r.start === '2026-09-07').funderGrace, 'ממתין לגורם מממן · עד 07/10/2026');
  assert.match(read('lib', 'debt-aging-xlsx.js'), /const PARTIAL_LABEL = 'שולם חלקית';/);
});

test('mutation check (app.js): a partly paid grace cycle that loses its «שולם חלקית» FAILS', () => {
  const from = "return owedKey === 'partial' ? paymentStatusLabel('partial') + ' · ' + FUNDER_GRACE_STATUS_LABEL : FUNDER_GRACE_STATUS_LABEL;";
  assert.equal(APP_SRC.split(from).length, 2);
  const m = loadApp({ payments: PARTIAL_PAYMENTS, appSrc: APP_SRC.replace(from, 'return FUNDER_GRACE_STATUS_LABEL;') });
  assert.notEqual(plain(m.patientPaymentState(P(m, 'id-btl'), m.state.payments, m.state.funders, TODAY)).label, 'שולם חלקית · ממתין לגורם מממן');
});

/* ============================ mutation checks ============================ */

const CHECKS = {
  boundary: (g) => (g.sandbox.isWithinFunderGrace_('2026-09-01', 'מכבי', '2026-10-01') === true
    && g.sandbox.isWithinFunderGrace_('2026-09-01', 'מכבי', '2026-10-02') === false ? '' : 'day 30 / 31 boundary'),
  everyFunder: (g) => (GRACE_LABELS.every((f) => g.sandbox.isWithinFunderGrace_('2026-10-01', f, TODAY)) ? '' : 'a funder lost its grace'),
  privateNone: (g) => (agingWith(g.sandbox, TODAY, HIST).byPatient.find((p) => p.patientId === 'id-pri').cycles.some((c) => c.funderGrace) ? 'private flagged' : ''),
  totals: (g) => {
    const a = agingWith(g.sandbox, TODAY, HIST), b = agingWith(g.sandbox, TODAY, ALL_PRIVATE);
    return JSON.stringify(a.totals) === JSON.stringify(b.totals) && a.funderGrace.count > 0 ? '' : 'totals moved or nothing flagged';
  },
  parity: (g) => (parityRun(lib, (d, f, t) => g.sandbox.isWithinFunderGrace_(d, f, t)).length ? 'parity broken' : ''),
};

test('mutation check: the real Code.gs passes every core check', () => {
  for (const [name, fn] of Object.entries(CHECKS)) assert.equal(fn(GS), '', name);
});

const MUTANTS = [
  ['grace 30 → 29 days', 'boundary', 'const FUNDER_GRACE_DAYS = 30;', 'const FUNDER_GRACE_DAYS = 29;'],
  ['≤ became <', 'boundary', 'return today - due <= FUNDER_GRACE_DAYS;', 'return today - due < FUNDER_GRACE_DAYS;'],
  ['מכבי dropped', 'everyFunder', "const FUNDER_GRACE_KEY_BY_LABEL = { 'ביטוח לאומי': 'btl', 'מכבי': 'maccabi', 'משרד הביטחון': 'mod' };", "const FUNDER_GRACE_KEY_BY_LABEL = { 'ביטוח לאומי': 'btl', 'משרד הביטחון': 'mod' };"],
  ['every funder treated as institutional', 'privateNone', 'if (!isWithinFunderGrace_(due, funder, asOf)) return', "if (!isWithinFunderGrace_(due, 'מכבי', asOf)) return"],
  ['grace cycles dropped from the totals', 'totals', "      debtAgingAdd_(totals.recorded_debt, bucket, balance);", "      if (!isWithinFunderGrace_(pay.dueDate, funderOn(p.id, pay.dueDate), asOf)) debtAgingAdd_(totals.recorded_debt, bucket, balance);"],
  ['grace flag never set', 'totals', 'funderGrace.count++;', ''],
];

for (const [name, check, from, to] of MUTANTS) {
  test(`mutation check (Code.gs): «${name}» FAILS its check`, () => {
    assert.equal(GS_SRC.split(from).length, 2, 'the mutation site exists exactly once: ' + from);
    let failure;
    try { failure = CHECKS[check](loadGs({ src: GS_SRC.replace(from, to) })); } catch (e) { failure = 'threw: ' + e.message; }
    assert.notEqual(failure, '', 'the mutant survived');
  });
}

test('mutation check (app.js): dropping the grace check from «לא דווח תשלום» FAILS', () => {
  const from = "\n      && !patientCycleInFunderGrace(patient, funders, patient.date, todayIso)) out.add('no_payment');";
  assert.equal(APP_SRC.split(from).length, 2);
  const m = loadApp({ appSrc: APP_SRC.replace(from, ") out.add('no_payment');") });
  assert.deepEqual(codes(m.patientProblems(P(m, 'id-btl'), NOINFO, [], m.state.funders, TODAY)), ['no_payment'], 'the mutant flags a day-30 ביטוח לאומי patient');
});

test('mutation check (app.js): an overdue strip that ignores the window FAILS', () => {
  const from = '    if (isInFunderGraceOn(p, dueISO)) return;';
  assert.equal(APP_SRC.split(from).length, 2);
  const m = loadApp({ appSrc: APP_SRC.replace(from, '') });
  assert.notDeepEqual(Array.from(m.overduePatients(TODAY), (x) => x.patient.id).sort(), ['id-pri', 'id-un']);
});

test('mutation check (lib): a lib whose window drifts from Code.gs FAILS the parity check', () => {
  const from = 'const FUNDER_GRACE_DAYS = 30;';
  assert.equal(LIB_SRC.split(from).length, 2);
  const sandbox = { Math, Date, Number, String, Object, Array, RegExp, JSON };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(LIB_SRC.replace(from, 'const FUNDER_GRACE_DAYS = 31;'), sandbox);
  assert.ok(parityRun(sandbox.FunderGrace, (d, f, t) => GS.sandbox.isWithinFunderGrace_(d, f, t)).length > 0, 'the mutant survived');
});
