'use strict';

/* «אמבולטורי» as a «נפגש עם» option + the automatic Outpatient handoff
 * (CHANGELOG-meeting-with-ambulatory.md).
 *
 * The REAL apps-script/Code.gs (vm sandbox, in-memory spreadsheet), the REAL
 * public/app.js (vm sandbox) and the REAL server.js helpers +
 * lib/ambulatory-handoff.js with injected sends — no network, no secret.
 * Every name and phone is SYNTHETIC. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadGs, richSheet } = require('./helpers/gs-sandbox');
const handoffLib = require('../lib/ambulatory-handoff');

const ROOT = path.join(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const GS_SRC = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');
const SW_SRC = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');
const CSS_SRC = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
const AMB = 'אמבולטורי';
const WARN_HE = 'הפגישה נשמרה, אך שליחת הליד לאמבולטורי נכשלה — לא נשלח';
const plain = (v) => JSON.parse(JSON.stringify(v));

/* ---------- app.js ---------- */
function loadApp() {
  const epilogue = `
    globalThis.__test = {
      MEETING_WITH_AMBULATORY, AMBULATORY_SENT_CHIP_HE,
      meetingWithSelectHTML, meetingWithOptionNames, meetingWithField, managerOptions,
      leadsNeedingMeetingWithDefault, autosaveMeetingWithDefaults,
      meetingsForWeek, meetingsSummaryHTML, meetingWhatsappUrl, meetingRowHTML,
      ambulatorySentChipHTML, applyAmbulatoryOutcome, normalizeOutpatientSentIds,
      setState(k, v) { state[k] = v; },
      getState(k) { return state[k]; },
      stubSaveAll() { const calls = []; saveAll = async () => { calls.push(true); }; return calls; },
    };
  `;
  const noop = () => {};
  const banner = { textContent: '', classList: { add: noop, remove: noop, toggle: noop } };
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/' },
    document: { addEventListener: noop, getElementById: () => banner, querySelectorAll: () => [] },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    setTimeout: noop, clearTimeout: noop,
    URLSearchParams, Math, Date, JSON, Number, String, Array, Object, RegExp, Promise, Set, Map,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(APP_SRC + epilogue, sandbox);
  return { app: sandbox.__test, banner };
}
const ROSTER = { arfoni: 'חנן', rehab: 'רנטה', asher: 'עידו', ramot: 'אורן' };
const optionValues = (html) => [...html.matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]);
const selectedValue = (html) => { const m = html.match(/<option value="([^"]*)"[^>]*\sselected[^>]*>/); return m ? m[1] : ''; };

/* ---------- Code.gs ---------- */
function world({ managers = null, leads = [], audit = [] } = {}) {
  const g = loadGs();
  const s = g.sandbox;
  g.run("todayISODate_ = function () { return '2026-10-26'; }");
  const put = (name, colsExpr, rows) => {
    const cols = Array.from(g.run(colsExpr));
    const sh = richSheet(name, cols);
    rows.forEach((r) => sh.grid.push(cols.map((c) => r[c] ?? '')));
    s.__sheets[name] = sh;
  };
  put('Leads', 'LEAD_COLUMNS', leads);
  if (audit.length) put('AuditLog', 'AUDIT_LOG_COLUMNS', audit);
  if (managers) {
    const sh = richSheet('Managers', ['house', 'manager_name', 'start_date', 'end_date']);
    managers.forEach((m) => sh.grid.push([m.house, m.manager_name, m.start_date || '', m.end_date || '']));
    s.__sheets.Managers = sh;
  }
  const verified = { verified: true, user: 'ורד', id: 'vered', auth: 'personal', roles: ['editor'], caps: [] };
  return {
    g, s,
    save: (ls) => plain(s.saveAll_(plain(ls), undefined, 'ורד')),
    record: (p) => plain(s.recordOutpatientLeadSend_(Object.assign({ __actor: verified }, p))),
    leads: () => g.sheetRows('Leads', 'LEAD_COLUMNS'),
    audit: () => g.sheetRows('AuditLog', 'AUDIT_LOG_COLUMNS'),
  };
}
const lead = (over) => Object.assign({
  id: 'L1', name: 'דנה לוי', phone: '0521234567', house: 'רמות השבים', source: 'facebook', note: 'הערה',
  stage: 'visit', visitDate: '2026-10-28', visitTime: '10:00', created: '2026-10-20', meetingWith: '',
}, over || {});

/* ===== 1. The option: present, last, never a manager ===== */

test('option: «אמבולטורי» is the LAST «נפגש עם» option on the card, the lead modals and the meeting edit modal', () => {
  const { app } = loadApp();
  assert.equal(app.MEETING_WITH_AMBULATORY, AMB);
  assert.deepEqual(optionValues(app.meetingWithSelectHTML({ house: '', meetingWith: '' }, ROSTER)), ['', 'חנן', 'רנטה', 'עידו', 'אורן', AMB]);
  // A saved former manager is pinned BEFORE it; «אמבולטורי» stays last and appears once.
  app.setState('houseManagers', ROSTER);
  assert.deepEqual(plain(app.meetingWithOptionNames('שחר')), ['חנן', 'רנטה', 'עידו', 'אורן', 'שחר', AMB]);
  assert.deepEqual(plain(app.meetingWithOptionNames(AMB)), ['חנן', 'רנטה', 'עידו', 'אורן', AMB]);
  const field = app.meetingWithField('');
  assert.equal(field.options[field.options.length - 1].value, AMB);
  const editModal = APP_SRC.slice(APP_SRC.indexOf('function openMeetingEditModal('), APP_SRC.indexOf('function openMeetingEditModal(') + 1500);
  assert.ok(editModal.includes('meetingWithOptionNames(m.meetingWith)'), 'the meeting edit modal uses the same list');
});

test('option: «אמבולטורי» is never a manager — not from currentManagers, not a house default, not in the summary strip', () => {
  const { app } = loadApp();
  app.setState('houseManagers', ROSTER);
  app.setState('currentManagers', [{ house: 'ramot', name: 'אורן' }, { house: 'asher', name: AMB }]);
  assert.ok(!plain(app.managerOptions()).includes(AMB), 'filtered even when a tab row names it');
  assert.equal(selectedValue(app.meetingWithSelectHTML({ house: 'רמות השבים', meetingWith: '' })), 'אורן');
  const strip = app.meetingsSummaryHTML([
    { id: '1', meetingWith: 'אורן', meetingOutcome: 'entered' },
    { id: '2', meetingWith: AMB, meetingOutcome: 'entered' },
  ]);
  assert.ok(strip.includes('אורן'));
  assert.ok(!strip.includes(AMB), 'no «אמבולטורי» manager row');
  assert.ok(!strip.includes('ללא מנהל'), 'no «ללא מנהל» artifact');
  assert.equal(app.meetingsSummaryHTML([{ id: '2', meetingWith: AMB, meetingOutcome: 'entered' }]), '', 'nothing to show → no strip');
});

test('Code.gs: currentManagers_ never lists «אמבולטורי» (Managers tab and bonusconfig), so it is never a meeting-report reporter', () => {
  const w = world({ managers: [{ house: 'ramot', manager_name: 'אורן' }, { house: 'raanana', manager_name: AMB }, { house: 'raanana', manager_name: 'שחר' }] });
  const cm = plain(w.s.currentManagers_('2026-10-26'));
  assert.equal(cm.source, 'managers');
  assert.ok(!cm.managers.some((m) => m.name === AMB));
  assert.ok(cm.managers.some((m) => m.name === 'שחר'));
  const rep = plain(w.s.meetingReportManagers_('2026-10-26'));
  assert.ok(!rep.managers.some((m) => m.name === AMB), 'the reporter list (and its server check) never offers it');
  assert.equal(w.g.run('MEETING_WITH_AMBULATORY'), AMB);
  assert.ok(!Object.values(plain(w.g.run('HOUSE_MANAGERS'))).includes(AMB));
});

/* ===== 2. Preserved on edit / re-render; autosave never touches it ===== */

test('preserved: a saved «אמבולטורי» stays selected on the card and the modal field; the autosave never fills or overwrites it', async () => {
  const { app } = loadApp();
  app.setState('houseManagers', ROSTER);
  app.setState('mode', 'edit');
  const saved = { id: 'A', stage: 'visit', house: 'רמות השבים', meetingWith: AMB };
  assert.equal(selectedValue(app.meetingWithSelectHTML(saved)), AMB);
  assert.equal(app.meetingWithField(AMB).value, AMB);
  assert.deepEqual(plain(app.leadsNeedingMeetingWithDefault([saved], ROSTER)), []);
  app.setState('leads', [saved]);
  const calls = app.stubSaveAll();
  await app.autosaveMeetingWithDefaults();
  assert.equal(calls.length, 0, 'no save fired');
  assert.equal(app.getState('leads')[0].meetingWith, AMB);
});

test('preserved: Code.gs saveAll_ round-trips «אמבולטורי» and keeps it on a later save of other fields', () => {
  const w = world({ leads: [lead()] });
  w.save([lead({ meetingWith: AMB })]);
  w.save([lead({ meetingWith: AMB, visitTime: '11:00' })]);
  assert.equal(w.leads()[0].meetingWith, AMB);
  assert.equal(w.leads()[0].visitTime, '11:00');
});

/* ===== 3. Bonus: never credited to a house ===== */

test('bonus: managerHouseByName_ yields no house for «אמבולטורי» — even if a Managers row carried that name', () => {
  const w = world();
  const asOf = w.s.parseDate_('2026-10-10');
  const managers = [{ house: 'ramot', manager_name: AMB, start_date: '', end_date: '' }];
  assert.equal(w.s.managerHouseByName_(managers, AMB, asOf), '');
  assert.equal(w.s.managerHouseByName_([{ house: 'ramot', manager_name: 'אורן' }], 'אורן', asOf), 'ramot', 'a real manager still credits');
});

test('bonus: computeIntakeMeetingsByHouse_ credits no house for a 7th admission whose meeting was «אמבולטורי»', () => {
  const w = world();
  w.s.Session = { getScriptTimeZone: () => 'Asia/Jerusalem' };
  const p = (i, entry, fromLead) => ({ houseId: 'ramot', name: 'p' + i, entry: w.s.parseDate_(entry), exit: null, fromLead });
  const patients = [0, 1, 2, 3, 4, 5].map((i) => p(i, '2026-08-01', ''));
  patients.push(p(6, '2026-10-05', 'LA'), p(7, '2026-10-06', 'LO'));
  const managers = [{ house: 'ramot', manager_name: 'אורן' }, { house: 'raanana', manager_name: AMB }];
  const out = plain(w.s.computeIntakeMeetingsByHouse_(patients, managers, { LA: AMB, LO: 'אורן' }, '2026-10', w.s.parseDate_('2026-11-20')));
  const credited = Object.keys(out).reduce((n, h) => n + out[h].confirmed + out[h].pending, 0);
  assert.equal(credited, 1, 'only the real manager\'s meeting');
  assert.deepEqual(out.ramot.items.map((i) => i.name), ['p7']);
  assert.equal(out.raanana.confirmed + out.raanana.pending, 0);
});

/* ===== 4. The handoff rule (Code.gs) ===== */

test('handoff: the first choice of «אמבולטורי» lists the lead — name, phone, note, source, NO house', () => {
  const w = world({ leads: [lead({ meetingWith: 'אורן' })] });
  const res = w.save([lead({ meetingWith: AMB })]);
  assert.equal(res.ok, true);
  assert.deepEqual(res.ambulatoryHandoff, [{ leadId: 'L1', name: 'דנה לוי', phone: '0521234567', note: 'הערה', source: 'facebook' }]);
  assert.ok(!('house' in res.ambulatoryHandoff[0]) && !('preferredHouse' in res.ambulatoryHandoff[0]));
  // A brand-new lead created with «אמבולטורי» counts as a change too.
  const w2 = world();
  assert.equal(w2.save([lead({ id: 'N1', meetingWith: AMB })]).ambulatoryHandoff[0].leadId, 'N1');
});

test('handoff: no resend — after a recorded send, an unchanged save, and a change away and back, list nothing', () => {
  const w = world({ leads: [lead()] });
  assert.equal(w.save([lead({ meetingWith: AMB })]).ambulatoryHandoff.length, 1);
  assert.equal(w.record({ leadId: 'L1', sent: true, outpatientId: 'op-9' }).ok, true);
  assert.equal(w.save([lead({ meetingWith: AMB })]).ambulatoryHandoff, undefined, 'unchanged');
  assert.equal(w.save([lead({ meetingWith: 'אורן' })]).ambulatoryHandoff, undefined);
  assert.equal(w.save([lead({ meetingWith: AMB })]).ambulatoryHandoff, undefined, 'away and back');
  // A second `sent` record writes nothing.
  assert.equal(w.record({ leadId: 'L1', sent: true }).duplicate, true);
  const sentRows = w.audit().filter((r) => r.action === 'outpatient_lead_sent');
  assert.equal(sentRows.length, 1);
  assert.equal(sentRows[0].patientId, 'L1');
  assert.ok(!JSON.stringify(sentRows[0]).includes('0521234567'), 'no phone in the audit row');
});

test('handoff: an unchanged «אמבולטורי» that was never attempted is not sent; a different lead\'s value is not touched', () => {
  const w = world({ leads: [lead({ meetingWith: AMB }), lead({ id: 'L2', name: 'יוסי כהן', meetingWith: 'אורן' })] });
  const res = w.save([lead({ meetingWith: AMB }), lead({ id: 'L2', name: 'יוסי כהן', meetingWith: 'אורן' })]);
  assert.equal(res.ambulatoryHandoff, undefined);
});

test('handoff: retry after a failure — the next save lists it again until a send is recorded', () => {
  const w = world({ leads: [lead()] });
  assert.equal(w.save([lead({ meetingWith: AMB })]).ambulatoryHandoff.length, 1);
  w.record({ leadId: 'L1', sent: false, error: 'outpatient_timeout' });
  assert.equal(w.save([lead({ meetingWith: AMB })]).ambulatoryHandoff.length, 1, 'retried');
  w.record({ leadId: 'L1', sent: false, error: 'outpatient_unreachable' });
  assert.equal(w.save([lead({ meetingWith: AMB })]).ambulatoryHandoff.length, 1, 'retried again');
  w.record({ leadId: 'L1', sent: true });
  assert.equal(w.save([lead({ meetingWith: AMB })]).ambulatoryHandoff, undefined, 'sent → done');
  assert.deepEqual(w.audit().map((r) => r.action), ['outpatient_lead_send_failed', 'outpatient_lead_send_failed', 'outpatient_lead_sent']);
  // A failure that moved away from «אמבולטורי» is not retried.
  const w2 = world({ leads: [lead()] });
  w2.save([lead({ meetingWith: AMB })]);
  w2.record({ leadId: 'L1', sent: false, error: 'no_phone' });
  assert.equal(w2.save([lead({ meetingWith: 'אורן' })]).ambulatoryHandoff, undefined);
});

test('handoff: the lead is never closed or moved — stage, row and sheet unchanged', () => {
  const w = world({ leads: [lead()] });
  w.save([lead({ meetingWith: AMB })]);
  w.record({ leadId: 'L1', sent: true });
  const rows = w.leads();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].stage, 'visit');
  assert.equal(rows[0].visitDate, '2026-10-28');
  assert.equal(w.s.__sheets['לידים לא רלוונטיים'], undefined);
  assert.equal(w.s.__sheets['לידים שהוסרו'], undefined);
});

test('handoff: a lead without a valid phone is listed with phone \'\' (server.js then refuses to send it)', () => {
  const w = world({ leads: [lead({ phone: '' })] });
  const res = w.save([lead({ phone: '', meetingWith: AMB })]);
  assert.equal(res.ok, true, 'the meeting still saves');
  assert.equal(res.ambulatoryHandoff[0].phone, '');
});

test('handoff: values are cut to safe cell text (no formula lead-in, no control chars, capped)', () => {
  const w = world({ leads: [lead()] });
  const res = w.save([lead({ meetingWith: AMB, note: '=HYPERLINK("x")\u0007' + 'א'.repeat(600), source: '+cmd' })]);
  const h = res.ambulatoryHandoff[0];
  assert.ok(!h.note.startsWith('='));
  assert.ok(!/[\u0000-\u001f]/.test(h.note));
  assert.ok(h.note.length <= 400);
  assert.equal(h.source, 'cmd');
});

test('recordOutpatientLeadSend_: verified proxy callers only; unknown lead refused; bad error codes normalized', () => {
  const w = world({ leads: [lead()] });
  assert.equal(plain(w.s.recordOutpatientLeadSend_({ leadId: 'L1', sent: true })).error, 'unauthorized');
  assert.equal(w.record({ leadId: 'NOPE', sent: true }).error, 'lead_not_found');
  assert.equal(w.record({ leadId: '', sent: true }).error, 'bad_lead_id');
  w.record({ leadId: 'L1', sent: false, error: '<script>' });
  assert.equal(JSON.parse(w.audit()[0].details).error, 'send_failed');
  assert.ok(Array.from(w.g.run('PROXY_KNOWN_ACTIONS')).includes('recordOutpatientLeadSend'));
  assert.match(GS_SRC, /if \(action === 'recordOutpatientLeadSend'\) return jsonOut_\(recordOutpatientLeadSend_\(params\)\);/);
});

test('getData: outpatientSentLeadIds lists the sent lead ids only', () => {
  const w = world({ leads: [lead(), lead({ id: 'L2', name: 'יוסי כהן' })] });
  w.save([lead({ meetingWith: AMB }), lead({ id: 'L2', name: 'יוסי כהן', meetingWith: AMB })]);
  w.record({ leadId: 'L1', sent: true });
  w.record({ leadId: 'L2', sent: false, error: 'no_phone' });
  assert.deepEqual(plain(w.s.outpatientLeadSendLog_()).sent, { L1: true });
  assert.match(GS_SRC, /outpatientSentLeadIds: Object\.keys\(outpatientLeadSendLog_\(\)\.sent\)/);
});

test('managersWork visits: a «אמבולטורי» meeting is a normal visit row (no error, its own name)', () => {
  const w = world({ leads: [lead({ house: 'ramot', meetingWith: AMB })] });
  w.s.__props.MANAGERS_WORK_SECRET = 'mw-s3cret';
  w.s.Session = { getScriptTimeZone: () => 'Asia/Jerusalem' };
  w.s.Utilities.formatDate = (d, tz, fmt) => {
    const x = new Date(d); const p = (n) => (n < 10 ? '0' + n : '' + n);
    if (fmt === 'HH:mm') return `${p(x.getHours())}:${p(x.getMinutes())}`;
    if (fmt === 'yyyy-MM') return `${x.getFullYear()}-${p(x.getMonth() + 1)}`;
    return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
  };
  const res = plain(w.g.post({ action: 'managersWork', secret: 'mw-s3cret', op: 'houseData', month: '2026-10',
    house: 'ramot', role: 'manager', actor: 'אורן', actorId: 'person-oran' }));
  assert.equal(res.ok, true, JSON.stringify(res).slice(0, 200));
  assert.deepEqual(res.visits.map((v) => v.meetingWith), [AMB]);
});

/* ===== 5. server.js half ===== */

test('lib: a send that succeeds is recorded as sent; nothing else is sent; no warning', async () => {
  const sends = []; const records = [];
  const out = await handoffLib.handOffAmbulatoryLeads(
    [{ leadId: 'L1', name: 'דנה לוי', phone: '0521234567', note: 'הערה', source: 'facebook', house: 'ramot' }],
    { send: async (f) => { sends.push(f); return { outcome: 'answered', data: { ok: true, id: 'op-1' } }; },
      record: async (r) => { records.push(r); } });
  assert.deepEqual(out, { sent: ['L1'], failed: [] });
  assert.deepEqual(sends, [{ name: 'דנה לוי', phone: '0521234567', note: 'הערה', source: 'facebook' }], 'no house');
  assert.deepEqual(records, [{ leadId: 'L1', sent: true, error: '', outpatientId: 'op-1' }]);
});

test('lib: no phone → never sent, recorded no_phone, Hebrew warning', async () => {
  let sent = 0; const records = [];
  const out = await handoffLib.handOffAmbulatoryLeads([{ leadId: 'L1', name: 'דנה לוי', phone: '' }],
    { send: async () => { sent++; }, record: async (r) => { records.push(r); } });
  assert.equal(sent, 0);
  assert.deepEqual(out, { sent: [], failed: ['L1'], warning: WARN_HE });
  assert.equal(records[0].error, 'no_phone');
  assert.equal(records[0].sent, false);
});

test('lib: Outpatient failure / refusal / timeout / not configured / a throwing send → failed + warning, never throws', async () => {
  const cases = [
    [{ outcome: 'unreachable', message: 'x' }, 'outpatient_unreachable'],
    [{ outcome: 'answered', data: { ok: false, error: 'unauthorized' } }, 'outpatient_refused'],
    [{ outcome: 'timeout' }, 'outpatient_timeout'],
    [{ outcome: 'not_configured' }, 'outpatient_not_configured'],
    ['throw', 'outpatient_unreachable'],
  ];
  for (const [result, code] of cases) {
    const records = [];
    const out = await handoffLib.handOffAmbulatoryLeads([{ leadId: 'L1', name: 'דנה לוי', phone: '0521234567' }], {
      send: async () => { if (result === 'throw') throw new Error('boom'); return result; },
      record: async (r) => { records.push(r); throw new Error('record down'); },   // a record failure is swallowed too
    });
    assert.deepEqual(out.failed, ['L1'], code);
    assert.equal(out.warning, WARN_HE);
    assert.equal(records[0].error, code);
  }
});

test('lib: a lead whose send is already in flight is not sent twice; items are capped and cleaned', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let sends = 0;
  const deps = { send: async () => { sends++; await gate; return { outcome: 'answered', data: { ok: true } }; }, record: async () => {} };
  const first = handoffLib.handOffAmbulatoryLeads([{ leadId: 'L1', phone: '0521234567' }], deps);
  const second = await handoffLib.handOffAmbulatoryLeads([{ leadId: 'L1', phone: '0521234567' }], deps);
  release();
  assert.deepEqual(await first, { sent: ['L1'], failed: [] });
  assert.deepEqual(second, { sent: [], failed: [] });
  assert.equal(sends, 1);
  assert.equal(handoffLib.cleanItem({ leadId: '', name: 'x' }), null);
  assert.equal(handoffLib.cleanItem({ leadId: 'L\n1', name: 'א'.repeat(500) }).name.length, 100);
});

const server = require('../server');

test('server: sendToOutpatient — fail-closed without URL/secret, secret in the body only, house only when given, timeout', async () => {
  assert.deepEqual(await server.sendToOutpatient({ name: 'x' }, { url: '', secret: 's' }), { outcome: 'not_configured' });
  assert.deepEqual(await server.sendToOutpatient({ name: 'x' }, { url: 'https://x', secret: '' }), { outcome: 'not_configured' });
  let body = null;
  const ok = await server.sendToOutpatient({ name: 'דנה לוי', phone: '0521234567', note: 'n', source: 'facebook' },
    { url: 'https://x', secret: 'sek', post: async (b) => { body = b; return { ok: true, id: 'op-1' }; } });
  assert.deepEqual(ok, { outcome: 'answered', data: { ok: true, id: 'op-1' } });
  assert.deepEqual(body, { secret: 'sek', name: 'דנה לוי', phone: '0521234567', note: 'n', source: 'facebook' });
  assert.ok(!('house' in body), 'the ambulatory handoff sends no house');
  const late = await server.sendToOutpatient({ name: 'x' }, { url: 'https://x', secret: 'sek', timeoutMs: 20, post: () => new Promise(() => {}) });
  assert.deepEqual(late, { outcome: 'timeout' });
  const bad = await server.sendToOutpatient({ name: 'x' }, { url: 'https://x', secret: 'sek', post: async () => { throw new Error('HTTP 500 sek'); } });
  assert.equal(bad.outcome, 'unreachable');
});

test('server: applyAmbulatoryHandoff strips the PII list, records each outcome via recordOutpatientLeadSend, answers { sent, failed, warning }', async () => {
  const posts = [];
  const data = { ok: true, written: {}, ambulatoryHandoff: [{ leadId: 'L1', name: 'דנה לוי', phone: '0521234567' }, { leadId: 'L2', name: 'יוסי כהן', phone: '' }] };
  const out = await server.applyAmbulatoryHandoff(data, 'ורד', null, {
    send: async () => ({ outcome: 'answered', data: { ok: true, id: 'op-1' } }),
    sheetsPost: async (b) => { posts.push(b); return { ok: true }; },
  });
  assert.equal(out.ambulatoryHandoff, undefined);
  assert.ok(!JSON.stringify(out).includes('0521234567'));
  assert.deepEqual(out.ambulatory, { sent: ['L1'], failed: ['L2'], warning: WARN_HE });
  assert.deepEqual(posts.map((p) => [p.action, p.leadId, p.sent, p.error, p.user]),
    [['recordOutpatientLeadSend', 'L1', true, '', 'ורד'], ['recordOutpatientLeadSend', 'L2', false, 'no_phone', 'ורד']]);
  // A refused save never sends; an answer without the key is untouched.
  const refused = await server.applyAmbulatoryHandoff({ ok: false, ambulatoryHandoff: [{ leadId: 'L1', phone: '0521234567' }] }, '', null,
    { send: async () => { throw new Error('must not send'); }, sheetsPost: async () => { throw new Error('must not record'); } });
  assert.deepEqual(refused, { ok: false });
  assert.deepEqual(await server.applyAmbulatoryHandoff({ ok: true }, '', null, {}), { ok: true });
});

test('server: recordOutpatientLeadSend is server-only — a browser call gets 403, nothing proxied', () => {
  assert.ok(Array.from(server.SERVER_ONLY_ACTIONS).includes('recordOutpatientLeadSend'));
  for (const method of ['GET', 'POST']) {
    let status = 0; let body = null; let nexted = false;
    const req = method === 'GET' ? { method, query: { action: 'recordOutpatientLeadSend' } } : { method, body: { action: 'recordOutpatientLeadSend', leadId: 'L1', sent: true } };
    server.refuseServerOnlyActions(req, { status(s) { status = s; return this; }, json(b) { body = b; } }, () => { nexted = true; });
    assert.equal(status, 403, method);
    assert.equal(body.error, 'forbidden');
    assert.equal(nexted, false);
  }
  let nexted = false;
  server.refuseServerOnlyActions({ method: 'POST', body: { action: 'saveAll' } }, {}, () => { nexted = true; });
  assert.equal(nexted, true);
  const SRV = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.match(SRV, /app\.post\('\/api\/sheets', requireSession, refuseServerOnlyActions,/);
  assert.match(SRV, /app\.get\('\/api\/sheets', requireSession, refuseServerOnlyActions,/);
  assert.match(SRV, /if \(summary\.action === 'saveAll'\) data = await applyAmbulatoryHandoff\(data, body\.user, principal\);/);
});

/* ===== 6. Client: chip, warning, board, WhatsApp, escaping, busy pattern ===== */

test('chip: «נשלח לאמבולטורי» shows only for a sent lead; getData ids and a save answer feed it', () => {
  const { app } = loadApp();
  const ids = app.normalizeOutpatientSentIds(['L1', ' ', null, 'L2 ']);
  assert.deepEqual([...ids], ['L1', 'L2']);
  assert.match(app.ambulatorySentChipHTML({ id: 'L1' }, ids), /class="lc-amb-chip"[^>]*>נשלח לאמבולטורי<\/div>/);
  assert.equal(app.ambulatorySentChipHTML({ id: 'L9' }, ids), '');
  assert.equal(app.normalizeOutpatientSentIds(undefined).size, 0, 'an older backend → no chip');
  app.setState('outpatientSentLeadIds', new Set());
  assert.equal(app.applyAmbulatoryOutcome({ ok: true, ambulatory: { sent: ['L3'], failed: [] } }), '');
  assert.ok(app.getState('outpatientSentLeadIds').has('L3'));
  assert.match(APP_SRC, /\$\{ambulatorySentChipHTML\(lead\)\}/);
  assert.match(CSS_SRC, /\.lead-card \.lc-amb-chip[,\s{]/);
});

test('warning: a failed send shows the Hebrew warning (the meeting is saved); no `ambulatory` key → nothing', () => {
  const { app, banner } = loadApp();
  assert.equal(app.applyAmbulatoryOutcome({ ok: true, ambulatory: { sent: [], failed: ['L1'], warning: WARN_HE } }), WARN_HE);
  assert.ok(banner.textContent.includes(WARN_HE));
  assert.equal(app.applyAmbulatoryOutcome({ ok: true, ambulatory: { sent: [], failed: ['L1'] } }), WARN_HE, 'fallback text');
  assert.equal(app.applyAmbulatoryOutcome({ ok: true }), '');
  assert.match(APP_SRC, /applySaveOutcome\(sent, res\);\n\s+applyAmbulatoryOutcome\(res\);/);
});

test('board: a «אמבולטורי» meeting lists with its name; the WhatsApp button is disabled unless a phone is configured', () => {
  const { app } = loadApp();
  app.setState('mode', 'edit');
  const wk = app.meetingsForWeek([{ id: 'A', name: 'דנה לוי', house: 'רמות השבים', visitDate: '2026-10-28', visitTime: '10:00', meetingWith: AMB }], '2026-10-26');
  assert.equal(wk.total, 1);
  const m = wk.days.find((d) => d.timed.length).timed[0];
  assert.equal(m.meetingWith, AMB);
  assert.equal(app.meetingWhatsappUrl(m, { 'אורן': '972500000000' }), '');
  const row = app.meetingRowHTML(m, undefined, false);
  assert.match(row, /<span class="mtg-with">אמבולטורי<\/span>/);
  assert.match(row, /<button type="button" class="mtg-wa" disabled/);
  assert.ok(!row.includes('ללא מנהל'));
  assert.match(app.meetingWhatsappUrl(m, { [AMB]: '972500000001' }), /^https:\/\/wa\.me\/972500000001\?text=/);
});

test('escaping: a hostile saved meetingWith is escaped in the select and on the board', () => {
  const { app } = loadApp();
  const evil = '<img src=x onerror=alert(1)>';
  const sel = app.meetingWithSelectHTML({ house: '', meetingWith: evil }, ROSTER);
  assert.ok(!sel.includes('<img'));
  assert.ok(sel.includes('&lt;img src=x onerror=alert(1)&gt;'));
  const row = app.meetingRowHTML({ id: '"><x', name: evil, houseLabel: evil, meetingWith: evil, date: '2026-10-28', time: '' }, '—', false);
  assert.ok(!row.includes('<img'));
  assert.equal(app.ambulatorySentChipHTML({ id: evil }, new Set([evil])).includes('<img'), false);
});

test('busy pattern: the lead-card select saves through withFieldSaving, the meeting edit modal through busyButton', () => {
  assert.match(APP_SRC, /return withFieldSaving\(inp, 'save', \(\) => updateLead\(lead\.id, \{ \[field\]: inp\.value \}\)\)/);
  const editModal = APP_SRC.slice(APP_SRC.indexOf('function openMeetingEditModal('), APP_SRC.indexOf('function renderAll()'));
  assert.match(editModal, /return busyButton\(submitBtn, 'save', async \(\) => \{/);
});

test('SW: CACHE_VERSION bumped from the live v90 to v91 with its comment (v17 never reused; later bumps stay monotonic)', () => {
  assert.ok(Number(/var CACHE_VERSION = 'v(\d+)';/.exec(SW_SRC)[1]) >= 91);
  assert.ok(SW_SRC.includes('v90 → v91:'));
});
