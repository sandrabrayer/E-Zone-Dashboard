/* «ייצוא רשימת תיקונים» — the data-cleanup workbook.
 * See CHANGELOG-cleanup-workbook.md.
 *
 * Locked here:
 *   - Code.gs cleanupReport_ on one synthetic world: every tab's rows, from the
 *     EXISTING checks (reconciliation §A/§D/§E/§F, debtAging_,
 *     refundPayoutForecastFor_), plus the new cross-tab spelling, near-duplicate
 *     and same-month duplicate rules
 *   - the «כנראה טעות רישום» rule, exactly
 *   - the action: read-only, PROXY_SECRET-gated (refused in enforce mode
 *     without it), not open, known, a finance action; getData keeps its keys
 *   - the workbook: a count-only «סיכום» first, then one tab per kind, each row
 *     with בית, מטופל, פרטים, הבעיה, מי מתקן, איך מתקנים, טופל ☐; RTL, colours,
 *     computed widths; no "איזון" / "E-ZONE" anywhere
 *   - the route: 401 / 403 (restricted session) / 503 without PROXY_SECRET;
 *     headers, no-store, no patient data in the log
 *   - the button (finance view only), the service worker (v28, network-only)
 *
 * vm sandbox on the real Code.gs and public/app.js. TZ pinned to Israel.
 * All names are SYNTHETIC. */

process.env.TZ = 'Asia/Jerusalem';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const ExcelJS = require('exceljs');
const JSZip = require('jszip');

const ROOT = path.join(__dirname, '..');
const GS_SRC = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const HTML_SRC = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const SW_SRC = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');
const SERVER_PATH = require.resolve('../server');

const cleanup = require('../lib/cleanup-xlsx');
const report = require('../lib/xlsx-report');
const scope = require('../lib/finance-scope');
const { createSessionToken } = require('../lib/session');
const pinHash = require('../lib/pin-hash');
const users = require('../lib/users');

const plain = (v) => JSON.parse(JSON.stringify(v));
const PROXY = 'proxy-secret-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const TODAY = '2026-10-03';
const NOW = '2026-10-03T07:00:00.000Z';   // 10:00 in Israel
const BANNED = ['איזון', 'E-ZONE'];

/* ---------- a read-only spreadsheet (every other method records + throws) ---------- */

function formatDate(d, tz, fmt) {
  const parts = {};
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(d).forEach((p) => { parts[p.type] = p.value; });
  return fmt.replace('yyyy', parts.year).replace('MM', parts.month).replace('dd', parts.day)
    .replace('HH', parts.hour).replace('mm', parts.minute);
}
function frozenDate(iso) {
  const fixed = new Date(iso).getTime();
  return class FrozenDate extends Date {
    constructor(...a) { if (a.length === 0) super(fixed); else super(...a); }
    static now() { return fixed; }
  };
}
function readOnly(target, label, attempts) {
  return new Proxy(target, {
    get(t, prop) {
      if (prop in t) return t[prop];
      if (typeof prop === 'symbol' || prop === 'then' || prop === 'toJSON') return undefined;
      return () => { attempts.push(label + '.' + String(prop)); throw new Error('read-only: ' + label + '.' + String(prop)); };
    },
  });
}
function roSheet(name, header, rows, attempts) {
  const grid = [header.slice()].concat(rows.map((r) => r.slice()));
  const width = () => grid.reduce((m, r) => Math.max(m, r.length), 0);
  return readOnly({
    getName: () => name,
    getLastRow: () => grid.length,
    getLastColumn: () => width(),
    getMaxColumns: () => Math.max(26, width()),
    getRange: (r, c, nr, nc) => {
      nr = nr || 1; nc = nc || 1;
      const read = () => {
        const out = [];
        for (let i = 0; i < nr; i++) {
          const row = [];
          for (let j = 0; j < nc; j++) { const g = grid[r - 1 + i]; row.push(g && g[c - 1 + j] !== undefined ? g[c - 1 + j] : ''); }
          out.push(row);
        }
        return out;
      };
      return readOnly({ getValues: read }, 'Range(' + name + ')', attempts);
    },
  }, 'Sheet(' + name + ')', attempts);
}

function loadGs(opts) {
  const o = opts || {};
  const attempts = [];
  const sheets = (o.sheets || []).map((s) => roSheet(s.name, s.header, s.rows, attempts));
  const ss = readOnly({
    getSheetByName: (n) => sheets.find((s) => s.getName() === n) || null,
    getSpreadsheetTimeZone: () => 'Asia/Jerusalem',
  }, 'Spreadsheet', attempts);
  const props = Object.assign({}, o.props || {});
  const sandbox = {
    console: { log() {}, warn() {}, error() {}, info() {} },
    JSON, Math, Date: frozenDate(o.now || NOW), Number, String, Array, Object, RegExp, isFinite, isNaN,
    Logger: { log() {} },
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    Utilities: { formatDate, getUuid: () => { attempts.push('Utilities.getUuid'); return 'x'; } },
    LockService: { getScriptLock: () => { attempts.push('LockService'); throw new Error('no lock'); } },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null) }) },
    CacheService: { getScriptCache: () => ({ get: () => null, put: () => {} }) },
    ContentService: { createTextOutput: (s) => ({ setMimeType: () => ({ json: JSON.parse(s) }) }), MimeType: { JSON: 'json' } },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(GS_SRC + `
    globalThis.__c = { LEAD_COLUMNS, PATIENT_COLUMNS, DISCHARGED_PATIENT_COLUMNS, PAYMENT_COLUMNS, CREDIT_COLUMNS,
      BILLING_OVERRIDE_COLUMNS, LEADS_SHEET, PATIENTS_SHEET, DISCHARGED_PATIENTS_SHEET, PAYMENTS_SHEET, CREDITS_SHEET,
      BILLING_OVERRIDES_SHEET, OPEN_ACTIONS, PROXY_KNOWN_ACTIONS, FINANCE_ACTIONS, CLEANUP_SECTION_KEYS, CLEANUP_STALE_DAYS };`, sandbox);
  return { sandbox, attempts, C: sandbox.__c };
}

/* ---------- the synthetic world ---------- */

const key = (h, n, d) => `${h}::${n}::${d}`;
const AVI = key('ramot', 'אבי כהן', '2026-07-10');
const BAT = key('arfoni', 'בת-אל רון', '2026-07-20');
const GAL = key('rehab', 'גל דוד', '2026-07-05');
const DANA = key('rehab', 'דנה לוי', '2026-07-15');
const DANA2 = key('rehab', 'דנה לואי', '2026-07-15');
const AMIT = key('arfoni', 'עמית בורן', '2026-09-07');
const NOA = key('pardes', 'נועה ים', '2026-07-15');
const RON = key('asher', 'רון בלי כניסה', '');
const TAL = key('asher', 'טל אפס', '2026-09-01');

const PATIENTS = [
  { id: 'pt-avi', houseId: 'ramot', name: 'אבי כהן', date: '2026-07-10', pay: 30000, status: 'active', fromLead: 'L1' },
  { id: 'pt-bat', houseId: 'arfoni', name: 'בת-אל רון', date: '2026-07-20', pay: 35000, status: 'active' },
  { id: 'pt-gal', houseId: 'rehab', name: 'גל דוד', date: '2026-07-05', pay: 20000, status: 'active' },
  { id: 'pt-dana', houseId: 'rehab', name: 'דנה לוי', date: '2026-07-15', pay: 25000, status: 'active' },
  { id: 'pt-dana2', houseId: 'rehab', name: 'דנה לואי', date: '2026-07-15', pay: 25000, status: 'released', exitDate: '2026-07-20' },
  { id: 'pt-amit', houseId: 'arfoni', name: 'עמית בורן', date: '2026-09-07', pay: 30000, status: 'active' },
  { id: 'pt-noa', houseId: 'pardes', name: 'נועה ים', date: '2026-07-15', pay: 28000, status: 'released', exitDate: '2026-08-20' },
  { id: 'pt-shai', houseId: 'rehab', name: 'שי בלי יציאה', date: '2026-07-03', pay: 18000, status: 'released' },
  { id: 'pt-ron', houseId: 'asher', name: 'רון בלי כניסה', date: '', pay: 15000, status: 'active' },
  { id: 'pt-tal', houseId: 'asher', name: 'טל אפס', date: '2026-09-01', pay: 0, status: 'active' },
  // a damaged name (U+FFFD), released before the cutoff: no cycles
  { id: 'pt-moshe', houseId: 'ramot', name: 'מ�ה לוי', date: '2026-06-01', pay: 30000, status: 'released', exitDate: '2026-06-20', fromLead: 'L5' },
];
const LEADS = [
  { id: 'L1', name: 'אברהם כהן', phone: '0501111111', house: 'ramot', stage: 'entry', created: '2026-07-01' },
  { id: 'L2', name: 'יוסי ליד', phone: '0502222222', house: 'sde', stage: 'paid', advance: 5000, created: '2026-09-20', entryDate: '2026-09-25' },
  { id: 'L5', name: 'משה לוי', phone: '0505555555', house: 'ramot', stage: 'entry', created: '2026-05-20' },
];
const pay = (pid, due, f) => Object.assign({
  id: 'pay::' + pid + '::' + due, patientId: pid, patientName: pid.split('::')[1], houseId: pid.split('::')[0], dueDate: due,
}, f);
const PAYMENTS = [
  pay(AVI, '2026-07-10', { amount: 30000, status: 'paid', amountPaid: 30000, chargedAt: '2026-07-12T10:00:00+03:00' }),
  // linked by the person to pt-avi, spelled differently on the row
  pay(key('ramot', 'אבי כהן-לוי', '2026-07-10'), '2026-08-10', { linkPatientUid: 'pt-avi', amount: 30000, status: 'paid', amountPaid: 30000, chargedAt: '2026-08-11T10:00:00+03:00' }),
  pay(AVI, '2026-09-10', { amount: 30000, status: 'unpaid', amountPaid: 0 }),                       // recorded debt, 23 days
  pay(GAL, '2026-07-05', { amount: 20000, status: 'paid', amountPaid: 20000, chargedAt: '2026-07-05T09:00:00+03:00' }),
  pay(GAL, '2026-07-06', { id: 'gal-dup', amount: 20000, status: 'paid', amountPaid: 20000, chargedAt: '2026-07-07T09:00:00+03:00' }), // same month, twice
  pay(GAL, '2026-09-05', { amount: 20000, status: 'paid', amountPaid: 20000, chargedAt: '2026-09-06T09:00:00+03:00' }),
  pay(GAL, '2026-09-06', { id: 'gal-void', amount: 20000, status: 'void', amountPaid: 20000 }),     // already voided: never a duplicate
  pay(DANA, '2026-07-15', { amount: 25000, status: 'paid', amountPaid: 25000, chargedAt: '2026-07-15T09:00:00+03:00' }),
  pay(DANA, '2026-08-15', { amount: 25000, status: 'paid', amountPaid: 25000, chargedAt: '2026-08-15T09:00:00+03:00' }),
  pay(DANA, '2026-09-15', { amount: 25000, status: 'paid', amountPaid: 25000, chargedAt: '2026-09-15T09:00:00+03:00' }),
  pay(DANA2, '2026-07-15', { amount: 25000, status: 'paid', amountPaid: 25000, chargedAt: '2026-07-15T09:00:00+03:00' }),
  pay(AMIT, '2026-09-07', { amount: 30000, status: 'paid', amountPaid: 30000, chargedAt: '2026-09-15T09:00:00+03:00' }),
  // the renamed-patient shape: a detached row, same house / entry day / amount
  { id: 'p-amit-old', patientId: key('arfoni', 'עמית', '2026-09-07'), patientName: 'עמית', houseId: 'arfoni', dueDate: '2026-09-07',
    amount: 30000, status: 'paid', amountPaid: 30000, chargedAt: '2026-09-08T09:00:00+03:00' },
  pay(NOA, '2026-07-15', { amount: 28000, status: 'paid', amountPaid: 28000, chargedAt: '2026-07-15T09:00:00+03:00' }),
  pay(NOA, '2026-09-15', { amount: 28000, status: 'unpaid', amountPaid: 0 }),                       // after the exit
  pay(RON, '2026-08-01', { amount: 15000, status: 'paid', amountPaid: 15000, chargedAt: '2026-08-01T09:00:00+03:00' }),
  // detached, matching lead L2 that has no patient: paid, not admitted
  { id: 'p-yossi', patientId: key('sde', 'יוסי ליד', '2026-09-25'), patientName: 'יוסי ליד', houseId: 'sde', dueDate: '2026-09-25',
    amount: 40000, status: 'paid', amountPaid: 40000, chargedAt: '2026-09-25T09:00:00+03:00' },
  // a decision already taken: marked «לא מטופל» with a note
  { id: 'p-supplier', patientId: key('ramot', 'ספק', '2026-09-01'), patientName: 'ספק', houseId: 'ramot', dueDate: '2026-09-01',
    amount: 5000, status: 'paid', amountPaid: 5000, linkStatus: 'not_a_patient', linkNote: 'החזר ספק' },
];
const CREDITS = [
  { id: 'c1', patientKey: AVI, patientName: 'אבי כהנא', houseId: 'ramot', amount: 1000, status: 'pending', createdAt: '2026-09-01T10:00:00+03:00' },
];
const DISCHARGED = [
  // detox, out on day 6 with the cycle paid → a refund awaiting a decision
  { id: 'd1', houseId: 'rehab', name: 'דנה לואי', date: '2026-07-15', exitDate: '2026-07-20', status: 'released' },
  // an unknown house → «לא ניתן לחשב»
  { id: 'd2', houseId: 'mars', name: 'אורח לא ידוע', date: '2026-07-01', exitDate: '2026-09-01', status: 'released' },
];

let GS;
function gs() { return GS || (GS = loadGs()); }
function tabsOf(C) {
  const rows = (sheet, list) => ({ sheet, rows: (list || []).map((o, i) => ({ rowNumber: i + 2, obj: Object.assign({}, o) })) });
  return {
    leads: rows(C.LEADS_SHEET, LEADS), patients: rows(C.PATIENTS_SHEET, PATIENTS), discharged: rows(C.DISCHARGED_PATIENTS_SHEET, DISCHARGED),
    payments: rows(C.PAYMENTS_SHEET, PAYMENTS), credits: rows(C.CREDITS_SHEET, CREDITS), overrides: rows(C.BILLING_OVERRIDES_SHEET, []),
  };
}
let REPORT;
function rep() { return REPORT || (REPORT = plain(gs().sandbox.cleanupReport_(TODAY, tabsOf(gs().C)))); }
const S = () => rep().sections;

/* ===================== the engine, tab by tab ===================== */

test('the report: ok, today, every section an array, counts match', () => {
  const r = rep();
  assert.equal(r.ok, true);
  assert.equal(r.today, TODAY);
  assert.equal(r.recordsCutoff, '2026-07-01');
  assert.deepEqual(Object.keys(r.sections), cleanup.SECTION_KEYS);
  assert.deepEqual(Array.from(gs().C.CLEANUP_SECTION_KEYS), cleanup.SECTION_KEYS, 'Code.gs and lib list the same sections');
  for (const k of cleanup.SECTION_KEYS) assert.equal(r.counts[k], r.sections[k].length, k);
  assert.equal(r.notAPatientExcluded, 1);
  assert.deepEqual(plain(gs().sandbox.cleanupReport_('2026-02-30', tabsOf(gs().C))), { ok: false, error: 'bad_today' });
});

test('«שמות לא תואמים»: U+FFFD (with §D\'s proposal), cross-tab spellings, near-duplicates in one house', () => {
  const names = S().names;
  const fffd = names.filter((r) => r.kind === 'fffd');
  assert.equal(fffd.length, 1);
  assert.deepEqual([fffd[0].houseId, fffd[0].proposal, fffd[0].confidence], ['ramot', 'משה לוי', 'גבוהה']);

  const spell = names.filter((r) => r.kind === 'spelling');
  const bySource = (s) => spell.filter((r) => r.source === s);
  assert.deepEqual(bySource('payments').map((r) => [r.name, r.recordedName, r.proposal, r.refs.length]), [['אבי כהן', 'אבי כהן-לוי', 'אבי כהן', 1]]);
  assert.deepEqual(bySource('credits').map((r) => [r.name, r.recordedName]), [['אבי כהן', 'אבי כהנא']]);
  assert.deepEqual(bySource('leads').map((r) => [r.name, r.recordedName]), [['אבי כהן', 'אברהם כהן']]);
  assert.ok(!spell.some((r) => /�/.test(r.name + r.recordedName)), 'a damaged name is listed once, under fffd');

  const near = names.filter((r) => r.kind === 'near_duplicate');
  assert.equal(near.length, 1);
  assert.deepEqual([near[0].houseId, near[0].why, near[0].name, near[0].otherName, near[0].proposal],
    ['rehab', 'one_letter', 'דנה לוי', 'דנה לואי', 'דנה לוי'], 'the row with more payments is the proposal');
});

test('near-duplicate rule: same name / spacing / partial / word order / one letter; not two different people', () => {
  const why = (a, b) => gs().sandbox.cleanupNearDuplicateWhy_(a, b);
  assert.equal(why('דנה לוי', 'דנה לוי'), 'same_name');
  assert.equal(why('דנה  לוי', 'דנה לוי'), 'spacing');
  assert.equal(why('ערן', 'ערן יצחק חונה'), 'partial');
  assert.equal(why('לוי דנה', 'דנה לוי'), 'word_order');
  assert.equal(why('דנה לוי', 'דנה לואי'), 'one_letter');
  assert.equal(why('משה כהן', 'דוד כהן'), '', 'a shared family name is not a near-duplicate');
  assert.equal(why('אבי', 'אבו'), '', 'one letter apart but too short');
  assert.equal(why('', 'x'), '');
});

test('«פערי גבייה לבדיקה»: debtAging\'s owed cycles as of today, oldest first, both kinds', () => {
  const gaps = S().gaps;
  for (let i = 1; i < gaps.length; i++) assert.ok(gaps[i - 1].start <= gaps[i].start, 'sorted oldest first');
  const find = (name, start) => gaps.find((g) => g.name === name && g.start === start);
  assert.deepEqual(find('אבי כהן', '2026-09-10') && [find('אבי כהן', '2026-09-10').kind, find('אבי כהן', '2026-09-10').balance], ['recorded_debt', 30000]);
  for (const s of ['2026-07-20', '2026-08-20', '2026-09-20']) assert.equal(find('בת-אל רון', s).kind, 'unrecorded_cycle', s);
  assert.equal(find('גל דוד', '2026-08-05').kind, 'unrecorded_cycle');
  assert.ok(!gaps.some((g) => g.name === 'טל אפס'), 'a 0 cycle is a zero-amount patient, not a gap');
  assert.ok(gaps.every((g) => g.balance > 0));
  // the same cycles debtAging_ itself returns, no more and no fewer
  const aging = plain(gs().sandbox.debtAging_(TODAY, tabsOf(gs().C)));
  const owed = [];
  aging.byPatient.forEach((p) => p.cycles.forEach((c) => { if (c.balance > 0) owed.push(p.name + '|' + c.start + '|' + c.balance); }));
  assert.deepEqual(gaps.map((g) => g.name + '|' + g.start + '|' + g.balance).sort(), owed.sort());
});

test('«כנראה טעות רישום» — the exact rule', () => {
  const rule = (start, days, later) => gs().sandbox.cleanupProbablyEntryError_(start, days, later);
  assert.equal(gs().C.CLEANUP_STALE_DAYS, 30);
  assert.equal(rule('2026-06-30', 0, true), true, 'before the cutoff → always');
  assert.equal(rule('2026-07-01', 95, true), false, 'later activity → no');
  assert.equal(rule('2026-07-01', 31, false), true, 'no later activity and older than 30 days → yes');
  assert.equal(rule('2026-09-03', 30, false), false, '30 days exactly is still fresh');
  assert.equal(rule('2026-09-20', 13, false), false, 'this month\'s fresh cycle is never flagged');
  // through the engine
  const g = (name, start) => S().gaps.find((x) => x.name === name && x.start === start);
  assert.deepEqual([g('בת-אל רון', '2026-07-20').probablyEntryError, g('בת-אל רון', '2026-07-20').laterActivity], [true, false]);
  assert.equal(g('בת-אל רון', '2026-08-20').probablyEntryError, true);
  assert.equal(g('בת-אל רון', '2026-09-20').probablyEntryError, false, '13 days old');
  assert.deepEqual([g('גל דוד', '2026-08-05').probablyEntryError, g('גל דוד', '2026-08-05').laterActivity], [false, true],
    'paid 05/09 after the gap: a real gap, not an entry error');
  assert.equal(g('אבי כהן', '2026-09-10').probablyEntryError, false, '23 days old');
  assert.equal(g('נועה ים', '2026-08-15').laterActivity, true, 'a later row (even unpaid) is activity');
});

test('«תשלומים לא משויכים»: debtAging\'s detached rows with §E\'s best candidate; «לא מטופל» rows left out', () => {
  const d = S().detached;
  assert.deepEqual(d.map((r) => r.name), ['עמית', 'יוסי ליד'], 'sorted by date');
  assert.match(d[0].candidate, /^עמית בורן — Patients שורה \d+$/);
  assert.ok(d[0].refs[0].startsWith('Payments שורה '));
  assert.ok(!d.some((r) => r.name === 'ספק'));
  assert.ok(d.every((r) => r.kind === 'detached'));
});

test('«תשלומים אחרי יציאה», «משוחררים ללא תאריך יציאה», «ללא תאריך כניסה», «מטופלים בסכום אפס» — debtAging\'s lists', () => {
  assert.deepEqual(S().outsideStay.map((r) => [r.kind, r.name, r.start, r.exitDate, r.amount]), [['after_exit', 'נועה ים', '2026-09-15', '2026-08-20', 28000]]);
  assert.deepEqual(S().releasedNoExit.map((r) => [r.kind, r.name, r.entryDate]), [['released_no_exit', 'שי בלי יציאה', '2026-07-03']]);
  assert.deepEqual(S().noEntryDate.map((r) => [r.kind, r.name, r.paymentRows]), [['no_entry_date', 'רון בלי כניסה', 1]]);
  assert.deepEqual(S().zeroAmount.map((r) => [r.kind, r.name, r.cycles]), [['zero_amount', 'טל אפס', 2]]);
});

test('«לידים ששולמו ולא נקלטו»: §A (lead paid, no patient) + §F (a detached payment matching it)', () => {
  const l = S().leads;
  const a = l.find((r) => r.kind === 'lead_no_patient');
  assert.deepEqual([a.name, a.houseId, a.stage, a.advance, a.phone], ['יוסי ליד', 'sde', 'paid', 5000, '0502222222']);
  const f = l.find((r) => r.kind === 'paid_not_admitted');
  assert.deepEqual([f.name, f.paymentName, f.amount, f.dueDate], ['יוסי ליד', 'יוסי ליד', 40000, '2026-09-25']);
  assert.ok(!l.some((r) => r.name === 'אבי כהן' || r.name === 'אברהם כהן'), 'a lead with a patient is not listed');
});

test('«כפילויות חשודות»: same patient + amount + month (or ≤ 7 days), void rows never count, renamed detached twin caught', () => {
  const d = S().duplicates;
  const gal = d.filter((r) => r.name === 'גל דוד');
  assert.deepEqual(gal.map((r) => [r.kind, r.rule, r.amount, r.dueDate, r.otherDueDate]), [['duplicate', 'same_month', 20000, '2026-07-05', '2026-07-06']],
    'the voided 06/09 row is not paired with 05/09');
  const amit = d.filter((r) => r.name === 'עמית בורן');
  assert.deepEqual(amit.map((r) => [r.kind, r.rule, r.names]), [['duplicate_detached', 'same_month', ['עמית בורן', 'עמית']]]);
  assert.equal(d.length, 2);
  // within 7 days across a month line still counts (reconciliation §I)
  const C = gs().C;
  const t = tabsOf(C);
  t.payments.rows.push({ rowNumber: 99, obj: pay(DANA, '2026-09-30', { id: 'x', amount: 25000, status: 'paid', amountPaid: 25000 }) });
  t.payments.rows.push({ rowNumber: 100, obj: pay(DANA, '2026-10-02', { id: 'y', amount: 25000, status: 'paid', amountPaid: 25000 }) });
  const r2 = plain(gs().sandbox.cleanupReport_(TODAY, t)).sections.duplicates.filter((r) => r.otherDueDate === '2026-10-02');
  assert.deepEqual(r2.map((r) => [r.rule, r.dueDate]), [['within_7_days', '2026-09-30']]);
});

test('«זיכויים לבדיקה»: refundPayoutForecast\'s awaiting decision + uncalculable (missing payment data is already a gap)', () => {
  const c = S().credits;
  const aw = c.filter((r) => r.kind === 'credit_awaiting');
  assert.equal(aw.length, 1);
  assert.equal(aw[0].name, 'דנה לואי');
  assert.ok(aw[0].amount > 0);
  assert.equal(aw[0].payoutDate, '2026-10-15', 'decided on the 3rd → paid on the 15th');
  const un = c.filter((r) => r.kind === 'credit_unresolved');
  assert.deepEqual(un.map((r) => [r.name, r.error]), [['אורח לא ידוע', 'unknown_house']]);
  assert.ok(!c.some((r) => r.kind === 'credit_missing_payment'));
  // the same rows refundPayoutForecastFor_ returns
  const objs = (k) => tabsOf(gs().C)[k].rows.map((r) => r.obj);
  const f = plain(gs().sandbox.refundPayoutForecastFor_(objs('discharged'), objs('credits'), objs('payments'), TODAY));
  assert.equal(f.awaiting_decision.count, aw.length);
  assert.equal(f.unresolved.count, un.length);
});

test('no second engine: the block reuses the existing checks, and writes nothing', () => {
  const start = GS_SRC.indexOf('/* ===== Data cleanup workbook (READ-ONLY)');
  const end = GS_SRC.indexOf('function cleanupReportAction_(');
  const block = GS_SRC.slice(start, GS_SRC.indexOf('\n}\n', end) + 3);
  assert.ok(start > 0 && end > start);
  for (const reuse of ['recModel_(', 'recBuildReport_(', 'debtAging_(', 'refundPayoutForecastFor_(', 'recCreditPatient_(',
    'recCandidates_(', 'recNameKey_(', 'recCollect_(', 'debtAgingAsOf_(', 'rec.sections.A', 'rec.sections.D', 'rec.sections.E', 'rec.sections.F']) {
    assert.ok(block.includes(reuse), 'reuses ' + reuse);
  }
  for (const bad of ['setValue', 'setValues', 'appendRow', 'insertSheet', 'getOrCreateSheet_', 'deleteRow', 'LockService',
    'logAudit_', 'PropertiesService', 'UrlFetchApp', 'MailApp', 'DriveApp', 'DocumentApp', 'Logger.log', 'console.']) {
    assert.ok(!block.includes(bad), bad);
  }
  // recSectionJ_ now shares recCreditPatient_ (behaviour unchanged: reconciliation tests stay green)
  assert.ok(/function recSectionJ_[\s\S]*?recCreditPatient_\(c, m\)/.test(GS_SRC));
});

/* ===================== the action ===================== */

function grid(cols, list) { return list.map((o) => cols.map((c) => (o[c] === undefined ? '' : o[c]))); }
function sheetsOf(C) {
  return [
    { name: C.LEADS_SHEET, header: Array.from(C.LEAD_COLUMNS), rows: grid(C.LEAD_COLUMNS, LEADS) },
    { name: C.PATIENTS_SHEET, header: Array.from(C.PATIENT_COLUMNS), rows: grid(C.PATIENT_COLUMNS, PATIENTS) },
    { name: C.DISCHARGED_PATIENTS_SHEET, header: Array.from(C.DISCHARGED_PATIENT_COLUMNS), rows: grid(C.DISCHARGED_PATIENT_COLUMNS, DISCHARGED) },
    { name: C.PAYMENTS_SHEET, header: Array.from(C.PAYMENT_COLUMNS), rows: grid(C.PAYMENT_COLUMNS, PAYMENTS) },
    { name: C.CREDITS_SHEET, header: Array.from(C.CREDIT_COLUMNS), rows: grid(C.CREDIT_COLUMNS, CREDITS) },
  ];
}

test('action cleanupReport: reads the sheets, answers like cleanupReport_, writes / locks / creates nothing', () => {
  const C = gs().C;
  const g = loadGs({ sheets: sheetsOf(C), props: { PROXY_SECRET: PROXY, PROXY_SECRET_MODE: 'enforce' } });
  const out = plain(g.sandbox.doPost({ parameter: {}, postData: { contents: JSON.stringify({ action: 'cleanupReport', proxySecret: PROXY, proxyUser: '' }) } }).json);
  assert.equal(out.ok, true);
  assert.equal(typeof out.generatedAt, 'string');
  assert.ok(out.missingTabs.includes('BillingOverrides'), 'a missing tab is listed, never created');
  assert.deepEqual(g.attempts, [], 'no write, no lock, no tab created');
  // same rows as the pure function (row refs aside: the sheet reader numbers rows itself)
  for (const k of cleanup.SECTION_KEYS) assert.equal(out.sections[k].length, rep().sections[k].length, k);
  // an empty spreadsheet: answered, not crashed
  const empty = loadGs({ props: { PROXY_SECRET: PROXY } });
  const e = plain(empty.sandbox.handle_({ action: 'cleanupReport' }).json);
  assert.equal(e.ok, true);
  for (const k of cleanup.SECTION_KEYS) assert.deepEqual(e.sections[k], [], k);
  assert.deepEqual(empty.attempts, []);
});

test('the action is refused WITHOUT PROXY_SECRET in enforce mode; not open; known; a finance action', () => {
  const C = gs().C;
  assert.ok(Array.from(C.PROXY_KNOWN_ACTIONS).includes('cleanupReport'));
  assert.ok(!Array.from(C.OPEN_ACTIONS).includes('cleanupReport'));
  assert.ok(Array.from(C.FINANCE_ACTIONS).includes('cleanupReport'));
  assert.ok(scope.FINANCE_ACTIONS.includes('cleanupReport'));
  assert.ok(scope.FINANCE_ROUTES.includes('/api/export/cleanup.xlsx'));
  const g = loadGs({ sheets: sheetsOf(C), props: { PROXY_SECRET: PROXY, PROXY_SECRET_MODE: 'enforce' } });
  const post = (body) => plain(g.sandbox.doPost({ parameter: {}, postData: { contents: JSON.stringify(body) } }).json);
  assert.deepEqual(post({ action: 'cleanupReport' }), { ok: false, error: 'unauthorized' });
  assert.deepEqual(post({ action: 'cleanupReport', proxySecret: 'nope' }), { ok: false, error: 'unauthorized' });
  assert.deepEqual(plain(g.sandbox.doGet({ parameter: { action: 'cleanupReport', proxySecret: PROXY } }).json), { ok: false, error: 'unauthorized' },
    'a secret in the URL does not count');
  // a verified restricted actor is refused even with the secret
  assert.deepEqual(post({ action: 'cleanupReport', proxySecret: PROXY, proxyUser: 'שירן', user: 'שירן', proxyAuth: 'personal', proxyUserId: 'shiran', proxyCaps: ['finance'] }),
    { ok: false, error: 'forbidden', message: scope.FINANCE_FORBIDDEN_MESSAGE });
  assert.equal(post({ action: 'cleanupReport', proxySecret: PROXY, proxyUser: 'סנדרה', user: 'סנדרה', proxyAuth: 'personal', proxyUserId: 'sandra', proxyCaps: ['finance'] }).ok, true);
  assert.deepEqual(g.attempts, []);
});

test('getData keeps its keys and is not widened', () => {
  const g = loadGs({ props: { PROXY_SECRET: PROXY } });
  const sheets = {};
  const fake = (name) => {
    const rows = [];
    return {
      getName: () => name, getLastRow: () => rows.length, getLastColumn: () => (rows[0] || []).length,
      getMaxRows: () => 1000, getMaxColumns: () => 26, setFrozenRows() {}, hideSheet() {}, isSheetHidden: () => false,
      appendRow(r) { rows.push(r.slice()); },
      getRange: (r, c, nr, nc) => ({
        setNumberFormat() { return this; }, setValue(v) { (rows[r - 1] = rows[r - 1] || [])[c - 1] = v; },
        setValues(v) { v.forEach((row, i) => { rows[r - 1 + i] = rows[r - 1 + i] || []; row.forEach((x, j) => { rows[r - 1 + i][c - 1 + j] = x; }); }); },
        getValues: () => Array.from({ length: nr || 1 }, (_, i) => Array.from({ length: nc || 1 }, (_, j) => ((rows[r - 1 + i] || [])[c - 1 + j] ?? ''))),
        getValue: () => ((rows[r - 1] || [])[c - 1] ?? ''),
      }),
    };
  };
  g.sandbox.SpreadsheetApp = { getActiveSpreadsheet: () => ({
    getSheetByName: (n) => sheets[n] || null, getSheets: () => Object.values(sheets),
    insertSheet: (n) => (sheets[n] = fake(n)), getSpreadsheetTimeZone: () => 'Asia/Jerusalem',
  }) };
  g.sandbox.LockService = { getScriptLock: () => ({ tryLock: () => true, waitLock() {}, releaseLock() {} }) };
  const out = plain(g.sandbox.handle_({ action: 'getData' }).json);
  assert.equal(out.ok, true);
  for (const k of ['ok', 'leads', 'patients', 'irrelevantLeads', 'removedLeads', 'dischargedPatients',
    'billingOverrides', 'houseManagers', 'managerPhones', 'currentManagers', 'currentManagersSource']) {
    assert.ok(k in out, 'getData lost ' + k);
  }
  assert.ok(!('sections' in out) && !('cleanup' in out), 'getData is not widened');
});

/* ===================== the workbook ===================== */

const FIXED_NOW = new Date(NOW);
async function book(data) {
  const buf = await report.buildXlsxReport(cleanup.buildCleanupSpec(data || rep(), FIXED_NOW));
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  return { wb, buf };
}
const cellText = (c) => (c && c.value instanceof Date ? c.value.toISOString().slice(0, 10) : String(c && c.value != null ? c.value : ''));
/* The header row (the first row whose first cell is 'בית' or 'לשונית') and the data rows under it. */
function table(ws) {
  let h = 0;
  ws.eachRow((row, r) => { if (!h && ['בית', 'לשונית'].includes(cellText(row.getCell(1)))) h = r; });
  const headers = [];
  ws.getRow(h).eachCell((c, i) => { headers[i - 1] = cellText(c); });
  const rows = [];
  for (let r = h + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    if (!cellText(row.getCell(1))) continue;
    const o = {};
    headers.forEach((name, i) => { o[name] = row.getCell(i + 1); });
    rows.push(o);
  }
  return { headerRow: h, headers, rows };
}

test('workbook: «סיכום» first, then one tab per kind, in order; every tab RTL, frozen, filtered, coloured', async () => {
  const { wb } = await book();
  assert.deepEqual(wb.worksheets.map((w) => w.name), ['סיכום'].concat(cleanup.TABS.map((t) => t.name)));
  assert.deepEqual(cleanup.TABS.map((t) => t.name), ['שמות לא תואמים', 'פערי גבייה לבדיקה', 'תשלומים לא משויכים', 'תשלומים אחרי יציאה',
    'משוחררים ללא תאריך יציאה', 'ללא תאריך כניסה', 'מטופלים בסכום אפס', 'לידים ששולמו ולא נקלטו', 'כפילויות חשודות', 'זיכויים לבדיקה']);
  for (const ws of wb.worksheets) {
    assert.equal(ws.views[0].rightToLeft, true, ws.name);
    assert.equal(ws.views[0].state, 'frozen', ws.name);
    assert.ok(ws.autoFilter, ws.name);
    const t = table(ws);
    assert.ok(t.headerRow > 0, ws.name);
    // a colour on the title row (lib/report-colors shades)
    assert.ok(ws.getRow(1).getCell(1).fill && ws.getRow(1).getCell(1).fill.fgColor, ws.name + ' colour');
    // computed widths, inside the helper's bounds
    for (const c of ws.columns) assert.ok(c.width >= report.MIN_WIDTH && c.width <= report.MAX_WIDTH, ws.name);
  }
});

test('workbook: every kind tab has בית, מטופל, …, פרטים, הבעיה, מי מתקן, איך מתקנים, טופל — and a ☐ on every row', async () => {
  const { wb } = await book();
  for (const t of cleanup.TABS) {
    const tb = table(wb.getWorksheet(t.name));
    assert.deepEqual(tb.headers.slice(0, 2), ['בית', 'מטופל'], t.name);
    assert.deepEqual(tb.headers.slice(-5), ['פרטים', 'הבעיה', 'מי מתקן', 'איך מתקנים', 'טופל'], t.name);
    assert.equal(tb.rows.length, rep().sections[t.key].length, t.name + ' row count');
    for (const r of tb.rows) {
      assert.equal(cellText(r['טופל']), '☐', t.name);
      assert.ok(['ורד', 'אורטל', 'סנדרה'].includes(cellText(r['מי מתקן'])), t.name + ' owner ' + cellText(r['מי מתקן']));
      assert.ok(cellText(r['הבעיה']) && cellText(r['איך מתקנים']), t.name);
    }
  }
  assert.ok(table(wb.getWorksheet('שמות לא תואמים')).headers.includes('הצעת תיקון'));
  assert.ok(table(wb.getWorksheet('פערי גבייה לבדיקה')).headers.includes('כנראה טעות רישום'));
});

test('workbook: «סיכום» holds counts only — one row per tab, per owner, no money and no total row', async () => {
  const { wb } = await book();
  const tb = table(wb.getWorksheet('סיכום'));
  assert.deepEqual(tb.headers, ['לשונית', 'שורות', 'ורד', 'אורטל', 'סנדרה']);
  assert.deepEqual(tb.rows.map((r) => cellText(r['לשונית'])), cleanup.TABS.map((t) => t.name), 'no total row');
  for (const r of tb.rows) {
    const t = cleanup.TABS.find((x) => x.name === cellText(r['לשונית']));
    assert.equal(r['שורות'].value, rep().sections[t.key].length);
    assert.equal(r['ורד'].value + r['אורטל'].value + r['סנדרה'].value, r['שורות'].value);
    for (const k of ['שורות', 'ורד', 'אורטל', 'סנדרה']) assert.notEqual(r[k].numFmt, report.MONEY_FORMAT);
  }
});

test('workbook: rows read back from the fixture — names, gaps (oldest first, the entry-error column), owners per the plan', async () => {
  const { wb } = await book();
  const names = table(wb.getWorksheet('שמות לא תואמים')).rows;
  const spell = names.find((r) => cellText(r['שם שונה']) === 'אבי כהן-לוי');
  assert.deepEqual([cellText(spell['בית']), cellText(spell['מטופל']), cellText(spell['הצעת תיקון']), cellText(spell['מי מתקן'])],
    ['רמות השבים', 'אבי כהן', 'אבי כהן', 'ורד']);
  const fffd = names.find((r) => cellText(r['הבעיה']) === 'שם עם תו פגום');
  assert.equal(cellText(fffd['הצעת תיקון']), 'משה לוי');
  assert.match(cellText(fffd['פרטים']), /ביטחון: גבוהה · ליד מקור/);
  assert.ok(!/fromLead|phone/.test(cellText(fffd['פרטים'])), 'no English codes in the sheet');
  const gaps = table(wb.getWorksheet('פערי גבייה לבדיקה')).rows;
  const starts = gaps.map((r) => cellText(r['תחילת מחזור']));
  assert.deepEqual(starts, starts.slice().sort(), 'oldest first');
  const bat = gaps.find((r) => cellText(r['מטופל']) === 'בת-אל רון' && cellText(r['תחילת מחזור']) === '2026-07-20');
  assert.equal(cellText(bat['כנראה טעות רישום']), 'כן');
  assert.equal(bat['יתרה'].numFmt, report.MONEY_FORMAT);
  assert.ok(bat['תחילת מחזור'].value instanceof Date, 'a real date');
  const gal = gaps.find((r) => cellText(r['מטופל']) === 'גל דוד');
  assert.equal(cellText(gal['כנראה טעות רישום']), 'לא');
  const owner = (tab) => [...new Set(table(wb.getWorksheet(tab)).rows.map((r) => cellText(r['מי מתקן'])))].sort();
  assert.deepEqual(owner('פערי גבייה לבדיקה'), ['ורד']);
  assert.deepEqual(owner('תשלומים לא משויכים'), ['אורטל']);
  assert.deepEqual(owner('תשלומים אחרי יציאה'), ['אורטל']);
  assert.deepEqual(owner('משוחררים ללא תאריך יציאה'), ['ורד']);
  assert.deepEqual(owner('כפילויות חשודות'), ['אורטל']);
  assert.deepEqual(owner('לידים ששולמו ולא נקלטו'), ['אורטל', 'ורד']);
  assert.deepEqual(owner('זיכויים לבדיקה'), ['אורטל', 'ורד']);
  const leads = table(wb.getWorksheet('לידים ששולמו ולא נקלטו')).rows;
  assert.equal(cellText(leads.find((r) => cellText(r['שלב']) === 'מקדמה שולמה')['מי מתקן']), 'ורד');
  const credits = table(wb.getWorksheet('זיכויים לבדיקה')).rows;
  assert.equal(cellText(credits.find((r) => cellText(r['מטופל']) === 'אורח לא ידוע')['פרטים']), 'בית לא מוכר');
});

test('workbook: every kind has words and an owner; owners follow the plan (§9, §7.4)', () => {
  for (const [k, v] of Object.entries(cleanup.KINDS)) {
    assert.ok(cleanup.OWNER_LABELS[v.owner], k);
    assert.ok(v.problem && v.how, k);
  }
  const owner = (k) => cleanup.KINDS[k].owner;
  for (const k of ['fffd', 'spelling', 'near_duplicate', 'lead_no_patient', 'released_no_exit', 'no_entry_date', 'zero_amount',
    'recorded_debt', 'unrecorded_cycle', 'credit_unresolved']) assert.equal(owner(k), 'vered', k);
  for (const k of ['detached', 'paid_not_admitted', 'after_exit', 'before_entry', 'duplicate', 'duplicate_detached', 'credit_awaiting']) {
    assert.equal(owner(k), 'ortal', k);
  }
  // every kind the engine emits has words
  for (const k of cleanup.SECTION_KEYS) for (const r of rep().sections[k]) assert.ok(cleanup.KINDS[r.kind], r.kind);
});

test('workbook: an empty report still has every tab, each saying so in words', async () => {
  const empty = { ok: true, today: TODAY, sections: {} };
  cleanup.SECTION_KEYS.forEach((k) => { empty.sections[k] = []; });
  assert.ok(cleanup.isCleanupResponse(empty));
  const { wb } = await book(empty);
  for (const t of cleanup.TABS) {
    let found = false;
    wb.getWorksheet(t.name).eachRow((row) => { if (cellText(row.getCell(1)) === 'אין פריטים לתיקון בלשונית זו') found = true; });
    assert.ok(found, t.name);
  }
  assert.ok(!cleanup.isCleanupResponse({ ok: true, today: TODAY, sections: { names: [] } }));
  assert.ok(!cleanup.isCleanupResponse({ ok: false }));
});

test('workbook: no "איזון" and no "E-ZONE" anywhere — cells, sheet names, properties, raw XML, file names', async () => {
  const { wb, buf } = await book();
  for (const ws of wb.worksheets) {
    for (const b of BANNED) assert.ok(!ws.name.includes(b), ws.name);
    ws.eachRow((row) => row.eachCell((c) => { for (const b of BANNED) assert.ok(!cellText(c).includes(b), ws.name + ': ' + cellText(c)); }));
  }
  const zip = await JSZip.loadAsync(buf);
  for (const name of Object.keys(zip.files)) {
    if (zip.files[name].dir) continue;
    const xml = await zip.files[name].async('string');
    for (const b of BANNED) assert.ok(!xml.includes(b), name + ' contains ' + b);
  }
  const names = [cleanup.cleanupContentDisposition(TODAY), decodeURIComponent(cleanup.cleanupContentDisposition(TODAY)), 'רשימת-תיקונים-${todayISO()}.xlsx'];
  for (const n of names) for (const b of BANNED) assert.ok(!n.includes(b), n);
  // and the library text itself
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'cleanup-xlsx.js'), 'utf8');
  for (const b of BANNED) assert.ok(!src.includes(b), 'lib/cleanup-xlsx.js contains ' + b);
});

test('workbook: names are formula-guarded and nothing is a formula', async () => {
  const data = plain(rep());
  data.sections.names = [{ kind: 'spelling', source: 'payments', houseId: 'ramot', name: '=HYPERLINK("x")', recordedName: '+1', refs: ['@a'], proposal: '-x' }];
  const { wb } = await book(data);
  const ws = wb.getWorksheet('שמות לא תואמים');
  const row = table(ws).rows[0];
  assert.equal(cellText(row['מטופל']), '\'=HYPERLINK("x")');
  assert.equal(cellText(row['שם שונה']), '\'+1');
  assert.equal(cellText(row['הצעת תיקון']), '\'-x');
  for (const w of wb.worksheets) w.eachRow((r) => r.eachCell((c) => assert.ok(!c.formula, w.name)));
});

/* ===================== the route ===================== */

const SESSION_SECRET = 'session-secret-TEST-cleanup-0123456789abcdef0123';
const SHEETS_URL = 'https://script.google.com/macros/s/TEST/exec';
const ENV_KEYS = ['PROXY_SECRET', 'SESSION_SECRET', 'SHEETS_URL', 'APP_PIN', 'USER_PIN_HASHES', 'PIN_PEPPER', 'APP_PIN_UNTIL'];
function freshServer(env) {
  const saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  const orig = { error: console.error, warn: console.warn, log: console.log };
  console.error = () => {}; console.warn = () => {}; console.log = () => {};
  delete require.cache[SERVER_PATH];
  try { return require('../server'); } finally {
    Object.assign(console, orig);
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}
function stubHttps(respond) {
  const calls = [];
  const original = https.request;
  https.request = (url, opts, cb) => {
    const req = new EventEmitter();
    let body = '';
    req.write = (c) => { body += c; };
    req.end = () => {
      calls.push({ body });
      const r = respond(JSON.parse(body || '{}'));
      const res = new EventEmitter();
      res.statusCode = 200; res.headers = {}; res.setEncoding = () => {}; res.resume = () => {};
      setImmediate(() => { cb(res); res.emit('data', JSON.stringify(r)); res.emit('end'); });
    };
    return req;
  };
  return { calls, restore: () => { https.request = original; } };
}
function get(port, urlPath, cookie) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: urlPath, headers: cookie ? { Cookie: cookie } : {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString('utf8')); } catch (_) { /* binary */ }
        resolve({ status: res.statusCode, headers: res.headers, buf, json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}
async function withServer(env, fn) {
  const mod = freshServer(env);
  const srv = await new Promise((r) => { const s = mod.app.listen(0, '127.0.0.1', () => r(s)); });
  try { return await fn(srv.address().port, mod); } finally { srv.close(); }
}
const NAMES = { vered: 'ורד', sandra: 'סנדרה', shiran: 'שירן', yael: 'יעל' };
const personal = (id) => 'ezone_session=' + createSessionToken(SESSION_SECRET, undefined, undefined, NAMES[id], { id, pinVersion: 1 });
const PEPPER = 'pepper-TEST-cleanup-a1b2c3d4e5f60718293a4b5c6d7e8f90';
let ENV;
/* Personal-PIN records shaped exactly like the live lines (lib/users.js recordLine). */
async function env(over) {
  if (!ENV) {
    const hash = await pinHash.hashPin('583920', PEPPER);
    ENV = { PROXY_SECRET: PROXY, SESSION_SECRET, SHEETS_URL, PIN_PEPPER: PEPPER,
      USER_PIN_HASHES: JSON.stringify(['vered', 'sandra', 'shiran', 'yael'].map((id) => JSON.parse(users.recordLine(id, hash, 1)))) };
  }
  return Object.assign({}, ENV, over || {});
}

test('route: 401 without a session; 403 for Shiran and Yael (nothing proxied); 503 without PROXY_SECRET', async () => {
  const stub = stubHttps(() => rep());
  try {
    await withServer(await env(), async (port) => {
      assert.equal((await get(port, '/api/export/cleanup.xlsx')).status, 401);
      for (const id of ['shiran', 'yael']) {
        const r = await get(port, '/api/export/cleanup.xlsx', personal(id));
        assert.deepEqual([r.status, r.json], [403, { ok: false, error: 'forbidden', message: scope.FINANCE_FORBIDDEN_MESSAGE }], id);
      }
      assert.equal(stub.calls.length, 0, 'a refused request reaches nothing');
    });
    await withServer(await env({ PROXY_SECRET: undefined }), async (port) => {
      assert.equal((await get(port, '/api/export/cleanup.xlsx', personal('vered'))).status, 503);
    });
  } finally { stub.restore(); }
});

test('route: Vered / Sandra get the workbook — headers, no-store, the session user forwarded, no patient data logged', async () => {
  const stub = stubHttps(() => rep());
  const lines = [];
  const saved = { log: console.log, error: console.error, warn: console.warn };
  try {
    await withServer(await env(), async (port) => {
      console.log = (...a) => lines.push(a.join(' ')); console.error = (...a) => lines.push(a.join(' ')); console.warn = (...a) => lines.push(a.join(' '));
      for (const id of ['vered', 'sandra']) {
        const r = await get(port, '/api/export/cleanup.xlsx', personal(id));
        assert.equal(r.status, 200, id);
        assert.equal(r.headers['content-type'], report.XLSX_MIME);
        assert.equal(r.headers['cache-control'], 'no-store');
        assert.equal(r.headers['x-content-type-options'], 'nosniff');
        assert.equal(r.headers['content-length'], String(r.buf.length));
        assert.equal(r.headers['content-disposition'], cleanup.cleanupContentDisposition(TODAY));
        assert.match(r.headers['content-disposition'], /^attachment; filename="cleanup-2026-10-03\.xlsx"; filename\*=UTF-8''/);
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(r.buf);
        assert.equal(wb.worksheets[0].name, 'סיכום');
      }
      Object.assign(console, saved);
    });
  } finally { Object.assign(console, saved); stub.restore(); }
  const sent = stub.calls.map((c) => JSON.parse(c.body));
  assert.deepEqual(sent.map((b) => b.action), ['cleanupReport', 'cleanupReport']);
  assert.deepEqual(sent.map((b) => b.user), ['ורד', 'סנדרה']);
  assert.ok(sent.every((b) => b.proxySecret === PROXY));
  const log = lines.join('\n');
  for (const n of ['אבי', 'בת-אל', 'יוסי', 'דנה', '30000', '0502222222']) assert.ok(!log.includes(n), 'logged: ' + n);
});

test('route: failures answer JSON with no-store — lock_busy 503, bad shape 502, unreachable 502', async () => {
  const { cleanupXlsxHandler } = freshServer(await env());
  const run = async (fetchCleanup) => {
    const res = { headers: {}, set(h, v) { if (typeof h === 'object') Object.assign(this.headers, h); else this.headers[h] = v; return this; },
      status(s) { this.code = s; return this; }, json(b) { this.body = b; return this; }, end(b) { this.body = b; return this; } };
    const saved = console.error; console.error = () => {};
    try { await cleanupXlsxHandler({ fetchCleanup, now: () => FIXED_NOW })({ headers: {} }, res); } finally { console.error = saved; }
    return res;
  };
  let r = await run(async () => ({ ok: false, error: 'lock_busy' }));
  assert.deepEqual([r.code, r.body, r.headers['Cache-Control']], [503, { ok: false, error: 'lock_busy' }, 'no-store']);
  r = await run(async () => ({ ok: true, today: TODAY, sections: {} }));
  assert.deepEqual([r.code, r.body.error], [502, 'bad_response']);
  r = await run(async () => ({ ok: false, error: 'forbidden' }));
  assert.equal(r.code, 403);
  r = await run(async () => { throw new Error('down'); });
  assert.deepEqual([r.code, r.body.error], [502, 'sheets_unreachable']);
  r = await run(async () => rep());
  assert.equal(r.code, 200);
});

/* ===================== the button and the service worker ===================== */

test('UI: «ייצוא רשימת תיקונים» sits next to the other exports, inside the finance-only גבייה screen', () => {
  const i = HTML_SRC.indexOf('id="cleanup-export"');
  assert.ok(i > 0);
  assert.match(HTML_SRC, /<button type="button" class="btn small primary" id="cleanup-export">ייצוא רשימת תיקונים<\/button>/);
  const exportBtn = HTML_SRC.indexOf('id="credits-forecast-export"');
  assert.ok(Math.abs(i - exportBtn) < 200, 'beside «ייצוא זיכויים לאקסל»');
  // inside <section id="screen-billing" … data-finance>, which applyView removes for a restricted session
  const sec = HTML_SRC.lastIndexOf('<section', i);
  assert.match(HTML_SRC.slice(sec, HTML_SRC.indexOf('>', sec) + 1), /id="screen-billing"[^>]*data-finance/);
  assert.equal((HTML_SRC.match(/ data-finance[ >]/g) || []).length, 10, 'no new tagged node: the screen already carries it');
});

function loadApp(finance, fetchImpl) {
  const noop = () => {};
  const clicked = [];
  const doc = {
    addEventListener: noop, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    createElement: () => ({ click() { clicked.push(this.download); }, remove: noop }),
    body: { appendChild: noop, classList: { contains: () => false, toggle: noop } },
  };
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/', hash: '' },
    document: doc,
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL: noop },
    setTimeout: noop, fetch: fetchImpl,
    URLSearchParams, Math, Date, JSON, Number, String, Array, Object, RegExp, isNaN, isFinite, parseInt, parseFloat, Promise,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(APP_SRC + `
    state.finance = ${finance};
    globalThis.__app = { exportCleanupXlsx, cleanupXlsxErrorText, CLEANUP_XLSX_URL };`, sandbox);
  return { app: sandbox.__app, clicked };
}

test('UI: the export GETs the route with no-store and downloads the dated file; refused for a restricted view; Hebrew errors', async () => {
  const calls = [];
  const ok = loadApp(true, async (url, opts) => { calls.push([url, opts]); return { ok: true, status: 200, blob: async () => ({}) }; });
  await ok.app.exportCleanupXlsx();
  assert.equal(calls[0][0], '/api/export/cleanup.xlsx');
  assert.equal(calls[0][1].cache, 'no-store');
  assert.equal(calls[0][1].method, 'GET');
  assert.match(ok.clicked[0], /^רשימת-תיקונים-\d{4}-\d{2}-\d{2}\.xlsx$/);

  const none = [];
  const restricted = loadApp(false, async (url) => { none.push(url); return { ok: true }; });
  await assert.rejects(restricted.app.exportCleanupXlsx(), /אין הרשאה/);
  assert.deepEqual(none, [], 'a restricted view never calls the route');

  const forbidden = loadApp(true, async () => ({ ok: false, status: 403, json: async () => ({ ok: false, error: 'forbidden' }) }));
  await assert.rejects(forbidden.app.exportCleanupXlsx(), /אין הרשאה לייצוא זה/);
  assert.equal(ok.app.cleanupXlsxErrorText(503, 'lock_busy').length > 0, true);
  assert.match(ok.app.cleanupXlsxErrorText(502, 'sheets_unreachable'), /אין חיבור לגיליון/);
  // wired through busyButton like the other exports
  assert.match(APP_SRC, /cleanup\.onclick = \(\) => busyButton\(cleanup, 'load', exportCleanupXlsx\)/);
});

test('service worker: v28 or later; /api/export/cleanup.xlsx is network-only (never cached)', () => {
  // v28 shipped the cleanup workbook; later PRs bump it again (v29: personal PINs PR C).
  const v = Number((SW_SRC.match(/var CACHE_VERSION = 'v(\d+)';/) || [])[1]);
  assert.ok(v >= 28, 'CACHE_VERSION is v' + v);
  assert.ok(SW_SRC.includes('v27 → v28:'));
  const sandbox = { self: { addEventListener() {} }, module: { exports: {} }, URL, caches: {}, fetch() {} };
  vm.createContext(sandbox);
  vm.runInContext(SW_SRC, sandbox);
  assert.equal(sandbox.module.exports.cacheStrategy('/api/export/cleanup.xlsx'), 'network-only');
});
