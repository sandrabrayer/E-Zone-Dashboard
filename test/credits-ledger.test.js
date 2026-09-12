/* Credits / refunds ledger (apps-script/Code.gs, public/app.js).
 *
 * Locked contracts (rules: CHANGELOG-credits-ledger.md):
 *   - CREDIT_COLUMNS order is PINNED (24 columns, append-only, position is the
 *     contract); both identity keys (patientId = persisted Patients id,
 *     patientKey = the legacy triple that keys Payments) are stored on every
 *     row and round-trip intact — never derived from each other;
 *   - FACILITY_TYPE_BY_HOUSE maps the six Patients-sheet houseIds:
 *     asher/ramot → residential; rehab/pardes/arfoni/sde → detox_dual;
 *     the server derives facilityType from houseId;
 *   - the sheet is auto-created via getOrCreateSheet_ with allocationMonth +
 *     every date/stamp column text-forced ('@');
 *   - the server mints credit::<patientId>::<month>::<seq>, validates
 *     creditType/status/month/amounts/houseId, REQUIRES overrideReason when
 *     amount ≠ calculatedAmount, requires paidDate+method for status 'paid',
 *     derives payoutDate from decidedDate (15th on/after), stamps
 *     createdAt/By + updatedAt/By from the signed-cookie user, keeps
 *     calculatedAmount/basis/creation stamps immutable on edit, and refuses a
 *     stale edit (differing updatedAt) with `conflicts`;
 *   - suggestCredits credits PER PAYMENT ROW on its coverage window
 *     [dueDate, dueDate + 1 month − 1 day]: unusedDays = window days strictly
 *     after the exit (never a day another window already credited),
 *     rate = that row's amountPaid / 30, classified by the window (starts on/
 *     before the exit → days_unused, after → prepaid_return); allocationMonth
 *     is reporting metadata only;
 *     residential pro-rata at any tenure except the last-7-days window;
 *     detox_dual pro-rata under 14 days, 0 at 14+ (discretionary);
 *     prepaid_return for later billed months regardless of everything;
 *     cap at amountPaid with the uncapped figure in basis; amountPaid 0 and
 *     "no payment row" still yield a (zero) suggestion; a raw ISO exitDate at
 *     a month boundary / across DST never drifts a day;
 *   - payoutDateFor: 14th → same-month 15th, 15th → same-month 15th,
 *     16th → next-month 15th;
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
    CREDIT_COLUMNS, CREDITS_SHEET, CREDIT_TYPES, CREDIT_STATUSES, CREDIT_EDITABLE_COLUMNS, CREDIT_TEXT_COLUMNS, FACILITY_TYPE_BY_HOUSE,
    AUDIT_LOG_COLUMNS, AUDIT_LOG_SHEET, PATIENT_COLUMNS,
    readSheet: (sh, cols) => readSheet_(sh, cols),
    handle: (params) => handle_(params).json,
    ensure: (name, cols) => getOrCreateSheet_(name, cols),
    upsert: (c, u) => upsertCredit_(c, u),
    creditId: (p, m, s) => creditId_(p, m, s),
    payoutDateFor: (d) => payoutDateFor_(d),
    facilityTypeFor: (h) => facilityTypeFor_(h),
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
  'id', 'patientId', 'patientKey', 'patientName', 'houseId', 'facilityType', 'creditType',
  'allocationMonth', 'calculatedAmount', 'amount', 'overrideReason', 'reason',
  'approvedBy', 'decidedDate', 'payoutDate', 'status', 'paidDate', 'method', 'notes',
  'basis', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy',
];
const FACILITY_MAP = { asher: 'residential', ramot: 'residential', rehab: 'detox_dual', pardes: 'detox_dual', arfoni: 'detox_dual', sde: 'detox_dual' };
const PID = 'id-sara-7f3';
const PKEY = 'ramot::שרה כהן::2026-07-01';
const BASE = {
  patientId: PID, patientKey: PKEY, patientName: 'שרה כהן', houseId: 'ramot',
  creditType: 'days_unused', allocationMonth: '2026-09',
  calculatedAmount: 4800, amount: 4800, overrideReason: '', reason: 'trail', status: 'pending', notes: '',
  decidedDate: '2026-09-14', basis: { rule: 'residential_prorata', uncappedAmount: 4800 },
};

/* ===== A. schema + sheet ensure ===== */

test('CREDIT_COLUMNS order is PINNED — 24 columns, both identity keys, stamps last; facility map covers the six house ids', () => {
  const { code } = loadCode();
  assert.deepStrictEqual(arr(code.CREDIT_COLUMNS), EXPECTED_COLUMNS);
  assert.strictEqual(code.CREDIT_COLUMNS.length, 24);
  assert.deepStrictEqual(plain(code.FACILITY_TYPE_BY_HOUSE), FACILITY_MAP);
  assert.strictEqual(code.facilityTypeFor('asher'), 'residential');
  assert.strictEqual(code.facilityTypeFor('sde'), 'detox_dual');
  assert.strictEqual(code.facilityTypeFor('nope'), '');
  assert.deepStrictEqual(arr(code.CREDIT_TYPES), ['days_unused', 'prepaid_return', 'other']);
  assert.deepStrictEqual(arr(code.CREDIT_STATUSES), ['pending', 'paid', 'cancelled']);
  assert.strictEqual(code.CREDITS_SHEET, 'Credits');
  // Patients / Payments structure untouched by this change.
  assert.deepStrictEqual(arr(code.PATIENT_COLUMNS), [
    'houseId', 'name', 'date', 'pay', 'adv', 'status', 'fromLead', 'exitDate', 'source', 'notes',
    'id', 'updatedAt', 'updatedBy']);
});

test('getOrCreateSheet_ auto-creates Credits with the header and text-forces allocationMonth + every date/stamp column', () => {
  const { code, sandbox } = loadCode();
  const sh = code.ensure(code.CREDITS_SHEET, arr(code.CREDIT_COLUMNS));
  assert.strictEqual(sandbox.__sheets.Credits, sh);
  assert.deepStrictEqual(sh.grid[0], EXPECTED_COLUMNS);
  const forced = sh.ops.filter((o) => o.op === 'fmt' && o.fmt === '@' && o.r === 1 && o.nr >= 1000).map((o) => EXPECTED_COLUMNS[o.c - 1]);
  assert.deepStrictEqual(forced.sort(), ['allocationMonth', 'createdAt', 'decidedDate', 'paidDate', 'payoutDate', 'updatedAt']);
  assert.deepStrictEqual(arr(code.CREDIT_TEXT_COLUMNS).slice().sort(), forced.sort());
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
  assert.strictEqual(r1.credit.facilityType, 'residential', 'derived from houseId ramot, never the payload');
  assert.strictEqual(r1.credit.decidedDate, '2026-09-14');
  assert.strictEqual(r1.credit.payoutDate, '2026-09-15', 'decided on the 14th → the 15th of the same month');
  assert.strictEqual(r1.credit.paidDate, '', 'pending carries no paidDate');
  assert.deepStrictEqual(JSON.parse(r1.credit.basis), { rule: 'residential_prorata', uncappedAmount: 4800 }, 'basis stored as JSON');

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
  assert.strictEqual(got.credits[0].facilityType, 'residential');
  assert.strictEqual(typeof got.credits[0].basis, 'string');
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
  assert.strictEqual(d.facilityType, 'residential');
  assert.strictEqual(d.payoutDate, '2026-09-15');
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
    [Object.assign({}, BASE, { houseId: 'unknown-house' }), 'bad_houseId'],
    [Object.assign({}, BASE, { decidedDate: 'not-a-date' }), 'bad_decidedDate'],
    [Object.assign({}, BASE, { status: 'paid' }), 'paid_requires_paidDate_method'],
    [Object.assign({}, BASE, { status: 'paid', paidDate: '2026-09-15' }), 'paid_requires_paidDate_method'],
    [Object.assign({}, BASE, { status: 'paid', method: 'העברה' }), 'paid_requires_paidDate_method'],
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
  const res2 = code.upsert(Object.assign({}, BASE, { amount: undefined, decidedDate: '' }), 'ורד');
  assert.strictEqual(res2.ok, true);
  assert.strictEqual(res2.credit.amount, 4800);
  assert.match(res2.credit.decidedDate, /^\d{4}-\d{2}-\d{2}$/, 'blank decidedDate defaults to today');
  assert.strictEqual(res2.credit.payoutDate, code.payoutDateFor(res2.credit.decidedDate));
});

test('payoutDateFor_: the 15th of the next month on or after decidedDate — 14th, 15th and 16th; year wrap; facilityType forged in the payload is ignored', () => {
  const { code } = loadCode();
  assert.strictEqual(code.payoutDateFor('2026-09-14'), '2026-09-15');
  assert.strictEqual(code.payoutDateFor('2026-09-15'), '2026-09-15');
  assert.strictEqual(code.payoutDateFor('2026-09-16'), '2026-10-15');
  assert.strictEqual(code.payoutDateFor('2026-12-20'), '2027-01-15');
  assert.strictEqual(code.payoutDateFor('2026-01-01'), '2026-01-15');
  assert.strictEqual(code.payoutDateFor(''), '');
  const detox = code.upsert(Object.assign({}, BASE, { houseId: 'rehab', facilityType: 'residential', decidedDate: '2026-09-16' }), 'ורד');
  assert.strictEqual(detox.ok, true);
  assert.strictEqual(detox.credit.facilityType, 'detox_dual', 'derived from houseId, the forged payload value is ignored');
  assert.strictEqual(detox.credit.payoutDate, '2026-10-15');
});

test('marking paid is an explicit edit: status paid + paidDate + method persist; payoutDate never flips status by itself', () => {
  const { code, sandbox } = loadCode();
  const created = code.upsert(Object.assign({}, BASE, { decidedDate: '2026-08-20' }), 'ורד').credit;
  assert.strictEqual(created.payoutDate, '2026-09-15');
  // A later read does not change anything — nothing is automatic.
  assert.strictEqual(code.handle({ action: 'getCredits' }).credits[0].status, 'pending');
  const paid = code.upsert({ id: created.id, updatedAt: created.updatedAt, status: 'paid', paidDate: '2026-09-15', method: 'העברה בנקאית' }, 'סנדרה');
  assert.strictEqual(paid.ok, true, JSON.stringify(paid));
  const row = creditsOf(code, sandbox)[0];
  assert.strictEqual(row.status, 'paid');
  assert.strictEqual(row.paidDate, '2026-09-15');
  assert.strictEqual(row.method, 'העברה בנקאית');
  assert.strictEqual(row.updatedBy, 'סנדרה');
  assert.strictEqual(row.payoutDate, '2026-09-15', 'payoutDate stays derived from decidedDate');
  // Un-paying clears paidDate; changing decidedDate re-derives payoutDate.
  const back = code.upsert({ id: created.id, updatedAt: paid.credit.updatedAt, status: 'pending', decidedDate: '2026-09-16' }, 'סנדרה');
  assert.strictEqual(back.credit.paidDate, '');
  assert.strictEqual(back.credit.payoutDate, '2026-10-15');
});

/* ===== C. edit: immutability + stale-save conflict ===== */

test('edit: only the editable columns change; calculatedAmount, identity keys, reason and creation stamps are carried from the SHEET whatever the payload says', () => {
  const { code, sandbox } = loadCode();
  const created = code.upsert(BASE, 'ורד').credit;
  const edit = code.upsert({
    id: created.id, updatedAt: created.updatedAt,
    // attempted tampering:
    calculatedAmount: 1, patientId: 'other', patientKey: 'x::y::z', reason: 'rewritten', basis: '{"forged":true}', facilityType: 'detox_dual', houseId: 'rehab', createdAt: '2000-01-01T00:00:00.000Z', createdBy: 'FORGED', creditType: 'other', allocationMonth: '2027-01', payoutDate: '2030-01-15',
    // legitimate edits:
    amount: 4000, overrideReason: 'סוכם טלפונית', status: 'paid', paidDate: '2026-09-20', method: 'העברה', notes: 'שולם', approvedBy: 'סנדרה',
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
  assert.strictEqual(r.paidDate, '2026-09-20');
  assert.strictEqual(r.houseId, 'ramot');
  assert.strictEqual(r.facilityType, 'residential');
  assert.strictEqual(r.payoutDate, '2026-09-15', 'derived, the forged payload value is ignored');
  assert.deepStrictEqual(JSON.parse(r.basis), { rule: 'residential_prorata', uncappedAmount: 4800 }, 'basis immutable');
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
      patientKey, saveCredit, dischargePatient, payoutDateFor, applyCreditCap, facilityTypeFor, pendingCreditsByPayout,
      FACILITY_TYPE_BY_HOUSE, CREDIT_DAYS_DIVISOR, CREDIT_DETOX_TENURE_CUTOFF_DAYS, CREDIT_RESIDENTIAL_LAST_DAYS,
      confirm: (payload) => globalThis.__confirm(payload),
      errors: () => globalThis.__errors,
      creditsModal: () => globalThis.__creditsModal,
      VAT_RATE,
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

/* ===== D. suggestCredits — the rules ===== */

/* Residential patient (ramot) and detox_dual patient (rehab) with the SAME
 * dates and payments, so facility policy is the only variable. */
const RES = { id: 'id-res-1', houseId: 'ramot', name: 'דנה', date: '2026-09-01', pay: 9000, status: 'active' };
const DTX = { id: 'id-dtx-1', houseId: 'rehab', name: 'דנה', date: '2026-09-01', pay: 9000, status: 'active' };
const RES_KEY = 'ramot::דנה::2026-09-01';
const DTX_KEY = 'rehab::דנה::2026-09-01';
function payFor(key, over) {
  return Object.assign({ id: 'pay::' + key + '::' + over.dueDate, patientId: key, patientName: 'דנה', houseId: key.split('::')[0],
    amount: 9000, status: 'paid', amountPaid: 9000, balance: 0, timestamp: '' }, over);
}
/* Same patient shape in a given house with an entry date; a paid 9000 row due
 * on the entry date. */
function scenario(houseId, entry, over) {
  const p = { id: 'id-' + houseId, houseId, name: 'דנה', date: entry, pay: 9000, status: 'active' };
  const key = `${houseId}::דנה::${entry}`;
  return { p, key, payments: [payFor(key, Object.assign({ dueDate: entry }, over || {}))] };
}

test('facility map mirrors Code.gs: asher/ramot residential, rehab/pardes/arfoni/sde detox_dual; constants pinned', () => {
  const { app } = loadApp();
  assert.deepStrictEqual(plain(app.FACILITY_TYPE_BY_HOUSE), FACILITY_MAP);
  assert.strictEqual(app.facilityTypeFor('pardes'), 'detox_dual');
  assert.strictEqual(app.facilityTypeFor('x'), '');
  assert.strictEqual(app.CREDIT_DAYS_DIVISOR, 30);
  assert.strictEqual(app.CREDIT_DETOX_TENURE_CUTOFF_DAYS, 14);
  assert.strictEqual(app.CREDIT_RESIDENTIAL_LAST_DAYS, 7);
});

test('the SAME discharge under both facility types gives different results: 20-day stay → residential pro-rata, detox_dual zero (discretionary)', () => {
  const { app } = loadApp();
  // entry Sep 1, exit Sep 21 (tenure 20, day 21 of 30 → outside the last-7 window); paid 9000 → dailyRate 300
  const res = app.suggestCredit(RES, '2026-09-21', [payFor(RES_KEY, { dueDate: '2026-09-01' })]);
  const dtx = app.suggestCredit(DTX, '2026-09-21', [payFor(DTX_KEY, { dueDate: '2026-09-01' })]);
  assert.strictEqual(res.basis.facilityType, 'residential');
  assert.strictEqual(dtx.basis.facilityType, 'detox_dual');
  assert.strictEqual(res.basis.tenureDays, 20);
  assert.strictEqual(dtx.basis.tenureDays, 20);
  assert.strictEqual(res.basis.classification, 'window_contains_exit');
  assert.strictEqual(res.basis.unusedDays, 9, 'Sep 22–30');
  assert.strictEqual(res.basis.dailyRate, 300);
  assert.strictEqual(res.calculatedAmount, 2700, 'residential: pro-rata at any tenure');
  assert.strictEqual(res.basis.rule, 'residential_prorata');
  assert.strictEqual(dtx.calculatedAmount, 0, 'detox_dual: tenure ≥ 14 → 0');
  assert.strictEqual(dtx.basis.rule, 'detox_tenure_cutoff_zero');
  assert.strictEqual(dtx.basis.discretionary, true);
  assert.strictEqual(dtx.basis.uncappedAmount, 2700, 'the figure the override may restore is on record');
  assert.notStrictEqual(res.calculatedAmount, dtx.calculatedAmount);
  // an unknown house falls back to the stricter (detox) policy and says so
  const unk = app.suggestCredit(Object.assign({}, RES, { houseId: 'nowhere' }), '2026-09-21', []);
  assert.strictEqual(unk.basis.facilityType, 'detox_dual');
  assert.strictEqual(unk.basis.facilityKnown, false);
});

test('detox_dual at 13, 14 and 15 days: pro-rata under 14, zero at 14 and 15 — row still suggested, override figure kept', () => {
  const { app } = loadApp();
  const payments = [payFor(DTX_KEY, { dueDate: '2026-09-01' })];
  const s13 = app.suggestCredit(DTX, '2026-09-14', payments);
  assert.strictEqual(s13.basis.tenureDays, 13);
  assert.strictEqual(s13.basis.eligible, true);
  assert.strictEqual(s13.basis.rule, 'detox_prorata');
  assert.strictEqual(s13.basis.windowDays, 30, 'Sep 1 → Sep 30 (D + 1 month − 1 day)');
  assert.strictEqual(s13.basis.unusedDays, 16, 'Sep 15–30 — strictly after the exit');
  assert.strictEqual(s13.calculatedAmount, 4800);   // 9000/30 × 16
  const s14 = app.suggestCredit(DTX, '2026-09-15', payments);
  assert.strictEqual(s14.basis.tenureDays, 14);
  assert.strictEqual(s14.basis.eligible, false);
  assert.strictEqual(s14.calculatedAmount, 0);
  assert.strictEqual(s14.basis.uncappedAmount, 4500);
  const s15 = app.suggestCredit(DTX, '2026-09-16', payments);
  assert.strictEqual(s15.basis.tenureDays, 15);
  assert.strictEqual(s15.calculatedAmount, 0);
  assert.strictEqual(s15.creditType, 'days_unused');
});

test('residential last-7-days window, inside and outside, in 28 / 30 / 31 day months (22–28 Feb, 24–30 Sep, 25–31 Aug)', () => {
  const { app } = loadApp();
  const run = (entry, exit) => { const sc = scenario('asher', entry, {}); return app.suggestCredit(sc.p, exit, sc.payments); };
  // February 2026 — 28 days: 21 outside, 22 inside
  const f21 = run('2026-02-01', '2026-02-21');
  assert.strictEqual(f21.basis.exitMonthDays, 28);
  assert.strictEqual(f21.basis.inLastDaysWindow, false);
  assert.strictEqual(f21.basis.rule, 'residential_prorata');
  assert.strictEqual(f21.basis.windowDays, 28);
  assert.strictEqual(f21.basis.unusedDays, 7);
  assert.strictEqual(f21.calculatedAmount, 2100);            // 9000/30 × 7
  const f22 = run('2026-02-01', '2026-02-22');
  assert.strictEqual(f22.basis.inLastDaysWindow, true);
  assert.strictEqual(f22.basis.rule, 'residential_last_days_zero');
  assert.strictEqual(f22.calculatedAmount, 0);
  assert.strictEqual(f22.basis.uncappedAmount, 1800, 'what it would have been is recorded');
  // September — 30 days: 23 outside, 24 inside
  const s23 = run('2026-09-01', '2026-09-23');
  assert.strictEqual(s23.basis.inLastDaysWindow, false);
  assert.strictEqual(s23.calculatedAmount, 2100);            // 30 − 23 = 7 → 9000/30 × 7
  const s24 = run('2026-09-01', '2026-09-24');
  assert.strictEqual(s24.basis.inLastDaysWindow, true);
  assert.strictEqual(s24.calculatedAmount, 0);
  assert.strictEqual(s24.basis.uncappedAmount, 1800);
  // August — 31 days: 24 outside, 25 inside
  const a24 = run('2026-08-01', '2026-08-24');
  assert.strictEqual(a24.basis.exitMonthDays, 31);
  assert.strictEqual(a24.basis.inLastDaysWindow, false);
  assert.strictEqual(a24.basis.windowDays, 31);
  assert.strictEqual(a24.calculatedAmount, 2100);            // 31 − 24 = 7 → 9000/30 × 7
  const a25 = run('2026-08-01', '2026-08-25');
  assert.strictEqual(a25.basis.inLastDaysWindow, true);
  assert.strictEqual(a25.calculatedAmount, 0);
  // the last-7 rule is about the EXIT's month, even when the row's allocationMonth differs (paid Jul 20 covers to Aug 19; exit Aug 25 after it)
  const cross = scenario('asher', '2026-07-20', {});
  const c = app.suggestCredit(cross.p, '2026-08-25', cross.payments);
  assert.strictEqual(c.allocationMonth, '2026-07', 'reporting metadata from the latest row');
  assert.strictEqual(c.basis.classification, 'no_unused_window');
  assert.strictEqual(c.basis.inLastDaysWindow, true);
  assert.strictEqual(c.calculatedAmount, 0);
});

test('divisor is 30 regardless of month length: identical daily rate in Feb, Sep and Aug; never the calendar day count', () => {
  const { app } = loadApp();
  ['2026-02-01', '2026-09-01', '2026-08-01'].forEach((entry) => {
    const sc = scenario('asher', entry, {});
    const s = app.suggestCredit(sc.p, entry.slice(0, 8) + '05', sc.payments);   // exit on the 5th: stayed 5
    assert.strictEqual(s.basis.divisor, 30);
    assert.strictEqual(s.basis.dailyRate, 300, entry);
    assert.strictEqual(s.calculatedAmount, 300 * s.basis.unusedDays, entry);
  });
  const feb = scenario('asher', '2026-02-01', {}); const f = app.suggestCredit(feb.p, '2026-02-05', feb.payments);
  const aug = scenario('asher', '2026-08-01', {}); const a = app.suggestCredit(aug.p, '2026-08-05', aug.payments);
  assert.strictEqual(f.basis.unusedDays, 23); assert.strictEqual(f.calculatedAmount, 6900);   // 28-day window
  assert.strictEqual(a.basis.unusedDays, 26); assert.strictEqual(a.calculatedAmount, 7800);   // 31-day window
  assert.notStrictEqual(Math.round(9000 / 28 * 100) / 100, f.basis.dailyRate, 'not 9000/28');
  assert.notStrictEqual(Math.round(9000 / 31 * 100) / 100, a.basis.dailyRate, 'not 9000/31');
});

test('prepaid_return fires regardless of the rules: tenure 40 (detox zero) AND residential inside the last-7 window both return every later billed month, amountPaid only', () => {
  const { app } = loadApp();
  const dtx = scenario('rehab', '2026-08-01', {});
  dtx.payments.push(payFor(dtx.key, { dueDate: '2026-09-01' }), payFor(dtx.key, { dueDate: '2026-10-01' }),
                    payFor(dtx.key, { dueDate: '2026-11-01', amount: 9000, amountPaid: 4500, status: 'partial' }));
  const all = app.suggestCredits(dtx.p, '2026-09-10', dtx.payments);   // tenure 40
  assert.strictEqual(all[0].creditType, 'days_unused');
  assert.strictEqual(all[0].basis.tenureDays, 40);
  assert.strictEqual(all[0].calculatedAmount, 0);
  assert.strictEqual(all[0].allocationMonth, '2026-09', 'the row whose window contains the exit (Aug 1–31 is fully used and silent)');
  assert.strictEqual(all[0].basis.uncappedAmount, 6000, '9000/30 × 20 unused days — on record for the override');
  assert.deepStrictEqual(plain(all.slice(1).map((s) => [s.creditType, s.allocationMonth, s.calculatedAmount])), [
    ['prepaid_return', '2026-10', 9000],
    ['prepaid_return', '2026-11', 4500],
  ]);
  assert.strictEqual(all[2].basis.billedAmount, 9000, 'billed figure kept in basis');
  assert.strictEqual(all[2].basis.fullReturn, true);
  assert.strictEqual(all[2].basis.unusedDays, 30, 'Nov 1–30, the whole window');
  // residential, exit Sep 27 (inside the window → days_unused 0) with October prepaid
  const res = scenario('ramot', '2026-09-01', {});
  res.payments.push(payFor(res.key, { dueDate: '2026-10-01' }));
  const r = app.suggestCredits(res.p, '2026-09-27', res.payments);
  assert.strictEqual(r[0].calculatedAmount, 0);
  assert.strictEqual(r[0].basis.rule, 'residential_last_days_zero');
  assert.deepStrictEqual(plain(r.slice(1).map((s) => [s.creditType, s.allocationMonth, s.calculatedAmount])), [['prepaid_return', '2026-10', 9000]]);
  // classification is by the WINDOW: a same-month row whose window starts after the exit is prepaid_return
  const same = app.suggestCredits(res.p, '2026-09-10', [payFor(res.key, { dueDate: '2026-09-01' }), payFor(res.key, { dueDate: '2026-09-25' })]);
  assert.deepStrictEqual(plain(same.map((s) => [s.creditType, s.allocationMonth, s.calculatedAmount])), [['days_unused', '2026-09', 6000], ['prepaid_return', '2026-09', 9000]]);
  assert.strictEqual(same[1].basis.classification, 'window_after_exit');
});

test('exitDate arrives as a raw ISO timestamp: month boundary + DST (March and October) — no −1 day drift, tenure exact', () => {
  const { app } = loadApp();
  // 2026-08-31T21:00Z is 2026-09-01 00:00 Israel (UTC+3). A naive slice says Aug 31 (→ inside the Aug last-7 window!).
  const sc = scenario('asher', '2026-09-01', {});
  const bnd = app.suggestCredit(sc.p, '2026-08-31T21:00:00.000Z', sc.payments);
  assert.strictEqual(bnd.basis.exitDate, '2026-09-01');
  assert.notStrictEqual(bnd.basis.exitDate, '2026-08-31T21:00:00.000Z'.slice(0, 10));
  assert.strictEqual(bnd.basis.inLastDaysWindow, false, 'Sep 1, not Aug 31');
  assert.strictEqual(bnd.basis.tenureDays, 0);
  assert.strictEqual(bnd.basis.unusedDays, 29, 'Sep 2–30');
  assert.strictEqual(bnd.allocationMonth, '2026-09');
  assert.strictEqual(bnd.calculatedAmount, 8700);   // 29 × 300

  // Israel DST starts 2026-03-27 02:00. Entry Mar 20 (paid 9300), exit at Israel midnight Apr 1.
  const mar = scenario('rehab', '2026-03-20', { amount: 9300, amountPaid: 9300 });
  const m = app.suggestCredit(mar.p, '2026-03-31T21:00:00.000Z', mar.payments);
  assert.strictEqual(m.basis.exitDate, '2026-04-01');
  assert.strictEqual(m.basis.tenureDays, 12, 'Mar 20 → Apr 1 across the DST switch is exactly 12 days');
  assert.strictEqual(m.allocationMonth, '2026-03');
  assert.strictEqual(m.basis.coverageStart, '2026-03-20');
  assert.strictEqual(m.basis.coverageEnd, '2026-04-19');
  assert.strictEqual(m.basis.windowDays, 31);
  assert.strictEqual(m.basis.unusedDays, 18, 'Apr 2 → Apr 19');
  assert.strictEqual(m.basis.creditedFrom, '2026-04-02');
  assert.strictEqual(m.basis.dailyRate, 310);
  assert.strictEqual(m.calculatedAmount, 5580);

  // Israel DST ends 2026-10-25 02:00. Exit at Israel midnight Nov 1 (UTC+2 → 22:00Z).
  const oct = scenario('rehab', '2026-10-20', {});
  const o = app.suggestCredit(oct.p, '2026-10-31T22:00:00.000Z', oct.payments);
  assert.strictEqual(o.basis.exitDate, '2026-11-01');
  assert.strictEqual(o.basis.tenureDays, 12);
  assert.strictEqual(o.basis.unusedDays, 18, 'Nov 2 → Nov 19');

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

test('cap at money received: the rate is built from amountPaid (partial 3000 of 9000 → 100/day), and an uncapped figure above amountPaid is capped with the figure visible in basis + trail', () => {
  const { app } = loadApp();
  // partial: rate follows what was RECEIVED, never the billed 9000
  const sc = scenario('asher', '2026-09-01', { amountPaid: 3000, status: 'partial', balance: 6000 });
  const s = app.suggestCredit(sc.p, '2026-09-06', sc.payments);
  assert.strictEqual(s.basis.amountPaid, 3000);
  assert.strictEqual(s.basis.dailyRate, 100);
  assert.strictEqual(s.basis.unusedDays, 24);
  assert.strictEqual(s.calculatedAmount, 2400);
  assert.ok(s.calculatedAmount <= 3000);
  // the cap itself (pure)
  assert.deepStrictEqual(plain(app.applyCreditCap(7200, 3000)), { calculatedAmount: 3000, capped: true });
  assert.deepStrictEqual(plain(app.applyCreditCap(2400, 3000)), { calculatedAmount: 2400, capped: false });
  // a 31-day window entirely after the exit: raw 3000/30 × 31 = 3100 exceeds the 3000 received → the row's
  // amountPaid is the ceiling (prepaid_return is a full return of what was paid, never more)
  const fut = scenario('asher', '2026-07-01', {});
  fut.payments.push(payFor(fut.key, { dueDate: '2026-08-01', amount: 9000, amountPaid: 3000, status: 'partial' }));
  const x = app.suggestCredits(fut.p, '2026-07-20', fut.payments).find((c) => c.creditType === 'prepaid_return');
  assert.strictEqual(x.basis.windowDays, 31);
  assert.strictEqual(x.basis.unusedDays, 31);
  assert.strictEqual(x.basis.uncappedAmount, 3100, '31 × 100 exceeds the 3000 received');
  assert.strictEqual(x.basis.capped, true);
  assert.strictEqual(x.calculatedAmount, 3000, 'never more than was received');
  // days_unused (window starts on/before the exit) can never exceed 30 unused days, so raw ≤ amountPaid there.
  const text = app.creditBasisText('days_unused', s.basis);
  assert.ok(text.includes('2400') && text.includes('3000'), text);
});

test('amountPaid 0 (row exists, unpaid) → dailyRate 0, calculatedAmount 0, suggestion still emitted', () => {
  const { app } = loadApp();
  const sc = scenario('asher', '2026-09-01', { amountPaid: 0, status: 'unpaid', balance: 9000 });
  const all = app.suggestCredits(sc.p, '2026-09-06', sc.payments);
  assert.strictEqual(all.length, 1);
  assert.strictEqual(all[0].calculatedAmount, 0);
  assert.strictEqual(all[0].basis.amountPaid, 0);
  assert.strictEqual(all[0].basis.dailyRate, 0);
  assert.strictEqual(all[0].basis.uncappedAmount, 0);
  assert.strictEqual(all[0].basis.classification, 'window_contains_exit');
  assert.strictEqual(all[0].basis.unusedDays, 24);
  assert.strictEqual(all[0].basis.eligible, true, 'residential, outside the window — the rule allowed it; the money did not');
  assert.strictEqual(app.validateCreditLine({ creditType: 'days_unused', allocationMonth: '2026-09', calculatedAmount: 0, amount: 0 }), null, 'a zero credit is saveable');
});

test('no payment row for the month at all → full calendar month fallback, nothing received → 0 (row still suggested); other patients never leak in', () => {
  const { app } = loadApp();
  const s = app.suggestCredit(RES, '2026-09-10', []);
  assert.strictEqual(s.allocationMonth, '2026-09');
  assert.strictEqual(s.basis.classification, 'no_unused_window');
  assert.strictEqual(s.basis.coverageSource, 'calendar_month');
  assert.strictEqual(s.basis.coverageStart, '2026-09-01');
  assert.strictEqual(s.basis.coverageEnd, '2026-09-30');
  assert.strictEqual(s.basis.windowDays, 30);
  assert.strictEqual(s.basis.unusedDays, 20);
  assert.strictEqual(s.basis.amountPaid, 0);
  assert.strictEqual(s.calculatedAmount, 0);
  const s2 = app.suggestCredit(RES, '2026-09-10', [payFor('asher::אחר::2026-09-01', { dueDate: '2026-09-01' })]);
  assert.strictEqual(s2.basis.classification, 'no_unused_window');
  assert.strictEqual(s2.calculatedAmount, 0);
  assert.deepStrictEqual(plain(app.suggestCredits(RES, '', [])), [], 'no exit date → nothing to compute');
});

test('billing day 20, exit on the 5th of the following month: the spillover days (6th → 19th) are credited and classified days_unused; allocationMonth is the row month', () => {
  const { app } = loadApp();
  const sc = scenario('asher', '2026-08-20', {});                 // paid Aug 20 → window Aug 20 … Sep 19
  const all = app.suggestCredits(sc.p, '2026-09-05', sc.payments);
  assert.strictEqual(all.length, 1);
  const s = all[0];
  assert.strictEqual(s.creditType, 'days_unused');
  assert.strictEqual(s.basis.classification, 'window_contains_exit');
  assert.strictEqual(s.basis.coverageStart, '2026-08-20');
  assert.strictEqual(s.basis.coverageEnd, '2026-09-19');
  assert.strictEqual(s.basis.creditedFrom, '2026-09-06');
  assert.strictEqual(s.basis.unusedDays, 14);
  assert.strictEqual(s.basis.dailyRate, 300);
  assert.strictEqual(s.calculatedAmount, 4200);
  assert.strictEqual(s.allocationMonth, '2026-08', 'monthKey(dueDate) — reporting only; the September days are credited regardless');
  // detox_dual with the same dates: tenure 16 → discretionary zero, same figure on record
  const d = scenario('rehab', '2026-08-20', {});
  const dz = app.suggestCredit(d.p, '2026-09-05', d.payments);
  assert.strictEqual(dz.basis.tenureDays, 16);
  assert.strictEqual(dz.calculatedAmount, 0);
  assert.strictEqual(dz.basis.uncappedAmount, 4200);
});

test('billing day 20, exit BEFORE the window starts: the row is prepaid_return in full — even though its month key equals the exit month', () => {
  const { app } = loadApp();
  const sc = scenario('asher', '2026-08-20', {});                 // Aug 20 row: window Aug 20 … Sep 19 (contains the exit)
  sc.payments.push(payFor(sc.key, { dueDate: '2026-09-20' }));   // Sep 20 row: window Sep 20 … Oct 19 (starts after the exit)
  const all = app.suggestCredits(sc.p, '2026-09-05', sc.payments);
  assert.deepStrictEqual(plain(all.map((s) => [s.creditType, s.allocationMonth, s.calculatedAmount])), [
    ['days_unused', '2026-08', 4200],
    ['prepaid_return', '2026-09', 9000],
  ]);
  assert.strictEqual(all[1].basis.classification, 'window_after_exit');
  assert.strictEqual(all[1].basis.coverageStart, '2026-09-20');
  assert.strictEqual(all[1].basis.unusedDays, 30);
  assert.strictEqual(all[1].basis.fullReturn, true);
  // exempt from the residential last-7 rule: exit Sep 27 zeroes days_unused, the prepaid row still returns
  const late = app.suggestCredits(sc.p, '2026-09-27', [payFor(sc.key, { dueDate: '2026-09-28' })]);
  assert.deepStrictEqual(plain(late.map((s) => [s.creditType, s.calculatedAmount])), [['days_unused', 0], ['prepaid_return', 9000]]);
});

test('two payment rows with overlapping windows never credit the same day twice', () => {
  const { app } = loadApp();
  const sc = scenario('asher', '2026-08-20', {});                 // window Aug 20 … Sep 19
  sc.payments.push(payFor(sc.key, { dueDate: '2026-09-01' }));   // window Sep 1 … Sep 30 — overlaps Sep 1–19
  const all = app.suggestCredits(sc.p, '2026-09-05', sc.payments);
  assert.strictEqual(all.length, 2);
  assert.strictEqual(all[0].basis.paymentDueDate, '2026-08-20');
  assert.strictEqual(all[0].basis.creditedFrom, '2026-09-06');
  assert.strictEqual(all[0].basis.unusedDays, 14, 'Sep 6 → Sep 19');
  assert.strictEqual(all[0].calculatedAmount, 4200);
  assert.strictEqual(all[1].basis.paymentDueDate, '2026-09-01');
  assert.strictEqual(all[1].basis.alreadyCreditedThrough, '2026-09-19');
  assert.strictEqual(all[1].basis.creditedFrom, '2026-09-20', 'resumes the day after the first window ended');
  assert.strictEqual(all[1].basis.unusedDays, 11, 'Sep 20 → Sep 30 only — Sep 6–19 not counted again');
  assert.strictEqual(all[1].calculatedAmount, 3300);
  const totalDays = all.reduce((n, s) => n + s.basis.unusedDays, 0);
  assert.strictEqual(totalDays, 25, 'Sep 6 → Sep 30 = 25 distinct days');
  // a second overlapping window with nothing left to credit is a zero row, not a duplicate credit
  const three = app.suggestCredits(sc.p, '2026-09-05', sc.payments.concat([payFor(sc.key, { dueDate: '2026-09-02', amount: 9000, amountPaid: 9000 })]));
  const sep2 = three.find((s) => s.basis.paymentDueDate === '2026-09-02');
  assert.strictEqual(sep2.creditType, 'days_unused');
  assert.strictEqual(sep2.basis.unusedDays, 1, 'Oct 1 only — everything through Sep 30 was credited by earlier windows');
  assert.strictEqual(three.reduce((n, s) => n + s.basis.unusedDays, 0), 26);
});

test('payoutDateFor (client mirror): 14th → 15th same month, 15th → 15th same month, 16th → 15th next month; pendingCreditsByPayout groups + totals', () => {
  const { app } = loadApp();
  assert.strictEqual(app.payoutDateFor('2026-09-14'), '2026-09-15');
  assert.strictEqual(app.payoutDateFor('2026-09-15'), '2026-09-15');
  assert.strictEqual(app.payoutDateFor('2026-09-16'), '2026-10-15');
  assert.strictEqual(app.payoutDateFor('2026-12-31'), '2027-01-15');
  const credits = [
    { id: 'a', status: 'pending', payoutDate: '2026-10-15', amount: 2400 },
    { id: 'b', status: 'pending', payoutDate: '2026-09-15', amount: 100.5 },
    { id: 'c', status: 'paid',    payoutDate: '2026-09-15', amount: 9999 },
    { id: 'd', status: 'pending', payoutDate: '2026-09-15', amount: 0 },
    { id: 'e', status: 'cancelled', payoutDate: '2026-10-15', amount: 500 },
  ];
  const groups = plain(app.pendingCreditsByPayout(credits));
  assert.deepStrictEqual(groups.map((g) => [g.payoutDate, g.total, g.credits.map((c) => c.id)]), [
    ['2026-09-15', 100.5, ['b', 'd']],
    ['2026-10-15', 2400, ['a']],
  ]);
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
  // marking paid is explicit: paidDate AND method
  assert.match(app.validateCreditLine(Object.assign({}, base, { status: 'paid' })), /שולם/);
  assert.match(app.validateCreditLine(Object.assign({}, base, { status: 'paid', paidDate: '2026-09-15' })), /שולם/);
  assert.strictEqual(app.validateCreditLine(Object.assign({}, base, { status: 'paid', paidDate: '2026-09-15', method: 'העברה' })), null);
  assert.match(app.validateCreditLine(Object.assign({}, base, { decidedDate: '15/09/2026' })), /החלטה/);
});

test('normalizeCredit round-trips patientId AND patientKey intact (distinct, neither derived); creditsForPatient joins on either key; buildCreditLines never proposes a duplicate', () => {
  const { app } = loadApp();
  const raw = { id: 'credit::id-dana-1::2026-09::1', patientId: 'id-dana-1', patientKey: KEY, patientName: 'דנה', houseId: 'ramot',
    creditType: 'days_unused', allocationMonth: '2026-09', calculatedAmount: '4800', amount: '4000', overrideReason: 'x', reason: 'trail',
    approvedBy: '', decidedDate: '2026-09-14', payoutDate: '2026-09-15', status: 'pending', paidDate: '', method: '', notes: '', facilityType: 'residential',
    basis: '{"rule":"residential_prorata","uncappedAmount":4800}', createdAt: 'T1', createdBy: 'ורד', updatedAt: 'T2', updatedBy: 'ורד' };
  const c = app.normalizeCredit(raw);
  assert.strictEqual(c.facilityType, 'residential');
  assert.strictEqual(c.payoutDate, '2026-09-15');
  assert.deepStrictEqual(plain(c.basis), { rule: 'residential_prorata', uncappedAmount: 4800 });
  assert.strictEqual(app.normalizeCredit(Object.assign({}, raw, { basis: 'not json' })).basis, null);
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
  const lines = app.buildCreditLines([c], app.suggestCredits(PATIENT, '2026-09-14', [pay({ dueDate: '2026-09-01' }), pay({ dueDate: '2026-10-01' })]), '2026-09-16');
  assert.deepStrictEqual(plain(lines.map((l) => [l.creditType, l.allocationMonth, l.isNew])), [
    ['days_unused', '2026-09', false],
    ['prepaid_return', '2026-10', true],
  ]);
  assert.strictEqual(lines[0].calculatedAmount, 4800);
  assert.strictEqual(lines[1].decidedDate, '2026-09-16');
  assert.strictEqual(lines[1].payoutDate, '2026-10-15', 'new lines carry the derived payout date');
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
