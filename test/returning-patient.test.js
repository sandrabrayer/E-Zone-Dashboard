'use strict';

/* «מטופל חוזר» — returning patient (CHANGELOG-returning-patient.md).
 * A. lib/returning-patient.js: persons, unique / none / multiple / conflict.
 * B. app.js: the pre-filled add → ONE new stay linked by personId, the old
 *    discharge row flagged restored, rollback; history on the card; labels.
 * C. Code.gs: personId appended, validated, immutable.
 * Names / phones are SYNTHETIC. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const R = require('../lib/returning-patient.js');
const { loadPage } = require('./helpers/app-sandbox');
const { richSheet, loadGs } = require('./helpers/gs-sandbox');
const { serverEcho } = require('./helpers/server-echo');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const plain = (v) => JSON.parse(JSON.stringify(v));

const P1 = { id: 'id-p1', houseId: 'ramot', name: 'דנה כהן', date: '2026-01-10', exitDate: '2026-04-01', status: 'released', pay: 28000, fromLead: 'L1', source: 'lead' };
const D1 = { id: 'id-d1', houseId: 'ramot', name: 'דנה כהן', date: '2026-01-10', exitDate: '2026-04-01', patientId: 'id-p1', disposition: 'completed', discharge_note: 'סיימה תוכנית', dischargedAt: '2026-04-01T10:00:00Z', restored: '' };
const L1 = { id: 'L1', name: 'דנה כהן', phone: '052-111-2222', stage: 'admitted' };
const WORLD = () => ({ patients: [P1], dischargedPatients: [D1], leads: [L1], irrelevantLeads: [] });

/* ---------------- A. the rule ---------------- */

test('A: a person joins Patients + discharge (patientId) + lead phone by ids', () => {
  const ps = R.buildPersons(WORLD());
  assert.equal(ps.length, 1);
  assert.deepEqual(ps[0].phones, ['0521112222']);
  assert.equal(ps[0].rootId, 'id-p1');
  assert.equal(ps[0].discharges[0].open, true);
  assert.equal(ps[0].active, false);
});

test('A: unique match by phone (any format) and by full name', () => {
  const ps = R.buildPersons(WORLD());
  assert.equal(R.findMatches(ps, { phone: '+972521112222' }).status, 'unique');
  assert.equal(R.findMatches(ps, { phone: '521112222', name: 'דנה כהן' }).status, 'unique', 'lost leading zero');
  const byName = R.findMatches(ps, { name: '  דנה   כהן ' });
  assert.equal(byName.status, 'unique');
  assert.equal(byName.via, 'name');
});

test('A: no match → none (fail closed), with loose suggestions only', () => {
  const ps = R.buildPersons(WORLD());
  const none = R.findMatches(ps, { name: 'רון לוי', phone: '0539999999' });
  assert.equal(none.status, 'none');
  assert.deepEqual(none.persons, []);
  assert.deepEqual(none.suggestions, []);
  const near = R.findMatches(ps, { name: 'דנה לוי' });
  assert.equal(near.status, 'none');
  assert.equal(near.suggestions.length, 1, 'shares the token דנה → offered for a manual pick');
  assert.deepEqual(near.persons, [], 'never linked automatically');
});

test('A: two different people with the same name → multiple (no auto-link)', () => {
  const w = WORLD();
  w.patients.push({ id: 'id-p2', houseId: 'asher', name: 'דנה כהן', date: '2025-05-01', status: 'released' });
  const m = R.findMatches(R.buildPersons(w), { name: 'דנה כהן' });
  assert.equal(m.status, 'multiple');
  assert.deepEqual(m.persons, []);
  assert.equal(m.suggestions.length, 2);
});

test('A: phone matches but the typed name is someone else → conflict (manual pick)', () => {
  const m = R.findMatches(R.buildPersons(WORLD()), { phone: '0521112222', name: 'משה כהן' });
  assert.equal(m.status, 'conflict');
  assert.deepEqual(m.persons, []);
  assert.equal(m.suggestions.length, 1);
});

test('A: a person with an ACTIVE stay is never offered; deleted discharge rows are ignored', () => {
  const w = WORLD();
  w.patients.push({ id: 'id-p3', houseId: 'ramot', name: 'דנה כהן', date: '2026-09-01', status: 'active', personId: 'id-p1' });
  assert.equal(R.findMatches(R.buildPersons(w), { name: 'דנה כהן' }).status, 'none');
  const del = R.buildPersons({ dischargedPatients: [Object.assign({}, D1, { patientId: '', deletedAt: '2026-05-01' })] });
  assert.equal(del.length, 0);
});

test('A: a closed lead joins the person by fromLead; a lead-only person offers its lead as the link', () => {
  const w = WORLD();
  w.irrelevantLeads.push({ id: 'L1', name: 'דנה כהן', phone: '0521112222', disposition: 'stopped_early', not_relevant_note: 'עזבה', movedAt: '2026-04-02' });
  w.irrelevantLeads.push({ id: 'L9', name: 'יוסי ברק', phone: '0547776666', disposition: 'not_relevant', movedAt: '2026-03-01' });
  const ps = R.buildPersons(w);
  assert.equal(ps.length, 2);
  const dana = ps.find((p) => p.rootId === 'id-p1');
  assert.equal(dana.closedLeads.length, 1);
  const yossi = ps.find((p) => !p.rootId);
  const pre = R.prefill(yossi);
  assert.equal(pre.fromLead, 'L9');
  assert.equal(pre.personId, '');
  assert.equal(R.prefill(dana).fromLead, '', 'a stay lead is never re-used by a second stay');
});

test('A: history merges a stay with its discharge rows, newest stay first; prefill from the latest', () => {
  const w = WORLD();
  w.patients.push({ id: 'id-p0', houseId: 'asher', name: 'דנה כהן', date: '2025-01-01', exitDate: '2025-03-01', status: 'released', personId: 'id-p1', pay: 25000 });
  const P = R.buildPersons(w)[0];
  const h = R.history(P);
  assert.deepEqual(h.stays.map((s) => s.date), ['2026-01-10', '2025-01-01']);
  assert.equal(h.stays[0].disposition, 'completed');
  assert.equal(h.stays[0].dischargeNote, 'סיימה תוכנית');
  const pre = R.prefill(P);
  assert.deepEqual([pre.name, pre.houseId, pre.pay, pre.personId], ['דנה כהן', 'ramot', 28000, 'id-p1']);
  assert.deepEqual(pre.openDischargeIds, ['id-d1']);
});

test('A: the module is pure', () => {
  const src = read('lib', 'returning-patient.js').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(src, /fetch\(|require\(|innerHTML|document\.|console\.|localStorage/);
});

/* ---------------- B. the app ---------------- */

function page(answerPost) {
  const pg = loadPage({ src: read('lib', 'returning-patient.js') + '\n' + read('public', 'app.js'),
    answerPost: answerPost || ((b) => (b.action === 'restorePatientToActive' ? { ok: true, restoredToActive: true, id: b.patient.id } : serverEcho(b, { ok: true }))) });
  pg.run('showModal = (m) => { globalThis.__modal = m; };');
  pg.sandbox.__w = WORLD();
  pg.run(`state.patients = __w.patients.map(normalizePatient);
          state.dischargedPatients = __w.dischargedPatients.map(normalizeDischargedPatient);
          state.leads = __w.leads.map(normalizeLead); state.irrelevantLeads = []; state.removedLeads = [];
          state.finance = false; state.payments = []; state.funders = [];`);
  return pg;
}
const FORM = { name: 'דנה כהן', phone: '0521112222', houseId: 'ramot', date: '2026-10-19', pay: '28000', status: 'active', notes: '' };

test('B: unique match → pre-filled form → ONE new active stay linked by personId; discharge flagged restored; its OWN «פנייה ישירה» lead', async () => {
  const pg = page();
  const ans = pg.run("returningSearch(state, { phone: '052-111-2222' })");
  assert.equal(ans.status, 'unique');
  pg.run("openReturningAdd(returningSearch(state, { phone: '0521112222' }).persons[0])");
  const fields = plain(pg.run('globalThis.__modal.fields'));
  assert.equal(fields.find((f) => f.name === 'name').value, 'דנה כהן');
  assert.equal(fields.find((f) => f.name === 'phone').value, '0521112222');
  assert.equal(fields.find((f) => f.name === 'houseId').value, 'ramot');
  assert.equal(fields.find((f) => f.name === 'pay').value, '28000');
  assert.match(pg.run('globalThis.__modal.title'), /^מטופל חוזר — דנה כהן$/);
  pg.sandbox.__v = FORM;
  assert.notEqual(await pg.run('globalThis.__modal.onSubmit(globalThis.__v)'), false);
  const save = pg.posts.find((b) => b.action === 'saveAll');
  const sent = save.patients.ramot.find((p) => p.date === '2026-10-19');
  assert.equal(sent.personId, 'id-p1');
  // CHANGELOG-direct-add-auto-lead.md: a returning stay is a new approach → its own lead.
  assert.equal(sent.fromLead, 'dl-' + sent.id, 'the old stay lead is not re-used; the stay has its own lead');
  assert.equal(sent.status, 'active');
  assert.equal(save.leads.length, 2, 'the old lead untouched + the new stay\'s lead');
  const own = save.leads.find((l) => l.id === 'dl-' + sent.id);
  assert.equal(own.source, 'direct_approach');
  assert.equal(own.stage, 'admitted');
  assert.equal(own.note, 'פנייה ישירה — מטופל חוזר (נוסף בתפוסה)');
  assert.deepEqual(plain(save.prove.leads), [own.id]);
  const restore = pg.posts.find((b) => b.action === 'restorePatientToActive');
  assert.equal(restore.patient.id, 'id-d1');
  assert.equal(restore.patient.restored, 'TRUE');
  assert.equal(pg.state().dischargedPatients[0].restored, 'TRUE');
  assert.equal(pg.state().patients.length, 2, 'the new stay is in state.patients (→ מטופלים)');
  const persons = pg.run('returningPersons(state)');
  assert.equal(persons.length, 1, 'still ONE person');
  assert.deepEqual(plain(persons[0].patientIds).sort(), ['id-p1', sent.id].sort());
});

test('B: a refused save rolls the new stay back and never touches the discharge row', async () => {
  const pg = page((b) => (b.action === 'saveAll' ? { ok: false, error: 'sheets_unreachable' } : { ok: true }));
  pg.run("openReturningAdd(returningSearch(state, { name: 'דנה כהן' }).persons[0])");
  pg.sandbox.__v = FORM;
  assert.equal(await pg.run('globalThis.__modal.onSubmit(globalThis.__v)'), false);
  assert.equal(pg.state().patients.length, 1);
  assert.ok(!pg.posts.some((b) => b.action === 'restorePatientToActive'));
  assert.equal(pg.state().dischargedPatients[0].restored, '');
});

test('B: no / several matches → results offer a manual pick, never an automatic link; values escaped', () => {
  const pg = page();
  const none = pg.run("returningResultsHtml(returningSearch(state, { name: 'אין כזה' }), false, [])");
  assert.match(none, /לא נמצאה התאמה מדויקת — לא קושר\./);
  assert.match(none, /data-rp-new/);
  assert.ok(!none.includes('data-rp-pick'));
  pg.run("state.patients.push(normalizePatient({ id: 'id-x', houseId: 'asher', name: 'דנה כהן', date: '2025-02-02', status: 'released' }))");
  const multi = pg.run("returningResultsHtml(returningSearch(state, { name: 'דנה כהן' }), false, [])");
  assert.match(multi, /נמצאו כמה התאמות — לא קושר אוטומטית/);
  assert.equal((multi.match(/data-rp-pick=/g) || []).length, 2);
  pg.run("state.patients.push(normalizePatient({ id: 'id-y', houseId: 'asher', name: '<img src=x>', date: '2025-02-02', status: 'released' }))");
  assert.ok(!pg.run("returningResultsHtml(returningSearch(state, { name: '<img src=x>' }), false, [])").includes('<img'));
});

test('B: the card shows «היסטוריית שהיות» with prior stays; payments by id for finance only', () => {
  const pg = page();
  pg.run("state.patients.unshift(normalizePatient({ id: 'id-new', houseId: 'ramot', name: 'דנה כהן', date: '2026-10-19', status: 'active', personId: 'id-p1', source: 'direct_admin' }))");
  const rowNew = "patientListRows(state, { status: 'all' }, '2026-10-19').find(r => r.patient.id === 'id-new')";
  const stays = pg.run(`${rowNew}.stays`);
  assert.match(stays, /<summary>היסטוריית שהיות<\/summary>/);
  assert.match(stays, /10\/01\/2026 – 01\/04\/2026/);
  assert.match(stays, /סיים טיפול/);
  assert.ok(!stays.includes('₪'), 'no money without finance');
  pg.run("state.finance = true; state.payments = [normalizePayment({ id: 'x1', patientId: 'ramot::דנה כהן::2026-01-10', patientUid: 'id-p1', dueDate: '2026-01-10', amount: 28000, amountPaid: 28000, status: 'paid' })]");
  assert.match(pg.run(`${rowNew}.stays`), /1 תשלומים · ₪ 28,000/);
  assert.match(pg.run(`patientListRowHtml(${rowNew}, false, false)`), /plist-stays/);
});

test('B: a direct / returning patient shows its source («פנייה ישירה» / «חוזר») instead of «ללא ליד»', () => {
  const pg = page();
  const label = (p) => pg.run(`patientNoLeadLabel(normalizePatient(${JSON.stringify(p)}))`);
  // CHANGELOG-direct-add-auto-lead.md replaced «ללא ליד · נוסף ישירות / מטופל חוזר».
  assert.equal(label({ name: 'א', source: 'direct_admin' }), 'פנייה ישירה');
  assert.equal(label({ name: 'א', source: 'direct_admin', personId: 'id-p1' }), 'חוזר');
  assert.equal(label({ name: 'א', source: 'lead' }), 'ללא ליד');
  pg.run("state.patients = [normalizePatient({ id: 'id-z', houseId: 'asher', name: 'זיו זך', date: '2026-10-01', status: 'active', source: 'direct_admin' })]");
  const row = pg.run("patientListRows(state, {}, '2026-10-19')[0]");
  assert.equal(plain(row.problems).find((x) => x.code === 'no_lead').label, 'פנייה ישירה');
});

test('B: personId round-trips through normalizePatient and serializePatients', () => {
  const pg = page();
  pg.run("state.patients = [normalizePatient({ id: 'id-r', houseId: 'ramot', name: 'ר ר', date: '2026-10-01', personId: 'id-p1' })]");
  assert.equal(pg.run('serializePatients().ramot[0].personId'), 'id-p1');
});

/* ---------------- C. Code.gs ---------------- */

const PROXY = 'proxy-secret-TEST-returning-patient-00000';
function gs(rows) {
  const g = loadGs({ props: { PROXY_SECRET_MODE: 'enforce', PROXY_SECRET: PROXY } });
  const pc = Array.from(g.run('PATIENT_COLUMNS'));
  const sh = richSheet('Patients', pc);
  (rows || []).forEach((r) => sh.grid.push(pc.map((c) => r[c] ?? '')));
  g.sandbox.__sheets.Patients = sh;
  const save = (house, list) => plain(g.post({ action: 'saveAll', proxySecret: PROXY, leads: JSON.stringify([]), patients: JSON.stringify({ [house]: list }) }));
  const all = () => sh.grid.slice(1).filter((r) => r.some((v) => v !== '' && v != null)).map((r) => Object.fromEntries(pc.map((c, i) => [c, r[i]])));
  return { g, pc, save, all };
}
const SHEET_P1 = { houseId: 'ramot', name: 'דנה כהן', date: '2026-01-10', pay: 28000, status: 'released', exitDate: '2026-04-01', source: 'lead', id: 'id-p1' };

test('C: personId is appended LAST to PATIENT_COLUMNS (append-only)', () => {
  const { pc } = gs();
  assert.equal(pc[pc.length - 1], 'personId');
  assert.deepEqual(pc.slice(-4), ['id', 'updatedAt', 'updatedBy', 'personId']);
});

test('C: a returning stay is appended as a NEW row with personId; the old stay is untouched', () => {
  const { save, all } = gs([SHEET_P1]);
  const r = save('ramot', [SHEET_P1, { houseId: 'ramot', name: 'דנה כהן', date: '2026-10-19', pay: 28000, status: 'active', source: 'direct_admin', id: 'id-new', personId: 'id-p1' }]);
  assert.equal(r.ok, true);
  const rows = all();
  assert.equal(rows.length, 2);
  assert.equal(rows.find((x) => x.id === 'id-p1').status, 'released');
  assert.equal(rows.find((x) => x.date === '2026-10-19').personId, 'id-p1');
});

test('C: an unknown or malformed personId is dropped (fail closed)', () => {
  const { save, all } = gs([SHEET_P1]);
  save('ramot', [SHEET_P1, { houseId: 'ramot', name: 'זר', date: '2026-10-19', status: 'active', id: 'id-a', personId: 'id-ghost' },
    { houseId: 'ramot', name: 'זר ב', date: '2026-10-19', status: 'active', id: 'id-b', personId: '=HYPERLINK("x")' }]);
  assert.equal(all().find((x) => x.id === 'id-a').personId, '');
  assert.equal(all().find((x) => x.id === 'id-b').personId, '');
});

test('C: personId is immutable once set — an old tab that sends none does not blank it', () => {
  const { save, all } = gs([SHEET_P1, { houseId: 'ramot', name: 'דנה כהן', date: '2026-10-19', status: 'active', id: 'id-new', personId: 'id-p1' }]);
  const r = save('ramot', [SHEET_P1, { houseId: 'ramot', name: 'דנה כהן', date: '2026-10-19', status: 'active', id: 'id-new', notes: 'עדכון' }]);
  assert.equal(r.ok, true);
  const row = all().find((x) => x.id === 'id-new');
  assert.equal(row.personId, 'id-p1');
  assert.equal(row.notes, 'עדכון');
});

/* ---------------- D. wiring ---------------- */

test('D: served / cached / loaded before app.js; the occupancy button opens the search', () => {
  assert.match(read('server.js'), /app\.get\('\/returning-patient\.js', sendLibAsset\('\/returning-patient\.js'\)\);/);
  const index = read('public', 'index.html');
  assert.ok(index.indexOf('returning-patient.js?v=__BUILD__') > 0 && index.indexOf('returning-patient.js?v=__BUILD__') < index.indexOf('app.js?v=__BUILD__'));
  assert.ok(index.includes('id="returning-patient-btn"'));
  assert.match(read('public', 'sw.js'), /var BUNDLE_PATHS = \[[^\]]*'\/returning-patient\.js'[^\]]*\]/);
  assert.match(read('public', 'app.js'), /if \(returningBtn\) returningBtn\.onclick = \(\) => openReturningPatientSearch\(\);/);
});
