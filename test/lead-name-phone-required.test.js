'use strict';

/* Lead validation. The CLASSIC app.js add-lead modal still checks name + phone
 * inline (legacy path, retained). Code.gs intake (saveAll) was RELAXED on
 * 20/11/2026 (CHANGELOG-optional-lead-fields.md): name and phone are OPTIONAL —
 * a first caller often won't give them — but a NON-EMPTY phone must still be a
 * valid Israeli number. The name is required later, at admission, in the CRM.
 * Names / phones are SYNTHETIC. app.js and Code.gs are REAL. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadPage } = require('./helpers/app-sandbox');
const { richSheet, loadGs } = require('./helpers/gs-sandbox');
const { serverEcho } = require('./helpers/server-echo');

const PROXY = 'proxy-secret-TEST-lead-required-000000000';
const arr = (x) => JSON.parse(JSON.stringify(x));

/* ---------------- UI: pure validators ---------------- */

test('UI: leadFullNameOk needs at least two words', () => {
  const pg = loadPage();
  const ok = pg.run('leadFullNameOk');
  assert.equal(ok('דנה כהן'), true);
  assert.equal(ok('  דנה   בת  כהן '), true);
  assert.equal(ok('דנה'), false);
  assert.equal(ok('  '), false);
  assert.equal(ok(''), false);
  assert.equal(ok(null), false);
});

test('UI: leadLocalPhone → 0XXXXXXXXX for valid Israeli phones only', () => {
  const pg = loadPage();
  const ph = pg.run('leadLocalPhone');
  assert.equal(ph('052-765-4321'), '0527654321');
  assert.equal(ph('+972 52 765 4321'), '0527654321');
  assert.equal(ph('00972527654321'), '0527654321');
  assert.equal(ph('(052) 7654321'), '0527654321');
  assert.equal(ph('02-6543210'), '', '9-digit landline does not match /^0\\d{9}$/');
  assert.equal(ph('527654321'), '', 'a lost leading zero is not guessed');
  assert.equal(ph('123'), '');
  assert.equal(ph(''), '');
  assert.equal(ph('05276543210'), '', '11 digits');
});

test('UI: leadRequiredErrors — create checks both; edit checks only changed fields', () => {
  const pg = loadPage();
  const errs = pg.run('leadRequiredErrors');
  assert.deepEqual(Object.keys(arr(errs({ name: 'דנה', phone: '' }, null))).sort(), ['name', 'phone']);
  assert.deepEqual(arr(errs({ name: 'דנה כהן', phone: '0527654321' }, null)), {});
  const legacy = { name: 'דני', phone: '' };
  assert.deepEqual(arr(errs({ name: 'דני', phone: '' }, legacy)), {}, 'untouched incomplete lead saves');
  assert.deepEqual(arr(errs({ name: ' דני ', phone: '' }, legacy)), {}, 'whitespace-only change is no change');
  assert.deepEqual(Object.keys(arr(errs({ name: 'דני', phone: '123' }, legacy))), ['phone']);
  assert.deepEqual(Object.keys(arr(errs({ name: 'דניאל', phone: '' }, legacy))), ['name']);
  assert.match(pg.run('LEAD_NAME_REQUIRED_HE'), /שם מלא/);
  assert.match(pg.run('LEAD_PHONE_REQUIRED_HE'), /טלפון/);
});

function page(answerPost) {
  const pg = loadPage({ answerPost: answerPost || ((b) => serverEcho(b, { ok: true })) });
  pg.run(`showModal = (m) => { globalThis.__modal = m; };
          showConfirm = (o) => { o.onConfirm(); };
          showFieldErrors = (form, e) => { globalThis.__fieldErrors = JSON.parse(JSON.stringify(e)); };`);
  return pg;
}
const NEW = { name: 'דנה כהן', phone: '052-765-4321', contactName: '', contactPhone: '', contactRelation: '', billingMode: 'patient', house: '', source: '', assignedTo: 'ורד', meetingWith: '', note: '' };

test('UI: add-lead form refuses a one-word name / missing phone inline, sends nothing', async () => {
  const pg = page();
  pg.set({ leads: [] });
  pg.run('openAddLeadModal()');
  const fields = arr(pg.run('globalThis.__modal.fields'));
  assert.equal(fields.find((f) => f.name === 'phone').required, true);
  assert.equal(fields.find((f) => f.name === 'phone').inlineError, true);
  pg.sandbox.__v = Object.assign({}, NEW, { name: 'דנה', phone: '' });
  assert.equal(await pg.run('globalThis.__modal.onSubmit(globalThis.__v, {})'), false);
  assert.deepEqual(Object.keys(pg.sandbox.__fieldErrors).sort(), ['name', 'phone']);
  assert.equal(pg.posts.length, 0);
  assert.equal(pg.state().leads.length, 0);
});

test('UI: add-lead form stores a valid lead with the phone normalized to 0XXXXXXXXX', async () => {
  const pg = page();
  pg.set({ leads: [] });
  pg.run('openAddLeadModal()');
  pg.sandbox.__v = Object.assign({}, NEW);
  assert.notEqual(await pg.run('globalThis.__modal.onSubmit(globalThis.__v, {})'), false);
  const sent = pg.posts.find((b) => b.action === 'saveAll');
  assert.ok(sent);
  assert.equal(pg.state().leads[0].phone, '0527654321');
  assert.equal(pg.state().leads[0].name, 'דנה כהן');
});

test('UI: edit form — an incomplete legacy lead still saves other fields; a bad changed phone is refused', async () => {
  const pg = page();
  pg.set({ leads: [pg.run('normalizeLead')({ id: 'L-old', name: 'דני', phone: '', stage: 'new' })] });
  pg.run("openEditLeadModal(state.leads[0])");
  const base = { name: 'דני', phone: '', contactName: '', contactPhone: '', contactRelation: '', billingMode: 'patient', house: '', created: '', visitDate: '', visitTime: '', meetingWith: '', note: 'הערה חדשה' };
  pg.sandbox.__v = base;
  assert.notEqual(await pg.run('globalThis.__modal.onSubmit(globalThis.__v, {})'), false, 'other edits not blocked');
  assert.equal(pg.state().leads[0].note, 'הערה חדשה');
  pg.run("openEditLeadModal(state.leads[0])");
  pg.sandbox.__v = Object.assign({}, base, { phone: '123' });
  const before = pg.posts.length;
  assert.equal(await pg.run('globalThis.__modal.onSubmit(globalThis.__v, {})'), false);
  assert.deepEqual(Object.keys(pg.sandbox.__fieldErrors), ['phone']);
  assert.equal(pg.posts.length, before);
});

test('UI: showModal renders an inline error slot only for inlineError fields (escaped name)', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(src, /f\.inlineError \? `<div class="field-error" data-err="\$\{escapeHtml\(f\.name\)\}" role="alert"><\/div>`/);
  assert.match(src, /const ok = await onSubmit\(values, formTarget\);/);
});

/* ---------------- Server: Code.gs ---------------- */

function boot(leads) {
  const g = loadGs({ props: { PROXY_SECRET_MODE: 'enforce', PROXY_SECRET: PROXY, CREATE_LEAD_SECRET: 'create-lead-secret-TEST-000000000000' } });
  const lc = Array.from(g.run('LEAD_COLUMNS'));
  const ls = richSheet('Leads', lc);
  (leads || []).forEach((r) => ls.grid.push(lc.map((c) => r[c] ?? '')));
  g.sandbox.__sheets.Leads = ls;
  const save = (payload) => arr(g.post({ action: 'saveAll', proxySecret: PROXY, leads: JSON.stringify(payload), patients: JSON.stringify({}) }));
  const rows = () => ls.grid.slice(1).filter((r) => r.some((v) => v !== '' && v != null)).map((r) => Object.fromEntries(lc.map((c, i) => [c, r[i]])));
  return { g, save, rows };
}

test('server: a NEW lead with no name / no phone / a one-word name now saves (relaxed 20/11/2026)', () => {
  const { save, rows } = boot([]);
  // a one-word name + valid phone — was refused, now allowed
  let r = save([{ id: 'n1', name: 'דנה', phone: '0527654321', stage: 'new' }]);
  assert.equal(r.ok, true, 'one-word name accepted');
  // a named lead with no phone — allowed
  r = save([{ id: 'n2', name: 'דנה כהן', phone: '', stage: 'new' }]);
  assert.equal(r.ok, true, 'no phone accepted');
  // a fully nameless, phoneless intake row — allowed (house + source are enforced in the app)
  r = save([{ id: 'n3', name: '', phone: '', stage: 'new' }]);
  assert.equal(r.ok, true, 'nameless + phoneless accepted');
  assert.equal(rows().length, 3);
});

test('server: a NON-EMPTY invalid phone is still refused — the format guard is kept', () => {
  const { save, rows } = boot([]);
  let r = save([{ id: 'n1', name: 'דנה כהן', phone: '02-6543210', stage: 'new' }]);
  assert.equal(r.ok, false, '9-digit phone refused');
  assert.equal(r.error, 'invalid_lead');
  assert.equal(r.invalidLeads[0].field, 'phone');
  r = save([{ id: 'n1', name: '', phone: '123', stage: 'new' }]);
  assert.equal(r.ok, false, 'a typed junk phone is refused even on a nameless lead');
  assert.equal(r.invalidLeads[0].field, 'phone');
  assert.equal(rows().length, 0, 'nothing written');
});

test('server: a valid new lead saves (any phone format normalizing to 0XXXXXXXXX)', () => {
  const { save, rows } = boot([]);
  const r = save([{ id: 'n1', name: 'דנה כהן', phone: '+972-52-765-4321', stage: 'new' }]);
  assert.equal(r.ok, true);
  assert.equal(rows().length, 1);
});

test('server: an EXISTING incomplete lead is not blocked; only a changed NON-EMPTY bad phone is refused', () => {
  const { save, rows } = boot([{ id: 'L1', name: 'דני', phone: '', stage: 'new' }]);
  let r = save([{ id: 'L1', name: 'דני', phone: '', stage: 'visit' }]);
  assert.equal(r.ok, true, 'stage change on a legacy incomplete lead');
  assert.equal(rows()[0].stage, 'visit');
  r = save([{ id: 'L1', name: 'דני', phone: '123', stage: 'visit' }]);
  assert.equal(r.ok, false, 'a typed junk phone is refused');
  assert.equal(r.invalidLeads[0].field, 'phone');
  r = save([{ id: 'L1', name: 'X', phone: '', stage: 'visit' }]);
  assert.equal(r.ok, true, 'a one-word name is allowed now');
  r = save([{ id: 'L1', name: '', phone: '', stage: 'visit' }]);
  assert.equal(r.ok, true, 'clearing the name is allowed (captured at admission)');
});

test('server: direct_admin intake phone records are exempt from the 2-word rule', () => {
  const { save } = boot([]);
  const r = save([{ id: 'i1', name: 'משה', phone: '0527654321', stage: 'admitted', source: 'direct_admin' }]);
  assert.equal(r.ok, true);
});

test('server: one invalid new lead (bad phone) refuses the whole save (other leads untouched)', () => {
  const { save, rows } = boot([{ id: 'L1', name: 'דני לוי', phone: '0527654321', stage: 'new' }]);
  const r = save([{ id: 'L1', name: 'דני לוי', phone: '0527654321', stage: 'visit' }, { id: 'n2', name: 'רק', phone: '123', stage: 'new' }]);
  assert.equal(r.ok, false);
  assert.equal(rows()[0].stage, 'new', 'nothing written');
});

test('server: createLeadFromTherapists_ uses the same name rule; phone allows landlines (CHANGELOG-landline-handoff.md)', () => {
  const { g } = boot([]);
  const call = (o) => arr(g.post(Object.assign({ action: 'createLeadFromTherapists', secret: 'create-lead-secret-TEST-000000000000', name: 'דנה כהן', phone: '052-765-4321' }, o)));
  assert.equal(call({ name: 'דנה' }).error, 'invalid_name');
  assert.equal(call({ phone: '123' }).error, 'invalid_phone');
  assert.equal(call({ phone: '02-6543210' }).ok, true, '9-digit landline accepted on the handoff path');
  assert.equal(call({}).ok, true);
});
