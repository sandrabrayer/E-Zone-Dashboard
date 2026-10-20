/* «חתכי מטופלים» UI + required «המשך טיפול» (CHANGELOG-patient-retention-ui.md).
 * The REAL public/app.js in a vm (helpers/app-sandbox) with the REAL
 * lib/patient-retention.js and lib/leads-funnel.js as its globals.
 * All names and ids are synthetic. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadPage, tick } = require('./helpers/app-sandbox');
const R = require('../lib/patient-retention');
const LF = require('../lib/leads-funnel');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const APP = read('public', 'app.js');
const HTML = read('public', 'index.html');
const SERVER = read('server.js');
const SW = read('public', 'sw.js');
const CSS = read('public', 'style.css');

function page(answerPost) {
  const pg = loadPage({ answerPost });
  pg.sandbox.PatientRetention = R;
  pg.sandbox.LeadsFunnel = LF;
  return pg;
}
const AUDIT = (over) => Object.assign({
  id: 'aud-1', houseId: 'ramot', name: 'מטופל', date: '2026-09-01', status: 'released',
  exitDate: '2026-09-11', dischargedAt: '2026-09-11T08:00:00Z', restored: '', deletedAt: '', continuity: 'unknown',
}, over || {});

/* ---------- lib: the list behind a number ---------- */

function sample() {
  return R.computeRetention({
    from: '2026-09-01', to: '2026-09-30', today: '2026-10-20', customThreshold: 20,
    patients: [
      { id: 'p1', houseId: 'ramot', name: 'א', date: '2026-09-01', status: 'released', exitDate: '2026-09-11' },
      { id: 'p2', houseId: 'ramot', name: 'ב', date: '2026-09-02', status: 'released', exitDate: '2026-11-20' },
      { id: 'p3', houseId: 'ramot', name: 'ג', date: '2026-09-20', status: 'active' },
      { id: 'p4', houseId: 'ramot', name: 'ד', date: '', status: 'active' },
    ],
    discharged: [
      AUDIT({ id: 'a1', patientId: 'p1', name: 'א', date: '2026-09-01', exitDate: '2026-09-11', continuity: 'none' }),
      AUDIT({ id: 'a2', patientId: 'p2', name: 'ב', date: '2026-09-02', exitDate: '2026-11-20', continuity: 'unknown' }),
    ],
  });
}

test('listFor returns the SAME rows the counts came from, for every kind of number', () => {
  const rep = sample();
  assert.equal(R.listFor(rep, { kind: 'bucket', key: 'upTo30' }), rep.rows.upTo30);
  assert.equal(R.listFor(rep, { kind: 'still' }).length, rep.stillInTreatment.count);
  assert.equal(R.listFor(rep, { kind: 'stillBucket', key: 'upTo30' }).length, rep.stillInTreatment.buckets.upTo30);
  assert.equal(R.listFor(rep, { kind: 'custom', key: 'atOrBelow' }).length, rep.custom.atOrBelow);
  assert.equal(R.listFor(rep, { kind: 'continuity', key: 'none' }).length, rep.continuity.none);
  assert.equal(R.listFor(rep, { kind: 'cross', bucket: 'over60', key: 'unknown' }).length, rep.cross.over60.unknown);
  assert.equal(R.listFor(rep, { kind: 'missing' }).length, rep.missingCount);
  for (const bad of [null, {}, { kind: 'bucket', key: 'x' }, { kind: 'cross', bucket: 'upTo30' }, { kind: '__proto__' }]) {
    assert.deepEqual(R.listFor(rep, bad), []);
    assert.equal(R.validSelection(bad), false);
  }
  assert.deepEqual(R.listFor({ ok: false }, { kind: 'still' }), []);
});

test('listTitle: Hebrew headings', () => {
  const rep = sample();
  assert.equal(R.listTitle({ kind: 'bucket', key: 'over60' }, rep), 'שוחררו · 61 יום ומעלה');
  assert.equal(R.listTitle({ kind: 'still' }, rep), 'עדיין בטיפול');
  assert.equal(R.listTitle({ kind: 'custom', key: 'above' }, rep), 'שוחררו · מעל 20 ימים');
  assert.equal(R.listTitle({ kind: 'continuity', key: 'none' }, rep), 'המשך טיפול · לא המשיך');
  assert.equal(R.listTitle({ kind: 'missing' }, rep), 'נתונים חסרים');
});

/* ---------- lib: CSV ---------- */

test('csvCell is the leads-funnel rule exactly (formula guard included)', () => {
  for (const v of ['=SUM(A1)', '+1', '-2', '@x', '\tx', '\rx', 'a"b', 'רגיל', '', null, undefined, 0, 12]) {
    assert.equal(R.csvCell(v), LF.csvCell(v), JSON.stringify(v));
  }
});

test('toCsv: UTF-8 BOM, CRLF, header, formula-guarded text cells, house names', () => {
  const rep = sample();
  const evil = Object.assign({}, rep.rows.upTo30[0], { name: '=HYPERLINK("http://x")' });
  const csv = R.toCsv([evil], { houseName: () => 'רמות' });
  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.ok(csv.endsWith('\r\n'));
  const [head, line] = csv.slice(1).split('\r\n');
  assert.equal(head, R.CSV_HEAD.map(R.csvCell).join(','));
  assert.ok(line.includes('"\'=HYPERLINK(""http://x"")"'), line);
  assert.ok(line.includes('"רמות"'));
  assert.ok(line.includes('"לא המשיך"'));
  assert.equal(R.toCsv([]).slice(1).split('\r\n').filter(Boolean).length, 1, 'empty list → header only');
});

test('csvFilename keeps only safe characters', () => {
  assert.equal(R.csvFilename('2026-09-01', '2026-09-30', { kind: 'cross', bucket: 'upTo30', key: 'none' }), 'חתכי-מטופלים-2026-09-01-2026-09-30-cross-upTo30-none.csv');
  assert.equal(R.csvFilename('../x', '2026', { kind: '<b>' }), 'חתכי-מטופלים-x-2026-b.csv');
});

/* ---------- app.js: labels, modal ---------- */

test('app.js labels and choices equal the lib (no «לא ידוע» choice)', () => {
  const pg = page();
  assert.deepEqual({ ...pg.run('DISCHARGE_CONTINUITY_LABELS') }, { ...R.CONTINUITY_LABELS });
  assert.deepEqual([...pg.run('DISCHARGE_CONTINUITY_CHOICES')], [...R.CONTINUITY_CHOICES]);
});

test('the שחרור modal asks for a REQUIRED «המשך טיפול» (three real values) and gates submit on it', () => {
  const fn = APP.slice(APP.indexOf('function showCloseLeadModal('), APP.indexOf('function showToast('));
  assert.match(fn, /continuityField \? `/);
  assert.match(fn, /<legend>המשך טיפול \*<\/legend>/);
  assert.match(fn, /DISCHARGE_CONTINUITY_CHOICES\.map\(key =>/);
  assert.match(fn, /name="continuity" value="\$\{escapeHtml\(key\)\}" required/);
  assert.match(fn, /if \(!continuityOk\(\)\) submitBtn\.disabled = true;/);
  assert.match(fn, /if \(!continuityOk\(\)\) return;/);
  assert.match(fn, /if \(continuityField\) payload\.continuity = /);
  const dp = APP.slice(APP.indexOf('function dischargePatient(p)'), APP.indexOf('async function runDischarge('));
  assert.match(dp, /continuityField: true,/);
  // closeLead (leads) does not get it.
  const cl = APP.slice(APP.indexOf('function closeLead(lead, opts)'), APP.indexOf('async function restoreIrrelevantLead('));
  assert.doesNotMatch(cl, /continuityField/);
});

test('the discharge sends the picked continuity in the audit row', async () => {
  const pg = page();
  pg.run(`showCloseLeadModal = (o) => { globalThis.__confirm = o.onConfirm; }`);
  pg.set({ patients: [pg.run('normalizePatient')({ id: 'pt-1', houseId: 'ramot', name: 'דנה', date: '2026-09-01', status: 'active' })], dischargedPatients: [], leads: [] });
  pg.run('dischargePatient(state.patients[0])');
  await pg.run(`globalThis.__confirm({ disposition: 'completed', note: '', dischargeDate: '2026-10-01', continuity: 'continued_other' })`).catch(() => {});
  const sent = pg.posts.find((b) => b.action === 'dischargePatient');
  assert.ok(sent);
  assert.equal(sent.patient.continuity, 'continued_other');
});

/* ---------- app.js: the view ---------- */

test('patientRetentionHtml: cards with % of the cohort, continuity % of the discharged, the cohort rule, the cross table', () => {
  const pg = page();
  pg.sandbox.__rep = sample();
  const html = pg.run(`patientRetentionHtml(globalThis.__rep, { from: '2026-09-01', to: '2026-09-30', threshold: '20', sel: { kind: 'bucket', key: 'upTo30' } }, { edit: false })`);
  assert.ok(html.includes('לפי תאריך כניסה בתקופה'));
  assert.ok(html.includes('עד 30 יום') && html.includes('31–60 יום') && html.includes('61 יום ומעלה') && html.includes('עדיין בטיפול'));
  // cohort = 3 placed stays; 1 of 3 = 33.3%.
  assert.ok(html.includes('33.3%'));
  // continuity: 1 of 2 discharged = 50%.
  assert.ok(html.includes('50%'));
  for (const k of R.CONTINUITY_KEYS) assert.ok(html.includes(R.CONTINUITY_LABELS[k]), k);
  assert.ok(html.includes('class="pr-cross"'));
  assert.ok(html.includes('נתונים חסרים: 1'));
  assert.ok(html.includes('מעל 20 ימים'));
  assert.ok(html.includes('ייצוא CSV'));
});

test('patientRetentionHtml escapes every value (names, house, selection JSON)', () => {
  const pg = page();
  const rep = R.computeRetention({
    from: '2026-09-01', to: '2026-09-30', today: '2026-10-20',
    patients: [{ id: 'x', houseId: '<img src=x onerror=alert(1)>', name: '<script>alert(1)</script>', date: '2026-09-05', status: 'released', exitDate: '2026-09-06' }],
    discharged: [],
  });
  pg.sandbox.__rep = rep;
  const html = pg.run(`patientRetentionHtml(globalThis.__rep, { from: '2026-09-01', to: '2026-09-30', threshold: '', sel: { kind: 'bucket', key: 'upTo30' } }, { edit: true })`);
  assert.ok(!html.includes('<script>alert'), 'name escaped');
  assert.ok(!html.includes('<img src=x'), 'house escaped');
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!/data-sel="\{"/.test(html), 'JSON in attributes is escaped');
});

test('a legacy row shows «לא ידוע — עדכון» only in edit mode and only with an audit id', () => {
  const pg = page();
  pg.sandbox.__rep = sample();
  const sel = "{ kind: 'continuity', key: 'unknown' }";
  const edit = pg.run(`patientRetentionHtml(globalThis.__rep, { from: '2026-09-01', to: '2026-09-30', threshold: '', sel: ${sel} }, { edit: true })`);
  assert.ok(edit.includes('class="pr-cont-set" data-id="a2"'));
  assert.ok(edit.includes('לא ידוע — עדכון'));
  const options = edit.slice(edit.indexOf('class="pr-cont-set"'), edit.indexOf('</select>'));
  assert.ok(!options.includes('value="unknown"'), '«לא ידוע» is not a choice');
  const view = pg.run(`patientRetentionHtml(globalThis.__rep, { from: '2026-09-01', to: '2026-09-30', threshold: '', sel: ${sel} }, { edit: false })`);
  assert.ok(!view.includes('pr-cont-set'));
});

test('a bad range or a missing module renders a message, never a crash', () => {
  const pg = page();
  pg.sandbox.__rep = { ok: false, error: 'bad_range' };
  assert.ok(pg.run(`patientRetentionHtml(globalThis.__rep, {}, {})`).includes('יש לבחור טווח תאריכים תקין'));
  pg.sandbox.PatientRetention = undefined;
  assert.deepEqual({ ...pg.run(`patientRetentionReport(state, { from: '2026-09-01', to: '2026-09-30' })`) }, { ok: false, error: 'no_module' });
  assert.ok(pg.run(`patientRetentionHtml({ ok: false, error: 'no_module' }, {}, {})`).includes('הדוח לא נטען'));
});

test('the report reads state.patients + state.dischargedPatients with the UI period and threshold', () => {
  const pg = page();
  pg.set({
    patients: [{ id: 'p', houseId: 'ramot', name: 'נ', date: '2026-09-03', status: 'released', exitDate: '2026-09-13' }],
    dischargedPatients: [AUDIT({ id: 'z', patientId: 'p', name: 'נ', date: '2026-09-03', exitDate: '2026-09-13', continuity: 'none' })],
  });
  const rep = pg.run(`patientRetentionReport(state, { from: '2026-09-01', to: '2026-09-30', threshold: '5' }, '2026-10-20')`);
  assert.equal(rep.ok, true);
  assert.equal(rep.counts.upTo30, 1);
  assert.equal(rep.continuity.none, 1);
  assert.equal(rep.custom.above, 1);
});

test('the default period is the leads funnel\'s «3 חודשים אחרונים» preset', () => {
  const pg = page();
  const ui = pg.run('patientRetentionUi()');
  const r = LF.presetRange('last_3_months', pg.run('debtAgingTodayIso()'));
  assert.equal(ui.from, r.from);
  assert.equal(ui.to, r.to);
  assert.equal(ui.open, false);
});

/* ---------- app.js: the inline update (optimistic + rollback) ---------- */

test('updateDischargeContinuity: optimistic, posts {id, continuity}, keeps it on success', async () => {
  const pg = page((b) => (b.action === 'setDischargeContinuity' ? { ok: true, id: b.id, continuity: b.continuity } : { ok: true }));
  pg.set({ dischargedPatients: [AUDIT()] });
  const p = pg.run(`updateDischargeContinuity('aud-1', 'continued_outpatient')`);
  assert.equal(pg.run('state.dischargedPatients[0].continuity'), 'continued_outpatient', 'optimistic');
  await p;
  assert.deepEqual(pg.posts.map((b) => [b.action, b.id, b.continuity]), [['setDischargeContinuity', 'aud-1', 'continued_outpatient']]);
  assert.equal(pg.run('state.dischargedPatients[0].continuity'), 'continued_outpatient');
  assert.deepEqual([...pg.errors], []);
});

test('updateDischargeContinuity: a refusal rolls back and shows the error', async () => {
  const pg = page((b) => (b.action === 'setDischargeContinuity' ? { ok: false, error: 'not_found', message: 'שורת השחרור לא נמצאה' } : { ok: true }));
  pg.set({ dischargedPatients: [AUDIT()] });
  await pg.run(`updateDischargeContinuity('aud-1', 'none')`);
  assert.equal(pg.run('state.dischargedPatients[0].continuity'), 'unknown', 'rolled back');
  assert.ok(pg.errors.some((m) => m.includes('עדכון המשך הטיפול נכשל')));
});

test('updateDischargeContinuity: an answer that does not name the row is unproven → rollback', async () => {
  const pg = page(() => ({ ok: true, id: 'other' }));
  pg.set({ dischargedPatients: [AUDIT()] });
  await pg.run(`updateDischargeContinuity('aud-1', 'none')`);
  assert.equal(pg.run('state.dischargedPatients[0].continuity'), 'unknown');
});

test('updateDischargeContinuity: «unknown» / junk / view mode never posts', async () => {
  const pg = page();
  pg.set({ dischargedPatients: [AUDIT()] });
  await pg.run(`updateDischargeContinuity('aud-1', 'unknown')`);
  await pg.run(`updateDischargeContinuity('aud-1', '=x')`);
  pg.set({ mode: 'view' });
  await pg.run(`updateDischargeContinuity('aud-1', 'none')`);
  await tick();
  assert.equal(pg.posts.length, 0);
  assert.equal(pg.run('state.dischargedPatients[0].continuity'), 'unknown');
});

test('the «מטופלים משוחררים» row control: placeholder + the three choices, text only, busy marker', () => {
  const pg = page();
  const cell = pg.run(`continuityUpdateCell({ id: 'aud-1' })`);
  const sel = cell.children[1];
  assert.equal(sel.className, 'pr-cont-set');
  assert.deepEqual(sel.children.map((o) => [o.value, o.textContent]), [
    ['', 'לא ידוע — עדכון'],
    ['continued_outpatient', 'המשיך באמבולטורי (E-ZONE)'],
    ['continued_other', 'המשיך במסגרת טיפולית אחרת'],
    ['none', 'לא המשיך'],
  ]);
  assert.match(APP, /withFieldSaving\(sel, 'save', \(\) => updateDischargeContinuity\(d\.id, sel\.value\)\)/);
  const rd = APP.slice(APP.indexOf('function renderDischargedPatients()'), APP.indexOf('/* ===== «מחק כפילות»'));
  assert.match(rd, /const contEditable = contKey === 'unknown' && state\.mode === 'edit';/);
  assert.match(rd, /if \(contEditable\) row\.appendChild\(continuityUpdateCell\(p\)\);/);
});

/* ---------- wiring ---------- */

test('wiring: the sub-view lives in «מטופלים משוחררים»; the lib loads before app.js; static asset only', () => {
  const screen = HTML.slice(HTML.indexOf('id="screen-discharged-patients"'), HTML.indexOf('<!-- ====== BILLING'));
  assert.ok(screen.includes('id="patient-retention-btn"') && screen.includes('חתכי מטופלים'));
  assert.ok(screen.includes('id="patient-retention" class="card patient-retention hidden"'));
  assert.ok(HTML.indexOf('patient-retention.js?v=__BUILD__') < HTML.indexOf('app.js?v=__BUILD__'));
  assert.match(SERVER, /'\/patient-retention\.js': \{ file: path\.join\(__dirname, 'lib', 'patient-retention\.js'\)/);
  assert.match(SERVER, /app\.get\('\/patient-retention\.js', sendLibAsset\('\/patient-retention\.js'\)\);/);
  assert.match(SW, /var BUNDLE_PATHS = \[[^\]]*'\/patient-retention\.js'[^\]]*\]/);
  assert.match(APP, /renderDischargedPatients\(\);\n  renderPatientRetention\(\);/);
});

test('CSS: 16px text, 44px targets', () => {
  const block = CSS.slice(CSS.indexOf('.patient-retention { margin-bottom'));
  assert.match(block, /\.pr-stat \{[^}]*min-height: 44px/);
  assert.match(block, /\.pr-cell \{[^}]*min-height: 44px/);
  assert.match(block, /\.pr-cont-set \{ min-height: 44px; font-size: 16px; \}/);
  assert.match(block, /\.continuity-fieldset \.reason-radio \{ min-height: 44px; \}/);
  assert.doesNotMatch(block, /font-size: 1[0-5](\.\d+)?px/);
});

test('SW CACHE_VERSION is v78 or later (v17 never reused)', () => {
  const v = Number(/var CACHE_VERSION = 'v(\d+)';/.exec(SW)[1]);
  assert.ok(v >= 78, 'v' + v);
});
