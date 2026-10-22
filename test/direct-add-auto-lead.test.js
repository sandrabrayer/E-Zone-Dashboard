/* Direct add → a regular ADMITTED lead (CHANGELOG-direct-add-auto-lead.md).
 *
 * A patient added straight into «תפוסה» (direct add, intake, returning stay)
 * gets a real lead — stage 'admitted', source 'direct_approach' («פנייה
 * ישירה»), id 'dl-<patient id>' — written by saveAll_ inside its lock, BEFORE
 * any patient row. The REAL apps-script/Code.gs, public/app.js and
 * lib/leads-funnel.js in vm sandboxes with an in-memory spreadsheet; every
 * name is SYNTHETIC. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadGs, richSheet } = require('./helpers/gs-sandbox');
const { loadPage } = require('./helpers/app-sandbox');
const { serverEcho } = require('./helpers/server-echo');
const LeadsFunnel = require('../lib/leads-funnel');

const plain = (v) => JSON.parse(JSON.stringify(v));
const ROOT = path.join(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');

const PAT = { id: 'id-pat-1', houseId: 'ramot', name: 'דנה לוי', date: '2026-10-05', pay: 9000, adv: 0, status: 'active', fromLead: '', source: 'direct_admin' };
const clientLead = (id, phone) => ({ id, name: 'דנה לוי', phone, house: 'רמות השבים', source: 'direct_approach', stage: 'admitted', entryDate: '2026-10-05', created: '2026-10-21' });

/* ---------- server world ---------- */
function world() {
  const g = loadGs();
  const s = g.sandbox;
  const K = {};
  ['LEADS_SHEET', 'LEAD_COLUMNS', 'PATIENTS_SHEET', 'PATIENT_COLUMNS', 'IRRELEVANT_LEADS_SHEET', 'IRRELEVANT_LEAD_COLUMNS',
    'REMOVED_LEADS_SHEET', 'REMOVED_LEAD_COLUMNS', 'AUDIT_LOG_SHEET', 'PATIENTS_TOMBSTONES_SHEET', 'PATIENT_TOMBSTONE_COLUMNS']
    .forEach((k) => { K[k] = Array.isArray(g.run(k)) ? Array.from(g.run(k)) : g.run(k); });
  g.run("todayISODate_ = function () { return '2026-10-21'; }");
  const leadsSh = () => s.getOrCreateSheet_(K.LEADS_SHEET, K.LEAD_COLUMNS);
  const patSh = () => s.getOrCreateSheet_(K.PATIENTS_SHEET, K.PATIENT_COLUMNS);
  return {
    g, s, K,
    // A fresh copy per call, as a real request is freshly parsed JSON (saveAll_ sets fromLead on it).
    save: (leads, patients, prove) => plain(s.saveAll_(plain(leads), plain(patients), 'ורד', prove)),
    leads: () => g.sheetRows(K.LEADS_SHEET, 'LEAD_COLUMNS'),
    patients: () => g.sheetRows(K.PATIENTS_SHEET, 'PATIENT_COLUMNS'),
    audit: () => g.sheetRows(K.AUDIT_LOG_SHEET, 'AUDIT_LOG_COLUMNS').map((r) => r.action),
    seedLead: (l) => s.upsertRowById_(leadsSh(), K.LEAD_COLUMNS, l),
    seedPatient: (p) => s.upsertRowById_(patSh(), K.PATIENT_COLUMNS, p),
  };
}

test('server: ONE admitted «פנייה ישירה» lead per direct add — built from the patient row, linked by fromLead', () => {
  const w = world();
  const res = w.save([clientLead('dl-id-pat-1', '+972-52-111-2233')], { ramot: [Object.assign({}, PAT, { fromLead: 'dl-id-pat-1' })] },
    { leads: ['dl-id-pat-1'], patients: ['id-pat-1'] });
  assert.equal(res.ok, true);
  const leads = w.leads();
  assert.equal(leads.length, 1);
  const L = leads[0];
  assert.deepEqual(
    { id: L.id, name: L.name, phone: L.phone, house: L.house, source: L.source, stage: L.stage, entryDate: L.entryDate, created: L.created, note: L.note },
    { id: 'dl-id-pat-1', name: 'דנה לוי', phone: '0521112233', house: 'רמות השבים', source: 'direct_approach', stage: 'admitted',
      entryDate: '2026-10-05', created: '2026-10-21', note: 'פנייה ישירה (נוסף בתפוסה)' });
  assert.equal(w.patients()[0].fromLead, 'dl-id-pat-1');
  assert.deepEqual(res.directLeads, [{ patientId: 'id-pat-1', leadId: 'dl-id-pat-1' }]);
  assert.deepEqual(res.proven, { leads: ['dl-id-pat-1'], patients: ['id-pat-1'] });
  assert.ok(w.audit().includes('direct_lead_created'));
});

test('server: the client copy of the lead cannot set its own fields — only its phone is read', () => {
  const w = world();
  const forged = Object.assign(clientLead('dl-id-pat-1', '0521112233'), { stage: 'new', source: 'פייסבוק', note: '=HYPERLINK("x")', advance: 5000 });
  w.save([forged], { ramot: [Object.assign({}, PAT, { fromLead: 'dl-id-pat-1' })] });
  const L = w.leads()[0];
  assert.equal(L.stage, 'admitted');
  assert.equal(L.source, 'direct_approach');
  assert.equal(L.note, 'פנייה ישירה (נוסף בתפוסה)');
  assert.equal(String(L.advance), '');
});

test('server: a retry creates no duplicate — same payload twice, and a retry after a half-landed save', () => {
  const w = world();
  const payload = () => [[clientLead('dl-id-pat-1', '0521112233')], { ramot: [Object.assign({}, PAT, { fromLead: 'dl-id-pat-1' })] }];
  w.save(...payload());
  w.save(...payload());
  assert.deepEqual(w.leads().map((l) => l.id), ['dl-id-pat-1']);
  assert.equal(w.patients().length, 1);

  // The lead landed, the patient did not (lost before the patient write): the retry re-links.
  const w2 = world();
  w2.seedLead(Object.assign(clientLead('dl-id-pat-1', '0521112233'), { note: 'פנייה ישירה (נוסף בתפוסה)' }));
  const res = w2.save(...payload());
  assert.deepEqual(w2.leads().map((l) => l.id), ['dl-id-pat-1']);
  assert.equal(w2.patients()[0].fromLead, 'dl-id-pat-1');
  assert.deepEqual(res.directLeads, [{ patientId: 'id-pat-1', leadId: 'dl-id-pat-1' }]);
});

test('server: a phone-less direct add still gets its lead (phone blank); a landline is kept', () => {
  const w = world();
  w.save([], { ramot: [PAT] });
  assert.equal(w.leads().length, 1);
  assert.equal(w.leads()[0].phone, '');
  assert.equal(w.patients()[0].fromLead, 'dl-id-pat-1');

  const w2 = world();
  w2.save([clientLead('dl-id-pat-1', '03-6123456')], { ramot: [PAT] });
  assert.equal(w2.leads()[0].phone, '036123456');
  const w3 = world();
  w3.save([clientLead('dl-id-pat-1', '12345')], { ramot: [PAT] });
  assert.equal(w3.leads()[0].phone, '', 'an invalid phone is stored blank, never refused');
});

test('server: a new row without an id gets one, so its lead id is known before the patient is written', () => {
  const w = world();
  const res = w.save([], { ramot: [Object.assign({}, PAT, { id: '' })] });
  const p = w.patients()[0];
  assert.match(p.id, /^id-/);
  assert.equal(p.fromLead, 'dl-' + p.id);
  assert.deepEqual(res.directLeads, [{ patientId: p.id, leadId: 'dl-' + p.id }]);
});

test('server: a returning patient gets its OWN new lead; the old stay\'s lead is untouched; personId stays', () => {
  const w = world();
  const OLD_LEAD = { id: 'L-old', name: 'דנה לוי', phone: '0521112233', house: 'רמות השבים', source: 'פייסבוק', stage: 'admitted', entryDate: '2026-01-10', created: '2026-01-01' };
  w.seedLead(OLD_LEAD);
  w.seedPatient({ id: 'id-p1', houseId: 'ramot', name: 'דנה לוי', date: '2026-01-10', status: 'released', exitDate: '2026-04-01', fromLead: 'L-old', source: 'lead' });
  const before = w.leads().find((l) => l.id === 'L-old');
  const stay = Object.assign({}, PAT, { id: 'id-p2', fromLead: 'L-old', personId: 'id-p1' });
  const res = w.save([OLD_LEAD], { ramot: [w.patients()[0], stay] });
  assert.equal(res.ok, true);
  const leads = w.leads();
  assert.deepEqual(leads.map((l) => l.id).sort(), ['L-old', 'dl-id-p2']);
  assert.deepEqual(leads.find((l) => l.id === 'L-old'), before, 'the previous lead is untouched');
  assert.equal(leads.find((l) => l.id === 'dl-id-p2').note, 'פנייה ישירה — מטופל חוזר (נוסף בתפוסה)');
  const p2 = w.patients().find((p) => p.id === 'id-p2');
  assert.equal(p2.fromLead, 'dl-id-p2');
  assert.equal(p2.personId, 'id-p1');
  assert.ok(!Array.from(w.K.LEAD_COLUMNS).includes('personId'), 'Leads gets no personId column');
});

test('server: a returning stay never takes over a previous lead, even one no patient row holds any more', () => {
  const w = world();
  const OLD = { id: 'L-old', name: 'דנה לוי', phone: '0521112233', source: 'פייסבוק', stage: 'admitted', created: '2025-01-01' };
  w.seedLead(OLD);
  const before = w.leads();
  w.save([OLD], { ramot: [Object.assign({}, PAT, { fromLead: 'L-old', personId: 'id-p1' })] });
  assert.equal(w.patients()[0].fromLead, 'dl-id-pat-1');
  assert.deepEqual(w.leads().filter((l) => l.id === 'L-old'), before);
});

test('server: an old client\'s hidden phone-record lead (direct_admin) is ADOPTED in place, never duplicated', () => {
  const w = world();
  const legacy = { id: 'id-legacy-1', name: 'דנה לוי', phone: '0521112233', house: 'רמות השבים', source: 'direct_admin',
    note: 'נקלט ישירות (ללא ליד) — טלפון נשמר לצורך המשך מעקב', stage: 'admitted', created: '2026-10-21' };
  const res = w.save([legacy], { ramot: [Object.assign({}, PAT, { fromLead: 'id-legacy-1' })] });
  const leads = w.leads();
  assert.deepEqual(leads.map((l) => l.id), ['id-legacy-1']);
  assert.equal(leads[0].source, 'direct_approach');
  assert.equal(leads[0].note, 'פנייה ישירה (נוסף בתפוסה)');
  assert.equal(leads[0].phone, '0521112233');
  assert.equal(leads[0].entryDate, '2026-10-05');
  assert.equal(w.patients()[0].fromLead, 'id-legacy-1');
  assert.deepEqual(res.directLeads, [{ patientId: 'id-pat-1', leadId: 'id-legacy-1' }]);
  assert.ok(w.audit().includes('direct_lead_adopted'));
});

test('server: a patient linked to a REAL board lead keeps that link and gets no extra lead', () => {
  const w = world();
  const BOARD = { id: 'L-board', name: 'דנה לוי', phone: '0521112233', house: 'רמות השבים', source: 'פייסבוק', stage: 'paid', created: '2026-09-01' };
  w.seedLead(BOARD);
  const before = w.leads();
  const res = w.save([BOARD], { ramot: [Object.assign({}, PAT, { fromLead: 'L-board' })] });
  assert.deepEqual(w.leads(), before, 'the board lead is untouched, no dl- lead');
  assert.equal(w.patients()[0].fromLead, 'L-board');
  assert.equal(res.directLeads, undefined);
});

test('server: a link to a closed, removed or unknown lead gets a fresh lead', () => {
  for (const where of ['closed', 'removed', 'unknown']) {
    const w = world();
    const gone = { id: 'L-gone', name: 'דנה לוי', phone: '0521112233', source: 'פייסבוק', stage: 'new', created: '2026-09-01' };
    if (where === 'closed') w.s.upsertRowById_(w.s.getOrCreateSheet_(w.K.IRRELEVANT_LEADS_SHEET, w.K.IRRELEVANT_LEAD_COLUMNS), w.K.IRRELEVANT_LEAD_COLUMNS, gone);
    if (where === 'removed') w.s.upsertRowById_(w.s.getOrCreateSheet_(w.K.REMOVED_LEADS_SHEET, w.K.REMOVED_LEAD_COLUMNS), w.K.REMOVED_LEAD_COLUMNS, gone);
    w.save([], { ramot: [Object.assign({}, PAT, { fromLead: 'L-gone' })] });
    assert.deepEqual(w.leads().map((l) => l.id), ['dl-id-pat-1'], where);
    assert.equal(w.patients()[0].fromLead, 'dl-id-pat-1', where);
  }
});

test('server: a failed lead write refuses the save BEFORE any patient is written — Hebrew message, AuditLog', () => {
  for (const mode of ['throw', 'silent']) {
    const w = world();
    const real = w.s.upsertRowById_;
    w.s.upsertRowById_ = function (sh, cols, obj) {
      if (sh.getName() === w.K.LEADS_SHEET) { if (mode === 'throw') throw new Error('Service Spreadsheets timed out'); return undefined; }
      return real(sh, cols, obj);
    };
    const res = w.save([], { ramot: [PAT, Object.assign({}, PAT, { id: 'id-pat-2', name: 'שרה כהן' })] });
    assert.equal(res.ok, false, mode);
    assert.equal(res.error, 'direct_lead_failed');
    assert.match(res.message, /דבר לא נשמר/);
    assert.deepEqual(w.patients(), [], mode + ': no patient written');
    assert.deepEqual(w.leads(), [], mode + ': no lead left behind');
    assert.ok(w.audit().includes('direct_lead_failed'), mode);
  }
});

test('server: the SECOND lead failing takes the first one back out', () => {
  const w = world();
  const real = w.s.upsertRowById_;
  let n = 0;
  w.s.upsertRowById_ = function (sh, cols, obj) {
    if (sh.getName() === w.K.LEADS_SHEET && ++n === 2) throw new Error('quota');
    return real(sh, cols, obj);
  };
  const res = w.save([], { ramot: [PAT, Object.assign({}, PAT, { id: 'id-pat-2', name: 'שרה כהן' })] });
  assert.equal(res.error, 'direct_lead_failed');
  assert.deepEqual(w.leads(), []);
  assert.deepEqual(w.patients(), []);
});

test('server: a patient write that throws removes the leads created for it', () => {
  const w = world();
  w.s.replaceHousePatients_ = () => { throw new Error('Service Spreadsheets timed out'); };
  assert.throws(() => w.save([], { ramot: [PAT] }), /timed out/);
  assert.deepEqual(w.leads(), []);
  assert.ok(w.audit().includes('direct_lead_undone'));
});

test('server: a tombstoned (user-deleted) patient leaves no orphan lead — directLeadsDropped', () => {
  const w = world();
  const tsh = w.s.getOrCreateSheet_(w.K.PATIENTS_TOMBSTONES_SHEET, w.K.PATIENT_TOMBSTONE_COLUMNS);
  w.s.upsertRowById_(tsh, w.K.PATIENT_TOMBSTONE_COLUMNS,
    { id: 'id-old', houseId: 'ramot', name: PAT.name, date: PAT.date, reason: 'user-delete', droppedAt: new Date().toISOString() });
  const res = w.save([], { ramot: [PAT] });
  assert.equal(res.ok, true);
  assert.deepEqual(w.patients(), []);
  assert.deepEqual(w.leads(), [], 'the lead made for it is removed again');
  assert.deepEqual(res.directLeadsDropped, [{ patientId: 'id-pat-1', leadId: 'dl-id-pat-1' }]);
  assert.equal(res.directLeads, undefined);
});

test('server: an ordinary saveAll never backfills an already-saved patient, and the manual-lead path is unchanged', () => {
  const w = world();
  w.seedPatient(Object.assign({}, PAT, { id: 'id-saved', name: 'ישן ישן' }));
  const NEW_LEAD = { id: 'L-new', name: 'יעל כהן', phone: '0501234567', house: 'רמות השבים', source: 'פייסבוק', stage: 'new', created: '2026-10-21' };
  const res = w.save([NEW_LEAD], { ramot: [w.patients()[0], { id: 'id-lp', houseId: 'ramot', name: 'נועה ברק', date: '2026-10-10', status: 'active', fromLead: 'L-other', source: 'lead' }] });
  assert.equal(res.ok, true);
  assert.deepEqual(w.leads().map((l) => l.id), ['L-new'], 'no dl- lead for a saved or a lead-converted patient');
  assert.equal(w.leads()[0].stage, 'new');
  assert.equal(w.patients().find((p) => p.id === 'id-saved').fromLead, '');
  assert.equal(res.directLeads, undefined);
  // The manual lead still meets the name + phone rule (the exemption is by source only).
  const bad = w.save([{ id: 'L-bad', name: 'יחיד', phone: '1', source: 'פייסבוק', stage: 'new' }], null);
  assert.equal(bad.error, 'invalid_lead');
});

test('server: direct_approach is exempt from the name/phone rule, like direct_admin', () => {
  const w = world();
  const res = w.save([{ id: 'dl-x', name: 'יחיד', phone: '', source: 'direct_approach', stage: 'admitted', created: '2026-10-21' }], null);
  assert.equal(res.ok, true);
  assert.deepEqual(w.leads().map((l) => l.id), ['dl-x']);
});

/* ---------- bonus parity (Patients.fromLead → Leads.meetingWith → Managers) ---------- */

test('bonus: a direct-add lead feeds the intake-meeting bonus EXACTLY like a normal admitted lead once meetingWith is set', () => {
  const run = (direct) => {
    const w = world();
    w.sandbox = w.s;
    w.s.Session = { getScriptTimeZone: () => 'Asia/Jerusalem' };
    w.s.Utilities.formatDate = (d) => {
      const x = new Date(d), m = x.getMonth() + 1, day = x.getDate();
      return `${x.getFullYear()}-${m < 10 ? '0' + m : m}-${day < 10 ? '0' + day : day}`;
    };
    const base = Array.from({ length: 6 }, (_, i) => ({ id: `id-b${i}`, houseId: 'ramot', name: `בסיס ${i}`, date: '2026-08-01', status: 'active', source: 'lead' }));
    base.forEach((p) => w.seedPatient(p));
    if (direct) {
      w.save([], { ramot: base.concat([PAT]) });
    } else {
      w.seedLead({ id: 'L-norm', name: PAT.name, phone: '0521112233', house: 'רמות השבים', source: 'פייסבוק', stage: 'admitted', created: '2026-09-20' });
      w.seedPatient(Object.assign({}, PAT, { fromLead: 'L-norm', source: 'lead' }));
    }
    const leadId = direct ? 'dl-id-pat-1' : 'L-norm';
    const lead = w.leads().find((l) => l.id === leadId);
    w.seedLead(Object.assign({}, lead, { meetingWith: 'אורן' }));
    const msh = richSheet('Managers', Array.from(w.g.run('MANAGER_COLUMNS')));
    msh.grid.push(['ramot', 'אורן', '2026-08-25', '']);
    w.s.__sheets.Managers = msh;
    w.g.run("intakeToday_ = function () { return parseDate_('2026-11-20'); }");
    return plain(w.s.managersOverview_('2026-10').houses.find((h) => h.key === 'ramot').intakeMeetings);
  };
  const normal = run(false);
  const direct = run(true);
  assert.deepEqual(normal, { confirmed: 1, pending: 0, items: [{ date: '2026-10-05', name: 'דנה לוי', house: 'ramot', status: 'confirmed' }] });
  assert.deepEqual(direct, normal);
});

/* ---------- client: forms build the lead, rollback, chip, labels ---------- */

function page(answerPost) {
  const pg = loadPage({ answerPost: answerPost || ((b) => serverEcho(b, { ok: true })) });
  pg.run(`showModal = (m) => { globalThis.__modal = m; }; saveAdmissionFunder = async () => {};`);
  pg.set({ finance: false, leads: [], patients: [], dischargedPatients: [], irrelevantLeads: [], removedLeads: [] });
  return pg;
}
const FORM = { name: 'דנה לוי', phone: '052-111-2233', houseId: 'ramot', date: '2026-10-05', pay: '9000', status: 'active', notes: '' };

test('client: the direct-add and intake forms build the SAME lead and send it in the same saveAll with prove.leads', async () => {
  for (const intake of [false, true]) {
    const pg = page();
    pg.run(`openDirectAddPatientModal(${intake ? '{ intake: true }' : ''})`);
    pg.sandbox.__v = FORM;
    assert.equal(await pg.run('globalThis.__modal.onSubmit(globalThis.__v)'), true);
    const save = pg.posts.find((b) => b.action === 'saveAll');
    const p = save.patients.ramot[0];
    const L = save.leads.find((l) => l.id === 'dl-' + p.id);
    assert.ok(L, 'lead sent');
    assert.deepEqual({ source: L.source, stage: L.stage, phone: L.phone, entryDate: L.entryDate, house: L.house, note: L.note },
      { source: 'direct_approach', stage: 'admitted', phone: '0521112233', entryDate: '2026-10-05', house: 'רמות השבים', note: 'פנייה ישירה (נוסף בתפוסה)' });
    assert.equal(p.fromLead, L.id);
    assert.equal(p.source, 'direct_admin');
    assert.deepEqual(plain(save.prove), { patients: [p.id], leads: [L.id] });
  }
});

test('client: a phone-less direct add still builds its lead (phone blank)', async () => {
  const pg = page();
  pg.run('openDirectAddPatientModal()');
  pg.sandbox.__v = Object.assign({}, FORM, { phone: '' });
  assert.equal(await pg.run('globalThis.__modal.onSubmit(globalThis.__v)'), true);
  const save = pg.posts.find((b) => b.action === 'saveAll');
  const L = save.leads.find((l) => l.source === 'direct_approach');
  assert.equal(L.phone, '');
  assert.equal(save.patients.ramot[0].fromLead, L.id);
});

test('client: the form retried after a refusal re-sends the SAME lead id; a refused save rolls patient AND lead back', async () => {
  let n = 0;
  const pg = page((b) => (b.action === 'saveAll' && ++n === 1
    ? { ok: false, error: 'direct_lead_failed', message: 'לא נשמר: יצירת הליד למטופל (פנייה ישירה) נכשלה. דבר לא נשמר — נסו שוב.' }
    : serverEcho(b, { ok: true })));
  pg.run('openDirectAddPatientModal()');
  pg.sandbox.__v = FORM;
  assert.equal(await pg.run('globalThis.__modal.onSubmit(globalThis.__v)'), false);
  assert.equal(pg.state().patients.length, 0, 'patient rolled back');
  assert.equal(pg.state().leads.length, 0, 'lead rolled back');
  assert.ok(pg.errors.some((m) => /נכשלה/.test(m)), JSON.stringify(pg.errors));
  assert.equal(await pg.run('globalThis.__modal.onSubmit(globalThis.__v)'), true);
  const ids = pg.posts.filter((b) => b.action === 'saveAll').map((b) => b.leads.find((l) => l.source === 'direct_approach').id);
  assert.equal(ids[0], ids[1], 'one lead id per form');
});

test('client: a board lead of the SAME person is linked, no second lead', async () => {
  const pg = page();
  pg.set({ leads: [pg.run('normalizeLead')({ id: 'L-board', name: 'דנה לוי', phone: '0521112233', stage: 'paid', source: 'פייסבוק' })] });
  pg.run('openDirectAddPatientModal()');
  pg.sandbox.__v = FORM;
  assert.equal(await pg.run('globalThis.__modal.onSubmit(globalThis.__v)'), true);
  const save = pg.posts.find((b) => b.action === 'saveAll');
  assert.equal(save.patients.ramot[0].fromLead, 'L-board');
  assert.ok(!save.leads.some((l) => l.source === 'direct_approach'));
});

test('client: buildDirectApproachLead matches the server builder field for field', () => {
  const pg = page();
  const c = plain(pg.run("buildDirectApproachLead('dl-id-x', ' דנה לוי ', '0521112233', houseById('ramot'), '2026-10-05', '2026-10-21', false)"));
  const w = world();
  const sv = plain(w.s.buildDirectApproachLead_('dl-id-x', { houseId: 'ramot', name: ' דנה לוי ', date: '2026-10-05' }, '0521112233', '2026-10-21'));
  assert.deepEqual(c, sv);
  const cr = plain(pg.run("buildDirectApproachLead('dl-id-y', 'א ב', '', houseById('sde'), '2026-10-05', '2026-10-21', true)"));
  const sr = plain(w.s.buildDirectApproachLead_('dl-id-y', { houseId: 'sde', name: 'א ב', date: '2026-10-05', personId: 'id-p1' }, '', '2026-10-21'));
  assert.deepEqual(cr, sr);
});

test('client: «פנייה ישירה» / «חוזר» source chip replaces «ללא ליד»; labels everywhere; values escaped', () => {
  const pg = page();
  pg.run(`state.leads = [normalizeLead({ id: 'dl-id-a', name: 'דנה לוי', phone: '', source: 'direct_approach', stage: 'admitted', created: '2026-10-21' }),
                         normalizeLead({ id: 'dl-id-b', name: '<b>x</b> y', phone: '', source: 'direct_approach', stage: 'admitted', created: '2026-10-21' }),
                         normalizeLead({ id: 'L-n', name: 'נועה ברק', phone: '0501234567', source: 'פייסבוק', stage: 'admitted', created: '2026-10-01' })];
          state.patients = [normalizePatient({ id: 'id-a', houseId: 'ramot', name: 'דנה לוי', date: '2026-10-05', status: 'active', source: 'direct_admin', fromLead: 'dl-id-a' }),
                            normalizePatient({ id: 'id-b', houseId: 'ramot', name: '<b>x</b> y', date: '2026-10-05', status: 'active', source: 'direct_admin', fromLead: 'dl-id-b', personId: 'id-p0' }),
                            normalizePatient({ id: 'id-n', houseId: 'ramot', name: 'נועה ברק', date: '2026-10-02', status: 'active', source: 'lead', fromLead: 'L-n' })];`);
  const html = (id) => pg.run(`patientLeadDetailsHtml(patientListRows(state, { status: 'all' }, '2026-10-21').find(r => r.patient.id === '${id}'))`);
  assert.match(html('id-a'), /<summary>פרטי הליד <span class="plist-source-chip" data-source="direct_approach">פנייה ישירה<\/span><\/summary>/);
  assert.match(html('id-a'), /<span class="p-label">מקור<\/span><span class="p-val">פנייה ישירה<\/span>/, '«פרטי הליד» shows the label, not the key');
  assert.match(html('id-b'), /data-source="returning">חוזר</);
  assert.ok(!html('id-b').includes('<b>x'), 'escaped');
  assert.ok(!html('id-n').includes('plist-source-chip'), 'a regular lead has no source chip');
  assert.ok(!/ללא ליד/.test(html('id-a') + html('id-b')));
  const rows = pg.run("patientListRows(state, { status: 'all' }, '2026-10-21')");
  assert.ok(!plain(rows).some((r) => r.problems.some((x) => x.code === 'no_lead')), 'no patient is «ללא ליד»');
  assert.equal(pg.run("leadSourceLabel('direct_approach')"), 'פנייה ישירה');
  assert.equal(pg.run("leadSourceLabel('פייסבוק')"), 'פייסבוק');
  // The lead card renders the label through escapeHtml.
  assert.match(APP_SRC, /'· מקור: ' \+ escapeHtml\(leadSourceLabel\(lead\.source\)\)/);
  assert.match(fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8'), /\.plist-source-chip \{[\s\S]*?color: var\(--info\);/);
});

test('client: a «פנייה ישירה» lead is not on the board and not in «ממתינים לקליטה»', () => {
  const pg = page();
  pg.run(`state.leads = [normalizeLead({ id: 'dl-id-a', name: 'דנה לוי', source: 'direct_approach', stage: 'admitted', entryDate: '2026-10-05', advance: 0, created: '2026-10-21' })];
          state.patients = [];`);
  assert.ok(!pg.run("STAGES.some(s => s.id === 'admitted')"), 'admitted is not a board column');
  assert.deepEqual(plain(pg.run("pendingAdmissionRows(state.leads, state.patients, [], '2026-10-21')")), []);
});

test('client: the edit-lead name/phone rule exempts a «פנייה ישירה» lead, not a regular one', () => {
  const pg = page();
  assert.deepEqual(plain(pg.run("leadRequiredErrors({ name: 'יחיד', phone: '' }, { name: 'יחיד', phone: 'x', source: 'direct_approach' })")), {});
  assert.notDeepEqual(plain(pg.run("leadRequiredErrors({ name: 'יחיד', phone: '' }, { name: 'יחיד', phone: 'x', source: 'פייסבוק' })")), {});
});

/* ---------- funnel ---------- */

test('funnel: a «פנייה ישירה» lead counts ONCE under «נכנסו לבית» in its creation period, with the Hebrew label', () => {
  const L = { id: 'dl-id-a', name: 'דנה לוי', source: 'direct_approach', stage: 'admitted', created: '2026-10-21' };
  const r = LeadsFunnel.funnel({
    leads: [L, { id: 'id-legacy', name: 'ישן', source: 'direct_admin', stage: 'admitted', created: '2026-10-21' }],
    irrelevantLeads: [Object.assign({}, L)],
    patients: [{ fromLead: 'dl-id-a' }],
    from: '2026-10-01', to: '2026-10-31',
  });
  assert.equal(r.population, 1, 'direct_admin stays excluded; the copy counts once');
  assert.deepEqual(r.counts, { notRelevant: 0, visitedNotEntered: 0, entered: 1 });
  assert.equal(r.rows.entered[0].source, 'פנייה ישירה');
  assert.match(LeadsFunnel.toCsv(r.rows.entered), /"פנייה ישירה"/);
  const sep = LeadsFunnel.funnel({ leads: [L], from: '2026-09-01', to: '2026-09-30' });
  assert.equal(sep.population, 0, 'outside its creation period');
});
