'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { loadGs, richSheet } = require('./helpers/gs-sandbox');
const { review } = require('../lib/billing-document-review');
const billing = require('../lib/billing-control-rules');
const plain = x => JSON.parse(JSON.stringify(x));
const receipt = extra => ({ id: 'rcpt-fixture', patientName: 'דוגמה', houseId: 'arfoni',
  receivedDate: '2026-10-01', invoiceWanted: 'yes', invoiceTo: 'משפחת דוגמה',
  confirmStatus: 'reported', amount: 1200, amountPaid: 1200, status: 'paid', ...extra });
const queue = receipts => ({ ok: true, today: '2026-10-16', receipts,
  followup: { complete: true, cycles: [] } });

test('all verification states retain an invoice request, without claiming issuance or changing financial/reminder views', () => {
  for (const confirmStatus of ['reported', 'partial', 'flagged', 'confirmed']) {
    const q = queue([receipt({ confirmStatus, confirmedAmount: 500, controlNote: 'חשבונית הופקה 123' })]);
    const before = JSON.stringify(q), reminders = billing.reminderPreview(q), verified = billing.verifiedForMonth(q.receipts, '2026-10', 'all');
    const r = review(q);
    assert.equal(r.requestedCount, 1);
    assert.deepEqual([r.rows[0].confirmStatus, r.rows[0].issuance], [confirmStatus, 'unrecorded']);
    assert.equal(JSON.stringify(q), before);
    assert.deepEqual(billing.reminderPreview(q), reminders);
    assert.deepEqual(billing.verifiedForMonth(q.receipts, '2026-10', 'all'), verified);
    for (const field of ['amount', 'amountPaid', 'controlNote', 'reference', 'patientUid', 'paymentUid']) assert.equal(Object.hasOwn(r.rows[0], field), false);
  }
});

test('no is excluded from request review only; legacy/invalid choices remain unknown, never issued', () => {
  const q = queue(['yes', 'no', '', undefined, 'YES', true].map((invoiceWanted, i) => receipt({ id: `r-${i}`, invoiceWanted })));
  const r = review(q);
  assert.deepEqual([r.requestedCount, r.excludedCount, r.unknownCount, r.rows.length], [1, 1, 4, 5]);
  assert.ok(r.rows.every(x => x.issuance === 'unrecorded'));
  assert.ok(r.rows.filter(x => x.kind === 'unknown').every(x => x.invoiceTo === ''));
  assert.equal(review(q, { kind: 'unknown' }).rows.length, 4);
});

test('house/kind filters do not hide global unknown counts or apply the verified-month filter', () => {
  const q = queue([receipt({ id: 'old', receivedDate: '2024-01-01' }), receipt({ id: 'new', houseId: 'ramot', invoiceWanted: '' })]);
  const r = review(q, { house: 'arfoni', kind: 'requested', month: '2026-10' });
  assert.deepEqual([r.requestedCount, r.unknownCount, r.rows.length, r.rows[0].receiptId], [1, 1, 1, 'old']);
  assert.equal(review(q, { house: 'missing' }).rows.length, 0);
});

test('unavailable, stale and malformed sources never become complete empty success', () => {
  for (const q of [null, {}, { ok: false, receipts: [] }, { ok: true }, { ok: true, receipts: {} }]) {
    assert.deepEqual([review(q).available, review(q).complete], [false, false]);
  }
  const r = review(queue([null, {}, receipt({ id: 'dup' }), receipt({ id: 'dup' }), receipt({ id: 'unknown-status', confirmStatus: 'future' })]), { stale: true });
  assert.equal(r.complete, false);
  assert.equal(r.stale, true);
  assert.equal(r.invalidCount, 5);
  assert.deepEqual(r.rows.map(x => [x.receiptId, x.confirmStatus]), [['unknown-status', 'unknown']]);
});

test('void/duplicate reports are excluded, genuine dates sort oldest first and unknown dates stay explicit', () => {
  const r = review(queue([
    receipt({ id: 'v', status: 'void' }), receipt({ id: 'd', linkStatus: 'duplicate' }),
    receipt({ id: 'late', receivedDate: '2026-10-05' }), receipt({ id: 'bad', receivedDate: '2026-02-30' }),
    receipt({ id: 'early', receivedDate: '2024-02-29' }), receipt({ id: 'missing', receivedDate: '' }),
  ]));
  assert.equal(r.requestedCount, 4);
  assert.deepEqual(r.rows.map(x => [x.receiptId, x.receivedDate]), [['early', '2024-02-29'], ['late', '2026-10-05'], ['bad', ''], ['missing', '']]);
});

test('unsupported document-like fields and transfer reference are not accepted as issuance evidence', () => {
  const r = review(queue([receipt({ invoiceNumber: '123', invoiceDate: '2026-10-01', documentStatus: 'issued', reference: 'BANK-123' })]));
  assert.equal(r.rows[0].issuance, 'unrecorded');
  assert.ok(!JSON.stringify(r).includes('BANK-123'));
  assert.equal(Object.hasOwn(r.rows[0], 'invoiceNumber'), false);
});

function gsWorld() {
  const secret = 'synthetic-document-review-0123456789';
  const g = loadGs({ props: { PROXY_SECRET: secret, PROXY_SECRET_MODE: 'enforce' } });
  const cols = Array.from(g.run('PAYMENT_COLUMNS'));
  g.sandbox.__sheets.Payments = richSheet('Payments', cols);
  const rows = [receipt({ paymentUid: 'PRIVATE-UID', reference: 'BANK-REF', notes: 'CLINICAL SECRET', confirmedAmount: '' })];
  rows.forEach(r => g.sandbox.__sheets.Payments.appendRow(cols.map(c => r[c] ?? '')));
  const actor = id => ({ proxySecret: secret, proxyAuth: 'personal', proxyUserId: id, proxyUser: id, user: id,
    proxyRoles: id === 'ortal' ? ['controller'] : id === 'sandra' ? ['approver'] : ['staff', 'reporter'],
    proxyCaps: ['ortal', 'sandra', 'vered'].includes(id) ? ['billingControl'] : [] });
  return { g, actor, q: id => plain(g.post({ action: 'billingControlQueue', ...actor(id) })) };
}

test('real queue projection is read-only and retains the request after real confirmPayment', () => {
  const w = gsWorld();
  const before = JSON.stringify(w.g.sandbox.__sheets);
  const q = w.q('ortal');
  assert.equal(q.ok, true);
  assert.equal(review(q).requestedCount, 1);
  assert.equal(JSON.stringify(w.g.sandbox.__sheets), before, 'review adds no sheet writes');
  const response = w.g.post({ action: 'confirmPayment', ...w.actor('ortal'), confirm: { ids: ['rcpt-fixture'], status: 'confirmed' } });
  assert.equal(response.ok, true, JSON.stringify(response));
  const after = review(w.q('ortal'));
  assert.deepEqual([after.requestedCount, after.rows[0].confirmStatus, after.rows[0].issuance], [1, 'confirmed', 'unrecorded']);
  assert.ok(!JSON.stringify(after).includes('PRIVATE-UID'));
  assert.ok(!JSON.stringify(after).includes('CLINICAL SECRET'));
});

test('existing queue access remains enforced and Vered cannot use verification as a completion shortcut', () => {
  const w = gsWorld();
  for (const id of ['ortal', 'sandra', 'vered']) assert.equal(w.q(id).ok, true, id);
  for (const id of ['shiran', 'yael']) assert.equal(w.q(id).ok, false, id);
  const before = JSON.stringify(w.g.sandbox.__sheets);
  assert.equal(w.g.post({ action: 'confirmPayment', ...w.actor('vered'), confirm: { ids: ['rcpt-fixture'], status: 'confirmed' } }).ok, false);
  assert.equal(JSON.stringify(w.g.sandbox.__sheets), before);
});

function app() {
  const noop = () => {}, elements = {};
  const s = { console, location: { origin: 'http://test', hash: '' }, document: { addEventListener: noop,
    getElementById: id => elements[id] || null, querySelectorAll: () => [], body: { classList: { toggle: noop } } },
    localStorage: { getItem: () => null, setItem: noop }, setTimeout: noop, clearTimeout: noop, URL, URLSearchParams, Intl };
  s.window = s; s.globalThis = s; vm.createContext(s);
  for (const f of ['lib/billing-document-review.js', 'public/funder.js', 'public/app.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), s);
  return { s, run: code => vm.runInContext(code, s) };
}

test('rendered review escapes all input and has no money, save, issue or send controls', () => {
  const a = app();
  a.s.q = queue([receipt({ patientName: '<img src=x>', invoiceTo: '<script>bad()</script>', houseId: '<i>house</i>', confirmStatus: 'confirmed' })]);
  const html = a.run('bcDocumentReviewHtml(BillingDocumentReview.review(q))');
  assert.ok(!html.includes('<img') && !html.includes('<script>') && !html.includes('<i>'));
  assert.ok(html.includes('&lt;img') && html.includes('&lt;script&gt;'));
  assert.match(html, /אומת/);
  assert.match(html, /מצב הנפקה: לא מתועד באפליקציה/);
  assert.ok(!/<input|<button|<textarea|₪/.test(html));
});

test('rendered unavailable/stale/empty/unknown states never claim all documents were issued', () => {
  const a = app();
  assert.match(a.run('bcDocumentReviewHtml(null)'), /אינם זמינים/);
  a.s.q = queue([]);
  assert.match(a.run('bcDocumentReviewHtml(BillingDocumentReview.review(q))'), /אין בכך אישור שהמסמכים הונפקו/);
  assert.match(a.run('bcDocumentReviewHtml(BillingDocumentReview.review(q, {stale:true}))'), /הרענון האחרון נכשל/);
  a.s.q = queue([receipt({ invoiceWanted: '', invoiceTo: 'DO NOT SHOW' })]);
  const html = a.run('bcDocumentReviewHtml(BillingDocumentReview.review(q, {kind:"unknown"}))');
  assert.match(html, /דורש בירור/);
  assert.ok(!html.includes('DO NOT SHOW'));
});
