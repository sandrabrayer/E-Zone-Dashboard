'use strict';

/* Meeting-flow gaps (CHANGELOG-meeting-flow-gaps.md) — real apps-script/Code.gs
 * in the shared vm sandbox, plus the server's managers whitelist:
 *
 *   Fix 1  a manager report on an already-ADMITTED lead (recent meeting) lands
 *          on its own Leads row; closed / removed leads stay lead_not_found;
 *          the picker lists admitted leads with a visit in the last 14 days.
 *   Fix 2  managersWork houseData visits: the current month looks 14 days
 *          past month end, de-duplicated by lead id, each item flagged
 *          inSelectedMonth (additive).
 *   Fix 3  the reporter list comes from the Managers tab (falls back to
 *          HOUSE_MANAGERS) and submitMeetingReport_ refuses any other name. */

const { test } = require('node:test');
const assert = require('node:assert');
const { richSheet, loadGs } = require('./helpers/gs-sandbox');

const arr = (x) => JSON.parse(JSON.stringify(x));
const TODAY = '2026-10-26';

function boot({ today = TODAY, leads = [], irrelevant = [], removed = [], managers = null, props = {} } = {}) {
  const g = loadGs({ props: Object.assign({ MEETING_REPORT_SECRET: 'mr-s3cret', MANAGERS_WORK_SECRET: 'mw-s3cret' }, props) });
  g.sandbox.Session = { getScriptTimeZone: () => 'Asia/Jerusalem' };
  g.sandbox.Utilities.formatDate = (d, tz, fmt) => {
    const x = new Date(d); const p = (n) => (n < 10 ? '0' + n : '' + n);
    if (fmt === 'HH:mm') return `${p(x.getHours())}:${p(x.getMinutes())}`;
    if (fmt === 'yyyy-MM') return `${x.getFullYear()}-${p(x.getMonth() + 1)}`;
    return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
  };
  g.run(`todayISODate_ = function () { return '${today}'; }`);
  const put = (name, colsExpr, rows) => {
    const cols = Array.from(g.run(colsExpr));
    const sh = richSheet(name, cols);
    rows.forEach((r) => sh.grid.push(cols.map((c) => r[c] ?? '')));
    g.sandbox.__sheets[name] = sh;
  };
  put('Leads', 'LEAD_COLUMNS', leads);
  if (irrelevant.length) put('לידים לא רלוונטיים', 'IRRELEVANT_LEAD_COLUMNS', irrelevant);
  if (removed.length) put('לידים שהוסרו', 'REMOVED_LEAD_COLUMNS', removed);
  if (managers) {
    const sh = richSheet('Managers', ['house', 'manager_name', 'start_date', 'end_date']);
    managers.forEach((m) => sh.grid.push([m.house, m.manager_name, m.start_date || '', m.end_date || '']));
    g.sandbox.__sheets.Managers = sh;
  }
  const leadsCols = Array.from(g.run('LEAD_COLUMNS'));
  const leadCell = (id, col) => {
    const row = g.sandbox.__sheets.Leads.grid.find((r) => r[leadsCols.indexOf('id')] === id);
    return row ? row[leadsCols.indexOf(col)] : undefined;
  };
  const submit = (r) => arr(g.run('submitMeetingReport_')(r));
  const reportLeads = () => arr(g.post({ action: 'meetingReportLeads', secret: 'mr-s3cret' }));
  return { g, submit, reportLeads, leadCell };
}

const MANAGERS_TAB = [
  { house: 'efroni', manager_name: 'חנן' },
  { house: 'rehab', manager_name: 'רנטה' },
  { house: 'raanana', manager_name: 'שחר', start_date: '2026-10-01' },
  { house: 'pardes', manager_name: 'חן' },
  { house: 'ramot', manager_name: 'אורן' },
  { house: 'raanana', manager_name: 'עידו', end_date: '2026-09-30' },   // former
  { house: 'ramot', manager_name: 'עתידי', start_date: '2026-11-15' },  // not yet
];

const LEADS = [
  { id: 'OPEN', name: 'פתוח', house: 'ramot', stage: 'visit', visitDate: '2026-10-20' },
  { id: 'ADM_RECENT', name: 'נקלט לאחרונה', house: 'ramot', stage: 'admitted', visitDate: '2026-10-19', phone: '0501234567', note: 'פנימי' },
  { id: 'ADM_EDGE', name: 'בדיוק 14', house: 'arfoni', stage: 'admitted', visitDate: '2026-10-12' },
  { id: 'ADM_OLD', name: 'נקלט מזמן', house: 'ramot', stage: 'admitted', visitDate: '2026-10-11' },
  { id: 'ADM_HE', name: 'נקלט בעברית', house: 'ramot', stage: 'נקלט', visitDate: '2026-10-25' },
  { id: 'ADM_NOVISIT', name: 'פנייה ישירה', house: 'ramot', stage: 'admitted', visitDate: '' },
  { id: 'ADM_FUTURE', name: 'ביקור עתידי', house: 'ramot', stage: 'admitted', visitDate: '2026-10-30' },
  { id: 'IRR_STAGE', name: 'לא רלוונטי בגיליון', house: 'ramot', stage: 'irrelevant', visitDate: '2026-10-20' },
];
const REPORT = { outcome: 'advancing', companion: 'mother', note: 'שיחה', reporter: 'אורן' };

/* ===== Fix 1 — report on an already-admitted lead ===== */

test('Fix 1: a report on an ADMITTED lead with a recent meeting lands on its Leads row — 5 fields, meetingSeen cleared, row kept', () => {
  const { submit, leadCell } = boot({ leads: [{ ...LEADS[1], meetingSeen: '1' }], managers: MANAGERS_TAB });
  const out = submit({ ...REPORT, leadId: 'ADM_RECENT', outcome: 'undecided', companion: 'סבתא', note: 'שורה\nשנייה' });
  assert.strictEqual(out.ok, true, JSON.stringify(out));
  assert.strictEqual(leadCell('ADM_RECENT', 'meetingReportOutcome'), 'undecided');
  assert.strictEqual(leadCell('ADM_RECENT', 'meetingCompanion'), 'סבתא');
  assert.strictEqual(leadCell('ADM_RECENT', 'meetingNote'), 'שורה\nשנייה', 'line breaks kept');
  assert.strictEqual(leadCell('ADM_RECENT', 'meetingReporter'), 'אורן');
  assert.strictEqual(leadCell('ADM_RECENT', 'meetingReportedAt'), out.saved.reportedAt);
  assert.strictEqual(leadCell('ADM_RECENT', 'meetingSeen'), '', 'unseen for Vered');
  assert.strictEqual(leadCell('ADM_RECENT', 'stage'), 'admitted', 'stage untouched');
  assert.strictEqual(leadCell('ADM_RECENT', 'phone'), '0501234567');
  assert.strictEqual(leadCell('ADM_RECENT', 'note'), 'פנימי');
});

test('Fix 1: the 14-day window — day 14 accepted, day 15 / no visit / a future visit refused; Hebrew stage label accepted', () => {
  const { submit } = boot({ leads: LEADS, managers: MANAGERS_TAB });
  assert.strictEqual(submit({ ...REPORT, leadId: 'ADM_EDGE' }).ok, true, 'visit exactly 14 days ago');
  assert.strictEqual(submit({ ...REPORT, leadId: 'ADM_HE' }).ok, true, "stage 'נקלט'");
  ['ADM_OLD', 'ADM_NOVISIT', 'ADM_FUTURE'].forEach((id) =>
    assert.strictEqual(submit({ ...REPORT, leadId: id }).error, 'lead_not_found', id));
  assert.strictEqual(submit({ ...REPORT, leadId: 'OPEN' }).ok, true, 'open leads unchanged');
});

test('Fix 1: closed (irrelevant) and removed leads stay lead_not_found — nothing written anywhere', () => {
  const recent = { name: 'x', house: 'ramot', visitDate: '2026-10-20' };
  const { g, submit } = boot({
    leads: LEADS, managers: MANAGERS_TAB,
    irrelevant: [{ ...recent, id: 'IRR', stage: 'irrelevant' }],
    removed: [{ ...recent, id: 'REM', stage: 'admitted' }],
  });
  const before = JSON.stringify(g.sandbox.__sheets);
  ['IRR', 'REM', 'IRR_STAGE', 'nope'].forEach((id) =>
    assert.strictEqual(submit({ ...REPORT, leadId: id }).error, 'lead_not_found', id));
  assert.strictEqual(JSON.stringify(g.sandbox.__sheets), before, 'no sheet changed');
});

test('Fix 1: the picker lists open leads + admitted leads with a visit in the last 14 days — still the four fields only', () => {
  const { reportLeads } = boot({ leads: LEADS, managers: MANAGERS_TAB });
  const out = reportLeads();
  assert.strictEqual(out.ok, true);
  assert.deepStrictEqual(out.leads.map((l) => l.id).sort(), ['ADM_EDGE', 'ADM_HE', 'ADM_RECENT', 'OPEN']);
  out.leads.forEach((l) => assert.deepStrictEqual(Object.keys(l).sort(), ['house', 'id', 'name', 'visitDate']));
});

test('Fix 1: the bonus readers are untouched by this PR', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
  const body = (name) => { const i = src.indexOf('function ' + name + '('); return src.slice(i, src.indexOf('\n}\n', i)); };
  assert.ok(!/reportableLeads_|isReportableLead_/.test(body('computeIntakeMeetingsByHouse_')));
  assert.ok(!/reportableLeads_|isReportableLead_/.test(body('readLeadMeetingManagers_')));
});

/* ===== Fix 3 — reporter list from the Managers tab ===== */

test('Fix 3: meetingReportLeads carries the CURRENT managers from the Managers tab (additive), former / future excluded', () => {
  const out = boot({ leads: LEADS, managers: MANAGERS_TAB }).reportLeads();
  assert.strictEqual(out.managersSource, 'managers');
  assert.deepStrictEqual(out.managers.map((m) => m.name).sort(), ['אורן', 'חן', 'חנן', 'רנטה', 'שחר'].sort());
  out.managers.forEach((m) => assert.deepStrictEqual(Object.keys(m).sort(), ['house', 'name']));
});

test('Fix 3 fallback: no Managers tab, or a tab with nobody current → the houseManagers source (HOUSE_MANAGERS)', () => {
  const houseManagers = (g) => Object.values(arr(g.run('HOUSE_MANAGERS'))).sort();
  const none = boot({ leads: LEADS });
  const a = none.reportLeads();
  assert.strictEqual(a.managersSource, 'default');
  assert.deepStrictEqual(a.managers.map((m) => m.name).sort(), houseManagers(none.g));
  const allFormer = boot({ leads: LEADS, managers: [{ house: 'ramot', manager_name: 'עבר', end_date: '2026-01-01' }] });
  const b = allFormer.reportLeads();
  assert.strictEqual(b.managersSource, 'default', 'an empty current list never leaves the form without names');
  assert.deepStrictEqual(b.managers.map((m) => m.name).sort(), houseManagers(allFormer.g));
});

test('Fix 3: submitMeetingReport_ refuses a reporter who is not a current manager — Hebrew message, nothing written', () => {
  const { g, submit } = boot({ leads: LEADS, managers: MANAGERS_TAB });
  const before = JSON.stringify(g.sandbox.__sheets.Leads.grid);
  ['עידו', 'עתידי', 'יעל', 'אורן ', '=HYPERLINK("x")'].forEach((name) => {
    const out = submit({ ...REPORT, leadId: 'OPEN', reporter: name });
    if (name === 'אורן ') { assert.strictEqual(out.ok, true, 'surrounding spaces are trimmed'); return; }
    assert.strictEqual(out.ok, false, name);
    assert.strictEqual(out.error, 'reporter_not_manager', name);
    assert.match(out.message, /ברשימת מנהלי הבתים הנוכחיים/);
    assert.ok(!out.message.includes(name), 'the name is never echoed');
  });
  assert.notStrictEqual(JSON.stringify(g.sandbox.__sheets.Leads.grid), before, 'only the trimmed valid name wrote');
  assert.strictEqual(submit({ ...REPORT, leadId: 'OPEN', reporter: 'שחר' }).ok, true, 'a manager from the tab, not HOUSE_MANAGERS');
});

test('Fix 3 fallback: without a Managers tab, a HOUSE_MANAGERS name is accepted and any other refused', () => {
  const { submit } = boot({ leads: LEADS });
  assert.strictEqual(submit({ ...REPORT, leadId: 'OPEN', reporter: 'עידו' }).ok, true);
  assert.strictEqual(submit({ ...REPORT, leadId: 'OPEN', reporter: 'שחר' }).error, 'reporter_not_manager');
});

test('inputs: an oversized or control-character leadId → bad_lead; text cells never start as a formula', () => {
  const { submit, leadCell } = boot({ leads: LEADS, managers: MANAGERS_TAB });
  assert.strictEqual(submit({ ...REPORT, leadId: 'x'.repeat(101) }).error, 'bad_lead');
  assert.strictEqual(submit({ ...REPORT, leadId: 'OPEN\n' }).ok, true, 'surrounding whitespace is trimmed');
  assert.strictEqual(submit({ ...REPORT, leadId: 'OP\u0000EN' }).error, 'bad_lead');
  const out = submit({ ...REPORT, leadId: 'OPEN', companion: '=IMPORTXML("x")', note: '+cmd|x\nשורה' });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(leadCell('OPEN', 'meetingCompanion'), 'IMPORTXML("x")');
  assert.strictEqual(leadCell('OPEN', 'meetingNote'), 'cmd|x\nשורה');
});

/* ===== Fix 2 — visits past month end ===== */

function houseData(opts, month) {
  const { g } = boot(opts);
  const res = arr(g.post({
    action: 'managersWork', secret: 'mw-s3cret', op: 'houseData', month,
    house: 'ramot', role: 'manager', actor: 'אורן', actorId: 'person-oran',
  }));
  assert.strictEqual(res.ok, true, JSON.stringify(res).slice(0, 300));
  return res.visits;
}

const VISIT_LEADS = [
  { id: 'V1', name: 'בחודש', house: 'רמות השבים', visitDate: '2026-10-28', visitTime: '10:00', meetingWith: 'אורן', meetingOutcome: 'thinking' },
  { id: 'V2', name: 'חודש הבא', house: 'ramot', visitDate: '2026-11-05', visitTime: '09:15', meetingWith: 'אורן' },
  { id: 'V3', name: 'יום 14', house: 'ramot', visitDate: '2026-11-09' },
  { id: 'V4', name: 'יום 15', house: 'ramot', visitDate: '2026-11-10' },
  { id: 'V5', name: 'בית אחר', house: 'קיסריה עפרוני', visitDate: '2026-11-02' },
  { id: 'V6', name: 'תחילת חודש', house: 'ramot', visitDate: '2026-10-02' },
];

test('Fix 2: the CURRENT month also returns visits today .. today+14 in the next month, flagged inSelectedMonth:false', () => {
  const v = houseData({ leads: VISIT_LEADS }, '2026-10');
  assert.deepStrictEqual(v.map((x) => [x.name, x.date, x.inSelectedMonth]), [
    ['יום 14', '2026-11-09', false],
    ['חודש הבא', '2026-11-05', false],
    ['בחודש', '2026-10-28', true],
    ['תחילת חודש', '2026-10-02', true],
  ]);
  // Same item shape plus the one additive key.
  assert.deepStrictEqual(Object.keys(v[1]).sort(), ['date', 'inSelectedMonth', 'meetingWith', 'name', 'outcome', 'time']);
  assert.deepStrictEqual(v[1], { date: '2026-11-05', time: '09:15', name: 'חודש הבא', meetingWith: 'אורן', outcome: '', inSelectedMonth: false });
});

test('Fix 2: a past month (and the default) keep the month-only window', () => {
  const past = houseData({ leads: VISIT_LEADS, today: '2026-11-03' }, '2026-10');
  assert.deepStrictEqual(past.map((x) => x.name), ['בחודש', 'תחילת חודש']);
  assert.ok(past.every((x) => x.inSelectedMonth === true));
  const now = houseData({ leads: VISIT_LEADS, today: '2026-11-03' }, '2026-11');
  assert.deepStrictEqual(now.map((x) => [x.name, x.inSelectedMonth]), [['יום 15', true], ['יום 14', true], ['חודש הבא', true]],
    'November is the current month: its own rows are all in it, nothing from October');
});

test('Fix 2: the look-ahead crosses a year end', () => {
  const v = houseData({ today: '2026-12-25', leads: [
    { id: 'Y1', name: 'ינואר', house: 'ramot', visitDate: '2027-01-08' },
    { id: 'Y2', name: 'מאוחר', house: 'ramot', visitDate: '2027-01-09' },
  ] }, '2026-12');
  assert.deepStrictEqual(v.map((x) => [x.name, x.inSelectedMonth]), [['ינואר', false]]);
});

test('Fix 2: one row per lead id across Leads / irrelevant / removed (Leads wins); id-less rows are kept', () => {
  const v = houseData({
    leads: [{ id: 'D1', name: 'בלידים', house: 'ramot', visitDate: '2026-11-01' }],
    irrelevant: [{ id: 'D1', name: 'עותק', house: 'ramot', visitDate: '2026-11-01', stage: 'irrelevant' }],
    removed: [
      { id: 'D1', name: 'עותק 2', house: 'ramot', visitDate: '2026-10-27' },
      { id: '', name: 'ללא מזהה', house: 'ramot', visitDate: '2026-10-27' },
    ],
  }, '2026-10');
  assert.deepStrictEqual(v.map((x) => x.name), ['בלידים', 'ללא מזהה']);
});

/* ===== server.js — the managers field is whitelisted ===== */

test('server: meetingReportManagersWhitelist keeps { house, name } strings only, capped', () => {
  const { meetingReportManagersWhitelist: wl } = require('../server.js');
  assert.deepStrictEqual(wl(undefined), []);
  assert.deepStrictEqual(wl('x'), []);
  assert.deepStrictEqual(wl([
    { house: 'ramot', name: ' אורן ', phone: '050', secret: 's' },
    { house: 7, name: 'חן' },
    { name: '' }, { name: 'x'.repeat(101) }, null, 'str', { name: 5 },
  ]), [{ house: 'ramot', name: 'אורן' }, { house: '', name: 'חן' }]);
  const many = Array.from({ length: 80 }, (_, i) => ({ house: 'h', name: 'n' + i }));
  assert.strictEqual(wl(many).length, 50);
});
