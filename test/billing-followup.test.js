'use strict';

// Real queue endpoint + real debt-aging engine, synthetic Sheets only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { loadGs, richSheet } = require('./helpers/gs-sandbox');
const rules = require('../lib/billing-control-rules');
const plain = x => JSON.parse(JSON.stringify(x));
const SECRET = 'synthetic-followup-0123456789abcdef';
const name = 'SYNTHETIC FOLLOWUP';
const pid = `arfoni::${name}::2026-10-01`;
const cycle = { id: `pay::${pid}::2026-10-01`, patientId: pid, patientName: name, houseId: 'arfoni',
  dueDate: '2026-10-01', amount: 10000, amountPaid: 6000, balance: 4000, status: 'partial',
  coverageStart: '2026-10-01', coverageEnd: '2026-10-31', legacyAmountPaid: '' };
const receipt = { id: 'rcpt-fixture-followup', patientId: pid, patientName: name, houseId: 'arfoni',
  dueDate: '2026-10-01', amount: 6000, amountPaid: 6000, balance: 0, status: 'paid',
  coverageStart: '2026-10-01', coverageEnd: '2026-10-31', receivedDate: '2026-10-02',
  recordedAt: '2026-10-03T10:00:00+03:00', confirmStatus: 'partial', confirmedAmount: 4000 };

function world(opts = {}) {
  const g = loadGs({ props: { PROXY_SECRET: SECRET, PROXY_SECRET_MODE: 'enforce' } });
  const today = opts.today || '2026-10-15';
  g.run(`paymentReportToday_ = () => ${JSON.stringify(today)}`);
  const add = (sheet, columns, rows) => {
    const cols = Array.from(g.run(columns));
    g.sandbox.__sheets[sheet] = richSheet(sheet, cols);
    rows.forEach(r => g.sandbox.__sheets[sheet].appendRow(cols.map(c => r[c] ?? '')));
  };
  add('Patients', 'PATIENT_COLUMNS', [{ id: 'p-fixture', houseId: 'arfoni', name,
    date: '2026-10-01', pay: 10000, status: 'active', notes: 'SYNTHETIC CLINICAL SECRET' }]);
  add('Payments', 'PAYMENT_COLUMNS', opts.rows || [cycle, receipt]);
  if (opts.funder) add('Funders', 'FUNDER_COLUMNS', [{ patientId: 'p-fixture', funder: opts.funder, effectiveFrom: '2026-10-01' }]);
  const actor = id => ({ proxySecret: SECRET, proxyAuth: 'personal', proxyUserId: id, user: id, proxyUser: id,
    proxyRoles: id === 'ortal' ? ['controller'] : ['staff', 'reporter'],
    proxyCaps: id === 'ortal' ? ['billingControl'] : id === 'vered' ? ['billingControl', 'finance'] : [] });
  const queue = (id = 'ortal') => plain(g.post({ action: 'billingControlQueue', ...actor(id) }));
  const snapshot = () => JSON.stringify(g.sandbox.__sheets);
  return { g, queue, snapshot };
}

test('10000 / 6000 / 4000: cycle remainder and verification gap stay separate, without writes', () => {
  const w = world(), before = w.snapshot();
  const q = w.queue();
  assert.equal(q.ok, true);
  assert.equal(q.followup.complete, true);
  const work = rules.followupRows(q);
  assert.deepEqual(work.map(r => [r.kind, r.amount, r.owner]), [['recorded', 4000, 'vered'], ['partial', 2000, 'ortal']]);
  assert.equal(work[0].originalDueDate, '2026-10-01');
  assert.equal(work[1].ageDays, 12);
  assert.equal(w.snapshot(), before);
  const json = JSON.stringify(q.followup);
  for (const forbidden of [pid, 'SYNTHETIC CLINICAL SECRET', 'patientUid', 'patientId', 'paymentUid']) assert.ok(!json.includes(forbidden));
});

test('full verification echo closes only receipt work, leaving the 4000 cycle balance', () => {
  const q = world().queue();
  q.receipts[0] = { ...q.receipts[0], confirmStatus: 'confirmed', confirmedAmount: 6000 };
  assert.deepEqual(rules.followupRows(q).map(r => [r.kind, r.amount]), [['recorded', 4000]]);
});

test('a due cycle with no Payments row appears before 60 days and is not labelled verified debt', () => {
  const q = world({ rows: [] }).queue();
  assert.equal(q.debt60.unrecorded.count, 0);
  assert.deepEqual(rules.followupRows(q).map(r => [r.kind, r.amount, r.ageDays]), [['unrecorded', 10000, 14]]);
});

test('institutional day 30 waits; day 31 resumes ordinary work without changing the source amount', () => {
  for (const [today, grace] of [['2026-10-31', true], ['2026-11-01', false]]) {
    const q = world({ today, funder: 'ביטוח לאומי' }).queue();
    const r = rules.followupRows(q).find(r => r.kind === 'recorded');
    assert.equal(r.amount, 4000);
    assert.equal(r.funderGrace, grace);
    assert.equal(r.owner, grace ? 'ortal' : 'vered');
  }
});

test('pro-bono and future cycles keep debt-aging exclusions', () => {
  assert.equal(world({ rows: [], funder: 'פרו-בונו' }).queue().followup.cycles.length, 0);
  assert.equal(world({ rows: [], today: '2026-09-30' }).queue().followup.cycles.length, 0);
});

test('failed aging is visibly incomplete while receipt work survives; failed queue is not empty success', () => {
  const w = world();
  w.g.run('debtAgingAction_ = () => { throw new Error("SYNTHETIC unavailable"); }');
  const q = w.queue();
  assert.equal(q.followup.complete, false);
  assert.equal(rules.followupRows(q)[0].amount, 2000);
  w.g.sandbox.__sheets.Payments.getRange = () => { throw new Error('SYNTHETIC sheet error'); };
  assert.equal(w.queue().ok, false);
});

test('flagging changes the responsible role but keeps both original dates', () => {
  const q = world().queue();
  q.receipts[0] = { ...q.receipts[0], confirmStatus: 'flagged', flaggedAt: '2026-10-15', flagNote: 'SYNTHETIC issue' };
  const r = rules.followupRows(q).find(r => r.kind === 'flagged');
  assert.deepEqual([r.owner, r.amount, r.openedDate, r.originalDueDate, r.ageDays], ['vered', 6000, '2026-10-03', '2026-10-01', 12]);
});

test('receipt age uses the Israel calendar day even when the UTC date is yesterday', () => {
  const w = world({ rows: [cycle, { ...receipt, recordedAt: '2026-10-02T22:30:00Z' }] });
  w.g.sandbox.Utilities.formatDate = (d, zone) => new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date(d));
  const q = w.queue(), r = rules.followupRows(q).find(r => r.receiptId);
  assert.equal(q.followup.receiptRecordedDates[receipt.id], '2026-10-03');
  assert.equal(r.openedDate, '2026-10-03');
  assert.equal(r.ageDays, 12);
});

test('voids, overpayments and multiple receipts do not invent a combined debt total', () => {
  const rows = [cycle, { ...receipt, amount: 12000, amountPaid: 12000, confirmedAmount: 9000 },
    { ...receipt, id: 'rcpt-void-fixture', status: 'void' }];
  const q = world({ rows }).queue();
  assert.deepEqual(rules.followupRows(q).map(r => [r.kind, r.amount]), [['partial', 3000]]);
  assert.equal(Object.hasOwn(q.followup, 'total'), false);
});

test('missing dates remain unknown, and role/house filters do not mutate the source', () => {
  const q = world().queue(), original = JSON.stringify(q);
  assert.equal(rules.followupRows(q, { owner: 'ortal', house: 'arfoni' }).length, 1);
  assert.equal(rules.followupRows(q, { house: 'other' }).length, 0);
  assert.equal(JSON.stringify(q), original);
  q.receipts[0].recordedAt = '';
  q.followup.receiptRecordedDates[q.receipts[0].id] = '';
  delete q.followup.receiptDueDates[q.receipts[0].id];
  const r = rules.followupRows(q).find(r => r.receiptId);
  assert.equal(r.ageDays, null);
  assert.equal(r.originalDueDate, '');
});

test('authorization remains enforced before the new projection, and Vered still cannot verify', () => {
  const w = world(), before = w.snapshot();
  assert.equal(w.queue('shiran').ok, false);
  assert.equal(w.queue('vered').ok, true);
  const res = w.g.post({ action: 'confirmPayment', confirm: { ids: [receipt.id], status: 'confirmed' },
    proxySecret: SECRET, proxyAuth: 'personal', proxyUserId: 'vered', proxyUser: 'vered', user: 'vered',
    proxyRoles: ['staff', 'reporter'], proxyCaps: ['billingControl', 'finance'] });
  assert.equal(res.ok, false);
  assert.equal(w.snapshot(), before);
});

function app() {
  const noop = () => {};
  const elements = {};
  const s = { console, location: { origin: 'http://test', hash: '' },
    document: { addEventListener: noop, getElementById: id => elements[id] || null,
      querySelectorAll: () => [], body: { classList: { toggle: noop } } },
    localStorage: { getItem: () => null, setItem: noop }, setTimeout: noop, clearTimeout: noop,
    URL, URLSearchParams, Intl };
  s.window = s; s.globalThis = s;
  vm.createContext(s);
  for (const f of ['lib/payment-report-rules.js', 'lib/billing-control-rules.js', 'public/funder.js', 'public/app.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), s);
  }
  return { run: code => vm.runInContext(code, s), s, elements };
}

test('rendered work rows escape data, preserve neutral grace and offer navigation only', () => {
  const a = app();
  a.s.fixture = [{ kind: 'unrecorded', owner: 'ortal', patientName: '<img src=x onerror=alert(1)>', houseId: 'arfoni',
    amount: 10000, originalDueDate: '2026-10-01', ageDays: 14, funderGrace: true, funderGraceUntil: '2026-10-31' }];
  const html = a.run('bcFollowupHtml(fixture)');
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;img'));
  assert.ok(html.includes('ממתין לגורם מממן'));
  assert.ok(html.includes('bc-followup-waiting'));
  assert.ok(!html.includes('data-bc-confirm'));
  assert.ok(!html.includes('<input'));
});

test('partial-source rendering never promises there are no open balances', () => {
  const a = app(), cl = { toggle() {} };
  for (const id of ['screen-billing-control', 'bc-followup', 'bc-followup-count', 'bc-followup-warning']) {
    a.elements[id] = { innerHTML: '', textContent: '', classList: cl };
  }
  a.s.fixture = { ok: true, today: '2026-10-15', receipts: [], followup: { complete: false, cycles: [] } };
  a.run('state.billingControl = true; billingControlState().data = fixture; renderBillingControl()');
  assert.ok(a.elements['bc-followup-warning'].textContent.includes('הנתונים חלקיים'));
  assert.equal(a.elements['bc-followup-count'].innerHTML, '0+');
  assert.ok(!a.elements['bc-followup'].innerHTML.includes('אין פריטים'));
});

test('filters and source buttons only select existing work and navigate, with no API writes', () => {
  const a = app(), handlers = {}, calls = [], cl = { toggle() {} };
  const row = { getAttribute: key => key === 'data-bc-id' ? receipt.id : null,
    setAttribute: (key, value) => calls.push([key, value]), focus: () => calls.push('focus'),
    scrollIntoView: () => calls.push('receipt-scroll') };
  a.elements['screen-billing-control'] = {
    addEventListener: (event, fn) => { handlers[event] = fn; },
    querySelectorAll: () => [row],
  };
  for (const id of ['bc-followup', 'bc-followup-count', 'bc-followup-warning', 'bc-followup-house', 'bc-followup-owner']) {
    a.elements[id] = { innerHTML: '', textContent: '', classList: cl, value: 'all' };
  }
  a.elements['debt-aging-view'] = { open: false, scrollIntoView: () => calls.push('debt-scroll') };
  a.s.document.querySelector = selector => selector === '.tab[data-screen="billing"]' ? { click: () => calls.push('billing-tab') } : null;
  a.s.fixture = world().queue();
  a.run('state.billingControl = true; billingControlState().data = fixture; apiPost = () => { throw new Error("unexpected write"); }; initBillingControlControls(); renderBillingControl()');
  assert.equal(a.elements['bc-followup-count'].innerHTML, '2');
  a.elements['bc-followup-owner'].value = 'vered';
  a.elements['bc-followup-owner'].onchange();
  assert.equal(a.elements['bc-followup-count'].innerHTML, '1');
  assert.ok(a.elements['bc-followup'].innerHTML.includes('4,000'));
  const click = (attribute, value) => handlers.click({ target: { closest: () => ({ getAttribute: key => key === attribute ? value : null }) } });
  click('data-bc-follow-receipt', receipt.id);
  click('data-bc-follow-debt', 'true');
  assert.deepEqual(calls, [['tabindex', '-1'], 'focus', 'receipt-scroll', 'billing-tab', 'debt-scroll']);
  assert.equal(a.elements['debt-aging-view'].open, true);
});

test('confirmation updates receipt work immediately; a void invalidates cycles until the guarded refresh', async () => {
  const a = app();
  a.s.fixture = world().queue();
  a.s.answer = { ok: true, changed: [{ ...a.s.fixture.receipts[0], confirmStatus: 'confirmed', confirmedAmount: 6000 }] };
  a.run('state.canConfirm = true; billingControlState().data = fixture; showToast = () => {}; apiPost = async () => answer; var refreshes = 0; loadBillingControl = async () => { refreshes++; };');
  await a.run(`confirmReceipts([${JSON.stringify(receipt.id)}], 'confirmed')`);
  assert.deepEqual(plain(a.run('bcRules().followupRows(billingControlState().data).map(r => [r.kind, r.amount])')), [['recorded', 4000]]);
  assert.equal(a.run('refreshes'), 0, 'confirmation needs no extra read');
  a.s.answer = { ok: true, changed: [], voided: [{ id: receipt.id }] };
  await a.run(`confirmReceipts([${JSON.stringify(receipt.id)}], 'duplicate', { flagNote: 'SYNTHETIC duplicate' })`);
  await Promise.resolve();
  assert.equal(a.run('billingControlState().data.followup.complete'), false);
  assert.equal(a.run('billingControlState().data.followup.cycles.length'), 0);
  assert.equal(a.run('refreshes'), 1);
});
