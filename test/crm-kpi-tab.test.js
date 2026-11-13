'use strict';

/* «KPI» tab, «תפוסה היום», «בקרת עבודה» position, «חריגים לבדיקה» in «גבייה» and the
 * stricter required fields (CHANGELOG-crm-kpi-tab.md). Pure core of public/crm/crm.js;
 * break-even parity against the classic app.js model. Synthetic names. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const core = require('../public/crm/crm.js');

const ROOT = path.join(__dirname, '..');
const CRM_SRC = fs.readFileSync(path.join(ROOT, 'public', 'crm', 'crm.js'), 'utf8');
const CRM_HTML = fs.readFileSync(path.join(ROOT, 'public', 'crm', 'crm.html'), 'utf8');
const TODAY = '2026-11-05';

/* ---------- shell ---------- */

test('areas: «KPI» for finance and ops (not the controller); «בקרת עבודה» sits next to «היום שלי»', () => {
  assert.ok(core.areasFor({ view: 'full', finance: true }).includes('kpi'));
  assert.ok(core.areasFor({ view: 'ops', ops: true, finance: false }).includes('kpi'));
  assert.deepEqual(core.areasFor({ view: 'controller' }), ['today', 'billing', 'control']);
  assert.deepEqual(core.NAV_GROUPS[0], { label: '', items: ['today', 'control'] });
  assert.deepEqual(core.NAV_GROUPS[core.NAV_GROUPS.length - 1], { label: 'דוחות והגדרות', items: ['kpi', 'monthly'] });   // + «היסטוריה חודשית» (CHANGELOG-crm-month-view.md)
  assert.equal(core.AREAS.filter((a) => a.id === 'kpi')[0].label, 'KPI');
  assert.equal(core.AREAS.filter((a) => a.id === 'control')[0].label, 'בקרת עבודה');
  assert.match(CRM_SRC, /kpi: renderKpi/);
  assert.match(CRM_SRC, /id="crm-control-about"/, '«בקרת עבודה» explains itself');
  assert.match(CRM_HTML, /<script src="patient-retention\.js\?v=__BUILD__"><\/script>/, 'the length-of-stay rules load in the CRM');
});

test('«תפוסה היום»: the overall percentage over open houses', () => {
  const pts = [];
  for (let i = 0; i < 10; i++) pts.push({ id: 'r' + i, houseId: 'ramot', status: 'active' });
  pts.push({ id: 'x', houseId: 'ramot', status: 'released' });
  const o = core.occupancyToday(pts);
  assert.equal(o.totalIn, 10);
  assert.equal(o.totalCap, 73, 'five open houses (sde closed and empty)');
  assert.equal(o.pct, Math.round(1000 / 73));
  assert.match(CRM_SRC, /<span class="l">תפוסה היום<\/span>/);
  assert.doesNotMatch(CRM_SRC, /\['בטיפול היום', o\.totalIn\]/, 'the old card is replaced');
});

test('kpiPeriod: presets around today, inclusive', () => {
  assert.deepEqual(core.kpiPeriod('this_month', TODAY), { from: '2026-11-01', to: TODAY });
  assert.deepEqual(core.kpiPeriod('last_month', TODAY), { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(core.kpiPeriod('last_3_months', TODAY), { from: '2026-09-01', to: TODAY });
  assert.deepEqual(core.kpiPeriod('this_year', TODAY), { from: '2026-01-01', to: TODAY });
  assert.deepEqual(core.kpiPeriod('last_month', '2026-01-15'), { from: '2025-12-01', to: '2025-12-31' });
  assert.equal(core.kpiPeriod('bogus', TODAY), null);
  assert.equal(core.kpiPeriod('this_month', 'x'), null);
});

/* ---------- lead conversion + manager close rate ---------- */

const DATA = {
  ok: true,
  leads: [
    { id: 'L-open', name: 'א פתוח', house: 'רמות השבים', stage: 'new', created: '2026-10-02' },
    { id: 'L-in', name: 'ב נכנס', house: 'רמות השבים', stage: 'paid', created: '2026-10-03', visitDate: '2026-10-05', meetingWith: 'אורן' },
    { id: 'L-amb', name: 'ג אמבו', house: '', stage: 'visit', created: '2026-10-04', visitDate: '2026-10-06', meetingWith: 'אמבולטורי', meetingOutcome: 'entered' },
    { id: 'L-sent', name: 'ד נשלח', house: 'רעננה אשר', stage: 'visit', created: '2026-10-04', visitDate: '2026-10-07', meetingWith: 'שחר' },
    { id: 'L-visit-open', name: 'ה ביקור', house: 'רעננה אשר', stage: 'visit', created: '2026-10-05', visitDate: '2026-10-08', meetingWith: 'שחר' },
    { id: 'L-future', name: 'ו עתידי', house: 'רעננה אשר', stage: 'visit', created: '2026-10-05', visitDate: '2026-12-01', meetingWith: 'שחר' },
    { id: 'dl-p9', name: 'ז ישיר', house: 'רמות השבים', stage: 'admitted', source: 'direct_approach', created: '2026-10-06' },
    { id: 'L-phone', name: 'ח טלפון', source: 'direct_admin', stage: 'admitted', created: '2026-10-06' },
    { id: 'L-old', name: 'ט ישן', house: 'רמות השבים', stage: 'new', created: '2026-01-01' },
  ],
  irrelevantLeads: [
    { id: 'L-nr', name: 'י לא רלוונטי', house: 'רמות השבים', stage: 'irrelevant', disposition: 'not_relevant', created: '2026-10-07', visitDate: '2026-10-09', meetingWith: 'אורן' },
    { id: 'L-legacy', name: 'כ ישן', house: 'רמות השבים', stage: 'irrelevant', not_relevant_reason: 'stopped_new', created: '2026-10-08' },
    { id: 'L-out', name: 'ל חוץ', house: 'רמות השבים', stage: 'irrelevant', disposition: 'released_outpatient', created: '2026-10-08', visitDate: '2026-10-10', meetingWith: 'אורן' },
    { id: 'L-in', name: 'ב כפול', stage: 'irrelevant', created: '2026-10-03' },
  ],
  patients: { ramot: [{ id: 'p1', name: 'ב נכנס', date: '2026-10-10', status: 'active', fromLead: 'L-in', pay: 36000 }, { id: 'p9', name: 'ז ישיר', date: '2026-10-06', status: 'active', fromLead: 'dl-p9', pay: 36000 }] },
  dischargedPatients: [],
  outpatientSentLeadIds: ['L-sent'],
};

test('leadFates: every real lead once (board wins over a stale closed copy), phone records out', () => {
  const c = core.compute(DATA, TODAY);
  const f = {};
  core.leadFates(DATA, c).forEach((l) => { f[l.id] = l.fate; });
  assert.equal(f['L-phone'], undefined, 'direct_admin is a phone record, never a lead');
  assert.equal(f['L-in'], 'inpatient');
  assert.equal(f['L-amb'], 'outpatient', 'an «אמבולטורי» meeting with outcome «נכנסים לטיפול»');
  assert.equal(f['L-sent'], 'outpatient', 'handed to Outpatient (AuditLog)');
  assert.equal(f['L-out'], 'outpatient', 'closed «משוחרר לטיפול חוץ»');
  assert.equal(f['L-nr'], 'notRelevant');
  assert.equal(f['L-legacy'], 'otherClosed', 'legacy reason stopped_new → stopped_early');
  assert.equal(f['L-open'], 'open');
  assert.equal(f['dl-p9'], 'inpatient');
  assert.equal(core.closedDisposition({ not_relevant_reason: 'never_relevant' }), 'not_relevant');
  assert.equal(core.closedDisposition({}), 'not_relevant');
});

test('leadConversion: leads opened in the period → inpatient / outpatient; direct adds kept out of the base', () => {
  const c = core.compute(DATA, TODAY);
  const r = core.leadConversion(DATA, c, '2026-10-01', '2026-10-31');
  assert.equal(r.total, 9, 'L-old outside; dl-p9 direct; L-phone not a lead; the stale closed copy of L-in counts once');
  assert.deepEqual(r.counts, { inpatient: 1, outpatient: 3, open: 3, notRelevant: 1, otherClosed: 1 });
  assert.equal(r.converted, 4);
  assert.equal(r.pct, 44.4);
  assert.equal(r.direct, 1);
  const ramot = r.houses.filter((h) => h.house === 'רמות השבים')[0];
  assert.deepEqual([ramot.total, ramot.inpatient, ramot.outpatient], [5, 1, 1]);
  assert.equal(core.leadConversion(DATA, c, '2026-12-01', '2026-12-31').pct, null, 'no leads → no percentage');
});

test('managerCloseRates: meetings HELD in the period, by «נפגש/ת עם»; closed = became a patient', () => {
  const c = core.compute(DATA, TODAY);
  const r = core.managerCloseRates(DATA, c, '2026-10-01', '2026-10-31', TODAY);
  const by = {};
  r.rows.forEach((x) => { by[x.manager] = x; });
  assert.deepEqual([by['אורן'].meetings, by['אורן'].entered, by['אורן'].lost, by['אורן'].open], [3, 2, 1, 0]);
  assert.equal(by['אורן'].closePct, 66.7);
  assert.equal(by['אורן'].lostPct, 33.3);
  assert.deepEqual([by['שחר'].meetings, by['שחר'].entered, by['שחר'].open], [2, 1, 1], 'the future meeting is not counted');
  assert.equal(by['אמבולטורי'], undefined, '«אמבולטורי» is a service, not a manager\'s name');
  assert.equal(r.skipped, 1);
  assert.equal(r.total.meetings, 5);
  assert.equal(r.total.entered, 3);
  assert.equal(r.rows[r.rows.length - 1].manager, 'שחר', 'sorted by close rate');
});

/* ---------- break-even: parity with the classic tab ---------- */

function loadClassic() {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const epilogue = '\nglobalThis.__t = { setPatients(a) { state.patients = a; }, setBreakeven(b) { state.breakeven = b; }, computeHouseMetrics, computeNetworkMetrics, HOUSES, BREAKEVEN_DEFAULTS };';
  const noop = () => {};
  const sb = { console: { log: noop, warn: noop, error: noop, info: noop }, location: { origin: 'http://t', href: 'http://t/' },
    document: { addEventListener: noop, getElementById: () => null }, localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    URLSearchParams, Math, Date, JSON, Number, String, Array, Object };
  sb.window = sb; sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(src + epilogue, sb);
  return sb.__t;
}

test('break-even: the CRM model equals the classic computeHouseMetrics / computeNetworkMetrics', () => {
  const app = loadClassic();
  assert.deepEqual(JSON.parse(JSON.stringify(core.BREAKEVEN_DEFAULTS)), JSON.parse(JSON.stringify(app.BREAKEVEN_DEFAULTS)), 'same default expenses');
  const pts = [
    { houseId: 'ramot', pay: 36000, status: 'active' }, { houseId: 'ramot', pay: 30000, status: 'trial' }, { houseId: 'ramot', pay: 0, status: 'active' },
    { houseId: 'asher', pay: 35000, status: 'active' }, { houseId: 'asher', pay: 99999, status: 'released' }, { houseId: 'rehab', pay: 21000, status: 'wait' },
  ];
  const cfg = core.breakevenConfig(null);
  app.setPatients(pts);
  app.setBreakeven(JSON.parse(JSON.stringify(app.BREAKEVEN_DEFAULTS)));
  const crm = core.breakevenReport(pts, cfg);
  const near = (a, b, m) => assert.ok(Math.abs(a - b) < 1e-6, m + ': ' + a + ' ≈ ' + b);
  ['arfoni', 'rehab', 'asher', 'ramot'].forEach((id) => {
    const h = app.HOUSES.filter((x) => x.id === id)[0];
    const a = app.computeHouseMetrics(h);
    const b = crm.houses.filter((x) => x.id === id)[0];
    ['breakevenPoint', 'currentPatients', 'capacity', 'totalExpenses'].forEach((k) => assert.equal(b[k], a[k], id + ' ' + k));
    ['price', 'currentRevenue', 'currentPL', 'maxPL'].forEach((k) => near(b[k], a[k], id + ' ' + k));
    assert.equal(b.marginPct === null, a.marginPct === null, id + ' margin null');
    if (a.marginPct !== null) near(b.marginPct, a.marginPct, id + ' margin');
  });
  const actives = app.HOUSES.filter((h) => app.BREAKEVEN_DEFAULTS.houses[h.id] && app.BREAKEVEN_DEFAULTS.houses[h.id].active).map((h) => app.computeHouseMetrics(h));
  const net = app.computeNetworkMetrics(actives);
  near(crm.network.housesPL, net.housesPL, 'housesPL');
  near(crm.network.networkPL, net.networkPL, 'networkPL');
  assert.equal(crm.network.networkBreakeven, net.networkBreakeven);
  assert.equal(crm.network.totalPatientsCurrent, net.totalPatientsCurrent);
});

test('breakevenConfig: the classic browser storage wins; junk falls back to the defaults', () => {
  const stored = JSON.stringify({ hqCost: 250000, houses: { ramot: { active: true, fixed: 1, variable: 2 }, pardes: { active: true, fixed: 100, variable: 50 } } });
  const c = core.breakevenConfig(stored);
  assert.equal(c.fromStorage, true);
  assert.equal(c.hqCost, 250000);
  assert.deepEqual(c.houses.ramot, { active: true, fixed: 1, variable: 2 });
  assert.deepEqual(c.houses.pardes, { active: true, fixed: 100, variable: 50 });
  assert.deepEqual(c.houses.asher, { active: true, fixed: 170000, variable: 140000 }, 'a house missing from storage keeps its default');
  const bad = core.breakevenConfig('{nope');
  assert.equal(bad.fromStorage, false);
  assert.equal(bad.hqCost, 300000);
  assert.equal(core.BREAKEVEN_STORAGE_KEY, 'ezone-breakeven-v1', 'the classic tab\'s key — one set of figures for both screens');
  assert.match(CRM_SRC, /if \(state\.me && state\.me\.finance\) html \+= renderBreakeven\(c\)/, 'break-even is for finance sessions only');
});

/* ---------- «חריגים לבדיקה» ---------- */

function cOf(patients, discharges) { return { patients: patients, discharges: discharges || [] }; }

test('billingAnomalies: the same person in two houses at the same time is an exception (the «טל לוי» case)', () => {
  const pts = [
    { id: 'a', name: 'טל לוי', houseId: 'ramot', date: '2026-05-18', status: 'released', exitDate: '2026-08-31', pay: 36000 },
    { id: 'b', name: 'טל  לוי', houseId: 'asher', date: '2026-05-17', status: 'released', exitDate: '2026-09-13', pay: 35000 },
  ];
  const rows = core.billingAnomalies(cOf(pts), null, TODAY);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'stay_overlap');
  assert.equal(rows[0].label, 'אותו אדם בשתי שהיות חופפות');
  assert.match(rows[0].why, /רשום\/ה בשני בתים באותה תקופה/);
  assert.match(rows[0].why, /18\/05\/2026–31\/08\/2026/);
  assert.match(rows[0].why, /זוהה לפי שם מלא/);
  assert.deepEqual(rows[0].stays.map((x) => x.id).sort(), ['a', 'b']);
});

test('billingAnomalies: a return on the exit day, different people, and single names are NOT overlaps; personId links stays', () => {
  const pts = [
    { id: 'r1', name: 'דנה כהן', houseId: 'ramot', date: '2026-01-01', status: 'released', exitDate: '2026-03-01' },
    { id: 'r2', name: 'דנה כהן', houseId: 'ramot', date: '2026-03-01', status: 'active', personId: 'r1' },
    { id: 'x1', name: 'אבי', houseId: 'ramot', date: '2026-01-01', status: 'active' },
    { id: 'x2', name: 'אבי', houseId: 'asher', date: '2026-01-01', status: 'active' },
    { id: 'y1', name: 'רון לוי', houseId: 'rehab', date: '2026-01-01', status: 'active' },
  ];
  assert.deepEqual(core.billingAnomalies(cOf(pts), null, TODAY).filter((r) => r.kind === 'stay_overlap'), []);
  const linked = [
    { id: 'q1', name: 'שם אחד', houseId: 'ramot', date: '2026-01-01', status: 'released', exitDate: '2026-04-01' },
    { id: 'q2', name: 'שם שונה', houseId: 'asher', date: '2026-03-01', status: 'active', personId: 'q1' },
  ];
  const r = core.billingAnomalies(cOf(linked), null, TODAY).filter((x) => x.kind === 'stay_overlap');
  assert.equal(r.length, 1);
  assert.equal(r[0].basis, 'person');
  assert.doesNotMatch(r[0].why, /זוהה לפי שם/);
});

test('billingAnomalies: exit before entry, released without exit, debt after exit, zero price in the house', () => {
  const pts = [
    { id: 'e', name: 'א ב', houseId: 'ramot', date: '2026-05-10', status: 'released', exitDate: '2026-05-01' },
    { id: 'n', name: 'ג ד', houseId: 'ramot', date: '2026-05-10', status: 'released' },
    { id: 'd', name: 'ה ו', houseId: 'asher', date: '2026-06-01', status: 'released', exitDate: '2026-07-15' },
    { id: 'z', name: 'ז ח', houseId: 'rehab', date: '2026-10-01', status: 'active', pay: 0 },
    { id: 'zf', name: 'ט י', houseId: 'rehab', date: '2026-12-01', status: 'wait', pay: 0 },
  ];
  const discharges = [{ id: 'aud', patientId: 'n', exitDate: '', deletedAt: '', restored: '' }];
  const debt = { ok: true, byPatient: [{ patientId: 'd', cycles: [{ start: '2026-07-01', balance: 1000 }, { start: '2026-08-01', balance: 35000 }, { start: '2026-09-01', balance: 0 }] }] };
  const rows = core.billingAnomalies(cOf(pts, discharges), debt, TODAY);
  const kinds = rows.map((r) => r.kind + ':' + r.stays[0].id);
  assert.deepEqual(kinds, ['debt_after_exit:d', 'exit_before_entry:e', 'released_no_exit:n', 'zero_pay_in_house:z']);
  assert.match(rows[0].why, /1 מחזורים · ₪35,000 אחרי יציאה ב-15\/07\/2026/);
  assert.equal(rows[0].amount, 35000);
  assert.ok(CRM_SRC.includes('const anomalies = billingAnomalies(c, state.billing.debt, state.today);') && CRM_SRC.includes("else if (tab === 'anomalies') html += renderAnomalies(anomalies);"), 'listed in «גבייה», in its own section (CHANGELOG-billing-sections.md)');
});

test('billingAnomalies: the discharge audit exit date counts when the Patients row has none', () => {
  const pts = [
    { id: 'a', name: 'טל לוי', houseId: 'ramot', date: '2026-05-18', status: 'released' },
    { id: 'b', name: 'טל לוי', houseId: 'asher', date: '2026-09-01', status: 'active' },
  ];
  const disc = [{ id: 'au', patientId: 'a', exitDate: '2026-08-31' }];
  assert.deepEqual(core.billingAnomalies(cOf(pts, disc), null, TODAY), [], 'no overlap, no missing exit');
  const late = [{ id: 'au', patientId: 'a', exitDate: '2026-09-10' }];
  assert.equal(core.billingAnomalies(cOf(pts, late), null, TODAY)[0].kind, 'stay_overlap');
});

/* ---------- nothing closes with a field missing ---------- */

test('required fields: a lead needs a source and a house (or an «אמבולטורי» meeting) and complete contact / billing details', () => {
  const ok = { name: 'דנה כהן', phone: '0527654321', assignedTo: 'ורד', source: 'גוגל', house: 'רמות השבים' };
  assert.deepEqual(core.leadFormErrors(ok), {});
  assert.deepEqual(Object.keys(core.leadFormErrors(Object.assign({}, ok, { source: '' }))), ['source']);
  assert.deepEqual(Object.keys(core.leadFormErrors(Object.assign({}, ok, { house: '' }))), ['house']);
  assert.deepEqual(core.leadFormErrors(Object.assign({}, ok, { house: '', meetingWith: 'אמבולטורי' })), {});
  assert.deepEqual(Object.keys(core.leadFormErrors(Object.assign({}, ok, { contactName: 'אמא' }))), ['contactRelation']);
  assert.deepEqual(Object.keys(core.leadFormErrors(Object.assign({}, ok, { contactName: 'א', contactRelation: 'אחר' }))), ['contactRelationOther']);
  assert.deepEqual(Object.keys(core.leadFormErrors(Object.assign({}, ok, { billingMode: 'contact' }))), ['contactPhone']);
  assert.deepEqual(Object.keys(core.leadFormErrors(Object.assign({}, ok, { billingMode: 'other', billingOther: '1' }))), ['billingOther']);
});

test('required fields: closing a lead needs a status and a reason; a direct add needs a phone; a discharge needs a date', () => {
  assert.deepEqual(core.closeLeadErrors({ disposition: 'completed', note: 'סיים' }), {});
  assert.deepEqual(Object.keys(core.closeLeadErrors({ disposition: 'completed', note: ' ' })), ['note']);
  assert.deepEqual(Object.keys(core.closeLeadErrors({ disposition: 'bogus', note: 'xx' })), ['disposition']);
  assert.match(CRM_SRC, /const ce = closeLeadErrors\(/, 'the close form is validated before the write');
  const base = { name: 'רונית פרץ', houseId: 'rehab', date: '2026-10-27', pay: '1' };
  assert.deepEqual(Object.keys(core.directAddErrors(base, false)), ['phone']);
  assert.deepEqual(core.directAddErrors(Object.assign({}, base, { phone: '050-333-4444' }), false), {});
  assert.deepEqual(Object.keys(core.dischargeErrors({ disposition: 'completed', dischargeDate: '' })), ['dischargeDate']);
  assert.deepEqual(core.dischargeErrors({ disposition: 'completed', dischargeDate: '2026-11-01' }), {});
});

test('the classic-only list is documented for the decision (no silent gaps)', () => {
  assert.ok(core.CLASSIC_ONLY.length >= 8);
  assert.ok(!core.CLASSIC_ONLY.some((x) => x.id === 'credits_manual'), 'manual credits moved into the CRM (CHANGELOG-crm-manual-credits.md)');
  assert.ok(core.CLASSIC_ONLY.some((x) => x.id === 'released_edit'));
  core.CLASSIC_ONLY.forEach((x) => { assert.ok(x.label && x.where, x.id); });
});

test('KPI section headings stand out: the page is wrapped and its headings are large, bold and dark (CHANGELOG-crm-kpi-headings.md)', () => {
  const CSS = fs.readFileSync(path.join(ROOT, 'public', 'crm', 'crm.css'), 'utf8');
  assert.match(CRM_SRC, /return '<div class="kpi-page">' \+ html \+ '<\/div>';/);
  assert.match(CSS, /\.kpi-page \.group-title \{[^}]*font-size: 20px; font-weight: 800; color: var\(--text\)/);
  assert.match(CSS, /\.kpi-page \.group-title \{[^}]*border-inline-start: 5px solid var\(--primary\)/);
  assert.match(CSS, /\.kpi-page \.group-title \.na \{ font-size: 14px;/, 'the count after the heading stays secondary');
});

/* Sandra 05/11/2026: «תתקן את הטעויות … תנטרל מידע שאין לך, אם אין לנו שם של מנהל אל תכניס את זה» */
test('no data we do not have: timestamps / stage keys / damaged text / placeholders are not manager rows; damaged or blank houses are not table rows', () => {
  ['אורן', 'רנטה', 'חן', 'ד"ר כהן'].forEach((n) => assert.equal(core.managerNameOk(n), true, n));
  ['', '2026-06-16T06:55:59.528Z', 'visit', 'קיסר\uFFFD\uFFFDה', 'ממלא מקום', 'אמבולטורי', 'A1', 'ללא מנהל/ת'].forEach((n) => assert.equal(core.managerNameOk(n), false, JSON.stringify(n)));
  const data = { ok: true, irrelevantLeads: [], outpatientSentLeadIds: [], patients: {}, leads: [
    { id: 'a', name: 'א א', house: 'רמות השבים', stage: 'visit', created: '2026-10-02', visitDate: '2026-10-03', meetingWith: 'אורן' },
    { id: 'b', name: 'ב ב', house: 'קיסריה ריהא\uFFFD\uFFFD', stage: 'visit', created: '2026-10-02', visitDate: '2026-10-03', meetingWith: '2026-06-16T06:55:59.528Z' },
    { id: 'c', name: 'ג ג', house: '', stage: 'visit', created: '2026-10-02', visitDate: '2026-10-03', meetingWith: 'visit' },
    { id: 'd', name: 'ד ד', house: 'ramot', stage: 'new', created: '2026-10-02' },
  ] };
  const c = core.compute(data, TODAY);
  const m = core.managerCloseRates(data, c, '2026-10-01', '2026-10-31', TODAY);
  assert.deepEqual(m.rows.map((r) => r.manager), ['אורן']);
  assert.equal(m.skipped, 2);
  const lc = core.leadConversion(data, c, '2026-10-01', '2026-10-31');
  assert.equal(lc.total, 4, 'every lead still counts in the totals');
  assert.deepEqual(lc.houses.map((h) => h.house), ['רמות השבים'], 'only real houses are rows');
  assert.equal(lc.noHouse, 2);
  assert.match(CRM_SRC, /לידים ללא בית מזוהה נספרו בסיכום אך אינם מוצגים בטבלה/);
  assert.match(CRM_SRC, /פגישות ללא שם מנהל\/ת תקין לא נכללו/);
  const CSS = fs.readFileSync(path.join(ROOT, 'public', 'crm', 'crm.css'), 'utf8');
  assert.match(CSS, /\.kpi-page \.group-title \{[^}]*align-items: baseline/, 'the heading and its count sit on one line');
});
