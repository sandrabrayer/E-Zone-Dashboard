/* «חתכי מטופלים» fixes (CHANGELOG-chitukim-fixes.md) — the parts CI can run
 * without a browser: the pure reconciliation table (lib/patient-retention.js
 * bucketSummary / summaryToCsv), the Excel «סיכום» and «שהות – חתך» sheets
 * read BACK with exceljs, the REAL public/app.js in a vm (the screen model,
 * the list behind a number, the input/change logic that used to swallow the
 * next click, the action guard and the retry toast), and the wiring.
 * The real-browser regressions are in chitukim-fixes-browser.test.js.
 * All names, phones and ids are synthetic. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ExcelJS = require('exceljs');
const R = require('../lib/patient-retention');
const LF = require('../lib/leads-funnel');
const X = require('../lib/report-xlsx');
const { loadPage, tick } = require('./helpers/app-sandbox');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const FROM = '2026-09-01', TO = '2026-09-30', TODAY = '2026-10-20';

const P = (id, date, over) => Object.assign({ id, houseId: 'ramot', name: 'מטופל ' + id, date, status: 'active' }, over || {});
const released = (id, date, exitDate, over) => P(id, date, Object.assign({ status: 'released', exitDate }, over || {}));

/* Discharged: 9 / 40 / 70 days (one per bucket). Still in treatment on
 * TODAY (2026-10-20): 20 and 25 days (≤ 30), 35 and 49 days (31–60), none
 * over 60. One released row without a discharge day («נתונים חסרים»). */
const PATIENTS = [
  released('d1', '2026-09-01', '2026-09-10', { name: '<img src=x onerror=alert(1)>' }),   // 9
  released('d2', '2026-09-05', '2026-10-15'),                                              // 40
  released('d3', '2026-09-02', '2026-11-11'),                                              // 70
  P('s1', '2026-09-30'),                                                                   // 20
  P('s2', '2026-09-25'),                                                                   // 25
  P('s3', '2026-09-15'),                                                                   // 35
  P('s4', '2026-09-01'),                                                                   // 49
  released('m1', '2026-09-08', ''),                                                        // missing
];
const DISCHARGED = [
  { id: 'a1', patientId: 'd1', houseId: 'ramot', name: '<img src=x onerror=alert(1)>', date: '2026-09-01', exitDate: '2026-09-10', continuity: 'none', phone: '0501234567' },
];
const report = (over) => R.computeRetention(Object.assign({ patients: PATIENTS, discharged: DISCHARGED, from: FROM, to: TO, today: TODAY }, over || {}));

/* ---------- 3. the numbers reconcile (pure) ---------- */

test('bucketSummary: discharged buckets + still in treatment = the cohort; sub-lines sum to «עדיין בטיפול»', () => {
  const r = report();
  const t = R.bucketSummary(r);
  assert.deepEqual(t.rows.map((x) => [x.key, x.discharged, x.still, x.total]), [
    ['upTo30', 1, 2, 3], ['d31to60', 1, 2, 3], ['over60', 1, 0, 1],
  ]);
  assert.equal(t.discharged, r.dischargedCount);
  assert.equal(t.still, r.stillInTreatment.count, 'Σ sub-lines = the «עדיין בטיפול» card');
  assert.equal(t.discharged + t.still, r.cohortSize, 'Σ discharged + Σ still = the cohort');
  assert.equal(t.cohort, r.cohortSize);
  assert.equal(r.missingCount, 1, 'a missing row is in neither');
  // every count is the list behind it
  t.rows.forEach((x) => {
    assert.equal(R.listFor(r, { kind: 'bucket', key: x.key }).length, x.discharged);
    assert.equal(R.listFor(r, { kind: 'stillBucket', key: x.key }).length, x.still);
  });
  assert.equal(R.bucketSummary({ ok: false }), null);
});

test('stillSubLineLabel: «+N עדיין בטיפול»; anything odd reads +0', () => {
  assert.equal(R.stillSubLineLabel(2), '+2 עדיין בטיפול');
  assert.equal(R.stillSubLineLabel(0), '+0 עדיין בטיפול');
  assert.equal(R.stillSubLineLabel(-1), '+0 עדיין בטיפול');
  assert.equal(R.stillSubLineLabel('<b>'), '+0 עדיין בטיפול');
});

/* Parse our CSV (quoted cells, "" escapes, BOM, CRLF). */
function parseCsv(text) {
  assert.equal(text.charCodeAt(0), 0xfeff, 'BOM');
  return text.slice(1).split('\r\n').filter(Boolean).map((line) => (line.match(/"((?:[^"]|"")*)"/g) || []).map((c) => c.slice(1, -1).replace(/""/g, '"')));
}

test('summary CSV: the same bucket table — rows reconcile to the cohort and the «עדיין בטיפול» card', () => {
  const r = report();
  const text = R.summaryToCsv(r);
  assert.ok(text.endsWith('\r\n'));
  const rows = parseCsv(text);
  assert.deepEqual(rows[0], [...R.SUMMARY_HEAD]);
  const body = rows.slice(1, 4);
  assert.deepEqual(body.map((x) => x[0]), R.BUCKETS.map((b) => b.label));
  body.forEach((x) => assert.equal(Number(x[1]) + Number(x[2]), Number(x[3])));
  const total = rows[4];
  assert.equal(total[0], R.SUMMARY_TOTAL_LABEL);
  assert.equal(Number(total[1]), r.dischargedCount);
  assert.equal(Number(total[2]), r.stillInTreatment.count);
  assert.equal(body.reduce((n, x) => n + Number(x[2]), 0), r.stillInTreatment.count, 'Σ sub-lines = «עדיין בטיפול»');
  assert.equal(Number(total[3]), r.cohortSize);
  assert.equal(Number(total[1]) + Number(total[2]), r.cohortSize);
  assert.deepEqual(rows[5].slice(0, 2), [R.MISSING_LABEL + ' (לא נספרו)', '1']);
  assert.match(R.summaryCsvFilename('../x', '<y>'), /^חתכי-מטופלים-סיכום-x-y\.csv$/, 'filename sanitized');
  assert.deepEqual(parseCsv(R.summaryToCsv({ ok: false })), [[...R.SUMMARY_HEAD]]);
});

/* ---------- Excel: «סיכום» + «שהות – חתך» show the sub-line numbers ---------- */

async function load(bytes) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(bytes));
  return wb;
}
const cellText = (c) => (c.value && typeof c.value === 'object' && c.value.richText ? c.value.richText.map((t) => t.text).join('') : c.value);
function grid(ws) {
  const out = [];
  ws.eachRow({ includeEmpty: true }, (row, n) => {
    const vals = [];
    for (let i = 1; i <= ws.columnCount; i++) vals.push(cellText(row.getCell(i)));
    while (vals.length && (vals[vals.length - 1] === null || vals[vals.length - 1] === undefined)) vals.pop();
    out[n - 1] = vals;
  });
  return out;
}

test('Excel «סיכום»: each bucket row is followed by its «עדיין בטיפול» sub-line; they reconcile to the cohort', async () => {
  const r = report();
  const t = R.bucketSummary(r);
  const wb = await load(X.writeXlsx(X.fullWorkbook({ retention: r, funnel: null, from: FROM, to: TO, exportedAt: new Date('2026-10-20T10:00:00Z') })));
  const g = grid(wb.getWorksheet('סיכום'));
  const at = (label) => g.findIndex((x) => x && x[0] === label);
  t.rows.forEach((b) => {
    const i = at('שוחררו · ' + b.label);
    assert.ok(i > 0, b.key);
    assert.deepEqual(g[i + 1].slice(0, 2), [X.SUB_LINE_PREFIX + b.label, b.still], 'the sub-line sits right under its bucket');
    assert.equal(g[i][1], b.discharged);
  });
  const subSum = t.rows.reduce((n, b) => n + g[at(X.SUB_LINE_PREFIX + b.label)][1], 0);
  assert.equal(subSum, g[at('עדיין בטיפול')][1], 'Σ sub-lines = «עדיין בטיפול»');
  const disSum = t.rows.reduce((n, b) => n + g[at('שוחררו · ' + b.label)][1], 0);
  assert.equal(disSum + g[at('עדיין בטיפול')][1], g[at('נכנסו בתקופה (הקבוצה)')][1], 'discharged + still = the cohort');
  assert.equal(g[at(X.RECONCILE_LABEL)][1], r.cohortSize);
});

test('Excel «שהות – חתך»: the bucket card table (discharged / still / total) equals the screen', async () => {
  const r = report();
  const t = R.bucketSummary(r);
  const wb = await load(X.writeXlsx(X.sectionWorkbook('retention', { retention: r, from: FROM, to: TO })));
  const g = grid(wb.getWorksheet('שהות – חתך'));
  const h = g.findIndex((x) => x && x[0] === R.SUMMARY_HEAD[0]);
  assert.deepEqual(g[h], [...R.SUMMARY_HEAD]);
  assert.deepEqual(g.slice(h + 1, h + 4), t.rows.map((b) => [b.label, b.discharged, b.still, b.total]));
  assert.deepEqual(g[h + 4], [R.SUMMARY_TOTAL_LABEL, r.dischargedCount, r.stillInTreatment.count, r.cohortSize]);
  // the older per-bucket rows are kept and agree
  t.rows.forEach((b) => assert.equal(g.find((x) => x && x[0] === 'עדיין בטיפול · ' + b.label)[1], b.still));
  // the counts are numbers, not text, and the "+" sub-line text is never a formula cell
  const cell = wb.getWorksheet('שהות – חתך').getRow(h + 2).getCell(3);
  assert.equal(typeof cell.value, 'number');
});

/* ---------- the screen model (REAL app.js in a vm) ---------- */

function page() {
  const pg = loadPage({});
  pg.sandbox.PatientRetention = R;
  pg.sandbox.LeadsFunnel = LF;
  pg.sandbox.ReportXlsx = X;
  const downloads = [];
  pg.sandbox.Blob = class { constructor(parts, o) { this.parts = parts; this.type = o && o.type; } };
  pg.sandbox.URL = { createObjectURL: (b) => { downloads.push({ blob: b }); return 'blob:x'; }, revokeObjectURL() {} };
  pg.sandbox.document.createElement = () => ({ click() { downloads[downloads.length - 1].name = this.download; }, remove() {} });
  pg.sandbox.document.body = { appendChild() {} };
  pg.set({ patients: PATIENTS, dischargedPatients: DISCHARGED, leads: [], irrelevantLeads: [] });
  return { pg, downloads };
}
const UI = (over) => Object.assign({ from: FROM, to: TO, threshold: '', completionThreshold: '', sel: null }, over || {});
function html(pg, ui) {
  pg.sandbox.__ui = UI(ui);
  pg.sandbox.__rep = pg.run(`patientRetentionReport(state, globalThis.__ui, '${TODAY}')`);
  pg.sandbox.__comp = pg.run(`patientCompletionReport(state, globalThis.__ui, '${TODAY}')`);
  return pg.run('patientRetentionHtml(globalThis.__rep, globalThis.__ui, { edit: false, completion: globalThis.__comp })');
}

test('screen: every bucket card has its discharged number + a «+N עדיין בטיפול» sub-line; they reconcile', () => {
  const { pg } = page();
  const h = html(pg);
  const r = pg.sandbox.__rep;
  const subs = [...h.matchAll(/class="pr-stat-sub[^"]*" data-sel="([^"]+)"[^>]*>([^<]+)</g)].map((m) => [JSON.parse(m[1].replace(/&quot;/g, '"')), m[2]]);
  assert.deepEqual(subs.map((x) => x[0]), R.BUCKETS.map((b) => ({ kind: 'stillBucket', key: b.key })));
  assert.deepEqual(subs.map((x) => x[1]), R.BUCKETS.map((b) => '+' + r.stillInTreatment.buckets[b.key] + ' עדיין בטיפול'));
  const nums = [...h.matchAll(/<span class="pr-stat-num">(\d+)<\/span>/g)].map((m) => Number(m[1]));
  const [b1, b2, b3, still] = nums;
  assert.deepEqual([b1, b2, b3], R.BUCKETS.map((b) => r.counts[b.key]), 'the big number stays the discharged count');
  assert.equal(still, r.stillInTreatment.count);
  assert.equal(subs.reduce((n, x) => n + Number(/\+(\d+)/.exec(x[1])[1]), 0), still, 'Σ sub-lines = the «עדיין בטיפול» card');
  assert.equal(b1 + b2 + b3 + still, r.cohortSize, 'discharged + still = the cohort in the title');
  assert.ok(h.includes(`משך שהות (מתוך ${r.cohortSize} שנכנסו בתקופה)`));
  // the «עדיין בטיפול» chips stay and carry the same numbers
  R.BUCKETS.forEach((b) => assert.ok(h.includes(`${b.label}: ${r.stillInTreatment.buckets[b.key]}</button>`), b.key));
  assert.ok(h.includes('class="btn small pr-sum-csv">ייצוא CSV'));
});

test('screen: no list until a number is clicked; the list opens under its own section with phone + close + exports', () => {
  const { pg } = page();
  assert.ok(!html(pg).includes('class="pr-list"'), 'closed by default');
  const at = (h, s) => h.indexOf(s);
  const cases = [
    [{ kind: 'bucket', key: 'upTo30' }, 'המשך טיפול (מתוך'],
    [{ kind: 'stillBucket', key: 'd31to60' }, 'המשך טיפול (מתוך'],
    [{ kind: 'continuity', key: 'none' }, 'משך שהות × המשך טיפול'],
    [{ kind: 'cross', bucket: 'upTo30', key: 'none' }, 'השלמת תקופת טיפול'],
    [{ kind: 'missing' }, 'השלמת תקופת טיפול'],
  ];
  for (const [sel, before] of cases) {
    const h = html(pg, { sel });
    assert.equal((h.match(/class="pr-list"/g) || []).length, 1, sel.kind);
    assert.ok(at(h, 'class="pr-list"') < at(h, before), `${sel.kind} opens before «${before}»`);
    assert.ok(h.includes('<th>טלפון</th>'));
    assert.ok(h.includes('pr-list-close') && h.includes('class="btn small pr-xlsx-list">ייצוא לאקסל') && h.includes('class="btn small pr-csv"'));
    assert.ok(h.includes(`${R.listTitle(sel, pg.sandbox.__rep)} (`));
  }
  const comp = html(pg, { sel: { kind: 'completion', threshold: 30, key: 'reached' } });
  assert.ok(at(comp, 'class="pr-comp-cards"') < at(comp, 'class="pr-list"') && at(comp, 'class="pr-list"') < at(comp, 'class="pr-comp-threshold"'));
  // the list: name escaped, phone shown, days, continuity
  const b = html(pg, { sel: { kind: 'bucket', key: 'upTo30' } });
  assert.ok(b.includes('&lt;img src=x onerror=alert(1)&gt;') && !b.includes('<img src=x'));
  assert.ok(b.includes('<td dir="ltr">0501234567</td>'));
  assert.ok(b.includes('<td>9</td><td>לא המשיך</td>'));
  assert.ok(b.includes('aria-pressed="true"'), 'the clicked number is marked');
});

test('screen: a hostile selection / stale completion threshold closes the list; every value escaped', () => {
  const { pg } = page();
  assert.ok(!html(pg, { sel: { kind: '<x>' } }).includes('class="pr-list"'));
  assert.ok(!html(pg, { sel: { kind: 'completion', threshold: 77, key: 'reached' } }).includes('class="pr-list"'));
  const h = html(pg, { sel: { kind: 'stillBucket', key: 'upTo30' } });
  assert.ok(!/data-sel="\{"/.test(h), 'JSON in attributes is escaped');
});

/* ---------- the controls (REAL app.js in a vm) ---------- */

function fakeButton(classes, attrs) {
  const a = Object.assign({}, attrs || {});
  const cls = new Set(classes);
  return {
    textContent: 'x', disabled: false,
    get className() { return [...cls].join(' '); },
    classList: { contains: (c) => cls.has(c), add: (c) => cls.add(c), remove: (c) => cls.delete(c) },
    getAttribute: (k) => (k in a ? a[k] : null),
    setAttribute: (k, v) => { a[k] = String(v); },
    removeAttribute: (k) => { delete a[k]; },
  };
}
/* The panel element + a manual clock: timers / frames run when we say so. */
function panelPage() {
  const { pg, downloads } = page();
  const timers = [];
  pg.sandbox.setTimeout = (fn) => { timers.push(fn); return timers.length; };
  pg.sandbox.clearTimeout = () => {};
  pg.sandbox.requestAnimationFrame = (fn) => fn();
  const buttons = { '.pr-apply': fakeButton(['btn', 'small', 'pr-apply']), '.pr-comp-apply': fakeButton(['btn', 'small', 'pr-comp-apply']) };
  const panel = {
    sets: 0, _html: '',
    set innerHTML(v) { this._html = v; this.sets++; }, get innerHTML() { return this._html; },
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    addEventListener() {}, contains: () => false,
    querySelector: (s) => buttons[s] || null, querySelectorAll: () => [],
  };
  const byId = pg.sandbox.document.getElementById;
  pg.sandbox.document.getElementById = (id) => (id === 'patient-retention' ? panel : byId(id));
  pg.run(`Object.assign(patientRetentionUi(), { open: true, from: '${FROM}', to: '${TO}', sel: null })`);
  pg.sandbox.__retry = [];
  pg.run('showRetryToast = (m, r) => { globalThis.__retry.push({ m, r }); }');
  const flush = async () => { for (let i = 0; i < 10; i++) { await tick(); while (timers.length) { timers.shift()(); await tick(); } } };
  return { pg, panel, timers, flush, downloads };
}
const input = (cls, value) => ({ classList: { contains: (c) => c === cls }, value });

test('root cause: a blur-change of a threshold stores the value and does NOT re-render under the press', async () => {
  const { pg, panel, timers, flush } = panelPage();
  pg.sandbox.document.activeElement = { id: 'body' };          // the change came from a blur
  pg.run('prPointer.down = true');                             // the user is pressing another control
  pg.sandbox.__in = input('pr-threshold', ' 25 ');
  pg.run('patientRetentionInputChange(globalThis.__in)');
  assert.equal(panel.sets, 0, 'the panel is NOT replaced between mousedown and mouseup');
  assert.equal(pg.run('patientRetentionUi().threshold'), '25');
  assert.equal(pg.run('patientRetentionUi().dirty'), true);
  assert.equal(timers.length, 1, 'applied later');
  timers.shift()();                                            // still pressed → waits again
  assert.equal(panel.sets, 0);
  assert.equal(timers.length, 1);
  pg.run('prPointer.down = false');
  await flush();                                               // nothing else rendered it → «החל» now
  assert.equal(panel.sets, 1);
  assert.equal(pg.run('patientRetentionUi().dirty'), false);
  assert.ok(panel.innerHTML.includes('לתקופה מסוימת — 25 ימים'));
});

test('a blur-change followed by the pressed control: the click renders once with the typed value; the deferred apply is a no-op', async () => {
  const { pg, panel, flush } = panelPage();
  pg.sandbox.document.activeElement = { id: 'body' };
  pg.sandbox.__in = input('pr-comp-threshold', '45');
  pg.run('patientRetentionInputChange(globalThis.__in)');
  assert.equal(panel.sets, 0);
  pg.sandbox.__card = fakeButton(['pr-stat'], { 'data-sel': JSON.stringify({ kind: 'bucket', key: 'over60' }) });
  const done = pg.run('patientRetentionAction(globalThis.__card)');
  await flush();
  assert.equal(await done, true);
  assert.equal(panel.sets, 1, 'exactly one render — the click\'s');
  assert.ok(panel.innerHTML.includes('class="pr-list"') && panel.innerHTML.includes('שוחררו · 61 יום ומעלה (1)'));
  assert.equal((panel.innerHTML.match(/class="pr-comp-card"/g) || []).length, 3, 'the typed 45 is applied');
});

test('a committed change (picker / Enter — focus still on the input) applies at once through «החל»', async () => {
  const { pg, panel, flush } = panelPage();
  pg.sandbox.__in = input('pr-from', '2026-09-10');
  pg.sandbox.document.activeElement = pg.sandbox.__in;
  pg.run('patientRetentionInputChange(globalThis.__in)');
  await flush();
  assert.equal(panel.sets, 1);
  assert.equal(pg.run('patientRetentionUi().from'), '2026-09-10');
});

test('action guard: spinner + disabled on the clicked control; a second click while busy is ignored', async () => {
  const { pg, flush, downloads } = panelPage();
  pg.sandbox.__b = fakeButton(['btn', 'small', 'pr-sum-csv']);
  const first = pg.run('patientRetentionAction(globalThis.__b)');
  const b = pg.sandbox.__b;
  assert.equal(b.getAttribute('aria-busy'), 'true');
  assert.equal(b.disabled, true);
  assert.ok(b.classList.contains('is-busy'));
  assert.equal(await pg.run('patientRetentionAction(globalThis.__b)'), false, 'double click ignored');
  pg.sandbox.__other = fakeButton(['btn', 'small', 'pr-xlsx-all']);
  assert.equal(await pg.run('patientRetentionAction(globalThis.__other)'), false, 'one action at a time');
  await flush();
  assert.equal(await first, true);
  assert.equal(downloads.length, 1);
  assert.match(downloads[0].name, /^חתכי-מטופלים-סיכום-2026-09-01-2026-09-30\.csv$/);
  assert.equal(b.getAttribute('aria-busy'), null);
  assert.equal(b.disabled, false);
});

test('a failed export / list shows a Hebrew error toast with retry; the control is handed back', async () => {
  const { pg, flush } = panelPage();
  pg.sandbox.ReportXlsx = undefined;
  pg.sandbox.__b = fakeButton(['btn', 'small', 'pr-xlsx'], { 'data-section': 'retention' });
  const p = pg.run('patientRetentionAction(globalThis.__b)');
  await flush();
  assert.equal(await p, false);
  assert.deepEqual(pg.sandbox.__retry.map((x) => x.m), ['הייצוא לאקסל נכשל']);
  assert.equal(typeof pg.sandbox.__retry[0].r, 'function');
  assert.equal(pg.sandbox.__b.disabled, false);
  assert.equal(pg.run('patientRetentionUi().busy'), false);
  pg.run(`Object.assign(patientRetentionUi(), { from: 'bad' })`);
  pg.sandbox.__s = fakeButton(['btn', 'small', 'pr-sum-csv']);
  const q = pg.run('patientRetentionAction(globalThis.__s)');
  await flush();
  assert.equal(await q, false);
  assert.equal(pg.sandbox.__retry[1].m, 'ייצוא ה־CSV נכשל');
});

test('a hostile data-sel never runs an action', async () => {
  const { pg, panel } = panelPage();
  pg.sandbox.__b = fakeButton(['pr-stat'], { 'data-sel': '{"kind":"<script>"}' });
  assert.equal(await pg.run('patientRetentionAction(globalThis.__b)'), false);
  pg.sandbox.__c = fakeButton(['pr-stat'], { 'data-sel': 'not json' });
  assert.equal(await pg.run('patientRetentionAction(globalThis.__c)'), false);
  assert.equal(panel.sets, 0);
});

test('showRetryToast writes text only and wires «נסו שוב»', () => {
  const pg = loadPage({});
  const msg = { textContent: '' };
  const retry = { onclick: null };
  const close = { onclick: null };
  const cls = new Set(['hidden']);
  const toast = { querySelector: (s) => ({ '.retry-toast-msg': msg, '.retry-toast-retry': retry, '.retry-toast-close': close })[s], classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c) } };
  const byId = pg.sandbox.document.getElementById;
  pg.sandbox.document.getElementById = (id) => (id === 'retry-toast' ? toast : byId(id));
  pg.sandbox.__ran = 0;
  pg.run('showRetryToast("<b>נכשל</b>", () => { globalThis.__ran++; })');
  assert.equal(msg.textContent, '<b>נכשל</b>', 'textContent — never HTML');
  assert.equal(cls.has('hidden'), false);
  retry.onclick();
  assert.equal(pg.sandbox.__ran, 1);
  assert.equal(cls.has('hidden'), true);
});

/* ---------- wiring ---------- */

test('wiring: delegated listener bound once; inputs never re-render from `change` directly; toast markup; CSS 44px; no Code.gs change; SW v81', () => {
  const APP = read('public', 'app.js');
  const block = APP.slice(APP.indexOf('function renderPatientRetention('), APP.indexOf('/* A Hebrew error toast'));
  assert.doesNotMatch(block, /\.onchange\s*=|\.onclick\s*=/, 'no per-render handlers');
  assert.match(block, /bindPatientRetentionPanel\(el\);/);
  assert.match(APP, /if \(!el \|\| el\._prBound \|\| typeof el\.addEventListener !== 'function'\) return;/);
  const HTML = read('public', 'index.html');
  assert.match(HTML, /<div id="retry-toast" class="retry-toast hidden" role="alert">/);
  assert.ok(HTML.includes('class="btn small retry-toast-retry">נסו שוב</button>'));
  const CSS = read('public', 'style.css');
  assert.match(CSS, /\.patient-retention button, \.patient-retention input, \.patient-retention select \{ min-height: 44px; \}/);
  assert.match(CSS, /\.retry-toast \.btn \{ min-height: 44px; min-width: 44px;/);
  assert.equal(read('apps-script', 'Code.gs').includes('stillSubLine'), false, 'no Code.gs change');
  const SW = read('public', 'sw.js');
  assert.equal(/var CACHE_VERSION = 'v(\d+)';/.exec(SW)[1], '81');
});
