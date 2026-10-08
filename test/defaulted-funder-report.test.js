/* The defaulted-funder report. See CHANGELOG-defaulted-funder-report.md.
 *
 * Locked here:
 *   - defaultedFunderPayments_ (pure) lists a Payments row only when its funder
 *     is the private label, it has a readable receivedDate, it is not void,
 *     and its patient had NO Funders row with a recognized label and
 *     effectiveFrom <= that receivedDate (the old default's own rule). Cycle
 *     rows → fix 'update_payment'; receipts (rcpt-…, immutable on the
 *     server) → 'void_and_rereport'.
 *   - defaultedFunderPaymentsReportNow is a DRY RUN: against a spreadsheet
 *     whose every mutator throws → zero attempts, ONE private RTL doc, the
 *     URL and counts logged and no patient name in the log. It is not
 *     reachable over HTTP.
 *   - the cleanup report carries the same rows as section `defaultedFunder`;
 *     the workbook tab «גורם מממן ברירת מחדל» is titled «תשלומים שקיבלו גורם
 *     מממן ברירת מחדל», and its how-to-fix text depends on the row type.
 *
 * vm sandbox on the real Code.gs. All names are SYNTHETIC. */

process.env.TZ = 'Asia/Jerusalem';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const cleanup = require('../lib/cleanup-xlsx');

const GS_SRC = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
const plain = (v) => JSON.parse(JSON.stringify(v));
const NOW = '2026-10-05T07:30:00.000Z';   // 10:30 in Israel

/* ---------- a spreadsheet that can only be READ, a DocumentApp that records ---------- */
function trap(readers, label, attempts) {
  return new Proxy(readers, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === 'symbol' || prop === 'then' || prop === 'toJSON') return undefined;
      return () => { attempts.push(label + '.' + String(prop)); throw new Error('read-only fake: ' + label + '.' + String(prop)); };
    },
  });
}
function roSheet(name, header, rows, attempts) {
  const grid = [header.slice()].concat(rows.map((r) => r.slice()));
  const width = () => grid.reduce((m, r) => Math.max(m, r.length), 0);
  return trap({
    getName: () => name,
    getLastRow: () => grid.length,
    getLastColumn: () => width(),
    getMaxColumns: () => Math.max(26, width()),
    getRange: (r, c, nr, nc) => {
      const read = () => {
        const out = [];
        for (let i = 0; i < (nr || 1); i++) {
          const row = [];
          for (let j = 0; j < (nc || 1); j++) { const g = grid[r - 1 + i]; row.push(g && g[c - 1 + j] !== undefined ? g[c - 1 + j] : ''); }
          out.push(row);
        }
        return out;
      };
      return trap({ getValues: read }, 'Range(' + name + ')', attempts);
    },
  }, 'Sheet(' + name + ')', attempts);
}
function fakeDocumentApp(log) {
  const para = (text) => {
    const rec = { text, ltr: null, align: null };
    log.paragraphs.push(rec);
    const self = trap({
      setHeading: () => self, setLeftToRight: (v) => { rec.ltr = v; return self; },
      setAlignment: (a) => { rec.align = a; return self; }, getType: () => 'PARAGRAPH', asParagraph: () => self,
    }, 'Paragraph', log.attempts);
    return self;
  };
  const body = trap({
    getParagraphs: () => [para('')],
    appendParagraph: (t) => para(String(t)),
    appendTable: (cells) => {
      log.tables.push(cells.map((r) => r.slice()));
      const objs = cells.map((r) => r.map((c) => para(c)));
      return trap({
        getNumRows: () => cells.length,
        getRow: (i) => trap({
          getNumCells: () => cells[i].length,
          getCell: (j) => trap({ getNumChildren: () => 1, getChild: () => objs[i][j] }, 'Cell', log.attempts),
          editAsText: () => trap({ setBold: () => {} }, 'Text', log.attempts),
        }, 'Row', log.attempts),
      }, 'Table', log.attempts);
    },
  }, 'Body', log.attempts);
  const doc = trap({
    getBody: () => body, saveAndClose: () => { log.saved++; },
    getUrl: () => 'https://docs.google.com/document/d/fake-doc/edit', getId: () => 'fake-doc',
  }, 'Document', log.attempts);
  return trap({
    create: (t) => { log.created.push(t); return doc; },
    ElementType: { PARAGRAPH: 'PARAGRAPH' },
    ParagraphHeading: { TITLE: 'TITLE', HEADING1: 'HEADING1', HEADING2: 'HEADING2' },
    HorizontalAlignment: { RIGHT: 'RIGHT' },
  }, 'DocumentApp', log.attempts);
}
function formatDate(d, tz, fmt) {
  const parts = {};
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(d).forEach((p) => { parts[p.type] = p.value; });
  return fmt.replace('yyyy', parts.year).replace('MM', parts.month).replace('dd', parts.day).replace('HH', parts.hour).replace('mm', parts.minute);
}
function frozenDate(iso) {
  const fixed = new Date(iso).getTime();
  return class FrozenDate extends Date {
    constructor(...a) { if (a.length === 0) super(fixed); else super(...a); }
    static now() { return fixed; }
  };
}
/* One Date class for every sandbox, so a Date cell built for one is a Date to all. */
const SANDBOX_DATE = frozenDate(NOW);
function loadCode(sheets) {
  const attempts = [];
  const logs = [];
  const doc = { created: [], paragraphs: [], tables: [], attempts: [], saved: 0 };
  const ro = (sheets || []).map((t) => roSheet(t.name, t.header, t.rows, attempts));
  const ss = trap({ getSheetByName: (n) => ro.find((s) => s.getName() === n) || null }, 'Spreadsheet', attempts);
  const sandbox = {
    console: { log() {}, warn() {}, error() {}, info() {} },
    JSON, Math, Date: SANDBOX_DATE, Number, String, Array, Object, RegExp, isFinite, isNaN,
    Logger: { log: (m) => logs.push(String(m)) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    DocumentApp: fakeDocumentApp(doc),
    Utilities: { formatDate, getUuid: () => { attempts.push('Utilities.getUuid'); return 'x'; } },
    LockService: { getScriptLock: () => { attempts.push('LockService'); throw new Error('no lock'); } },
    PropertiesService: { getScriptProperties: () => { attempts.push('PropertiesService'); throw new Error('no properties'); } },
    ContentService: { createTextOutput: (s) => ({ setMimeType: () => ({ json: JSON.parse(s) }) }), MimeType: { JSON: 'json' } },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(GS_SRC + `
    globalThis.__c = { PAYMENT_COLUMNS, FUNDER_COLUMNS, PAYMENTS_SHEET, FUNDERS_SHEET, CLEANUP_SECTION_KEYS };`, sandbox);
  return { sandbox, attempts, logs, doc, C: sandbox.__c };
}

/* ---------- the fixture ---------- */
const PRIVATE = 'פרטי';
const pay = (id, f) => Object.assign({ id, patientName: 'מטופל ' + id, houseId: 'ramot', dueDate: '2026-08-01', amount: 30000, status: 'paid', amountPaid: 30000 }, f);
const PAYMENTS = [
  // LISTED — a cycle row, no Funders row at all
  pay('c-1', { patientUid: 'p-a', patientName: 'אבי ברירת', houseId: 'arfoni', funder: PRIVATE, receivedDate: '2026-08-01' }),
  // LISTED — a receipt; the patient's only row starts AFTER the received date
  pay('rcpt-2', { patientUid: 'p-b', patientName: 'בתיה קבלה', funder: PRIVATE, receivedDate: '2026-09-10', amount: 12000, amountPaid: '' }),
  // not listed — a real פרטי row covers the received date (a decision)
  pay('c-3', { patientUid: 'p-c', funder: PRIVATE, receivedDate: '2026-09-01' }),
  // not listed — not the private label
  pay('c-4', { patientUid: 'p-d', funder: 'מכבי', receivedDate: '2026-09-01' }),
  // not listed — void (nothing left to fix)
  pay('rcpt-5', { patientUid: 'p-e', funder: PRIVATE, receivedDate: '2026-09-01', status: 'void' }),
  // not listed — no receivedDate (the default only ran on a report)
  pay('c-6', { patientUid: 'p-f', funder: PRIVATE }),
  // LISTED — the only row has an unrecognized label: the old rule skipped it
  pay('c-7', { patientUid: 'p-g', patientName: 'גיל תווית', funder: PRIVATE, receivedDate: '05/09/2026', amountPaid: 10000 }),
  // not listed — no patientUid, but the LINKED patient had a row
  pay('c-8', { linkPatientUid: 'p-h', funder: PRIVATE, receivedDate: '2026-09-02' }),
  // LISTED — no patient id at all: no Funders row can exist
  pay('c-9', { patientName: 'דנה בלי מזהה', funder: PRIVATE, receivedDate: '2026-09-02', amountPaid: 0, amount: 25000 }),
  // not listed — a row effective on the received day itself (<= is inclusive); a Date cell
  pay('c-10', { patientUid: 'p-i', funder: PRIVATE, receivedDate: 'DATE_CELL' }),
  // not listed — a padded label is not the exact private label
  pay('c-11', { patientUid: 'p-j', funder: 'פרטית', receivedDate: '2026-09-03' }),
];
const FUNDERS = [
  { patientId: 'p-b', funder: 'ביטוח לאומי', effectiveFrom: '2026-09-15' },
  { patientId: 'p-c', funder: PRIVATE, effectiveFrom: '2026-08-01' },
  { patientId: 'p-g', funder: 'כללית', effectiveFrom: '2026-01-01' },
  { patientId: 'p-h', funder: 'מכבי', effectiveFrom: '2026-01-01' },
  { patientId: 'p-i', funder: PRIVATE, effectiveFrom: '2026-09-03' },
];
const LISTED = ['c-1', 'c-9', 'c-7', 'rcpt-2'];   // by receivedDate

/* PAYMENTS with c-10's receivedDate as a Date cell OF THE SANDBOX'S REALM
 * (what getValues returns in Apps Script), so `instanceof Date` holds. */
const payments = (sandbox) => PAYMENTS.map((p) => (p.receivedDate === 'DATE_CELL'
  ? Object.assign({}, p, { receivedDate: new sandbox.Date('2026-09-03T00:00:00+03:00') }) : p));

const positional = (cols, o) => cols.map((c) => (o[c] === undefined ? '' : o[c]));
function sheets(C, opts, sandbox) {
  const o = opts || {};
  const out = [];
  if (o.payments !== false) out.push({ name: C.PAYMENTS_SHEET, header: C.PAYMENT_COLUMNS, rows: payments(sandbox).map((p) => positional(C.PAYMENT_COLUMNS, p)) });
  if (o.funders !== false) out.push({ name: C.FUNDERS_SHEET, header: C.FUNDER_COLUMNS, rows: FUNDERS.map((f) => positional(C.FUNDER_COLUMNS, f)) });
  return out;
}
function run(opts) {
  const base = loadCode([]);
  const h = loadCode(sheets(base.C, opts, base.sandbox));
  return Object.assign(h, { out: plain(h.sandbox.defaultedFunderPaymentsReportNow()) });
}

/* ============================ the rule ============================ */

test(`the rule: ${LISTED.length} of ${PAYMENTS.length} fixture rows were decided by the old default — cycles → updatePayment, receipts → void + re-report`, () => {
  const { sandbox } = loadCode([]);
  const rows = plain(sandbox.defaultedFunderPayments_(payments(sandbox), FUNDERS));
  assert.deepEqual(rows.map((r) => r.paymentId), LISTED);
  assert.deepEqual(rows.map((r) => r.fix), ['update_payment', 'update_payment', 'update_payment', 'void_and_rereport']);
  assert.deepEqual(rows.map((r) => r.receipt), [false, false, false, true]);
  assert.deepEqual(rows.map((r) => r.receivedDate), ['2026-08-01', '2026-09-02', '2026-09-05', '2026-09-10'], 'DD/MM/YYYY read too');
  assert.deepEqual(rows.map((r) => r.amount), [30000, 25000, 10000, 12000], 'cycle: amountPaid (else amount); receipt: amount');
  assert.deepEqual(rows[0], {
    kind: 'defaulted_funder', paymentId: 'c-1', receipt: false, houseId: 'arfoni', name: 'אבי ברירת', patientUid: 'p-a',
    receivedDate: '2026-08-01', amount: 30000, fix: 'update_payment',
  });
  // a Funders row set later moves the row off the list (the person decided)
  const later = plain(sandbox.defaultedFunderPayments_(payments(sandbox), FUNDERS.concat([{ patientId: 'p-a', funder: PRIVATE, effectiveFrom: '2026-07-01' }])));
  assert.deepEqual(later.map((r) => r.paymentId), ['c-9', 'c-7', 'rcpt-2']);
  // the Date cell is read by its Israel day: without p-i's row, c-10 is listed on 2026-09-03
  const noRow = plain(sandbox.defaultedFunderPayments_(payments(sandbox), FUNDERS.filter((f) => f.patientId !== 'p-i')));
  assert.equal(noRow.find((r) => r.paymentId === 'c-10').receivedDate, '2026-09-03');
  // nothing in → nothing out
  assert.deepEqual(plain(sandbox.defaultedFunderPayments_(null, null)), []);
});

/* ============================ dry run ============================ */

test('dry run: a spreadsheet whose every mutator throws → ZERO attempts, ONE private RTL doc, URL logged, no names in the log', () => {
  const { attempts, logs, doc, out } = run();
  assert.deepEqual(attempts, [], 'no sheet write, lock, property or uuid');
  assert.deepEqual(doc.attempts, [], 'nothing beyond create + append + formatting');
  assert.equal(doc.created.length, 1);
  assert.equal(doc.created[0], 'E-Zone תשלומים עם גורם מממן ברירת מחדל 2026-10-05 10:30');
  assert.equal(doc.saved, 1);
  assert.equal(out.count, 4);
  assert.equal(out.total, 77000);
  assert.equal(out.url, 'https://docs.google.com/document/d/fake-doc/edit');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /DRY RUN, READ-ONLY on the spreadsheet/);
  assert.match(logs[0], /Rows: 4 \(1 receipts\), total ₪77,000/);
  assert.ok(logs[0].includes(out.url));
  for (const p of PAYMENTS) assert.ok(!logs[0].includes(p.patientName), 'no patient name in the log');
  // the document: one table, header + 4 rows, the house in Hebrew
  assert.equal(doc.tables.length, 1);
  const rows = plain(doc.tables[0]).map((r) => r.slice().reverse());   // recDocTable_ reverses each row for RTL
  assert.deepEqual(rows[0], ['מזהה תשלום', 'סוג', 'מטופל', 'בית', 'תאריך קבלה', 'סכום', 'תיקון']);
  assert.deepEqual(rows.slice(1).map((r) => r[0]), LISTED);
  assert.deepEqual(rows[1], ['c-1', 'מחזור', 'אבי ברירת', 'קיסריה עפרוני', '01/08/2026', '₪30,000', 'updatePayment']);
  assert.deepEqual(rows[4].slice(0, 2).concat(rows[4].slice(-1)), ['rcpt-2', 'קבלה', 'ביטול ודיווח מחדש']);
  doc.paragraphs.forEach((p) => assert.equal(p.ltr, false, 'RTL: ' + p.text));
  assert.ok(doc.paragraphs.some((p) => /updatePayment/.test(p.text) && /ביטול קבלה/.test(p.text)), 'how to fix, both row types');
});

test('dry run: no Payments / Funders tab → "אין פריטים.", nothing created in the sheet', () => {
  const h = run({ payments: false, funders: false });
  assert.deepEqual(h.attempts, []);
  assert.equal(h.out.count, 0);
  assert.equal(h.doc.tables.length, 0);
  assert.ok(h.doc.paragraphs.some((p) => p.text === 'אין פריטים.'));
  // Payments without a Funders tab: every private row with a received date
  const p = run({ funders: false });
  assert.deepEqual(p.out.rows.map((r) => r.paymentId), ['c-1', 'c-3', 'c-8', 'c-9', 'c-10', 'c-7', 'rcpt-2']);
});

/* ============================ read-only, by source ============================ */

function stripComments(src) { return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1'); }
function stripStrings(src) { return src.replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, '""'); }

test('source: nothing the report reaches writes the sheet, locks, reads a property, or shares the doc', () => {
  const { sandbox } = loadCode([]);
  const fns = {};
  const queue = ['defaultedFunderPaymentsReportNow'];
  while (queue.length) {
    const n = queue.shift();
    if (fns[n]) continue;
    fns[n] = sandbox[n].toString();
    (stripStrings(stripComments(fns[n])).match(/\b[A-Za-z_$][\w$]*(?=\s*\()/g) || []).forEach((id) => {
      if (!fns[id] && typeof sandbox[id] === 'function' && GS_SRC.includes('function ' + id + '(')) queue.push(id);
    });
  }
  ['defaultedFunderPayments_', 'recReadSheet_', 'recDocPara_', 'recDocTable_', 'isReceiptRow_', 'isVoidStatus_'].forEach((n) => assert.ok(fns[n], 'reaches ' + n));
  const FORBIDDEN = [/\.setValues?\s*\(/, /\.appendRow\s*\(/, /\.delete\w*\s*\(/, /\.insert\w*\s*\(/, /\.clear\w*\s*\(/,
    /\bgetOrCreateSheet_\s*\(/, /\blogAudit_\s*\(/, /\bLockService\b/, /\bPropertiesService\b/, /\bUrlFetchApp\b/, /\bMailApp\b/,
    /\bDriveApp\b/, /\baddEditors?\b/, /\baddViewers?\b/, /\bsetSharing\b/, /\bmoveTo\b/];
  Object.keys(fns).forEach((n) => FORBIDDEN.forEach((re) => assert.ok(!re.test(stripComments(fns[n])), n + ' must not match ' + re)));
  // sheet setters: only the document writers may call set*
  Object.keys(fns).filter((n) => !['defaultedFunderPaymentsReportNow', 'recDocPara_', 'recDocTable_'].includes(n))
    .forEach((n) => assert.ok(!/\.set[A-Z]\w*\s*\(/.test(stripComments(fns[n])), n + ' calls no setter'));
  assert.equal((stripComments(fns.defaultedFunderPaymentsReportNow).match(/DocumentApp\.create\s*\(/g) || []).length, 1);
});

test('not reachable over HTTP: handle_ never names it and answers unknown_action', () => {
  const handleSrc = GS_SRC.slice(GS_SRC.indexOf('function handle_('), GS_SRC.indexOf('function collectParams_('));
  assert.ok(!/defaultedFunder/.test(handleSrc));
  const { sandbox } = loadCode([]);
  assert.deepEqual(plain(sandbox.handle_({ action: 'defaultedFunderPaymentsReportNow' }).json),
    { ok: false, error: 'unknown_action', action: 'defaultedFunderPaymentsReportNow' });
  assert.ok(/\nfunction defaultedFunderPaymentsReportNow\(\)/.test(GS_SRC), 'public, in the Run dropdown');
});

/* ============================ the cleanup workbook ============================ */

test('cleanup report: section defaultedFunder = the same rows (cycles and receipts), counted', () => {
  const { sandbox, C } = loadCode([]);
  const tab = (sheet, list) => ({ sheet, rows: list.map((o, i) => ({ rowNumber: i + 2, obj: Object.assign({}, o) })) });
  const r = plain(sandbox.cleanupReport_('2026-10-05', { payments: tab(C.PAYMENTS_SHEET, payments(sandbox)), funders: tab(C.FUNDERS_SHEET, FUNDERS) }));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(Array.from(C.CLEANUP_SECTION_KEYS), cleanup.SECTION_KEYS);
  assert.deepEqual(r.sections.defaultedFunder.map((x) => x.paymentId).sort(), LISTED.slice().sort());
  assert.equal(r.counts.defaultedFunder, 4);
});

test('cleanup workbook: tab «גורם מממן ברירת מחדל» (≤ 31 chars), titled «תשלומים שקיבלו גורם מממן ברירת מחדל»; how-to-fix by row type; Vered fixes', () => {
  const { sandbox } = loadCode([]);
  const rows = plain(sandbox.defaultedFunderPayments_(payments(sandbox), FUNDERS));
  const data = { ok: true, today: '2026-10-05', sections: {} };
  cleanup.SECTION_KEYS.forEach((k) => { data.sections[k] = []; });
  data.sections.defaultedFunder = rows;
  assert.ok(cleanup.isCleanupResponse(data));
  const older = JSON.parse(JSON.stringify(data));
  delete older.sections.defaultedFunder;
  assert.ok(cleanup.isCleanupResponse(older), 'a Code.gs deployed before this PR → an empty tab');
  const spec = cleanup.buildCleanupSpec(data, new Date(NOW));
  const sheet = spec.sheets.find((s) => s.name === 'גורם מממן ברירת מחדל');
  assert.ok(sheet);
  assert.ok(sheet.name.length <= 31);
  assert.equal(sheet.title, 'תשלומים שקיבלו גורם מממן ברירת מחדל');
  assert.deepEqual(sheet.columns.map((c) => c.header).slice(0, 6), ['בית', 'מטופל', 'מזהה תשלום', 'סוג', 'תאריך קבלה', 'סכום']);
  assert.deepEqual(sheet.rows.map((r) => r.paymentId), LISTED);
  const cycle = sheet.rows[0];
  const receipt = sheet.rows[3];
  assert.equal(cycle.owner, 'ורד');
  assert.equal(cycle.rowType, 'מחזור');
  assert.equal(cycle.house, 'קיסריה עפרוני');
  assert.match(cycle.how, /השלמת גורם מממן/);
  assert.match(cycle.how, /updatePayment/);
  assert.equal(receipt.rowType, 'קבלה');
  assert.match(receipt.how, /השלמת גורם מממן/);
  assert.match(receipt.how, /ביטול קבלה/);
  assert.ok(!/updatePayment/.test(receipt.how), 'a receipt cannot be edited (receipt_immutable)');
  const summary = spec.sheets[0].rows.find((r) => r.tab === 'גורם מממן ברירת מחדל');
  assert.deepEqual([summary.count, summary.vered], [4, 4]);
});

test('the fix text is true: updatePayment changes a cycle row\'s funder, and refuses a receipt', () => {
  assert.ok(/error: 'receipt_immutable'/.test(GS_SRC), 'receipts are immutable');
  assert.ok(/fields\.funder = sent\('funder'\) \? paymentReportText_\(pay\.funder\) : prevFunder;/.test(GS_SRC),
    'a carried funder replaces the stored one on a cycle row');
});
