'use strict';

/* Intake-meeting reports in the managers app (CHANGELOG-meeting-report-in-managers.md).
 *
 *   - managersWork op 'meetings': the caller's house only (lead house OR the
 *     house of its meetingWith manager on the visit date), whitelisted fields,
 *     a bounded date range;
 *   - managersWork op 'meetingReport': the SAME validation + locked write as
 *     /meeting-report (submitMeetingReportVia_), reporter = the caller, via 'app',
 *     out-of-scope = lead_not_found with nothing written;
 *   - the not-held reason + proposed date rules on BOTH paths;
 *   - append-only columns, the saveAll guard, the delete, the label maps in sync,
 *     and the WhatsApp message line.
 * Real apps-script/Code.gs in the shared vm sandbox; no network, no secrets. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { richSheet, loadGs } = require('./helpers/gs-sandbox');

const SECRET = 'mw-secret-123';
const MR_SECRET = 'mr-secret-456';
const TODAY = '2026-11-19';
const arr = (x) => JSON.parse(JSON.stringify(x));
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function boot() {
  const g = loadGs({ props: { MANAGERS_WORK_SECRET: SECRET, MEETING_REPORT_SECRET: MR_SECRET } });
  g.sandbox.Session = { getScriptTimeZone: () => 'Asia/Jerusalem' };
  g.run(`todayISODate_ = function () { return '${TODAY}'; }`);
  const put = (name, colsExpr, rows) => {
    const cols = Array.from(g.run(colsExpr));
    const sh = richSheet(name, cols);
    rows.forEach((r) => sh.grid.push(cols.map((c) => r[c] ?? '')));
    g.sandbox.__sheets[name] = sh;
  };
  put('Managers', 'MANAGER_COLUMNS', [
    { house: 'ramot', manager_name: 'אורן', start_date: '2026-01-01' },
    { house: 'efroni', manager_name: 'חנן', start_date: '2026-01-01' },
  ]);
  put('Leads', 'LEAD_COLUMNS', [
    { id: 'M1', name: 'דני', phone: '0501234567', contactPhone: '0529999999', house: 'רמות השבים', stage: 'visit', visitDate: '2026-11-17', visitTime: '10:00', meetingWith: 'אורן', note: 'רקע מהמשרד' },
    // Lead of another house, but the meeting is with the ramot manager → in BOTH scopes.
    { id: 'M2', name: 'רות', phone: '0501111111', house: 'קיסריה עפרוני', stage: 'visit', visitDate: '2026-11-18', visitTime: '', meetingWith: 'אורן' },
    { id: 'M3', name: 'יוסי', phone: '0502222222', house: 'קיסריה עפרוני', stage: 'visit', visitDate: '2026-11-18', visitTime: '09:15', meetingWith: 'חנן' },
    { id: 'M4', name: 'ישן', house: 'ramot', stage: 'visit', visitDate: '2026-09-01', meetingWith: 'אורן' },
    { id: 'M5', name: 'נקלט', house: 'ramot', stage: 'admitted', visitDate: '2026-10-01', meetingWith: 'אורן' },
    { id: 'M6', name: 'מחר', house: 'ramot', stage: 'visit', visitDate: '2026-11-25', visitTime: '12:30', meetingWith: 'אורן' },
  ]);
  const call = (body) => arr(g.post({ action: 'managersWork', secret: SECRET, ...body }));
  const leads = () => g.sheetRows('Leads', 'LEAD_COLUMNS');
  const lead = (id) => leads().find((l) => l.id === id);
  return { g, call, leads, lead };
}
const ORAN = { house: 'ramot', role: 'manager', actor: 'אורן', actorId: 'person-oran' };
const HANAN = { house: 'efroni', role: 'manager', actor: 'חנן', actorId: 'person-hanan' };
const SANDRA = { house: 'efroni', role: 'admin', actor: 'סנדרה', actorId: 'person-sandra' };
const HELD = { leadId: 'M1', outcome: 'advancing', companion: 'mother', note: 'שיחה טובה' };

/* ===== schema ===== */

test('LEAD_COLUMNS: the three new columns are appended LAST, after meetingSeen, nothing reordered', () => {
  const { g } = boot();
  const cols = Array.from(g.run('LEAD_COLUMNS'));
  assert.deepStrictEqual(cols.slice(-4), ['meetingSeen', 'meetingNotHeldReason', 'meetingProposedDate', 'meetingReportVia']);
  assert.deepStrictEqual(Array.from(g.run('MEETING_REPORT_MANAGER_ONLY_FIELDS')), ['meetingNotHeldReason', 'meetingProposedDate', 'meetingReportVia']);
  const fields = Array.from(g.run('MEETING_REPORT_LEAD_FIELDS'));
  ['meetingNotHeldReason', 'meetingProposedDate', 'meetingReportVia'].forEach((f) => assert.ok(fields.includes(f), f));
});

test('capabilities advertise meetings', () => {
  const { call } = boot();
  assert.ok(call({ op: 'capabilities' }).capabilities.includes('meetings'));
});

/* ===== op meetings ===== */

test('meetings: a manager gets their house — lead house OR their own meeting elsewhere — sorted, in range', () => {
  const { call } = boot();
  const out = call({ op: 'meetings', ...ORAN });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.house, 'ramot');
  assert.deepStrictEqual(out.meetings.map((m) => m.id), ['M1', 'M2', 'M6'], 'M3 = another manager, M4 out of range, M5 admitted long ago');
  assert.deepStrictEqual(out.notHeldReasons, ['no_show', 'postponed', 'cancelled_family', 'cancelled_us', 'other']);
  const hanan = call({ op: 'meetings', ...HANAN });
  assert.deepStrictEqual(hanan.meetings.map((m) => m.id), ['M3', 'M2'], 'efroni: both efroni leads, timed first on the same day');
});

test('meetings: only whitelisted fields — no phone, contact or billing data ever leaves', () => {
  const { call } = boot();
  const m1 = call({ op: 'meetings', ...ORAN }).meetings[0];
  assert.deepStrictEqual(Object.keys(m1).sort(),
    ['house', 'houseLabel', 'id', 'meetingWith', 'name', 'officeNote', 'report', 'visitDate', 'visitTime']);
  assert.deepStrictEqual(m1, {
    id: 'M1', name: 'דני', house: 'ramot', houseLabel: 'רמות השבים', visitDate: '2026-11-17',
    visitTime: '10:00', meetingWith: 'אורן', officeNote: 'רקע מהמשרד', report: null,
  });
  assert.ok(!JSON.stringify(call({ op: 'meetings', ...ORAN })).includes('050'), 'no phone digits anywhere');
});

test('meetings: the house is the caller\'s (from the managers server) — an invalid house or role is refused', () => {
  const { call } = boot();
  assert.strictEqual(call({ op: 'meetings', ...ORAN, house: 'nowhere' }).error, 'bad_request');
  assert.strictEqual(call({ op: 'meetings', ...ORAN, role: 'guest' }).error, 'bad_request');
  assert.strictEqual(call({ op: 'meetings', ...ORAN, actorId: '' }).error, 'bad_request');
});

test('meetings: from/to bounded — bad dates, reversed or longer than 62 days → bad_range', () => {
  const { call } = boot();
  assert.strictEqual(call({ op: 'meetings', ...ORAN, from: '2026-02-30', to: '2026-03-10' }).error, 'bad_range');
  assert.strictEqual(call({ op: 'meetings', ...ORAN, from: '2026-11-20', to: '2026-11-10' }).error, 'bad_range');
  assert.strictEqual(call({ op: 'meetings', ...ORAN, from: '2026-08-01', to: '2026-11-30' }).error, 'bad_range');
  const ok = call({ op: 'meetings', ...ORAN, from: '2026-08-25', to: '2026-09-05' });
  assert.deepStrictEqual(ok.meetings.map((m) => m.id), ['M4']);
});

test('managersWork meetings ops refuse without the managers secret (fail-closed)', () => {
  const { g } = boot();
  assert.strictEqual(arr(g.post({ action: 'managersWork', op: 'meetings', ...ORAN })).error, 'unauthorized');
  assert.strictEqual(arr(g.post({ action: 'managersWork', secret: 'wrong', op: 'meetingReport', ...ORAN, ...HELD })).error, 'unauthorized');
});

/* ===== op meetingReport ===== */

test('meetingReport (app): writes the same report fields, reporter = caller, via app, unseen for Vered', () => {
  const { call, lead } = boot();
  const out = call({ op: 'meetingReport', ...ORAN, ...HELD, submissionId: 'sub-aaaaaaaa1111' });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.saved.leadId, 'M1');
  assert.strictEqual(out.saved.via, 'app');
  const l = lead('M1');
  assert.strictEqual(l.meetingReportOutcome, 'advancing');
  assert.strictEqual(l.meetingCompanion, 'mother');
  assert.strictEqual(l.meetingNote, 'שיחה טובה');
  assert.strictEqual(l.meetingReporter, 'אורן');
  assert.strictEqual(l.meetingReportVia, 'app');
  assert.strictEqual(l.meetingSeen, '');
  assert.strictEqual(l.meetingNotHeldReason, '');
  assert.strictEqual(l.phone, '0501234567', 'the rest of the row is preserved');
  // …and the meetings list now carries the report.
  const m1 = call({ op: 'meetings', ...ORAN }).meetings.find((m) => m.id === 'M1');
  assert.strictEqual(m1.report.outcome, 'advancing');
  assert.strictEqual(m1.report.via, 'app');
  assert.strictEqual(m1.report.reporter, 'אורן');
});

test('meetingReport: a meeting of another house → lead_not_found, nothing written', () => {
  const { call, lead } = boot();
  const out = call({ op: 'meetingReport', ...ORAN, ...HELD, leadId: 'M3' });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.error, 'lead_not_found');
  assert.strictEqual(lead('M3').meetingReportedAt, '');
  // Hanan may report M3, and Oran may report M2 (his own meeting at efroni).
  assert.strictEqual(call({ op: 'meetingReport', ...HANAN, ...HELD, leadId: 'M3' }).ok, true);
  assert.strictEqual(call({ op: 'meetingReport', ...ORAN, ...HELD, leadId: 'M2' }).ok, true);
});

test('meetingReport: admin reports in the house they picked, under their own name', () => {
  const { call, lead } = boot();
  assert.strictEqual(call({ op: 'meetingReport', ...SANDRA, ...HELD, leadId: 'M3' }).ok, true);
  assert.strictEqual(lead('M3').meetingReporter, 'סנדרה');
});

test('not held: outcome no_show REQUIRES a reason; a held outcome may carry none', () => {
  const { call } = boot();
  assert.strictEqual(call({ op: 'meetingReport', ...ORAN, ...HELD, outcome: 'no_show' }).error, 'bad_reason');
  assert.strictEqual(call({ op: 'meetingReport', ...ORAN, ...HELD, notHeldReason: 'no_show' }).error, 'bad_reason');
  assert.strictEqual(call({ op: 'meetingReport', ...ORAN, ...HELD, proposedDate: '2026-12-01' }).error, 'bad_reason');
  assert.strictEqual(call({ op: 'meetingReport', ...ORAN, ...HELD, outcome: 'no_show', notHeldReason: 'x'.repeat(101) }).error, 'bad_reason');
});

test('not held: each reason key and the אחר free text are stored', () => {
  for (const r of ['no_show', 'cancelled_family', 'cancelled_us', 'other', 'הגיע לבית הלא נכון']) {
    const { call, lead } = boot();
    const out = call({ op: 'meetingReport', ...ORAN, leadId: 'M1', outcome: 'no_show', notHeldReason: r, companion: '', note: '' });
    assert.strictEqual(out.ok, true, r);
    assert.strictEqual(lead('M1').meetingNotHeldReason, r);
    assert.strictEqual(lead('M1').meetingProposedDate, '');
  }
});

test('proposed date: only with postponed, a real date, today or later — never moves visitDate', () => {
  const { call, lead } = boot();
  const base = { op: 'meetingReport', ...ORAN, leadId: 'M1', outcome: 'no_show', companion: '', note: '' };
  assert.strictEqual(call({ ...base, notHeldReason: 'no_show', proposedDate: '2026-12-01' }).error, 'bad_proposed_date');
  assert.strictEqual(call({ ...base, notHeldReason: 'postponed', proposedDate: '2026-11-18' }).error, 'bad_proposed_date');
  assert.strictEqual(call({ ...base, notHeldReason: 'postponed', proposedDate: '2026-02-30' }).error, 'bad_proposed_date');
  assert.strictEqual(call({ ...base, notHeldReason: 'postponed', proposedDate: '1/12/2026' }).error, 'bad_proposed_date');
  assert.strictEqual(lead('M1').meetingReportedAt, '', 'every refusal wrote nothing');
  assert.strictEqual(call({ ...base, notHeldReason: 'postponed', proposedDate: TODAY }).ok, true);
  assert.strictEqual(call({ ...base, notHeldReason: 'postponed', proposedDate: '2026-12-01' }).ok, true);
  assert.strictEqual(lead('M1').meetingProposedDate, '2026-12-01');
  assert.strictEqual(lead('M1').visitDate, '2026-11-17', 'Vered still reschedules');
  assert.strictEqual(call({ ...base, notHeldReason: 'postponed' }).ok, true, 'the date is optional');
});

test('idempotent: the same submissionId twice → replayed, one report', () => {
  const { call, lead } = boot();
  const a = call({ op: 'meetingReport', ...ORAN, ...HELD, submissionId: 'sub-bbbbbbbb2222' });
  const at = lead('M1').meetingReportedAt;
  const b = call({ op: 'meetingReport', ...ORAN, ...HELD, submissionId: 'sub-bbbbbbbb2222' });
  assert.strictEqual(b.replayed, true);
  assert.strictEqual(b.saved.reportedAt, a.saved.reportedAt);
  assert.strictEqual(lead('M1').meetingReportedAt, at);
});

/* ===== the link path (/meeting-report) ===== */

test('link path: same rules; the row differs from the app path only in via (and the reporter it names)', () => {
  const link = boot();
  const lo = link.g.run(`submitMeetingReport_(${JSON.stringify({ leadId: 'M1', outcome: 'no_show', notHeldReason: 'postponed', proposedDate: '2026-12-01', companion: '', note: 'נדחה', reporter: 'אורן' })})`);
  assert.strictEqual(lo.ok, true);
  const app = boot();
  assert.strictEqual(app.call({ op: 'meetingReport', ...ORAN, leadId: 'M1', outcome: 'no_show', notHeldReason: 'postponed', proposedDate: '2026-12-01', companion: '', note: 'נדחה' }).ok, true);
  const a = { ...link.lead('M1') }, b = { ...app.lead('M1') };
  assert.strictEqual(a.meetingReportVia, 'link');
  assert.strictEqual(b.meetingReportVia, 'app');
  delete a.meetingReportVia; delete b.meetingReportVia; delete a.meetingReportedAt; delete b.meetingReportedAt;
  assert.deepStrictEqual(a, b);
  // no_show without a reason is refused on the link too.
  const again = boot();
  assert.strictEqual(again.g.run(`submitMeetingReport_({ leadId: 'M1', outcome: 'no_show', companion: '', note: '', reporter: 'אורן' })`).error, 'bad_reason');
  // and the link keeps refusing a reporter who is not a current manager.
  assert.strictEqual(again.g.run(`submitMeetingReport_({ leadId: 'M1', outcome: 'advancing', companion: '', note: '', reporter: 'זר' })`).error, 'reporter_not_manager');
});

test('link path via handle_ forwards the reason (MEETING_REPORT_SECRET gate unchanged)', () => {
  const { g, lead } = boot();
  const out = arr(g.post({ action: 'submitMeetingReport', secret: MR_SECRET, report: { leadId: 'M1', outcome: 'no_show', notHeldReason: 'cancelled_us', companion: '', note: '', reporter: 'אורן' } }));
  assert.strictEqual(out.ok, true, JSON.stringify(out));
  assert.strictEqual(lead('M1').meetingNotHeldReason, 'cancelled_us');
  assert.strictEqual(arr(g.post({ action: 'submitMeetingReport', secret: 'nope', report: { leadId: 'M1' } })).error, 'unauthorized');
});

/* ===== saveAll guard + delete ===== */

test('saveAll guard: a same-report client copy with a blank reason never erases the sheet\'s reason', () => {
  const { g, call } = boot();
  call({ op: 'meetingReport', ...ORAN, leadId: 'M1', outcome: 'no_show', notHeldReason: 'postponed', proposedDate: '2026-12-01', companion: '', note: '' });
  const out = arr(g.run(`(function () {
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(LEADS_SHEET);
    const rows = readSheet_(sh, LEAD_COLUMNS);
    const row = sh.getRange(2, 1, 1, LEAD_COLUMNS.length).getValues()[0];
    const merged = Object.assign({}, rows[0], { meetingNotHeldReason: '', meetingProposedDate: '', meetingReportVia: '', meetingSeen: '1' });
    return preserveNewerMeetingReport_(merged, row);
  })()`));
  assert.strictEqual(out.meetingNotHeldReason, 'postponed');
  assert.strictEqual(out.meetingProposedDate, '2026-12-01');
  assert.strictEqual(out.meetingReportVia, 'app');
  assert.strictEqual(out.meetingSeen, '1', 'Vered\'s mark-seen still persists');
});

test('deleteMeetingReport_ clears the reason fields too', () => {
  const { g, call, lead } = boot();
  call({ op: 'meetingReport', ...ORAN, leadId: 'M1', outcome: 'no_show', notHeldReason: 'cancelled_family', companion: '', note: '' });
  assert.strictEqual(g.run(`deleteMeetingReport_('M1', null)`).ok, true);
  const l = lead('M1');
  assert.strictEqual(l.meetingReportedAt, '');
  assert.strictEqual(l.meetingNotHeldReason, '');
  assert.strictEqual(l.meetingReportVia, '');
});

/* ===== label maps in sync + the WhatsApp message ===== */

function objLiteral(src, name) {
  const m = new RegExp(name + '\\s*=\\s*(?:Object\\.freeze\\()?\\{([^}]*)\\}').exec(src);
  assert.ok(m, name + ' found');
  const out = {};
  m[1].replace(/(\w+)\s*:\s*'([^']*)'/g, (_, k, v) => { out[k] = v; return ''; });
  return out;
}

test('not-held labels identical in app.js, meeting-report.js and crm.js; keys = Code.gs MEETING_NOT_HELD_KEYS', () => {
  const app = objLiteral(read('public/app.js'), 'const MEETING_NOT_HELD_LABELS');
  const mr = objLiteral(read('public/meeting-report.js'), 'var MR_NOT_HELD_LABELS');
  const crm = objLiteral(read('public/crm/crm.js'), 'const MEETING_NOT_HELD_LABELS');
  assert.deepStrictEqual(mr, app);
  assert.deepStrictEqual(crm, app);
  const { g } = boot();
  assert.deepStrictEqual(Object.keys(app), Array.from(g.run('MEETING_NOT_HELD_KEYS')));
});

const MR = require('../public/meeting-report.js');

test('WhatsApp message: a held meeting is byte-identical to before (no «סיבה» line)', () => {
  const saved = { name: 'דני', house: 'ramot', outcome: 'advancing', companion: 'mother', note: 'שיחה', reporter: 'אורן' };
  assert.strictEqual(MR.mrWhatsAppMessage(saved), [
    'יומן ביקורים ודיווח סטטוס — E-Zone', 'ליד: דני (רמות השבים)', 'תוצאה: התקיימה — מתקדם לכניסה',
    'הגיע/ה עם: אמא', 'פירוט: שיחה', 'דווח ע"י: אורן',
  ].join('\n'));
});

test('WhatsApp message: a not-held report carries «סיבה» (+ the proposed date) after «תוצאה»', () => {
  const saved = { name: 'דני', house: 'ramot', outcome: 'no_show', companion: '', note: '', reporter: 'אורן', notHeldReason: 'postponed', proposedDate: '2026-12-01' };
  const lines = MR.mrWhatsAppMessage(saved).split('\n');
  assert.strictEqual(lines[2], 'תוצאה: לא הגיע / בוטל');
  assert.strictEqual(lines[3], 'סיבה: נדחתה · מועד חדש מוצע: 01/12/2026');
  assert.strictEqual(lines[lines.length - 1], 'דווח ע"י: אורן');
  assert.strictEqual(MR.mrNotHeldLine({ notHeldReason: 'מחלה פתאומית' }), 'סיבה: מחלה פתאומית');
});

test('WhatsApp share: a 5,000-char Hebrew note with a reason keeps the reason line and the footer', () => {
  const saved = { name: 'דני', house: 'ramot', outcome: 'no_show', companion: '', note: 'ש'.repeat(5000), reporter: 'אורן', notHeldReason: 'cancelled_family' };
  const msg = MR.mrWhatsAppShareMessage(saved);
  assert.ok(msg.includes('סיבה: בוטלה ע"י הפונה/המשפחה'));
  assert.ok(msg.endsWith('דווח ע"י: אורן'));
  assert.ok(MR.mrWhatsAppShareUrl(saved).length <= MR.MR_WA_URL_MAX);
});

test('form helpers: the reason value, the display rule and the client-side refusal mirror Code.gs', () => {
  assert.strictEqual(MR.mrNotHeldValue('postponed', 'x'), 'postponed');
  assert.strictEqual(MR.mrNotHeldValue('other', '  סיבה  '), 'סיבה');
  assert.strictEqual(MR.mrNotHeldValue('other', ''), 'other');
  assert.strictEqual(MR.mrNotHeldDisplay('cancelled_us'), 'בוטלה על ידינו');
  assert.strictEqual(MR.mrNotHeldError('advancing', '', '', TODAY), '');
  assert.ok(MR.mrNotHeldError('no_show', '', '', TODAY));
  assert.ok(MR.mrNotHeldError('no_show', 'no_show', '2026-12-01', TODAY));
  assert.ok(MR.mrNotHeldError('no_show', 'postponed', '2026-11-01', TODAY));
  assert.strictEqual(MR.mrNotHeldError('no_show', 'postponed', '2026-12-01', TODAY), '');
  assert.ok(MR.MR_SUBMIT_ERROR_TEXTS.bad_reason && MR.MR_SUBMIT_ERROR_TEXTS.bad_proposed_date);
});

test('the form page has the reason step; server.js forwards the reason and the date', () => {
  const html = read('public/meeting-report.html');
  ['mr-reason-wrap', 'mr-reasons', 'mr-reason-other', 'mr-proposed'].forEach((id) => assert.ok(html.includes(`id="${id}"`), id));
  const server = read('server.js');
  assert.ok(/notHeldReason:\s*b\.notHeldReason/.test(server));
  assert.ok(/proposedDate:\s*b\.proposedDate/.test(server));
});

test('Vered sees the reason: the report block (app.js) and the CRM report view render «סיבה», escaped', () => {
  const app = read('public/app.js');
  assert.ok(/<span class="mrv-label">סיבה:<\/span> \$\{escapeHtml\(meetingNotHeldText\(/.test(app));
  const crm = read('public/crm/crm.js');
  assert.ok(crm.includes("'<dt>סיבה</dt><dd>' + esc(m.report.notHeld)"));
  assert.ok(/meetingNotHeldReason: s\(l\.meetingNotHeldReason\)/.test(crm));
});

/* ===== real Chromium: the reason step on /meeting-report (skipped where no browser) ===== */

const http = require('node:http');
let playwright = null;
try { playwright = require('playwright'); } catch (_) { /* not installed — skip */ }
const chromiumPath = [process.env.EZONE_CHROMIUM, '/opt/pw-browsers/chromium'].filter(Boolean)
  .find((p) => { try { return fs.existsSync(p); } catch (_) { return false; } });
const skip = !playwright ? 'playwright is not installed' : (!chromiumPath ? 'no Chromium binary found' : false);

function serveForm(posts) {
  const PUBLIC = path.join(ROOT, 'public');
  const types = { '.css': 'text/css', '.js': 'application/javascript', '.html': 'text/html; charset=utf-8' };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    if (u.pathname === '/api/meeting-report/leads') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, leads: [{ id: 'A', name: 'דני', house: 'ramot', visitDate: '2026-01-02', officeNote: '' }], managers: [{ house: 'ramot', name: 'אורן' }] }));
      return;
    }
    if (u.pathname === '/api/meeting-report/submit') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const p = JSON.parse(body); posts.push(p);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, saved: { leadId: p.leadId, outcome: p.outcome, notHeldReason: p.notHeldReason, proposedDate: p.proposedDate } }));
      });
      return;
    }
    const file = u.pathname === '/' ? 'meeting-report.html' : u.pathname.slice(1);
    const f = path.join(PUBLIC, file);
    if (!f.startsWith(PUBLIC) || !fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' });
    res.end(fs.readFileSync(f));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('browser: «לא הגיע / בוטל» opens the reason step; נדחתה shows the date; the reason is sent and shared', { skip }, async () => {
  const posts = [];
  const server = await serveForm(posts);
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForSelector('#mr-lead option[value="A"]', { state: 'attached' });
    await page.selectOption('#mr-reporter', 'אורן');
    await page.selectOption('#mr-lead', 'A');
    assert.equal(await page.isVisible('#mr-reason-wrap'), false, 'hidden until no_show');
    await page.click('[data-outcome="no_show"]');
    assert.equal(await page.isVisible('#mr-reason-wrap'), true);
    // No reason → refused at the form, nothing sent.
    await page.click('#mr-submit');
    assert.ok((await page.textContent('#mr-error')).includes('למה הפגישה לא התקיימה'));
    assert.equal(posts.length, 0);
    await page.click('[data-reason="postponed"]');
    assert.equal(await page.isVisible('#mr-proposed'), true);
    const d = new Date(Date.now() + 7 * 86400000);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    await page.fill('#mr-proposed', iso);
    await page.click('#mr-submit');
    await page.waitForSelector('#mr-done:not(.hidden)');
    assert.equal(posts.length, 1);
    assert.equal(posts[0].notHeldReason, 'postponed');
    assert.equal(posts[0].proposedDate, iso);
    assert.ok((await page.textContent('#mr-summary')).includes('סיבה: נדחתה'));
    const href = await page.getAttribute('#mr-whatsapp', 'href');
    assert.ok(decodeURIComponent(href.split('text=')[1]).includes('סיבה: נדחתה · מועד חדש מוצע:'));
    // Another outcome hides the step and sends no reason.
    await page.click('#mr-again');
    await page.waitForSelector('#mr-form:not(.hidden)');
    await page.selectOption('#mr-lead', 'A');
    await page.click('[data-outcome="no_show"]');
    await page.click('[data-reason="cancelled_us"]');
    await page.click('[data-outcome="advancing"]');
    assert.equal(await page.isVisible('#mr-reason-wrap'), false);
    await page.click('#mr-submit');
    await page.waitForSelector('#mr-done:not(.hidden)');
    assert.equal(posts[1].notHeldReason, '');
    assert.equal(posts[1].proposedDate, '');
  } finally {
    await browser.close();
    server.close();
  }
});
