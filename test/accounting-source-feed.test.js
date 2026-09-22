/* Accounting source feed — stable payment identity, a server-side charge
 * stamp, and a read-only endpoint an external accounting-control app pulls.
 *
 * THE PROBLEM THIS CLOSES. An accounting app has to be able to say "this
 * source payment is the one I already checked against the bank". The Payments
 * `id` cannot answer that: it is pay::<houseId>::<name>::<entryDate>::<dueDate>,
 * so correcting a patient's name or re-dating a cycle produces a DIFFERENT id
 * for the same money. And nothing on the row said who reported it paid, or
 * when — only a client-stamped `timestamp` that moves on every save.
 *
 * Locked contracts:
 *   - PAYMENT_COLUMNS gains seven columns AT THE END; the twelve before them
 *     keep their positions (readSheet_ maps by position). CREDIT_COLUMNS gains
 *     creditUid at the END. The `id` schemes are UNCHANGED — billing
 *     overrides, the reconcile and the client all still key on them;
 *   - paymentUid is MINTED ONCE and then permanent: never re-derived on read,
 *     never re-minted, never disturbed by a name / date / amount / status
 *     change. Backfilled under the script lock, idempotent, ZERO writes and NO
 *     lock in the steady state (the backfillPatientIdsLocked_ pattern);
 *   - patientUid is the PERSISTED Patients `id`, resolved by an EXACT match of
 *     the billing triple — never a name lookup; unresolved stays BLANK;
 *   - payerUid is reserved and always null: Dashboard has no payer entity;
 *   - chargedAt / chargedBy are SERVER-owned, Israel time with an explicit
 *     offset, from the SIGNED SESSION COOKIE, stamped when a row is reported
 *     paid/partial and RE-stamped when amountPaid moves. Historical rows stay
 *     BLANK — no stamp is ever derived. Reads never stamp;
 *   - the endpoint is READ-ONLY behind its OWN least-privilege secret,
 *     fail-closed, paginated, incremental, and returns NO clinical data.
 *
 * TZ pinned to Asia/Jerusalem so the offset assertions mean what they say.
 * vm-sandbox on the REAL shipped Code.gs, per repo convention.
 */

process.env.TZ = 'Asia/Jerusalem';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const GS_SRC = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

const arr = (x) => Array.from(x);

/* ================= harness ================= */

let opSeq = 0;
function fakeSheet(headerRow, dataRows) {
  const grid = [headerRow.slice()].concat((dataRows || []).map((r) => r.slice()));
  const ops = [];
  return {
    grid, ops,
    getLastRow() { return grid.length; },
    getLastColumn() { return grid[0] ? grid[0].length : 0; },
    getMaxRows() { return Math.max(grid.length, 1000); },
    setFrozenRows() {},
    hideSheet() {}, isSheetHidden() { return false; },
    appendRow(row) { ops.push({ op: 'append', seq: ++opSeq }); grid.push(row.slice()); },
    deleteRow(r) { ops.push({ op: 'delete', seq: ++opSeq, r }); grid.splice(r - 1, 1); },
    getRange(r, c, nr, nc) {
      nr = nr || 1; nc = nc || 1;
      return {
        setNumberFormat(fmt) { ops.push({ op: 'fmt', seq: ++opSeq, r, c, nr, nc, fmt }); },
        getValue() { const g = grid[r - 1]; return g ? (g[c - 1] === undefined ? '' : g[c - 1]) : ''; },
        setValue(v) {
          ops.push({ op: 'setcell', seq: ++opSeq, r, c });
          if (!grid[r - 1]) grid[r - 1] = [];
          grid[r - 1][c - 1] = v;
        },
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
        clearContent() { ops.push({ op: 'clear', seq: ++opSeq, r, c, nr, nc }); },
      };
    },
  };
}
const writeOps = (sh) => sh.ops.filter((o) => o.op !== 'fmt');

/* Apps Script's Utilities.formatDate is Java SimpleDateFormat; the two
 * patterns Code.gs actually uses are reproduced here against the process TZ
 * (pinned to Asia/Jerusalem above), so "XXX" really yields +02:00 / +03:00. */
function fakeFormatDate(d, _tz, pattern) {
  const p = (n) => String(n).padStart(2, '0');
  if (pattern === 'yyyy-MM-dd') return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  if (pattern === 'yyyy-MM') return `${d.getFullYear()}-${p(d.getMonth() + 1)}`;
  if (pattern === 'HH:mm') return `${p(d.getHours())}:${p(d.getMinutes())}`;
  const offMin = -d.getTimezoneOffset();
  const sign = offMin >= 0 ? '+' : '-';
  // SimpleDateFormat's 'Z' token: RFC-822, no colon. Code.gs inserts it.
  const off = sign + p(Math.floor(Math.abs(offMin) / 60)) + p(Math.abs(offMin) % 60);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${off}`;
}

function loadCode(opts) {
  opts = opts || {};
  const noop = () => {};
  let nowMs = Date.parse(opts.now || '2026-09-22T10:00:00+03:00');
  class FakeDate extends Date {
    constructor(...a) { if (a.length === 0) super(nowMs); else super(...a); }
    static now() { return nowMs; }
  }
  FakeDate.parse = Date.parse;
  FakeDate.UTC = Date.UTC;

  let uuidSeq = 0;
  const props = Object.assign({}, opts.props || {});
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    JSON, Math, Date: FakeDate, Number, String, Array, Object, RegExp, Set,
    isNaN, isFinite, parseInt, parseFloat,
    Logger: { log: noop },
    __sheets: {},
    __lockCalls: 0,
  };
  sandbox.SpreadsheetApp = {
    getActiveSpreadsheet: () => ({
      getSheetByName: (name) => sandbox.__sheets[name] || null,
      insertSheet: (name) => (sandbox.__sheets[name] = fakeSheet([], [])),
      getSpreadsheetTimeZone: () => 'Asia/Jerusalem',
    }),
  };
  sandbox.PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (k) => (k in props ? props[k] : null),
      setProperty(k, v) { props[k] = v; return this; },
    }),
  };
  sandbox.ContentService = {
    createTextOutput: (s) => ({ setMimeType: () => ({ json: JSON.parse(s), text: s }) }),
    MimeType: { JSON: 'json' },
  };
  sandbox.Utilities = {
    getUuid: () => 'u' + (++uuidSeq),
    formatDate: fakeFormatDate,
  };
  sandbox.LockService = {
    getScriptLock: () => ({
      tryLock() { sandbox.__lockCalls++; return true; },
      releaseLock: noop,
    }),
  };
  sandbox.globalThis = sandbox;
  const epilogue = `globalThis.__test = {
    PAYMENT_COLUMNS, PAYMENT_SERVER_COLUMNS, PAYMENT_VERSION_IGNORED_COLUMNS,
    PAYMENT_TEXT_COLUMNS, PAYMENT_CHARGED_STATUSES,
    CREDIT_COLUMNS, PAYMENTS_SHEET, CREDITS_SHEET, PATIENTS_SHEET, PATIENT_COLUMNS,
    PAYMENTS_TOMBSTONES_SHEET, PAYMENT_TOMBSTONE_COLUMNS,
    ACCOUNTING_SECRET_PROP, ACCOUNTING_PAGE_MAX, ACCOUNTING_SOURCE_APP,
    handle: (p) => handle_(p).json,
    ensure: (n, c) => getOrCreateSheet_(n, c),
    readSheet: (sh, c) => readSheet_(sh, c),
    upsert: (p, u) => upsertPayment_(p, u),
    stampRow: (p, prev, had, user, now) => stampPaymentRow_(p, prev, had, user, now),
    backfillPaymentIdentity: (sh) => backfillPaymentIdentityLocked_(sh),
    backfillMissingUids: (sh, c, col, pre, max) => backfillMissingUids_(sh, c, col, pre, max),
    IDENTITY_BACKFILL_MAX_PER_RUN,
    backfillCreditUids: (sh) => backfillCreditUidsLocked_(sh),
    israelTimestamp: (d) => israelTimestamp_(d),
    paymentStatus: (s) => paymentStatus_(s),
    coverage: (r) => accountingCoverage_(r),
    allocation: (c, a, ap) => accountingAllocation_(c, a, ap),
    appendPaymentTombstones: (e, r, f) => appendPaymentTombstones_(e, r, f),
    objectToRow: (o, c) => objectToRow_(o, c),
  };`;
  vm.createContext(sandbox);
  vm.runInContext(GS_SRC + epilogue, sandbox);
  return {
    code: sandbox.__test,
    sandbox,
    props,
    clock: { set: (iso) => { nowMs = Date.parse(iso); }, advance: (ms) => { nowMs += ms; } },
  };
}

function seedSheet(sandbox, code, name, columns, rows) {
  const cols = arr(columns);
  const sh = fakeSheet(cols, (rows || []).map((r) => code.objectToRow(r, cols)));
  sandbox.__sheets[name] = sh;
  return sh;
}

/** Extract one `function NAME(...) { ... }` body out of a source string. */
function fnSource(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'function not found: ' + name);
  let depth = 0;
  let i = src.indexOf('{', start);
  const from = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (!depth) return src.slice(from, i + 1); }
  }
  throw new Error('unbalanced braces in ' + name);
}

/* ================= fixtures ================= */

const SECRET = 's3cr3t-accounting';
const DANA = 'דנה כהן';
const KEY  = 'arfoni::' + DANA + '::2025-06-20';
const PAT  = { houseId: 'arfoni', name: DANA, date: '2025-06-20', pay: 3000, status: 'active', id: 'id-dana' };

function payRow(over) {
  const dueDate = (over && over.dueDate) || '2026-01-20';
  return Object.assign({
    id: 'pay::' + KEY + '::' + dueDate,
    patientId: KEY, patientName: DANA, houseId: 'arfoni',
    dueDate, amount: 3000, status: 'unpaid', amountPaid: 0, balance: 3000,
    timestamp: '2026-01-20T08:00:00.000Z',
    coverageStart: '', coverageEnd: '',
  }, over || {});
}

/* A world with the Patients sheet seeded so the triple resolves. */
function world(opts) {
  opts = opts || {};
  const h = loadCode(opts);
  seedSheet(h.sandbox, h.code, h.code.PATIENTS_SHEET, h.code.PATIENT_COLUMNS,
    opts.patients || [PAT]);
  seedSheet(h.sandbox, h.code, h.code.PAYMENTS_SHEET, h.code.PAYMENT_COLUMNS,
    opts.payments || []);
  seedSheet(h.sandbox, h.code, h.code.CREDITS_SHEET, h.code.CREDIT_COLUMNS,
    opts.credits || []);
  return h;
}

const authed = (code, extra) => code.handle(Object.assign(
  { action: 'accountingPayments', secret: SECRET }, extra || {}));

/* ================= A. schema is APPEND-ONLY ================= */

test('A: PAYMENT_COLUMNS appends seven accounting columns and moves nothing', () => {
  const { code } = loadCode();
  const cols = arr(code.PAYMENT_COLUMNS);
  assert.deepEqual(cols.slice(0, 12), [
    'id', 'patientId', 'patientName', 'houseId', 'dueDate',
    'amount', 'status', 'amountPaid', 'balance', 'timestamp',
    'coverageStart', 'coverageEnd',
  ], 'position IS the data contract — every pre-existing column is unmoved');
  assert.deepEqual(cols.slice(12), [
    'paymentUid', 'patientUid', 'payerUid',
    'chargedAt', 'chargedBy', 'sourceUpdatedAt', 'sourceVersion',
  ]);
  assert.equal(cols.length, 19);
});

test('A: CREDIT_COLUMNS appends creditUid at the END, nothing else moves', () => {
  const { code } = loadCode();
  const cols = arr(code.CREDIT_COLUMNS);
  assert.equal(cols[cols.length - 1], 'creditUid');
  assert.equal(cols.indexOf('creditUid'), cols.length - 1);
  assert.deepEqual(cols.slice(0, 7),
    ['id', 'patientId', 'patientKey', 'patientName', 'houseId', 'facilityType', 'creditType']);
  assert.equal(cols.filter((c) => c === 'creditUid').length, 1);
});

test('A: the appended text columns are force-formatted at ensure; the original ten are not', () => {
  const { code, sandbox } = loadCode();
  const sh = code.ensure(code.PAYMENTS_SHEET, arr(code.PAYMENT_COLUMNS));
  const cols = arr(code.PAYMENT_COLUMNS);
  const forced = sh.ops
    .filter((o) => o.op === 'fmt' && o.fmt === '@' && o.r === 1 && o.nr >= 1000)
    .map((o) => cols[o.c - 1]).sort();
  assert.deepEqual(forced, [
    'chargedAt', 'chargedBy', 'coverageEnd', 'coverageStart',
    'patientUid', 'payerUid', 'paymentUid', 'sourceUpdatedAt',
  ]);
  ['id', 'patientId', 'patientName', 'houseId', 'dueDate',
   'amount', 'status', 'amountPaid', 'balance', 'timestamp'].forEach((c) => {
    assert.ok(forced.indexOf(c) < 0, c + ' is LIVE — re-formatting it would be a migration');
  });
  // sourceVersion is a small integer and stays numeric.
  assert.ok(forced.indexOf('sourceVersion') < 0);
  assert.equal(sandbox.__sheets[code.PAYMENTS_SHEET], sh);
});

test('A: every server-owned column is a real column, and none of them is client-writable', () => {
  const { code } = loadCode();
  const cols = arr(code.PAYMENT_COLUMNS);
  arr(code.PAYMENT_SERVER_COLUMNS).forEach((c) => assert.ok(cols.indexOf(c) >= 0, c));
  // The version test ignores bookkeeping + the client clock, and NOTHING else.
  assert.deepEqual(arr(code.PAYMENT_VERSION_IGNORED_COLUMNS).slice().sort(), [
    'chargedAt', 'chargedBy', 'payerUid', 'paymentUid',
    'sourceUpdatedAt', 'sourceVersion', 'timestamp',
  ]);
  assert.ok(arr(code.PAYMENT_VERSION_IGNORED_COLUMNS).indexOf('patientUid') < 0,
    'healing a blank patient link IS a change the accounting app must see');
});

/* ================= B. paymentUid: minted once, backfilled under the lock ===== */

test('B: the backfill mints a uid for every content row, and a second run writes NOTHING', () => {
  const h = world({ payments: [payRow({ dueDate: '2026-01-20' }), payRow({ dueDate: '2026-02-20' })] });
  const sh = h.sandbox.__sheets[h.code.PAYMENTS_SHEET];
  sh.grid.push([]);                       // a fully-empty trailing row
  const res = h.code.backfillPaymentIdentity(sh);
  assert.equal(res.paymentUids, 2);
  const rows = arr(h.code.readSheet(sh, arr(h.code.PAYMENT_COLUMNS)));
  assert.equal(rows.length, 2, 'the empty trailing row is not resurrected');
  rows.forEach((r) => assert.match(String(r.paymentUid), /^pmt-u\d+$/));
  assert.notEqual(rows[0].paymentUid, rows[1].paymentUid);

  const before = arr(rows).map((r) => r.paymentUid);
  const opsBefore = sh.ops.length;
  const locksBefore = h.sandbox.__lockCalls;
  const second = h.code.backfillPaymentIdentity(sh);
  assert.equal(second.paymentUids, 0, 'idempotent');
  assert.equal(second.patientUids, 0, 'idempotent');
  assert.equal(sh.ops.length, opsBefore, 'ZERO writes in the steady state');
  assert.equal(h.sandbox.__lockCalls, locksBefore, 'and NO lock taken');
  assert.deepEqual(arr(h.code.readSheet(sh, arr(h.code.PAYMENT_COLUMNS))).map((r) => r.paymentUid), arr(before));
});

test('B: the mint is BOUNDED per invocation and converges over successive reads', () => {
  // getPayments_ is the read behind Vered's גבייה tab; an unbounded first mint
  // on a years-old sheet could run into the Apps Script execution limit.
  const many = [];
  for (let i = 1; i <= 7; i++) many.push(payRow({ id: 'pay::' + KEY + '::' + i, dueDate: '2026-0' + i + '-20' }));
  const h = world({ payments: many });
  const sh = h.sandbox.__sheets[h.code.PAYMENTS_SHEET];
  const cols = arr(h.code.PAYMENT_COLUMNS);
  const uidCol = cols.indexOf('paymentUid');
  const pending = () => arr(h.code.readSheet(sh, cols)).filter((r) => String(r.paymentUid || '') === '').length;

  // Force the bound low enough to observe it, via the shared primitive.
  assert.equal(pending(), 7);
  let filled = 0, runs = 0;
  while (pending() > 0 && runs++ < 10) {
    filled += h.code.backfillMissingUids(sh, cols, 'paymentUid', 'pmt-', 3);
  }
  assert.equal(filled, 7, 'every row eventually gets one');
  assert.equal(runs, 3, '3 + 3 + 1 — bounded, and it converges');
  assert.equal(pending(), 0);
  const uids = sh.grid.slice(1).map((r) => r[uidCol]);
  assert.equal(new Set(uids).size, 7, 'and every uid is distinct');
});

test('B: the feed reports how many rows are still awaiting identity', () => {
  const h = world({ props: { ACCOUNTING_SECRET: SECRET }, payments: [payRow(), payRow({ id: 'pay::b', dueDate: '2026-02-20' })] });
  const res = h.code.handle({ action: 'accountingPayments', secret: SECRET });
  assert.equal(res.identityPending, 0, 'the read mints first, then reports');
  assert.ok(res.payments.every((p) => p.paymentUid !== null));
});

test('B: the needful run takes the script lock exactly once; the steady state takes none', () => {
  const h = world({ payments: [payRow()] });
  const sh = h.sandbox.__sheets[h.code.PAYMENTS_SHEET];
  h.sandbox.__lockCalls = 0;
  h.code.backfillPaymentIdentity(sh);
  assert.equal(h.sandbox.__lockCalls, 1, 'one script lock around the per-cell writes');
  h.code.backfillPaymentIdentity(sh);
  assert.equal(h.sandbox.__lockCalls, 1, 'nothing to do → no lock at all');
});

test('B: the backfill writes SINGLE CELLS — never a whole-row or whole-sheet rewrite', () => {
  const h = world({ payments: [payRow(), payRow({ dueDate: '2026-02-20' })] });
  const sh = h.sandbox.__sheets[h.code.PAYMENTS_SHEET];
  sh.ops.length = 0;
  h.code.backfillPaymentIdentity(sh);
  const writes = writeOps(sh);
  assert.ok(writes.length > 0);
  assert.ok(writes.every((o) => o.op === 'setcell'),
    'single-cell writes only: ' + JSON.stringify(writes.map((o) => o.op)));
});

test('B: getPayments heals identity before reading, so the reader sees the stored uids', () => {
  const h = world({ payments: [payRow()] });
  const res = h.code.handle({ action: 'getPayments' });
  assert.equal(res.ok, true);
  assert.match(String(res.payments[0].paymentUid), /^pmt-/);
  const grid = h.sandbox.__sheets[h.code.PAYMENTS_SHEET].grid;
  const col = arr(h.code.PAYMENT_COLUMNS).indexOf('paymentUid');
  assert.equal(grid[1][col], res.payments[0].paymentUid, 'PERSISTED, not derived on read');
});

test('B: the uid survives every legitimate edit — name, due date, amount, status', () => {
  const h = world({ payments: [payRow()] });
  const sh = h.sandbox.__sheets[h.code.PAYMENTS_SHEET];
  h.code.backfillPaymentIdentity(sh);
  const uid = h.code.readSheet(sh, arr(h.code.PAYMENT_COLUMNS))[0].paymentUid;
  assert.match(uid, /^pmt-/);

  h.code.upsert(payRow({ patientName: 'דנה כהן-לוי', amount: 4200, status: 'paid', amountPaid: 4200, balance: 0 }), 'ורד');
  const after = h.code.readSheet(sh, arr(h.code.PAYMENT_COLUMNS))[0];
  assert.equal(after.paymentUid, uid, 'minted once, then permanent');
  assert.equal(after.patientName, 'דנה כהן-לוי');
  assert.equal(after.amount, 4200);
});

test('B: an insert through upsertPayment_ mints its own uid, and the id scheme is untouched', () => {
  const h = world();
  const res = h.code.upsert(payRow(), 'ורד');
  assert.equal(res.created, true);
  assert.match(String(res.payment.paymentUid), /^pmt-/);
  assert.equal(res.payment.id, 'pay::' + KEY + '::2026-01-20',
    'the deterministic id scheme is deliberately unchanged');
});

test('B: a client may not choose its own uid or its own stamps', () => {
  const h = world();
  const res = h.code.upsert(payRow({
    paymentUid: 'pmt-FORGED', patientUid: 'id-FORGED', payerUid: 'payer-FORGED',
    chargedAt: '1999-01-01T00:00:00+02:00', chargedBy: 'FORGED',
    sourceUpdatedAt: '1999-01-01T00:00:00+02:00', sourceVersion: 999,
    status: 'paid', amountPaid: 3000, balance: 0,
  }), 'ורד');
  const p = res.payment;
  assert.notEqual(p.paymentUid, 'pmt-FORGED');
  assert.equal(p.patientUid, 'id-dana', 'resolved from the Patients sheet, not from the payload');
  assert.equal(p.payerUid, '');
  assert.notEqual(p.chargedBy, 'FORGED');
  assert.equal(p.chargedBy, 'ורד');
  assert.equal(p.sourceVersion, 1, 'a payload cannot claim a version');
});

test('B: creditUid is minted once and never re-minted; credit behaviour is unchanged', () => {
  const h = world();
  const c = {
    patientId: 'id-dana', patientKey: KEY, patientName: DANA, houseId: 'arfoni',
    creditType: 'other', allocationMonth: '2026-01',
    calculatedAmount: 500, amount: 500, reason: 'הסבר', decidedDate: '2026-01-25',
  };
  const r1 = h.code.handle({ action: 'saveCredit', credit: JSON.stringify(c), user: 'ורד' });
  assert.equal(r1.ok, true);
  assert.match(String(r1.credit.creditUid), /^crd-/);
  assert.equal(r1.credit.id, 'credit::id-dana::2026-01::1', 'the existing id scheme is untouched');

  const r2 = h.code.handle({
    action: 'saveCredit', user: 'ורד',
    credit: JSON.stringify(Object.assign({}, c, { id: r1.credit.id, updatedAt: r1.credit.updatedAt, notes: 'עודכן' })),
  });
  assert.equal(r2.ok, true);
  assert.equal(r2.credit.creditUid, r1.credit.creditUid, 'carried verbatim across an edit');
  assert.equal(r2.credit.notes, 'עודכן');
});

test('B: the credit backfill is the same locked, idempotent, zero-writes-at-rest pattern', () => {
  const h = world({ credits: [{ id: 'credit::id-dana::2026-01::1', patientId: 'id-dana', patientKey: KEY, amount: 100, status: 'pending', updatedAt: '2026-01-25T10:00:00.000Z' }] });
  const sh = h.sandbox.__sheets[h.code.CREDITS_SHEET];
  h.sandbox.__lockCalls = 0;
  assert.equal(h.code.backfillCreditUids(sh), 1);
  assert.equal(h.sandbox.__lockCalls, 1);
  const opsBefore = sh.ops.length;
  assert.equal(h.code.backfillCreditUids(sh), 0);
  assert.equal(sh.ops.length, opsBefore, 'ZERO writes at rest');
  assert.equal(h.sandbox.__lockCalls, 1, 'and no lock');
});

/* ================= C. patientUid — persisted, exact, never by name ========= */

test('C: patientUid is the PERSISTED Patients id, written into the cell', () => {
  const h = world({ payments: [payRow()] });
  const sh = h.sandbox.__sheets[h.code.PAYMENTS_SHEET];
  const res = h.code.backfillPaymentIdentity(sh);
  assert.equal(res.patientUids, 1);
  const col = arr(h.code.PAYMENT_COLUMNS).indexOf('patientUid');
  assert.equal(sh.grid[1][col], 'id-dana', 'persisted on the row, not derived at read time');
});

test('C: an unresolvable billing triple leaves patientUid BLANK — never guessed', () => {
  const h = world({ payments: [payRow({ patientId: 'ramot::מישהו אחר::2020-01-01' })] });
  const sh = h.sandbox.__sheets[h.code.PAYMENTS_SHEET];
  const res = h.code.backfillPaymentIdentity(sh);
  assert.equal(res.patientUids, 0);
  const rows = h.code.readSheet(sh, arr(h.code.PAYMENT_COLUMNS));
  assert.equal(String(rows[0].patientUid), '', 'no link is honest; a guessed link is not');
  assert.match(String(rows[0].paymentUid), /^pmt-/, 'the payment still gets its own identity');
});

test('C: patients are NOT matched by name — same name, different house or entry date does not link', () => {
  const h = world({
    patients: [{ houseId: 'ramot', name: DANA, date: '2024-01-01', status: 'active', id: 'id-other' }],
    payments: [payRow()],   // arfoni :: DANA :: 2025-06-20
  });
  const sh = h.sandbox.__sheets[h.code.PAYMENTS_SHEET];
  h.code.backfillPaymentIdentity(sh);
  const rows = h.code.readSheet(sh, arr(h.code.PAYMENT_COLUMNS));
  assert.equal(String(rows[0].patientUid), '', 'the name matched; the identity did not');
  // And the resolver really is keyed on the whole triple.
  const src = fnSource(GS_SRC, 'patientUidIndexByKey_');
  assert.ok(src.includes('patientKey_(r.houseId, r.name, asISODate_(r.date))'));
});

test('C: an AMBIGUOUS triple (two patient rows, one key) links to neither', () => {
  const h = world({
    patients: [
      { houseId: 'arfoni', name: DANA, date: '2025-06-20', status: 'active', id: 'id-a' },
      { houseId: 'arfoni', name: DANA, date: '2025-06-20', status: 'released', id: 'id-b' },
    ],
    payments: [payRow()],
  });
  const sh = h.sandbox.__sheets[h.code.PAYMENTS_SHEET];
  h.code.backfillPaymentIdentity(sh);
  assert.equal(String(h.code.readSheet(sh, arr(h.code.PAYMENT_COLUMNS))[0].patientUid), '');
});

test('C: once resolved, patientUid is never rewritten — even if the Patients row changes', () => {
  const h = world({ payments: [payRow()] });
  const sh = h.sandbox.__sheets[h.code.PAYMENTS_SHEET];
  h.code.backfillPaymentIdentity(sh);
  // Repoint the Patients sheet at a different id, then save the payment again.
  seedSheet(h.sandbox, h.code, h.code.PATIENTS_SHEET, h.code.PATIENT_COLUMNS,
    [{ houseId: 'arfoni', name: DANA, date: '2025-06-20', status: 'active', id: 'id-CHANGED' }]);
  h.code.upsert(payRow({ amount: 3100 }), 'ורד');
  assert.equal(h.code.readSheet(sh, arr(h.code.PAYMENT_COLUMNS))[0].patientUid, 'id-dana');
});

test('C: payerUid is reserved and always blank — no payer entity exists to infer one from', () => {
  const h = world({ props: { ACCOUNTING_SECRET: SECRET }, payments: [payRow()] });
  h.code.backfillPaymentIdentity(h.sandbox.__sheets[h.code.PAYMENTS_SHEET]);
  const rows = h.code.readSheet(h.sandbox.__sheets[h.code.PAYMENTS_SHEET], arr(h.code.PAYMENT_COLUMNS));
  assert.equal(String(rows[0].payerUid), '', 'nothing mints a payer id, because nothing knows one');
  const p = authed(h.code).payments[0];
  assert.equal(p.payerUid, null, 'served as an explicit null, not an empty string');
  // Nowhere in the feed is a payer derived from a name.
  const src = GS_SRC.slice(GS_SRC.indexOf('function stampPaymentRow_'));
  assert.ok(!/payerUid\s*=\s*[^p]*patientName/.test(src));
  assert.ok(fnSource(GS_SRC, 'stampPaymentRow_').includes("out.payerUid = paymentCell_(prev.payerUid);"),
    'carried from the sheet and never invented');
});

/* ================= D. chargedAt / chargedBy ================= */

const ISRAEL_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;

test('D: the stamp is Israel time with an EXPLICIT offset, on both sides of the DST switch', () => {
  const summer = loadCode({ now: '2026-09-22T14:03:11+03:00' });
  assert.equal(summer.code.israelTimestamp(), '2026-09-22T14:03:11+03:00');
  const winter = loadCode({ now: '2026-01-15T09:00:00+02:00' });
  assert.equal(winter.code.israelTimestamp(), '2026-01-15T09:00:00+02:00');
  assert.match(summer.code.israelTimestamp(), ISRAEL_STAMP);
});

test('D: marking a payment paid stamps chargedAt + chargedBy from the SIGNED COOKIE', () => {
  const h = world();
  const res = h.code.handle({
    action: 'savePayment', user: 'ורד',
    payment: JSON.stringify(payRow({ status: 'paid', amountPaid: 3000, balance: 0, chargedBy: 'FORGED' })),
  });
  assert.equal(res.ok, true);
  assert.equal(res.payment.chargedAt, '2026-09-22T10:00:00+03:00');
  assert.equal(res.payment.chargedBy, 'ורד', 'never the client-supplied name');
});

test('D: `partial` stamps too; `unpaid` leaves both blank', () => {
  const h = world();
  const part = h.code.upsert(payRow({ dueDate: '2026-03-20', status: 'partial', amountPaid: 1000, balance: 2000 }), 'ורד');
  assert.match(part.payment.chargedAt, ISRAEL_STAMP);
  assert.equal(part.payment.chargedBy, 'ורד');
  const un = h.code.upsert(payRow({ dueDate: '2026-04-20' }), 'ורד');
  assert.equal(un.payment.chargedAt, '');
  assert.equal(un.payment.chargedBy, '');
  assert.deepEqual(arr(h.code.PAYMENT_CHARGED_STATUSES), ['paid', 'partial']);
});

test('D: re-saving the SAME reported figure does not move the stamp', () => {
  const h = world();
  const first = h.code.upsert(payRow({ status: 'paid', amountPaid: 3000, balance: 0 }), 'ורד');
  h.clock.advance(3 * 60 * 60 * 1000);
  const again = h.code.upsert(payRow({ status: 'paid', amountPaid: 3000, balance: 0, coverageStart: '2026-01-20', coverageEnd: '2026-02-19' }), 'אורטל');
  assert.equal(again.payment.chargedAt, first.payment.chargedAt, 'the report did not happen again');
  assert.equal(again.payment.chargedBy, 'ורד');
});

test('D: when amountPaid MOVES, both stamps are refreshed', () => {
  const h = world();
  const first = h.code.upsert(payRow({ status: 'paid', amountPaid: 3000, balance: 0 }), 'ורד');
  h.clock.set('2026-09-23T11:30:00+03:00');
  const fixed = h.code.upsert(payRow({ status: 'partial', amountPaid: 2500, balance: 500 }), 'שרה');
  assert.equal(fixed.payment.chargedAt, '2026-09-23T11:30:00+03:00');
  assert.equal(fixed.payment.chargedBy, 'שרה');
  assert.notEqual(fixed.payment.chargedAt, first.payment.chargedAt);
});

test('D: a HISTORICAL paid row stays BLANK — no stamp is ever derived for it', () => {
  // A legacy row: Hebrew status label, blank accounting columns — exactly what
  // the live sheet holds today.
  const h = world({ payments: [payRow({ status: 'שולם', amountPaid: 3000, balance: 0 })] });
  const sh = h.sandbox.__sheets[h.code.PAYMENTS_SHEET];
  h.code.backfillPaymentIdentity(sh);
  let rows = h.code.readSheet(sh, arr(h.code.PAYMENT_COLUMNS));
  assert.equal(String(rows[0].chargedAt), '', 'the backfill mints identity and nothing else');

  // An unrelated later edit that reports the SAME figure must not invent one.
  h.code.upsert(payRow({ status: 'paid', amountPaid: 3000, balance: 0, coverageStart: '2026-01-20', coverageEnd: '2026-02-19' }), 'ורד');
  rows = h.code.readSheet(sh, arr(h.code.PAYMENT_COLUMNS));
  assert.equal(String(rows[0].chargedAt), '', 'nobody recorded when this was reported; blank says so');
  assert.equal(String(rows[0].chargedBy), '');
  assert.equal(h.code.paymentStatus('שולם'), 'paid', 'the legacy label reads as already-charged');
  assert.equal(h.code.paymentStatus('שולם חלקית'), 'partial');
});

test('D: reverting a row to unpaid CLEARS the stamps', () => {
  const h = world();
  h.code.upsert(payRow({ status: 'paid', amountPaid: 3000, balance: 0 }), 'ורד');
  const back = h.code.upsert(payRow({ status: 'unpaid', amountPaid: 0, balance: 3000 }), 'ורד');
  assert.equal(back.payment.chargedAt, '');
  assert.equal(back.payment.chargedBy, '');
  assert.ok(back.payment.sourceVersion > 1, 'but the version records that the record changed');
});

test('D: READS never stamp — neither getPayments nor the accounting feed touches a charge cell', () => {
  const h = world({
    props: { ACCOUNTING_SECRET: SECRET },
    payments: [payRow({ status: 'שולם', amountPaid: 3000, balance: 0 })],
  });
  const sh = h.sandbox.__sheets[h.code.PAYMENTS_SHEET];
  const cols = arr(h.code.PAYMENT_COLUMNS);
  h.code.handle({ action: 'getPayments' });
  h.code.handle({ action: 'accountingPayments', secret: SECRET });
  h.code.handle({ action: 'accountingPayments', secret: SECRET });
  const chargeCols = [cols.indexOf('chargedAt') + 1, cols.indexOf('chargedBy') + 1];
  const touched = writeOps(sh).filter((o) => o.op === 'setcell' && chargeCols.indexOf(o.c) >= 0);
  assert.equal(touched.length, 0, 'a read may mint identity; it may never claim money was reported');
  assert.equal(String(h.code.readSheet(sh, cols)[0].chargedAt), '');
});

test('D: the stamping rule is PURE and testable on its own', () => {
  const { code, clock } = loadCode({ now: '2026-05-05T12:00:00+03:00' });
  // insert, paid → stamped
  let out = code.stampRow({ id: 'x', status: 'paid', amountPaid: 100 }, {}, false, 'ורד');
  assert.equal(out.chargedAt, '2026-05-05T12:00:00+03:00');
  assert.equal(out.sourceVersion, 1);
  // same figure again, three weeks later → carried, version held
  const prev = Object.assign({}, out, { id: 'x' });
  clock.set('2026-05-26T12:00:00+03:00');
  out = code.stampRow({ id: 'x', status: 'paid', amountPaid: 100 }, prev, true, 'אורטל');
  assert.equal(out.chargedAt, '2026-05-05T12:00:00+03:00');
  assert.equal(out.chargedBy, 'ורד');
  assert.equal(out.sourceVersion, 1, 'nothing changed, so nothing ticked');
  // the reported figure moves → both stamps refresh, version ticks
  out = code.stampRow({ id: 'x', status: 'paid', amountPaid: 80 }, prev, true, 'אורטל');
  assert.equal(out.chargedAt, '2026-05-26T12:00:00+03:00');
  assert.equal(out.chargedBy, 'אורטל');
  assert.equal(out.sourceVersion, 2);
});

/* ================= E. change tracking ================= */

test('E: sourceVersion starts at 1, holds on a no-op save, and ticks on a real change', () => {
  const h = world();
  const a = h.code.upsert(payRow(), 'ורד');
  assert.equal(a.payment.sourceVersion, 1);
  assert.match(a.payment.sourceUpdatedAt, ISRAEL_STAMP);

  h.clock.advance(60000);
  // Only the client clock moved — the row did not.
  const b = h.code.upsert(payRow({ timestamp: '2026-01-21T09:00:00.000Z' }), 'ורד');
  assert.equal(b.payment.sourceVersion, 1, 'a re-save that changes nothing must not flood the queue');
  assert.equal(b.payment.sourceUpdatedAt, a.payment.sourceUpdatedAt);

  h.clock.set('2026-09-24T08:00:00+03:00');
  const c = h.code.upsert(payRow({ amount: 3300, balance: 3300 }), 'ורד');
  assert.equal(c.payment.sourceVersion, 2);
  assert.equal(c.payment.sourceUpdatedAt, '2026-09-24T08:00:00+03:00');
});

test('E: healing a blank patientUid IS a change the feed reports', () => {
  const h = world({ patients: [], payments: [] });
  const a = h.code.upsert(payRow(), 'ורד');
  assert.equal(a.payment.patientUid, '', 'no Patients row to resolve against yet');
  assert.equal(a.payment.sourceVersion, 1);
  seedSheet(h.sandbox, h.code, h.code.PATIENTS_SHEET, h.code.PATIENT_COLUMNS, [PAT]);
  const b = h.code.upsert(payRow(), 'ורד');
  assert.equal(b.payment.patientUid, 'id-dana');
  assert.equal(b.payment.sourceVersion, 2);
});

/* ================= F. endpoint authentication ================= */

test('F: FAIL-CLOSED — with no secret configured the endpoint serves nothing', () => {
  const h = world({ payments: [payRow()] });   // ACCOUNTING_SECRET unset
  const res = h.code.handle({ action: 'accountingPayments' });
  assert.deepEqual(res, { ok: false, error: 'unauthorized' });
  const withGuess = h.code.handle({ action: 'accountingPayments', secret: 'anything' });
  assert.deepEqual(withGuess, { ok: false, error: 'unauthorized' });
});

test('F: a wrong, blank or missing secret is refused, and leaks no data', () => {
  const h = world({ props: { ACCOUNTING_SECRET: SECRET }, payments: [payRow()] });
  ['wrong', '', undefined, null].forEach((s) => {
    const res = h.code.handle({ action: 'accountingPayments', secret: s });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'unauthorized');
    assert.equal(res.payments, undefined);
    assert.ok(!JSON.stringify(res).includes(DANA), 'no patient data in a refusal');
  });
  ['accountingCredits'].forEach((action) => {
    assert.equal(h.code.handle({ action, secret: 'wrong' }).error, 'unauthorized');
  });
});

test('F: the correct secret serves both read actions', () => {
  const h = world({ props: { ACCOUNTING_SECRET: SECRET }, payments: [payRow()] });
  assert.equal(h.code.handle({ action: 'accountingPayments', secret: SECRET }).ok, true);
  assert.equal(h.code.handle({ action: 'accountingCredits', secret: SECRET }).ok, true);
});

test('F: the accounting secret is its OWN property and unlocks nothing else', () => {
  assert.equal(loadCode().code.ACCOUNTING_SECRET_PROP, 'ACCOUNTING_SECRET');
  const auth = fnSource(GS_SRC, 'accountingAuthOk_');
  assert.ok(auth.includes('ACCOUNTING_SECRET_PROP'));
  assert.ok(!auth.includes('ADMITTED_ROSTER_SECRET'));
  assert.ok(!auth.includes('MEETING_REPORT_SECRET'));
  // And it does not open the roster / meeting-report endpoints.
  const h = world({ props: { ACCOUNTING_SECRET: SECRET } });
  assert.equal(h.code.handle({ action: 'getAdmittedRoster', secret: SECRET }).error, 'unauthorized');
  assert.equal(h.code.handle({ action: 'meetingReportLeads', secret: SECRET }).error, 'unauthorized');
});

test('F: the endpoint exposes NO write action', () => {
  const dispatch = GS_SRC.slice(GS_SRC.indexOf('function handle_'),
    GS_SRC.indexOf('function collectParams_'));
  const gated = dispatch.slice(dispatch.indexOf('accountingAuthOk_'));
  ['saveAll', 'savePayment', 'updatePayment', 'saveCredit', 'deletePatientRow',
   'dischargePatient', 'upsertBillingOverride'].forEach((a) => {
    assert.ok(!gated.includes("'" + a + "'"), 'the accounting branch must not reach ' + a);
  });
  // The two actions it does gate are read-only by construction.
  ['accountingPayments_', 'accountingCredits_'].forEach((fn) => {
    const body = fnSource(GS_SRC, fn);
    ['setValue', 'setValues', 'appendRow', 'deleteRow'].forEach((w) => {
      assert.ok(!body.includes(w), fn + ' must never ' + w);
    });
  });
  // A sanity check that the proxy learned nothing about this at all.
  assert.ok(!/ACCOUNTING_SECRET|accountingPayments/.test(SERVER),
    'the accounting app talks to Apps Script directly — server.js is untouched');
});

test('F: an authenticated read performs no business write', () => {
  const h = world({ props: { ACCOUNTING_SECRET: SECRET }, payments: [payRow({ status: 'paid', amountPaid: 3000, balance: 0 })] });
  const sh = h.sandbox.__sheets[h.code.PAYMENTS_SHEET];
  h.code.handle({ action: 'accountingPayments', secret: SECRET });   // mints identity
  const before = h.code.readSheet(sh, arr(h.code.PAYMENT_COLUMNS))[0];
  sh.ops.length = 0;
  h.code.handle({ action: 'accountingPayments', secret: SECRET });
  assert.equal(writeOps(sh).length, 0, 'the second read writes nothing at all');
  const after = h.code.readSheet(sh, arr(h.code.PAYMENT_COLUMNS))[0];
  assert.deepEqual(after, before);
});

/* ================= G. pagination + updatedSince ================= */

function manyPayments(n) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    const due = '2026-' + String(((i - 1) % 12) + 1).padStart(2, '0') + '-20';
    out.push(payRow({
      id: 'pay::' + KEY + '::' + i, dueDate: due,
      paymentUid: 'pmt-' + String(i).padStart(3, '0'),
      sourceUpdatedAt: '2026-09-' + String(i).padStart(2, '0') + 'T10:00:00+03:00',
      sourceVersion: 1,
    }));
  }
  return out;
}

test('G: a paged sync walks every row exactly once — no skips, no repeats', () => {
  const h = world({ props: { ACCOUNTING_SECRET: SECRET }, payments: manyPayments(11) });
  const seen = [];
  let cursor = null, guard = 0;
  do {
    const res = h.code.handle({ action: 'accountingPayments', secret: SECRET, limit: 4, cursor: cursor });
    assert.equal(res.ok, true);
    assert.ok(res.payments.length <= 4);
    res.payments.forEach((p) => seen.push(p.paymentUid));
    cursor = res.page.nextCursor;
    assert.equal(res.page.hasMore, cursor !== null);
  } while (cursor && guard++ < 20);
  assert.equal(seen.length, 11);
  assert.equal(new Set(seen).size, 11, 'no repeats');
  assert.deepEqual(seen, seen.slice().sort(), 'ascending and stable');
});

test('G: updatedSince returns only what moved since the watermark (inclusive)', () => {
  const h = world({ props: { ACCOUNTING_SECRET: SECRET }, payments: manyPayments(6) });
  const res = h.code.handle({
    action: 'accountingPayments', secret: SECRET, limit: 100,
    updatedSince: '2026-09-04T10:00:00+03:00',
  });
  assert.deepEqual(res.payments.map((p) => p.paymentUid), ['pmt-004', 'pmt-005', 'pmt-006']);
  assert.equal(res.page.updatedSince, '2026-09-04T10:00:00+03:00');
});

test('G: HISTORICAL rows are flagged, and an incremental read never drags them in', () => {
  const h = world({
    props: { ACCOUNTING_SECRET: SECRET },
    payments: [
      payRow({ id: 'pay::old::1', dueDate: '2025-02-20', status: 'שולם', amountPaid: 3000, balance: 0 }),
      payRow({ id: 'pay::new::1', dueDate: '2026-09-20', paymentUid: 'pmt-new', status: 'paid', amountPaid: 3000, balance: 0,
               chargedAt: '2026-09-21T09:00:00+03:00', chargedBy: 'ורד',
               sourceUpdatedAt: '2026-09-21T09:00:00+03:00', sourceVersion: 1 }),
    ],
  });
  const full = h.code.handle({ action: 'accountingPayments', secret: SECRET });
  assert.equal(full.payments.length, 2, 'a FULL sync sees everything');
  const hist = full.payments.filter((p) => p.historical);
  assert.equal(hist.length, 1);
  assert.equal(hist[0].sourceUpdatedAt, null);
  assert.equal(hist[0].chargedAt, null, 'and carries no invented charge time');
  assert.equal(hist[0].sourceVersion, null);

  const inc = h.code.handle({
    action: 'accountingPayments', secret: SECRET, updatedSince: '2026-09-01T00:00:00+03:00',
  });
  assert.deepEqual(inc.payments.map((p) => p.paymentUid), ['pmt-new'],
    'this is how the accounting app keeps history out of its confirmation queue');
});

test('G: a malformed updatedSince or cursor is REFUSED, never treated as a full sync', () => {
  const h = world({ props: { ACCOUNTING_SECRET: SECRET }, payments: manyPayments(3) });
  assert.deepEqual(h.code.handle({ action: 'accountingPayments', secret: SECRET, updatedSince: 'yesterday' }),
    { ok: false, error: 'bad_updatedSince' });
  assert.deepEqual(h.code.handle({ action: 'accountingPayments', secret: SECRET, cursor: 'garbage' }),
    { ok: false, error: 'bad_cursor' });
  assert.equal(h.code.handle({ action: 'accountingCredits', secret: SECRET, updatedSince: 'nope' }).error, 'bad_updatedSince');
});

test('G: limit defaults, is clamped, and never exceeds the cap', () => {
  const h = world({ props: { ACCOUNTING_SECRET: SECRET }, payments: manyPayments(3) });
  assert.equal(h.code.handle({ action: 'accountingPayments', secret: SECRET }).page.limit, 200);
  assert.equal(h.code.handle({ action: 'accountingPayments', secret: SECRET, limit: 99999 }).page.limit,
    h.code.ACCOUNTING_PAGE_MAX);
  assert.equal(h.code.handle({ action: 'accountingPayments', secret: SECRET, limit: 0 }).page.limit, 200);
  assert.equal(h.code.handle({ action: 'accountingPayments', secret: SECRET, limit: -5 }).page.limit, 200);
  assert.equal(h.code.handle({ action: 'accountingPayments', secret: SECRET, limit: 2 }).page.count, 2);
});

test('G: credits page and filter on their own timestamps', () => {
  const h = world({
    props: { ACCOUNTING_SECRET: SECRET },
    credits: [1, 2, 3].map((i) => ({
      id: 'credit::id-dana::2026-0' + i + '::1', creditUid: 'crd-00' + i,
      patientId: 'id-dana', patientKey: KEY, patientName: DANA, houseId: 'arfoni',
      creditType: 'days_unused', allocationMonth: '2026-0' + i,
      calculatedAmount: 100 * i, amount: 100 * i, status: 'pending',
      updatedAt: '2026-0' + i + '-15T10:00:00.000Z',
    })),
  });
  const page1 = h.code.handle({ action: 'accountingCredits', secret: SECRET, limit: 2 });
  assert.deepEqual(page1.credits.map((c) => c.creditUid), ['crd-001', 'crd-002']);
  assert.equal(page1.page.hasMore, true);
  const page2 = h.code.handle({ action: 'accountingCredits', secret: SECRET, limit: 2, cursor: page1.page.nextCursor });
  assert.deepEqual(page2.credits.map((c) => c.creditUid), ['crd-003']);
  assert.equal(page2.page.hasMore, false);
  assert.equal(page2.page.nextCursor, null);
  const since = h.code.handle({ action: 'accountingCredits', secret: SECRET, updatedSince: '2026-03-01T00:00:00+02:00' });
  assert.deepEqual(since.credits.map((c) => c.creditUid), ['crd-003']);
});

/* ================= H. the response contract ================= */

const PAYMENT_KEYS = [
  'sourceApp', 'sourceRecordId', 'paymentUid', 'patientUid', 'payerUid',
  'patientName', 'house', 'dueDate', 'amount', 'amountPaid', 'balance',
  'currency', 'vatInclusive', 'status', 'statusRaw', 'chargedAt', 'chargedBy',
  'coverageStart', 'coverageEnd', 'coverageSource', 'coverageDays',
  'coverageAllocation', 'sourceUpdatedAt', 'sourceVersion', 'historical',
  'deleted', 'creditLinkBasis', 'credits',
];
const CREDIT_KEYS = [
  'sourceApp', 'sourceRecordId', 'creditUid', 'patientUid', 'patientKey', 'payerUid',
  'house', 'creditType', 'allocationMonth', 'calculatedAmount', 'amount',
  'currency', 'vatInclusive', 'status', 'decidedDate', 'payoutDate', 'paidDate',
  'sourceUpdatedAt', 'sourceCreatedAt',
];

test('H: the payment projection is an exact ALLOW-LIST', () => {
  const h = world({
    props: { ACCOUNTING_SECRET: SECRET },
    payments: [payRow({ status: 'paid', amountPaid: 3000, balance: 0 })],
  });
  const res = h.code.handle({ action: 'accountingPayments', secret: SECRET });
  assert.equal(res.ok, true);
  assert.equal(res.sourceApp, 'ezone-dashboard');
  assert.equal(res.schemaVersion, 1);
  assert.match(res.serverTime, ISRAEL_STAMP);
  const p = res.payments[0];
  assert.deepEqual(Object.keys(p).sort(), PAYMENT_KEYS.slice().sort());
  assert.equal(p.sourceRecordId, 'pay::' + KEY + '::2026-01-20');
  assert.match(String(p.paymentUid), /^pmt-/);
  assert.equal(p.patientUid, 'id-dana');
  assert.equal(p.payerUid, null, 'nullable, with an explicit crosswalk owed by the accounting app');
  assert.equal(p.house, 'arfoni');
  assert.equal(p.status, 'paid');
  assert.equal(p.deleted, false);
});

test('H: amounts stay VAT-INCLUSIVE — the feed performs no second VAT conversion', () => {
  const h = world({
    props: { ACCOUNTING_SECRET: SECRET },
    payments: [payRow({ amount: 3540, status: 'paid', amountPaid: 3540, balance: 0 })],
  });
  const p = h.code.handle({ action: 'accountingPayments', secret: SECRET }).payments[0];
  assert.equal(p.amount, 3540, 'stored VAT-inclusive, served VAT-inclusive');
  assert.equal(p.amountPaid, 3540);
  assert.equal(p.vatInclusive, true);
  assert.equal(p.currency, 'ILS');
  // No VAT arithmetic anywhere in the accounting projection.
  ['accountingPaymentView_', 'accountingCreditView_', 'accountingAllocation_'].forEach((fn) => {
    const body = fnSource(GS_SRC, fn);
    assert.ok(!/1\.18|VAT_RATE|exVat/i.test(body), fn + ' must not convert VAT');
  });
});

test('H: NO clinical data can reach the response', () => {
  const CLINICAL = 'אבחנה: דיכאון מג׳ורי — טיפול תרופתי';
  const h = world({
    props: { ACCOUNTING_SECRET: SECRET },
    patients: [Object.assign({}, PAT, { notes: CLINICAL, adv: 1, source: 'פנייה' })],
    payments: [payRow({ status: 'paid', amountPaid: 3000, balance: 0 })],
    credits: [{
      id: 'credit::id-dana::2026-01::1', creditUid: 'crd-1',
      patientId: 'id-dana', patientKey: KEY, patientName: DANA, houseId: 'arfoni',
      creditType: 'days_unused', allocationMonth: '2026-01',
      calculatedAmount: 500, amount: 500, status: 'pending',
      reason: CLINICAL, notes: CLINICAL, overrideReason: CLINICAL,
      basis: JSON.stringify({ note: CLINICAL }),
      updatedAt: '2026-01-25T10:00:00.000Z', createdAt: '2026-01-25T10:00:00.000Z',
    }],
  });
  const pay = JSON.stringify(h.code.handle({ action: 'accountingPayments', secret: SECRET }));
  const cred = JSON.stringify(h.code.handle({ action: 'accountingCredits', secret: SECRET }));
  [pay, cred].forEach((body) => {
    assert.ok(!body.includes(CLINICAL), 'clinical free text must never appear');
    ['"notes"', '"reason"', '"overrideReason"', '"basis"', '"diagnosis"',
     '"discharge_note"', '"disposition"', '"meetingNote"', '"adv"', '"source"'].forEach((k) => {
      assert.ok(!body.includes(k), 'key ' + k + ' must not be in the feed');
    });
  });
});

test('H: the credit projection is an exact ALLOW-LIST too', () => {
  const h = world({
    props: { ACCOUNTING_SECRET: SECRET },
    credits: [{
      id: 'credit::id-dana::2026-01::1', creditUid: 'crd-1',
      patientId: 'id-dana', patientKey: KEY, patientName: DANA, houseId: 'arfoni',
      creditType: 'prepaid_return', allocationMonth: '2026-01',
      calculatedAmount: 3000, amount: 3000, status: 'pending',
      decidedDate: '2026-01-25', payoutDate: '2026-02-15',
      createdAt: '2026-01-25T10:00:00.000Z', updatedAt: '2026-01-25T10:00:00.000Z',
    }],
  });
  const c = h.code.handle({ action: 'accountingCredits', secret: SECRET }).credits[0];
  assert.deepEqual(Object.keys(c).sort(), CREDIT_KEYS.slice().sort());
  assert.equal(c.creditUid, 'crd-1');
  assert.equal(c.patientUid, 'id-dana');
  assert.equal(c.vatInclusive, true);
  // Credits carry the repo's older UTC stamps; the feed states one convention.
  assert.match(c.sourceUpdatedAt, ISRAEL_STAMP);
  assert.equal(c.sourceUpdatedAt, '2026-01-25T12:00:00+02:00');
  assert.ok(!('patientName' in c));
});

test('H: credits linked to a payment ride along, and the link basis is stated', () => {
  const h = world({
    props: { ACCOUNTING_SECRET: SECRET },
    payments: [payRow({ status: 'paid', amountPaid: 3000, balance: 0 })],   // due 2026-01-20
    credits: [{
      id: 'credit::id-dana::2026-01::1', creditUid: 'crd-1',
      patientId: 'id-dana', patientKey: KEY, houseId: 'arfoni',
      creditType: 'days_unused', allocationMonth: '2026-01',
      calculatedAmount: 400, amount: 400, status: 'pending',
      updatedAt: '2026-02-01T10:00:00.000Z',
    }, {
      id: 'credit::id-dana::2026-05::1', creditUid: 'crd-2',
      patientId: 'id-dana', patientKey: KEY, houseId: 'arfoni',
      creditType: 'other', allocationMonth: '2026-05',
      calculatedAmount: 50, amount: 50, status: 'pending',
      updatedAt: '2026-05-01T10:00:00.000Z',
    }],
  });
  const p = h.code.handle({ action: 'accountingPayments', secret: SECRET }).payments[0];
  assert.deepEqual(p.credits.map((c) => c.creditUid), ['crd-1'],
    'only the credit whose allocation month is this row month');
  assert.equal(p.creditLinkBasis, 'derived:patientKey+allocationMonth==dueDateMonth');
  // The unlinked one is still exposed in full by the authoritative credits action.
  const all = h.code.handle({ action: 'accountingCredits', secret: SECRET }).credits;
  assert.deepEqual(all.map((c) => c.creditUid).sort(), ['crd-1', 'crd-2']);
});

/* ================= I. coverage + day/month allocation ================= */

test('I: the RECORDED coverage period wins; a blank pair falls back to the inferred cycle', () => {
  const { code } = loadCode();
  const rec = code.coverage({ dueDate: '2026-01-20', coverageStart: '2026-02-01', coverageEnd: '2026-02-28' });
  assert.equal(rec.source, 'recorded');
  const inf = code.coverage({ dueDate: '2026-01-20', coverageStart: '', coverageEnd: '' });
  assert.equal(inf.source, 'inferred');
  assert.equal(inf.start.getDate(), 20);
  assert.equal(inf.end.getMonth(), 1);   // February
  assert.equal(inf.end.getDate(), 19);   // dueDate + 1 month − 1 day
  assert.equal(code.coverage({ dueDate: '' }), null);
});

test('I: a straddling window splits day by day and the parts add back up', () => {
  const { code } = loadCode();
  const cov = code.coverage({ dueDate: '2026-01-20' });       // 20 Jan – 19 Feb, 31 days
  const alloc = arr(code.allocation(cov, 3000, 3000));
  assert.deepEqual(alloc.map((a) => a.month), ['2026-01', '2026-02']);
  assert.deepEqual(alloc.map((a) => a.days), [12, 19]);
  assert.equal(alloc[0].amount, 1161.29);
  assert.equal(alloc[1].amount, 1838.71);
  assert.equal(alloc[0].amount + alloc[1].amount, 3000);
  assert.equal(Math.round((alloc[0].share + alloc[1].share) * 1e6) / 1e6, 1);
});

test('I: a window inside one month is one bucket; a partly-paid row splits both figures', () => {
  const h = world({
    props: { ACCOUNTING_SECRET: SECRET },
    payments: [payRow({ coverageStart: '2026-03-01', coverageEnd: '2026-03-31', status: 'partial', amountPaid: 1500, balance: 1500 })],
  });
  const p = h.code.handle({ action: 'accountingPayments', secret: SECRET }).payments[0];
  assert.equal(p.coverageSource, 'recorded');
  assert.equal(p.coverageDays, 31);
  assert.deepEqual(p.coverageAllocation, [
    { month: '2026-03', days: 31, share: 1, amount: 3000, amountPaid: 1500 },
  ]);
});

/* ================= J. deletion / tombstones ================= */

test('J: a deleted payment is exposed as a tombstone, and the recovery copy never leaks', () => {
  const h = world({ props: { ACCOUNTING_SECRET: SECRET }, payments: [payRow({ dueDate: '2026-02-20' })] });
  seedSheet(h.sandbox, h.code, h.code.PAYMENTS_TOMBSTONES_SHEET, h.code.PAYMENT_TOMBSTONE_COLUMNS, [{
    paymentUid: 'pmt-gone', sourceRecordId: 'pay::' + KEY + '::2026-01-20',
    patientUid: 'id-dana', houseId: 'arfoni', dueDate: '2026-01-20',
    amount: 3000, amountPaid: 3000, status: 'paid',
    deletedAt: '2026-09-10T12:00:00+03:00', deletedBy: '', deletedByFn: 'reconcileOrphanPaymentsNow',
    reason: 'orphan_reconcile_stray_twin', values: '["SECRET-RECOVERY-COPY"]',
  }]);
  const res = h.code.handle({ action: 'accountingPayments', secret: SECRET });
  assert.equal(res.tombstones.length, 1);
  const t = res.tombstones[0];
  assert.equal(t.paymentUid, 'pmt-gone');
  assert.equal(t.deleted, true);
  assert.equal(t.reason, 'orphan_reconcile_stray_twin');
  assert.ok(!('values' in t));
  assert.ok(!JSON.stringify(res).includes('SECRET-RECOVERY-COPY'));
  assert.equal(res.tombstonesTruncated, false);
});

test('J: tombstones honour updatedSince and ride the FIRST page only', () => {
  const h = world({ props: { ACCOUNTING_SECRET: SECRET }, payments: manyPayments(5) });
  seedSheet(h.sandbox, h.code, h.code.PAYMENTS_TOMBSTONES_SHEET, h.code.PAYMENT_TOMBSTONE_COLUMNS, [
    { paymentUid: 'pmt-old', sourceRecordId: 'a', deletedAt: '2026-01-01T09:00:00+02:00', reason: 'x' },
    { paymentUid: 'pmt-recent', sourceRecordId: 'b', deletedAt: '2026-09-09T09:00:00+03:00', reason: 'x' },
  ]);
  const since = h.code.handle({ action: 'accountingPayments', secret: SECRET, updatedSince: '2026-09-01T00:00:00+03:00' });
  assert.deepEqual(since.tombstones.map((t) => t.paymentUid), ['pmt-recent']);

  const p1 = h.code.handle({ action: 'accountingPayments', secret: SECRET, limit: 2 });
  assert.equal(p1.tombstones.length, 2);
  const p2 = h.code.handle({ action: 'accountingPayments', secret: SECRET, limit: 2, cursor: p1.page.nextCursor });
  assert.deepEqual(p2.tombstones, [], 'a paging client is not handed the same deletions twice');
});

test('J: the tombstone writer records the whole row and names the delete', () => {
  const h = world();
  const cols = arr(h.code.PAYMENT_COLUMNS);
  const values = h.code.objectToRow(payRow({ paymentUid: 'pmt-x', patientUid: 'id-dana', status: 'paid', amountPaid: 3000 }), cols);
  const n = h.code.appendPaymentTombstones([{ rowNumber: 7, values }], 'orphan_reconcile_stray_twin', 'reconcileOrphanPaymentsNow');
  assert.equal(n, 1);
  const sh = h.sandbox.__sheets[h.code.PAYMENTS_TOMBSTONES_SHEET];
  const t = h.code.readSheet(sh, arr(h.code.PAYMENT_TOMBSTONE_COLUMNS))[0];
  assert.equal(t.paymentUid, 'pmt-x');
  assert.equal(t.sourceRecordId, 'pay::' + KEY + '::2026-01-20');
  assert.equal(t.deletedByFn, 'reconcileOrphanPaymentsNow');
  assert.equal(t.deletedBy, '', 'a repair run from the editor has no signed session behind it');
  assert.match(String(t.deletedAt), ISRAEL_STAMP);
  assert.ok(String(t.values).includes('pmt-x'), 'recoverable');
  // Nothing to record → no sheet is even created.
  const h2 = world();
  assert.equal(h2.code.appendPaymentTombstones([], 'x', 'y'), 0);
  assert.equal(h2.sandbox.__sheets[h2.code.PAYMENTS_TOMBSTONES_SHEET], undefined);
});

test('J: with no tombstone sheet at all the feed simply reports no deletions', () => {
  const h = world({ props: { ACCOUNTING_SECRET: SECRET }, payments: [payRow()] });
  const res = h.code.handle({ action: 'accountingPayments', secret: SECRET });
  assert.deepEqual(res.tombstones, []);
  assert.equal(h.sandbox.__sheets[h.code.PAYMENTS_TOMBSTONES_SHEET], undefined,
    'a read never creates the sheet');
});
