/* Israeli date display: every date a human reads is DD/MM/YYYY.
 *
 * Dates were rendered two different ways and neither was the Israeli form:
 * formatDate() produced he-IL's locale default ("9.5.2026" — dots, no zero
 * padding) and the coverage-period ranges printed raw ISO ("2026-09-22 →
 * 2026-10-21"). formatDateHe() is now the ONE formatter, and dateRangeHeHtml()
 * the one range renderer.
 *
 * Locked contracts:
 *   A. formatDateHe accepts a bare 'YYYY-MM-DD', a full ISO timestamp or a
 *      Date; returns 'DD/MM/YYYY', '' for blank, and the ORIGINAL value for
 *      anything unparseable — never 'NaN', never 'Invalid Date';
 *   B. NO TIMEZONE SHIFT. A bare date is split on its own digits and never
 *      touches `new Date(...)` (which parses it as UTC midnight and renders
 *      the previous day for Israel); a timestamp reads its LOCAL calendar day;
 *   C. a range reads start-on-the-RIGHT in RTL, each date isolated in <bdi>,
 *      everything escaped;
 *   D. a source scan: no template in app.js may interpolate a raw date value
 *      into markup without going through the formatter. Input `value=`
 *      attributes, storage/API payloads and identity keys are allowlisted
 *      EXPLICITLY, one entry per line, so a new raw render cannot slip in.
 *
 * TZ pinned to Asia/Jerusalem so the offset assertions mean what they say.
 * vm-sandbox on the REAL shipped app.js, per repo convention.
 */

process.env.TZ = 'Asia/Jerusalem';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const SW_SRC = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');

/* ---------- harness ---------- */

function loadApp(opts) {
  opts = opts || {};
  const epilogue = `globalThis.__test = {
    formatDateHe, dateRangeHeHtml, formatDate, escapeHtml, isoDate, todayISO,
  };`;
  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/' },
    document: {
      addEventListener: noop, getElementById: () => null,
      querySelector: () => null, querySelectorAll: () => [],
      createElement: () => ({ style: {}, classList: { add: noop, toggle: noop } }),
    },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    URLSearchParams, Math, JSON, Number, String, Array, Object, RegExp,
    isNaN, isFinite, parseInt, parseFloat, Promise,
    Date: opts.Date || Date,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(APP_SRC + epilogue, sandbox);
  return sandbox.__test;
}
const app = loadApp();

/* ================= A. what formatDateHe accepts and returns ============= */

test('A: a bare YYYY-MM-DD becomes DD/MM/YYYY', () => {
  assert.equal(app.formatDateHe('2026-09-22'), '22/09/2026');
  assert.equal(app.formatDateHe('2026-01-05'), '05/01/2026');
  assert.equal(app.formatDateHe('2025-12-31'), '31/12/2025');
  // Zero-padded, slash-separated — not he-IL's "5.1.2026" default.
  assert.match(app.formatDateHe('2026-01-05'), /^\d{2}\/\d{2}\/\d{4}$/);
});

test('A: a full ISO timestamp becomes DD/MM/YYYY of its LOCAL day', () => {
  // Midday — same calendar day in every reasonable zone.
  assert.equal(app.formatDateHe('2026-09-22T12:00:00.000Z'), '22/09/2026');
  // The shape Sheets hands back for a date-typed cell.
  assert.equal(app.formatDateHe('2026-06-10T09:30:00+03:00'), '10/06/2026');
});

test('A: a Date object becomes DD/MM/YYYY of its LOCAL day', () => {
  assert.equal(app.formatDateHe(new Date(2026, 8, 22, 14, 5)), '22/09/2026');
  assert.equal(app.formatDateHe(new Date(2026, 0, 1, 9, 0)), '01/01/2026');
});

test('A: blank in, blank out', () => {
  for (const v of ['', null, undefined]) assert.equal(app.formatDateHe(v), '');
});

test('A: an unparseable value comes back UNCHANGED — never NaN, never Invalid Date', () => {
  for (const v of ['not a date', 'שלום', '2026-13-99xx', 'TBD', '—']) {
    const out = app.formatDateHe(v);
    assert.equal(out, v, `${v} must be handed back as-is`);
    assert.doesNotMatch(out, /NaN|Invalid/, `${v} produced ${out}`);
  }
  /* A non-string with no honest text form renders BLANK — String() would give
   * 'Invalid Date' / '[object Object]' / 'NaN', which is the whole point. */
  for (const v of [new Date('nope'), NaN, {}, []]) {
    const out = app.formatDateHe(v);
    assert.doesNotMatch(String(out), /NaN|Invalid|object/, `produced ${out}`);
  }
  assert.equal(app.formatDateHe(new Date('nope')), '');
});

/* ================= B. no timezone shift ================= */

test('B: a bare date never touches `new Date` — proven by counting constructions', () => {
  /* new Date('2026-09-22') parses as UTC MIDNIGHT, which renders as 21/09 for
   * Israel. The only way to be sure the bare path cannot regress into it is to
   * watch whether a Date is constructed at all while it runs. (app.js builds
   * Dates at load time, so the counter is reset after loading rather than made
   * fatal.) */
  let constructed = 0;
  class CountingDate extends Date {
    constructor(...a) { constructed++; super(...a); }
  }
  CountingDate.now = Date.now;
  CountingDate.parse = Date.parse;
  CountingDate.UTC = Date.UTC;
  const strict = loadApp({ Date: CountingDate });
  constructed = 0;
  assert.equal(strict.formatDateHe('2026-09-22'), '22/09/2026');
  assert.equal(strict.formatDateHe('2026-01-01'), '01/01/2026');
  assert.equal(strict.formatDateHe(''), '');
  assert.equal(constructed, 0, 'the bare-date path constructed a Date');
  // A timestamp legitimately does construct one — proving the counter works.
  strict.formatDateHe('2026-09-21T21:30:00.000Z');
  assert.ok(constructed > 0, 'the counter must actually observe constructions');
  // And the source really does split the digits before anything else.
  const body = APP_SRC.slice(APP_SRC.indexOf('function formatDateHe('));
  const head = body.slice(0, body.indexOf('const iso = isoDate(value);'));
  assert.match(head, /value\.match\(\/\^\(\\d\{4\}\)-\(\\d\{2\}\)-\(\\d\{2\}\)\$\//);
  assert.ok(!/new Date/.test(head), 'the bare-date path must be Date-free');
});

test('B: a time near midnight keeps its LOCAL day (the −1-day drift guard)', () => {
  // 00:30 local Israel. Its UTC instant is the PREVIOUS day (21:30Z), so a
  // UTC-based formatter would print 21/09.
  assert.equal(app.formatDateHe(new Date(2026, 8, 22, 0, 30)), '22/09/2026');
  // The same instant as a Sheets-style UTC timestamp — 2026-09-21T21:30Z is
  // 2026-09-22 00:30 in Israel (UTC+3 in September).
  assert.equal(app.formatDateHe('2026-09-21T21:30:00.000Z'), '22/09/2026');
  // 23:45 local, whose UTC instant is the SAME day — must not roll forward.
  assert.equal(app.formatDateHe(new Date(2026, 8, 22, 23, 45)), '22/09/2026');
  // Winter, UTC+2: 2026-01-14T22:30Z is 2026-01-15 00:30 in Israel.
  assert.equal(app.formatDateHe('2026-01-14T22:30:00.000Z'), '15/01/2026');
});

test('B: a bare date is stable regardless of the machine timezone', () => {
  const saved = process.env.TZ;
  try {
    for (const tz of ['UTC', 'Pacific/Kiritimati', 'Pacific/Pago_Pago', 'Asia/Jerusalem']) {
      process.env.TZ = tz;
      const a = loadApp();
      assert.equal(a.formatDateHe('2026-09-22'), '22/09/2026', 'under ' + tz);
      assert.equal(a.formatDateHe('2026-01-01'), '01/01/2026', 'under ' + tz);
    }
  } finally {
    process.env.TZ = saved;
  }
});

/* ================= C. ranges read right-to-left ================= */

test('C: a range is start-first, so the START reads on the RIGHT in RTL', () => {
  const html = app.dateRangeHeHtml('2026-09-22', '2026-10-21');
  assert.equal(html, '<bdi>22/09/2026</bdi> – <bdi>21/10/2026</bdi>');
  // Source order: start before end. In an RTL container that puts it rightmost.
  assert.ok(html.indexOf('22/09/2026') < html.indexOf('21/10/2026'));
  // Each date is isolated so its digits can never be reordered.
  assert.equal((html.match(/<bdi>/g) || []).length, 2);
  assert.match(html, /<\/bdi> – <bdi>/, 'an en dash between the two');
});

test('C: a half-blank range renders the one date it has; fully blank renders nothing', () => {
  assert.equal(app.dateRangeHeHtml('2026-09-22', ''), '<bdi>22/09/2026</bdi>');
  assert.equal(app.dateRangeHeHtml('', '2026-10-21'), '<bdi>21/10/2026</bdi>');
  assert.equal(app.dateRangeHeHtml('', ''), '');
  assert.equal(app.dateRangeHeHtml(null, undefined), '');
});

test('C: a range escapes an unparseable value rather than injecting it', () => {
  const PAYLOAD = '<img src=x onerror=alert(1)>';

  /* BOTH sides at once — each date must pass through escapeHtml on its own,
   * so neither position can be the one that leaks. */
  const both = app.dateRangeHeHtml(PAYLOAD, PAYLOAD);
  assert.ok(!both.includes('<img'), 'markup must not survive: ' + both);
  /* The payload's CHARACTERS survive as text — that is correct and harmless:
   * with < and > escaped it can never become a tag or an attribute. What must
   * not survive is the MARKUP, asserted above and by the tag census below. */
  assert.equal((both.match(/&lt;img src=x onerror=alert\(1\)&gt;/g) || []).length, 2,
    'both dates are escaped, not just one: ' + both);
  // The only tags left are the two <bdi> wrappers this helper writes itself.
  assert.deepEqual(both.match(/<[^>]+>/g), ['<bdi>', '</bdi>', '<bdi>', '</bdi>']);

  // …and each side alone.
  for (const html of [app.dateRangeHeHtml(PAYLOAD, '2026-10-21'),
                      app.dateRangeHeHtml('2026-09-22', PAYLOAD)]) {
    assert.ok(!html.includes('<img'), 'markup must not survive: ' + html);
    assert.match(html, /&lt;img/);
  }
  // The single-date branch (one side blank) escapes too.
  const lone = app.dateRangeHeHtml(PAYLOAD, '');
  assert.ok(!lone.includes('<img'), 'markup must not survive: ' + lone);
  assert.match(lone, /^<bdi>&lt;img/);

  assert.equal(app.escapeHtml('<b>'), '&lt;b&gt;');
  // Every value the helper interpolates goes through escapeHtml in the source.
  const src = APP_SRC.slice(APP_SRC.indexOf('function dateRangeHeHtml('));
  const body = src.slice(0, src.indexOf('\n}') + 2);
  (body.match(/\$\{[^}]*\}/g) || []).forEach((expr) => {
    assert.match(expr, /escapeHtml\(/, 'unescaped interpolation in dateRangeHeHtml: ' + expr);
  });
});

test('C: both range call sites dropped dir="ltr" — the isolation is per-date now', () => {
  assert.match(APP_SRC, /<span class="p-val bill-cov-view">\$\{covHtml\}/);
  assert.match(APP_SRC, /<span class="p-label">חלון כיסוי<\/span><span class="p-val">\$\{windowHtml\}<\/span>/);
  // The raw-ISO arrow renders they replace are gone from the display layer.
  assert.ok(!APP_SRC.includes('`${covStart} → ${covEnd}`'));
  assert.ok(!APP_SRC.includes('`${row.coverageStart} → ${row.coverageEnd}`'));
});

/* ================= D. the source scan ================= */

/* Identifiers that hold a calendar date. A `${…}` interpolation naming one of
 * these is rendering a date — it must go through the formatter. */
const DATE_TOKENS = [
  'dueDate', 'dueDateISO', 'visitDate', 'exitDate', 'entryDate', 'dischargedAt',
  'movedAt', 'removedAt', 'decidedDate', 'payoutDate', 'paidDate', 'linkedAt',
  'waitlistedAt', 'createdISO', 'renewalISO', 'weekStart', 'weekEnd',
  'coverageStart', 'coverageEnd', 'RECORDS_COMPLETE_FROM',
];
const FORMATTERS = ['formatDateHe', 'formatDate', 'dateRangeHeHtml', 'meetingReportWhenText'];

/* Lines that legitimately carry a raw ISO date, each justified. Matched as a
 * substring of the source line, so adding a raw render elsewhere still fails. */
const ALLOWLIST = [
  // <input type="date"> / <input type="month"> values MUST stay ISO.
  'value="${escapeHtml(covStart)}"',
  'value="${escapeHtml(covEnd)}"',
  'value="${escapeHtml(l.decidedDate || \'\')}"',
  'value="${escapeHtml(l.paidDate || \'\')}"',
  'value="${escapeHtml(l.allocationMonth)}"',
  'value="${escapeHtml(m.date || \'\')}"',
  'value="${lead.visitDate || \'\'}"',
  'data-field="created" value="${escapeHtml(createdISO)}" />`',
  // Identity keys and request payloads — stored values, never displayed.
  'return `${p.houseId}::${trimName(p.name)}::${p.date || \'\'}`;',
  'return `${resolveHouseId(houseId || \'\')}::${normalizeNameForMatch(name)}::${isoDate(dateISO)}`;',
  'return `pay::${patientKey(patient)}::${dueDateISO}`;',
  'return `ovr::${patientId}::${month}`;',
  // isoFromLocalDate IS the ISO producer; it must emit ISO.
  "return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;",
  // creditBasisText is PERSISTED to the Sheets `reason` column verbatim.
  // Reformatting it would change stored data, which this change must not do.
  'const windowText = `חלון כיסוי ${basis.coverageStart} → ${basis.coverageEnd}',
  '`שהות ${basis.tenureDays == null ? \'?\' : basis.tenureDays} ימים',
  'return `${CREDIT_RULE_LABELS.prepaid_return} (שחרור ${basis.exitDate});',
  '(עד ${basis.alreadyCreditedThrough} כבר זוכה בשורה קודמת)',
];

function scanRawDateRenders(src) {
  const out = [];
  src.split('\n').forEach((line, i) => {
    if (ALLOWLIST.some((a) => line.includes(a))) return;
    const interps = line.match(/\$\{[^}]*\}/g) || [];
    interps.forEach((expr) => {
      if (FORMATTERS.some((f) => expr.includes(f + '('))) return;
      if (!DATE_TOKENS.some((t) => new RegExp('\\b' + t + '\\b').test(expr))) return;
      out.push({ line: i + 1, expr: expr, src: line.trim() });
    });
  });
  return out;
}

test('D: no template in app.js renders a raw date without the formatter', () => {
  const hits = scanRawDateRenders(APP_SRC);
  assert.deepEqual(hits, [],
    'raw date renders found:\n' + hits.map((h) => `  app.js:${h.line}  ${h.expr}\n      ${h.src}`).join('\n'));
});

test('D: the scanner actually catches a raw render (it is not vacuously green)', () => {
  const planted = 'const x = `<span>${payment.dueDate}</span>`;';
  const hits = scanRawDateRenders(planted);
  assert.equal(hits.length, 1, 'the guard must flag a raw ${payment.dueDate}');
  assert.equal(hits[0].expr, '${payment.dueDate}');
  // …and accepts the formatted form.
  assert.deepEqual(scanRawDateRenders('const x = `<span>${formatDateHe(payment.dueDate)}</span>`;'), []);
});

test('D: every allowlist entry still exists in app.js (no stale exemptions)', () => {
  for (const entry of ALLOWLIST) {
    assert.ok(APP_SRC.includes(entry), 'stale allowlist entry — delete it: ' + entry);
  }
});

/* ================= E. what must NOT have changed ================= */

test('E: isoDate / isoTime still produce ISO, and inputs still get ISO', () => {
  assert.equal(app.isoDate('2026-09-22'), '2026-09-22');
  assert.equal(app.isoDate(new Date(2026, 8, 22, 0, 30)), '2026-09-22');
  assert.match(app.todayISO(), /^\d{4}-\d{2}-\d{2}$/);
  // The two coverage inputs are still fed the ISO values, not the display form.
  assert.match(APP_SRC, /startIn\.value = covStart;/);
  assert.match(APP_SRC, /endIn\.value = covEnd;/);
  assert.match(APP_SRC, /const covStart = cov \? isoFromLocalDate\(cov\.start\) : '';/);
});

test('E: formatDate keeps its "—" placeholder and now delegates to formatDateHe', () => {
  assert.equal(app.formatDate(''), '—');
  assert.equal(app.formatDate(null), '—');
  assert.equal(app.formatDate('2026-09-22'), '22/09/2026');
  // The old he-IL locale output ("22.9.2026") is gone.
  assert.ok(!app.formatDate('2026-09-22').includes('.'));
  assert.ok(!/toLocaleDateString\('he-IL'\)/.test(APP_SRC),
    'the bare locale-date call is gone; only the month-year labels remain');
});

test('E: month-year labels are untouched (they are not DD/MM/YYYY dates)', () => {
  const monthLabels = APP_SRC.match(/toLocaleDateString\('he-IL', \{ month: 'long', year: 'numeric' \}\)/g) || [];
  assert.equal(monthLabels.length, 2, 'the two "ספטמבר 2026" headings stay as they are');
});

test('E: the service worker cache version was bumped for the app.js change', () => {
  const v = /var CACHE_VERSION = '(v\d+)';/.exec(SW_SRC)[1];
  /* What matters is that v15 — the last version that served ISO dates — is
   * evicted, not that the counter stopped at v16. Pinning the exact number
   * made every later asset change break this test (sw-install-fix.test.js was
   * already made version-agnostic for the same reason). */
  assert.ok(Number(v.slice(1)) >= 16,
    `v15 served ISO dates and must be superseded; found ${v}`);
});
