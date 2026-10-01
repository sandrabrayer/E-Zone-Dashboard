/* DETACHED PAYMENTS — the durable link, and the tool for the ones already lost.
 *
 * THE PROBLEM. A payment is attached to a patient by houseId::name::entryDate.
 * ANY change to any of the three detaches it, silently and permanently. The
 * live sheet holds six proofs:
 *
 *   "שחר חיון " (trailing space)      07/09  ₪35,000  עפרוני
 *   "עמית יעקובי"                      07/09  ₪30,000  עפרוני — attached to
 *     nobody, while עמית בורנשטיין (עפרוני, entered 7.9) has his OWN ₪30,000
 *     that same day. A rename, or a double entry — and only a person knows.
 *   "אביב שבתאי" (invisible chars)     13/07  ₪18,000  ריהאב
 *   "ערן"                              09/08  ₪35,000  עפרוני
 *   "עדי"                              14/09  ₪35,000  ריהאב
 *   נועם אשבל — moved ריהאב → הפרדס; her payment stayed on the ריהאב record.
 *
 * Locked contracts:
 *   - patientUid (the PERSISTED Patients id) is appended to PAYMENT_COLUMNS,
 *     stamped on every new payment row, and matched FIRST — so a rename or a
 *     house transfer cannot detach a row;
 *   - names are trimmed at EVERY write, client and server;
 *   - the triple is still read as a fallback, exactly and then normalized, so
 *     a row already holding "שחר חיון " keeps matching;
 *   - NOTHING reconnects automatically. The engine ranks candidates, the
 *     screen presents them, a person decides;
 *   - a reconnection writes patientUid and is logged with WHO and WHEN, both
 *     stamped server-side from the signed session cookie;
 *   - a double entry is WARNED about, never blocked;
 *   - the backfill writes a uid ONLY where the triple names exactly one
 *     current patient. Everything else goes to the reconnect screen.
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
      state, trimName, normalizeNameForMatch, patientUid, paymentPatientUid,
      patientKey, patientMatchKey, patientMatchKeyOf, patientMatchKeyFromId,
      matchPatientForPayment, PAYMENT_MATCH_TIERS,
      findPatientForPaymentIn, detachedPayments, reconnectCandidates,
      namesLookAlike, reconnectDoubleEntry, planPatientUidBackfill,
      withPatientUid, normalizePayment, normalizePatient,
      paymentForPatientOnDate, buildMonthlyRevenue, monthKey, isoDate,
      PAYMENT_LINK_STATUSES, PAYMENT_LINK_NOTE_MAX, NAME_INVISIBLES,
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


/* ================= fixtures — the live sheet's own rows ================= */

const patient = (over) => app.normalizePatient(Object.assign({
  id: 'id-amit', houseId: 'arfoni', name: 'עמית בורנשטיין',
  date: '2026-09-07', pay: 30000, status: 'active', exitDate: '',
}, over || {}));

/* A payment as the SHEET holds it — deliberately NOT normalized, so a test can
 * plant the exact malformed value the live row carries. */
const payment = (over) => Object.assign({
  id: 'pay::arfoni::עמית בורנשטיין::2026-09-07::2026-09-07',
  patientId: 'arfoni::עמית בורנשטיין::2026-09-07',
  patientName: 'עמית בורנשטיין', houseId: 'arfoni', dueDate: '2026-09-07',
  amount: 30000, amountPaid: 30000, status: 'paid', balance: 0,
  patientUid: '', linkPatientUid: '', linkStatus: '', linkNote: '',
  linkedBy: '', linkedAt: '',
}, over || {});

/* ================= A. prevention — trimming ================= */

test('A: a patient name is TRIMMED at every write — the client side', () => {
  assert.equal(app.normalizePatient({ name: ' שחר חיון ', houseId: 'arfoni', date: '2026-09-07' }).name,
    'שחר חיון');
  assert.match(fnSource(APP, 'normalizePatient'), /trimName\(pickField\(p, \['name'/);
  /* normalizePatient is on EVERY patient path — the add form, the edit form,
   * the lead promotion and every saveAll echo — so trimming there covers all
   * of them at once rather than one form at a time. */
  assert.equal(app.trimName('  '), '');
  assert.equal(app.trimName(null), '');
  // Only the ENDS. Nothing inside somebody's recorded name is touched.
  assert.equal(app.trimName(' דנה  כהן '), 'דנה  כהן');
});

test('A: and the SERVER side, which is the authority', () => {
  const { code } = loadCode();
  /* This matters more since PR #139: patientUidIndexByKey_() builds its index
   * from the TRIMMED key while a payment row holds the untrimmed one, so a
   * stray space is precisely why the server's exact match leaves such a row
   * blank. Trimming what is stored removes the disagreement at the source. */
  assert.match(fnSource(GS_SRC, 'replaceHousePatients_'),
    /withHouse\.name = String\(withHouse\.name == null \? '' : withHouse\.name\)\.trim\(\);/);
  /* patientKey_() has ALWAYS trimmed, while the client's patientKey() did not
   * — that disagreement is how a payment row came to hold
   * "…::שחר חיון ::…" while the server's key for the same row was
   * "…::שחר חיון::…". Both sides trim now, so there is nothing left to
   * disagree about. */
  assert.equal(code.patientKey_('arfoni', ' שחר חיון ', '2026-09-07'),
    code.patientKey_('arfoni', 'שחר חיון', '2026-09-07'));
  assert.equal(app.patientKey({ houseId: 'arfoni', name: ' שחר חיון ', date: '2026-09-07' }),
    code.patientKey_('arfoni', ' שחר חיון ', '2026-09-07'),
    'client and server compute the SAME key for the same row');
});

/* ================= B. the durable link ================= */

test('B: the five LINK columns are appended, text-forced, and do not duplicate #139', () => {
  const { code } = loadCode();
  const cols = arr(code.PAYMENT_COLUMNS);
  assert.deepEqual(cols.slice(0, 19), [
    'id', 'patientId', 'patientName', 'houseId', 'dueDate',
    'amount', 'status', 'amountPaid', 'balance', 'timestamp',
    'coverageStart', 'coverageEnd',
    'paymentUid', 'patientUid', 'payerUid',
    'chargedAt', 'chargedBy', 'sourceUpdatedAt', 'sourceVersion',
  ], 'position IS the data contract — nothing before the append moved');
  assert.deepEqual(cols.slice(19),
    ['linkPatientUid', 'linkStatus', 'linkNote', 'linkedBy', 'linkedAt']);
  /* ONE patientUid, not two. PR #139 already put the persisted patient id on
   * the payment row; this change REUSES it and adds the manual decision
   * beside it. A second column of the same name would be a data-contract
   * disaster on a sheet read by position. */
  assert.equal(cols.filter((c) => c === 'patientUid').length, 1);
  /* Text-forced, for the same reason patientUid is: an opaque id that looks
   * like a date or a long number is coerced by Sheets. */
  for (const c of ['linkPatientUid', 'linkStatus', 'linkNote', 'linkedBy', 'linkedAt']) {
    assert.ok(arr(code.PAYMENT_TEXT_COLUMNS).indexOf(c) >= 0, c + ' must be text-forced');
  }
  /* The DECISION is the client's to send; its provenance never is. */
  const serverOwned = arr(code.PAYMENT_SERVER_COLUMNS);
  assert.ok(serverOwned.indexOf('linkedBy') >= 0);
  assert.ok(serverOwned.indexOf('linkedAt') >= 0);
  assert.ok(serverOwned.indexOf('patientUid') >= 0, 'still #139\'s to resolve');
  assert.ok(serverOwned.indexOf('linkPatientUid') < 0, 'but the decision is not');
});

test('B: a new payment row is born with a TRIMMED triple, and claims no uid', () => {
  /* patientUid is SERVER-OWNED (PR #139): it is resolved from the triple on
   * write. What the client can do is make sure the triple it hands over is
   * the same one the server's index is built from — i.e. trimmed. */
  const prev = app.state.patients;
  app.state.patients = [app.normalizePatient({
    id: 'id-amit', houseId: 'arfoni', name: ' עמית בורנשטיין ', date: '2026-09-07', pay: 30000,
  })];
  try {
    const p = app.state.patients[0];
    const pay = app.paymentForPatientOnDate(p, '2026-10-07');
    assert.equal(pay.patientId, 'arfoni::עמית בורנשטיין::2026-09-07', 'no stray space in the key');
    assert.equal(pay.patientName, 'עמית בורנשטיין');
    assert.equal(pay.patientUid, '', 'the server resolves it, not the client');
  } finally { app.state.patients = prev; }
  assert.match(fnSource(APP, 'paymentForPatientOnDate'), /patientName: trimName\(patient\.name\)/);
  assert.match(fnSource(APP, 'savePayment'), /payment = withPatientUid\(payment, state\.patients\);/);
});

test('B: the uid is matched FIRST — a rename cannot detach the row', () => {
  const p = patient({ name: 'עמית בורנשטיין-לוי' });      // renamed
  const pay = payment({ patientUid: 'id-amit' });          // triple is now stale
  const m = app.matchPatientForPayment(pay, [p]);
  assert.ok(m, 'still attached');
  assert.equal(m.via, 'patientUid');
  assert.equal(m.patient.name, 'עמית בורנשטיין-לוי');
  // Without the uid the same row is lost — which is the bug, reproduced.
  assert.equal(app.matchPatientForPayment(payment(), [p]), null);
});

test('B: a HOUSE TRANSFER keeps the payments — the נועם אשבל case', () => {
  /* נועם moved ריהאב → הפרדס and her payment stayed behind on the ריהאב
   * record. With a uid on the row, the house is not part of the link. */
  const before = patient({ id: 'id-noam', name: 'נועם אשבל', houseId: 'rehab', date: '2026-07-14' });
  const after = patient({ id: 'id-noam', name: 'נועם אשבל', houseId: 'pardes', date: '2026-07-14' });
  const pay = payment({
    id: 'pay-noam', patientUid: 'id-noam', houseId: 'rehab',
    patientId: app.patientKey(before), patientName: 'נועם אשבל', dueDate: '2026-07-14',
  });
  assert.equal(app.matchPatientForPayment(pay, [before]).patient.houseId, 'rehab');
  const m = app.matchPatientForPayment(pay, [after]);
  assert.ok(m, 'the transfer did not detach it');
  assert.equal(m.via, 'patientUid');
  assert.equal(m.patient.houseId, 'pardes');
  // And without the uid it IS detached — the bug as reported.
  assert.equal(app.matchPatientForPayment(Object.assign({}, pay, { patientUid: '' }), [after]), null);
});

test('B: a TRAILING-SPACE name still matches — the שחר חיון row', () => {
  /* The row in the sheet: patientName and patientId both carry the space.
   * The patient's own name is now stored trimmed. No uid on the row — this is
   * a historical row, and it has to keep working without one. */
  const shachar = patient({ id: 'id-shachar', name: 'שחר חיון', date: '2026-09-07' });
  const pay = payment({
    id: 'pay-shachar', patientUid: '',
    patientId: 'arfoni::שחר חיון ::2026-09-07', patientName: 'שחר חיון ',
    amount: 35000, amountPaid: 35000,
  });
  const m = app.matchPatientForPayment(pay, [shachar]);
  assert.ok(m, 'the trailing space must not orphan the money');
  assert.equal(m.via, 'triple_loose');
  assert.equal(m.patient.id, 'id-shachar');
});

test('B: invisible characters do not orphan a row either — the אביב שבתאי row', () => {
  const aviv = patient({ id: 'id-aviv', houseId: 'rehab', name: 'אביב שבתאי', date: '2026-07-13' });
  // A zero-width joiner and a bidi mark, exactly the kind pasted text carries.
  const dirty = 'אביב‍שבתאי'.replace('‍', ' ‏');
  const pay = payment({
    id: 'pay-aviv', patientUid: '', houseId: 'rehab', dueDate: '2026-07-13',
    patientId: 'rehab::' + dirty + '::2026-07-13', patientName: dirty, amount: 18000,
  });
  assert.equal(app.normalizeNameForMatch(dirty), 'אביב שבתאי');
  const m = app.matchPatientForPayment(pay, [aviv]);
  assert.ok(m, 'got null for ' + JSON.stringify(dirty));
  assert.equal(m.via, 'triple_loose');
  /* MATCHING ONLY. What is STORED keeps every character it had — stripping
   * characters out of somebody's recorded name is a data edit, not a
   * comparison. */
  assert.equal(app.normalizePayment(pay).patientName, dirty);
});

test('B: the four tiers are tried in order, and ambiguity is never guessed at', () => {
  assert.deepEqual(plain(app.PAYMENT_MATCH_TIERS),
    ['patientUid', 'triple_exact', 'triple_loose', 'house_name']);
  const a = patient({ id: 'id-a', name: 'עדי לוי', date: '2026-09-14' });
  const b = patient({ id: 'id-b', name: 'עדי לוי', date: '2026-09-14' });   // same triple!
  const pay = payment({ patientUid: '', patientId: app.patientKey(a), patientName: 'עדי לוי' });
  assert.equal(app.matchPatientForPayment(pay, [a, b]), null,
    'two patients normalize to one triple — a guess would put the money on the wrong ledger');
  // One of them, and it matches exactly.
  assert.equal(app.matchPatientForPayment(pay, [a]).via, 'triple_exact');
  // A uid that names NOBODY does not fall through to a name match: the
  // decision has gone stale, and re-linking by name would be a silent guess.
  assert.equal(app.matchPatientForPayment(payment({ patientUid: 'id-gone' }), [patient()]), null);
});

test('B: ONE matching rule — the גבייה tab and the revenue screen share it', () => {
  assert.match(fnSource(APP, 'findPatientForPayment'), /matchPatientForPayment\(pay, state\.patients\)/);
  assert.match(fnSource(APP, 'findPatientForPaymentIn'), /matchPatientForPayment\(pay, patients\)/);
  for (const name of ['matchPatientForPayment', 'patientUid', 'paymentPatientUid',
                      'normalizeNameForMatch', 'trimName', 'detachedPayments',
                      'planPatientUidBackfill', 'reconnectCandidates']) {
    assert.equal((APP.match(new RegExp('^function\\s+' + name + '\\s*\\(', 'gm')) || []).length, 1,
      name + ' must be declared exactly once');
  }
  // The revenue screen really does follow a transferred patient's money.
  const after = patient({ id: 'id-noam', name: 'נועם אשבל', houseId: 'pardes', date: '2026-07-14' });
  const pay = payment({
    id: 'pay-noam', patientUid: 'id-noam', houseId: 'rehab', dueDate: '2026-07-14',
    patientId: 'rehab::נועם אשבל::2026-07-14', patientName: 'נועם אשבל',
    amount: 30000, amountPaid: 30000, status: 'paid',
  });
  assert.equal(app.findPatientForPaymentIn([after], pay).houseId, 'pardes');
});

/* ================= C. the reconnect tool ================= */

test('C: the detached list is exactly the rows nobody can place', () => {
  const amit = patient();
  const rows = [
    payment({ id: 'ok', patientUid: 'id-amit' }),                                   // linked
    payment({ id: 'eran', patientUid: '', patientId: 'arfoni::ערן::2026-08-09',
              patientName: 'ערן', dueDate: '2026-08-09', amount: 35000 }),          // detached
    payment({ id: 'done', patientUid: '', patientId: 'arfoni::החזר::2026-08-09',
              patientName: 'החזר ספק', linkStatus: 'not_a_patient',
              linkNote: 'החזר לספק, לא מטופל' }),                                    // decided
  ];
  assert.deepEqual(plain(app.detachedPayments(rows, [amit]).map((r) => r.id)), ['eran']);
  /* A row marked not_a_patient has been DECIDED — it is not a loose end, it
   * is a documented non-patient, and leaving it on the worklist forever would
   * train Sandra to ignore the worklist. */
});

test('C: candidates are ranked by real signals, and a bare house match is not one', () => {
  const amit = patient();                                                  // עפרוני, entered 7.9
  const other = patient({ id: 'id-other', name: 'דנה כהן', date: '2026-03-01' });   // same house only
  const pay = payment({
    id: 'yaakovi', patientUid: '', patientId: 'arfoni::עמית יעקובי::2026-09-07',
    patientName: 'עמית יעקובי', dueDate: '2026-09-07', amount: 30000,
  });
  const cands = app.reconnectCandidates(pay, [amit, other]);
  assert.equal(cands.length, 1, 'same-house-only is not a candidate — it would offer the whole house');
  assert.equal(cands[0].patient.id, 'id-amit');
  // The reasons are reported, so the screen shows WHY rather than a score.
  assert.ok(cands[0].reasons.indexOf('name') >= 0, 'עמית ~ עמית');
  assert.ok(cands[0].reasons.indexOf('entry_date') >= 0, 'due 07/09 vs entry 7.9');
  assert.ok(cands[0].reasons.indexOf('same_house') >= 0);
});

test('C: a single-word name finds its owner — the ערן and עדי rows', () => {
  const eranK = patient({ id: 'id-eran', name: 'ערן כהן', date: '2026-08-09' });
  const adi = patient({ id: 'id-adi', houseId: 'rehab', name: 'עדי לוי', date: '2026-09-14' });
  const eranPay = payment({
    id: 'eran', patientUid: '', patientName: 'ערן', dueDate: '2026-08-09',
    patientId: 'arfoni::ערן::2026-08-09', amount: 35000,
  });
  const adiPay = payment({
    id: 'adi', patientUid: '', houseId: 'rehab', patientName: 'עדי', dueDate: '2026-09-14',
    patientId: 'rehab::עדי::2026-09-14', amount: 35000,
  });
  assert.equal(app.reconnectCandidates(eranPay, [eranK, adi])[0].patient.id, 'id-eran');
  assert.equal(app.reconnectCandidates(adiPay, [eranK, adi])[0].patient.id, 'id-adi');
  // The prefix rule that makes it work, stated directly.
  assert.equal(app.namesLookAlike('ערן', 'ערן כהן'), true);
  assert.equal(app.namesLookAlike('עדי', 'עדי לוי'), true);
  assert.equal(app.namesLookAlike('ערן', 'עדי'), false);
  assert.equal(app.namesLookAlike('עמית יעקובי', 'עמית בורנשטיין'), true, 'a shared first name');
  assert.equal(app.namesLookAlike('', 'ערן'), false);
});

test('C: the עמית יעקובי / עמית בורנשטיין pair is WARNED about, not resolved', () => {
  /* עמית בורנשטיין already has his own ₪30,000 on 07/09. Linking the
   * "עמית יעקובי" row to him would give one patient two payments for one
   * cycle — a rename, or a double entry. The tool refuses to decide. */
  const amit = patient();
  const his = payment({ id: 'pay-amit', patientUid: 'id-amit', dueDate: '2026-09-07' });
  const stray = payment({
    id: 'pay-yaakovi', patientUid: '', patientName: 'עמית יעקובי',
    patientId: 'arfoni::עמית יעקובי::2026-09-07', dueDate: '2026-09-07',
  });
  const dup = app.reconnectDoubleEntry(stray, amit, [his, stray]);
  assert.equal(dup.length, 1);
  assert.equal(dup[0].id, 'pay-amit');
  // Same CYCLE, not same day: a stored due date that drifted a day or two
  // from the anchor is still that cycle.
  const drifted = Object.assign({}, his, { id: 'pay-drift', dueDate: '2026-09-09' });
  assert.equal(app.reconnectDoubleEntry(stray, amit, [drifted]).length, 1);
  // A different month is a different cycle, and no warning.
  const nextMonth = Object.assign({}, his, { id: 'pay-oct', dueDate: '2026-10-07' });
  assert.equal(app.reconnectDoubleEntry(stray, amit, [nextMonth]).length, 0);
  /* It is a WARNING, never a block. שייך is still offered on a flagged
   * candidate — the pair CAN be a rename whose first row was never linked —
   * it just steps down to secondary while כפילות leads. */
  const row = fnSource(APP, 'buildReconnectRow');
  assert.match(row, /ייתכן רישום כפול/);
  assert.match(row, /class="btn small \$\{dup\.length \? '' : 'primary'\} cand-link"/);
  assert.match(row, /dup\.length \? `<button class="btn small primary cand-dup"/,
    'and כפילות is the PRIMARY action exactly where the warning is');
  assert.ok(!/dup\.length \? ' disabled'/.test(row), 'a possible double entry must not block the link');
});

test('C: NOTHING reconnects automatically', () => {
  /* The engine ranks and the screen presents; every write is behind a click.
   * reconnectCandidates and detachedPayments are pure — no write path, no
   * savePayment, nothing. */
  for (const name of ['detachedPayments', 'reconnectCandidates', 'reconnectDoubleEntry',
                      'planPatientUidBackfill', 'namesLookAlike', 'matchPatientForPayment']) {
    const src = fnSource(APP, name);
    for (const writer of ['savePayment', 'apiPost', 'state.payments =', 'localStorage']) {
      assert.ok(!src.includes(writer), name + ' must not ' + writer);
    }
  }
  // The renderer never links on its own either — only the click handler does.
  const render = fnSource(APP, 'renderReconnect');
  assert.ok(!render.includes('reconnectPaymentToPatient'), 'rendering is not deciding');
  assert.match(fnSource(APP, 'buildReconnectRow'),
    /\.cand-link'\)\.onclick = e =>\s*\n\s*busyButton\(e\.currentTarget, 'save', \(\) => reconnectPaymentToPatient\(pay, c\.patient\)\)/);
});

test('C: "not a patient" REQUIRES a reason — client and server', () => {
  assert.match(fnSource(APP, 'markPaymentNotAPatient'), /if \(!reason\) \{ showError/);
  const { code } = loadCode();
  const res = code.upsert(payment({
    id: 'p-noreason', linkStatus: 'not_a_patient', linkNote: '   ',
  }), 'ורד');
  assert.equal(res.ok, false);
  assert.match(res.error, /סיבה/);
  /* And the mirror refusal: a link with no patient behind it is not a link.
   * Refused rather than silently downgraded, so a caller never believes it
   * recorded a decision the sheet does not hold. */
  const noUid = code.upsert(payment({ id: 'p-nouid', linkStatus: 'linked', linkPatientUid: '' }), 'ורד');
  assert.equal(noUid.ok, false);
  assert.match(noUid.error, /מזהה מטופל/);
  /* A dismissal with no reason is indistinguishable next year from a row
   * nobody ever looked at — which is the state this screen exists to end. */
});

/* ================= D. the writes ================= */

test('D: a reconnection writes the DECISION and NOTHING about the money', () => {
  const src = fnSource(APP, 'reconnectPaymentToPatient');
  assert.match(src, /linkPatientUid: uid,/);
  assert.ok(!/[^k]patientUid: uid/.test(src),
    'patientUid is the server\'s to resolve — the client sends the decision');
  assert.match(src, /linkStatus: 'linked',/);
  assert.match(src, /await savePayment\(/, 'the ONE payment write path');
  for (const money of ['amount:', 'amountPaid:', 'balance:', 'status:', 'coverageStart:']) {
    assert.ok(!src.includes(money), 'a reconnection must not touch ' + money);
  }
  // A patient with no persisted id cannot be linked to — there is nothing
  // durable to write, and writing a blank would be a silent no-op.
  assert.match(src, /if \(!uid\) \{ showError/);
});

test('D: WHO and WHEN are stamped by the SERVER, never by the caller', () => {
  const { code } = loadCode();
  const res = code.upsert(payment({
    id: 'p-link', linkPatientUid: 'id-amit', linkStatus: 'linked',
    linkedBy: 'מישהו אחר', linkedAt: '1999-01-01T00:00:00.000Z',
  }), 'ורד');
  assert.equal(res.ok, true);
  assert.equal(res.payment.linkedBy, 'ורד', 'from the signed session cookie, not the body');
  assert.notEqual(res.payment.linkedAt, '1999-01-01T00:00:00.000Z');
  /* israelTimestamp_ — the same stamp #139 writes to chargedAt, so the link
   * trail and the accounting trail read in one timezone. (The harness's
   * Utilities.formatDate stub truncates to the date; the shape is what is
   * being asserted, not the clock.) */
  assert.match(res.payment.linkedAt, /^\d{4}-\d{2}-\d{2}/);
  /* THE DECISION WINS over #139's automatic resolution: the reconnect screen
   * exists because the triple can be wrong, and a correction nobody may apply
   * is not a correction. */
  assert.equal(res.payment.patientUid, 'id-amit');
  // The dispatcher is what supplies the user, from requestUser_ — not the payload.
  assert.match(GS_SRC, /upsertPayment_\(payment, requestUser_\(params\)\)/);
  // An UNDECIDED row carries no stamps at all: blank means "nobody looked".
  const plainRes = code.upsert(payment({ id: 'p-plain' }), 'ורד');
  assert.equal(plainRes.payment.linkStatus, '');
  assert.equal(plainRes.payment.linkedBy, '');
  assert.equal(plainRes.payment.linkedAt, '');
  /* "Not a patient" CLEARS the automatic link. Leaving one on a row a person
   * declared is not a patient's money is exactly the wrong-ledger outcome
   * these columns exist to prevent — the one case where patientUid is not
   * immutable, and the decision that cleared it is recorded beside it. */
  const not = code.upsert(payment({
    id: 'p-not', linkStatus: 'not_a_patient', linkNote: 'החזר לספק',
  }), 'ורד');
  assert.equal(not.ok, true);
  assert.equal(not.payment.patientUid, '');
  assert.equal(not.payment.linkedBy, 'ורד');
});

test('D: every decision is logged to the AuditLog with who, when and what', () => {
  const { code, sandbox } = loadCode();
  code.upsert(payment({
    id: 'p-link', linkPatientUid: 'id-amit', linkStatus: 'linked',
  }), 'ורד');
  const log = sandbox.__sheets[code.AUDIT_LOG_SHEET];
  assert.ok(log, 'the AuditLog sheet was written');
  const cols = arr(code.AUDIT_LOG_COLUMNS);
  const row = log.grid[log.grid.length - 1];
  assert.equal(row[cols.indexOf('action')], 'payment_link_linked');
  assert.equal(row[cols.indexOf('patientId')], 'id-amit');
  const details = JSON.parse(row[cols.indexOf('details')]);
  assert.equal(details.paymentId, 'p-link');
  assert.equal(details.linkPatientUid, 'id-amit');
  assert.equal(details.by, 'ורד');
  assert.match(details.at, /^\d{4}-\d{2}-\d{2}/);
  /* The row's five columns hold the LATEST decision; the AuditLog holds the
   * history of them, and survives the payment row being edited again. */
  const before = log.grid.length;
  code.upsert(payment({ id: 'p-plain' }), 'ורד');
  assert.equal(log.grid.length, before, 'an ordinary payment save logs nothing');
});

test('D: the server sanitizes what it stores — nothing is trusted as sent', () => {
  const { code } = loadCode();
  assert.equal(code.uidClean('  id-amit  '), 'id-amit');
  assert.equal(code.uidClean('id\u0000-amit'), '', 'a control character is not an id');
  assert.equal(code.uidClean('x'.repeat(code.PAYMENT_LINK_UID_MAX + 1)), '');
  assert.equal(code.uidClean(null), '');
  assert.equal(code.statusClean('linked'), 'linked');
  assert.equal(code.statusClean('<script>'), '', 'off the enum — dropped, not stored');
  assert.equal(code.statusClean('LINKED'), '');
  assert.equal(code.noteClean('=HYPERLINK("http://x")'), 'HYPERLINK("http://x")',
    'a formula lead-in is stripped: the note is rendered and exported too');
  assert.equal(code.noteClean('a\nb'), 'a b');
  assert.equal(code.noteClean('x'.repeat(400)).length, code.PAYMENT_LINK_NOTE_MAX);
  // And through the real write path.
  const res = code.upsert(payment({
    id: 'p-dirty', linkPatientUid: 'id\u0001bad', linkStatus: 'whatever', linkNote: '=1+1',
  }), 'ורד');
  assert.equal(res.ok, true);
  assert.equal(res.payment.linkPatientUid, '');
  assert.equal(res.payment.linkStatus, '');
  assert.equal(res.payment.linkNote, '1+1');
});

/* ================= E. the backfill ================= */

test('E: the backfill plans ONLY unambiguous rows', () => {
  const amit = patient();
  const shachar = patient({ id: 'id-shachar', name: 'שחר חיון', date: '2026-09-07' });
  const twinA = patient({ id: 'id-t1', name: 'עדי לוי', date: '2026-09-14' });
  const twinB = patient({ id: 'id-t2', name: 'עדי לוי', date: '2026-09-14' });

  const rows = [
    payment({ id: 'exact' }),                                                       // triple_exact
    payment({ id: 'loose', patientId: 'arfoni::שחר חיון ::2026-09-07',
              patientName: 'שחר חיון ' }),                                          // triple_loose
    payment({ id: 'ambiguous', patientId: app.patientKey(twinA), patientName: 'עדי לוי' }),
    payment({ id: 'orphan', patientId: 'arfoni::ערן::2026-08-09', patientName: 'ערן' }),
    payment({ id: 'already', patientUid: 'id-amit' }),                              // has one
  ];
  const plan = app.planPatientUidBackfill(rows, [amit, shachar, twinA, twinB]);
  /* ONLY the normalized-triple row. The 'exact' one is PR #139's to resolve —
   * its server does that on write and by its own locked backfill over the
   * whole sheet — and planning it here would be a second writer racing the
   * first for no gain. */
  assert.deepEqual(plain(plan.map((x) => [x.payment.id, x.patient.id, x.via])), [
    ['loose', 'id-shachar', 'triple_loose'],
  ]);
  /* Everything else goes to the reconnect screen, where a person decides. The
   * ambiguous row is the point: two patients share one triple, and writing a
   * durable identity off a coin flip is worse than leaving it undecided. */
  const left = app.detachedPayments(rows, [amit, shachar, twinA, twinB]).map((r) => r.id);
  assert.ok(left.indexOf('orphan') >= 0);
  assert.ok(left.indexOf('ambiguous') >= 0);
});

test('E: a house+name-only match is NEVER backfilled', () => {
  /* The loose tier has no date in it. It is good enough to keep a row
   * READABLE on screen; it is not good enough to write a permanent identity
   * from, because two admissions of the same person are exactly the case it
   * cannot tell apart. */
  const p = patient({ id: 'id-x', name: 'ערן כהן', date: '2026-01-01' });
  const pay = payment({ id: 'byname', patientUid: '', patientId: 'garbage',
                        patientName: 'ערן כהן', houseId: 'arfoni' });
  assert.equal(app.matchPatientForPayment(pay, [p]).via, 'house_name', 'it still READS as attached');
  assert.deepEqual(plain(app.planPatientUidBackfill([pay], [p])), [], 'but it is not WRITTEN');
  assert.equal(app.withPatientUid(pay, [p]), pay, 'and savePayment records nothing either');
  /* Both gates say the same thing in the same words: only the normalized
   * triple — same house, same entry date, a name differing by a space or an
   * invisible character — is written without a person. */
  assert.match(fnSource(APP, 'withPatientUid'), /m\.via !== 'triple_loose'/);
  assert.match(fnSource(APP, 'planPatientUidBackfill'), /m\.via !== 'triple_loose'/);
});

test('E: the backfill runs ON DEMAND, never on load, and never overwrites', () => {
  /* A write that runs by itself when a screen opens is a write nobody chose —
   * and this one touches every historical payment row. The button says how
   * many rows it will change before it changes them. */
  const render = fnSource(APP, 'renderReconnect');
  assert.match(render, /backfillEl\.onclick = e =>[\s\S]{0,120}runPatientUidBackfill\(\)/,
    'it runs from a CLICK');
  assert.equal((render.match(/runPatientUidBackfill\(\)/g) || []).length, 1,
    'and from nowhere else in the renderer');
  assert.match(fnSource(APP, 'renderReconnect'), /השלמת שיוך ל־\$\{plan\.length\} שורות/);
  assert.ok(!fnSource(APP, 'renderAll').includes('runPatientUidBackfill'));
  // A uid already on a row is somebody's decision; only the screen may change it.
  const withUid = payment({ patientUid: 'id-other' });
  assert.equal(app.withPatientUid(withUid, [patient()]), withUid);
  assert.deepEqual(plain(app.planPatientUidBackfill([withUid], [patient()])), []);
});

/* ================= F. scope + security (PR #124 parity) ================= */

test('F: no new endpoint — the link rides the existing savePayment', () => {
  assert.ok(!SERVER.includes('patientUid'), 'the proxy learned nothing');
  assert.ok(!SERVER.includes('reconnect'));
  const dispatch = GS_SRC.slice(GS_SRC.indexOf('function handle_'), GS_SRC.indexOf('function handle_') + 6000);
  const payActions = (dispatch.match(/action === '(\w+)'/g) || []).filter((a) => /Payment/i.test(a));
  /* accountingPayments is PR #139's READ-only feed and predates this change;
   * the three WRITE-capable actions are still exactly the three that existed
   * before, and this change adds none. */
  assert.deepEqual(plain(Array.from(new Set(payActions)).sort()), [
    "action === 'accountingPayments'",
    "action === 'getPayments'", "action === 'savePayment'", "action === 'updatePayment'",
  ].sort());
  for (const name of ['reconnectPaymentToPatient', 'markPaymentNotAPatient', 'runPatientUidBackfill']) {
    assert.match(fnSource(APP, name), /savePayment\(/, name + ' must use the one write path');
    assert.ok(!fnSource(APP, name).includes('apiPost('), name + ' must not post directly');
  }
});

test('F: everything the reconnect screen renders is escaped', () => {
  const row = fnSource(APP, 'buildReconnectRow');
  for (const v of ['escapeHtml(rawName)', "escapeHtml(pay.patientId || '—')",
                   'escapeHtml(formatDate(pay.dueDate))']) {
    assert.ok(row.includes(v), 'unescaped: ' + v);
  }
  assert.match(row, /escapeHtml\(c\.patient\.name \|\| ''\)/);
  assert.match(row, /escapeHtml\(RECONNECT_REASON_LABELS\[r\] \|\| r\)/);
  assert.match(fnSource(APP, 'renderReconnect'), /escapeHtml\(pay\.linkNote \|\| ''\)/);
  /* The payment NAME is the one value that is attacker-shaped here: it comes
   * off the sheet verbatim and is printed verbatim, on purpose, so a trailing
   * space is visible. Verbatim through escapeHtml, never into innerHTML raw. */
  assert.ok(!/\$\{rawName\}/.test(row), 'the raw name must never be interpolated unescaped');
  assert.match(CSS, /\.reconnect-cand \{/);
  assert.match(CSS, /\.reconnect-cand\.has-dup \{/);
});

test('F: the screen is registered, and nothing else about the app moved', () => {
  assert.match(APP, /'billing', 'revenue', 'reconnect', 'breakeven'/);
  assert.ok(INDEX.includes('id="screen-reconnect"'), 'the router looks this up by id');
  assert.ok(INDEX.includes('data-screen="reconnect"'));
  assert.match(fnSource(APP, 'renderAll'), /renderReconnect\(\);/);
  // Read-only over its inputs: the payment and patient objects are untouched.
  const pay = payment({ patientId: 'arfoni::שחר חיון ::2026-09-07', patientName: 'שחר חיון ' });
  const p = patient({ id: 'id-shachar', name: 'שחר חיון' });
  const before = JSON.stringify([pay, p]);
  app.matchPatientForPayment(pay, [p]);
  app.reconnectCandidates(pay, [p]);
  app.planPatientUidBackfill([pay], [p]);
  app.detachedPayments([pay], [p]);
  assert.equal(JSON.stringify([pay, p]), before, 'byte-identical afterwards');
});
