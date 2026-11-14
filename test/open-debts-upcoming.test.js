'use strict';

/* «חובות פתוחים» → «צפוי לגבייה עד …» (CHANGELOG-open-debts-upcoming.md).
 * Sandra (14/11/2026): in «גבייה» she wants the unpaid debts AND how much is left
 * to collect by the end of the month; the period was capped at today.
 *   - past debt (due ≤ today) stays exactly as before;
 *   - the period may end after today → the cycles due AFTER today up to that day
 *     are added as a separate part (the «צפי תזרים» rows; no second calculation);
 *   - private on the billing day, institutional «שוטף +30»;
 *   - released patients and pro-bono never; «לא הוגדר» counts.
 * Names are SYNTHETIC. */

process.env.TZ = 'Asia/Jerusalem';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../public/crm/crm.js');
const CB = require('../lib/cycle-balance.js');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'crm', 'crm.js'), 'utf8');
const TODAY = '2026-11-14';
const EOM = '2026-11-30';

const data = (byHouse) => ({ ok: true, leads: [], patients: byHouse, billingOverrides: [] });
const P = (o) => Object.assign({ id: 'id-p1', name: 'דן לוי', date: '2026-07-15', pay: 32000, status: 'active', exitDate: '' }, o || {});
const PAY = (o) => Object.assign({ ok: true, payments: [], receipts: [], funders: [] }, o || {});
const FUND = (id, funder, from) => ({ patientId: id, funder: funder, effectiveFrom: from || '2026-01-01' });
const up = (d, p, range, slice, opts) => core.upcomingDebts(d, p, range, TODAY, CB, core.billSlice(slice || {}), opts);

test('off unless the period ends after today (past-only periods behave exactly as before)', () => {
  const d = data({ ramot: [P()] }), p = PAY({ funders: [FUND('id-p1', 'פרטי')] });
  for (const r of [{}, { to: TODAY }, { from: '2026-10-15', to: TODAY }, { to: '2026-11-01' }, { to: 'junk' }])
    assert.equal(up(d, p, r).on, false, JSON.stringify(r));
  assert.equal(up(d, p, { to: EOM }).on, true);
});

test('Sandra\'s case: a private cycle due 15/11 shows when «עד תאריך» = 30/11 and not when it = 14/11', () => {
  const d = data({ ramot: [P()] }), p = PAY({ funders: [FUND('id-p1', 'פרטי')] });
  const r = up(d, p, { from: '2026-10-15', to: EOM });
  assert.deepEqual(r.rows.map((x) => [x.dueDate, x.expectedDate, x.amount, x.kind]), [['2026-11-15', '2026-11-15', 32000, 'private']]);
  assert.equal(r.total, 32000); assert.equal(r.count, 1);
  assert.equal(r.from, '2026-11-15', 'upcoming starts tomorrow even when the period started earlier');
  assert.equal(up(d, p, { from: '2026-10-15', to: TODAY }).rows.length, 0);
});

test('never overlaps past debt: a cycle due today or earlier is not upcoming (even an institutional one inside its terms)', () => {
  // private, due today
  assert.equal(up(data({ ramot: [P({ date: '2026-07-14' })] }), PAY({ funders: [FUND('id-p1', 'פרטי')] }), { to: EOM }).rows.length, 0);
  // institutional, due 05/11 → «שוטף +30» 05/12: inside terms, but it is past debt (debtAging, «גוף מממן» chip), not upcoming
  const inst = up(data({ ramot: [P({ date: '2026-07-05' })] }), PAY({ funders: [FUND('id-p1', 'ביטוח לאומי')] }), { to: '2026-12-31' });
  assert.ok(inst.rows.every((x) => x.dueDate > TODAY), 'only cycles due after today');
  assert.deepEqual(inst.rows.map((x) => [x.dueDate, x.expectedDate]), [], 'due 05/12 → expected 04/01, after the period');
});

test('institutional «שוטף +30»: due after today, expected 30 days later — inside the period only if that date is', () => {
  const d = data({ ramot: [P({ date: '2026-07-20' })] }), p = PAY({ funders: [FUND('id-p1', 'מכבי')] });
  assert.equal(up(d, p, { to: EOM }).rows.length, 0, 'due 20/11 → 20/12, not by the month end');
  const r = up(d, p, { to: '2026-12-31' });
  assert.deepEqual(r.rows.map((x) => [x.kind, x.dueDate, x.expectedDate]), [['institutional', '2026-11-20', '2026-12-20']]);
});

test('released and pro-bono patients never; «לא הוגדר» counts and is flagged', () => {
  const d = data({ ramot: [P({ id: 'a', status: 'released', exitDate: '2026-11-01' }), P({ id: 'b', name: 'רון', date: '2026-07-16' }), P({ id: 'c', name: 'גל', date: '2026-07-17' })] });
  const p = PAY({ funders: [FUND('a', 'פרטי'), FUND('b', 'פרו-בונו')] });
  const r = up(d, p, { to: EOM });
  assert.deepEqual(r.rows.map((x) => [x.patientId, x.kind]), [['c', 'unset']]);
  assert.equal(r.unset, 1); assert.equal(r.total, 32000, '«לא הוגדר» is in the total (past debt counts it too)');
});

test('a partial payment reduces the expected amount; a paid cycle is gone', () => {
  const d = data({ ramot: [P()] });
  const row = (paid) => ({ id: 'pay-1', patientUid: 'id-p1', patientId: 'ramot::דן לוי::2026-07-15', dueDate: '2026-11-15', amount: 32000, amountPaid: paid, status: paid >= 32000 ? 'paid' : 'partial', coverageStart: '2026-11-15', coverageEnd: '2026-12-14' });
  const part = up(d, PAY({ funders: [FUND('id-p1', 'פרטי')], payments: [row(12000)] }), { to: EOM });
  assert.equal(part.total, 20000);
  assert.equal(up(d, PAY({ funders: [FUND('id-p1', 'פרטי')], payments: [row(32000)] }), { to: EOM }).rows.length, 0);
});

test('the slice (house / funder / search) narrows it like the rest; an aging bucket or «משוחררים» → past debt only', () => {
  const d = data({ ramot: [P()], asher: [P({ id: 'x', name: 'נועה', date: '2026-07-20' })] });
  const p = PAY({ funders: [FUND('id-p1', 'פרטי'), FUND('x', 'פרטי')] });
  assert.equal(up(d, p, { to: EOM }).count, 2);
  assert.deepEqual(up(d, p, { to: EOM }, { house: 'asher' }).rows.map((r) => r.name), ['נועה']);
  assert.deepEqual(up(d, p, { to: EOM }, { q: 'דן' }).rows.map((r) => r.name), ['דן לוי']);
  assert.equal(up(d, p, { to: EOM }, { funder: 'מכבי' }).count, 0);
  for (const o of [{ bucket: 'd61_plus' }, { status: 'out' }]) {
    const r = up(d, p, { to: EOM }, {}, o);
    assert.equal(r.on, true); assert.equal(r.pastOnly, true); assert.equal(r.count, 0);
  }
  assert.equal(up(d, p, { to: EOM }, {}, { status: 'in' }).count, 2, '«בבית» keeps the upcoming rows (all active)');
});

test('a period that starts after tomorrow starts there', () => {
  const d = data({ ramot: [P(), P({ id: 'y', name: 'שי', date: '2026-07-25' })] });
  const p = PAY({ funders: [FUND('id-p1', 'פרטי'), FUND('y', 'פרטי')] });
  const r = up(d, p, { from: '2026-11-20', to: EOM });
  assert.equal(r.from, '2026-11-20');
  assert.deepEqual(r.rows.map((x) => x.dueDate), ['2026-11-25']);
});

test('upcomingGroups: by funder / house; other dims → none', () => {
  const rows = [{ funder: 'פרטי', houseId: 'ramot', houseName: 'רמות', amount: 10 }, { funder: 'פרטי', houseId: 'asher', houseName: 'אשר', amount: 30 }, { funder: 'מכבי', houseId: 'ramot', houseName: 'רמות', amount: 20 }];
  assert.deepEqual(core.upcomingGroups(rows, 'funder').map((g) => [g.key, g.total, g.count]), [['פרטי', 40, 2], ['מכבי', 20, 1]]);
  assert.deepEqual(core.upcomingGroups(rows, 'house').map((g) => [g.label, g.total]), [['רמות', 30], ['אשר', 30]].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'he')));
  assert.deepEqual(core.upcomingGroups(rows, 'bucket'), []);
});

test('debtPreset: «עד סוף החודש» = every past debt + up to the month end; the old presets unchanged', () => {
  assert.deepEqual(core.debtPreset('eom', TODAY), { from: '', to: EOM });
  assert.deepEqual(core.debtPreset('eom', '2026-02-10'), { from: '', to: '2026-02-28' });
  assert.deepEqual(core.debtPreset('month', TODAY), { from: '2026-11-01', to: TODAY });
  assert.deepEqual(core.debtPreset('prev', TODAY), { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(core.debtPreset('prev', '2026-01-05'), { from: '2025-12-01', to: '2025-12-31' });
  assert.deepEqual(core.debtPreset('all', TODAY), { from: '', to: '' });
});

test('the UI: no max=today cap, an «עד סוף החודש» button, the three totals, the «צפוי» chip; read-only (no request)', () => {
  const fn = SRC.slice(SRC.indexOf('function renderDebts(b, patients)'), SRC.indexOf('/* «תקבולים» (CHANGELOG-billing-sections.md)'));
  assert.ok(fn.includes('id="crm-debt-to" value="\' + esc(rg.to) + \'">'), 'no max on «עד תאריך»');
  assert.ok(!/crm-debt-to[^>]*max=/.test(fn));
  assert.ok(fn.includes('data-debt-preset="eom">עד סוף החודש<'));
  for (const x of ['id="crm-debt-split"', 'חוב עבר · עד היום', 'צפוי לגבייה עד ', 'סה"כ לגבייה עד ', 'id="crm-debt-upcoming"', "chip('wait', 'צפוי · ' + fmtDate(r.expectedDate))", 'upcomingDebts(state.data, state.billing.payments, rg, state.today'])
    assert.ok(fn.includes(x), x);
  assert.ok(!/api\(/.test(fn), 'no request of its own');
  assert.equal(SRC.split('id="crm-debt-upcoming"').length - 1, 1, 'one table');
  assert.deepEqual(core.CALC_TABLES['crm-debt-upcoming'], { col: 'סכום', label: 'צפוי לגבייה' });
  // every value written into the table goes through esc / fmt (no raw patient strings)
  assert.ok(fn.includes("data-open-tab=\"account\"><td>' + esc(r.name) + '</td><td>' + esc(r.houseName) + '</td><td>' + esc(r.funder) + (r.kind === 'unset'"));
});
