/* DUPLICATE PAYMENTS — voided, never deleted.
 *
 * THE CASE. A patient is renamed after their first payment is recorded. The
 * payment detaches (it is keyed houseId::name::entryDate), nobody notices, and
 * the money is entered again under the new name. Three confirmed pairs in the
 * live sheet, all of them the same shape — same house, same entry date, same
 * amount, a name that grew:
 *
 *   arfoni::ערן::2026-08-09         ₪35,000 (entered 9/8)
 *     duplicates arfoni::ערן יצחק חונה::2026-08-09      ₪35,000 (entered 17/8)
 *   rehab::עדי::2026-09-14          ₪35,000 (entered 15/9)
 *     duplicates rehab::עדי עמית::2026-09-14            ₪35,000 (entered 17/9)
 *   arfoni::עמית יעקובי::2026-09-07 ₪30,000 (entered 8/9)
 *     duplicates arfoni::עמית בורנשטיין::2026-09-07     ₪30,000 (entered 15/9)
 *
 * Locked contracts:
 *   - THE ROW IS NEVER DELETED. It keeps its amount, its amountPaid, its dates
 *     and its stored triple — that record is the only evidence anyone will
 *     ever have that the money was entered twice rather than collected twice;
 *   - it is marked status 'void', an ALIASED status on both sides, so a row
 *     read back from the sheet cannot silently un-void itself;
 *   - a void row is excluded from EVERY revenue, debt and alert figure, through
 *     one shared predicate;
 *   - the void carries a note, who and when, and is written to the AuditLog;
 *   - the row is shown side by side with the surviving original BEFORE the
 *     decision is confirmed;
 *   - where a candidate carries the double-entry warning, כפילות is the
 *     PRIMARY action and שייך steps down — offered, never removed;
 *   - undoing a void is SANDRA'S ALONE, enforced on the server against the
 *     signed session cookie.
 *
 * TZ pinned to Asia/Jerusalem. vm-sandbox on the REAL shipped app.js / Code.gs.
 */

process.env.TZ = 'Asia/Jerusalem';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const GS_SRC = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');

const arr = (x) => Array.from(x);
const plain = (v) => JSON.parse(JSON.stringify(v));

/* ================= app.js harness ================= */

function loadApp() {
  const epilogue = `
    globalThis.__test = {
      state, isVoidPayment, paymentCoversCycle, statusFromAmounts, canReverseVoid,
      PAYMENT_VOID_STATUS, PAYMENT_VOID_LABEL, PAYMENT_VOID_REVERSERS,
      PAYMENT_STATUS, PAYMENT_STATUS_ALIASES, PAYMENT_LINK_STATUSES,
      RECONNECT_DECIDED_STATUSES, duplicateVoidNote,
      normalizePayment, normalizePatient, patientKey, paymentId,
      detachedPayments, reconnectDoubleEntry, reconnectCandidates,
      buildMonthlyRevenue, suggestCredits, overduePatients, patientsNeedingRenewal,
      isoDate, monthKey, roundMoney,
    };
  `;
  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/' },
    document: {
      addEventListener: noop, getElementById: () => null,
      querySelector: () => null, querySelectorAll: () => [],
    },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    URLSearchParams, Math, Date, JSON, Number, String, Array, Object, RegExp,
    isNaN, isFinite, parseInt, parseFloat, Promise,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(APP + epilogue, sandbox);
  return sandbox.__test;
}
const app = loadApp();

/** Extract one `function NAME(...) { ... }` body out of a source string.
 *
 * The body starts after the PARAMETER LIST closes, not at the first `{` —
 * showDuplicateConfirm({ pay, original, ... }) destructures, and taking the
 * first brace would read the parameter object and silently assert nothing. */
function fnSource(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'function not found: ' + name);
  let paren = 0, j = src.indexOf('(', start);
  for (; j < src.length; j++) {
    if (src[j] === '(') paren++;
    else if (src[j] === ')') { paren--; if (!paren) break; }
  }
  let depth = 0;
  let i = src.indexOf('{', j);
  const from = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (!depth) return src.slice(from, i + 1); }
  }
  throw new Error('unbalanced braces in ' + name);
}

/* ================= Code.gs harness ================= */

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
    hideSheet() {},
    isSheetHidden() { return false; },
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
    PAYMENT_COLUMNS, PAYMENTS_SHEET, PAYMENT_TEXT_COLUMNS, COVERAGE_MAX_DAYS,
    readSheet: (sh, cols) => readSheet_(sh, cols),
    handle: (params) => handle_(params).json,
    ensure: (name, cols) => getOrCreateSheet_(name, cols),
    upsert: (p, user) => upsertPayment_(p, user),
    PAYMENT_VOID_STATUS, PAYMENT_VOID_REVERSERS,
    isVoidStatus: (v) => isVoidStatus_(v),
    paymentStatus: (v) => paymentStatus_(v),
    PAYMENT_LINK_STATUSES, PAYMENT_LINK_NOTE_MAX, PAYMENT_LINK_UID_MAX,
    PAYMENT_SERVER_COLUMNS, PATIENTS_SHEET, PATIENT_COLUMNS,
    AUDIT_LOG_SHEET, AUDIT_LOG_COLUMNS,
    uidClean: (v) => paymentLinkUidClean_(v),
    noteClean: (v) => paymentLinkNoteClean_(v),
    statusClean: (v) => paymentLinkStatusClean_(v),
    patientKey_: (h, n, d) => patientKey_(h, n, d),
  };`;
  vm.createContext(sandbox);
  vm.runInContext(GS_SRC + epilogue, sandbox);
  return { code: sandbox.__test, sandbox };
}



/* ================= fixtures — the three live pairs ================= */

const patient = (over) => app.normalizePatient(Object.assign({
  id: 'id-amit', houseId: 'arfoni', name: 'עמית בורנשטיין',
  date: '2026-09-07', pay: 30000, status: 'active', exitDate: '',
}, over || {}));

/* The SURVIVING row: attached to the current patient, money intact. */
const original = (over) => app.normalizePayment(Object.assign({
  id: 'pay::arfoni::עמית בורנשטיין::2026-09-07::2026-09-07',
  patientId: 'arfoni::עמית בורנשטיין::2026-09-07', patientUid: 'id-amit',
  patientName: 'עמית בורנשטיין', houseId: 'arfoni', dueDate: '2026-09-07',
  amount: 30000, amountPaid: 30000, balance: 0, status: 'paid',
}, over || {}));

/* The DUPLICATE: same money, recorded under the pre-rename name. */
const dupe = (over) => app.normalizePayment(Object.assign({
  id: 'pay::arfoni::עמית יעקובי::2026-09-07::2026-09-07',
  patientId: 'arfoni::עמית יעקובי::2026-09-07', patientUid: '',
  patientName: 'עמית יעקובי', houseId: 'arfoni', dueDate: '2026-09-07',
  amount: 30000, amountPaid: 30000, balance: 0, status: 'paid',
}, over || {}));

/* The same row after Sandra marks it. */
const voided = (over) => dupe(Object.assign({
  status: 'void', linkStatus: 'duplicate',
  linkNote: 'כפילות של pay::arfoni::עמית בורנשטיין::2026-09-07::2026-09-07',
  linkedBy: 'ורד', linkedAt: '2026-09-22T14:03:11+03:00',
}, over || {}));

const build = (over) => app.buildMonthlyRevenue(Object.assign({
  month: '2026-09', patients: [], payments: [], credits: [], overrides: [],
  today: '2026-10-20',
}, over || {}));

/* overduePatients / patientsNeedingRenewal read module state; set, call, restore. */
function withState(patients, payments, fn) {
  const pp = app.state.patients, py = app.state.payments;
  app.state.patients = patients; app.state.payments = payments;
  try { return fn(); } finally { app.state.patients = pp; app.state.payments = py; }
}

/* ================= A. void is a real status ================= */

test('A: "void" survives the round-trip — it is aliased, not unknown', () => {
  /* normalizePayment maps an UNRECOGNIZED status to 'unpaid'. Without the
   * alias, a void row read back from the sheet would silently un-void itself
   * and its money would walk back into every figure. */
  assert.equal(app.normalizePayment({ status: 'void' }).status, 'void');
  assert.equal(app.normalizePayment({ status: 'מבוטל' }).status, 'void');
  assert.equal(app.normalizePayment({ status: 'לא-קיים' }).status, 'unpaid',
    'the unknown-status fallback is still there — that is why the alias matters');
  const { code } = loadCode();
  assert.equal(code.paymentStatus('void'), 'void', 'and the SERVER agrees');
  assert.equal(code.paymentStatus('מבוטל'), 'void');
  assert.ok(code.isVoidStatus('void') && !code.isVoidStatus('paid'));
});

test('A: void is NOT one of the three statuses a recorder can pick', () => {
  /* Voiding is a decision taken against a named original, with a reason, on
   * the שיוך תשלומים screen — never a fourth dropdown option one click away
   * from "לא שולם". */
  assert.deepEqual(plain(app.PAYMENT_STATUS.map((x) => x.id)), ['paid', 'partial', 'unpaid']);
  assert.ok(!app.PAYMENT_STATUS.some((x) => x.id === 'void'));
  // The row still renders it, pinned on and disabled, rather than falling back
  // to whichever option happens to be first.
  const row = fnSource(APP, 'buildBillingRow');
  assert.match(row, /const isVoid = isVoidPayment\(payment\);/);
  assert.match(row, /\? \[\{ id: PAYMENT_VOID_STATUS, label: PAYMENT_VOID_LABEL \}\]\.concat\(PAYMENT_STATUS\)/);
  assert.match(row, /state\.mode === 'edit' && !isVoid \? '' : 'disabled'/);
  assert.match(row, /badge void/);
});

test('A: ONE predicate, and every figure asks it', () => {
  assert.equal(app.isVoidPayment(voided()), true);
  assert.equal(app.isVoidPayment(original()), false);
  assert.equal(app.isVoidPayment(null), false);
  assert.equal((APP.match(/^function isVoidPayment\s*\(/gm) || []).length, 1,
    'declared exactly once — app.js is one flat script scope');
  /* Named, so a new consumer that forgets it is findable by grep rather than
   * by a wrong number on a screen. */
  for (const consumer of ['buildMonthlyRevenue', 'suggestCredits', 'renderBilling',
                          'renderBillingOpenList', 'renderBillingMonthlySummary',
                          'paymentCoversCycle', 'buildBillingRow', 'detachedPayments']) {
    assert.match(fnSource(APP, consumer), /isVoidPayment\(/, consumer + ' must ask');
  }
});

/* ================= B. excluded from הכנסות חודשיות ================= */

test('B: a voided duplicate is worth NOTHING on the revenue screen', () => {
  const p = patient();
  /* The 7 Sep cycle covers 7 Sep – 6 Oct: 24 of its 30 days fall in September,
   * so each ₪30,000 row is worth ₪24,000 to this month. */
  const share = app.roundMoney(30000 * 24 / 30);
  const both = build({ patients: [p], payments: [original(), dupe()] });
  assert.equal(both.received.inclVat, app.roundMoney(share * 2),
    'before the void, the money is counted twice');

  const fixed = build({ patients: [p], payments: [original(), voided()] });
  assert.equal(fixed.received.inclVat, share, 'after it, once');
  assert.equal(fixed.received.rows.length, 1);
  assert.equal(fixed.received.rows[0].paymentId, original().id);
  assert.equal(fixed.expected.inclVat, 0, 'and it does not reappear as expected');
  assert.equal(fixed.net.inclVat, share);
  // Not in the per-house breakdown either.
  const house = fixed.byHouse.find((b) => b.house === 'קיסריה עפרוני');
  assert.equal(house.received.inclVat, share);
});

test('B: a void row does not CLAIM its cycle — the surviving twin does', () => {
  /* The billed-cycle index is what stops the projected pass double-counting.
   * A void row must not sit in it: if the only row for a cycle was voided,
   * that cycle genuinely has no payment behind it. */
  const p = patient();
  const withTwin = build({ patients: [p], payments: [original(), voided()] });
  assert.equal(withTwin.expected.rows.filter((r) => r.dueDate === '2026-09-07').length, 0,
    'the surviving row still claims the cycle');

  const alone = build({ patients: [p], payments: [voided()] });
  assert.equal(alone.received.inclVat, 0);
  const back = alone.expected.rows.find((r) => r.dueDate === '2026-09-07');
  assert.ok(back, 'voided alone, the cycle returns to the projected pass');
  assert.equal(back.kind, 'unbilled_past');
  assert.match(fnSource(APP, 'buildMonthlyRevenue'), /if \(!p \|\| isVoidPayment\(p\)\) return;/);
});

test('B: a voided payment refunds nothing — the credits ledger skips it', () => {
  /* suggestCredits divides amountPaid to compute a refund. Against a void row
   * it would refund a patient for money they never paid twice. */
  const p = patient({ id: 'id-dana', name: 'דנה כהן', date: '2026-09-01', pay: 30000 });
  const key = app.patientKey(p);
  const pay = (over) => app.normalizePayment(Object.assign({
    id: 'c1', patientId: key, patientName: 'דנה כהן', houseId: 'arfoni',
    dueDate: '2026-09-01', amount: 30000, amountPaid: 30000, balance: 0, status: 'paid',
  }, over || {}));
  /* Discharged on the 10th — a 9-day stay, under the detox tenure cutoff, so
   * the days-unused rule actually pays out and the void has something to
   * suppress. */
  const live = app.suggestCredits(p, '2026-09-10', [pay()]);
  assert.ok(live.some((c) => c.calculatedAmount > 0), 'a real payment does refund');
  const dead = app.suggestCredits(p, '2026-09-10', [pay({ status: 'void' })]);
  assert.ok(!dead.some((c) => c.calculatedAmount > 0), 'a void one does not');
});

/* ================= C. excluded from debt ================= */

test('C: the debt screens all step over a void row', () => {
  const rb = fnSource(APP, 'renderBilling');
  assert.match(rb, /const countableDue\s+= due\.filter\(d => !isPreRecordsCycle\(selected\) && !isVoidPayment\(d\.payment\)\);/);
  assert.match(rb, /const totalCollected = due\.filter\(d => !isVoidPayment\(d\.payment\)\)/,
    'נגבה too: a void row\'s amountPaid is the second copy of a sum already counted');

  const open = fnSource(APP, 'renderBillingOpenList');
  assert.match(open, /\.filter\(p => !isVoidPayment\(p\)/);

  const sum = fnSource(APP, 'renderBillingMonthlySummary');
  assert.match(sum, /const liveRows = thisMonth\.filter\(p => !isVoidPayment\(p\)\);/);
  assert.match(sum, /const collected\s+= liveRows\.reduce/);
  assert.match(sum, /const debtRows = liveRows\.filter/);
  assert.match(sum, /const rows = liveRows\.filter\(p => p\.houseId === h\.id\);/,
    'the per-house breakdown too');
  // …and it says how many rows it set aside, rather than silently shrinking.
  assert.match(sum, /const voidRows = thisMonth\.filter\(p => isVoidPayment\(p\)\);/);
  assert.match(sum, /לא נספרות כלל/);
});

test('C: the row is still LISTED — marked, not hidden', () => {
  /* The whole feature refuses to delete. A row that also vanished from every
   * screen would be indistinguishable from one that had been deleted. */
  const rb = fnSource(APP, 'renderBilling');
  assert.ok(!/const due = .*isVoidPayment/.test(rb), 'the void row is not filtered OUT of the list');
  assert.match(CSS, /\.badge\.void \{/);
  assert.match(CSS, /text-decoration: line-through/);
});

/* ================= D. excluded from alerts ================= */

test('D: a void row never silences an alert', () => {
  assert.equal(app.paymentCoversCycle(original()), true);
  assert.equal(app.paymentCoversCycle(voided()), false, 'even though its status WAS paid');
  assert.equal(app.paymentCoversCycle(dupe({ status: 'partial' })), true);
  assert.equal(app.paymentCoversCycle(null), false);
  // Both alerts read the one rule, so they cannot drift apart.
  assert.match(fnSource(APP, 'overduePatients'), /if \(paymentCoversCycle\(pay\)\) return;/);
  assert.match(fnSource(APP, 'patientsNeedingRenewal'), /if \(paymentCoversCycle\(pay\)\) return;/);
});

test('D: voiding the only payment for a cycle brings the overdue alert back', () => {
  const p = patient({ id: 'id-eran', name: 'ערן יצחק חונה', date: '2026-08-09', pay: 35000 });
  const key = app.patientKey(p);
  const paid = app.normalizePayment({
    id: app.paymentId(p, '2026-09-09'), patientId: key, patientName: p.name,
    houseId: 'arfoni', dueDate: '2026-09-09', amount: 35000, amountPaid: 35000,
    balance: 0, status: 'paid',
  });
  const silent = withState([p], [paid], () => app.overduePatients('2026-09-20'));
  assert.equal(silent.length, 0, 'a real payment silences it');

  const loud = withState([p], [Object.assign({}, paid, { status: 'void' })],
    () => app.overduePatients('2026-09-20'));
  assert.equal(loud.length, 1, 'a void one does not — the cycle is genuinely unpaid');
  assert.equal(loud[0].dueDate, undefined);
  assert.equal(loud[0].dueISO, '2026-09-09');

  // The renewal alert reads the same rule.
  const ren = withState([p], [Object.assign({}, paid, { status: 'void' })],
    () => app.patientsNeedingRenewal('2026-09-05', 7));
  assert.ok(ren.some((r) => r.renewalISO === '2026-09-09'));
});

/* ================= E. the decision, and its trail ================= */

test('E: the three live pairs are all recognised as double entries', () => {
  const cases = [
    { house: 'arfoni', old: 'ערן', now: 'ערן יצחק חונה', entry: '2026-08-09', due: '2026-08-09', amount: 35000, uid: 'id-eran' },
    { house: 'rehab', old: 'עדי', now: 'עדי עמית', entry: '2026-09-14', due: '2026-09-14', amount: 35000, uid: 'id-adi' },
    { house: 'arfoni', old: 'עמית יעקובי', now: 'עמית בורנשטיין', entry: '2026-09-07', due: '2026-09-07', amount: 30000, uid: 'id-amit' },
  ];
  cases.forEach((c) => {
    const p = patient({ id: c.uid, houseId: c.house, name: c.now, date: c.entry, pay: c.amount });
    const keep = app.normalizePayment({
      id: 'keep-' + c.uid, patientId: app.patientKey(p), patientUid: c.uid,
      patientName: c.now, houseId: c.house, dueDate: c.due,
      amount: c.amount, amountPaid: c.amount, balance: 0, status: 'paid',
    });
    const stray = app.normalizePayment({
      id: 'stray-' + c.uid, patientId: `${c.house}::${c.old}::${c.entry}`,
      patientName: c.old, houseId: c.house, dueDate: c.due,
      amount: c.amount, amountPaid: c.amount, balance: 0, status: 'paid',
    });
    // The stray is on the worklist, the survivor is not.
    assert.deepEqual(plain(app.detachedPayments([keep, stray], [p]).map((x) => x.id)),
      ['stray-' + c.uid], c.old);
    // The current patient is offered, carrying the double-entry warning.
    const cand = app.reconnectCandidates(stray, [p])[0];
    assert.ok(cand, c.old + ': a candidate is offered');
    assert.equal(cand.patient.id, c.uid);
    const dup = app.reconnectDoubleEntry(stray, p, [keep, stray]);
    assert.deepEqual(plain(dup.map((d) => d.id)), ['keep-' + c.uid], c.old + ': the original is named');
  });
});

test('E: THE ROW IS NEVER DELETED — the money stays on it, verbatim', () => {
  const before = dupe();
  const after = voided();
  for (const k of ['id', 'patientId', 'patientName', 'houseId', 'dueDate',
                   'amount', 'amountPaid', 'balance', 'coverageStart', 'coverageEnd']) {
    assert.deepEqual(after[k], before[k], k + ' must survive the void untouched');
  }
  assert.equal(after.status, 'void');
  /* The write path touches the status and the decision, and nothing else —
   * zeroing the amount would destroy the evidence that a second ₪30,000 was
   * ever entered, which is the one fact this record exists to preserve. */
  const src = fnSource(APP, 'markPaymentDuplicate');
  assert.match(src, /status: PAYMENT_VOID_STATUS,/);
  assert.match(src, /linkStatus: 'duplicate',/);
  assert.match(src, /await savePayment\(/, 'the ONE payment write path');
  for (const money of ['amount:', 'amountPaid:', 'balance:', 'coverageStart:']) {
    assert.ok(!src.includes(money), 'a void must not touch ' + money);
  }
  // It refuses the degenerate cases rather than writing something meaningless.
  assert.match(src, /if \(original\.id === pay\.id\)/);
  assert.match(src, /if \(!reason\)/);
});

test('E: the note names the original, so the pair survives this screen', () => {
  const note = app.duplicateVoidNote(dupe(), original(), patient());
  assert.match(note, /כפילות של pay::arfoni::עמית בורנשטיין::2026-09-07::2026-09-07/);
  assert.match(note, /עמית בורנשטיין/);
  /* DD/MM/YYYY — the app-wide people-facing format (PR #143). The note is
   * read by a person, so it follows the same rule as every other date on
   * screen; the row IDS beside it keep their ISO, because those are keys. */
  assert.match(note, /07\/09\/2026/);
  assert.match(note, /30,000/);
});

test('E: the server refuses a void that carries no decision, and vice versa', () => {
  const { code } = loadCode();
  const post = (over) => Object.assign({
    id: 'p1', patientId: 'arfoni::עמית יעקובי::2026-09-07', patientName: 'עמית יעקובי',
    houseId: 'arfoni', dueDate: '2026-09-07', amount: 30000, amountPaid: 30000,
    balance: 0, status: 'paid',
  }, over);

  const bare = code.upsert(post({ status: 'void' }), 'ורד');
  assert.equal(bare.ok, false);
  assert.match(bare.error, /מחייב סימון ככפילות/);

  const noStatus = code.upsert(post({ linkStatus: 'duplicate', linkNote: 'x' }), 'ורד');
  assert.equal(noStatus.ok, false);
  assert.match(noStatus.error, /סטטוס מבוטל/);

  const noNote = code.upsert(post({ status: 'void', linkStatus: 'duplicate' }), 'ורד');
  assert.equal(noNote.ok, false);
  assert.match(noNote.error, /סיבה/);

  const good = code.upsert(post({ status: 'void', linkStatus: 'duplicate', linkNote: 'כפילות של p0' }), 'ורד');
  assert.equal(good.ok, true);
  assert.equal(good.payment.status, 'void');
  assert.equal(good.payment.linkedBy, 'ורד', 'who — from the signed session cookie');
  assert.match(good.payment.linkedAt, /^\d{4}-\d{2}-\d{2}/, 'and when');
  assert.equal(good.payment.amountPaid, 30000, 'the money is still on the row');
});

test('E: the void is written to the AuditLog', () => {
  const { code, sandbox } = loadCode();
  code.upsert({
    id: 'p1', patientId: 'arfoni::עמית יעקובי::2026-09-07', patientName: 'עמית יעקובי',
    houseId: 'arfoni', dueDate: '2026-09-07', amount: 30000, amountPaid: 30000,
    balance: 0, status: 'void', linkStatus: 'duplicate', linkNote: 'כפילות של p0',
  }, 'ורד');
  const log = sandbox.__sheets[code.AUDIT_LOG_SHEET];
  assert.ok(log, 'the AuditLog sheet was written');
  const cols = arr(code.AUDIT_LOG_COLUMNS);
  const row = log.grid[log.grid.length - 1];
  assert.equal(row[cols.indexOf('action')], 'payment_link_duplicate');
  const details = JSON.parse(row[cols.indexOf('details')]);
  assert.equal(details.paymentId, 'p1');
  assert.equal(details.amount, 30000);
  assert.equal(details.note, 'כפילות של p0');
  assert.equal(details.by, 'ורד');
});

/* ================= F. reversible by Sandra only ================= */

test('F: the SERVER refuses an un-void from anyone else', () => {
  const { code } = loadCode();
  assert.deepEqual(plain(arr(code.PAYMENT_VOID_REVERSERS)), ['סנדרה']);
  const base = {
    id: 'p1', patientId: 'arfoni::עמית יעקובי::2026-09-07', patientName: 'עמית יעקובי',
    houseId: 'arfoni', dueDate: '2026-09-07', amount: 30000, amountPaid: 30000, balance: 0,
  };
  code.upsert(Object.assign({}, base, {
    status: 'void', linkStatus: 'duplicate', linkNote: 'כפילות של p0',
  }), 'ורד');

  const refused = code.upsert(Object.assign({}, base, { status: 'paid' }), 'ורד');
  assert.equal(refused.ok, false);
  assert.match(refused.error, /לסנדרה בלבד/);

  const allowed = code.upsert(Object.assign({}, base, { status: 'paid' }), 'סנדרה');
  assert.equal(allowed.ok, true);
  assert.equal(allowed.payment.status, 'paid');
  /* The stamping user comes from requestUser_ — the signed session cookie —
   * so "Sandra only" cannot be claimed by a hand-built request body. */
  assert.match(GS_SRC, /upsertPayment_\(payment, requestUser_\(params\)\)/);
  assert.match(fnSource(GS_SRC, 'upsertPayment_'),
    /PAYMENT_VOID_REVERSERS\.indexOf\(stampUser\) < 0/);
});

test('F: the reversal gets its own audit row', () => {
  const { code, sandbox } = loadCode();
  const base = {
    id: 'p1', patientId: 'arfoni::עמית יעקובי::2026-09-07', patientName: 'עמית יעקובי',
    houseId: 'arfoni', dueDate: '2026-09-07', amount: 30000, amountPaid: 30000, balance: 0,
  };
  code.upsert(Object.assign({}, base, {
    status: 'void', linkStatus: 'duplicate', linkNote: 'כפילות של p0',
  }), 'ורד');
  code.upsert(Object.assign({}, base, { status: 'paid' }), 'סנדרה');

  const log = sandbox.__sheets[code.AUDIT_LOG_SHEET];
  const cols = arr(code.AUDIT_LOG_COLUMNS);
  const actions = log.grid.slice(1).map((r) => r[cols.indexOf('action')]);
  assert.ok(actions.indexOf('payment_void_reversed') >= 0,
    'un-voiding is searchable on its own, not as a link decision filtered by what it used to be');
  const row = log.grid.find((r) => r[cols.indexOf('action')] === 'payment_void_reversed');
  const details = JSON.parse(row[cols.indexOf('details')]);
  assert.equal(details.by, 'סנדרה');
  assert.equal(details.restoredStatus, 'paid');
  assert.equal(details.previousNote, 'כפילות של p0');
});

test('F: the CLIENT only offers the control to a permitted user', () => {
  assert.deepEqual(plain(app.PAYMENT_VOID_REVERSERS), ['סנדרה']);
  const prev = app.state.sessionUser;
  try {
    app.state.sessionUser = 'ורד';
    assert.equal(app.canReverseVoid(), false);
    app.state.sessionUser = 'סנדרה';
    assert.equal(app.canReverseVoid(), true);
    app.state.sessionUser = ' סנדרה ';
    assert.equal(app.canReverseVoid(), true, 'trimmed, like every other name in this app');
  } finally { app.state.sessionUser = prev; }

  const render = fnSource(APP, 'renderReconnect');
  assert.match(render, /if \(canReverseVoid\(\)\) \{/);
  /* Everyone else is told WHOM to ask rather than handed a button that will be
   * refused — the repo's own idiom (meeting-report.js: "פנו לסנדרה"). */
  assert.match(render, /לביטול הסימון — פנו לסנדרה/);
  assert.match(fnSource(APP, 'reversePaymentVoid'), /if \(!canReverseVoid\(\)\)/);
  // The restored status is derived from the money the row still carries.
  assert.equal(app.statusFromAmounts({ amount: 30000, amountPaid: 30000 }), 'paid');
  assert.equal(app.statusFromAmounts({ amount: 30000, amountPaid: 10000 }), 'partial');
  assert.equal(app.statusFromAmounts({ amount: 30000, amountPaid: 0 }), 'unpaid');
});

/* ================= G. the UI ================= */

test('G: כפילות leads exactly where the double-entry warning is', () => {
  const row = fnSource(APP, 'buildReconnectRow');
  assert.match(row, /\$\{dup\.length \? `<button class="btn small primary cand-dup"/);
  assert.match(row, /class="btn small \$\{dup\.length \? '' : 'primary'\} cand-link"/);
  /* שייך is offered, never removed: the pair CAN be a rename whose first row
   * was simply never linked, and only a person knows which. */
  assert.match(row, /line\.querySelector\('\.cand-link'\)\.onclick/);
  assert.match(row, /dupBtn\.onclick = \(\) => showDuplicateConfirm\(\{/);
  assert.match(row, /original: dup\[0\]/);
});

test('G: the original is shown SIDE BY SIDE before anything is written', () => {
  const src = fnSource(APP, 'showDuplicateConfirm');
  assert.match(src, /duplicatePanelHtml\(pay, 'תסומן ככפילות', 'dup-void'\)/);
  assert.match(src, /duplicatePanelHtml\(original, 'המקור שנשאר', 'dup-keep'\)/);
  // The fields that decide it, in the same order on both sides.
  const panel = fnSource(APP, 'duplicatePanelHtml');
  for (const field of ['שם כפי שנרשם', 'בית', 'תאריך לתשלום', 'סכום', 'שולם בפועל', 'סטטוס']) {
    assert.ok(panel.includes(field), 'missing comparison field: ' + field);
  }
  assert.match(panel, /מזהה שורה/);
  assert.match(panel, /שיוך מאוחסן/);
  // And it flags the two ways a "duplicate" might not be one.
  assert.match(src, /sameAmount \?/);
  assert.match(src, /sameMonth \?/);
  assert.match(src, /שום שורה אינה נמחקת/);
  assert.match(CSS, /\.dup-compare \{/);
  assert.match(CSS, /\.dup-panel\.dup-void \{/);
  assert.match(CSS, /\.dup-panel\.dup-keep \{/);
});

test('G: a decided row leaves the worklist but stays on the screen', () => {
  const p = patient();
  assert.deepEqual(plain(app.detachedPayments([original(), voided()], [p])), [],
    'a voided row is decided, not a loose end');
  assert.deepEqual(plain(arr(app.RECONNECT_DECIDED_STATUSES)), ['not_a_patient', 'duplicate']);
  const render = fnSource(APP, 'renderReconnect');
  assert.match(render, /const voided = state\.payments\.filter\(p => p && isVoidPayment\(p\)\);/);
  assert.match(render, /סומנו ככפילות/);
  assert.match(render, /escapeHtml\(pay\.linkNote \|\| ''\)/);
  assert.match(render, /escapeHtml\(pay\.linkedBy \|\| '—'\)/);
});

/* ================= H. scope + security ================= */

test('H: no new endpoint, and nothing here moves money', () => {
  assert.ok(!SERVER.includes('void'), 'the proxy learned nothing');
  const dispatch = GS_SRC.slice(GS_SRC.indexOf('function handle_'), GS_SRC.indexOf('function handle_') + 6000);
  const payActions = Array.from(new Set((dispatch.match(/action === '(\w+)'/g) || [])
    .filter((a) => /Payment/i.test(a))));
  assert.deepEqual(plain(payActions.sort()), [
    "action === 'accountingPayments'",
    "action === 'getPayments'", "action === 'savePayment'", "action === 'updatePayment'",
  ].sort());
  for (const name of ['markPaymentDuplicate', 'reversePaymentVoid']) {
    assert.match(fnSource(APP, name), /savePayment\(/, name + ' must use the one write path');
    assert.ok(!fnSource(APP, name).includes('apiPost('), name + ' must not post directly');
  }
  // The pure readers are pure.
  for (const name of ['isVoidPayment', 'paymentCoversCycle', 'statusFromAmounts', 'duplicateVoidNote']) {
    const src = fnSource(APP, name);
    for (const writer of ['savePayment', 'apiPost', 'state.payments =', 'localStorage']) {
      assert.ok(!src.includes(writer), name + ' must not ' + writer);
    }
  }
});

test('H: everything the new UI interpolates is escaped, and none of it is static', () => {
  const panel = fnSource(APP, 'duplicatePanelHtml');
  assert.match(panel, /escapeHtml\(String\(v\)\)/);
  assert.match(panel, /escapeHtml\(k\)/);
  assert.match(panel, /escapeHtml\(pay\.id \|\| '—'\)/);
  assert.match(panel, /escapeHtml\(pay\.patientId \|\| '—'\)/);
  assert.match(fnSource(APP, 'showDuplicateConfirm'), /escapeHtml\(PAYMENT_VOID_LABEL\)/);
  assert.match(fnSource(APP, 'buildBillingRow'), /escapeHtml\(PAYMENT_VOID_LABEL\)/);
  /* The note is set as a VALUE, never interpolated into markup — it is
   * pre-filled from data and then edited by hand. */
  assert.match(fnSource(APP, 'showDuplicateConfirm'), /noteEl\.value = duplicateVoidNote\(/);
  assert.ok(!INDEX.includes('dup-compare'), 'the modal is built by the renderer');
  assert.ok(!INDEX.includes('badge void'));
});

test('H: the input rows are never mutated by any of this', () => {
  const a = dupe(), b = original(), p = patient();
  const before = JSON.stringify([a, b, p]);
  app.isVoidPayment(a);
  app.paymentCoversCycle(a);
  app.duplicateVoidNote(a, b, p);
  app.reconnectDoubleEntry(a, p, [a, b]);
  app.detachedPayments([a, b], [p]);
  build({ patients: [p], payments: [a, b] });
  assert.equal(JSON.stringify([a, b, p]), before, 'byte-identical afterwards');
});
