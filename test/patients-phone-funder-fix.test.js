'use strict';

/* «מטופלים»: «חסר טלפון» + inline «הוסף טלפון», and the «הגדר גורם מממן»
 * button fix (CHANGELOG-patients-phone-funder-fix.md). app.js is REAL; names
 * and phones are SYNTHETIC. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadPage } = require('./helpers/app-sandbox');
const { serverEcho } = require('./helpers/server-echo');

const TODAY = '2026-10-19';
const plain = (v) => JSON.parse(JSON.stringify(v));
const codes = (list) => plain(list).map((x) => x.code);

function page(answerPost) {
  const pg = loadPage({ answerPost: answerPost || ((b) => serverEcho(b, { ok: true })) });
  return pg;
}
function seed(pg, { leads = [], patients = [], funders = [] } = {}) {
  pg.sandbox.__seed = { leads, patients, funders };
  pg.run(`state.leads = globalThis.__seed.leads.map(normalizeLead);
          state.patients = globalThis.__seed.patients.map(normalizePatient);
          state.funders = globalThis.__seed.funders.map(normalizeFunderRow);
          state.irrelevantLeads = []; state.removedLeads = []; state.dischargedPatients = []; state.payments = [];`);
}
const P = (f) => Object.assign({ id: 'P-1', houseId: 'ramot', name: 'דנה ישראלי', date: '2026-10-01', pay: 30000, status: 'active', fromLead: 'L-1' }, f);
const LEAD = (f) => Object.assign({ id: 'L-1', name: 'דנה ישראלי', phone: '050-1234567', house: 'רמות השבים', stage: 'admitted' }, f);

/* ---------------- «חסר טלפון» ---------------- */

test('no_phone: a lead with a valid phone → none; blank / invalid / no lead → «חסר טלפון»; released / ambiguous → none', () => {
  const pg = page();
  const run = (patient, leads) => {
    seed(pg, { leads, patients: [patient] });
    return codes(pg.run(`patientProblems(state.patients[0], patientLeadInfo(state.patients[0], patientLeadPool(state), state.patients), null, null, '${TODAY}', state.patients, patientLeadPool(state))`));
  };
  assert.deepEqual(run(P(), [LEAD()]), []);
  assert.deepEqual(run(P(), [LEAD({ phone: '' })]), ['no_phone']);
  assert.deepEqual(run(P(), [LEAD({ phone: '123' })]), ['no_phone']);
  assert.deepEqual(run(P({ fromLead: '' }), []), ['no_lead', 'no_phone']);
  assert.deepEqual(run(P({ status: 'released', exitDate: '2026-10-10' }), [LEAD({ phone: '' })]), []);
  assert.deepEqual(run(P({ fromLead: '' }), [LEAD({ id: 'L-a', phone: '' }), LEAD({ id: 'L-b', phone: '' })]), [], 'ambiguous: never flagged');
  assert.equal(pg.run("PATIENT_PROBLEMS.find(p => p.code === 'no_phone').label"), 'חסר טלפון');
});

test('no_phone is counted in the «בעיות פתוחות» summary and kept by the «בעיות בלבד» filter', () => {
  const pg = page();
  seed(pg, { leads: [LEAD({ phone: '' })], patients: [P()] });
  pg.run('state.finance = false');
  const sum = plain(pg.run(`patientProblemSummary(state, '${TODAY}')`));
  assert.equal(sum.patients, 1);
  assert.equal(sum.byCode.no_phone, 1);
  const rows = plain(pg.run(`patientListRows(state, { problemsOnly: true }, '${TODAY}')`));
  assert.equal(rows.length, 1);
  assert.deepEqual(codes(rows[0].problems), ['no_phone']);
});

test('the row shows the red chip and, in edit mode only, «הוסף טלפון»; the waiting row too', () => {
  const pg = page();
  seed(pg, { leads: [LEAD({ phone: '' })], patients: [P()] });
  const row = `patientListRows(state, {}, '${TODAY}')[0]`;
  const edit = pg.run(`patientListRowHtml(${row}, false, true)`);
  assert.match(edit, /<span class="plist-chip" data-problem="no_phone">חסר טלפון<\/span>/);
  assert.match(edit, /plist-phone-btn">הוסף טלפון</);
  assert.match(edit, /type="tel" class="plist-phone-input"/);
  assert.ok(!pg.run(`patientListRowHtml(${row}, false, false)`).includes('plist-phone-btn'), 'view mode: no action');
  const pend = pg.run(`pendingAdmissionRowHtml({ lead: normalizeLead({ id: 'W', name: 'ממתין <b>', phone: '', house: 'רמות השבים', stage: 'paid' }), days: 1, chipDays: null }, true)`);
  assert.match(pend, /data-problem="no_phone">חסר טלפון/);
  assert.match(pend, /plist-phone-btn/);
  assert.ok(!pend.includes('<b>'), 'escaped');
  const ok = pg.run(`pendingAdmissionRowHtml({ lead: normalizeLead({ id: 'W', name: 'ממתין', phone: '0521234567', stage: 'paid' }), days: 1, chipDays: null }, true)`);
  assert.ok(!ok.includes('no_phone'));
});

test('patientPhoneInput: 10-digit Israeli only, normalized', () => {
  const pg = page();
  const f = pg.run('patientPhoneInput');
  assert.equal(f('+972-52-123-4567'), '0521234567');
  assert.equal(f('052 123 4567'), '0521234567');
  assert.equal(f('02-6543210'), '');
  assert.equal(f('abc'), '');
});

/* ---------------- «הוסף טלפון» saves ---------------- */

test('add phone (no lead): creates a direct_admin phone lead + links fromLead in ONE proven saveAll; chip gone', async () => {
  const pg = page();
  seed(pg, { patients: [P({ fromLead: '' })] });
  const ok = await pg.run("addPatientPhone(state.patients[0], '052-123-4567')");
  assert.equal(ok, true);
  const save = pg.posts.find((b) => b.action === 'saveAll');
  assert.ok(save, 'one saveAll');
  const lead = save.leads.find((l) => l.phone === '0521234567');
  assert.equal(lead.source, 'direct_admin');
  assert.equal(pg.state().patients[0].fromLead, lead.id);
  pg.run('state.finance = false');
  assert.deepEqual(codes(pg.run(`patientListRows(state, {}, '${TODAY}')[0].problems`)), [], 'no «חסר טלפון», no «ללא ליד»');
  assert.ok(pg.toasts.includes('הטלפון נשמר'));
});

test('add phone (linked lead without phone): updates that lead; a refused save rolls back', async () => {
  const pg = page((b) => (b.action === 'saveAll' ? { ok: false, error: 'sheets_unreachable' } : { ok: true }));
  seed(pg, { leads: [LEAD({ phone: '' })], patients: [P()] });
  const ok = await pg.run("addPatientPhone(state.patients[0], '0521234567')");
  assert.equal(ok, false);
  assert.equal(pg.state().leads[0].phone, '', 'rolled back');
  assert.equal(pg.state().patients[0].fromLead, 'L-1');
  assert.ok(pg.errors.some((e) => e.includes('שמירת הטלפון נכשלה')));
});

test('add phone (create path) rollback removes the new lead and the link', async () => {
  const pg = page((b) => (b.action === 'saveAll' ? { ok: true, proven: { leads: [], patients: [] } } : { ok: true }));
  seed(pg, { patients: [P({ fromLead: '' })] });
  assert.equal(await pg.run("addPatientPhone(state.patients[0], '0521234567')"), false);
  assert.equal(pg.state().leads.length, 0);
  assert.equal(pg.state().patients[0].fromLead, '');
});

test('add phone: an invalid phone sends nothing', async () => {
  const pg = page();
  seed(pg, { patients: [P({ fromLead: '' })] });
  assert.equal(await pg.run("addPatientPhone(state.patients[0], '123')"), false);
  assert.equal(pg.posts.length, 0);
});

test('add phone on a waiting lead goes through updateLead (optimistic + rollback)', async () => {
  const pg = page();
  seed(pg, { leads: [LEAD({ id: 'W', phone: '', stage: 'paid' })] });
  assert.equal(await pg.run("addLeadPhone(state.leads[0], '+972521234567')"), true);
  assert.equal(pg.state().leads[0].phone, '0521234567');
  const bad = page((b) => (b.action === 'saveAll' ? { ok: false, error: 'x' } : { ok: true }));
  seed(bad, { leads: [LEAD({ id: 'W', phone: '', stage: 'paid' })] });
  assert.equal(await bad.run("addLeadPhone(state.leads[0], '0521234567')"), false);
  assert.equal(bad.state().leads[0].phone, '');
});

/* ---------------- the funder button ---------------- */

test('REGRESSION: «הגדר גורם מממן» shows ONLY when no funder is set; a set funder shows its name + ✏️ שינוי', () => {
  const pg = page();
  seed(pg, { leads: [LEAD()], patients: [P()], funders: [] });
  pg.run("state.finance = true; state.mode = 'edit'");
  const html = () => pg.run(`patientListRowHtml(patientListRows(state, {}, todayISO())[0], true, true)`);
  const unset = html();
  assert.ok(unset.includes('>הגדר גורם מממן</button>'));
  assert.match(unset, /funder-unset/);
  pg.run("state.funders = [normalizeFunderRow({ patientId: 'P-1', funder: 'מכבי', effectiveFrom: '2026-10-01', setBy: 'ורד', setAt: '2026-10-01T09:00:00Z' })]");
  const set = html();
  assert.ok(!set.includes('הגדר גורם מממן'), 'the set-funder button is gone');
  assert.match(set, /<span class="plist-funder-name" data-funder="maccabi">מכבי<\/span>/);
  assert.match(set, /plist-funder-edit[^>]*>✏️ שינוי</);
  assert.ok(!pg.run(`patientListRowHtml(patientListRows(state, {}, todayISO())[0], true, false)`).includes('plist-funder-btn'), 'view mode: no button');
});

test('patientFunderState agrees with the «ללא גורם מממן» chip (one source); trimmed label is set; unknown label / no id is unset', () => {
  const pg = page();
  seed(pg, { patients: [P()], funders: [{ patientId: 'P-1', funder: ' פרטי ', effectiveFrom: '2026-10-01' }] });
  assert.deepEqual(plain(pg.run(`patientFunderState(state.patients[0], state.funders, '${TODAY}')`)), { key: 'private', label: 'פרטי', unset: false });
  pg.run("state.funders = [normalizeFunderRow({ patientId: 'P-1', funder: 'משהו', effectiveFrom: '2026-10-01' })]");
  assert.equal(pg.run(`patientFunderState(state.patients[0], state.funders, '${TODAY}')`).unset, true);
  assert.equal(pg.run(`patientFunderState(normalizePatient({ id: '', name: 'x' }), state.funders, '${TODAY}')`).unset, true);
  pg.run("state.funders = [normalizeFunderRow({ patientId: 'P-1', funder: 'מכבי', effectiveFrom: '2026-12-01' })]");
  assert.equal(pg.run(`patientFunderState(state.patients[0], state.funders, '${TODAY}')`).unset, true, 'a future-dated row is not yet in effect');
});
