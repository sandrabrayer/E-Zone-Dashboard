/* «דוח תשלום» persistence — CHANGELOG-payment-report-persistence.md.
 *
 * Vered: after saving a report in «גבייה» the row sometimes reverts to
 * «לא שולם» (or its paid amount drops back). Each confirmed cause has a
 * regression test here that FAILED on the code before the fix:
 *
 *   R1  a getPayments read that started BEFORE the report landed answered
 *       AFTER it and overwrote the confirmed echo (no sequence guard);
 *   R2  the visibilitychange resync fired while the report POST was in
 *       flight (reportPayment never counted as a save in flight);
 *   R3  a failed getPayments silently wiped state.payments to [] — every row
 *       read «לא שולם», with no error on screen;
 *   R4  no reconcile after a confirmed save — nothing re-read the sheet;
 *   R5  no idempotency: a retry of a report whose first response was lost
 *       (proxy 502 / network) was refused as possible_duplicate, or — after
 *       «כן, קבלה נוספת» — written TWICE;
 *   R6  "saved" without proof: an ok:true answer with no persisted receipt
 *       id closed the modal and toasted success.
 *
 * Code.gs is the REAL file in a vm (test/helpers/gs-sandbox.js); app.js is
 * the REAL file in a vm with fetch / apiGet stubbed. Names are SYNTHETIC. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { richSheet, loadGs } = require('./helpers/gs-sandbox');

const ROOT = path.join(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const SW_SRC = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');
const noop = () => {};
const plain = (v) => JSON.parse(JSON.stringify(v));
const arr = (v) => Array.from(v);

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const tick = async (n = 8) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

/* ============================ page (app.js in a vm) ============================ */

const CYCLE_ID = 'pay::arfoni::דנה כהן::2026-09-15::2026-09-15';
const CYCLE_IN = {
  id: CYCLE_ID, patientId: 'arfoni::דנה כהן::2026-09-15', patientName: 'דנה כהן', houseId: 'arfoni',
  dueDate: '2026-09-15', amount: 30000, coverageStart: '2026-09-15', coverageEnd: '2026-10-14',
};
const UNPAID = Object.assign({}, CYCLE_IN, { status: 'unpaid', amountPaid: 0, balance: 30000 });
const PAID = Object.assign({}, CYCLE_IN, { status: 'paid', amountPaid: 30000, balance: 0 });
const RECEIPT = {
  id: 'rcpt-1', cycleId: CYCLE_ID, patientId: CYCLE_IN.patientId, patientName: 'דנה כהן', houseId: 'arfoni',
  dueDate: '2026-09-15', amount: 30000, amountPaid: 30000, status: 'paid', receivedDate: '2026-10-01',
};
const VALUES = {
  receivedDate: '2026-10-01', amount: '30000', method: 'העברה בנקאית', payer: 'משפחת כהן', reference: 'TRX-1',
  funder: 'פרטי', coverageStart: '2026-09-15', coverageEnd: '2026-10-14', invoiceWanted: 'no', invoiceTo: '',
};
const DATA = { ok: true, leads: [], patients: {}, irrelevantLeads: [], removedLeads: [], dischargedPatients: [], billingOverrides: [] };

/* answerPost(body) → the JSON the POST answers (or a Promise of it). */
function loadApp(answerPost) {
  const listeners = {};
  const posts = [];
  const fetches = [];
  const doc = {
    visibilityState: 'visible',
    addEventListener: (ev, fn) => { listeners[ev] = fn; },
    querySelectorAll: () => [],
    getElementById: () => null,
    body: { classList: { toggle: noop, add: noop, remove: noop, contains: () => false } },
  };
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/', hash: '', reload: noop },
    setTimeout: () => 0, clearTimeout: noop,
    document: doc,
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    fetch: (url, opts) => {
      fetches.push({ url, opts });
      if (opts && opts.method === 'POST') {
        const body = JSON.parse(opts.body);
        posts.push(body);
        return Promise.resolve(answerPost ? answerPost(body) : { ok: true }).then((data) => ({
          ok: true, status: 200, json: () => Promise.resolve(data),
        }));
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
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
    renderDashboard = function () {};
    renderPatientsTab = function () {};
    renderCreditsPayouts = function () {};
    globalThis.__t = {
      loadAll: () => loadAll(),
      apiGet: (p) => apiGet(p),
      submitPaymentReport: (c, v, d, s) => submitPaymentReport(c, v, d, s),
      setApiGet(fn) { apiGet = fn; },
      setShowError(fn) { showError = fn; },
      setShowToast(fn) { showToast = fn; },
      setSaveAll(fn) { saveAll = fn; },
      setState(s) { Object.assign(state, s); },
      getState() { return state; },
      normalizePayment: (p) => normalizePayment(p),
      normalizeReceipt: (r) => normalizeReceipt(r),
      newSubmissionId: () => (typeof newSubmissionId === 'function' ? newSubmissionId() : ''),
      reconcile: () => (typeof _paymentsReconcile !== 'undefined' ? _paymentsReconcile : null),
      SAVE_FAILED: typeof PAYMENT_REPORT_SAVE_FAILED_HE !== 'undefined' ? PAYMENT_REPORT_SAVE_FAILED_HE : '',
      LOAD_FAILED: typeof PAYMENTS_LOAD_FAILED_HE !== 'undefined' ? PAYMENTS_LOAD_FAILED_HE : '',
    };`, sandbox);
  const t = sandbox.__t;
  const errors = [];
  t.setShowError((m) => errors.push(m));
  t.setShowToast(noop);
  t.setSaveAll(() => Promise.resolve());
  t.setState({ mode: 'edit' });
  return { t, errors, posts, fetches, listeners, doc };
}

/* apiGet stub: every call gets its own deferred, queued per action. */
function deferredGets(h) {
  const calls = [];
  h.t.setApiGet((p) => { const d = deferred(); calls.push({ action: p.action, d }); return d.promise; });
  const next = (action) => calls.find((c) => c.action === action && !c.taken && (c.taken = true));
  return { calls, next };
}

const echo = () => ({ ok: true, receipt: plain(RECEIPT), cycle: plain(PAID), created: true });
const cycleOf = (s) => arr(s.payments).find((p) => p.id === CYCLE_ID);

test('R1: a getPayments read that started BEFORE the report must not overwrite the confirmed echo', async () => {
  const h = loadApp(() => echo());
  const g = deferredGets(h);
  const load = h.t.loadAll();                 // e.g. the visibilitychange resync
  await tick();
  const staleRead = g.next('getPayments');
  assert.ok(staleRead, 'the load read is in flight');

  await h.t.submitPaymentReport(CYCLE_IN, VALUES, false, 'sub-0123456789abcdef');
  assert.equal(cycleOf(h.t.getState()).status, 'paid', 'the echo is on screen');

  // The stale read answers with the sheet as it was BEFORE the write.
  g.next('getData').d.resolve(DATA);
  staleRead.d.resolve({ ok: true, payments: [UNPAID], receipts: [] });
  const credits = g.next('getCredits'); if (credits) credits.d.resolve({ ok: true, credits: [] });
  await load;
  const s = h.t.getState();
  assert.equal(cycleOf(s).status, 'paid', 'still שולם — the stale read was discarded');
  assert.ok(arr(s.receipts).some((r) => r.id === 'rcpt-1'), 'the confirmed receipt survives');
});

test('R2: the visibility resync does not reload while a report is in flight', async () => {
  const gate = deferred();
  const h = loadApp(() => gate.promise);
  const asked = [];
  h.t.setApiGet((p) => { asked.push(p.action); return new Promise(noop); });
  const sending = h.t.submitPaymentReport(CYCLE_IN, VALUES, false, 'sub-0123456789abcdef');
  await tick();
  h.listeners.visibilitychange();
  assert.deepEqual(asked, [], 'no getData / getPayments while the report POST is mid-air');
  gate.resolve(echo());
  await sending;
});

test('R3: a failed getPayments keeps the money state and says so in Hebrew — never a silent «לא שולם»', async () => {
  const h = loadApp();
  h.t.setState({ payments: [h.t.normalizePayment(PAID)], receipts: [h.t.normalizeReceipt(RECEIPT)] });
  h.t.setApiGet((p) => (p.action === 'getData' ? Promise.resolve(DATA)
    : p.action === 'getPayments' ? Promise.reject(new Error('Apps Script HTTP 502'))
      : Promise.resolve({ ok: true, credits: [] })));
  await h.t.loadAll();
  const s = h.t.getState();
  assert.equal(cycleOf(s).status, 'paid', 'the paid row is NOT wiped');
  assert.equal(arr(s.receipts).length, 1);
  assert.ok(h.t.LOAD_FAILED, 'PAYMENTS_LOAD_FAILED_HE is defined');
  assert.ok(h.errors.some((m) => m.indexOf(h.t.LOAD_FAILED) === 0), 'a Hebrew error is shown: ' + JSON.stringify(h.errors));
});

test('R4: a confirmed save re-reads getPayments and reconciles — guarded by the request sequence', async () => {
  const h = loadApp(() => echo());
  const g = deferredGets(h);
  await h.t.submitPaymentReport(CYCLE_IN, VALUES, false, 'sub-0123456789abcdef');
  const re = g.next('getPayments');
  assert.ok(re, 'a fresh getPayments is requested after the confirmed save');
  // The sheet's truth (one more receipt from another device) is adopted.
  const other = Object.assign({}, RECEIPT, { id: 'rcpt-other' });
  re.d.resolve({ ok: true, payments: [PAID], receipts: [RECEIPT, other], funders: [] });
  await h.t.reconcile();
  assert.deepEqual(arr(h.t.getState().receipts).map((r) => r.id).sort(), ['rcpt-1', 'rcpt-other']);

  // A reconcile answer that does NOT carry the confirmed receipt is not applied.
  await h.t.submitPaymentReport(CYCLE_IN, VALUES, false, 'sub-fedcba9876543210');
  g.next('getPayments').d.resolve({ ok: true, payments: [UNPAID], receipts: [], funders: [] });
  await h.t.reconcile();
  assert.equal(cycleOf(h.t.getState()).status, 'paid');
});

test('R4: apiGet bypasses every cache (fetch cache: no-store)', async () => {
  const h = loadApp();
  await h.t.apiGet({ action: 'getPayments' });
  const get = h.fetches.find((f) => String(f.url).indexOf('getPayments') >= 0);
  assert.equal(get.opts && get.opts.cache, 'no-store');
});

test('R6: ok:true WITHOUT a persisted receipt id is a failure, never «saved»', async () => {
  const h = loadApp(() => ({ ok: true, cycle: plain(PAID) }));
  await assert.rejects(h.t.submitPaymentReport(CYCLE_IN, VALUES, false, 'sub-0123456789abcdef'),
    (e) => e.message === h.t.SAVE_FAILED && /נסי שוב/.test(e.message));
  assert.equal(cycleOf(h.t.getState()) && cycleOf(h.t.getState()).status, undefined, 'nothing applied');
});

test('R5 (client): the report carries the submission id; a retry re-sends the SAME id', async () => {
  const h = loadApp(() => echo());
  const id = h.t.newSubmissionId();
  assert.match(id, /^sub-[0-9a-f]{32}$/);
  assert.notEqual(h.t.newSubmissionId(), id, 'one id per form');
  await h.t.submitPaymentReport(CYCLE_IN, VALUES, false, id);
  await h.t.submitPaymentReport(CYCLE_IN, VALUES, true, id);
  assert.deepEqual(h.posts.map((b) => b.report.submissionId), [id, id]);
});

/* ============================ Code.gs (the real file) ============================ */

const PROXY_SECRET = 'proxy-secret-TEST-payment-persistence-0123456789abcdef';
const VERED = () => ({
  proxySecret: PROXY_SECRET, proxyUser: 'ורד', user: 'ורד', proxyAuth: 'personal', proxyUserId: 'vered',
  proxyRoles: ['staff', 'reporter', 'deleter'], proxyCaps: ['finance', 'billingControl'],
});
const israelDay = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date(ms));
const GS_CYCLE = {
  id: 'pay::arfoni::דנה כהן::2026-09-15::2026-09-15', patientId: 'arfoni::דנה כהן::2026-09-15',
  patientName: 'דנה כהן', houseId: 'arfoni', dueDate: '2026-09-15', amount: 30000,
  coverageStart: '2026-09-15', coverageEnd: '2026-10-14',
};

function world() {
  const g = loadGs({ props: { PROXY_SECRET, PROXY_SECRET_MODE: 'enforce' } });
  const S = g.sandbox.__sheets;
  const pcols = arr(g.run('PATIENT_COLUMNS'));
  S.Patients = richSheet('Patients', pcols);
  S.Patients.appendRow(pcols.map((c) => ({ id: 'p1', houseId: 'arfoni', name: 'דנה כהן', date: '2026-09-15', pay: 30000, status: 'active' }[c] || '')));
  const report = (extra, amount) => plain(g.post(Object.assign({ action: 'reportPayment', report: Object.assign({
    cycle: GS_CYCLE,
    report: {
      receivedDate: israelDay(Date.now() - 86400000), amount: amount || 30000, method: 'העברה בנקאית',
      payer: 'משפחת כהן', reference: 'TRX-1', funder: 'פרטי', invoiceWanted: 'no',
      coverageStart: '2026-09-15', coverageEnd: '2026-10-14',
    },
  }, extra || {}) }, VERED())));
  const rows = () => g.sheetRows('Payments', 'PAYMENT_COLUMNS');
  const receipts = () => rows().filter((r) => String(r.id).indexOf('rcpt-') === 0);
  const getPayments = () => plain(g.post(Object.assign({ action: 'getPayments' }, VERED())));
  return { g, S, report, rows, receipts, getPayments };
}

test('R5 (server): the same submissionId twice → ONE receipt; the retry replays the stored answer', () => {
  const w = world();
  const sid = 'sub-0123456789abcdef0123456789abcdef';
  const first = w.report({ submissionId: sid });
  assert.equal(first.ok, true, JSON.stringify(first));
  const retry = w.report({ submissionId: sid });
  assert.equal(retry.ok, true, 'a lost response is retried safely: ' + JSON.stringify(retry));
  assert.equal(retry.replayed, true);
  assert.equal(retry.receipt.id, first.receipt.id, 'the SAME persisted receipt id');
  assert.equal(retry.cycle.status, 'paid');
  assert.equal(w.receipts().length, 1, 'never a second receipt row');
  // …even when the retry carries «כן, קבלה נוספת».
  const confirmed = w.report({ submissionId: sid, confirmDuplicate: true });
  assert.equal(confirmed.replayed, true);
  assert.equal(w.receipts().length, 1);
  // The receipt row stores its submission id (append-only column, at the END).
  assert.equal(w.receipts()[0].submissionId, sid);
  const cols = arr(w.g.run('PAYMENT_COLUMNS'));
  assert.equal(cols[cols.length - 1], 'submissionId');
  assert.equal(w.S.Payments.grid[0][cols.length - 1], 'submissionId');
  // getPayments reads it back paid, the receipt linked to its cycle.
  const got = w.getPayments();
  assert.equal(got.payments.find((p) => p.id === GS_CYCLE.id).status, 'paid');
  assert.equal(got.receipts[0].cycleId, GS_CYCLE.id);
});

test('R5 (server): a DIFFERENT submission is still a new report (possible_duplicate guard unchanged)', () => {
  const w = world();
  assert.equal(w.report({ submissionId: 'sub-aaaaaaaaaaaaaaaa' }).ok, true);
  const second = w.report({ submissionId: 'sub-bbbbbbbbbbbbbbbb' });
  assert.equal(second.error, 'possible_duplicate');
  assert.equal(w.receipts().length, 1);
  // No id at all (an older client) still works.
  assert.equal(w.report({}, 1000).ok, true);
  assert.equal(w.receipts().length, 2);
});

test('R5 (server): a malformed submissionId is refused and nothing is written', () => {
  const w = world();
  for (const bad of ['x', 'sub-<script>', 'sub-' + 'a'.repeat(80), '=HYPERLINK("x")', 42]) {
    const r = w.report({ submissionId: bad });
    assert.equal(r.ok, false, String(bad));
    assert.equal(r.error, 'bad_submission_id');
  }
  assert.equal(w.receipts().length, 0);
});

test('R5 (server): submissionId is server-owned on savePayment and text-forced', () => {
  const w = world();
  assert.ok(arr(w.g.run('PAYMENT_SERVER_COLUMNS')).includes('submissionId'));
  assert.ok(arr(w.g.run('PAYMENT_TEXT_COLUMNS')).includes('submissionId'));
});

test('SW: CACHE_VERSION bumped past the live v47 (never v17)', () => {
  const m = /var CACHE_VERSION = 'v(\d+)'/.exec(SW_SRC);
  assert.ok(m && Number(m[1]) >= 48 && m[1] !== '17', m && m[1]);
});
