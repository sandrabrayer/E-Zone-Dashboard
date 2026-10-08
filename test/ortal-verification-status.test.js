/* «בקרת גבייה» status dropdown, partial amount, remaining balance, the note,
 * and Ortal's read-only «גבייה» — the page side (PR 2, UI).
 * CHANGELOG-ortal-verification-status.md. public/app.js and
 * lib/billing-control-rules.js run in a vm; the real-Chromium flow is
 * test/ortal-verification-status-browser.test.js. All names are SYNTHETIC. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const RULES_SRC = fs.readFileSync(path.join(ROOT, 'lib', 'billing-control-rules.js'), 'utf8');
const PR_RULES_SRC = fs.readFileSync(path.join(ROOT, 'lib', 'payment-report-rules.js'), 'utf8');
const HTML_SRC = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const CSS_SRC = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
const SW_SRC = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');
const SERVER_SRC = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const FUNDER_SRC = fs.readFileSync(path.join(ROOT, 'public', 'funder.js'), 'utf8');
const plain = (v) => JSON.parse(JSON.stringify(v));

function loadApp() {
  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/', hash: '', reload: noop },
    document: {
      addEventListener: noop,
      body: { classList: { toggle: noop, add: noop, remove: noop, contains: () => false } },
      getElementById: () => null, createElement: () => ({}), querySelectorAll: () => [],
    },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    setTimeout: noop, clearTimeout: noop,
    fetch: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) }),
    URL, URLSearchParams, Intl, Math, Date, JSON, Number, String, Array, Object, RegExp, Promise,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(PR_RULES_SRC, sandbox);
  vm.runInContext(RULES_SRC, sandbox);
  vm.runInContext(FUNDER_SRC, sandbox);
  vm.runInContext(APP_SRC + `
    globalThis.__test = {
      get state() { return state; },
      normalizeReceipt, buildMonthlyRevenue, allowedScreens, resolveScreen, billingTabView, billingReadView,
      bcReceiptHtml, bcCardsHtml, bcStatusSelectHtml, bcPartialFormHtml, bcControlNoteHtml, bcRemainingText,
      billingControlState, BC_ERRORS, isProbonoOn,
    };`, sandbox);
  return { app: sandbox.__test, sandbox };
}

const R = (over) => Object.assign({
  id: 'rcpt-1', patientName: 'דנה כהן', houseId: 'arfoni', amount: 10000, receivedDate: '2026-10-01',
  method: 'העברה בנקאית', reference: 'TRX-1', payer: 'משפחת כהן', funder: 'פרטי', recordedBy: 'ורד', confirmStatus: 'reported',
}, over || {});

/* ============================ status enum ============================ */

test('status dropdown: exactly שולם / שולם חלקית / לא שולם / כפילות (+ the blank «בחרו סטטוס»), values from the shared enum, current one selected', () => {
  const { app } = loadApp();
  const html = app.bcStatusSelectHtml(R());
  const opts = [...html.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map((m) => [m[1], m[2]]);
  // «כפילות» added by CHANGELOG-receipt-duplicates-and-edit.md.
  assert.deepEqual(opts, [['', 'בחרו סטטוס…'], ['confirmed', 'שולם'], ['partial', 'שולם חלקית'], ['flagged', 'לא שולם'], ['duplicate', 'כפילות']]);
  assert.match(html, /<option value="" selected disabled>/, 'a waiting row starts blank');
  assert.match(app.bcStatusSelectHtml(R({ confirmStatus: 'partial' })), /<option value="partial" selected>/);
  assert.match(app.bcStatusSelectHtml(R({ confirmStatus: 'flagged' })), /<option value="flagged" selected>/);
  // Every value is one Code.gs accepts.
  const rules = require('../lib/billing-control-rules');
  for (const [v] of opts.slice(1)) assert.ok(rules.CONTROL_STATUSES.includes(v) || v === rules.DUPLICATE_DECISION, v);
  // The server's refusal codes all have a Hebrew message.
  for (const code of ['partial_single', 'partial_amount_invalid', 'partial_amount_range', 'control_note_invalid', 'control_note_single', 'confirm_status_invalid']) {
    assert.ok(/[֐-׿]/.test(app.BC_ERRORS[code]), code);
  }
});

/* ============================ partial + remaining ============================ */

test('partial: the form shows the reported amount and the live remaining balance; the partial row shows verified, of, and «יתרה פתוחה»', () => {
  const { app } = loadApp();
  app.state.canConfirm = true;
  assert.equal(app.bcRemainingText(10000, 6000), 'יתרה פתוחה: ₪ 4,000');
  assert.equal(app.bcRemainingText(10000, 0), 'יתרה פתוחה: ₪ 10,000');
  assert.equal(app.bcRemainingText(100, 99.99), 'יתרה פתוחה: ₪ 0.01');
  const s = app.billingControlState();
  s.partialOpen = 'rcpt-1'; s.partialDraft = '2500';
  const form = app.bcPartialFormHtml(R());
  assert.match(form, /מתוך ₪ 10,000/);
  assert.match(form, /יתרה פתוחה: ₪ 7,500/);
  assert.match(form, /inputmode="decimal"/);
  assert.match(form, /dir="ltr"/);
  s.partialDraft = '20000';   // out of range → the remaining line shows the whole amount
  assert.match(app.bcPartialFormHtml(R()), /יתרה פתוחה: ₪ 10,000/);
  s.partialOpen = '';
  const row = app.bcReceiptHtml(R({ confirmStatus: 'partial', verifiedAmount: 6000, openAmount: 4000, confirmedAmount: 6000 }), 'partial');
  assert.match(row, /אומת ₪ 6,000 מתוך ₪ 10,000/);
  assert.match(row, /יתרה פתוחה: ₪ 4,000/);
  assert.match(row, /data-bc-status="rcpt-1"/);
  // «לא שולם» rows show the whole amount open.
  assert.match(app.bcReceiptHtml(R({ confirmStatus: 'flagged', flagNote: 'לא הגיע' }), 'flagged'), /יתרה פתוחה: ₪ 10,000/);
});

test('remaining-debt math on the page: the «יתרה פתוחה» card = the lib openDebt; «מאומת» on הכנסות חודשיות counts only the confirmed part of a partial receipt', () => {
  const { app } = loadApp();
  const rules = require('../lib/billing-control-rules');
  const receipts = [
    R({ id: 'rcpt-a', confirmStatus: 'partial', confirmedAmount: 6000, coverageStart: '2026-10-01', coverageEnd: '2026-10-31' }),
    R({ id: 'rcpt-b', confirmStatus: 'flagged', amount: 4000, coverageStart: '2026-10-01', coverageEnd: '2026-10-31' }),
    R({ id: 'rcpt-c', confirmStatus: 'confirmed', amount: 2500, coverageStart: '2026-10-01', coverageEnd: '2026-10-31' }),
  ];
  const cards = rules.summaryCards({ receipts }, '2026-10');
  assert.deepEqual(plain(cards.openDebt), { partial: { count: 1, amount: 4000 }, notReceived: { count: 1, amount: 4000 }, total: 8000 });
  assert.equal(cards.confirmedThisMonth.amount, 8500);
  const html = app.bcCardsHtml(Object.assign({}, cards, { debt60: null }));
  assert.match(html, /id="bc-card-open">₪ 8,000</);
  assert.match(html, /חלקי ₪ 4,000 · לא שולם ₪ 4,000/);
  // normalizeReceipt keeps confirmedAmount / controlNote (raw getPayments rows).
  const n = app.normalizeReceipt({ id: 'rcpt-a', amountPaid: 10000, confirmStatus: 'partial', confirmedAmount: 6000, controlNote: 'x' });
  assert.deepEqual([n.amount, n.confirmStatus, n.confirmedAmount, n.controlNote], [10000, 'partial', 6000, 'x']);
  assert.equal(rules.verifiedAmountOf(n), 6000);
  assert.equal(rules.openAmountOf(n), 4000);
});

/* ============================ the note + escaping ============================ */

test('escaping: the note, the flag note and every field render as text — no tag, no attribute break-out — for Ortal, Vered and in the editor', () => {
  const { app } = loadApp();
  const evil = '<img src=x onerror=alert(1)> "q" & \'s\'';
  const r = R({ patientName: '<b>x</b>', payer: '"><script>1</script>', controlNote: evil, confirmStatus: 'flagged', flagNote: '<i>n</i>' });
  for (const can of [true, false]) {
    app.state.canConfirm = can;
    const html = app.bcReceiptHtml(r, 'flagged');
    assert.ok(!/<img|<script|<b>x|<i>n/.test(html), 'escaped (can=' + can + ')');
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt; &quot;q&quot; &amp; &#39;s&#39;') || html.includes('&lt;img src=x onerror=alert(1)&gt; &quot;q&quot; &amp; \'s\''), 'the note as text');
  }
  app.state.canConfirm = true;
  const s = app.billingControlState();
  s.noteOpen = 'rcpt-1'; s.noteDraft = evil;
  const editor = app.bcControlNoteHtml(r, true);
  assert.ok(!/<img/.test(editor), 'the textarea content is escaped');
  assert.match(editor, /maxlength="500"/);
  assert.match(editor, /\d+ \/ 500/);
  s.noteOpen = '';
  // A hostile id never breaks out of an attribute.
  const idHtml = app.bcReceiptHtml(R({ id: 'rcpt-"><img src=x>' }), 'queue');
  assert.ok(!/<img/.test(idHtml));
});

test('the note: «+ הערה» on every row for a decider (queue, «לא שולם», partial, confirmed); none for Vered — who still reads the text', () => {
  const { app } = loadApp();
  app.state.canConfirm = true;
  for (const [mode, st] of [['queue', 'reported'], ['flagged', 'flagged'], ['partial', 'partial'], ['confirmed', 'confirmed']]) {
    assert.match(app.bcReceiptHtml(R({ confirmStatus: st, flagNote: 'x' }), mode, { inMonth: 1 }), /data-bc-cnote-open="rcpt-1"/, mode);
  }
  assert.match(app.bcReceiptHtml(R({ controlNote: 'קיים' }), 'queue'), /✎ עריכת הערה/);
  app.state.canConfirm = false;
  const v = app.bcReceiptHtml(R({ controlNote: 'קיים' }), 'queue');
  assert.ok(!/data-bc-cnote-open|<textarea|<select/.test(v));
  assert.match(v, /<b>הערה:<\/b> קיים/);
  // Sandra's exceptions list stays without any control.
  app.state.canConfirm = true;
  assert.ok(!/<button|<select|<textarea/.test(app.bcReceiptHtml(R({ controlNote: 'x' }), 'exception')));
});

test('no element id twice: a partial receipt listed under «אומתו» by month carries no control (its controls are in «שולם חלקית»)', () => {
  const { app } = loadApp();
  app.state.canConfirm = true;
  const s = app.billingControlState();
  s.noteOpen = 'rcpt-1'; s.partialOpen = 'rcpt-1';
  const p = R({ confirmStatus: 'partial', confirmedAmount: 6000 });
  const inMonth = app.bcReceiptHtml(p, 'confirmed', { inMonth: 3000 });
  assert.ok(!/<select|<textarea|<input|<button/.test(inMonth), inMonth.slice(0, 300));
  // CHANGELOG-receipt-duplicates-and-edit.md: the month slice of the
  // CONFIRMED part, named as such; «שולם חלקית» only on a partial receipt.
  assert.match(inMonth, /חלק החודש: ₪ 3,000 · אומת ₪ 6,000 מתוך ₪ 10,000 \(תקופה 01\/10–01\/10\) · שולם חלקית/, 'its month slice of the CONFIRMED part');
  const own = app.bcReceiptHtml(p, 'partial');
  assert.match(own, /id="bc-cnote-rcpt-1"/);
  assert.match(own, /id="bc-partial-rcpt-1"/);
});

/* ============================ permissions (page side) ============================ */

test('permissions (page): Ortal opens «בקרת גבייה» first and «גבייה» only with billingRead; Shiran / Yael (restricted) get neither', () => {
  const { app } = loadApp();
  assert.deepEqual(plain(app.allowedScreens(false, 'controller')), ['billing-control']);
  assert.deepEqual(plain(app.allowedScreens(false, 'controller', false)), ['billing-control']);
  assert.deepEqual(plain(app.allowedScreens(false, 'controller', true)), ['billing-control', 'billing']);
  assert.equal(app.resolveScreen('billing', false, 'controller', true), 'billing');
  assert.equal(app.resolveScreen('revenue', false, 'controller', true), 'billing-control', 'no other money tab');
  assert.equal(app.resolveScreen('billing', false, 'controller', false), 'billing-control');
  const restricted = plain(app.allowedScreens(false, 'restricted', true));
  assert.ok(!restricted.includes('billing') && !restricted.includes('billing-control'), 'billingRead never opens it for a restricted session');
  // billingTabView: only the finance view or the controller with billingRead.
  app.state.view = 'controller'; app.state.finance = false; app.state.billingRead = true;
  assert.equal(app.billingTabView(), true);
  app.state.billingRead = false;
  assert.equal(app.billingTabView(), false);
  app.state.view = 'restricted'; app.state.billingRead = true;
  assert.equal(app.billingTabView(), false);
});

test('wiring: index.html section, CSS (read-only + RTL + mobile), the server body class, SW >= v40 (never v17)', () => {
  assert.ok(HTML_SRC.includes('id="bc-partial"') && HTML_SRC.includes('id="bc-partial-count"') && HTML_SRC.includes('id="bc-partial-open"'));
  assert.match(HTML_SRC, /«שולם», «שולם חלקית» \(מזינים כמה התקבל\) או «לא שולם»/);
  assert.ok(!HTML_SRC.includes('✓ «אושר בבנק» או ⚑'), 'the old ✓ / ⚑ help text is gone');
  assert.match(CSS_SRC, /body\.view-controller\.view-billing-read \.tabs \.tab\[data-screen="billing"\]/);
  for (const sel of ['.bill-report-btn', '.bill-amount-edit-btn', '.bill-cov-edit-btn', '.receipt-void-btn', '#funder-fill']) {
    assert.ok(CSS_SRC.includes(sel.startsWith('#') ? 'body.view-controller ' + sel : 'body.view-controller #screen-billing ' + sel), sel + ' hidden for Ortal');
  }
  assert.match(CSS_SRC, /\.bc-status \{ min-height: 44px;/);
  assert.match(CSS_SRC, /@media \(max-width: 480px\) \{\n  \.bc-status-wrap \{ flex-basis: 100%; \}/);
  assert.match(SERVER_SRC, /'<body class="view-controller view-billing-read">'/);
  const v = /var CACHE_VERSION = 'v(\d+)';/.exec(SW_SRC)[1];
  // v40 shipped this change; later public/ changes bump past it (v41: the
  // re-landed reactivation fix). v17 must never come back.
  assert.ok(Number(v) >= 40, 'CACHE_VERSION must be v40 or later, got v' + v);
  assert.notEqual(v, '17');
  assert.match(SW_SRC, /v39 → v40:/);
});

test('Ortal\'s read-only «גבייה»: a pro-bono patient is left out exactly as for Vered (the funder data is loaded and read for her)', () => {
  const { app } = loadApp();
  const p = { id: 'pt-1', houseId: 'arfoni', name: 'דנה כהן', date: '2026-07-15', status: 'active', pay: 25000 };
  app.state.funders = [{ patientId: 'pt-1', funder: 'פרו-בונו', effectiveFrom: '2026-09-01', setBy: 'ורד', setAt: '2026-09-01T09:00:00+03:00' }];
  // Vered (finance): pro-bono from September.
  app.state.view = 'full'; app.state.finance = true; app.state.billingRead = false;
  assert.equal(app.isProbonoOn(p, '2026-09-15'), true);
  assert.equal(app.isProbonoOn(p, '2026-08-15'), false);
  // Ortal (controller + billingRead): the same answer.
  app.state.view = 'controller'; app.state.finance = false; app.state.billingRead = true;
  assert.equal(app.isProbonoOn(p, '2026-09-15'), true);
  assert.equal(app.isProbonoOn(p, '2026-08-15'), false);
  // Shiran (restricted): no funder view at all.
  app.state.view = 'restricted'; app.state.billingRead = false;
  assert.equal(app.isProbonoOn(p, '2026-09-15'), false);
  // loadBillingRead keeps the Funders rows from getPayments.
  // Since CHANGELOG-payment-report-persistence.md it goes through the
  // sequence-guarded applyPaymentsRead, which sets state.funders.
  assert.match(APP_SRC, /async function loadBillingRead\(\)[\s\S]*?applyPaymentsRead\(paymentsTicket, p\.value\)/);
  assert.match(APP_SRC, /function paymentsStateFrom\(pr\)[\s\S]*?funders: \(Array\.isArray\(pr && pr\.funders\)/);
  assert.match(APP_SRC, /function applyPaymentsRead\(ticket, pr\)[\s\S]*?state\.funders = next\.funders;/);
});
