/* Tests for the overdue-payment alerts (billing PR 3 — frontend only).
 *
 *   app.js — lastBillingDayOnOrBefore (entry-day anchor, short-month clamp,
 *            mirror of nextBillingDayOnOrAfter); overduePatients (overdue =
 *            current cycle's due date arrived AND no paid/partial payment for
 *            it; clears on payment; released excluded; no-cycle-yet guard);
 *            renderOverdueAlert (count strip, hidden at zero);
 *            buildBillingRow marks unpaid past-due rows with .overdue.
 *
 * Same vm-sandbox approach as billing-override-ui.test.js. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fakeClassList() {
  const set = new Set();
  return {
    add: c => set.add(c), remove: c => set.delete(c),
    toggle: (c, on) => { (on === undefined ? !set.has(c) : on) ? set.add(c) : set.delete(c); },
    contains: c => set.has(c),
  };
}
function fakeEl() {
  const el = {
    className: '', _html: '', dataset: {}, textContent: '', value: '', disabled: false,
    set innerHTML(v) { this._html = v; },
    get innerHTML() { return this._html; },
    classList: fakeClassList(), children: [],
    appendChild(c) { this.children.push(c); },
    remove() {}, addEventListener() {},
    _sub: {},
    querySelector(sel) { if (!this._sub[sel]) this._sub[sel] = fakeEl(); return this._sub[sel]; },
    querySelectorAll() { return []; },
  };
  return el;
}

function loadApp() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const epilogue = `
    globalThis.__test = {
      setState(s) { Object.assign(state, s); },
      lastBillingDayOnOrBefore,
      overduePatients,
      renderOverdueAlert,
      buildBillingRow,
      isoDate,
    };
  `;
  const noop = () => {};
  const byId = {};
  const doc = {
    addEventListener: noop,
    getElementById: (id) => { if (!byId[id]) byId[id] = fakeEl(); return byId[id]; },
    createElement: () => fakeEl(),
    querySelectorAll: () => [],
    querySelector: () => null,
  };
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/' },
    document: doc,
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    setTimeout: noop,
    URLSearchParams,
    Math, Date, JSON, Number, String, Array, Object, RegExp, Promise,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + epilogue, sandbox);
  return { app: sandbox.__test, byId };
}

const { app, byId } = loadApp();
const iso = (d) => app.isoDate(d);

function patient(over) {
  return Object.assign(
    { houseId: 'ramot', name: 'בעז', date: '2026-01-15', pay: 9000, adv: 0,
      status: 'active', fromLead: '', exitDate: '' },
    over || {}
  );
}
function paidFor(p, dueISO, status) {
  const pid = `${p.houseId}::${p.name}::${p.date}`;
  return { id: `pay::${pid}::${dueISO}`, patientId: pid, patientName: p.name,
           houseId: p.houseId, dueDate: dueISO, amount: p.pay,
           status: status || 'paid', amountPaid: status === 'partial' ? 1000 : p.pay,
           balance: status === 'partial' ? p.pay - 1000 : 0 };
}

/* ===== lastBillingDayOnOrBefore — anchor + short-month clamping ===== */

test('returns this month\'s occurrence when it has passed, else the previous month\'s', () => {
  assert.strictEqual(iso(app.lastBillingDayOnOrBefore('2026-01-15', '2026-08-20')), '2026-08-15');
  assert.strictEqual(iso(app.lastBillingDayOnOrBefore('2026-01-15', '2026-08-15')), '2026-08-15', 'on the day itself');
  assert.strictEqual(iso(app.lastBillingDayOnOrBefore('2026-01-15', '2026-08-14')), '2026-07-15', 'day before → previous cycle');
});

test('short-month clamping: entry day 31/30/29 clamp to the month\'s last day', () => {
  // 2026 is not a leap year — February has 28 days.
  assert.strictEqual(iso(app.lastBillingDayOnOrBefore('2026-01-31', '2026-03-05')), '2026-02-28', 'day 31 → Feb 28');
  assert.strictEqual(iso(app.lastBillingDayOnOrBefore('2026-01-30', '2026-03-01')), '2026-02-28', 'day 30 → Feb 28');
  assert.strictEqual(iso(app.lastBillingDayOnOrBefore('2026-01-29', '2026-03-01')), '2026-02-28', 'day 29 → Feb 28');
  // A 30-day month clamps day 31 to the 30th.
  assert.strictEqual(iso(app.lastBillingDayOnOrBefore('2026-01-31', '2026-05-01')), '2026-04-30');
});

test('year rollover: January "from" reaches back into December', () => {
  assert.strictEqual(iso(app.lastBillingDayOnOrBefore('2026-01-15', '2027-01-10')), '2026-12-15');
});

/* ===== overduePatients ===== */

test('before the renewal day (previous cycle paid) → NOT overdue; on the day → overdue', () => {
  const p = patient(); // entry day 15
  app.setState({ mode: 'edit', billingOverrides: [],
                 patients: [p], payments: [paidFor(p, '2026-07-15')] });
  assert.strictEqual(app.overduePatients('2026-08-14').length, 0, 'Aug 14: July cycle paid, Aug not due yet');
  const onDay = app.overduePatients('2026-08-15');
  assert.strictEqual(onDay.length, 1, 'Aug 15: the new cycle is due and unpaid');
  assert.strictEqual(onDay[0].dueISO, '2026-08-15');
});

test('a recorded payment for the cycle clears the alert (paid AND partial)', () => {
  const p = patient();
  app.setState({ patients: [p], payments: [paidFor(p, '2026-08-15')], billingOverrides: [] });
  assert.strictEqual(app.overduePatients('2026-08-20').length, 0, 'paid clears');
  app.setState({ payments: [paidFor(p, '2026-08-15', 'partial')] });
  assert.strictEqual(app.overduePatients('2026-08-20').length, 0, 'partial clears');
  app.setState({ payments: [] });
  assert.strictEqual(app.overduePatients('2026-08-20').length, 1, 'no payment → overdue');
});

test('short-month cycle: entry day 31 is overdue on Feb 28 when unpaid', () => {
  const p = patient({ date: '2026-01-31' });
  app.setState({ patients: [p], payments: [], billingOverrides: [] });
  const out = app.overduePatients('2026-02-28');
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].dueISO, '2026-02-28', 'clamped due date');
  // Feb 27 with the January cycle paid → nothing due yet.
  app.setState({ payments: [paidFor(p, '2026-01-31')] });
  assert.strictEqual(app.overduePatients('2026-02-27').length, 0);
});

test('released patients are excluded; a not-yet-started first cycle is not overdue', () => {
  const released = patient({ name: 'שוחרר', status: 'released' });
  const future   = patient({ name: 'חדש', date: '2026-09-01' });
  app.setState({ patients: [released, future], payments: [], billingOverrides: [] });
  assert.strictEqual(app.overduePatients('2026-08-20').length, 0);
});

test('oldest due first', () => {
  const a = patient({ name: 'א', date: '2026-01-05' });
  const b = patient({ name: 'ב', date: '2026-01-25' });
  app.setState({ patients: [b, a], payments: [], billingOverrides: [] });
  const out = app.overduePatients('2026-08-26');
  assert.deepStrictEqual(Array.from(out.map(o => o.patient.name)), ['א', 'ב']);
});

/* ===== the dashboard strip ===== */

test('renderOverdueAlert shows the Hebrew count text and hides at zero', () => {
  const p = patient({ date: '2026-01-15' });
  const q = patient({ name: 'שני', date: '2026-01-10' });
  app.setState({ patients: [p, q], payments: [], billingOverrides: [] });
  app.renderOverdueAlert();
  assert.strictEqual(byId['overdue-alert'].classList.contains('hidden'), false);
  assert.strictEqual(byId['overdue-alert-count'].textContent, 2);
  assert.strictEqual(byId['overdue-alert-text'].textContent, '2 מטופלים ממתינים לתשלום');

  app.setState({ patients: [] });
  app.renderOverdueAlert();
  assert.strictEqual(byId['overdue-alert'].classList.contains('hidden'), true, 'hidden at zero');
});

/* ===== billing-row highlight ===== */

test('an unpaid past-due row gets .overdue; paid and carry rows do not', () => {
  const p = patient();
  app.setState({ mode: 'edit', patients: [p], payments: [], billingOverrides: [] });
  const duePast = { id: 'x', patientId: 'pid', patientName: 'בעז', houseId: 'ramot',
                    dueDate: '2020-01-01', amount: 9000, status: 'unpaid', amountPaid: 0, balance: 9000 };
  const overdueRow = app.buildBillingRow(p, duePast, '2020-01-01', false);
  assert.ok(overdueRow.className.includes('overdue'), 'unpaid past-due → highlighted');

  const futureRow = app.buildBillingRow(p, { ...duePast, dueDate: '2099-01-01' }, '2099-01-01', false);
  assert.ok(!futureRow.className.includes('overdue'), 'future due date → no highlight');

  const paidRow = app.buildBillingRow(p, { ...duePast, status: 'paid', amountPaid: 9000, balance: 0 }, '2020-01-01', false);
  assert.ok(!paidRow.className.includes('overdue'), 'paid → no highlight');

  const carryRow = app.buildBillingRow(p, duePast, '2020-01-01', true);
  assert.ok(carryRow.className.includes('carry') && !carryRow.className.includes('overdue'),
    'carry rows keep their existing treatment');
});
