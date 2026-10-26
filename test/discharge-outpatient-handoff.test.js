'use strict';

/* Discharged patient → Outpatient, «העבר לאמבולטורי», the missing-from-
 * Outpatient report, and restore matching (CHANGELOG-discharge-outpatient-handoff.md).
 *
 * The REAL apps-script/Code.gs (vm sandbox, in-memory spreadsheet), the REAL
 * public/app.js (vm sandbox) and the REAL server.js helper with injected
 * sends — no network, no secret. Every name and phone is SYNTHETIC. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadGs, richSheet } = require('./helpers/gs-sandbox');

const ROOT = path.join(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const SW_SRC = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');
const CSS_SRC = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
const plain = (v) => JSON.parse(JSON.stringify(v));
const RLM = '\u200f';   // an invisible bidi mark, as pasted from WhatsApp

/* ---------- Code.gs ---------- */
function world({ leads = [], irrelevant = [], patients = [], discharged = [], outpatients = [] } = {}) {
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
  if (irrelevant.length) put(g.run('IRRELEVANT_LEADS_SHEET'), 'IRRELEVANT_LEAD_COLUMNS', irrelevant);
  put(g.run('PATIENTS_SHEET'), 'PATIENT_COLUMNS', patients);
  put(g.run('DISCHARGED_PATIENTS_SHEET'), 'DISCHARGED_PATIENT_COLUMNS', discharged);
  if (outpatients.length) put('Outpatients', 'OUTPATIENT_COLUMNS', outpatients);
  const verified = { verified: true, user: 'ורד', id: 'vered', auth: 'personal', roles: ['editor'], caps: [] };
  return {
    g, s,
    prep: (p) => plain(s.dischargeOutpatientPayload_(Object.assign({ __actor: verified }, p))),
    record: (p) => plain(s.recordOutpatientLeadSend_(Object.assign({ __actor: verified }, p))),
    audit: () => g.sheetRows('AuditLog', 'AUDIT_LOG_COLUMNS'),
    patientsRows: () => g.sheetRows(g.run('PATIENTS_SHEET'), 'PATIENT_COLUMNS'),
  };
}
const DROW = (over) => Object.assign({
  id: 'aud-1', houseId: 'ramot', name: 'דנה לוי', date: '2026-08-01', status: 'released', exitDate: '2026-10-20',
  fromLead: 'L1', source: 'ליד', notes: 'הערה', disposition: 'released_outpatient', continuity: 'continued_outpatient',
  restored: '', deletedAt: '',
}, over || {});
const LEAD = { id: 'L1', name: 'דנה לוי', phone: '052-123-4567', stage: 'admitted' };

test('payload: «משוחרר לטיפול חוץ» row → name, phone from the source lead, house KEY, note = source + notes', () => {
  const w = world({ leads: [LEAD], discharged: [DROW()] });
  assert.deepEqual(w.prep({ dischargeId: 'aud-1' }), {
    ok: true, key: 'discharge:aud-1',
    payload: { name: 'דנה לוי', phone: '0521234567', house: 'ramot', note: 'ליד — הערה' },
  });
});

test('payload: the phone is found on the closed-leads tab too; none anywhere → \'\'', () => {
  const w = world({ irrelevant: [Object.assign({}, LEAD, { stage: 'irrelevant' })], discharged: [DROW()] });
  assert.equal(w.prep({ dischargeId: 'aud-1' }).payload.phone, '0521234567');
  const w2 = world({ discharged: [DROW()] });
  assert.equal(w2.prep({ dischargeId: 'aud-1' }).payload.phone, '');
});

test('payload: automatic send only for «משוחרר לטיפול חוץ»; «העבר לאמבולטורי» (manual) for any open row', () => {
  const w = world({ leads: [LEAD], discharged: [DROW({ disposition: 'completed' })] });
  assert.deepEqual(w.prep({ dischargeId: 'aud-1' }), { ok: true, eligible: false });
  assert.equal(w.prep({ dischargeId: 'aud-1', manual: true }).key, 'discharge:aud-1');
});

test('payload: unknown, restored and deleted rows are refused; unverified callers too', () => {
  const w = world({ discharged: [DROW(), DROW({ id: 'aud-r', restored: 'TRUE' }), DROW({ id: 'aud-d', deletedAt: '2026-10-21T00:00:00Z' })] });
  assert.equal(w.prep({ dischargeId: 'nope' }).error, 'not_found');
  assert.equal(w.prep({ dischargeId: 'aud-r' }).error, 'not_open');
  assert.equal(w.prep({ dischargeId: 'aud-d' }).error, 'not_open');
  assert.equal(w.prep({ dischargeId: '' }).error, 'bad_discharge_id');
  assert.equal(plain(w.s.dischargeOutpatientPayload_({ dischargeId: 'aud-1' })).error, 'unauthorized');
});

test('idempotent: a recorded send → alreadySent; a second `sent` writes nothing; a failure leaves it sendable', () => {
  const w = world({ leads: [LEAD], discharged: [DROW()] });
  w.record({ dischargeId: 'aud-1', sent: false, error: 'outpatient_timeout' });
  assert.equal(w.prep({ dischargeId: 'aud-1' }).key, 'discharge:aud-1', 'a failure can be retried');
  assert.equal(w.record({ dischargeId: 'aud-1', sent: true, outpatientId: 'op-1' }).sent, true);
  assert.deepEqual(w.prep({ dischargeId: 'aud-1' }), { ok: true, alreadySent: true, key: 'discharge:aud-1' });
  assert.equal(w.record({ dischargeId: 'aud-1', sent: true }).duplicate, true);
  const rows = w.audit();
  assert.deepEqual(rows.map((r) => [r.action, r.patientId]),
    [['outpatient_lead_send_failed', 'discharge:aud-1'], ['outpatient_lead_sent', 'discharge:aud-1']]);
  assert.ok(!JSON.stringify(rows).includes('0521234567'), 'no phone in AuditLog');
  assert.equal(w.record({ dischargeId: 'nope', sent: true }).error, 'not_found');
  // getData's outpatientSentLeadIds carries the key (the row's chip).
  assert.deepEqual(Object.keys(plain(w.s.outpatientLeadSendLog_()).sent), ['discharge:aud-1']);
});

test('restore: a rebuilt row carrying the open discharge row\'s own id lands; any other new row with that lead is still refused', () => {
  const w = world({ discharged: [DROW()] });
  const rebuilt = { id: 'aud-1', houseId: 'ramot', name: 'דנה לוי', date: '2026-08-01', status: 'active', fromLead: 'L1', source: 'lead' };
  const ok = plain(w.s.saveAll_(undefined, { ramot: [rebuilt] }, 'ורד'));
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.promoteSkipped, {});
  assert.equal(w.patientsRows().length, 1);
  const w2 = world({ discharged: [DROW()] });
  const res = plain(w2.s.saveAll_(undefined, { ramot: [Object.assign({}, rebuilt, { id: 'other' })] }, 'ורד'));
  assert.equal(res.promoteSkipped.ramot[0].reason, 'discharged_not_restored');
  // A rebuilt row that is itself 'released' is not a restore.
  const w3 = world({ discharged: [DROW()] });
  const res3 = plain(w3.s.saveAll_(undefined, { ramot: [Object.assign({}, rebuilt, { status: 'released' })] }, 'ורד'));
  assert.equal(res3.promoteSkipped.ramot[0].reason, 'discharged_not_restored');
});

/* ---------- the report ---------- */

test('report rows: «טיפול חוץ» / «המשיך באמבולטורי» not sent and not on the Outpatients tab; sent, listed, closed rows excluded', () => {
  const w = world();
  const log = { sent: { 'discharge:sent': true }, failed: { 'discharge:failed': true } };
  const rows = [
    DROW({ id: 'missing' }),
    DROW({ id: 'cont', disposition: '', continuity: 'continued_outpatient', name: 'יוסי כהן' }),
    DROW({ id: 'sent', name: 'שלום א' }),
    DROW({ id: 'failed', name: 'רונית ב' }),
    DROW({ id: 'listed', name: 'מיכל ג' + RLM }),
    DROW({ id: 'other', disposition: 'completed', continuity: 'none', name: 'אבי ד' }),
    DROW({ id: 'restored', restored: 'TRUE', name: 'נעמה ה' }),
  ];
  const out = plain(w.s.outpatientMissingRows_(rows, log, [{ patient_name: '  מיכל  ג ' }]));
  assert.deepEqual(out.map((r) => [r.id, r.attempt]), [['missing', 'none'], ['cont', 'none'], ['failed', 'failed']]);
});

test('report rows: unmatched discharge rows — patientId / exact triple match is fine; an invisible-mark name is listed, flagged «נמצא אחרי ניקוי»', () => {
  const w = world();
  const patients = [
    { id: 'p1', houseId: 'ramot', name: 'דנה לוי', date: '2026-08-01' },
    { id: 'p2', houseId: 'ramot', name: 'אביב שבתאי', date: '2026-07-13' },
  ];
  const rows = [
    DROW({ id: 'exact' }),
    DROW({ id: 'byid', patientId: 'p1', name: 'שם אחר' }),
    DROW({ id: 'dirty', name: 'אביב' + RLM + ' שבתאי', date: '2026-07-13' }),
    DROW({ id: 'gone', name: 'אין כזה', date: '2026-01-01' }),
  ];
  assert.deepEqual(plain(w.s.unmatchedDischargeRows_(rows, patients)).map((r) => [r.id, r.normalizedMatch]),
    [['dirty', true], ['gone', false]]);
});

test('report: editor-run, one new Doc, read-only on the sheet, no names in the log', () => {
  const w = world({ discharged: [DROW()], patients: [{ id: 'p1', houseId: 'ramot', name: 'דנה לוי', date: '2026-08-01' }] });
  // The Doc helpers are covered by the reconciliation-report suite; here they
  // only collect what the report writes.
  const texts = [];
  w.s.recDocPara_ = (_b, t) => { texts.push(String(t)); };
  w.s.recDocTable_ = (_b, rows) => { texts.push(JSON.stringify(rows)); };
  w.s.DocumentApp = {
    ParagraphHeading: { TITLE: 'T', HEADING2: 'H2' },
    create: () => ({ getBody: () => ({ getParagraphs: () => [] }), saveAndClose() {}, getUrl: () => 'https://docs.example/d/1' }),
  };
  const before = JSON.stringify(w.s.__sheets[w.g.run('DISCHARGED_PATIENTS_SHEET')].grid);
  const res = plain(w.s.outpatientMissingReportNow());
  assert.equal(res.missing.length, 1);
  assert.equal(res.unmatched.length, 0);
  assert.equal(res.url, 'https://docs.example/d/1');
  assert.ok(texts.some((t) => t.includes('דנה לוי') && t.includes('לא מאומת')), 'the row is in the Doc');
  assert.equal(JSON.stringify(w.s.__sheets[w.g.run('DISCHARGED_PATIENTS_SHEET')].grid), before);
  assert.equal(w.s.__sheets.AuditLog, undefined, 'nothing logged to AuditLog');
  const logLine = w.g.logs.join('\n');
  assert.match(logLine, /Missing: 1, unmatched discharge rows: 0/);
  assert.ok(!logLine.includes('דנה'), 'no names in the log');
  // Not reachable over HTTP.
  assert.ok(!Array.from(w.g.run('PROXY_KNOWN_ACTIONS')).includes('outpatientMissingReportNow'));
});

/* ---------- server.js ---------- */

const server = require('../server');
function srv(prep, sendResult) {
  const posts = []; const sends = [];
  return {
    posts, sends,
    deps: {
      sheetsPost: async (b) => { posts.push(b); return b.action === 'dischargeOutpatientPayload' ? prep : { ok: true }; },
      send: async (f) => { sends.push(f); return sendResult; },
    },
  };
}
const PREP = { ok: true, key: 'discharge:aud-1', payload: { name: 'דנה לוי', phone: '0521234567', house: 'ramot', note: 'ליד' } };

test('server: a «טיפול חוץ» row is sent once through sendToOutpatient — house included — and recorded', async () => {
  const t = srv(PREP, { outcome: 'answered', data: { ok: true, id: 'op-7' } });
  const r = await server.dischargeOutpatientHandoff({ dischargeId: 'aud-1' }, 'ורד', null, t.deps);
  assert.deepEqual(r, { status: 200, body: { ok: true, sent: true } });
  assert.deepEqual(t.sends, [{ name: 'דנה לוי', phone: '0521234567', house: 'ramot', note: 'ליד' }]);
  assert.deepEqual(t.posts.map((p) => [p.action, p.dischargeId, p.sent, p.manual, p.user]), [
    ['dischargeOutpatientPayload', 'aud-1', undefined, false, 'ורד'],
    ['recordOutpatientLeadSend', 'aud-1', true, false, 'ורד'],
  ]);
});

test('server: already sent / not «טיפול חוץ» → nothing sent', async () => {
  const a = srv({ ok: true, alreadySent: true }, null);
  assert.deepEqual(await server.dischargeOutpatientHandoff({ dischargeId: 'aud-1', manual: true }, '', null, a.deps),
    { status: 200, body: { ok: true, alreadySent: true } });
  const b = srv({ ok: true, eligible: false }, null);
  assert.deepEqual(await server.dischargeOutpatientHandoff({ dischargeId: 'aud-1' }, '', null, b.deps),
    { status: 200, body: { ok: true, skipped: 'not_outpatient' } });
  assert.equal(a.sends.length + b.sends.length, 0);
});

test('server: no phone / Outpatient failure → recorded failure + Hebrew message; bad id → 400; unknown row → 404', async () => {
  const noPhone = srv(Object.assign({}, PREP, { payload: Object.assign({}, PREP.payload, { phone: '' }) }), null);
  const r1 = await server.dischargeOutpatientHandoff({ dischargeId: 'aud-1' }, '', null, noPhone.deps);
  assert.equal(r1.status, 502);
  assert.equal(r1.body.error, 'no_phone');
  assert.equal(r1.body.message, server.DISCHARGE_OUTPATIENT_NO_PHONE_HE);
  assert.equal(noPhone.sends.length, 0);
  assert.equal(noPhone.posts[1].error, 'no_phone');
  const down = srv(PREP, { outcome: 'unreachable', message: 'x' });
  const r2 = await server.dischargeOutpatientHandoff({ dischargeId: 'aud-1' }, '', null, down.deps);
  assert.deepEqual(r2.body, { ok: false, error: 'outpatient_unreachable', message: server.DISCHARGE_OUTPATIENT_FAILED_HE });
  assert.equal(down.posts[1].sent, false);
  for (const id of ['', 'x'.repeat(201), 'a\nb', undefined]) {
    assert.equal((await server.dischargeOutpatientHandoff({ dischargeId: id }, '', null, srv(PREP, null).deps)).status, 400);
  }
  assert.equal((await server.dischargeOutpatientHandoff({ dischargeId: 'aud-1' }, '', null, srv({ ok: false, error: 'not_found' }, null).deps)).status, 404);
  const boom = { sheetsPost: async () => { throw new Error('down'); }, send: async () => null };
  assert.equal((await server.dischargeOutpatientHandoff({ dischargeId: 'aud-1' }, '', null, boom)).status, 502);
});

test('server: the payload action is server-only; the route reuses /api/outpatient-lead (no Code.gs sender)', () => {
  assert.ok(Array.from(server.SERVER_ONLY_ACTIONS).includes('dischargeOutpatientPayload'));
  const SRV = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.match(SRV, /if \(req\.body && req\.body\.dischargeId !== undefined\) \{\n\s+const r = await dischargeOutpatientHandoff\(/);
  const GS = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');
  assert.ok(!/function sendToOutpatient_/.test(GS), 'Code.gs never calls Outpatient');
  assert.ok(!/OUTPATIENT_LEAD_URL/.test(GS));
});

/* ---------- app.js ---------- */
function loadApp() {
  const epilogue = `
    globalThis.__test = {
      dischargeAuditRow, matchActivePatientIndex, buildRestoredToActivePatients,
      openDischargeAuditsFor, auditRowForReleasedPatient, healClobberedDischarges,
      dischargeSentToOutpatient, dischargeOutpatientKey,
      setState(k, v) { state[k] = v; }, getState(k) { return state[k]; },
    };
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
  vm.runInContext(APP_SRC + epilogue, sandbox);
  return sandbox.__test;
}

test('root cause (2): restore finds the patient whose name carries an invisible mark — flipped in place, no second row', () => {
  const app = loadApp();
  const patient = { id: 'p2', houseId: 'rehab', name: 'אביב שבתאי', date: '2026-07-13', status: 'released', fromLead: 'L9' };
  const audit = { id: 'aud-9', houseId: 'rehab', name: 'אביב' + RLM + ' שבתאי', date: '2026-07-13', prior_status: 'active', fromLead: 'L9' };
  const out = plain(app.buildRestoredToActivePatients([patient], audit));
  assert.equal(out.reconstructed, false);
  assert.equal(out.patients.length, 1);
  assert.equal(out.patients[0].status, 'active');
  assert.equal(out.patients[0].id, 'p2');
});

test('matching: patientId first; normalized triple next; the source-lead fallback only for a restore', () => {
  const app = loadApp();
  const ps = [
    { id: 'a', houseId: 'ramot', name: 'דנה  לוי ', date: '2026-08-01', status: 'released', fromLead: 'L1' },
    { id: 'b', houseId: 'ramot', name: 'שם שתוקן', date: '2026-08-02', status: 'released', fromLead: 'L2' },
  ];
  assert.equal(app.matchActivePatientIndex(ps, { patientId: 'b', houseId: 'x', name: 'y', date: '' }), 1);
  assert.equal(app.matchActivePatientIndex(ps, { houseId: 'ramot', name: 'דנה לוי', date: '2026-08-01' }), 0);
  const renamed = { houseId: 'ramot', name: 'שם ישן', date: '2026-07-30', fromLead: 'L2' };
  assert.equal(app.matchActivePatientIndex(ps, renamed), -1, 'the heal never matches by lead');
  assert.equal(app.matchActivePatientIndex(ps, renamed, { byFromLead: true }), 1);
  // Two released rows with that lead → ambiguous → no match.
  assert.equal(app.matchActivePatientIndex(ps.concat([Object.assign({}, ps[1], { id: 'c' })]), renamed, { byFromLead: true }), -1);
});

test('matching: open discharge rows of a stay and the released-row bridge use the same rule', () => {
  const app = loadApp();
  const p = { id: 'p1', houseId: 'ramot', name: 'דנה לוי', date: '2026-08-01' };
  const rows = [
    { id: 'd1', houseId: 'ramot', name: 'דנה' + RLM + ' לוי', date: '2026-08-01', restored: '' },
    { id: 'd2', patientId: 'p1', houseId: 'ramot', name: 'אחר', date: '2026-01-01', restored: '' },
    { id: 'd3', houseId: 'ramot', name: 'דנה לוי', date: '2026-08-01', restored: 'TRUE' },
  ];
  assert.deepEqual(plain(app.openDischargeAuditsFor(p, rows)).map((d) => d.id), ['d1', 'd2']);
  assert.equal(app.auditRowForReleasedPatient(p, rows).id, 'd1');
});

test('the Dashboard\'s own discharge rows now carry the persisted patientId', () => {
  const app = loadApp();
  const row = plain(app.dischargeAuditRow({ id: 'p1', houseId: 'ramot', name: 'דנה לוי', date: '2026-08-01', status: 'active' },
    { disposition: 'released_outpatient', note: '', dischargeDate: '2026-10-20', continuity: 'continued_outpatient' }, '2026-10-26'));
  assert.equal(row.patientId, 'p1');
  assert.notEqual(row.id, 'p1');
});

test('root cause (1): the שחרור flow sends by row id on every path once the discharge row landed', () => {
  const run = APP_SRC.slice(APP_SRC.indexOf('async function runDischarge('), APP_SRC.indexOf('function autoRefundNotice('));
  assert.match(run, /const sendOutpatient = rowId => \(shouldCreateOutpatientLead\(disposition\)\n\s+\? createOutpatientLead\(p, rowId\)/);
  assert.equal((run.match(/await sendOutpatient\(String\(auditRes\.id \|\| ''\)\);/g) || []).length, 2, 'duplicate answer: success and failed save');
  assert.equal((run.match(/await sendOutpatient\(auditRow\.id\);/g) || []).length, 2, 'own row: success and failed save');
  assert.ok(!/outpatientLeadPayload/.test(APP_SRC), 'the browser no longer builds the payload');
});

test('«העבר לאמבולטורי»: on every open discharged row in edit mode, busy pattern, chip once sent', () => {
  const app = loadApp();
  assert.equal(app.dischargeOutpatientKey(' aud-1 '), 'discharge:aud-1');
  assert.equal(app.dischargeSentToOutpatient({ id: 'aud-1' }, new Set(['discharge:aud-1'])), true);
  assert.equal(app.dischargeSentToOutpatient({ id: 'aud-2' }, new Set(['discharge:aud-1'])), false);
  const render = APP_SRC.slice(APP_SRC.indexOf('function renderDischargedPatients('), APP_SRC.indexOf('function renderDischargedPatients(') + 9000);
  assert.match(render, /ambBtn\.textContent = 'העבר לאמבולטורי';/);
  assert.match(render, /ambBtn\.onclick = \(\) => busyButton\(ambBtn, 'send', \(\) => createOutpatientLead\(p, p\.id, \{ manual: true \}\)\);/);
  assert.match(render, /chip\.textContent = AMBULATORY_SENT_CHIP_HE;/);
  assert.match(CSS_SRC, /\.irrelevant-actions \.lc-amb-chip \{/);
});

test('SW: v91 (live) → v92 with its comment; v17 never reused', () => {
  assert.ok(Number(/var CACHE_VERSION = 'v(\d+)';/.exec(SW_SRC)[1]) >= 92, 'later bumps stay monotonic');
  assert.ok(SW_SRC.includes('v91 → v92:'));
});
