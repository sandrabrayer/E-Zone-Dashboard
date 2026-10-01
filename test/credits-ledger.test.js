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
 *     derives payoutDate from decidedDate (refundPayoutDate_: decided on the
 *     1st–10th → that month's 15th, later → next month's 15th), stamps
 *     createdAt/By + updatedAt/By from the signed-cookie user, keeps
 *     calculatedAmount/basis/creation stamps immutable on edit, and refuses a
 *     stale edit (differing updatedAt) with `conflicts`;
 *   - the refund RULES are server-only since the wiring PR: suggestions come
 *     from suggestRefunds → computeRefund_ and are tested in
 *     test/refund-logic-wiring.test.js (this file no longer holds them);
 *   - payoutDateFor (display echo): 10th → same-month 15th, 11th → next
 *     month's 15th;
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
  sandbox.LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock: noop }) };
  sandbox.globalThis = sandbox;
  const epilogue = `globalThis.__test = {
    CREDIT_COLUMNS, CREDITS_SHEET, CREDIT_TYPES, CREDIT_STATUSES, CREDIT_EDITABLE_COLUMNS, CREDIT_TEXT_COLUMNS, FACILITY_TYPE_BY_HOUSE,
    AUDIT_LOG_COLUMNS, AUDIT_LOG_SHEET, PATIENT_COLUMNS,
    readSheet: (sh, cols) => readSheet_(sh, cols),
    handle: (params) => handle_(params).json,
    ensure: (name, cols) => getOrCreateSheet_(name, cols),
    upsert: (c, u) => upsertCredit_(c, u),
    creditId: (p, m, s) => creditId_(p, m, s),
    payoutDateFor: (d) => refundPayoutDate_(d),
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

/* APPEND-ONLY: `creditUid` was appended at the END for the accounting
 * source-feed contract (CHANGELOG-accounting-source-feed.md). The 24 original
 * columns keep their exact positions — readSheet_ maps by position. */
const EXPECTED_COLUMNS = [
  'id', 'patientId', 'patientKey', 'patientName', 'houseId', 'facilityType', 'creditType',
  'allocationMonth', 'calculatedAmount', 'amount', 'overrideReason', 'reason',
  'approvedBy', 'decidedDate', 'payoutDate', 'status', 'paidDate', 'method', 'notes',
  'basis', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy',
  'creditUid',
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

test('CREDIT_COLUMNS order is PINNED — the original 24 unmoved, creditUid appended; facility map covers the six house ids', () => {
  const { code } = loadCode();
  assert.deepStrictEqual(arr(code.CREDIT_COLUMNS), EXPECTED_COLUMNS);
  assert.deepStrictEqual(arr(code.CREDIT_COLUMNS).slice(0, 24), EXPECTED_COLUMNS.slice(0, 24),
    'position IS the data contract — the original 24 are untouched');
  assert.strictEqual(code.CREDIT_COLUMNS.length, 25);
  assert.strictEqual(code.CREDIT_COLUMNS[24], 'creditUid');
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
  assert.strictEqual(r1.credit.payoutDate, '2026-10-15', 'decided on the 14th (after the 10th) → the 15th of the next month');
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
  assert.strictEqual(d.payoutDate, '2026-10-15');
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

test('refundPayoutDate_ drives payoutDate: 10th → same-month 15th, 11th / 14th / 15th / 16th → next month; year wrap; facilityType forged in the payload is ignored', () => {
  const { code } = loadCode();
  assert.strictEqual(code.payoutDateFor('2026-09-10'), '2026-09-15');
  assert.strictEqual(code.payoutDateFor('2026-09-11'), '2026-10-15');
  assert.strictEqual(code.payoutDateFor('2026-09-14'), '2026-10-15');
  assert.strictEqual(code.payoutDateFor('2026-09-15'), '2026-10-15');
  assert.strictEqual(code.payoutDateFor('2026-09-16'), '2026-10-15');
  assert.strictEqual(code.payoutDateFor('2026-12-20'), '2027-01-15');
  assert.strictEqual(code.payoutDateFor('2026-01-01'), '2026-01-15');
  assert.throws(() => code.payoutDateFor(''), (e) => e.code === 'bad_date');
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
  assert.strictEqual(r.payoutDate, '2026-10-15', 'derived, the forged payload value is ignored');
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
      validateCreditLine, creditBasisText, buildCreditLines,
      creditsForPatient, creditId, paymentCoverage, addMonthsClamped, localDateFromISO, diffWholeDays, isoDate, exVat,
      patientKey, saveCredit, dischargePatient, payoutDateFor, facilityTypeFor, pendingCreditsByPayout,
      FACILITY_TYPE_BY_HOUSE, CREDIT_DECISION_CUTOFF_DAY,
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

/* ===== D. client side of the rules =====
 * The refund RULES moved to the server (suggestRefunds → computeRefund_) in
 * the wiring PR; their tests live in test/refund-logic-wiring.test.js. What
 * stays here: the facility map the modal header labels with, and the payout
 * echo the modal shows while the decision date is edited. */

test('facility map mirrors Code.gs: asher/ramot residential, rehab/pardes/arfoni/sde detox_dual; no client copy of the refund rules', () => {
  const { app } = loadApp();
  assert.deepStrictEqual(plain(app.FACILITY_TYPE_BY_HOUSE), FACILITY_MAP);
  assert.strictEqual(app.facilityTypeFor('pardes'), 'detox_dual');
  assert.strictEqual(app.facilityTypeFor('x'), '');
  assert.strictEqual(app.CREDIT_DECISION_CUTOFF_DAY, 10);
  assert.ok(!/function suggestCredits?\(|CREDIT_DAYS_DIVISOR|CREDIT_RESIDENTIAL_LAST_DAYS|CREDIT_DETOX_TENURE_CUTOFF_DAYS|function applyCreditCap/.test(APP_SRC),
    'the old-rule calculation is gone from app.js');
});

test('payoutDateFor (display echo of refundPayoutDate_): 10th → 15th same month, 11th → 15th next month; pendingCreditsByPayout groups + totals', () => {
  const { app } = loadApp();
  assert.strictEqual(app.payoutDateFor('2026-09-10'), '2026-09-15');
  assert.strictEqual(app.payoutDateFor('2026-09-11'), '2026-10-15');
  assert.strictEqual(app.payoutDateFor('2026-09-15'), '2026-10-15');
  assert.strictEqual(app.payoutDateFor('2026-12-31'), '2027-01-15');
  assert.strictEqual(app.payoutDateFor(''), '');
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
  // Server-shaped suggestions (suggestRefunds): one for the saved month, one new.
  const suggestions = [
    { creditType: 'days_unused', allocationMonth: '2026-09', calculatedAmount: 5200, basis: { basisVersion: 2, rule: 'residential_prorata' } },
    { creditType: 'prepaid_return', allocationMonth: '2026-10', calculatedAmount: 9000, basis: { basisVersion: 2, rule: 'prepaid_return' } },
  ];
  const lines = app.buildCreditLines([c], suggestions, '2026-09-16');
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
