'use strict';

/* The calculator on every money table + «חובות של תקופה»
 * (CHANGELOG-table-calculator.md). Names are SYNTHETIC. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../public/crm/crm.js');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'crm', 'crm.js'), 'utf8');
const TODAY = '2026-11-12';

test('moneyFromText: the displayed amount, sign included; no digit → null (no tick box)', () => {
  assert.equal(core.moneyFromText('₪40,000'), 40000);
  assert.equal(core.moneyFromText('₪9,333.5'), 9333.5);
  assert.equal(core.moneyFromText('₪0'), 0);
  assert.equal(core.moneyFromText('−₪1,734'), -1734);
  assert.equal(core.moneyFromText('-₪5'), -5);
  assert.equal(core.moneyFromText('⁦−₪12⁩'), -12, 'inside the left-to-right isolate the page uses');
  assert.equal(core.moneyFromText('  ₪ 1,000 '), 1000);
  for (const none of ['—', '', null, undefined, 'אין']) assert.equal(core.moneyFromText(none), null, String(none));
});

test('calcSummary: per table the count and the sum of the ticked rows; a table with no tick is not a line; the grand total', () => {
  const sum = core.calcSummary([{ label: 'תקבולים', amounts: [40000, 37000, 0.5], of: 25 }, { label: 'חייבים לגבייה', amounts: [], of: 66 }, { label: 'זיכויים לתשלום', amounts: [-1734], of: 12 }]);
  assert.deepEqual(sum.groups, [{ label: 'תקבולים', count: 3, of: 25, total: 77000.5 }, { label: 'זיכויים לתשלום', count: 1, of: 12, total: -1734 }]);
  assert.deepEqual([sum.count, sum.total], [4, 75266.5]);
  assert.deepEqual(core.calcSummary([]), { groups: [], count: 0, total: 0 });
  assert.deepEqual(core.calcSummary(null), { groups: [], count: 0, total: 0 });
  assert.equal(core.calcSummary([{ label: 'x', amounts: [1, NaN, 'a', Infinity, 2] }]).total, 3, 'junk is never summed');
});

test('the bar text: one table → «נבחרו N מתוך M · <table> · סה"כ»; several → a line per table + the total; nothing ticked → empty', () => {
  assert.equal(core.calcBarText(core.calcSummary([{ label: 'תקבולים', amounts: [40000, 37000], of: 25 }])), 'נבחרו 2 מתוך 25 · תקבולים · סה"כ ₪77,000');
  assert.equal(core.calcBarText(core.calcSummary([{ label: 'תקבולים', amounts: [40000], of: 25 }, { label: 'זיכויים לתשלום', amounts: [-1734], of: 2 }])),
    'תקבולים: 1 מתוך 25 · ₪40,000  |  זיכויים לתשלום: 1 מתוך 2 · −₪1,734  |  סה"כ ₪38,266');
  assert.equal(core.calcBarText(core.calcSummary([])), '');
});

test('every money table of «גבייה» and the patient\'s «חשבון» is in the calculator, each with the header of its amount column', () => {
  const ids = Object.keys(core.CALC_TABLES);
  for (const id of ['crm-due', 'crm-fc-rows', 'crm-debtors', 'crm-debt-groups', 'crm-receipts', 'crm-rc-groups', 'crm-pending-credits', 'crm-detached',
    'crm-account-open', 'crm-account-credits', 'crm-account-cycles', 'crm-account-receipts']) assert.ok(ids.includes(id), id);
  // the table exists in the page source and has a header with exactly that text
  for (const id of ids) {
    if (id === 'crm-debt-groups' || id === 'crm-rc-groups') continue;   // built by groupTable(id, …) — checked below
    const at = SRC.indexOf('id="' + id + '"><thead><tr>');
    assert.ok(at > 0, id + ' is rendered');
    const head = SRC.slice(at, SRC.indexOf('</tr></thead>', at));
    assert.ok(head.includes('<th>' + core.CALC_TABLES[id].col + '</th>'), id + ' has the «' + core.CALC_TABLES[id].col + '» column');
    assert.ok(core.CALC_TABLES[id].label, id + ' has a name for the bar');
  }
  const grp = SRC.slice(SRC.indexOf('function groupTable('), SRC.indexOf('function renderDueOnDate('));
  assert.ok(grp.includes('<th>שורות</th><th>סכום</th><th>חלק</th>') && SRC.includes("groupTable('crm-debt-groups'") && SRC.includes("groupTable('crm-rc-groups'"));
  assert.ok(!ids.includes('crm-cleanup-rows'), 'the cleanup tool keeps its own ticks (they select what to close)');
  // no table that no longer exists (CHANGELOG-billing-sections.md removed the duplicate lists)
  for (const id of ids) assert.ok(SRC.includes(id === 'crm-debt-groups' || id === 'crm-rc-groups' ? "'" + id + "'" : 'id="' + id + '"'), id);
});

test('wiring: display only — ticking re-renders nothing and asks nothing; a tick never opens the row; ticks are restored after a re-render', () => {
  const block = SRC.slice(SRC.indexOf('state.calcSel = {};'), SRC.indexOf("root.addEventListener('toggle'"));
  assert.ok(!/api\(|renderMain\(/.test(block), 'no request, no re-render');
  assert.ok(block.includes("root.addEventListener('click', function (ev) { if (ev.target.closest && ev.target.closest('[data-calc-cell]')) ev.stopPropagation(); }, true);"), 'capture: before every row handler');
  assert.ok(block.includes("if (sel[key] === true) { box.checked = true; tr.classList.add('picked'); }"), 'restored');
  assert.ok(block.includes("tr.children.length === width && !tr.classList.contains('sum')"), 'a total row is never a pick');
  assert.ok(block.includes('new win.MutationObserver(function () { decorateCalc(); }).observe(root, { childList: true, subtree: true })'), 'the drawer and every later render get it too');
  assert.ok(block.includes("if (el && el.textContent !== txt) el.textContent = txt;"), 'no write when nothing changed (no observer loop)');
  assert.ok(!/innerHTML = [^']*\+/.test(block.replace(/bar\.innerHTML = '[^;]*;/, '')), 'row content is built with DOM nodes, never concatenated HTML');
});

/* ---- «חובות של תקופה» ---- */
const CYC = (start, balance, days, o) => Object.assign({ start: start, end: start, expected: balance, received: 0, balance: balance, days: days, kind: 'recorded', month: start.slice(0, 7) }, o || {});
const DEBT = { ok: true, asOf: TODAY, totals: {}, byHouse: [], byPatient: [
  { patientId: 'p1', patientKey: 'k1', name: 'דנה כהן', houseId: 'ramot', status: 'active', inHouseAtAsOf: true, cycles: [CYC('2026-08-20', 30000, 84), CYC('2026-10-20', 12000, 23, { kind: 'unrecorded' })] },
  { patientId: 'p2', patientKey: 'k2', name: 'אבי רז', houseId: 'asher', status: 'released', inHouseAtAsOf: false, cycles: [CYC('2026-10-01T21:00:00.000Z', 20000, 41)] },
  { patientId: 'p3', patientKey: 'k3', name: 'גל שי', houseId: 'rehab', status: 'active', inHouseAtAsOf: true, cycles: [CYC('2026-11-03', 9000, 9)] }] };
const PAY = { ok: true, payments: [], funders: [], receipts: [] };
const list = (range) => core.collectionDebtors(DEBT, PAY, TODAY, '', range);

test('no period → every open cycle, exactly as before', () => {
  const all = list(undefined);
  assert.deepEqual([all.count, all.total, all.range.on], [3, 71000, false]);
  assert.deepEqual(list({}).total, 71000); assert.deepEqual(list({ from: '', to: '' }).total, 71000);
});

test('a period keeps only the cycles whose billing day is inside it (both ends included); each patient is re-summed from those cycles', () => {
  const oct = list({ from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(oct.rows.map((r) => [r.name, r.balance, r.cycles, r.oldestDays, r.unrecorded]), [['אבי רז', 20000, 1, 41, 0], ['דנה כהן', 12000, 1, 23, 1]]);
  assert.deepEqual([oct.count, oct.total], [2, 32000]);
  assert.deepEqual(oct.range, { from: '2026-10-01', to: '2026-10-31', on: true });
  // a Sheets timestamp is read as its Israel day (01/10 21:00Z = 02/10)
  assert.equal(list({ from: '2026-10-02', to: '2026-10-02' }).rows[0].name, 'אבי רז');
  assert.equal(list({ from: '2026-10-01', to: '2026-10-01' }).count, 0);
  // the ends are inclusive
  assert.equal(list({ from: '2026-10-20', to: '2026-10-20' }).total, 12000);
});

test('an open end: only «from» → from that day on; only «to» → up to that day; a reversed pair is swapped; junk → no period', () => {
  assert.deepEqual([list({ from: '2026-11-01' }).count, list({ from: '2026-11-01' }).total], [1, 9000]);
  assert.deepEqual([list({ to: '2026-08-31' }).count, list({ to: '2026-08-31' }).total], [1, 30000]);
  assert.equal(list({ from: '2026-10-31', to: '2026-10-01' }).total, 32000);
  assert.equal(list({ from: 'x', to: '31/10/2026' }).total, 71000);
  assert.deepEqual(core.debtRange({ from: '2026-10-31', to: '2026-10-01' }), { from: '2026-10-01', to: '2026-10-31', on: true });
});

test('the periods partition the debt: Aug + Sep + Oct + Nov = everything (nothing counted twice, nothing lost); the debt read itself is not mutated', () => {
  const before = JSON.stringify(DEBT);
  const parts = [['2026-08-01', '2026-08-31'], ['2026-09-01', '2026-09-30'], ['2026-10-01', '2026-10-31'], ['2026-11-01', '2026-11-30']].map((r) => list({ from: r[0], to: r[1] }).total);
  assert.deepEqual(parts, [30000, 0, 32000, 9000]);
  assert.equal(parts.reduce((a, b) => a + b, 0), list().total);
  assert.equal(JSON.stringify(DEBT), before);
});

test('period wiring: two date inputs + «החודש» / «החודש הקודם» / «כל התקופות»; the screen says the list is narrowed; no request', () => {
  const block = SRC.slice(SRC.indexOf('function renderDebts('), SRC.indexOf('function renderReceipts()'));
  for (const x of ['id="crm-debt-from"', 'id="crm-debt-to"', 'data-debt-preset="month"', 'data-debt-preset="prev"', 'data-debt-preset="all"', 'מוצגים רק מחזורים שיום החיוב שלהם בתקופה שנבחרה', "esc(rg.from)", "esc(rg.to)"]) assert.ok(block.includes(x), x);
  assert.ok(!/api\(/.test(block));
  assert.ok(SRC.includes("if (t.id === 'crm-debt-from') { state.debtFrom = isoDateOk(t.value) ? t.value : ''; return renderMain(); }"));
});
