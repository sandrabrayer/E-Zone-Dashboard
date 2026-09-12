/* Credits / refunds ledger (apps-script/Code.gs, public/app.js).
 *
 * Locked contracts:
 *   - CREDIT_COLUMNS order is PINNED (append-only, position is the contract);
 *     both identity keys (patientId = persisted Patients id, patientKey = the
 *     legacy triple that keys Payments) are stored on every row and round-trip
 *     intact — never derived from each other;
 *   - the sheet is auto-created via getOrCreateSheet_ with allocationMonth,
 *     paymentDate, createdAt, updatedAt text-forced ('@');
 *   - the server mints the deterministic id credit::<patientId>::<month>::<seq>,
 *     validates creditType/status/month/amounts, REQUIRES overrideReason when
 *     amount ≠ calculatedAmount, stamps createdAt/By + updatedAt/By from the signed-cookie
 *     user (requestUser_), keeps calculatedAmount + creation stamps immutable
 *     on edit, and refuses a stale edit (differing updatedAt) with `conflicts`;
 *   - suggestCredits: the 14-day boundary (13 / 14 / 15), the calendar-day
 *     divisor (28 / 30 / 31), prepaid_return firing regardless of tenure, cap
 *     at amountPaid with the uncapped figure kept in basis, amountPaid 0 and
 *     "no payment row" still yield a (zero) suggestion, and a raw ISO exitDate
 *     at a month boundary / across DST never drifts a day;
 *   - validateCreditLine refuses amount ≠ calculatedAmount without a reason;
 *   - dischargePatient offers credits only AFTER both discharge writes succeed
 *     and a failed credit write never rolls the discharge back; backend
 *     refusals surface (conflict → Hebrew banner naming who saved first).
 *
 * TZ pinned to Asia/Jerusalem so the local-part assertions are deterministic.
 * vm-sandbox on the REAL shipped Code.gs / app.js, per repo convention. */

process.env.TZ = 'Asia/Jerusalem';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const arr = (x) => Array.from(x);
const plain = (x) => JSON.parse(JSON.stringify(x));

/* ================= Code.gs harness ================= */

let opSeq = 0;
function fakeSheet(headerRow, dataRows) {
  const grid = [headerRow.slice()].concat((dataRows || []).map((r) => r.slice()));
  const ops = [];
  let hidden = false;
  return {
    grid, ops,
    getLastRow() { return grid.length; },
    getLastColumn() { return grid[0] ? grid[0].length : 0; },
    getMaxRows() { return Math.max(grid.length, 1000); },
    setFrozenRows() {},
    hideSheet() { hidden = true; },
    isSheetHidden() { return hidden; },
    appendRow(row) { grid.push(row.slice()); },
    getRange(r, c, nr, nc) {
      nr = nr || 1; nc = nc || 1;
      return {
        setNumberFormat(fmt) { ops.push({ op: 'fmt', seq: ++opSeq, r, c, nr, nc, fmt }); },
        getValue() { const g = grid[r - 1]; return g ? (g[c - 1] === undefined ? '' : g[c - 1]) : ''; },
        setValue(v) { if (!grid[r - 1]) grid[r - 1] = []; grid[r - 1][c - 1] = v; },
        getValues() {
          const out = [];
          for (let i = 0; i < nr; i++) {
            const row = [];
            for (let j = 0; j < nc; j++) { const g = grid[r - 1 + i]; row.push(g ? (g[c - 1 + j] === undefined ? '' : g[c - 1 + j]) : ''); }
            out.push(row);
          }
          return out;
        },
        setValues(vals) {
          ops.push({ op: 'set', seq: ++opSeq, r, c, nr, nc });
          for (let i = 0; i < vals.length; i++) {
            if (!grid[r - 1 + i]) grid[r - 1 + i] = [];
            for (let j = 0; j < vals[i].length; j++) grid[r - 1 + i][c - 1 + j] = vals[i][j];
          }
        },
        clearContent() {},
      };
    },
  };
}

const GS_SRC = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
function loadCode() {
  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    JSON, Math, Date, Number, String, Array, Object, RegExp,
    Logger: { log: noop },
    __sheets: {},
  };
  sandbox.SpreadsheetApp = {
    getActiveSpreadsheet: () => ({
      getSheetByName: (name) => sandbox.__sheets[name] || null,
      insertSheet: (name) => (sandbox.__sheets[name] = fakeSheet([], [])),
      getSpreadsheetTimeZone: () => 'Asia/Jerusalem',
    }),
  };
  sandbox.PropertiesService = { getScriptProperties: () => ({ getProperty: () => null, setProperty() { return this; } }) };
  sandbox.ContentService = {
    createTextOutput: (s) => ({ setMimeType: () => ({ json: JSON.parse(s) }) }),
    MimeType: { JSON: 'json' },
  };
  sandbox.Utilities = { getUuid: () => 'uuid', formatDate: (d) => d.toISOString().slice(0, 10) };
  sandbox.LockService = { getScriptLock: () => ({ tryLock: noop, releaseLock: noop }) };
  sandbox.globalThis = sandbox;
  const epilogue = `globalThis.__test = {
    CREDIT_COLUMNS, CREDITS_SHEET, CREDIT_TYPES, CREDIT_STATUSES, CREDIT_EDITABLE_COLUMNS,
    AUDIT_LOG_COLUMNS, AUDIT_LOG_SHEET, PATIENT_COLUMNS,
    readSheet: (sh, cols) => readSheet_(sh, cols),
    handle: (params) => handle_(params).json,
    ensure: (name, cols) => getOrCreateSheet_(name, cols),
    upsert: (c, u) => upsertCredit_(c, u),
    creditId: (p, m, s) => creditId_(p, m, s),
  };`;
  vm.createContext(sandbox);
  vm.runInContext(GS_SRC + epilogue, sandbox);
  return { code: sandbox.__test, sandbox };
}
function creditsOf(code, sandbox) {
  const sh = sandbox.__sheets[code.CREDITS_SHEET];
  return sh ? code.readSheet(sh, arr(code.CREDIT_COLUMNS)) : [];
}
function auditOf(code, sandbox) {
  const sh = sandbox.__sheets[code.AUDIT_LOG_SHEET];
  return sh ? code.readSheet(sh, arr(code.AUDIT_LOG_COLUMNS)) : [];
}

const EXPECTED_COLUMNS = [
  'id', 'patientId', 'patientKey', 'patientName', 'houseId', 'creditType', 'allocationMonth',
  'calculatedAmount', 'amount', 'overrideReason', 'reason', 'approvedBy', 'status',
  'paymentDate', 'method', 'notes', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy',
];
const PID = 'id-sara-7f3';
const PKEY = 'ramot::שרה כהן::2026-07-01';
const BASE = {
  patientId: PID, patientKey: PKEY, patientName: 'שרה כהן', houseId: 'ramot',
  creditType: 'days_unused', allocationMonth: '2026-09',
  calculatedAmount: 4800, amount: 4800, overrideReason: '', reason: 'trail', status: 'pending', notes: '',
};

/* ===== A. schema + sheet ensure ===== */

test('CREDIT_COLUMNS order is PINNED — 20 columns, both identity keys, stamps last', () => {
  const { code } = loadCode();
  assert.deepStrictEqual(arr(code.CREDIT_COLUMNS), EXPECTED_COLUMNS);
  assert.deepStrictEqual(arr(code.CREDIT_TYPES), ['days_unused', 'prepaid_return', 'other']);
  assert.deepStrictEqual(arr(code.CREDIT_STATUSES), ['pending', 'paid', 'cancelled']);
  assert.strictEqual(code.CREDITS_SHEET, 'Credits');
  // Patients / Payments structure untouched by this change.
  assert.deepStrictEqual(arr(code.PATIENT_COLUMNS), [
    'houseId', 'name', 'date', 'pay', 'adv', 'status', 'fromLead', 'exitDate', 'source', 'notes',
    'id', 'updatedAt', 'updatedBy']);
});

test('getOrCreateSheet_ auto-creates Credits with the header and text-forces allocationMonth/paymentDate/createdAt/updatedAt', () => {
  const { code, sandbox } = loadCode();
  const sh = code.ensure(code.CREDITS_SHEET, arr(code.CREDIT_COLUMNS));
  assert.strictEqual(sandbox.__sheets.Credits, sh);
  assert.deepStrictEqual(sh.grid[0], EXPECTED_COLUMNS);
  const forced = sh.ops.filter((o) => o.op === 'fmt' && o.fmt === '@' && o.r === 1 && o.nr >= 1000).map((o) => EXPECTED_COLUMNS[o.c - 1]);
  assert.deepStrictEqual(forced.sort(), ['allocationMonth', 'createdAt', 'paymentDate', 'updatedAt']);
});

/* ===== B. create via handle_ (dispatch + signed-cookie user) ===== */

test('saveCredit via handle_: server mints credit::<patientId>::<month>::<seq>, stamps from body.user, both keys round-trip intact via getCredits', () => {
  const { code, sandbox } = loadCode();
  const r1 = code.handle({ action: 'saveCredit', credit: JSON.stringify(Object.assign({}, BASE, { createdBy: 'FORGED', updatedBy: 'FORGED' })), user: 'ורד' });
  assert.strictEqual(r1.ok, true);
  assert.strictEqual(r1.created, true);
  assert.strictEqual(r1.credit.id, code.creditId(PID, '2026-09', 1));
  assert.strictEqual(r1.credit.id, 'credit::id-sara-7f3::2026-09::1');
  assert.strictEqual(r1.credit.createdBy, 'ורד', 'createdBy comes from the proxy-injected user, never the payload');
  assert.strictEqual(r1.credit.updatedBy, 'ורד');
  assert.ok(Number.isFinite(Date.parse(r1.credit.createdAt)));
  assert.strictEqual(r1.credit.createdAt, r1.credit.updatedAt);

  const r2 = code.handle({ action: 'saveCredit', credit: Object.assign({}, BASE, { creditType: 'prepaid_return', allocationMonth: '2026-10', calculatedAmount: 9000, amount: 9000 }), user: 'ורד' });
  assert.strictEqual(r2.credit.id, 'credit::id-sara-7f3::2026-10::1');
  const r3 = code.handle({ action: 'saveCredit', credit: BASE, user: 'דנה' });
  assert.strictEqual(r3.credit.id, 'credit::id-sara-7f3::2026-09::2', 'seq increments per patientId+month');

  const got = code.handle({ action: 'getCredits' });
  assert.strictEqual(got.ok, true);
  assert.strictEqual(got.credits.length, 3);
  got.credits.forEach((c) => {
    assert.strictEqual(c.patientId, PID, 'persisted Patients id stored as-is');
    assert.strictEqual(c.patientKey, PKEY, 'legacy triple stored as-is');
    assert.notStrictEqual(c.patientId, c.patientKey);
    assert.strictEqual(typeof c.allocationMonth, 'string');
  });
  assert.strictEqual(got.credits[0].allocationMonth, '2026-09');
  // row-level '@' on the allocationMonth cell landed BEFORE the values did
  const sh = sandbox.__sheets.Credits;
  const monthCol = EXPECTED_COLUMNS.indexOf('allocationMonth') + 1;
  const fmt = sh.ops.find((o) => o.op === 'fmt' && o.r === 2 && o.c === monthCol);
  const set = sh.ops.find((o) => o.op === 'set' && o.r === 2);
  assert.ok(fmt && set && fmt.seq < set.seq);
  // audit
  const audit = auditOf(code, sandbox).filter((a) => a.action === 'credit_created');
  assert.strictEqual(audit.length, 3);
  const d = JSON.parse(audit[0].details);
  assert.strictEqual(d.patientKey, PKEY);
  assert.strictEqual(d.override, false);
  assert.strictEqual(d.updatedBy, 'ורד');
});

test('server-side validation: creditType outside the allowed list, bad status, bad month and a missing key are refused — nothing written', () => {
  const { code, sandbox } = loadCode();
  const cases = [
    [Object.assign({}, BASE, { creditType: 'refund' }), 'bad_creditType'],
    [Object.assign({}, BASE, { creditType: 'DAYS_UNUSED' }), 'bad_creditType'],
    [Object.assign({}, BASE, { status: 'done' }), 'bad_status'],
    [Object.assign({}, BASE, { allocationMonth: '2026-13' }), 'bad_month'],
    [Object.assign({}, BASE, { allocationMonth: '09/2026' }), 'bad_month'],
    [Object.assign({}, BASE, { patientKey: '' }), 'missing_patientKey'],
    [Object.assign({}, BASE, { patientId: '' }), 'missing_patientId'],
    [Object.assign({}, BASE, { amount: -5 }), 'bad_amount'],
    [Object.assign({}, BASE, { calculatedAmount: 'abc' }), 'bad_amount'],
    [Object.assign({}, BASE, { creditType: 'other', reason: '' }), 'reason_required'],
    [null, 'missing_credit'],
  ];
  cases.forEach(([credit, error]) => {
    const res = code.upsert(credit, 'ורד');
    assert.strictEqual(res.ok, false, error);
    assert.strictEqual(res.error, error);
  });
  assert.strictEqual(creditsOf(code, sandbox).length, 0);
});

test('override path: amount ≠ calculatedAmount WITHOUT overrideReason is refused; with a reason both figures persist and calculatedAmount is untouched', () => {
  const { code, sandbox } = loadCode();
  const bad = code.upsert(Object.assign({}, BASE, { amount: 4000, overrideReason: '   ' }), 'ורד');
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.error, 'override_reason_required');
  assert.strictEqual(creditsOf(code, sandbox).length, 0);

  const ok = code.upsert(Object.assign({}, BASE, { amount: 4000, overrideReason: 'הסכמה עם המשפחה' }), 'ורד');
  assert.strictEqual(ok.ok, true);
  const row = creditsOf(code, sandbox)[0];
  assert.strictEqual(row.calculatedAmount, 4800);
  assert.strictEqual(row.amount, 4000);
  assert.strictEqual(row.overrideReason, 'הסכמה עם המשפחה');
  const d = JSON.parse(auditOf(code, sandbox).find((a) => a.action === 'credit_created').details);
  assert.strictEqual(d.override, true);
});

test('a ZERO credit is still a row (calculatedAmount 0, amount 0, no override needed)', () => {
  const { code, sandbox } = loadCode();
  const res = code.upsert(Object.assign({}, BASE, { calculatedAmount: 0, amount: 0 }), 'ורד');
  assert.strictEqual(res.ok, true);
  const row = creditsOf(code, sandbox)[0];
  assert.strictEqual(row.calculatedAmount, 0);
  assert.strictEqual(row.amount, 0);
  assert.strictEqual(row.status, 'pending');
  // amount omitted → defaults to calculatedAmount
  const res2 = code.upsert(Object.assign({}, BASE, { amount: undefined }), 'ורד');
  assert.strictEqual(res2.ok, true);
  assert.strictEqual(res2.credit.amount, 4800);
});

/* ===== C. edit: immutability + stale-save conflict ===== */

test('edit: only the editable columns change; calculatedAmount, identity keys, reason and creation stamps are carried from the SHEET whatever the payload says', () => {
  const { code, sandbox } = loadCode();
  const created = code.upsert(BASE, 'ורד').credit;
  const edit = code.upsert({
    id: created.id, updatedAt: created.updatedAt,
    // attempted tampering:
    calculatedAmount: 1, patientId: 'other', patientKey: 'x::y::z', reason: 'rewritten', createdAt: '2000-01-01T00:00:00.000Z', createdBy: 'FORGED', creditType: 'other', allocationMonth: '2027-01',
    // legitimate edits:
    amount: 4000, overrideReason: 'סוכם טלפונית', status: 'paid', paymentDate: '2026-09-20', method: 'העברה', notes: 'שולם', approvedBy: 'סנדרה',
  }, 'דנה');
  assert.strictEqual(edit.ok, true, JSON.stringify(edit));
  assert.strictEqual(edit.updated, true);
  const rows = creditsOf(code, sandbox);
  assert.strictEqual(rows.length, 1, 'edit replaces in place — no second row');
  const r = rows[0];
  assert.strictEqual(r.id, created.id);
  assert.strictEqual(r.calculatedAmount, 4800, 'never overwritten by the edited value');
  assert.strictEqual(r.amount, 4000);
  assert.strictEqual(r.overrideReason, 'סוכם טלפונית');
  assert.strictEqual(r.patientId, PID);
  assert.strictEqual(r.patientKey, PKEY);
  assert.strictEqual(r.reason, 'trail');
  assert.strictEqual(r.creditType, 'days_unused');
  assert.strictEqual(r.allocationMonth, '2026-09');
  assert.strictEqual(r.createdAt, created.createdAt);
  assert.strictEqual(r.createdBy, 'ורד');
  assert.strictEqual(r.updatedBy, 'דנה');
  assert.strictEqual(r.status, 'paid');
  assert.strictEqual(r.paymentDate, '2026-09-20');
  assert.strictEqual(r.method, 'העברה');
  assert.strictEqual(r.approvedBy, 'סנדרה');
  assert.ok(auditOf(code, sandbox).some((a) => a.action === 'credit_updated'));
});

test('edit: a payload updatedAt that differs from the sheet stamp is REFUSED with `conflicts` (who saved first) and the row is byte-unchanged', () => {
  const { code, sandbox } = loadCode();
  const created = code.upsert(BASE, 'ורד').credit;
  const before = JSON.stringify(sandbox.__sheets.Credits.grid[1]);
  const res = code.upsert({ id: created.id, updatedAt: '2026-01-01T00:00:00.000Z', amount: 100, overrideReason: 'x' }, 'דנה');
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'conflict');
  assert.strictEqual(res.conflicts.length, 1);
  assert.strictEqual(res.conflicts[0].id, created.id);
  assert.strictEqual(res.conflicts[0].sheetUpdatedBy, 'ורד');
  assert.strictEqual(res.conflicts[0].sheetUpdatedAt, created.updatedAt);
  assert.strictEqual(JSON.stringify(sandbox.__sheets.Credits.grid[1]), before);
  assert.ok(auditOf(code, sandbox).some((a) => a.action === 'credit_save_conflict'));
  // A blank seen-stamp (pre-stamp client) keeps last-writer-wins — no refusal.
  const ok = code.upsert({ id: created.id, updatedAt: '', notes: 'n' }, 'דנה');
  assert.strictEqual(ok.ok, true);
});

test('edit: an id the sheet does not carry is refused (clients never mint ids) — nothing appended', () => {
  const { code, sandbox } = loadCode();
  code.upsert(BASE, 'ורד');
  const res = code.upsert(Object.assign({}, BASE, { id: 'credit::id-sara-7f3::2026-09::9' }), 'ורד');
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'unknown_credit');
  assert.strictEqual(creditsOf(code, sandbox).length, 1);
});

test('no new unauthenticated surface: server.js is untouched by this change and the proxy still overwrites body.user from the cookie', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(!/saveCredit|getCredits/.test(server), 'no credit-specific route — credits ride the session-authed /api/sheets proxy');
  assert.ok(/body\.user = sessionUserFromRequest\(req\)/.test(server));
});

/* ================= app.js harness ================= */

function fakeEl() {
  return {
    className: '', dataset: {}, style: {}, _html: '', children: [], disabled: false, hidden: false, value: '',
    set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; },
    appendChild(c) { this.children.push(c); }, addEventListener() {}, remove() {},
    set onclick(_f) {}, set onchange(_f) {}, set onsubmit(_f) {},
    querySelector() { return fakeEl(); }, querySelectorAll() { return []; },
    classList: { add() {}, remove() {}, toggle() {} },
  };
}
const APP_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
function loadApp(routes) {
  const calls = [];
  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/' },
    document: { getElementById: () => fakeEl(), createElement: () => fakeEl(), querySelectorAll: () => [], addEventListener() {}, body: fakeEl() },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    URL, URLSearchParams, Math, Date, JSON, Number, String, Array, Object, RegExp, Promise, Intl,
    setTimeout, clearTimeout,
    fetch: (url, opts) => {
      const body = opts && opts.body ? JSON.parse(opts.body) : null;
      calls.push(body);
      const handler = body && routes && routes[body.action];
      const payload = handler ? handler(body) : { ok: true };
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) });
    },
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  const epilogue = `
    showCloseLeadModal = (opts) => { globalThis.__confirm = opts.onConfirm; };
    showCreditsModal = (opts) => { globalThis.__creditsModal.push(opts); };
    renderAll = () => {};
    showError = (m) => { globalThis.__errors.push(m); };
    showToast = () => {};
    globalThis.__errors = [];
    globalThis.__creditsModal = [];
    globalThis.__test = {
      state,
      normalizePatient, normalizePayment, normalizeCredit,
      suggestCredits, suggestCredit, validateCreditLine, creditBasisText, buildCreditLines,
      creditsForPatient, creditId, paymentCoverage, addMonthsClamped, localDateFromISO, diffWholeDays, isoDate, exVat,
      patientKey, saveCredit, dischargePatient,
      confirm: (payload) => globalThis.__confirm(payload),
      errors: () => globalThis.__errors,
      creditsModal: () => globalThis.__creditsModal,
      CREDIT_MIN_TENURE_DAYS, VAT_RATE,
    };`;
  vm.createContext(sandbox);
  vm.runInContext(APP_SRC + epilogue, sandbox);
  return { app: sandbox.__test, calls };
}

const PATIENT = { id: 'id-dana-1', houseId: 'ramot', name: 'דנה', date: '2026-09-01', pay: 9000, adv: 0, status: 'active', fromLead: 'L1', exitDate: '', source: 'lead', notes: '' };
const KEY = 'ramot::דנה::2026-09-01';
function pay(over) {
  return Object.assign({ id: 'pay::' + KEY + '::' + over.dueDate, patientId: KEY, patientName: 'דנה', houseId: 'ramot',
    amount: 9000, status: 'paid', amountPaid: 9000, balance: 0, timestamp: '' }, over);
}

/* ===== D. suggestCredits — the rule ===== */

test('14-day boundary: tenure 13 credits the unused remainder; 14 and 15 credit 0 (row still suggested)', () => {
  const { app } = loadApp();
  const payments = [pay({ dueDate: '2026-09-01' })];
  const s13 = app.suggestCredit(PATIENT, '2026-09-14', payments);
  assert.strictEqual(s13.creditType, 'days_unused');
  assert.strictEqual(s13.allocationMonth, '2026-09');
  assert.strictEqual(s13.basis.tenureDays, 13);
  assert.strictEqual(s13.basis.eligible, true);
  assert.strictEqual(s13.basis.daysInMonth, 30);
  assert.strictEqual(s13.basis.dailyRate, 300);
  assert.strictEqual(s13.basis.daysPaidFor, 30, 'Sep 1 → Sep 30 (D + 1 month − 1 day)');
  assert.strictEqual(s13.basis.daysStayed, 14, 'exit day counts as stayed');
  assert.strictEqual(s13.basis.unusedDays, 16);
  assert.strictEqual(s13.calculatedAmount, 4800);

  const s14 = app.suggestCredit(PATIENT, '2026-09-15', payments);
  assert.strictEqual(s14.basis.tenureDays, 14);
  assert.strictEqual(s14.basis.eligible, false);
  assert.strictEqual(s14.calculatedAmount, 0);
  assert.strictEqual(s14.basis.uncappedAmount, 0);

  const s15 = app.suggestCredit(PATIENT, '2026-09-16', payments);
  assert.strictEqual(s15.basis.tenureDays, 15);
  assert.strictEqual(s15.calculatedAmount, 0);
  assert.strictEqual(app.CREDIT_MIN_TENURE_DAYS, 14);
});

test('divisor = actual calendar days of the credited month: 28 (Feb 2026), 30 (Sep), 31 (Aug)', () => {
  const { app } = loadApp();
  const run = (entry, exit) => app.suggestCredit(Object.assign({}, PATIENT, { date: entry }),
    exit, [pay({ dueDate: entry, patientId: `ramot::דנה::${entry}`, id: 'x' })]);
  const feb = run('2026-02-01', '2026-02-06');   // tenure 5, stayed 6
  assert.strictEqual(feb.basis.daysInMonth, 28);
  assert.strictEqual(feb.basis.daysPaidFor, 28);
  assert.strictEqual(feb.basis.unusedDays, 22);
  assert.strictEqual(feb.calculatedAmount, Math.round(9000 / 28 * 22 * 100) / 100);  // 7071.43
  const sep = run('2026-09-01', '2026-09-06');
  assert.strictEqual(sep.basis.daysInMonth, 30);
  assert.strictEqual(sep.calculatedAmount, 7200);
  const aug = run('2026-08-01', '2026-08-06');
  assert.strictEqual(aug.basis.daysInMonth, 31);
  assert.strictEqual(aug.basis.daysPaidFor, 31);
  assert.strictEqual(aug.calculatedAmount, Math.round(9000 / 31 * 25 * 100) / 100);  // 7258.06
});

test('prepaid_return fires at tenure well above 14 for every payment due AFTER the exit — including a same-month row — and is 0-free for months already covered', () => {
  const { app } = loadApp();
  const p = Object.assign({}, PATIENT, { date: '2026-08-01' });
  const key = 'ramot::דנה::2026-08-01';
  const payments = [
    pay({ dueDate: '2026-08-01', patientId: key }),
    pay({ dueDate: '2026-09-01', patientId: key }),
    pay({ dueDate: '2026-10-01', patientId: key, amountPaid: 9000 }),
    pay({ dueDate: '2026-11-01', patientId: key, amount: 9000, amountPaid: 4500, status: 'partial' }),
  ];
  const all = app.suggestCredits(p, '2026-09-10', payments);   // tenure 40
  assert.strictEqual(all.length, 3);
  assert.strictEqual(all[0].creditType, 'days_unused');
  assert.strictEqual(all[0].basis.tenureDays, 40);
  assert.strictEqual(all[0].calculatedAmount, 0);
  assert.strictEqual(all[0].allocationMonth, '2026-09', 'credited month = the row covering the exit');
  assert.deepStrictEqual(plain(all.slice(1).map((s) => [s.creditType, s.allocationMonth, s.calculatedAmount])), [
    ['prepaid_return', '2026-10', 9000],
    ['prepaid_return', '2026-11', 4500],
  ]);
  assert.strictEqual(all[2].basis.uncappedAmount, 9000, 'billed figure kept in basis');
  assert.strictEqual(all[2].basis.capped, true);
  // same calendar month as the discharge but due AFTER it → still fully unearned
  const same = app.suggestCredits(p, '2026-09-10', [pay({ dueDate: '2026-09-01', patientId: key }), pay({ dueDate: '2026-09-25', patientId: key })]);
  assert.deepStrictEqual(plain(same.slice(1).map((s) => [s.creditType, s.allocationMonth, s.calculatedAmount])), [['prepaid_return', '2026-09', 9000]]);
});

test('exitDate arrives as a raw ISO timestamp: month boundary + DST (March and October) — no −1 day drift, tenure exact', () => {
  const { app } = loadApp();
  // 2026-08-31T21:00Z is 2026-09-01 00:00 Israel (UTC+3). A naive slice says Aug 31.
  const bnd = app.suggestCredit(PATIENT, '2026-08-31T21:00:00.000Z', [pay({ dueDate: '2026-09-01' })]);
  assert.strictEqual(bnd.basis.exitDate, '2026-09-01');
  assert.notStrictEqual(bnd.basis.exitDate, '2026-08-31T21:00:00.000Z'.slice(0, 10));
  assert.strictEqual(bnd.basis.tenureDays, 0);
  assert.strictEqual(bnd.basis.daysStayed, 1);
  assert.strictEqual(bnd.allocationMonth, '2026-09');

  // Israel DST starts 2026-03-27 02:00. Entry Mar 20 (paid), exit at Israel midnight Apr 1.
  const marchP = Object.assign({}, PATIENT, { date: '2026-03-20', pay: 9300 });
  const march = app.suggestCredit(marchP, '2026-03-31T21:00:00.000Z',
    [pay({ dueDate: '2026-03-20', patientId: 'ramot::דנה::2026-03-20', amount: 9300, amountPaid: 9300 })]);
  assert.strictEqual(march.basis.exitDate, '2026-04-01');
  assert.strictEqual(march.basis.tenureDays, 12, 'Mar 20 → Apr 1 across the DST switch is exactly 12 days');
  assert.strictEqual(march.allocationMonth, '2026-03');
  assert.strictEqual(march.basis.daysInMonth, 31);
  assert.strictEqual(march.basis.dailyRate, 300);
  assert.strictEqual(march.basis.coverageStart, '2026-03-20');
  assert.strictEqual(march.basis.coverageEnd, '2026-04-19');
  assert.strictEqual(march.basis.daysPaidFor, 31);
  assert.strictEqual(march.basis.daysStayed, 13);
  assert.strictEqual(march.basis.unusedDays, 18);
  assert.strictEqual(march.calculatedAmount, 5400);

  // Israel DST ends 2026-10-25 02:00. Exit at Israel midnight Nov 1 (UTC+2 → 22:00Z).
  const octP = Object.assign({}, PATIENT, { date: '2026-10-20' });
  const oct = app.suggestCredit(octP, '2026-10-31T22:00:00.000Z', [pay({ dueDate: '2026-10-20', patientId: 'ramot::דנה::2026-10-20' })]);
  assert.strictEqual(oct.basis.exitDate, '2026-11-01');
  assert.strictEqual(oct.basis.tenureDays, 12);
  assert.strictEqual(oct.basis.daysStayed, 13);

  // The helpers themselves
  const a = app.localDateFromISO('2026-03-20'), b = app.localDateFromISO('2026-04-01');
  assert.strictEqual(app.diffWholeDays(a, b), 12);
  assert.strictEqual(app.isoDate('2026-03-31T21:00:00.000Z'), '2026-04-01');
});

test('coverage period: D + 1 month − 1 day with the day clamped (Jan 31 → ends Feb 27, never a March overflow)', () => {
  const { app } = loadApp();
  const cov = app.paymentCoverage({ dueDate: '2026-01-31' });
  assert.strictEqual(cov.start.getDate(), 31);
  assert.strictEqual(cov.end.getMonth(), 1);
  assert.strictEqual(cov.end.getDate(), 27);
  const c2 = app.paymentCoverage({ dueDate: '2026-09-15' });
  assert.strictEqual(c2.end.getMonth(), 9);
  assert.strictEqual(c2.end.getDate(), 14);
  assert.strictEqual(app.addMonthsClamped(new Date(2026, 0, 31), 1).getDate(), 28);
});

test('cap at money received: partial payment where the uncapped credit exceeds amountPaid → calculated = amountPaid, uncapped visible in basis + trail text', () => {
  const { app } = loadApp();
  const s = app.suggestCredit(PATIENT, '2026-09-06', [pay({ dueDate: '2026-09-01', amountPaid: 3000, status: 'partial', balance: 6000 })]);
  assert.strictEqual(s.basis.unusedDays, 24);
  assert.strictEqual(s.basis.uncappedAmount, 7200);
  assert.strictEqual(s.basis.amountPaid, 3000);
  assert.strictEqual(s.basis.capped, true);
  assert.strictEqual(s.calculatedAmount, 3000);
  const text = app.creditBasisText('days_unused', Object.assign({ allocationMonth: s.allocationMonth }, s.basis));
  assert.ok(text.includes('7200') && text.includes('3000'), text);
  assert.ok(text.includes('הוגבל לסכום ששולם'));
});

test('amountPaid 0 (row exists, unpaid) → calculatedAmount 0 but the suggestion is still emitted', () => {
  const { app } = loadApp();
  const all = app.suggestCredits(PATIENT, '2026-09-06', [pay({ dueDate: '2026-09-01', amountPaid: 0, status: 'unpaid', balance: 9000 })]);
  assert.strictEqual(all.length, 1);
  assert.strictEqual(all[0].calculatedAmount, 0);
  assert.strictEqual(all[0].basis.uncappedAmount, 7200);
  assert.strictEqual(all[0].basis.amountPaid, 0);
  assert.strictEqual(all[0].basis.capped, true);
  assert.strictEqual(all[0].basis.coverageSource, 'payment');
  assert.strictEqual(app.validateCreditLine({ creditType: 'days_unused', allocationMonth: '2026-09', calculatedAmount: 0, amount: 0 }), null, 'a zero credit is saveable');
});

test('no payment row for the month at all → full calendar month fallback, monthly rate from patient.pay, nothing received → 0 (row still suggested)', () => {
  const { app } = loadApp();
  const s = app.suggestCredit(PATIENT, '2026-09-10', []);
  assert.strictEqual(s.allocationMonth, '2026-09');
  assert.strictEqual(s.basis.coverageSource, 'calendar_month');
  assert.strictEqual(s.basis.coverageStart, '2026-09-01');
  assert.strictEqual(s.basis.coverageEnd, '2026-09-30');
  assert.strictEqual(s.basis.daysPaidFor, 30);
  assert.strictEqual(s.basis.daysStayed, 10);
  assert.strictEqual(s.basis.unusedDays, 20);
  assert.strictEqual(s.basis.monthlyRate, 9000);
  assert.strictEqual(s.basis.uncappedAmount, 6000);
  assert.strictEqual(s.basis.amountPaid, 0);
  assert.strictEqual(s.calculatedAmount, 0);
  // Another patient's rows never leak in (joined on patientKey)
  const s2 = app.suggestCredit(PATIENT, '2026-09-10', [pay({ dueDate: '2026-09-01', patientId: 'asher::אחר::2026-09-01' })]);
  assert.strictEqual(s2.basis.coverageSource, 'calendar_month');
  assert.strictEqual(s2.calculatedAmount, 0);
  assert.deepStrictEqual(plain(app.suggestCredits(PATIENT, '', [])), [], 'no exit date → nothing to compute');
});

/* ===== E. client validation + normalization ===== */

test('validateCreditLine: amount ≠ calculatedAmount without overrideReason FAILS; with one passes; other type needs a reason; bad month/type refused', () => {
  const { app } = loadApp();
  const base = { creditType: 'days_unused', allocationMonth: '2026-09', calculatedAmount: 4800, amount: 4800, overrideReason: '' };
  assert.strictEqual(app.validateCreditLine(base), null);
  const changed = Object.assign({}, base, { amount: 4000 });
  assert.match(app.validateCreditLine(changed), /נימוק/);
  assert.match(app.validateCreditLine(Object.assign({}, changed, { overrideReason: '   ' })), /נימוק/);
  assert.strictEqual(app.validateCreditLine(Object.assign({}, changed, { overrideReason: 'סוכם' })), null);
  assert.match(app.validateCreditLine(Object.assign({}, base, { amount: '' })), /סכום/);
  assert.match(app.validateCreditLine(Object.assign({}, base, { amount: -1 })), /סכום/);
  assert.match(app.validateCreditLine(Object.assign({}, base, { creditType: 'refund' })), /סוג/);
  assert.match(app.validateCreditLine(Object.assign({}, base, { allocationMonth: '2026-9' })), /חודש/);
  assert.match(app.validateCreditLine({ creditType: 'other', allocationMonth: '2026-09', calculatedAmount: 500, amount: 500, reason: '' }), /סיבה/);
  assert.strictEqual(app.validateCreditLine({ creditType: 'other', allocationMonth: '2026-09', calculatedAmount: 500, amount: 500, reason: 'פיצוי' }), null);
});

test('normalizeCredit round-trips patientId AND patientKey intact (distinct, neither derived); creditsForPatient joins on either key; buildCreditLines never proposes a duplicate', () => {
  const { app } = loadApp();
  const raw = { id: 'credit::id-dana-1::2026-09::1', patientId: 'id-dana-1', patientKey: KEY, patientName: 'דנה', houseId: 'ramot',
    creditType: 'days_unused', allocationMonth: '2026-09', calculatedAmount: '4800', amount: '4000', overrideReason: 'x', reason: 'trail',
    approvedBy: '', status: 'pending', paymentDate: '', method: '', notes: '', createdAt: 'T1', createdBy: 'ורד', updatedAt: 'T2', updatedBy: 'ורד' };
  const c = app.normalizeCredit(raw);
  assert.strictEqual(c.patientId, 'id-dana-1');
  assert.strictEqual(c.patientKey, KEY);
  assert.strictEqual(c.calculatedAmount, 4800);
  assert.strictEqual(c.amount, 4000);
  assert.strictEqual(c.updatedAt, 'T2');
  // a row with a blank patientId still joins by the triple; a renamed patient still joins by id
  const legacy = app.normalizeCredit(Object.assign({}, raw, { id: 'c2', patientId: '' }));
  assert.strictEqual(legacy.patientId, '', 'not derived from patientKey');
  assert.strictEqual(app.creditsForPatient([c, legacy], 'id-dana-1', '').length, 1);
  assert.strictEqual(app.creditsForPatient([c, legacy], '', KEY).length, 2);
  assert.strictEqual(app.creditsForPatient([c, legacy], 'id-dana-1', KEY).length, 2);
  const lines = app.buildCreditLines([c], app.suggestCredits(PATIENT, '2026-09-14', [pay({ dueDate: '2026-09-01' }), pay({ dueDate: '2026-10-01' })]));
  assert.deepStrictEqual(plain(lines.map((l) => [l.creditType, l.allocationMonth, l.isNew])), [
    ['days_unused', '2026-09', false],
    ['prepaid_return', '2026-10', true],
  ]);
  assert.strictEqual(lines[0].calculatedAmount, 4800);
  assert.strictEqual(app.creditId('id-dana-1', '2026-09', 1), 'credit::id-dana-1::2026-09::1');
  assert.strictEqual(app.exVat(1180), 1000);
});

/* ===== F. discharge integration + error surfacing ===== */

test('discharge: credits are offered only AFTER dischargePatient and saveAll both succeed, with patientId + patientKey + the normalized exitDate', async () => {
  const { app, calls } = loadApp({});
  app.state.mode = 'edit';
  const p = app.normalizePatient(PATIENT);
  app.state.patients = [p]; app.state.leads = []; app.state.dischargedPatients = []; app.state.payments = [pay({ dueDate: '2026-09-01' })];
  app.dischargePatient(p);
  await app.confirm({ disposition: 'completed', note: '', dischargeDate: '2026-09-14' });
  const actions = calls.map((c) => c && c.action);
  assert.deepStrictEqual(actions, ['dischargePatient', 'saveAll']);
  assert.strictEqual(app.creditsModal().length, 1);
  const opts = app.creditsModal()[0];
  assert.strictEqual(opts.patientId, 'id-dana-1');
  assert.strictEqual(opts.patientKey, KEY);
  assert.strictEqual(opts.exitDate, '2026-09-14');
  assert.strictEqual(p.status, 'released');
});

test('discharge: a FAILED discharge write never reaches the credits step', async () => {
  const { app } = loadApp({ dischargePatient: () => ({ ok: false, error: 'exception', message: 'boom' }) });
  app.state.mode = 'edit';
  const p = app.normalizePatient(PATIENT);
  app.state.patients = [p]; app.state.leads = []; app.state.dischargedPatients = [];
  app.dischargePatient(p);
  await assert.rejects(() => app.confirm({ disposition: 'completed', note: '', dischargeDate: '2026-09-14' }));
  assert.strictEqual(app.creditsModal().length, 0);
  assert.strictEqual(p.status, 'active');
});

test('saveCredit surfaces backend refusals: {ok:false} on a 200 throws with the backend message; a conflict renders the Hebrew banner naming who saved first; the discharge stays released', async () => {
  const { app } = loadApp({
    saveCredit: (body) => body.credit.notes === 'conflict'
      ? { ok: false, error: 'conflict', conflicts: [{ id: 'c1', name: 'דנה', sheetUpdatedBy: 'סנדרה', sheetUpdatedAt: 'T9' }] }
      : body.credit.notes === 'bad'
        ? { ok: false, error: 'override_reason_required' }
        : body.credit.notes === 'empty' ? { ok: true } : { ok: true, created: true, credit: Object.assign({}, body.credit, { id: 'credit::id-dana-1::2026-09::1', updatedAt: 'T1' }) },
  });
  app.state.mode = 'edit';
  const p = app.normalizePatient(Object.assign({}, PATIENT, { status: 'released', exitDate: '2026-09-14' }));
  app.state.patients = [p];
  const line = { id: '', patientId: 'id-dana-1', patientKey: KEY, creditType: 'days_unused', allocationMonth: '2026-09', calculatedAmount: 4800, amount: 4800, notes: '' };

  await assert.rejects(() => app.saveCredit(Object.assign({}, line, { notes: 'bad' })), /override_reason_required/);
  await assert.rejects(() => app.saveCredit(Object.assign({}, line, { notes: 'empty' })), /תשובת שרת לא תקינה/);
  await assert.rejects(() => app.saveCredit(Object.assign({}, line, { notes: 'conflict' })), (e) => e.handled === true && e.conflict === true);
  assert.ok(app.errors().some((m) => m.includes('סנדרה') && m.includes('לא נשמר')), JSON.stringify(app.errors()));
  assert.strictEqual(p.status, 'released', 'a failed credit write never touches the discharge');
  assert.strictEqual(app.state.credits.length, 0);

  const saved = await app.saveCredit(line);
  assert.strictEqual(saved.id, 'credit::id-dana-1::2026-09::1');
  assert.strictEqual(app.state.credits.length, 1);
  assert.strictEqual(app.state.credits[0].patientKey, KEY);
});

test('saveCredit refuses outside edit mode without a network call', async () => {
  const { app, calls } = loadApp({});
  app.state.mode = 'view';
  await assert.rejects(() => app.saveCredit({}), /עריכה/);
  assert.strictEqual(calls.length, 0);
});
