/* Write-path hardening, PR A — the MONEY writes (CHANGELOG-write-path-hardening.md).
 *
 * PR #201 fixed «דווח תשלום» with three rules; this applies them to every
 * other money write. Each test below FAILED on the code before this change:
 *
 *   R1  a stale read never overwrites a newer write, and no reload starts
 *       while a write is in flight:
 *         - voidReceipt / confirmReceipts were not counted in _savesInFlight
 *           (the visibility resync reloaded under them);
 *         - a getData that started before an amount edit wiped the override;
 *         - a getCredits that started before saveCredit undid the credit;
 *         - a «בקרת גבייה» queue read that started before a decision put the
 *           decided rows back to «ממתין».
 *   R2  a failed getCredits wiped state.credits to [] silently.
 *   R3  "saved" only with server proof, and a retry is answered, never
 *       refused or written twice:
 *         - voidReceipt / savePayment / editReceipt / appendFunder /
 *           confirmPayment / billing override accepted any ok:true;
 *         - a re-void of a void receipt answered «receipt_immutable»;
 *         - a re-sent «כפילות» answered «receipt_void»;
 *         - an editReceipt replay carried no receipt;
 *         - a re-sent appendFunder appended a second row;
 *         - a re-sent credit edit answered «conflict».
 *
 * app.js and Code.gs are the REAL files in a vm. Names are SYNTHETIC. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { richSheet, loadGs } = require('./helpers/gs-sandbox');
const { writeEcho } = require('./helpers/write-echo');

const ROOT = path.join(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const SW_SRC = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');
const FUNDER = require(path.join(ROOT, 'public', 'funder.js'));
const noop = () => {};
const plain = (v) => JSON.parse(JSON.stringify(v));
const arr = (v) => Array.from(v);

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const tick = async (n = 10) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

/* ============================ page (app.js in a vm) ============================ */

const DATA = { ok: true, leads: [], patients: {}, irrelevantLeads: [], removedLeads: [], dischargedPatients: [], billingOverrides: [] };
const RECEIPT = {
  id: 'rcpt-1', cycleId: 'pay::c', patientId: 'arfoni::דנה כהן::2026-09-15', patientName: 'דנה כהן', houseId: 'arfoni',
  dueDate: '2026-09-15', amount: 30000, amountPaid: 30000, status: 'paid', receivedDate: '2026-10-01', reference: 'A1',
};

/* answerPost(body) → the JSON the POST answers (or a Promise of it). */
function loadApp(answerPost) {
  const listeners = {};
  const posts = [];
  const gets = [];
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/', hash: '', reload: noop },
    setTimeout: () => 0, clearTimeout: noop,
    document: {
      visibilityState: 'visible',
      addEventListener: (ev, fn) => { listeners[ev] = fn; },
      querySelectorAll: () => [],
      getElementById: () => null,
      body: { classList: { toggle: noop, add: noop, remove: noop, contains: () => false } },
    },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    Funder: FUNDER,
    fetch: (url, opts) => {
      if (opts && opts.method === 'POST') {
        const body = JSON.parse(opts.body);
        posts.push(body);
        return Promise.resolve(answerPost ? answerPost(body) : writeEcho(body)).then((data) => ({
          ok: true, status: 200, json: () => Promise.resolve(data),
        }));
      }
      gets.push(url);
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(DATA) });
    },
    URL, URLSearchParams, Intl, Math, Date, JSON, Number, String, Array, Object, RegExp,
    Promise, Set, Map, Error, isFinite, parseFloat, parseInt,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(APP_SRC + `
    renderAll = function () {};
    renderBilling = function () {};
    renderBillingMonthlySummary = function () {};
    renderBillingControl = function () {};
    renderDashboard = function () {};
    renderPatientsTab = function () {};
    renderCreditsPayouts = function () {};
    markPayoutForecastStale = function () {};
    globalThis.__t = {
      loadAll: () => loadAll(),
      voidReceipt: (r, n) => voidReceipt(r, n),
      submitReceiptEdit: (r, f, why) => submitReceiptEdit(r, f, why),
      savePayment: (p) => savePayment(p),
      saveBillingOverride: (p, a) => saveBillingOverride(p, a),
      saveCredit: (c) => saveCredit(c),
      reloadCredits: () => reloadCredits(),
      saveFunder: (p, f, d) => saveFunder(p, f, d),
      confirmReceipts: (ids, st, x) => confirmReceipts(ids, st, x),
      loadBillingControl: () => loadBillingControl(),
      bc: () => billingControlState(),
      setApiGet(fn) { apiGet = fn; },
      setShowError(fn) { showError = fn; },
      setShowToast(fn) { showToast = fn; },
      setSaveAll(fn) { saveAll = fn; },
      setState(s) { Object.assign(state, s); },
      getState() { return state; },
      NOT_CONFIRMED: typeof WRITE_NOT_CONFIRMED_HE !== 'undefined' ? WRITE_NOT_CONFIRMED_HE : '',
    };`, sandbox);
  const t = sandbox.__t;
  const errors = [];
  const toasts = [];
  t.setShowError((m) => errors.push(m));
  t.setShowToast((m) => toasts.push(m));
  t.setSaveAll(() => Promise.resolve());
  t.setState({ mode: 'edit', deleter: true, finance: true, canConfirm: true });
  return { t, errors, toasts, posts, gets, listeners };
}

/* apiGet stub: every call gets its own deferred, queued per action. */
function deferredGets(h) {
  const calls = [];
  h.t.setApiGet((p) => { const d = deferred(); calls.push({ action: p.action, d }); return d.promise; });
  const next = (action) => calls.find((c) => c.action === action && !c.taken && (c.taken = true));
  return { calls, next };
}

/* ---- R3: "saved" only with proof --------------------------------------- */

test('R3 void: an ok:true with no stored row is NOT "voided" — the receipt stays live, no toast', async () => {
  const h = loadApp(() => ({ ok: true }));
  h.t.setState({ receipts: [Object.assign({}, RECEIPT)] });
  await assert.rejects(h.t.voidReceipt(RECEIPT, 'כפול'), (e) => e.message === h.t.NOT_CONFIRMED);
  assert.equal(h.t.getState().receipts[0].status, 'paid');
  assert.deepEqual(h.toasts, []);
});

test('R3 void: the echoed row is what lands on screen', async () => {
  const h = loadApp((b) => ({ ok: true, payment: Object.assign({}, RECEIPT, { status: 'void' }), replayed: true }));
  h.t.setState({ receipts: [Object.assign({}, RECEIPT)] });
  await h.t.voidReceipt(RECEIPT, 'כפול');
  assert.equal(h.t.getState().receipts[0].status, 'void');
  assert.equal(h.toasts.length, 1);
});

test('R3 savePayment: an ok:true with no echoed payment rolls back and says so', async () => {
  const h = loadApp(() => ({ ok: true }));
  const prev = { id: 'pay::c', patientId: 'x', dueDate: '2026-09-15', amount: 100, coverageStart: '', coverageEnd: '' };
  h.t.setState({ payments: [Object.assign({}, prev)], patients: [] });
  await h.t.savePayment(Object.assign({}, prev, { linkNote: 'חדש' }));
  assert.equal(h.t.getState().payments[0].linkNote, undefined, 'rolled back');
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0], /השמירה לא אושרה בשרת/);
});

test('R3 editReceipt: a replay answer without the receipt is not proof; with it, it is', async () => {
  const bare = loadApp(() => ({ ok: true, changed: false }));
  bare.t.setState({ receipts: [Object.assign({}, RECEIPT)] });
  await assert.rejects(bare.t.submitReceiptEdit(RECEIPT, { reference: 'B2' }, ''));
  const h = loadApp(() => ({ ok: true, changed: false, receipt: Object.assign({}, RECEIPT, { reference: 'B2' }) }));
  h.t.setState({ receipts: [Object.assign({}, RECEIPT)] });
  await h.t.submitReceiptEdit(RECEIPT, { reference: 'B2' }, '');
  assert.equal(h.t.getState().receipts[0].reference, 'B2');
  assert.equal(h.t.getState().receipts[0].cycleId, 'pay::c');
});

test('R3 billing override: an ok:true with no stored override rolls the amount back', async () => {
  const h = loadApp(() => ({ ok: true }));
  h.t.setState({ billingOverrides: [], payments: [] });
  await h.t.saveBillingOverride({ patientId: 'P1', dueDate: '2026-09-05' }, 8000);
  assert.equal(h.t.getState().billingOverrides.length, 0);
  assert.equal(h.errors.length, 1);
  assert.deepEqual(h.toasts, []);
});

test('R3 funder: no stored row is a failure; a replay adds no second row on screen', async () => {
  const p = { id: 'p1', houseId: 'arfoni', name: 'דנה כהן', date: '2026-09-15' };
  const bare = loadApp(() => ({ ok: true }));
  bare.t.setState({ funders: [], patients: [p] });
  await assert.rejects(bare.t.saveFunder(p, 'פרטי', '2026-09-15'));
  assert.equal(bare.t.getState().funders.length, 0);
  assert.deepEqual(bare.toasts, []);

  const row = { patientId: 'p1', funder: 'פרטי', effectiveFrom: '2026-09-15', setBy: 'ורד', setAt: '2026-10-01T10:00:00+03:00' };
  const h = loadApp(() => ({ ok: true, row, replayed: true }));
  h.t.setState({ funders: [plain(row)], patients: [p] });
  await h.t.saveFunder(p, 'פרטי', '2026-09-15');
  assert.equal(h.t.getState().funders.length, 1, 'the replayed row is already on screen');
});

test('R3 confirmPayment: an answer that accounts for none of the ids is not "saved"', async () => {
  const h = loadApp(() => ({ ok: true, changed: [], unchanged: 0 }));
  h.t.bc().data = { receipts: [{ id: 'rcpt-1', confirmStatus: 'reported' }] };
  const res = await h.t.confirmReceipts(['rcpt-1'], 'confirmed');
  assert.equal(res, null);
  assert.deepEqual(h.toasts, []);
  assert.equal(h.errors.length, 1);
  assert.equal(h.t.bc().data.receipts[0].confirmStatus, 'reported');
});

/* ---- R1: in flight + stale reads --------------------------------------- */

test('R1 void in flight: the visibility resync does not reload', async () => {
  const gate = deferred();
  const h = loadApp((b) => gate.promise.then(() => writeEcho(b)));
  h.t.setState({ receipts: [Object.assign({}, RECEIPT)] });
  const run = h.t.voidReceipt(RECEIPT, 'כפול');
  await tick();
  h.listeners.visibilitychange();
  await tick();
  assert.equal(h.gets.length, 0, 'no getData while the void is mid-air');
  gate.resolve();
  await run;
});

test('R1 confirmPayment in flight: the visibility resync does not reload', async () => {
  const gate = deferred();
  const h = loadApp((b) => gate.promise.then(() => writeEcho(b)));
  h.t.bc().data = { receipts: [{ id: 'rcpt-1', confirmStatus: 'reported' }] };
  const run = h.t.confirmReceipts(['rcpt-1'], 'confirmed');
  await tick();
  h.listeners.visibilitychange();
  await tick();
  assert.equal(h.gets.length, 0);
  gate.resolve();
  await run;
});

test('R1 amount edit: a getData that started before it cannot wipe the override', async () => {
  const h = loadApp();
  const g = deferredGets(h);
  h.t.setState({ billingOverrides: [], payments: [] });
  const load = h.t.loadAll();
  await tick();
  await h.t.saveBillingOverride({ patientId: 'P1', dueDate: '2026-09-05' }, 8000);
  assert.equal(h.t.getState().billingOverrides.length, 1);
  g.next('getData').d.resolve(plain(DATA));          // read from the sheet BEFORE the write
  g.next('getPayments').d.resolve({ ok: true, payments: [], receipts: [], funders: [] });
  g.next('getCredits').d.resolve({ ok: true, credits: [] });
  await load;
  assert.equal(h.t.getState().billingOverrides.length, 1, 'the stale getData was discarded for the overrides');
  assert.equal(h.t.getState().billingOverrides[0].amount, 8000);
});

const CREDIT = { id: 'credit::P1::2026-09::1', patientId: 'P1', patientKey: 'k', houseId: 'ramot', creditType: 'other',
  allocationMonth: '2026-09', amount: 100, calculatedAmount: 100, status: 'pending' };

test('R1 credits: a getCredits that started before a saved credit cannot undo it', async () => {
  const h = loadApp(() => ({ ok: true, credit: plain(CREDIT), created: true }));
  const g = deferredGets(h);
  h.t.setState({ credits: [] });
  const reload = h.t.reloadCredits();
  await tick();
  await h.t.saveCredit(Object.assign({}, CREDIT, { id: '' }));
  assert.equal(h.t.getState().credits.length, 1);
  g.next('getCredits').d.resolve({ ok: true, credits: [] });
  await reload;
  assert.equal(h.t.getState().credits.length, 1, 'the stale getCredits was discarded');
});

test('R1 «בקרת גבייה»: a queue read that started before a decision cannot undo it', async () => {
  const h = loadApp(() => ({ ok: true, changed: [{ id: 'rcpt-1', confirmStatus: 'confirmed' }], unchanged: 0 }));
  const g = deferredGets(h);
  h.t.bc().data = { receipts: [{ id: 'rcpt-1', confirmStatus: 'reported' }] };
  const load = h.t.loadBillingControl();
  await tick();
  await h.t.confirmReceipts(['rcpt-1'], 'confirmed');
  assert.equal(h.t.bc().data.receipts[0].confirmStatus, 'confirmed');
  g.next('billingControlQueue').d.resolve({ ok: true, receipts: [{ id: 'rcpt-1', confirmStatus: 'reported' }] });
  await load;
  assert.equal(h.t.bc().data.receipts[0].confirmStatus, 'confirmed', 'the stale queue was discarded');
});

/* ---- R2: a failed read keeps what is on screen ---------------------------- */

test('R2 getCredits fails: the credits on screen stay, and a Hebrew error says so', async () => {
  const h = loadApp();
  h.t.setState({ credits: [plain(CREDIT)] });
  h.t.setApiGet((p) => (p.action === 'getData' ? Promise.resolve(plain(DATA))
    : p.action === 'getPayments' ? Promise.resolve({ ok: true, payments: [], receipts: [], funders: [] })
      : Promise.reject(new Error('HTTP 502'))));
  await h.t.loadAll();
  assert.equal(h.t.getState().credits.length, 1);
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0], /^טעינת הזיכויים נכשלה/);
});

test('R2 reloadCredits fails: the credits stay, and the user is told', async () => {
  const h = loadApp();
  h.t.setState({ credits: [plain(CREDIT)] });
  h.t.setApiGet(() => Promise.reject(new Error('HTTP 502')));
  assert.equal(await h.t.reloadCredits(), false);
  assert.equal(h.t.getState().credits.length, 1);
  assert.match(h.errors[0], /^טעינת הזיכויים נכשלה/);
});

/* ============================ Code.gs (server) ============================ */

const PROXY_SECRET = 'proxy-secret-TEST-write-path-0123456789abcdef';
const VERED = () => ({ proxySecret: PROXY_SECRET, proxyUser: 'ורד', user: 'ורד', proxyAuth: 'personal',
  proxyUserId: 'vered', proxyRoles: ['staff', 'reporter', 'deleter'], proxyCaps: ['finance', 'billingControl'] });
const ORTAL = () => ({ proxySecret: PROXY_SECRET, proxyUser: 'אורטל', user: 'אורטל', proxyAuth: 'personal',
  proxyUserId: 'ortal', proxyRoles: ['controller'], proxyCaps: ['billingControl'] });
const CYCLE = {
  id: 'pay::arfoni::דנה כהן::2026-09-15::2026-09-15', patientId: 'arfoni::דנה כהן::2026-09-15',
  patientName: 'דנה כהן', houseId: 'arfoni', dueDate: '2026-09-15', amount: 30000,
};
const israelDay = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date(ms));
const daysAgo = (n) => israelDay(Date.now() - n * 86400000);

function world() {
  const g = loadGs({ props: { PROXY_SECRET, PROXY_SECRET_MODE: 'enforce' } });
  const S = g.sandbox.__sheets;
  const pcols = arr(g.run('PATIENT_COLUMNS'));
  S.Patients = richSheet('Patients', pcols);
  S.Patients.appendRow(pcols.map((c) => ({ id: 'p1', houseId: 'arfoni', name: 'דנה כהן', date: '2026-09-15', pay: 30000, status: 'active' }[c] || '')));
  const call = (body, who) => plain(g.post(Object.assign({}, body, (who || VERED)())));
  const reportPay = (amount, receivedDate) => call({ action: 'reportPayment', report: { cycle: CYCLE, report: {
    receivedDate, amount, method: 'העברה בנקאית', payer: 'משפחת כהן', reference: 'TRX-' + receivedDate.replace(/-/g, ''),
    funder: 'פרטי', invoiceWanted: 'no', coverageStart: '2026-09-15', coverageEnd: '2026-10-14',
  } } });
  const snapshot = () => JSON.stringify(Object.keys(S).sort().map((k) => [k, S[k].grid]));
  return { g, S, call, reportPay, snapshot };
}
const voidBody = (id) => ({ action: 'savePayment', payment: {
  id, patientId: CYCLE.patientId, patientName: CYCLE.patientName, houseId: 'arfoni', dueDate: CYCLE.dueDate,
  status: 'void', linkPatientUid: '', linkStatus: 'duplicate', linkNote: 'כפול', timestamp: new Date().toISOString(),
} });

test('R3 server: a re-sent void of a void receipt is answered with the stored row — nothing written', () => {
  const w = world();
  const a = w.reportPay(10000, daysAgo(3));
  w.reportPay(12000, daysAgo(2));
  const first = w.call(voidBody(a.receipt.id));
  assert.equal(first.ok, true, JSON.stringify(first));
  const snap = w.snapshot();
  const again = w.call(voidBody(a.receipt.id));
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(again.replayed, true);
  assert.equal(again.payment.id, a.receipt.id);
  assert.equal(again.payment.status, 'void');
  assert.equal(again.cycle.id, CYCLE.id);
  assert.equal(w.snapshot(), snap, 'the replay writes nothing');
});

test('R3 server: a re-sent «כפילות» is answered — not «receipt_void»', () => {
  const w = world();
  w.reportPay(10000, daysAgo(3));
  const b = w.reportPay(12000, daysAgo(2));
  const decide = () => w.call({ action: 'confirmPayment', confirm: { ids: [b.receipt.id], status: 'duplicate', flagNote: 'כפול' } }, ORTAL);
  assert.equal(decide().ok, true);
  const snap = w.snapshot();
  const again = decide();
  assert.deepEqual([again.ok, again.replayed, again.voided[0].id], [true, true, b.receipt.id]);
  assert.equal(w.snapshot(), snap);
});

test('R3 server: an editReceipt replay echoes the stored receipt', () => {
  const w = world();
  const a = w.reportPay(10000, daysAgo(3));
  const edit = () => w.call({ action: 'editReceipt', edit: { id: a.receipt.id, fields: { reference: 'NEW-1' } } });
  assert.equal(edit().changed, true);
  const snap = w.snapshot();
  const again = edit();
  assert.deepEqual([again.ok, again.changed, again.receipt.id, again.receipt.reference], [true, false, a.receipt.id, 'NEW-1']);
  assert.equal(w.snapshot(), snap);
});

test('R3 server: a re-sent appendFunder appends nothing; a deliberate switch back still lands', () => {
  const w = world();
  const send = (funder) => w.call({ action: 'appendFunder', funder: { patientId: 'p1', funder, effectiveFrom: '2026-09-01' } });
  const rows = () => w.g.sheetRows('Funders', 'FUNDER_COLUMNS');
  assert.equal(send('פרטי').ok, true);
  const again = send('פרטי');
  assert.deepEqual([again.ok, again.replayed, again.row.funder], [true, true, 'פרטי']);
  assert.equal(rows().length, 1, 'no second row');
  const funders = arr(w.g.run('PAYMENT_FUNDERS'));
  const other = funders.find((f) => f !== 'פרטי');
  assert.equal(send(other).ok, true);
  assert.equal(send('פרטי').replayed, undefined, 'A → B → A is a real change');
  assert.equal(rows().length, 3);
});

test('R3 server: a re-sent credit edit is answered — a real stale edit is still a conflict', () => {
  const w = world();
  const BASE = { patientId: 'id-x', patientKey: 'ramot::שרה::2026-09-01', patientName: 'שרה', houseId: 'ramot',
    creditType: 'days_unused', allocationMonth: '2026-09', calculatedAmount: 4800, amount: 4800, status: 'pending',
    decidedDate: '2026-09-14', reason: '', notes: '', basis: {} };
  const created = w.call({ action: 'saveCredit', credit: BASE });
  assert.equal(created.ok, true, JSON.stringify(created));
  const loaded = created.credit;
  const edit = { id: loaded.id, updatedAt: loaded.updatedAt, notes: 'הערה' };
  // The server stamps updatedAt to the millisecond: make sure the edit's
  // stamp differs from the one this "tab" loaded.
  const t0 = Date.now(); while (Date.now() === t0) { /* spin one ms */ }
  const first = w.call({ action: 'saveCredit', credit: edit });
  assert.equal(first.ok, true, JSON.stringify(first));
  const snap = w.snapshot();
  const again = w.call({ action: 'saveCredit', credit: edit });   // the old stamp, same change
  assert.deepEqual([again.ok, again.replayed, again.credit.id], [true, true, loaded.id]);
  assert.equal(w.snapshot(), snap, 'the replay writes nothing');
  const stale = w.call({ action: 'saveCredit', credit: { id: loaded.id, updatedAt: loaded.updatedAt, notes: 'אחרת' } });
  assert.equal(stale.ok, false);
  assert.equal(stale.error, 'conflict');
});

test('SW: CACHE_VERSION is v50 or later (live served v49)', () => {
  const v = Number((SW_SRC.match(/var CACHE_VERSION = 'v(\d+)';/) || [])[1]);
  assert.ok(v >= 50, 'CACHE_VERSION v' + v);
});
