/* CHANGELOG-undated-visit-leads.md — a lead in «ביקור נקבע» with no visitDate
 * is on no meeting surface (board, CRM «יומן», managers' feed). Reproduction
 * first: אורנה פרלמן as the live sheet held her on 28/10/2026 — stage 'visit',
 * meetingWith 'אורן', visitDate '' — is in NO week of meetingsForWeek and in no
 * calendarRows range; from now on she is in the undated strip of both, and
 * moving a lead to «ביקור נקבע» asks for the date on the spot. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadApp() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const epilogue = `
    globalThis.__test = { undatedVisitLeads, undatedVisitsBannerHTML, meetingStubForLead, meetingsForWeek, state };
  `;
  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/' },
    document: { addEventListener: noop, getElementById: () => null },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    URLSearchParams, Math, Date, JSON, Number, String, Array, Object, RegExp, Promise, Set, Map,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + epilogue, sandbox);
  return sandbox.__test;
}
const app = loadApp();
const crm = require('../public/crm/crm.js');

const ORNA  = { id: 'id-orna', name: 'אורנה פרלמן', house: 'רמות השבים', stage: 'visit', visitDate: '', visitTime: '', meetingWith: 'אורן', created: '2026-10-23' };
const DATED = { id: 'id-dated', name: 'יוסי כהן', house: 'ramot', stage: 'visit', visitDate: '2026-10-28', visitTime: '10:00', meetingWith: 'אורן' };
const NEW   = { id: 'id-new', name: 'חדש', house: 'asher', stage: 'new', visitDate: '' };
const BAD   = { id: 'id-bad', name: 'שנה שבורה', house: 'ramot', stage: 'visit', visitDate: '0020-10-28' };

/* ===== classic ===== */

test('reproduction: a dateless «ביקור נקבע» lead is in no week of the meetings board', () => {
  const wk = app.meetingsForWeek([ORNA, DATED], '2026-10-28');
  const ids = [].concat(...wk.days.map(d => d.timed.concat(d.noTime))).map(m => m.id);
  assert.deepEqual(ids, ['id-dated']);
});

test('classic: undatedVisitLeads — visit stage + no date; dated, non-visit and damaged-date leads are out', () => {
  assert.deepEqual(app.undatedVisitLeads([ORNA, DATED, NEW, BAD]).map(l => l.id), ['id-orna']);
  assert.deepEqual(app.undatedVisitLeads([]), []);
  assert.deepEqual(app.undatedVisitLeads(null), []);
});

test('classic: the strip names the lead with house and manager; chips are buttons in edit mode, spans otherwise; nothing when none', () => {
  app.state.mode = 'edit';
  const html = app.undatedVisitsBannerHTML([ORNA, DATED]);
  assert.ok(html.includes('1 ליד ב«ביקור נקבע» ללא תאריך פגישה'));
  assert.ok(html.includes('data-undated-lead="id-orna"'));
  assert.ok(html.includes('אורנה פרלמן · רמות השבים · אורן'));
  assert.ok(html.includes('לא מופיעים בלוח ולא אצל המנהלים'));
  app.state.mode = 'view';
  const ro = app.undatedVisitsBannerHTML([ORNA]);
  assert.ok(!ro.includes('data-undated-lead') && ro.includes('<span class="mtg-bad-date-lead mtg-undated-lead">'));
  assert.strictEqual(app.undatedVisitsBannerHTML([DATED, NEW]), '');
});

test('classic: the strip escapes names', () => {
  app.state.mode = 'edit';
  const html = app.undatedVisitsBannerHTML([Object.assign({}, ORNA, { name: '<b>x</b>' })]);
  assert.ok(html.includes('&lt;b&gt;x&lt;/b&gt;') && !html.includes('<b>x</b>'));
});

test('classic: meetingStubForLead carries what the meeting modal pre-fills', () => {
  assert.deepEqual(app.meetingStubForLead(ORNA), { id: 'id-orna', date: '', time: '', name: 'אורנה פרלמן', house: 'רמות השבים', meetingWith: 'אורן' });
  assert.deepEqual(app.meetingStubForLead(DATED).date, '2026-10-28');
});

test('classic: renderMeetings shows the strip; moveLead opens the meeting modal on arrival at «ביקור נקבע» without a date', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.ok(/\$\{badLeadDatesBannerHTML\(state\.leads\)\}\s*\n\s*\$\{undatedVisitsBannerHTML\(state\.leads\)\}/.test(src));
  const mv = src.slice(src.indexOf('async function moveLead('), src.indexOf('async function updateLead('));
  assert.ok(mv.includes("newStage === 'visit' && prev !== 'visit' && !leadVisitDateISO(lead.visitDate) && state.mode === 'edit'"));
  assert.ok(mv.includes('openMeetingEditModal(meetingStubForLead(lead)'));
  // the failure path returns before the prompt: a rolled-back move never asks for a date
  assert.ok(/showError\('עדכון שלב נכשל — ' \+ e\.message\);\s*\n\s*return;/.test(mv));
});

/* ===== CRM ===== */

test('reproduction: calendarRows never lists a dateless visit lead, on any day', () => {
  const range = crm.calendarRange('week', '2026-10-28');
  assert.deepEqual(crm.calendarRows([ORNA, DATED], range, '2026-10-28').map(r => r.id), ['id-dated']);
});

test('CRM: undatedVisits — visit stage + no date, oldest first, with house label and manager', () => {
  const older = Object.assign({}, ORNA, { id: 'id-older', name: 'ב', created: '2026-10-01' });
  const list = crm.undatedVisits([DATED, ORNA, NEW, older]);
  assert.deepEqual(list.map(u => u.id), ['id-older', 'id-orna']);
  assert.deepEqual(list[1], { id: 'id-orna', name: 'אורנה פרלמן', house: 'רמות השבים', withWhom: 'אורן', created: '2026-10-23' });
  assert.deepEqual(crm.undatedVisits([]), []);
});

test('CRM: renderCalendar shows the strip; moveStage asks for the date on arrival at «ביקור נקבע»', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'crm', 'crm.js'), 'utf8');
  assert.ok(src.includes('const undated = undatedVisits(c.leads);'));
  assert.ok(src.includes('id="crm-cal-undated"') && src.includes('data-focus-meeting="1"'));
  const mv = src.slice(src.indexOf('function moveStage('), src.indexOf('function focusMeetingForm('));
  assert.ok(mv.includes("const needsDate = target === 'visit' && !l.visitDate;"));
  assert.ok(mv.includes("if (ok && needsDate) { openDrawer('lead', id, true); focusMeetingForm();"));
  assert.ok(src.includes("if (t.dataset.focusMeeting) focusMeetingForm();"));
});
