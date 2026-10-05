/* Ortal's daily payments digest (apps-script/Code.gs → one email per working
 * morning). Runs the REAL Code.gs in a vm sandbox against fakes of
 * SpreadsheetApp (read-only — every non-read method throws and is recorded),
 * PropertiesService, MailApp, LockService, ScriptApp and Utilities.
 *
 * Locked here:
 *   - weekday gating in JERUSALEM time (Fri/Sat skip, Sun–Thu send), including
 *     the 23:30 UTC edges on both sides of the October DST switch;
 *   - the window (DIGEST_LAST_AT, now], compared as instants; the first run;
 *     Sunday's mail spanning Thursday-after-send through Saturday;
 *   - void / unpaid / unstamped rows excluded; an edited row marked «עודכן»;
 *   - totals per house and overall; the empty heartbeat;
 *   - CC only on/before DIGEST_CC_UNTIL; missing / malformed DIGEST_TO → no send;
 *   - DIGEST_LAST_AT never advanced by a send failure, a preview, or a test send;
 *   - HTML escaping; no phone number and no id anywhere in the message;
 *   - the trigger installer is idempotent; authorizeDigestNow's first statement;
 *   - read-only against the spreadsheet; not reachable over HTTP.
 * All names, ids, phone numbers and addresses are SYNTHETIC. */

process.env.TZ = 'UTC';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const GS_SRC = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps-script', 'appsscript.json'), 'utf8'));
const arr = (x) => Array.from(x);

const TO = 'ortal@example.test';
const CC = 'sandra@example.test';

/* ---------- Utilities.formatDate: the SimpleDateFormat tokens Code.gs uses ---------- */
function formatDate(d, tz, fmt) {
  const parts = {};
  new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(d).forEach((p) => { parts[p.type] = p.value; });
  const wd = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[parts.weekday];
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  const offMin = Math.round((asUtc - Math.floor(d.getTime() / 1000) * 1000) / 60000);
  const sign = offMin >= 0 ? '+' : '-';
  const a = Math.abs(offMin);
  const Z = sign + String(Math.floor(a / 60)).padStart(2, '0') + String(a % 60).padStart(2, '0');
  let out = '';
  for (let i = 0; i < fmt.length;) {
    if (fmt[i] === "'") { const j = fmt.indexOf("'", i + 1); out += fmt.slice(i + 1, j); i = j + 1; continue; }
    const tok = ['yyyy', 'MM', 'dd', 'HH', 'mm', 'ss', 'u', 'Z'].find((t) => fmt.startsWith(t, i));
    if (!tok) { out += fmt[i]; i++; continue; }
    out += { yyyy: parts.year, MM: parts.month, dd: parts.day, HH: parts.hour, mm: parts.minute, ss: parts.second, u: String(wd), Z }[tok];
    i += tok.length;
  }
  return out;
}

/* ---------- a spreadsheet that can only be READ ---------- */
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
      return trap({ getValues: read }, 'Range(' + name + ')', attempts);
    },
  }, 'Sheet(' + name + ')', attempts);
}

/* ---------- fakes with memory ---------- */
function fakeProps(initial) {
  const store = Object.assign({}, initial || {});
  const writes = [];
  return {
    store, writes,
    api: {
      getProperty: (k) => (k in store ? store[k] : null),
      setProperty: (k, v) => { writes.push(k); store[k] = String(v); },
      setProperties: (o) => { Object.keys(o).forEach((k) => { writes.push(k); store[k] = String(o[k]); }); },
      deleteProperty: (k) => { writes.push('-' + k); delete store[k]; },
    },
  };
}

function fakeScriptApp(existing) {
  const state = { triggers: (existing || []).map((h, i) => ({ id: 'pre-' + i, handler: h })), created: [], scopes: [], scopesThrow: false };
  let seq = 0;
  const builder = (handler) => {
    const spec = { handler };
    const b = {
      timeBased: () => b,
      everyDays: (n) => { spec.everyDays = n; return b; },
      atHour: (h) => { spec.atHour = h; return b; },
      nearMinute: (m) => { spec.nearMinute = m; return b; },
      inTimezone: (tz) => { spec.tz = tz; return b; },
      create: () => { const t = { id: 'new-' + (seq++), handler, spec }; state.triggers.push(t); state.created.push(spec); return t; },
    };
    return b;
  };
  return {
    state,
    api: {
      AuthMode: { FULL: 'FULL', LIMITED: 'LIMITED' },
      requireAllScopes: (mode) => { state.scopes.push(mode); if (state.scopesThrow) throw new Error('Authorization is required'); },
      getProjectTriggers: () => state.triggers.map((t) => ({ getHandlerFunction: () => t.handler, __id: t.id })),
      deleteTrigger: (t) => { state.triggers = state.triggers.filter((x) => x.id !== t.__id); },
      newTrigger: builder,
    },
  };
}

function frozenDate(at) {
  const fixed = new Date(at).getTime();
  return class FrozenDate extends Date {
    constructor(...a) { if (a.length === 0) super(fixed); else super(...a); }
    static now() { return fixed; }
  };
}

/* The digest section of Code.gs, from its banner comment to the end. */
function digestSection() {
  const i = GS_SRC.indexOf("Ortal's daily payments digest");
  assert.ok(i > 0);
  const start = GS_SRC.lastIndexOf('/*', i);
  const next = GS_SRC.indexOf('\n/* ===== ', i);
  return GS_SRC.slice(start, next < 0 ? GS_SRC.length : next);
}
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function load(opts) {
  opts = opts || {};
  const attempts = [];
  const logs = [];
  const sent = [];
  const lockCalls = [];
  const props = fakeProps(opts.props);
  const scriptApp = fakeScriptApp(opts.triggers);
  const sandbox = {
    console: { log() {}, warn() {}, error() {}, info() {} },
    JSON, Math, Date: opts.now ? frozenDate(opts.now) : Date, Number, String, Array, Object, RegExp, isFinite, isNaN, Error,
    Logger: { log: (m) => logs.push(String(m)) },
    Utilities: { formatDate, getUuid: () => 'uuid' },
    PropertiesService: { getScriptProperties: () => props.api },
    MailApp: {
      sendEmail: (m) => { if (opts.mailThrows) throw new Error('Service invoked too many times'); sent.push(m); },
      getRemainingDailyQuota: () => 97,
    },
    LockService: {
      getScriptLock: () => ({
        tryLock: (ms) => { lockCalls.push('try:' + ms); return opts.lockBusy ? false : true; },
        releaseLock: () => lockCalls.push('release'),
      }),
    },
    ScriptApp: scriptApp.api,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(GS_SRC + '\nglobalThis.__C = { PAYMENT_COLUMNS, PAYMENTS_SHEET };', sandbox);
  const header = arr(sandbox.__C.PAYMENT_COLUMNS).concat(['טלפון', 'אמצעי תשלום']);
  const sheets = [];
  if (opts.rows) sheets.push(roSheet(sandbox.__C.PAYMENTS_SHEET, header, opts.rows.map((f) => header.map((c) => (f[c] === undefined ? '' : f[c]))), attempts));
  sandbox.SpreadsheetApp = {
    getActiveSpreadsheet: () => trap({
      getSheetByName: (n) => sheets.find((s) => s.getName() === n) || null,
      getSpreadsheetTimeZone: () => 'Asia/Jerusalem',
    }, 'Spreadsheet', attempts),
  };
  return { g: sandbox, attempts, logs, sent, props, scriptApp, lockCalls };
}

/* ---------- fixtures ---------- */
let n = 0;
function pay(f) {
  n++;
  return Object.assign({
    id: 'pay::arfoni::שם בדוי ' + n + '::2026-06-20::2026-09-20',
    patientId: 'arfoni::שם בדוי ' + n + '::2026-06-20',
    patientName: 'שם בדוי ' + n,
    houseId: 'arfoni', dueDate: '2026-09-20', amount: 30000, status: 'paid', amountPaid: 30000, balance: 0,
    paymentUid: 'pmt-00000000-0000-0000-0000-' + String(n).padStart(12, '0'),
    patientUid: 'id-patient-' + n,
    chargedBy: 'ורד', sourceVersion: 1,
    'טלפון': '050-987-65' + String(n).padStart(2, '0'),
    'אמצעי תשלום': 'העברה בנקאית',
  }, f);
}
const BASE = { DIGEST_TO: TO, DIGEST_CC: CC, DIGEST_CC_UNTIL: '2026-10-08' };
// Thursday 01/10/2026 08:00 IDT and Sunday 04/10/2026 08:00 IDT.
const THU_8 = new Date('2026-10-01T05:00:00Z');
const SUN_8 = new Date('2026-10-04T05:00:00Z');

/* ===================== weekday gating ===================== */

test('weekday gating: Sunday–Thursday send, Friday and Saturday skip (Jerusalem, summer time)', () => {
  const days = [
    ['2026-09-27T05:00:00Z', true],  // Sun
    ['2026-09-28T05:00:00Z', true],  // Mon
    ['2026-09-29T05:00:00Z', true],  // Tue
    ['2026-09-30T05:00:00Z', true],  // Wed
    ['2026-10-01T05:00:00Z', true],  // Thu
    ['2026-10-02T05:00:00Z', false], // Fri
    ['2026-10-03T05:00:00Z', false], // Sat
  ];
  for (const [iso, sends] of days) {
    const t = load({ props: BASE, rows: [] });
    const r = t.g.paymentsDigestRun_('scheduled', new Date(iso));
    assert.equal(t.sent.length, sends ? 1 : 0, iso);
    if (!sends) {
      assert.equal(r.skipped, 'weekend');
      assert.equal(t.props.writes.length, 0, 'a skipped day writes nothing');
      assert.equal(t.lockCalls.length, 0, 'a skipped day takes no lock');
    }
  }
});

test('weekday gating: 23:30 UTC edges decide by the JERUSALEM day, on both sides of the DST switch', () => {
  const cases = [
    ['2026-10-01T23:30:00Z', false, 'Thu 23:30 UTC = Fri 02:30 IDT'],
    ['2026-10-03T23:30:00Z', true,  'Sat 23:30 UTC = Sun 02:30 IDT'],
    ['2026-10-02T20:30:00Z', false, 'Fri 20:30 UTC = Fri 23:30 IDT'],
    ['2026-10-03T20:30:00Z', false, 'Sat 20:30 UTC = Sat 23:30 IDT'],
    ['2026-10-03T21:30:00Z', true,  'Sat 21:30 UTC = Sun 00:30 IDT'],
    ['2026-11-05T23:30:00Z', false, 'Thu 23:30 UTC = Fri 01:30 IST (winter)'],
    ['2026-11-07T23:30:00Z', true,  'Sat 23:30 UTC = Sun 01:30 IST (winter)'],
    ['2026-11-07T21:30:00Z', false, 'Sat 21:30 UTC = Sat 23:30 IST (winter)'],
    ['2026-11-07T22:30:00Z', true,  'Sat 22:30 UTC = Sun 00:30 IST (winter)'],
  ];
  const t = load({ props: BASE, rows: [] });
  for (const [iso, workday, why] of cases) {
    assert.equal(t.g.digestIsWorkday_(new Date(iso)), workday, why);
  }
  const fri = load({ props: BASE, rows: [] });
  fri.g.paymentsDigestRun_('scheduled', new Date('2026-10-01T23:30:00Z'));
  assert.equal(fri.sent.length, 0);
  const sun = load({ props: BASE, rows: [] });
  sun.g.paymentsDigestRun_('scheduled', new Date('2026-10-03T23:30:00Z'));
  assert.equal(sun.sent.length, 1);
});

test('the trigger handler runs the scheduled mode (weekend skip included)', () => {
  const src = GS_SRC.slice(GS_SRC.indexOf('function paymentsDigestJob('));
  assert.match(src.slice(0, 400), /paymentsDigestRun_\('scheduled'\)/);
});

/* ===================== the window ===================== */

test('window: only rows recorded in (lastDigestAt, now] — boundary excluded, future excluded, compared as instants', () => {
  const rows = [
    pay({ patientName: 'לפני', chargedAt: '2026-09-30T08:00:00+03:00' }),
    pay({ patientName: 'בדיוק בגבול', chargedAt: '2026-09-30T08:05:00+03:00' }),
    pay({ patientName: 'אחרי', chargedAt: '2026-09-30T08:05:01+03:00' }),
    pay({ patientName: 'בעוד UTC', chargedAt: '2026-09-30T20:00:00Z' }),
    pay({ patientName: 'עתיד', chargedAt: '2026-10-01T08:00:01+03:00' }),
  ];
  const t = load({ props: Object.assign({ DIGEST_LAST_AT: '2026-09-30T05:05:00Z' }, BASE), rows });
  const r = t.g.paymentsDigestRun_('scheduled', THU_8);
  assert.equal(r.count, 2);
  const html = t.sent[0].htmlBody;
  assert.ok(html.includes('אחרי') && html.includes('בעוד UTC'));
  assert.ok(!html.includes('לפני') && !html.includes('בדיוק בגבול') && !html.includes('עתיד'));
  assert.equal(t.props.store.DIGEST_LAST_AT, '2026-10-01T08:00:00+03:00', 'advanced to the run instant, with offset');
});

test("window: Sunday's mail covers Thursday after the send through Saturday", () => {
  const rows = [
    pay({ patientName: 'חמישי לפני', chargedAt: '2026-10-01T07:30:00+03:00' }),
    pay({ patientName: 'חמישי אחרי', chargedAt: '2026-10-01T14:00:00+03:00' }),
    pay({ patientName: 'שישי', chargedAt: '2026-10-02T10:00:00+03:00' }),
    pay({ patientName: 'שבת', chargedAt: '2026-10-03T21:00:00+03:00' }),
  ];
  const t = load({ props: BASE, rows });
  t.g.paymentsDigestRun_('scheduled', THU_8);
  t.g.paymentsDigestRun_('scheduled', new Date('2026-10-02T05:00:00Z')); // Fri — skipped
  t.g.paymentsDigestRun_('scheduled', new Date('2026-10-03T05:00:00Z')); // Sat — skipped
  const r = t.g.paymentsDigestRun_('scheduled', SUN_8);
  assert.equal(t.sent.length, 2);
  assert.equal(r.count, 3);
  const sun = t.sent[1].htmlBody;
  assert.ok(sun.includes('חמישי אחרי') && sun.includes('שישי') && sun.includes('שבת'));
  assert.ok(!sun.includes('חמישי לפני'), 'already in Thursday’s mail');
  assert.ok(t.sent[0].htmlBody.includes('חמישי לפני'));
});

test('window: the first run (no lastDigestAt) covers the last 7 days and says so', () => {
  const rows = [
    pay({ patientName: 'שמונה ימים', chargedAt: '2026-09-23T07:00:00+03:00' }),
    pay({ patientName: 'שישה ימים', chargedAt: '2026-09-25T07:00:00+03:00' }),
  ];
  const t = load({ props: BASE, rows });
  const r = t.g.paymentsDigestRun_('scheduled', THU_8);
  assert.equal(r.count, 1);
  assert.ok(t.sent[0].htmlBody.includes('שישה ימים'));
  assert.ok(t.sent[0].htmlBody.includes('הרצה ראשונה'));
});

test('a second scheduled run on the same Jerusalem day sends nothing', () => {
  const t = load({ props: BASE, rows: [] });
  t.g.paymentsDigestRun_('scheduled', THU_8);
  const r = t.g.paymentsDigestRun_('scheduled', new Date('2026-10-01T09:00:00Z'));
  assert.equal(t.sent.length, 1);
  assert.equal(r.skipped, 'already_sent_today');
});

/* ===================== what is listed ===================== */

test('void, unpaid and unstamped (historical) rows are excluded; partial is listed at amountPaid', () => {
  const at = '2026-09-30T12:00:00+03:00';
  const rows = [
    pay({ patientName: 'מבוטל אנגלית', status: 'void', chargedAt: at }),
    pay({ patientName: 'מבוטל עברית', status: 'מבוטל', chargedAt: at }),
    pay({ patientName: 'לא שולם', status: 'unpaid', amountPaid: 0, chargedAt: at }),
    pay({ patientName: 'היסטורי', chargedAt: '' }),
    pay({ patientName: 'חלקי', status: 'partial', amount: 30000, amountPaid: 12000, chargedAt: at }),
    pay({ patientName: 'שולם בעברית', status: 'שולם', chargedAt: at }),
  ];
  const t = load({ props: Object.assign({ DIGEST_LAST_AT: '2026-09-30T08:00:00+03:00' }, BASE), rows });
  const r = t.g.paymentsDigestRun_('scheduled', THU_8);
  assert.equal(r.count, 2);
  const html = t.sent[0].htmlBody;
  for (const gone of ['מבוטל אנגלית', 'מבוטל עברית', 'לא שולם', 'היסטורי']) assert.ok(!html.includes(gone), gone);
  assert.ok(html.includes('חלקי') && html.includes('₪12,000'));
  assert.equal(r.total, 42000);
});

test('an amount edited after it was sent is marked «עודכן» with the amount sent before; new rows are not', () => {
  const rows = [pay({ patientName: 'דוגמה', amountPaid: 30000, chargedAt: '2026-09-30T12:00:00+03:00' })];
  const t = load({ props: Object.assign({ DIGEST_LAST_AT: '2026-09-30T08:00:00+03:00' }, BASE), rows });
  t.g.paymentsDigestRun_('scheduled', THU_8);
  assert.ok(!t.sent[0].htmlBody.includes('עודכן'), 'first report is not an update');
  assert.ok(t.props.store.DIGEST_LEDGER_CHUNKS === '1');

  // Friday: Vered corrects the amount → stampPaymentRow_ re-stamps chargedAt.
  rows[0].amountPaid = 25000;
  rows[0].chargedAt = '2026-10-02T11:00:00+03:00';
  const fresh = pay({ patientName: 'חדש', chargedAt: '2026-10-02T12:00:00+03:00' });
  const t2 = load({ props: Object.assign({}, t.props.store), rows: [rows[0], fresh] });
  t2.g.paymentsDigestRun_('scheduled', SUN_8);
  const html = t2.sent[0].htmlBody;
  assert.match(html, /עודכן \(נשלח קודם: ₪30,000\)/);
  assert.equal((html.match(/עודכן/g) || []).length, 1, 'only the edited row');
  assert.ok(t2.sent[0].body.includes('עודכן (נשלח קודם: ₪30,000)'), 'plain text carries the mark too');
});

test('totals per house and overall', () => {
  const at = '2026-09-30T12:00:00+03:00';
  const rows = [
    pay({ houseId: 'arfoni', amountPaid: 30000, chargedAt: at }),
    pay({ houseId: 'arfoni', amountPaid: 5000, chargedAt: at }),
    pay({ houseId: 'ramot', amountPaid: 20000.5, chargedAt: at }),
    pay({ houseId: 'רעננה אשר', amountPaid: 15000, chargedAt: at }),
  ];
  const t = load({ props: Object.assign({ DIGEST_LAST_AT: '2026-09-30T08:00:00+03:00' }, BASE), rows });
  const r = t.g.paymentsDigestRun_('scheduled', THU_8);
  assert.equal(r.total, 70000.5);
  const tot = t.g.digestTotals_(t.g.digestSelect_(rows, Date.parse('2026-09-30T05:00:00Z'), THU_8.getTime(), {}));
  const by = Object.fromEntries(tot.byHouse.map((h) => [h.houseLabel, [h.count, h.amount]]));
  assert.deepEqual(by['קיסריה עפרוני'], [2, 35000]);
  assert.deepEqual(by['רמות השבים'], [1, 20000.5]);
  assert.deepEqual(by['רעננה אשר'], [1, 15000]);
  assert.equal(tot.count, 4);
  const text = t.sent[0].body;
  assert.ok(text.includes('קיסריה עפרוני: 2 תשלומים, ₪35,000'));
  assert.ok(text.includes('סה״כ: 4 תשלומים, ₪70,000.50'));
  assert.ok(t.sent[0].htmlBody.includes('סה״כ'));
});

test('each row carries name, Hebrew house, ₪ amount, DD/MM/YYYY date, method, recorded by and at', () => {
  const rows = [pay({ patientName: 'מטופל דוגמה', houseId: 'sde', amountPaid: 35000, dueDate: '2026-09-07',
    chargedBy: 'שירן', chargedAt: '2026-09-30T13:45:00+03:00' })];
  const t = load({ props: Object.assign({ DIGEST_LAST_AT: '2026-09-30T08:00:00+03:00' }, BASE), rows });
  t.g.paymentsDigestRun_('scheduled', THU_8);
  const m = t.sent[0];
  for (const s of ['מטופל דוגמה', 'שדה אליעזר', '₪35,000', '07/09/2026', 'העברה בנקאית', 'שירן', '30/09/2026 13:45']) {
    assert.ok(m.htmlBody.includes(s), 'html: ' + s);
    assert.ok(m.body.includes(s), 'text: ' + s);
  }
  assert.equal(m.subject, 'תשלומים שנרשמו — 01/10/2026');
  assert.ok(m.htmlBody.includes('href="https://ezone-dashboard.up.railway.app"'));
  assert.ok(m.body.includes('https://ezone-dashboard.up.railway.app'));
  assert.match(m.htmlBody, /^<div dir="rtl" style="direction:rtl;/);
  assert.ok(!/<style|class=/.test(m.htmlBody), 'inline styles only');
});

test('empty window → a short heartbeat «אין תשלומים חדשים», and the window still advances', () => {
  const t = load({ props: Object.assign({ DIGEST_LAST_AT: '2026-09-30T08:00:00+03:00' }, BASE),
    rows: [pay({ chargedAt: '2026-09-29T12:00:00+03:00' })] });
  const r = t.g.paymentsDigestRun_('scheduled', THU_8);
  assert.equal(r.count, 0);
  assert.equal(t.sent.length, 1);
  assert.ok(t.sent[0].htmlBody.includes('אין תשלומים חדשים'));
  assert.ok(t.sent[0].body.startsWith('אין תשלומים חדשים'));
  assert.ok(!t.sent[0].htmlBody.includes('<table'));
  assert.equal(t.props.store.DIGEST_LAST_AT, '2026-10-01T08:00:00+03:00');
});

test('no Payments sheet at all → heartbeat, never an error', () => {
  const t = load({ props: BASE });
  const r = t.g.paymentsDigestRun_('scheduled', THU_8);
  assert.equal(r.ok, true);
  assert.ok(t.sent[0].htmlBody.includes('אין תשלומים חדשים'));
});

/* ===================== recipients ===================== */

test('Sandra is CC’d on and before DIGEST_CC_UNTIL, not after; missing / malformed → no CC', () => {
  const run = (until, now) => {
    const p = Object.assign({}, BASE);
    if (until === undefined) delete p.DIGEST_CC_UNTIL; else p.DIGEST_CC_UNTIL = until;
    const t = load({ props: p, rows: [] });
    t.g.paymentsDigestRun_('scheduled', now);
    return t.sent[0];
  };
  assert.equal(run('2026-10-04', SUN_8).cc, CC, 'on the day');
  assert.equal(run('2026-10-08', SUN_8).cc, CC, 'before');
  assert.equal(run('2026-10-03', SUN_8).cc, undefined, 'after');
  assert.equal(run(undefined, SUN_8).cc, undefined, 'unset');
  assert.equal(run('04/10/2026', SUN_8).cc, undefined, 'malformed');
  // The day boundary is Jerusalem's: 22:30 UTC Sunday is already Monday.
  assert.equal(run('2026-10-04', new Date('2026-10-04T22:30:00Z')).cc, undefined);
  for (const m of [run('2026-10-08', SUN_8), run('2026-10-03', SUN_8)]) assert.equal(m.to, TO);
});

test('DIGEST_TO missing, blank or malformed → nothing sent, a warning logged, nothing advanced', () => {
  for (const bad of [undefined, '', '   ', 'ortal', 'ortal@example.test\nBcc: x@example.test', 'ortal@example.test, nope']) {
    const p = Object.assign({}, BASE);
    if (bad === undefined) delete p.DIGEST_TO; else p.DIGEST_TO = bad;
    const t = load({ props: p, rows: [pay({ chargedAt: '2026-09-30T12:00:00+03:00' })] });
    const r = t.g.paymentsDigestRun_('scheduled', THU_8);
    assert.equal(t.sent.length, 0, JSON.stringify(bad));
    assert.equal(r.error, 'no_recipient');
    assert.ok(t.logs.some((l) => /WARNING/.test(l) && /DIGEST_TO/.test(l)));
    assert.equal(t.props.writes.length, 0);
  }
});

test('a malformed DIGEST_CC never blocks Ortal’s mail; it just drops the CC', () => {
  const t = load({ props: Object.assign({}, BASE, { DIGEST_CC: 'sandra@example.test\r\nBcc: x@y.test' }), rows: [] });
  t.g.paymentsDigestRun_('scheduled', THU_8);
  assert.equal(t.sent.length, 1);
  assert.equal(t.sent[0].cc, undefined);
});

test('recipients are never written in Code.gs: no e-mail address literal in the digest section', () => {
  const section = digestSection();
  assert.ok(!/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(section));
});

/* ===================== the watermark ===================== */

test('a send failure advances nothing, the job throws (execution shows Failed), and the next run covers the gap', () => {
  const rows = [pay({ patientName: 'פער', chargedAt: '2026-09-30T12:00:00+03:00' })];
  const props = Object.assign({ DIGEST_LAST_AT: '2026-09-30T08:00:00+03:00' }, BASE);
  const t = load({ props, rows, mailThrows: true });
  const r = t.g.paymentsDigestRun_('scheduled', THU_8);
  assert.equal(r.error, 'send_failed');
  assert.equal(t.props.store.DIGEST_LAST_AT, '2026-09-30T08:00:00+03:00');
  assert.equal(t.props.writes.length, 0);
  assert.deepEqual(t.lockCalls, ['try:30000', 'release'], 'lock released after the failure');
  const t2 = load({ props, rows, mailThrows: true, now: THU_8 });
  assert.throws(() => t2.g.paymentsDigestJob(), /send failed/);
  // Next working day, mail is back: the row recorded before the failed run is in.
  const t3 = load({ props: Object.assign({}, t.props.store), rows });
  t3.g.paymentsDigestRun_('scheduled', SUN_8);
  assert.ok(t3.sent[0].htmlBody.includes('פער'));
});

test('a busy lock sends nothing and advances nothing', () => {
  const t = load({ props: BASE, rows: [], lockBusy: true });
  const r = t.g.paymentsDigestRun_('scheduled', THU_8);
  assert.equal(r.error, 'lock_busy');
  assert.equal(t.sent.length, 0);
  assert.equal(t.props.writes.length, 0);
});

test('the watermark moves only AFTER MailApp returns, inside the lock', () => {
  const body = GS_SRC.slice(GS_SRC.indexOf('function paymentsDigestRun_('), GS_SRC.indexOf('function paymentsDigestJob('));
  const send = body.lastIndexOf('MailApp.sendEmail(mail)');
  const adv = body.indexOf('set[DIGEST_PROP_LAST_AT]');
  const lock = body.indexOf('lock.tryLock(30000) !== true');
  const release = body.lastIndexOf('lock.releaseLock()');
  assert.ok(lock > 0 && lock < send && send < adv && adv < release);
  assert.equal((body.match(/DIGEST_PROP_LAST_AT\]/g) || []).length, 1, 'one write site');
});

test('previewDigestNow builds and logs the mail WITHOUT sending and WITHOUT advancing — on any day', () => {
  const rows = [pay({ patientName: 'תצוגה', chargedAt: '2026-10-01T12:00:00+03:00' })];
  const t = load({ props: Object.assign({ DIGEST_LAST_AT: '2026-09-30T08:00:00+03:00' }, BASE), rows });
  const r = t.g.paymentsDigestRun_('preview', new Date('2026-10-02T05:00:00Z')); // a Friday
  assert.equal(t.sent.length, 0);
  assert.equal(t.props.writes.length, 0);
  assert.equal(t.lockCalls.length, 0);
  assert.equal(r.count, 1);
  assert.ok(t.logs.join('\n').includes('תצוגה'));
  assert.ok(t.logs.join('\n').includes('not sent'));
  const noTo = load({ props: { DIGEST_CC: CC }, rows });
  noTo.g.previewDigestNow();
  assert.ok(noTo.logs.join('\n').includes('would send NOTHING'));
});

test('sendDigestTestNow sends to DIGEST_CC only (no CC, never Ortal) and advances nothing', () => {
  const rows = [pay({ chargedAt: '2026-10-01T12:00:00+03:00' })];
  const t = load({ props: Object.assign({ DIGEST_LAST_AT: '2026-09-30T08:00:00+03:00' }, BASE, { DIGEST_CC_UNTIL: '2026-01-01' }), rows });
  const r = t.g.sendDigestTestNow();
  assert.equal(r.sent, true);
  assert.equal(t.sent.length, 1);
  assert.equal(t.sent[0].to, CC);
  assert.equal(t.sent[0].cc, undefined);
  assert.match(t.sent[0].subject, /^\[בדיקה\] תשלומים שנרשמו — /);
  assert.equal(t.props.writes.length, 0);
  const none = load({ props: { DIGEST_TO: TO }, rows });
  assert.equal(none.g.sendDigestTestNow().error, 'no_cc');
  assert.equal(none.sent.length, 0);
  const fail = load({ props: BASE, rows, mailThrows: true });
  assert.equal(fail.g.sendDigestTestNow().error, 'send_failed');
  assert.equal(fail.props.writes.length, 0);
});

/* ===================== content safety ===================== */

test('every value is HTML-escaped (name, house, method, recorder)', () => {
  const evil = '<script>alert(1)</script>&"\'';
  const rows = [pay({ patientName: evil, houseId: '<b>x</b>', chargedBy: '<img src=x onerror=1>',
    'אמצעי תשלום': '"><a href=javascript:1>', chargedAt: '2026-09-30T12:00:00+03:00' })];
  const t = load({ props: Object.assign({ DIGEST_LAST_AT: '2026-09-30T08:00:00+03:00' }, BASE), rows });
  t.g.paymentsDigestRun_('scheduled', THU_8);
  const html = t.sent[0].htmlBody;
  assert.ok(!html.includes('<script') && !html.includes('<img') && !html.includes('<b>x') && !html.includes('<a href=javascript'));
  // The dashboard link, and (Phase 4) the «ממתינים לאימות» link to the tab.
  assert.equal((html.match(/<a /g) || []).length, 2, 'only the dashboard link and the «בקרת גבייה» link');
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;&amp;&quot;&#39;'));
  assert.ok(html.includes('&lt;img src=x onerror=1&gt;'));
  assert.equal(t.g.digestEsc_('a&<>"\'b'), 'a&amp;&lt;&gt;&quot;&#39;b');
});

test('a line break in a name cannot forge a line in the plain-text part', () => {
  const rows = [pay({ patientName: 'שם\nסה״כ: 0 תשלומים', chargedAt: '2026-09-30T12:00:00+03:00' })];
  const t = load({ props: Object.assign({ DIGEST_LAST_AT: '2026-09-30T08:00:00+03:00' }, BASE), rows });
  t.g.paymentsDigestRun_('scheduled', THU_8);
  assert.ok(!t.sent[0].body.split('\n').some((l) => l.startsWith('סה״כ: 0')));
});

test('no phone number and no id (row id, billing triple, paymentUid, patientUid) anywhere in the message', () => {
  const rows = [
    pay({ chargedAt: '2026-09-30T12:00:00+03:00' }),
    pay({ houseId: 'ramot', chargedAt: '2026-09-30T13:00:00+03:00' }),
  ];
  const t = load({ props: Object.assign({ DIGEST_LAST_AT: '2026-09-30T08:00:00+03:00' }, BASE), rows });
  t.g.paymentsDigestRun_('scheduled', THU_8);
  const all = t.sent[0].htmlBody + '\n' + t.sent[0].body + '\n' + t.sent[0].subject;
  for (const r of rows) {
    for (const v of [r['טלפון'], r.id, r.patientId, r.paymentUid, r.patientUid]) assert.ok(!all.includes(v), 'leaked: ' + v);
  }
  assert.ok(!/0\d{1,2}-?\d{3}-?\d{4}/.test(all), 'nothing phone-shaped');
  assert.ok(!/pmt-|id-patient|pay::|::/.test(all), 'nothing id-shaped');
  const projected = Object.keys(t.g.digestRow_(rows[0], {})).sort();
  assert.deepEqual(projected, ['amount', 'houseLabel', 'instant', 'key', 'method', 'patientName', 'paymentDate',
    'previousAmount', 'recordedAt', 'recordedBy', 'reference', 'updated',
    'invoiceWanted', 'invoiceTo'].sort(), 'the allow-list (reference: Phase 3 PR 2; invoice: CHANGELOG-payment-invoice.md)');
});

test('read-only against the spreadsheet: zero write attempts, never getOrCreateSheet_', () => {
  const rows = [pay({ chargedAt: '2026-09-30T12:00:00+03:00' })];
  const t = load({ props: Object.assign({ DIGEST_LAST_AT: '2026-09-30T08:00:00+03:00' }, BASE), rows });
  t.g.paymentsDigestRun_('scheduled', THU_8);
  t.g.paymentsDigestRun_('preview', THU_8);
  assert.deepEqual(t.attempts, []);
  const section = stripComments(digestSection());
  assert.ok(!/getOrCreateSheet_|setValues|appendRow|deleteRow|insertSheet|logAudit_|UrlFetchApp|GmailApp|DriveApp/.test(section));
});

/* ===================== ledger ===================== */

test('the ledger is chunked, pruned after 180 days, and stale chunks are deleted', () => {
  const t = load({ props: BASE, rows: [] });
  const old = {};
  for (let i = 0; i < 400; i++) old['pmt-' + String(i).padStart(36, 'x')] = { amount: 30000, day: i < 200 ? '2026-01-01' : '2026-09-01' };
  const led = t.g.digestLedgerNext_(old, [{ key: 'pmt-new', amount: 1 }], '2026-10-01', 9);
  const json = Object.keys(led.set).filter((k) => /^DIGEST_LEDGER_\d+$/.test(k)).sort((a, b) => +a.slice(14) - +b.slice(14))
    .map((k) => led.set[k]).join('');
  const parsed = JSON.parse(json);
  assert.equal(Object.keys(parsed).length, 201, '200 kept + 1 new; 200 pruned');
  assert.ok(Object.keys(led.set).every((k) => String(led.set[k]).length <= 9000));
  const chunks = +led.set.DIGEST_LEDGER_CHUNKS;
  assert.ok(chunks >= 2);
  assert.equal(led.drop.length, 9 - chunks);
});

/* ===================== editor-run entry points ===================== */

test('installDigestTriggerNow is idempotent: one daily 08:00 Asia/Jerusalem trigger, others untouched', () => {
  const t = load({ props: BASE, triggers: ['paymentsDigestJob', 'paymentsDigestJob', 'nightlyIntegrityJob'] });
  const r1 = t.g.installDigestTriggerNow();
  assert.equal(r1.removed, 2);
  t.g.installDigestTriggerNow();
  t.g.installDigestTriggerNow();
  const handlers = t.scriptApp.state.triggers.map((x) => x.handler);
  assert.equal(handlers.filter((h) => h === 'paymentsDigestJob').length, 1);
  assert.equal(handlers.filter((h) => h === 'nightlyIntegrityJob').length, 1);
  const spec = t.scriptApp.state.created[t.scriptApp.state.created.length - 1];
  assert.deepEqual({ ...spec }, { handler: 'paymentsDigestJob', everyDays: 1, atHour: 8, nearMinute: 0, tz: 'Asia/Jerusalem' });
});

test('authorizeDigestNow: requireAllScopes(FULL) is the FIRST statement and is not caught; then it logs the quota', () => {
  const fn = GS_SRC.slice(GS_SRC.indexOf('function authorizeDigestNow('), GS_SRC.indexOf('function previewDigestNow('));
  const bodyCode = fn.slice(fn.indexOf('{') + 1).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').trim();
  assert.ok(bodyCode.startsWith('ScriptApp.requireAllScopes(ScriptApp.AuthMode.FULL);'));
  assert.ok(!/\btry\b|\bcatch\b/.test(fn), 'uncaught');
  const ok = load({ props: BASE });
  assert.equal(ok.g.authorizeDigestNow().remainingDailyQuota, 97);
  assert.deepEqual(ok.scriptApp.state.scopes, ['FULL']);
  assert.ok(ok.logs.some((l) => /quota: 97/.test(l)));
  const denied = load({ props: BASE });
  denied.scriptApp.state.scopesThrow = true;
  assert.throws(() => denied.g.authorizeDigestNow(), /Authorization is required/);
});

test('not reachable over HTTP: handle_ names none of the digest functions', () => {
  const h = GS_SRC.slice(GS_SRC.indexOf('function handle_('), GS_SRC.indexOf('\nfunction ', GS_SRC.indexOf('function handle_(') + 1));
  for (const name of ['paymentsDigestJob', 'paymentsDigestRun_', 'authorizeDigestNow', 'previewDigestNow',
    'sendDigestTestNow', 'installDigestTriggerNow', 'digest']) {
    assert.ok(!h.includes(name + '(') && !h.includes("'" + name), name);
  }
});

test('appsscript.json pins the two scopes the digest needs; the project stays on Asia/Jerusalem', () => {
  assert.ok(MANIFEST.oauthScopes.includes('https://www.googleapis.com/auth/script.send_mail'));
  assert.ok(MANIFEST.oauthScopes.includes('https://www.googleapis.com/auth/script.scriptapp'));
  assert.equal(MANIFEST.timeZone, 'Asia/Jerusalem');
});

test('the digest section declares each function once and no top-level side effects', () => {
  const section = digestSection();
  const names = [...section.matchAll(/^function (\w+)\(/gm)].map((m) => m[1]);
  assert.equal(new Set(names).size, names.length);
  for (const nm of names) assert.equal((GS_SRC.match(new RegExp('^function ' + nm + '\\(', 'gm')) || []).length, 1, nm);
  const topLevel = section.split('\n').filter((l) => /^[A-Za-z]/.test(l));
  const bad = topLevel.filter((l) => !/^(const |function |\})/.test(l));
  assert.deepEqual(bad, []);
});
