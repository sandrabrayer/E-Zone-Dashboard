/* reconciliationReportNow() — the READ-ONLY reconciliation report
 * (apps-script/Code.gs → one new private Google Doc).
 *
 * Locked here:
 *   1. The SPREADSHEET is never written, proven two ways:
 *      - SOURCE: neither the function nor ANY Code.gs helper it reaches
 *        (transitive closure) calls a sheet mutator, getOrCreateSheet_,
 *        logAudit_, a lock, a property, Drive, mail or a fetch; DocumentApp
 *        appears ONLY in the three document writers, and nothing shares or
 *        moves the document;
 *      - RUNTIME: it runs end to end against a spreadsheet whose every
 *        non-read method THROWS and records the attempt — zero attempts — and
 *        against a DocumentApp fake that records every call: exactly one
 *        create(), nothing but body appends and formatting, every paragraph
 *        right-to-left.
 *   2. Not reachable over HTTP (handle_ never names it).
 *   3. Sections A–K report what they promise on synthetic Hebrew data, each
 *      item carrying its tab + row, money sections sorted largest ₪ first.
 *   4. PARITY: every rule ported from public/app.js is run side by side with
 *      the app.js original on the same fixtures — payment→patient matching
 *      (all four tiers + ambiguity), look-alike names, name normalization,
 *      reconnect candidates, the stay window, the records cutoff, the VAT
 *      rate and ex-VAT rounding, the coverage period, billing overrides, the
 *      stage and payment-status aliases, and the cycle due dates.
 *   5. The new section declares only functions, each name once.
 * All names, ids and phone numbers are SYNTHETIC. */

process.env.TZ = 'Asia/Jerusalem';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const GS_SRC = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps-script', 'appsscript.json'), 'utf8'));
const arr = (x) => Array.from(x);
const plain = (v) => JSON.parse(JSON.stringify(v));
const FFFD = String.fromCharCode(0xfffd);
const RLM = String.fromCharCode(0x200f);
const NBSP = String.fromCharCode(0x00a0);
const NOW = '2026-09-30T09:00:00.000Z';   // 12:00 in Israel

/* ---------- a spreadsheet that can only be READ ---------- */
function trap(readers, label, attempts) {
  return new Proxy(readers, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === 'symbol' || prop === 'then' || prop === 'toJSON') return undefined;
      return () => {
        attempts.push(label + '.' + String(prop));
        throw new Error('read-only fake: ' + label + '.' + String(prop) + ' is not allowed');
      };
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
    getMaxRows: () => Math.max(1000, grid.length),
    getRange: (r, c, nr, nc) => {
      nr = nr || 1; nc = nc || 1;
      const read = () => {
        const out = [];
        for (let i = 0; i < nr; i++) {
          const row = [];
          for (let j = 0; j < nc; j++) {
            const g = grid[r - 1 + i];
            row.push(g && g[c - 1 + j] !== undefined ? g[c - 1 + j] : '');
          }
          out.push(row);
        }
        return out;
      };
      return trap({ getValues: read, getValue: () => read()[0][0] }, 'Range(' + name + ')', attempts);
    },
  }, 'Sheet(' + name + ')', attempts);
}

/* ---------- a DocumentApp that records everything ---------- */
function fakeDocumentApp(log) {
  const ElementType = { PARAGRAPH: 'PARAGRAPH', TABLE: 'TABLE' };
  // A paragraph handle whose setters record onto its own log entry.
  const para = (text) => {
    const rec = { text, heading: null, ltr: null, align: null };
    log.paragraphs.push(rec);
    const self = trap({
      setHeading: (x) => { rec.heading = x; return self; },
      setLeftToRight: (v) => { rec.ltr = v; return self; },
      setAlignment: (a) => { rec.align = a; return self; },
      getType: () => ElementType.PARAGRAPH,
      asParagraph: () => self,
    }, 'Paragraph', log.attempts);
    return self;
  };
  const body = trap({
    getParagraphs: () => [para('')],
    appendParagraph: (t) => { log.order.push({ p: String(t) }); return para(String(t)); },
    appendTable: (cells) => {
      const t = { cells: cells.map((r) => r.slice()), bold: false };
      log.tables.push(t);
      log.order.push({ table: log.tables.length - 1 });
      const cellObjs = cells.map((r) => r.map((c) => para(c)));
      return trap({
        getNumRows: () => cells.length,
        getRow: (i) => trap({
          getNumCells: () => cells[i].length,
          getCell: (j) => trap({ getNumChildren: () => 1, getChild: () => cellObjs[i][j] }, 'TableCell', log.attempts),
          editAsText: () => trap({ setBold: () => { if (i === 0) t.bold = true; } }, 'Text', log.attempts),
        }, 'TableRow', log.attempts),
      }, 'Table', log.attempts);
    },
  }, 'Body', log.attempts);
  const doc = trap({
    getBody: () => body,
    saveAndClose: () => { log.saved++; },
    getUrl: () => 'https://docs.google.com/document/d/fake-doc/edit',
    getId: () => 'fake-doc',
  }, 'Document', log.attempts);
  return trap({
    create: (title) => { log.created.push(title); return doc; },
    ElementType,
    ParagraphHeading: { TITLE: 'TITLE', HEADING1: 'HEADING1', HEADING2: 'HEADING2' },
    HorizontalAlignment: { RIGHT: 'RIGHT', LEFT: 'LEFT' },
  }, 'DocumentApp', log.attempts);
}

function frozenDate(iso) {
  const fixed = new Date(iso).getTime();
  return class FrozenDate extends Date {
    constructor(...a) { if (a.length === 0) super(fixed); else super(...a); }
    static now() { return fixed; }
  };
}

function formatDate(d, tz, fmt) {
  const parts = {};
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(d).forEach((p) => { parts[p.type] = p.value; });
  return fmt.replace('yyyy', parts.year).replace('MM', parts.month).replace('dd', parts.day)
    .replace('HH', parts.hour).replace('mm', parts.minute);
}

function loadCode(tabs, nowIso) {
  const attempts = [];
  const logs = [];
  const doc = { created: [], paragraphs: [], tables: [], order: [], attempts: [], saved: 0 };
  const sheets = (tabs || []).map((t) => roSheet(t.name, t.header, t.rows, attempts));
  const ss = trap({
    getSheetByName: (n) => sheets.find((s) => s.getName() === n) || null,
    getSpreadsheetTimeZone: () => 'Asia/Jerusalem',
  }, 'Spreadsheet', attempts);
  const sandbox = {
    console: { log() {}, warn() {}, error() {}, info() {} },
    JSON, Math, Date: frozenDate(nowIso || NOW), Number, String, Array, Object, RegExp, isFinite, isNaN,
    Logger: { log: (m) => logs.push(String(m)) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    DocumentApp: fakeDocumentApp(doc),
    Utilities: { formatDate, getUuid: () => { attempts.push('Utilities.getUuid'); return 'x'; } },
    LockService: { getScriptLock: () => { attempts.push('LockService'); throw new Error('no lock'); } },
    PropertiesService: { getScriptProperties: () => { attempts.push('PropertiesService'); throw new Error('no properties'); } },
    DriveApp: new Proxy({}, { get: (_, p) => () => { attempts.push('DriveApp.' + String(p)); throw new Error('no Drive'); } }),
    ContentService: {
      createTextOutput: (s) => ({ setMimeType: () => ({ json: JSON.parse(s) }) }),
      MimeType: { JSON: 'json' },
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(GS_SRC + `
    globalThis.__cols = {
      LEAD_COLUMNS, PATIENT_COLUMNS, DISCHARGED_PATIENT_COLUMNS, IRRELEVANT_LEAD_COLUMNS,
      REMOVED_LEAD_COLUMNS, PATIENT_TOMBSTONE_COLUMNS, PAYMENT_COLUMNS, CREDIT_COLUMNS,
      BILLING_OVERRIDE_COLUMNS, LEADS_SHEET, PATIENTS_SHEET, DISCHARGED_PATIENTS_SHEET,
      IRRELEVANT_LEADS_SHEET, REMOVED_LEADS_SHEET, PATIENTS_TOMBSTONES_SHEET, PAYMENTS_SHEET,
      CREDITS_SHEET, BILLING_OVERRIDES_SHEET,
    };`, sandbox);
  return { sandbox, attempts, logs, doc, C: sandbox.__cols };
}

function loadApp() {
  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/' },
    document: { addEventListener: noop, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    URLSearchParams, Math, Date, JSON, Number, String, Array, Object, RegExp, isNaN, isFinite, parseInt, parseFloat, Promise,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(APP_SRC + `
    globalThis.__app = {
      matchPatientForPayment, namesLookAlike, normalizeNameForMatch, reconnectCandidates,
      patientStayCoversDate, isPreRecordsCycle, RECORDS_COMPLETE_FROM, VAT_RATE, revenueExVat,
      paymentCoverage, applyBillingOverride, normalizeStage, normalizePayment, projectedCycleDueDates,
      revenueMonthBounds, isoDate, isoFromLocalDate, patientKey,
    };`, sandbox);
  return sandbox.__app;
}

const rowOf = (cols, f) => arr(cols).map((c) => (f[c] === undefined ? '' : f[c]));

/* ---------- the synthetic spreadsheet (today = 30/09/2026) ---------- */
function world() {
  const { C } = loadCode([]);
  const L = (f) => rowOf(C.LEAD_COLUMNS, f);
  const R = (f) => rowOf(C.REMOVED_LEAD_COLUMNS, f);
  const P = (f) => rowOf(C.PATIENT_COLUMNS, f);
  const D = (f) => rowOf(C.DISCHARGED_PATIENT_COLUMNS, f);
  const T = (f) => rowOf(C.PATIENT_TOMBSTONE_COLUMNS, f);
  const PAYH = arr(C.PAYMENT_COLUMNS).concat(['טלפון', 'אמצעי תשלום']);
  const Y = (f) => rowOf(PAYH, f);
  const CR = (f) => rowOf(C.CREDIT_COLUMNS, f);
  const O = (f) => rowOf(C.BILLING_OVERRIDE_COLUMNS, f);
  const avi = 'ramot::אבי כהן::2026-07-10';
  return [
    { name: C.LEADS_SHEET, header: arr(C.LEAD_COLUMNS), rows: [
      L({ id: 'lead-1', name: 'אבי כהן', phone: '050-111-0001', house: 'רמות השבים', stage: 'admitted', created: '2026-06-01' }),   // 2
      L({ id: 'lead-2', name: 'בני לוי', phone: '0501110002', house: 'רעננה אשר', stage: 'מקדמה שולמה', advance: 5000,
        created: '2026-08-01', visitDate: '2026-08-10', entryDate: '2026-09-01' }),                                            // 3 → A
      L({ id: 'lead-3', name: 'גילה מזרחי', phone: '0501110003', house: 'קיסריה ריהאב', stage: 'visit', meetingOutcome: 'entered',
        created: '2026-09-01', visitDate: '2026-09-15' }),                                                                     // 4 → A
      L({ id: 'lead-4', name: 'דנה פרץ', phone: '+972-50-111-0004', house: 'קיסריה ריהאב', stage: 'paid' }),                   // 5 — patient by phone
      L({ id: 'lead-5', name: 'הדס שמעוני', phone: '', house: 'רמות השבים', stage: 'admitted' }),                              // 6 — patient by name+house
      L({ id: 'lead-6', name: 'ורד בר', phone: '0501110006', house: 'רעננה אשר', stage: 'new' }),                              // 7 → F
      L({ id: 'lead-7', name: 'זיו א' + FFFD + 'ון', phone: '0501110007', house: 'רמות השבים', stage: 'new' }),                 // 8 → D (phone)
      L({ id: 'lead-10', name: 'רון אלי', phone: '0501110010', house: 'רעננה אשר', stage: 'admitted' }),                       // 9
      L({ id: 'lead-11', name: 'מיכל', phone: '0501110011', house: 'רמות השבים', stage: 'admitted', created: '2026-05-01' }),  // 10 → A (audit note)
      L({ id: 'lead-13', name: FFFD + FFFD, phone: '', house: '', stage: 'new' }),                                            // 11 → D (no proposal)
    ] },
    { name: C.REMOVED_LEADS_SHEET, header: arr(C.REMOVED_LEAD_COLUMNS), rows: [
      R({ id: 'lead-9', name: 'גל דוד', phone: '0501110004', house: 'קיסריה ריהאב', stage: 'admitted' }),                      // 2
      R({ id: 'lead-12', name: 'זיו אלון', phone: '050-111-0007', house: 'רמות השבים', stage: 'new' }),                        // 3
    ] },
    { name: C.PATIENTS_SHEET, header: arr(C.PATIENT_COLUMNS), rows: [
      P({ id: 'pt-1', houseId: 'ramot', name: 'אבי כהן', date: '2026-07-10', pay: 30000, status: 'active', fromLead: 'lead-1' }),  // 2
      P({ id: 'pt-2', houseId: 'arfoni', name: 'בת-אל רון', date: '2026-06-20', pay: 35000, status: 'active' }),                  // 3
      P({ id: 'pt-3', houseId: 'rehab', name: 'גל דוד', date: '2026-08-05', pay: 20000, status: 'פעיל', fromLead: 'lead-9' }),     // 4
      P({ id: 'pt-4', houseId: 'ramot', name: 'הדס שמעוני', date: '2026-07-01', pay: 30000, status: 'active' }),                  // 5
      P({ id: 'pt-5', houseId: 'ramot', name: 'אבי כהן', date: '2026-07-10', pay: 30000, status: 'active', fromLead: 'lead-1' }),  // 6 — twin of row 2
      P({ id: 'pt-6', houseId: 'pardes', name: 'נועה ים', date: '2026-07-15', pay: 28000, status: 'released', exitDate: '2026-08-20' }), // 7
      P({ id: 'pt-7', houseId: 'asher', name: 'רון ' + FFFD + 'לי', date: '2026-08-01', pay: 15000, status: 'active', fromLead: 'lead-10' }), // 8
      P({ id: 'pt-8', houseId: 'sde', name: 'שחר חיון', date: '2026-09-07', pay: 35000, status: 'active' }),                      // 9
      P({ id: 'pt-9', houseId: 'arfoni', name: 'עמית בורנשטיין', date: '2026-09-07', pay: 30000, status: 'active' }),             // 10
    ] },
    { name: C.DISCHARGED_PATIENTS_SHEET, header: arr(C.DISCHARGED_PATIENT_COLUMNS), rows: [
      D({ id: 'aud-1', houseId: 'sde', name: 'שחר חיון', date: '2026-09-07', status: 'released', dischargedAt: '2026-09-20T08:00:00.000Z', restored: '' }), // 2 → C
      D({ id: 'aud-2', houseId: 'pardes', name: 'נועה ים', date: '2026-07-15', status: 'released', restored: '' }),               // 3 — patient not active
      D({ id: 'aud-3', houseId: 'ramot', name: 'מיכל', date: '2026-05-10', status: 'released', restored: true }),                  // 4
    ] },
    { name: C.PATIENTS_TOMBSTONES_SHEET, header: arr(C.PATIENT_TOMBSTONE_COLUMNS), rows: [
      T({ id: 'pt-99', houseId: 'arfoni', name: 'עמרי גל', date: '2026-07-03', status: 'active', reason: 'user-delete', droppedAt: '2026-09-01T08:00:00.000Z' }),
    ] },
    { name: C.PAYMENTS_SHEET, header: PAYH, rows: [
      Y({ id: 'pay::' + avi + '::2026-07-10', patientId: avi, patientName: 'אבי כהן', houseId: 'ramot', dueDate: '2026-07-10', amount: 30000, status: 'שולם', amountPaid: 30000, patientUid: 'pt-1' }), // 2
      Y({ id: 'pay::' + avi + '::2026-08-10', patientId: avi, patientName: 'אבי כהן', houseId: 'ramot', dueDate: '2026-08-10', amount: 30000, status: 'paid', amountPaid: 30000, patientUid: 'pt-1' }), // 3
      Y({ id: 'pay::' + avi + '::2026-09-10', patientId: avi, patientName: 'אבי כהן', houseId: 'ramot', dueDate: '2026-09-10', amount: 30000, status: 'unpaid', amountPaid: 0, patientUid: 'pt-1' }), // 4 → K off (override)
      Y({ id: 'p5', patientId: 'rehab::גל דוד::2026-08-05', patientName: 'גל דוד', houseId: 'rehab', dueDate: '2026-08-05', amount: 20000, status: 'paid', amountPaid: 20000 }), // 5
      Y({ id: 'p6', patientId: 'rehab::גל דוד::2026-08-05', patientName: 'גל דוד', houseId: 'rehab', dueDate: '2026-08-09', amount: 20000, status: 'paid', amountPaid: 20000 }), // 6 → I
      Y({ id: 'p7', patientId: 'rehab::גל דוד::2026-08-05', patientName: 'גל דוד', houseId: 'rehab', dueDate: '2026-09-05', amount: 20000, status: 'partial', amountPaid: 12000 }), // 7
      Y({ id: 'p8', patientId: 'ramot::הדס שמעוני::2026-07-01', patientName: 'הדס שמעוני', houseId: 'ramot', dueDate: '2026-07-01', amount: 25423.73, status: 'paid', amountPaid: 25423.73 }), // 8 → K off (ex-VAT)
      Y({ id: 'p9', patientId: 'ramot::הדס שמעוני::2026-07-01', patientName: 'הדס שמעוני', houseId: 'ramot', dueDate: '2026-08-01', amount: 30000, status: 'paid', amountPaid: 30000 }), // 9
      Y({ id: 'p10', patientId: 'ramot::הדס שמעוני::2026-07-01', patientName: 'הדס שמעוני', houseId: 'ramot', dueDate: '2026-09-01', amount: 30000, status: 'paid', amountPaid: 30000 }), // 10
      Y({ id: 'p11', patientId: 'pardes::נועה ים::2026-07-15', patientName: 'נועה ים', houseId: 'pardes', dueDate: '2026-07-15', amount: 28000, status: 'paid', amountPaid: 28000 }), // 11
      Y({ id: 'p12', patientId: 'pardes::נועה ים::2026-07-15', patientName: 'נועה ים', houseId: 'pardes', dueDate: '2026-08-15', amount: 28000, status: 'paid', amountPaid: 28000 }), // 12
      Y({ id: 'p13', patientId: 'pardes::נועה ים::2026-07-15', patientName: 'נועה ים', houseId: 'pardes', dueDate: '2026-09-15', amount: 28000, status: 'paid', amountPaid: 28000 }), // 13 → K after exit
      Y({ id: 'p14', patientId: 'asher::רון ' + FFFD + 'לי::2026-08-01', patientName: 'רון ' + FFFD + 'לי', houseId: 'asher', dueDate: '2026-08-01', amount: 15000, status: 'paid', amountPaid: 15000, patientUid: 'pt-7' }), // 14 → D
      Y({ id: 'p15', patientId: 'asher::רון ' + FFFD + 'לי::2026-08-01', patientName: 'רון', houseId: 'asher', dueDate: '2026-09-01', amount: 15000, status: 'paid', amountPaid: 15000, patientUid: 'pt-7' }), // 15
      Y({ id: 'p16', patientId: 'sde::שחר חיון ::2026-09-07', patientName: 'שחר חיון ', houseId: 'sde', dueDate: '2026-09-07', amount: 35000, status: 'paid', amountPaid: 35000 }), // 16 (triple_loose)
      Y({ id: 'p17', patientId: 'arfoni::עמרי גל::2026-07-03', patientName: 'עמרי גל', houseId: 'arfoni', dueDate: '2026-07-03', amount: 30000, status: 'paid', amountPaid: 30000, patientUid: 'pt-99' }), // 17 → E (tombstone)
      Y({ id: 'p18', patientId: '', patientName: 'ורד בר', houseId: 'asher', dueDate: '2026-09-12', amount: 40000, status: 'paid', amountPaid: 40000, 'טלפון': '050-111-0006', 'אמצעי תשלום': 'העברה' }), // 18 → E + F
      Y({ id: 'p19', patientId: 'arfoni::בת אל::2026-06-20', patientName: 'בת אל', houseId: 'arfoni', dueDate: '2026-06-20', amount: 35000, status: 'paid', amountPaid: 35000 }), // 19 → E (candidate pt-2)
      Y({ id: 'p20', patientId: 'arfoni::עמית יעקובי::2026-09-07', patientName: 'עמית יעקובי', houseId: 'arfoni', dueDate: '2026-09-07', amount: 30000, status: 'void', amountPaid: 30000 }), // 20 → I voided
      Y({ id: 'p21', patientId: 'arfoni::עמית בורנשטיין::2026-09-07', patientName: 'עמית בורנשטיין', houseId: 'arfoni', dueDate: '2026-09-07', amount: 30000, status: 'paid', amountPaid: 30000 }), // 21
    ] },
    { name: C.CREDITS_SHEET, header: arr(C.CREDIT_COLUMNS), rows: [
      CR({ id: 'c1', patientId: 'pt-6', patientName: 'נועה ים', houseId: 'pardes', amount: 5000, status: 'pending' }),                 // 2
      CR({ id: 'c2', patientId: 'pt-404', patientKey: 'ramot::אלמוני::2026-07-01', patientName: 'אלמוני', houseId: 'ramot', amount: 7000, status: 'pending' }), // 3 → J
      CR({ id: 'c3', patientId: 'pt-8', patientName: 'שחר חיון', houseId: 'sde', amount: 40000, status: 'pending' }),                // 4 → J exceeds
      CR({ id: 'c4', patientId: 'pt-405', patientName: 'בוטל', amount: 9000, status: 'cancelled' }),                                  // 5 — ignored
    ] },
    { name: C.BILLING_OVERRIDES_SHEET, header: arr(C.BILLING_OVERRIDE_COLUMNS), rows: [
      O({ id: 'ovr::' + avi + '::2026-09', patientId: avi, month: '2026-09', amount: 25000 }),
    ] },
  ];
}

function run(tabs) {
  const h = loadCode(tabs || world());
  const report = h.sandbox.reconciliationReportNow();
  return Object.assign(h, { report: plain(report) });
}

/* ===== 1. READ-ONLY — source ===== */

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
}
function stripStrings(src) {
  return src.replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, '""');
}
function reachableFunctions() {
  const { sandbox } = loadCode([]);
  const out = {};
  const queue = ['reconciliationReportNow'];
  while (queue.length) {
    const name = queue.shift();
    if (out[name]) continue;
    assert.equal(typeof sandbox[name], 'function', 'not a Code.gs function: ' + name);
    out[name] = sandbox[name].toString();
    const calls = stripStrings(stripComments(out[name])).match(/\b[A-Za-z_$][\w$]*(?=\s*\()/g) || [];
    calls.forEach((id) => {
      if (!out[id] && typeof sandbox[id] === 'function' && GS_SRC.includes('function ' + id + '(')) queue.push(id);
    });
  }
  return out;
}
const DOC_WRITERS = ['recWriteDoc_', 'recDocPara_', 'recDocTable_'];

test('no function the report reaches writes the spreadsheet, takes a lock, reads a property or touches Drive/mail/fetch', () => {
  const fns = reachableFunctions();
  const names = Object.keys(fns);
  ['recCollect_', 'recReadSheet_', 'recBuildReport_', 'recMatchPatient_', 'recStayCovers_', 'recCycleDueDates_',
    'accountingCoverage_', 'asISODate_', 'diagClientHouseId_', 'diagClientStatus_', 'diagPhoneKey_', 'hasCorruption_',
    'corruptionWildcardRegex_', 'paymentStatus_', 'recWriteDoc_', 'recDocTable_'].forEach((n) => {
    assert.ok(names.includes(n), 'expected the report to reach ' + n);
  });
  const SHEET_FORBIDDEN = [
    /\.setValues?\s*\(/, /\.appendRow\s*\(/, /\.deleteRows?\s*\(/, /\.insert\w*\s*\(/, /\.clear\w*\s*\(/,
    /\.set[A-Z]\w*\s*\(/, /\.delete\w*\s*\(/, /\.hideSheet\s*\(/, /\.copyTo\s*\(/, /\.moveTo\s*\(/,
    /\.protect\s*\(/, /\.getRange\([^)]*\)\s*\.sort\s*\(/, /\bgetOrCreateSheet_\s*\(/, /\blogAudit_\s*\(/,
    /\bLockService\b/, /\bPropertiesService\b/, /\bUrlFetchApp\b/, /\bMailApp\b/, /\bGmailApp\b/, /\bDriveApp\b/,
    /\bDrive\.\w/, /\bDocumentApp\b/, /\binsertSheet\b/,
  ];
  names.filter((n) => !DOC_WRITERS.includes(n)).forEach((n) => {
    const src = stripComments(fns[n]);
    SHEET_FORBIDDEN.forEach((re) => assert.ok(!re.test(src), n + ' (reached by the report) must not match ' + re));
  });
});

test('DocumentApp is the ONLY write path: the three document writers touch no sheet, and nothing shares or moves the doc', () => {
  const fns = reachableFunctions();
  DOC_WRITERS.forEach((n) => {
    assert.ok(fns[n], n + ' is reached');
    const src = stripComments(fns[n]);
    [/\bSpreadsheetApp\b/, /\bgetRange\b/, /\bgetSheet\w*\b/, /\bgetOrCreateSheet_\b/, /\blogAudit_\b/, /\bLockService\b/,
      /\bPropertiesService\b/, /\bDriveApp\b/, /\bDrive\.\w/, /\bUrlFetchApp\b/, /\bMailApp\b/].forEach((re) => {
      assert.ok(!re.test(src), n + ' must not match ' + re);
    });
  });
  Object.keys(fns).forEach((n) => {
    const src = stripComments(fns[n]);
    [/\baddEditors?\b/, /\baddViewers?\b/, /\baddCommenters?\b/, /\bsetSharing\b/, /\bmoveTo\b/, /\bmakeCopy\b/, /\bsetOwner\b/]
      .forEach((re) => assert.ok(!re.test(src), n + ' must not share or move the document: ' + re));
  });
  assert.equal((stripComments(fns.recWriteDoc_).match(/DocumentApp\.create\s*\(/g) || []).length, 1, 'exactly one create()');
});

/* ===== 1b. READ-ONLY — runtime ===== */

test('runs end to end against a spreadsheet whose every mutator throws — ZERO sheet attempts, ONE private doc', () => {
  const { attempts, logs, doc, report } = run();
  assert.deepEqual(attempts, [], 'no sheet write / lock / property / uuid / Drive attempt of any kind');
  assert.deepEqual(doc.attempts, [], 'nothing beyond create + append + formatting on the document');
  assert.equal(doc.created.length, 1);
  assert.match(doc.created[0], /^E-Zone דוח פערים \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(doc.created[0], 'E-Zone דוח פערים 2026-09-30 12:00', 'Israel wall-clock time in the title');
  assert.equal(doc.saved, 1);
  assert.equal(report.url, 'https://docs.google.com/document/d/fake-doc/edit');
  assert.ok(logs.some((l) => l.includes('https://docs.google.com/document/d/fake-doc/edit')), 'the URL is logged');
  assert.match(logs[0], /READ-ONLY on the spreadsheet/);
});

test('every paragraph and every table cell in the document is right-to-left and right-aligned', () => {
  const { doc } = run();
  assert.ok(doc.paragraphs.length > 50);
  doc.paragraphs.forEach((p) => assert.equal(p.ltr, false, 'RTL: ' + JSON.stringify(p.text)));
  doc.paragraphs.filter((p) => p.text !== '').forEach((p) => assert.equal(p.align, 'RIGHT'));
  doc.tables.forEach((t) => assert.equal(t.bold, true, 'header row bold'));
});

test('an EMPTY spreadsheet (no tabs) is reported, not crashed on, and creates no tab', () => {
  const h = loadCode([]);
  const report = plain(h.sandbox.reconciliationReportNow());
  assert.deepEqual(h.attempts, []);
  assert.equal(report.missingTabs.length, 9);
  assert.ok(report.summary.every((s) => s.count === 0));
  assert.ok(h.doc.order.some((o) => o.p && o.p.startsWith('לשוניות חסרות:')));
  assert.ok(h.doc.order.filter((o) => o.p === 'אין פריטים.').length >= 11);
});

/* ===== 2. not reachable over HTTP ===== */

test('not reachable over HTTP: handle_ never names it and answers unknown_action', () => {
  const handleSrc = GS_SRC.slice(GS_SRC.indexOf('function handle_('), GS_SRC.indexOf('function collectParams_('));
  assert.ok(!/reconciliation|recBuild|recCollect/.test(handleSrc));
  const { sandbox } = loadCode([]);
  const out = plain(sandbox.handle_({ action: 'reconciliationReportNow' }).json);
  assert.deepEqual(out, { ok: false, error: 'unknown_action', action: 'reconciliationReportNow' });
  assert.ok(/\nfunction reconciliationReportNow\(\)/.test(GS_SRC), 'public (no underscore) so it is in the Run dropdown');
});

test('appsscript.json: the documents scope is declared beside the existing explicit scopes', () => {
  assert.ok(MANIFEST.oauthScopes.includes('https://www.googleapis.com/auth/documents'));
  assert.ok(MANIFEST.oauthScopes.includes('https://www.googleapis.com/auth/spreadsheets'));
  assert.equal(MANIFEST.timeZone, 'Asia/Jerusalem');
});

/* ===== 3. the sections ===== */

const S = () => run().report.sections;

test('summary: one count per section A–K, in order, with ₪ impact where money is involved', () => {
  const { report, doc } = run();
  assert.deepEqual(report.summary.map((s) => s.letter), ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K']);
  const by = Object.fromEntries(report.summary.map((s) => [s.letter, s]));
  assert.deepEqual([by.A.count, by.B.count, by.C.count, by.D.count, by.E.count, by.F.count, by.G.count, by.H.count, by.I.count, by.J.count, by.K.count],
    [3, 3, 1, 4, 3, 1, 2, 4, 2, 2, 3]);
  assert.equal(by.E.money, 105000);
  assert.equal(by.H.money, 105000 + 85000 + 25000 + 8000);
  const summaryTable = doc.tables[0];
  assert.equal(summaryTable.cells.length, 12, 'header + 11 sections');
  assert.deepEqual(plain(summaryTable.cells[0]), ['השפעה כספית', 'מספר פריטים', 'סעיף'], 'columns placed right-to-left');
});

test('A: leads that paid / were admitted / are entering treatment with no Patients row — fromLead, phone and name+house all count as a row', () => {
  const a = S().A;
  assert.deepEqual(a.map((x) => x.lead.id), ['lead-2', 'lead-3', 'lead-11'], 'largest advance first, then newest');
  assert.equal(a[0].ref, 'Leads שורה 3');
  assert.equal(a[0].lead.phone, '0501110002');
  assert.equal(a[0].lead.created, '2026-08-01');
  assert.equal(a[1].why, 'נכנסים לטיפול');
  assert.ok(a[2].notes.some((n) => n === 'קיים במטופלים משוחררים שורה 4'), 'an audit trace is shown, not hidden');
  // lead-1 (fromLead), lead-4 (phone via removed lead-9 → patient row 4), lead-5 (name + house) are NOT listed.
  ['lead-1', 'lead-4', 'lead-5', 'lead-10'].forEach((id) => assert.ok(!a.some((x) => x.lead.id === id), id));
});

test('B: an active patient duplicated by house+name+date, by fromLead and by phone', () => {
  const b = S().B;
  assert.deepEqual(b.map((x) => x.kind).sort(), ['fromLead', 'key', 'phone']);
  b.forEach((g) => assert.deepEqual(g.refs, ['Patients שורה 2', 'Patients שורה 6']));
  assert.equal(b.find((g) => g.kind === 'phone').key, '0501110001');
});

test('C: an OPEN discharge audit row whose stay is still an active patient — restored and non-active ones are not', () => {
  const c = S().C;
  assert.equal(c.length, 1);
  assert.equal(c[0].audit.row, 2);
  assert.equal(c[0].patient.row, 9);
  assert.equal(c[0].via, 'house_name_date');
});

test('D: U+FFFD names with a proposed clean name and a confidence level', () => {
  const d = S().D;
  const at = (ref) => d.find((x) => x.ref === ref);
  assert.deepEqual([at('Patients שורה 8').proposal, at('Patients שורה 8').confidence], ['רון אלי', 'גבוהה'], 'same fromLead');
  assert.deepEqual([at('Leads שורה 8').proposal, at('Leads שורה 8').confidence], ['זיו אלון', 'בינונית'], 'same phone');
  assert.deepEqual([at('Payments שורה 14').proposal, at('Payments שורה 14').confidence], ['רון אלי', 'נמוכה'], 'pattern only');
  assert.deepEqual([at('Leads שורה 11').proposal, at('Leads שורה 11').confidence], ['', 'אין הצעה'], 'never a guess');
  assert.deepEqual(d.map((x) => x.confidence), ['גבוהה', 'בינונית', 'נמוכה', 'אין הצעה'], 'most certain first');
});

test('E: detached payments — largest ₪ first, tombstoned patient named, best candidate with its reason', () => {
  const e = S().E;
  assert.deepEqual(e.map((x) => x.payment.row), [18, 19, 17]);
  assert.equal(e[0].phone, '050-111-0006');
  assert.equal(e[0].payment.method, 'העברה');
  assert.match(e[0].best, /^ליד: ורד בר — Leads שורה 7$/);
  assert.equal(e[0].reason, 'טלפון, שם זהה');
  assert.match(e[1].best, /^בת-אל רון — Patients שורה 3$/);
  assert.match(e[1].reason, /תאריך כניסה ±יום/);
  assert.ok(e[2].notes.some((n) => /מצביע על מטופל שנמחק — PatientsTombstones שורה 2 \(user-delete\)/.test(n)));
  // The trailing-space row (16) is attached by the normalized triple; the void row (20) is not "detached money".
  assert.ok(!e.some((x) => x.payment.row === 16 || x.payment.row === 20));
});

test('F: paid but not admitted — a detached payment that matches a lead with no patient record', () => {
  const f = S().F;
  assert.equal(f.length, 1);
  assert.equal(f[0].ref, 'Payments שורה 18');
  assert.equal(f[0].lead.id, 'lead-6');
  assert.equal(f[0].money, 40000);
});

test('G: active patients with no payment at all', () => {
  const g = S().G;
  assert.deepEqual(g.map((x) => x.ref), ['Patients שורה 3', 'Patients שורה 6']);
});

test('H: stay months vs covered months — the cutoff, a partial cycle, an override and the ex-VAT gap', () => {
  const h = S().H;
  const at = (row) => h.find((x) => x.patient.row === row);
  assert.deepEqual(h.slice(0, 4).map((x) => x.patient.row), [3, 6, 2, 4], 'largest gap first');
  const p3 = at(3);
  assert.deepEqual([p3.stayMonths, p3.beforeCutoff, p3.missing, p3.gap], [4, 1, 3, 105000], 'the June cycle is before the records');
  assert.equal(p3.gapExVat, 88983.05);
  const p2 = at(2);
  assert.deepEqual([p2.stayMonths, p2.covered, p2.missing, p2.totalPaid, p2.gap, p2.expected], [3, 2, 1, 60000, 25000, 85000],
    'September is billed at its override (₪25,000), not the stored ₪30,000');
  const p4 = at(4);
  assert.deepEqual([p4.covered, p4.partial, p4.gap, p4.totalPaid], [1, 1, 8000, 52000]);
  const p5 = at(5);
  assert.deepEqual([p5.stayMonths, p5.beforeCutoff, p5.gap], [3, 0, 0], 'the cutoff day itself is inside the records');
  assert.equal(at(9).gap, 0, 'attached through the normalized triple');
  assert.ok(!h.some((x) => x.patient.row === 7), 'released patients are not active');
  assert.equal(h.length, 8);
});

test('I: the same patient and amount within 7 days, and voided rows shown apart with their twin', () => {
  const i = S().I;
  assert.equal(i.pairs.length, 1);
  assert.deepEqual([i.pairs[0].a.row, i.pairs[0].b.row, i.pairs[0].days], [5, 6, 4]);
  assert.equal(i.voided.length, 1);
  assert.equal(i.voided[0].payment.row, 20);
  assert.deepEqual(i.voided[0].twins.map((p) => p.row), [21]);
});

test('J: a credit attached to nobody, and credits larger than the patient\'s payments — cancelled ones ignored', () => {
  const j = S().J;
  assert.deepEqual(j.map((x) => [x.kind, x.refs.join(','), x.money]),
    [['unattached', 'Credits שורה 3', 7000], ['exceeds', 'Credits שורה 4', 5000]]);
  assert.equal(j[1].paid, 35000);
});

test('K: a payment after the exit date, and amounts >5% off the (override-aware) monthly pay', () => {
  const k = S().K;
  assert.deepEqual(k.after.map((x) => x.payment.row), [13]);
  assert.equal(k.after[0].exit, '2026-08-20');
  assert.deepEqual(k.off.map((x) => x.payment.row), [4, 8]);
  assert.match(k.off[0].note, /מול חריגת חיוב לחודש/);
  assert.equal(k.off[0].expected, 25000);
  assert.equal(k.off[1].note, 'נראה כסכום ללא מע״מ');
});

test('every item in the document names its tab and row, and tables read right-to-left', () => {
  const { doc } = run();
  const heads = doc.order.filter((o) => o.p && /^[A-K]\. /.test(o.p)).map((o) => o.p[0]);
  assert.deepEqual(heads, ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K']);
  doc.tables.slice(1).forEach((t) => {
    t.cells.slice(1).forEach((r) => assert.ok(r.some((c) => /(Leads|Patients|Payments|Credits|מטופלים משוחררים|לידים שהוסרו) שורה \d+/.test(c)), r.join(' | ')));
  });
  const h = doc.tables.find((t) => t.cells[0][t.cells[0].length - 1] === 'שורה' && t.cells[0].includes('פער ₪ ללא מע״מ'));
  assert.ok(h, 'H table present');
  assert.ok(h.cells[1].includes('₪105,000') && h.cells[1].includes('₪88,983'));
});

/* ===== 4. parity with public/app.js ===== */

const app = loadApp();
const gs = loadCode([]).sandbox;

const PATIENTS = [
  { id: 'u1', houseId: 'ramot', name: 'אבי כהן', date: '2026-07-10', status: 'active', exitDate: '' },
  { id: 'u2', houseId: 'ramot', name: 'אבי כהן', date: '2026-07-10', status: 'active', exitDate: '' },
  { id: 'u3', houseId: 'arfoni', name: 'שחר חיון', date: '2026-09-07', status: 'active', exitDate: '' },
  { id: 'u4', houseId: 'rehab', name: 'עדי עמית', date: '2026-09-14', status: 'released', exitDate: '2026-09-25' },
  { id: 'u5', houseId: 'rehab', name: 'אביב שבתאי', date: '2026-07-13', status: 'released', exitDate: '' },
  { id: 'u6', houseId: 'pardes', name: 'נועם אשבל', date: '2026-01-31', status: 'active', exitDate: '' },
  { id: 'u7', houseId: 'asher', name: 'Dana Lee', date: '2026-02-29', status: 'trial', exitDate: '2026-12-31' },
];
const PAYS = [
  { patientUid: 'u3', patientId: 'x::y::z', patientName: 'שחר', houseId: 'arfoni' },
  { patientUid: 'gone', patientId: 'arfoni::שחר חיון::2026-09-07', patientName: 'שחר חיון', houseId: 'arfoni' },
  { linkPatientUid: 'u4', patientUid: 'u3' },
  { patientId: 'ramot::אבי כהן::2026-07-10', patientName: 'אבי כהן', houseId: 'ramot' },
  { patientId: 'arfoni::שחר חיון ::2026-09-07', patientName: 'שחר חיון ', houseId: 'arfoni' },
  { patientId: 'arfoni::שחר' + RLM + ' חיון::2026-09-07' },
  { patientId: 'rehab::עדי::2026-09-14', patientName: 'עדי עמית', houseId: 'rehab' },
  { patientId: '', patientName: 'dana  LEE', houseId: 'רעננה אשר' },
  { patientId: '', patientName: 'אבי כהן', houseId: 'ramot' },
  { patientId: 'bad-id', patientName: 'אביב שבתאי', houseId: 'קיסריה ריהאב' },
  { patientId: '', patientName: 'אף אחד', houseId: 'sde' },
  { patientName: 'עדי', houseId: 'rehab', dueDate: '2026-09-15' },
  { patientName: 'נועם', houseId: 'rehab', dueDate: '2026-01-31' },
];

test('parity: payment → patient matching, all four tiers and every refusal, is app.js matchPatientForPayment', () => {
  PAYS.forEach((pay) => {
    const a = app.matchPatientForPayment(pay, PATIENTS);
    const g = gs.recMatchPatient_(pay, PATIENTS);
    assert.deepEqual(g ? [g.patient.id, g.via] : null, a ? [a.patient.id, a.via] : null, JSON.stringify(pay));
  });
  const vias = PAYS.map((p) => (app.matchPatientForPayment(p, PATIENTS) || {}).via).filter(Boolean);
  ['patientUid', 'triple_loose', 'house_name'].forEach((v) => assert.ok(vias.includes(v), 'fixture exercises ' + v));
  const exact = [{ id: 'q', houseId: 'ramot', name: 'אבי כהן', date: '2026-07-10' }];
  assert.equal(gs.recMatchPatient_(PAYS[3], exact).via, 'triple_exact');
  assert.equal(app.matchPatientForPayment(PAYS[3], exact).via, 'triple_exact');
});

test('parity: reconnect candidates (score, reasons, order) are app.js reconnectCandidates', () => {
  PAYS.forEach((pay) => {
    const a = plain(app.reconnectCandidates(pay, PATIENTS).map((c) => [c.patient.id, c.score, c.reasons]));
    const g = plain(gs.recCandidates_(pay, PATIENTS).map((c) => [c.patient.id, c.score, c.reasons]));
    assert.deepEqual(g, a, JSON.stringify(pay));
  });
});

test('parity: name normalization and look-alike names', () => {
  const names = ['אבי כהן', ' אבי כהן ', 'אבי' + NBSP + 'כהן', 'אבי' + RLM + ' כהן', 'אבי  כהן', 'ABI Cohen', 'abi cohen',
    'ערן', 'ערן יצחק חונה', 'עדי', 'עדי עמית', 'בת-אל רון', 'בת אל', 'א ב', '', 'e\u0301', '\u00e9'];
  names.forEach((n) => assert.equal(gs.recNameKey_(n), app.normalizeNameForMatch(n), JSON.stringify(n)));
  names.forEach((x) => names.forEach((y) => {
    assert.equal(gs.recNamesLookAlike_(x, y), app.namesLookAlike(x, y), JSON.stringify([x, y]));
  }));
});

test('parity: the stay window, the records cutoff, VAT and ex-VAT rounding', () => {
  const dates = ['2026-01-30', '2026-01-31', '2026-06-30', '2026-07-01', '2026-07-13', '2026-09-07', '2026-09-25', '2026-09-26', '2026-12-31', '', '2026-09-06T21:00:00.000Z'];
  PATIENTS.concat([{ id: 'dx', date: '2026-07-01', status: 'released', dischargedAt: '2026-08-01' }, null]).forEach((p) => {
    dates.forEach((d) => assert.equal(gs.recStayCovers_(p, d), app.patientStayCoversDate(p, d), JSON.stringify([p && p.id, d])));
  });
  assert.equal(gs.recRecordsCutoff_(), app.RECORDS_COMPLETE_FROM);
  dates.forEach((d) => assert.equal(gs.recBeforeCutoff_(d), app.isPreRecordsCycle(d), d));
  assert.equal(gs.recBeforeCutoff_('2026-01-15', '2026-02-01'), app.isPreRecordsCycle('2026-01-15', '2026-02-01'));
  assert.equal(gs.recVatRate_(), app.VAT_RATE);
  [0, 1, 18, 30000, 35000, 25423.73, 1234.567, -500, '3000', null].forEach((v) => assert.equal(gs.recExVat_(v), app.revenueExVat(v), String(v)));
});

test('parity: a payment\'s coverage period (recorded wins, else inferred) is app.js paymentCoverage', () => {
  const rows = [
    { dueDate: '2026-01-31' }, { dueDate: '2026-02-28' }, { dueDate: '2026-07-10' },
    { dueDate: '2026-07-10', coverageStart: '2026-07-15', coverageEnd: '2026-09-14' },
    { dueDate: '2026-07-10', coverageStart: '2026-07-15', coverageEnd: '' },
    { dueDate: '2026-07-10', coverageStart: '2026-09-15', coverageEnd: '2026-07-14' },
    { dueDate: '2026-07-10', coverageStart: '2026-02-30', coverageEnd: '2026-03-10' },
    { dueDate: '2026-07-10', coverageStart: '2026-01-01', coverageEnd: '2027-06-01' },
    { dueDate: '2026-09-06T21:00:00.000Z' }, { dueDate: '' }, {},
  ];
  const view = (c) => (c ? [app.isoFromLocalDate(c.start), app.isoFromLocalDate(c.end), c.source] : null);
  rows.forEach((r) => assert.deepEqual(view(gs.accountingCoverage_(r)), view(app.paymentCoverage(r)), JSON.stringify(r)));
});

test('parity: billing overrides touch only UNPAID rows, for their due-date month', () => {
  const ovr = [{ patientId: 'ramot::אבי כהן::2026-07-10', month: '2026-09', amount: 25000 },
    { patientId: 'ramot::אבי כהן::2026-07-10', month: '2026-10', amount: '0' }];
  [['unpaid', '2026-09-10', 5000], ['partial', '2026-09-10', 12000], ['paid', '2026-09-10', 30000], ['unpaid', '2026-08-10', 0],
    ['unpaid', '2026-10-10', 0], ['unpaid', '2026-09-30', 0]].forEach(([status, dueDate, amountPaid]) => {
    const pay = { id: 'x', patientId: 'ramot::אבי כהן::2026-07-10', dueDate, status, amount: 30000, amountPaid, balance: 30000 - amountPaid };
    const a = app.applyBillingOverride(pay, ovr);
    const g = gs.recApplyOverride_(pay, ovr);
    assert.deepEqual([g.amount, g.balance], [a.amount, a.balance], JSON.stringify([status, dueDate]));
  });
});

test('parity: stage aliases and payment-status aliases (void kept apart, per PR #144)', () => {
  const stages = ['new', 'ליד חדש', 'visit', 'ביקור', 'paid', 'מקדמה שולמה', 'בטיפול פעיל', 'entry', 'entered', 'נכנס',
    'admitted', 'נקלט', 'אושפז', 'irrelevant', 'לא רלוונטי', 'waitlist', 'רשימת המתנה', 'PAID', ' paid ', 'garbage', '', null, undefined];
  stages.forEach((s) => assert.equal(gs.recStage_(s), app.normalizeStage(s), JSON.stringify(s)));
  ['שולם', 'paid', 'PAID', 'שולם חלקית', 'partial', 'לא שולם', 'unpaid', '', 'junk', ' שולם '].forEach((s) => {
    assert.equal(gs.recPaymentStatus_(s), app.normalizePayment({ status: s }).status, JSON.stringify(s));
  });
  assert.equal(gs.recPaymentStatus_('void'), 'void');
  assert.equal(gs.recPaymentStatus_('מבוטל'), 'void');
});

test('parity: cycle due dates are the entry-day cycles app.js projects, month by month, up to today', () => {
  const today = '2026-09-30';
  const patients = [
    { date: '2026-01-31', status: 'active' }, { date: '2026-06-20', status: 'active' },
    { date: '2026-07-10', status: 'released', exitDate: '2026-09-10' }, { date: '2026-07-10', status: 'active', exitDate: '2026-09-11' },
    { date: '2026-02-29', status: 'active' }, { date: '2026-09-30', status: 'active' }, { date: '2026-10-05', status: 'active' },
  ];
  patients.forEach((p) => {
    const want = new Set();
    for (let m = 1; m <= 10; m++) {
      const b = app.revenueMonthBounds('2026-' + String(m).padStart(2, '0'));
      app.projectedCycleDueDates(p, b).forEach((d) => { if (d <= today) want.add(d); });
    }
    assert.deepEqual(arr(gs.recCycleDueDates_(p, today)), [...want].sort(), JSON.stringify(p));
  });
});

test('parity: the date normalizer the report reads with agrees with app.js isoDate', () => {
  ['2026-07-10', '2026-09-06T21:00:00.000Z', '2026-03-28T22:00:00Z', new Date(2026, 6, 10), new Date('2026-07-10T23:30:00+03:00')]
    .forEach((v) => assert.equal(gs.asISODate_(v), app.isoDate(v), String(v)));
});

/* ===== 5. additive only ===== */

test('the report section declares only functions, each name exactly once in Code.gs', () => {
  const start = GS_SRC.indexOf('/* ===== Reconciliation report (READ-ONLY');
  assert.ok(start > 0);
  const section = stripStrings(stripComments(GS_SRC.slice(start)));
  let depth = 0;
  const top = [];
  section.split('\n').forEach((ln) => {
    if (depth === 0 && ln.trim()) top.push(ln.trim());
    for (const ch of ln) { if (ch === '{') depth++; else if (ch === '}') depth--; }
  });
  top.forEach((ln) => assert.match(ln, /^(function [A-Za-z_$][\w$]*\s*\(|\}$)/, 'only function declarations: ' + ln));
  const names = top.map((ln) => (ln.match(/^function ([A-Za-z_$][\w$]*)/) || [])[1]).filter(Boolean);
  assert.ok(names.includes('reconciliationReportNow') && names.length > 40);
  names.forEach((n) => {
    const decl = GS_SRC.match(new RegExp('(^|\\n)\\s*(function\\s+|(const|let|var)\\s+)' + n.replace(/\$/g, '\\$') + '\\b', 'g')) || [];
    assert.equal(decl.length, 1, n + ' declared exactly once');
  });
});
