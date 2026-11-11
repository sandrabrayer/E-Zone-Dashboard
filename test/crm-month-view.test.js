'use strict';

/* «היסטוריה חודשית» in the CRM (CHANGELOG-crm-month-view.md): a month's occupancy
 * from the patients' entry / exit dates, and — finance only — its revenue from the
 * classic engine (public/revenue-engine.js). Names are SYNTHETIC. */

process.env.TZ = 'Asia/Jerusalem';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../public/crm/crm.js');
const engine = require('../public/revenue-engine.js');
const scope = require('../lib/finance-scope.js');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'public', 'crm', 'crm.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'public', 'crm', 'crm.html'), 'utf8');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const SW = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');
const TODAY = '2026-11-11';
const P = (o) => Object.assign({ id: 'x', houseId: 'ramot', name: 'דנה', date: '2026-09-20', exitDate: '', status: 'active' }, o);
const occ = (list, month) => core.monthOccupancy(list, month, TODAY);
const house = (o, id) => o.houses.filter((h) => h.id === id)[0];

test('patient-days: every day of [entry, exit] inside the month, both ends inclusive; no exit → to the month end', () => {
  const o = occ([P(), P({ id: 'b', name: 'גל', date: '2026-10-11', exitDate: '2026-10-20', status: 'released' })], '2026-10');
  assert.equal(o.ok, true);
  assert.deepEqual([o.from, o.to, o.days, o.partial], ['2026-10-01', '2026-10-31', 31, false]);
  const r = house(o, 'ramot');
  assert.equal(r.patientDays, 31 + 10);
  assert.equal(r.avg, 1.3);                      // 41 / 31
  assert.equal(r.pct, 6.6);                      // 1.32 / 20 beds
  assert.deepEqual([r.peak, r.entries, r.exits], [2, 1, 1]);
  assert.deepEqual([o.patientDays, o.capacity, o.pct], [41, 20, 6.6]);
});

test('the running month is counted up to today and flagged partial; a future month is refused', () => {
  const o = occ([P()], '2026-11');
  assert.deepEqual([o.days, o.to, o.partial, o.patientDays], [11, TODAY, true, 11]);
  assert.equal(house(o, 'ramot').avg, 1);
  assert.equal(occ([P()], '2026-12').ok, false);
  for (const bad of ['', '2026-13', '11/2026', null]) assert.equal(occ([P()], bad).ok, false, String(bad));
  assert.equal(core.monthOccupancy([P()], '2026-10', 'x').ok, false);
});

test('the same person is counted once a day per house (two rows of one stay); a Sheets timestamp is read as its day', () => {
  const o = occ([P({ date: '2026-10-01', exitDate: '2026-10-10', status: 'released' }), P({ id: 'y', date: '2026-10-08', exitDate: '2026-10-12', status: 'released' }),
    P({ id: 'z', name: 'נוי', date: '2026-10-30T22:00:00.000Z', exitDate: '' })], '2026-10');
  assert.equal(house(o, 'ramot').patientDays, 12 + 2, 'days 1–12 once, + the 30th and 31st');
});

test('capacity: a house joins from the month of its first patient; a closed house shows its patients with no %, and stays out of the network %', () => {
  const list = [P(), P({ id: 'p', houseId: 'pardes', name: 'אבי', date: '2026-11-03' }), P({ id: 's', houseId: 'sde', name: 'רון', date: '2026-08-01', exitDate: '2026-10-05', status: 'released' })];
  const oct = occ(list, '2026-10');
  assert.equal(house(oct, 'pardes'), undefined, 'not open yet — not empty beds');
  assert.deepEqual([house(oct, 'sde').patientDays, house(oct, 'sde').capacity, house(oct, 'sde').pct], [5, 0, null]);
  assert.equal(oct.capacity, 20, 'ramot only');
  assert.equal(oct.patientDays, 36); assert.equal(oct.pct, 5, '31 ramot days / 31 / 20 — the closed house is not in the %');
  const nov = occ(list, '2026-11');
  assert.equal(nov.capacity, 33, 'ramot 20 + pardes 13');
  assert.equal(house(nov, 'sde'), undefined, 'closed and empty → not listed');
  // a legacy house id resolves; an unknown house is counted apart
  const odd = occ([P({ houseId: 'raanana', date: '2026-10-01' }), P({ id: 'u', houseId: 'nowhere', date: '2026-10-30' })], '2026-10');
  assert.equal(house(odd, 'asher').patientDays, 31); assert.equal(odd.unknownDays, 2);
});

test('history: the last n months, oldest first, never a future one; month helpers', () => {
  const t = core.occupancyTrend([P()], '2026-11', TODAY, 4);
  assert.deepEqual(t.map((o) => o.month), ['2026-08', '2026-09', '2026-10', '2026-11']);
  assert.deepEqual(t.map((o) => o.pct), [null, 1.8, 5, 5]);
  assert.equal(core.occupancyTrend([P()], '2026-11', TODAY, 12).length, 12);
  assert.equal(core.monthShift('2026-01', -1), '2025-12'); assert.equal(core.monthShift('2026-12', 1), '2027-01'); assert.equal(core.monthShift('x', 1), '');
  assert.equal(core.monthLabelHe('2026-10'), 'אוקטובר 2026');
});

test('revenue: the classic engine\'s figures, ex-VAT, per house by name; nothing is computed in crm.js', () => {
  const data = { patients: { ramot: [{ id: 'u1', name: 'דנה כהן', date: '2026-08-20', pay: 30000, status: 'active' }] }, billingOverrides: [] };
  const pay = { ok: true, payments: [{ id: 'pay-1', patientId: 'ramot::דנה כהן::2026-08-20', patientName: 'דנה כהן', houseId: 'ramot', dueDate: '2026-09-20', amount: 30000, amountPaid: 30000, status: 'paid' }], receipts: [] };
  const cr = { ok: true, credits: [] };
  const r = core.monthRevenue(engine, data, pay, cr, '2026-10', TODAY);
  const m = engine.monthModel({ month: '2026-10', data, payments: pay, credits: cr, today: TODAY });
  assert.deepEqual([r.received, r.expected, r.credits, r.net], [m.received.exVat, m.expected.exVat, m.credits.exVat, m.net.exVat]);
  assert.equal(r.received, 16101.69, '19/30 of ₪30,000, ÷1.18');
  assert.equal(r.byHouse['רמות השבים'].received, 16101.69);
  assert.equal(r.recordsFrom, '2026-07-01');
  const block = SRC.slice(SRC.indexOf('function monthRevenue('), SRC.indexOf('/* «מטופלים פעילים» on «היום שלי»'));
  assert.ok(!/1\.18|VAT|\* 100|\/ 100/.test(block), 'no money arithmetic in the CRM wrapper');
});

test('revenue fail-soft: no engine / a failed read / a bad month → null (the screen says so), never a zero', () => {
  const ok = { ok: true, payments: [], receipts: [] }, cr = { ok: true, credits: [] };
  assert.equal(core.monthRevenue(null, {}, ok, cr, '2026-10', TODAY), null);
  assert.equal(core.monthRevenue(engine, {}, { ok: false }, cr, '2026-10', TODAY), null);
  assert.equal(core.monthRevenue(engine, {}, ok, { ok: false }, '2026-10', TODAY), null);
  assert.equal(core.monthRevenue(engine, {}, ok, cr, 'x', TODAY), null);
  assert.match(SRC, /הכנסות החודש לא נטענו <button type="button" class="btn small" data-billing-retry>/);
});

test('who sees what: the area for finance and ops/restricted, not the controller; revenue only for a finance session; its reads are finance-gated on the server', () => {
  assert.ok(core.areasFor({ view: 'full', finance: true }).includes('monthly'));
  assert.ok(core.areasFor({ view: 'ops', ops: true, finance: false }).includes('monthly'));
  assert.ok(!core.areasFor({ view: 'controller' }).includes('monthly'));
  assert.equal(core.AREAS.filter((a) => a.id === 'monthly')[0].label, 'היסטוריה חודשית');
  assert.ok(core.NAV_GROUPS.some((g) => g.label === 'דוחות והגדרות' && g.items.includes('monthly')));
  const block = SRC.slice(SRC.indexOf('function renderMonthly(c)'), SRC.indexOf('function kpiCard('));
  assert.ok(block.includes("const fin = !!(state.me && state.me.finance) && areasFor(state.me).indexOf('billing') >= 0;"));
  assert.ok(block.includes('if (fin) {\n        if (!state.billing) { loadBilling(renderMain);'), 'money is read only for a finance session');
  for (const a of ['getPayments', 'getCredits']) assert.ok(scope.FINANCE_ACTIONS.includes(a), a + ' is refused to Dana by the server');
  assert.ok(!/api\(/.test(block), 'no request of its own');
  for (const cell of ['esc(h.name)', 'esc(n)', 'esc(t.label)', 'esc(o.label)', 'esc(month)', 'esc(t.month)']) assert.ok(block.includes(cell), cell);
});

test('wiring: the CRM page loads the engine + the «מאומת» rule before crm.js; the server hashes and serves it; the worker treats it as a bundle file', () => {
  const a = HTML.indexOf('<script src="billing-control-rules.js?v=__BUILD__"></script>'), b = HTML.indexOf('<script src="revenue-engine.js?v=__BUILD__"></script>'), c = HTML.indexOf('<script src="crm/crm.js?v=__BUILD__"></script>');
  assert.ok(a > 0 && a < b && b < c);
  assert.ok(SERVER.includes("'/revenue-engine.js': { file: path.join(__dirname, 'public', 'revenue-engine.js'), mime: 'application/javascript' },"));
  assert.ok(SERVER.includes("app.get('/revenue-engine.js', sendStatic('revenue-engine.js', 'application/javascript'));"));
  assert.match(SW, /var BUNDLE_PATHS = \[[^\]]*'\/revenue-engine\.js'[^\]]*\]/);
});
