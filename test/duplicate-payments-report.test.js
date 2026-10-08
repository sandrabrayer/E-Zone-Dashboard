/* duplicatePaymentsReportNow() — the read-only duplicate-payment report.
 * CHANGELOG-duplicate-payments-report.md.
 *
 * The matching rule (dupPaymentsFind_, pure), and the run end to end against
 * a spreadsheet whose every mutator throws: ONE private Google Doc, the URL
 * logged, zero sheet / lock / property writes. Code.gs is the REAL file in a
 * vm (test/helpers/gs-sandbox.js). All names are SYNTHETIC. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { richSheet, loadGs, GS_SRC } = require('./helpers/gs-sandbox');

const plain = (v) => JSON.parse(JSON.stringify(v));
const arr = (v) => Array.from(v);

const CYCLE_A = 'pay::arfoni::דנה כהן::2026-09-15::2026-09-15';
const PID_A = 'arfoni::דנה כהן::2026-09-15';

/* A receipt row (the shape reportPayment_ writes). */
const rcpt = (id, over) => Object.assign({
  id, patientId: PID_A, patientName: 'דנה כהן', houseId: 'arfoni', dueDate: '2026-09-15',
  amount: 30000, amountPaid: 30000, status: 'paid', receivedDate: '2026-10-01',
  coverageStart: '2026-09-15', coverageEnd: '2026-10-14', method: 'העברה בנקאית', reference: 'TRX-1',
  recordedAt: '2026-10-01T10:00:00+03:00', timestamp: '2026-10-01T07:00:00.000Z',
}, over || {});
const cycle = (over) => Object.assign({
  id: CYCLE_A, patientId: PID_A, patientName: 'דנה כהן', houseId: 'arfoni', dueDate: '2026-09-15',
  amount: 30000, amountPaid: 30000, balance: 0, status: 'paid',
  coverageStart: '2026-09-15', coverageEnd: '2026-10-14', timestamp: '2026-10-01T07:00:00.000Z',
}, over || {});

function world(payRows, opts) {
  const g = loadGs();
  const cols = arr(g.run('PAYMENT_COLUMNS'));
  if (!(opts && opts.noSheet)) {
    const sh = richSheet('Payments', cols);
    payRows.forEach((o) => sh.appendRow(cols.map((c) => (o[c] === undefined ? '' : o[c]))));
    // Read-only guard: every mutator throws.
    const attempts = [];
    const getRange = sh.getRange.bind(sh);
    sh.getRange = (...a) => {
      const r = getRange(...a);
      for (const k of ['setValue', 'setValues', 'clearContent', 'setNumberFormat']) {
        r[k] = () => { attempts.push('Range.' + k); throw new Error('read-only'); };
      }
      return r;
    };
    sh.appendRow = () => { attempts.push('appendRow'); throw new Error('read-only'); };
    g.sandbox.__sheets.Payments = sh;
    g.attempts = attempts;
  } else g.attempts = [];
  g.sandbox.LockService = { getScriptLock: () => { g.attempts.push('LockService'); throw new Error('no lock'); } };
  g.sandbox.PropertiesService = { getScriptProperties: () => { g.attempts.push('PropertiesService'); throw new Error('no props'); } };
  const doc = { created: [], paragraphs: [], tables: [], saved: 0 };
  const para = (t) => { doc.paragraphs.push(String(t)); const p = { setHeading: () => p, setLeftToRight: () => p, setAlignment: () => p, getType: () => 'PARAGRAPH', asParagraph: () => p }; return p; };
  g.sandbox.DocumentApp = {
    ElementType: { PARAGRAPH: 'PARAGRAPH' },
    ParagraphHeading: { TITLE: 'TITLE', HEADING1: 'H1', HEADING2: 'H2' },
    HorizontalAlignment: { RIGHT: 'RIGHT' },
    create: (title) => {
      doc.created.push(title);
      return {
        getBody: () => ({
          getParagraphs: () => [para('')],
          appendParagraph: (t) => para(t),
          appendTable: (cells) => {
            doc.tables.push(cells.map((r) => r.slice()));
            return {
              getNumRows: () => cells.length,
              getRow: (i) => ({
                getNumCells: () => cells[i].length,
                getCell: () => ({ getNumChildren: () => 1, getChild: () => para('') }),
                editAsText: () => ({ setBold: () => {} }),
              }),
            };
          },
        }),
        saveAndClose: () => { doc.saved++; },
        getUrl: () => 'https://docs.google.com/document/d/fake-dup/edit',
        getId: () => 'fake-dup',
      };
    },
  };
  return { g, doc };
}

const find = (g, rows) => plain(g.sandbox.dupPaymentsFind_(rows.map((obj, i) => ({ rowNumber: i + 2, obj })), '2026-09-30'));

test('same patient + same amount + same payment date → one group (two receipts of the same transfer)', () => {
  const { g } = world([]);
  const r = find(g, [cycle(), rcpt('rcpt-a'), rcpt('rcpt-b', { recordedAt: '2026-10-03T09:00:00+03:00', reference: 'TRX-2' })]);
  assert.equal(r.groups.length, 1);
  assert.deepEqual(r.groups[0].map((e) => e.receiptId), ['rcpt-a', 'rcpt-b']);
  assert.deepEqual(r.groups[0].map((e) => e.rowNumber), [3, 4]);
  const e = r.groups[0][0];
  assert.deepEqual([e.patient, e.house, e.amount, e.date, e.method, e.reference],
    ['דנה כהן', 'arfoni', 30000, '2026-10-01', 'העברה בנקאית', 'TRX-1']);
});

test('same patient + amount, different payment date, created within 10 minutes → a group; 11 minutes apart → not', () => {
  const { g } = world([]);
  const near = find(g, [cycle(), rcpt('rcpt-a'),
    rcpt('rcpt-b', { receivedDate: '2026-09-30', recordedAt: '2026-10-01T10:09:59+03:00' })]);
  assert.equal(near.groups.length, 1);
  const far = find(g, [cycle(), rcpt('rcpt-a'),
    rcpt('rcpt-b', { receivedDate: '2026-09-30', recordedAt: '2026-10-01T10:11:00+03:00' })]);
  assert.equal(far.groups.length, 0);
});

test('a name variant: a different patientId with no shared key is not grouped; a shared patientUid is', () => {
  const { g } = world([]);
  const r = find(g, [cycle(), rcpt('rcpt-a'), rcpt('rcpt-b', { patientId: 'arfoni::דנה  כהן::2026-09-15' })]);
  // A receipt links to a cycle only when the patient matches, so with a
  // different patientId it shares neither the patient nor the cycle…
  assert.equal(r.groups.length, 0);
  // …but two receipts that share patientUid are the same patient whatever the name.
  const u = find(g, [cycle({ patientUid: 'id-1' }), rcpt('rcpt-a', { patientUid: 'id-1' }),
    rcpt('rcpt-b', { patientUid: 'id-1', patientId: 'arfoni::דנה  כהן::2026-09-15' })]);
  assert.equal(u.groups.length, 1);
});

test('different amount / different patient / voided / before the cutoff → not listed', () => {
  const { g } = world([]);
  assert.equal(find(g, [cycle(), rcpt('rcpt-a'), rcpt('rcpt-b', { amount: 20000, amountPaid: 20000 })]).groups.length, 0);
  assert.equal(find(g, [cycle(), rcpt('rcpt-a'),
    rcpt('rcpt-b', { patientId: 'rehab::רון לוי::2026-09-01', patientName: 'רון לוי' })]).groups.length, 0);
  // The נועם שני case: one live + one voided receipt of the same amount.
  assert.equal(find(g, [cycle(), rcpt('rcpt-a'), rcpt('rcpt-b', { status: 'void' })]).groups.length, 0);
  assert.equal(find(g, [cycle(), rcpt('rcpt-a'), rcpt('rcpt-b', { status: 'מבוטל' })]).groups.length, 0);
  const old = find(g, [cycle(), rcpt('rcpt-a', { recordedAt: '2026-09-29T23:59:00+03:00' }),
    rcpt('rcpt-b', { recordedAt: '2026-09-29T23:59:30+03:00' })]);
  assert.equal(old.groups.length, 0, 'created before 30/09/2026 (Israel time)');
  assert.equal(old.rowCount, 0);
});

test('a cycle with receipts is NOT compared with them; a legacy paid cycle with no receipt IS a money row', () => {
  const { g } = world([]);
  assert.equal(find(g, [cycle(), rcpt('rcpt-a')]).groups.length, 0, 'the cycle carries its receipt\'s derived total');
  // Legacy: a paid cycle (no receipts) + a second legacy cycle row for the
  // same patient, same amount, same due date (an id variant).
  const legacy = find(g, [
    cycle({ id: 'pay::arfoni::דנה כהן::2026-09-15::2026-10-15', dueDate: '2026-10-15', coverageStart: '', coverageEnd: '' }),
    cycle({ id: 'pay::arfoni::דנה כהן ::2026-09-15::2026-10-15', dueDate: '2026-10-15', coverageStart: '', coverageEnd: '' }),
  ]);
  assert.equal(legacy.groups.length, 1);
  assert.deepEqual(legacy.groups[0].map((e) => e.receiptId), ['', '']);
  // An unpaid cycle is not money.
  assert.equal(find(g, [cycle({ status: 'unpaid', amountPaid: 0 }), cycle({ id: 'x', status: 'unpaid', amountPaid: 0 })]).groups.length, 0);
});

test('a chain of three is ONE group, oldest first; Date-typed cells are read', () => {
  const { g } = world([]);
  const r = find(g, [cycle(),
    rcpt('rcpt-c', { recordedAt: new Date('2026-10-01T07:08:00Z') }),
    rcpt('rcpt-a', { recordedAt: '2026-10-01T10:00:00+03:00' }),
    rcpt('rcpt-b', { recordedAt: '2026-10-01T10:04:00+03:00', receivedDate: new Date(2026, 9, 1) })]);
  assert.equal(r.groups.length, 1);
  assert.deepEqual(r.groups[0].map((e) => e.receiptId), ['rcpt-a', 'rcpt-b', 'rcpt-c']);
});

test('end to end: READ-ONLY on the spreadsheet, ONE private Doc with the table, the URL logged', () => {
  const { g, doc } = world([cycle(), rcpt('rcpt-a'), rcpt('rcpt-b', { recordedAt: '2026-10-01T10:03:00+03:00' }),
    rcpt('rcpt-c', { amount: 5000, amountPaid: 5000 })]);
  const before = JSON.stringify(g.sandbox.__sheets.Payments.grid);
  const report = plain(g.sandbox.duplicatePaymentsReportNow());
  assert.deepEqual(g.attempts, [], 'no sheet write, lock or property');
  assert.equal(JSON.stringify(g.sandbox.__sheets.Payments.grid), before);
  assert.equal(doc.created.length, 1);
  assert.match(doc.created[0], /^E-Zone דוח תשלומים כפולים \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(doc.saved, 1);
  assert.equal(doc.tables.length, 1);
  assert.deepEqual(arr(doc.tables[0][0]), ['קבוצה', 'שורה בגיליון', 'מטופל', 'בית', 'סכום', 'תאריך', 'אמצעי', 'אסמכתא', 'מזהה קבלה', 'נוצר'].reverse(),
    'header row (Docs lays tables out left-to-right, so each row is reversed)');
  assert.equal(doc.tables[0].length, 3, 'header + the two rows of the one group');
  assert.ok(doc.tables[0][1].includes('rcpt-a') && doc.tables[0][1].includes('01/10/2026') && doc.tables[0][1].includes('₪30,000'));
  assert.equal(report.url, 'https://docs.google.com/document/d/fake-dup/edit');
  assert.ok(g.logs.some((l) => l.includes('https://docs.google.com/document/d/fake-dup/edit') && l.includes('1 group(s)')), g.logs.join('\n'));
});

test('end to end with no Payments tab: nothing created on the sheet, the Doc says so', () => {
  const { g, doc } = world([], { noSheet: true });
  const report = plain(g.sandbox.duplicatePaymentsReportNow());
  assert.equal(g.sandbox.__sheets.Payments, undefined, 'the tab is never created');
  assert.equal(report.groups.length, 0);
  assert.ok(doc.paragraphs.includes('לשונית Payments לא נמצאה.'));
  assert.ok(doc.paragraphs.includes('אין פריטים.'));
});

test('not reachable over HTTP: no action names it; the function body touches no writer', () => {
  const g = loadGs();
  assert.ok(!/'duplicatePaymentsReportNow'/.test(GS_SRC), 'never named as an action string');
  for (const fn of ['duplicatePaymentsReportNow', 'dupPaymentsFind_', 'dupCreatedMs_', 'dupPayDate_', 'dupPaymentsWriteDoc_']) {
    const src = g.sandbox[fn].toString();
    for (const re of [/\.setValues?\s*\(/, /\.appendRow\s*\(/, /getOrCreateSheet_\s*\(/, /logAudit_\s*\(/, /LockService/,
      /PropertiesService/, /DriveApp/, /addEditor|addViewer|setSharing/, /UrlFetchApp|MailApp|GmailApp/]) {
      assert.ok(!re.test(src), fn + ' must not match ' + re);
    }
  }
});
