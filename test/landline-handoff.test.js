'use strict';

/* Landline on the server-to-server lead handoff (CHANGELOG-landline-handoff.md).
 * createLeadFromTherapists_ (the non-UI caller) accepts a 10-digit mobile OR a
 * 9-digit landline /^0[2-9]\d{7}$/ after normalizePhone_. The Dashboard UI form
 * and its saveAll path stay mobile-only. A refused handoff returns an explicit
 * error code AND is logged (console + AuditLog) without the phone or name.
 * Names / phones are SYNTHETIC. app.js and Code.gs are REAL. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadPage } = require('./helpers/app-sandbox');
const { serverEcho } = require('./helpers/server-echo');
const { richSheet, loadGs } = require('./helpers/gs-sandbox');

const PROXY = 'proxy-secret-TEST-landline-handoff-0000000';
const SECRET = 'create-lead-secret-TEST-landline-00000000';
const arr = (x) => JSON.parse(JSON.stringify(x));
const LANDLINE = '02-6543210';
const INVALID = ['123', '', '0265432', '01-2345678', '05276543210', 'abc'];

function boot() {
  const g = loadGs({ props: { PROXY_SECRET_MODE: 'enforce', PROXY_SECRET: PROXY, CREATE_LEAD_SECRET: SECRET } });
  const lc = Array.from(g.run('LEAD_COLUMNS'));
  const ls = richSheet('Leads', lc);
  g.sandbox.__sheets.Leads = ls;
  const handoff = (o) => arr(g.post(Object.assign({ action: 'createLeadFromTherapists', secret: SECRET, name: 'דנה כהן', phone: '052-765-4321', by: 'שרה' }, o)));
  const save = (payload) => arr(g.post({ action: 'saveAll', proxySecret: PROXY, leads: JSON.stringify(payload), patients: JSON.stringify({}) }));
  const rows = () => ls.grid.slice(1).filter((r) => r.some((v) => v !== '' && v != null)).map((r) => Object.fromEntries(lc.map((c, i) => [c, r[i]])));
  const audit = () => g.sheetRows('AuditLog', 'AUDIT_LOG_COLUMNS');
  return { g, handoff, save, rows, audit };
}

function uiPage() {
  const pg = loadPage({ answerPost: (b) => serverEcho(b, { ok: true }) });
  pg.run(`showModal = (m) => { globalThis.__modal = m; };
          showConfirm = (o) => { o.onConfirm(); };
          showFieldErrors = (form, e) => { globalThis.__fieldErrors = JSON.parse(JSON.stringify(e)); };`);
  return pg;
}
const NEW = { name: 'דנה כהן', phone: '052-765-4321', contactName: '', contactPhone: '', contactRelation: '', billingMode: 'patient', house: '', source: '', assignedTo: 'ורד', meetingWith: '', note: '' };

/* ---------------- pure rule ---------------- */

test('leadHandoffPhone_: mobile + 9-digit landline (any format) → normalized; else ""', () => {
  const { g } = boot();
  const ph = g.run('leadHandoffPhone_');
  assert.equal(ph('052-765-4321'), '0527654321');
  assert.equal(ph(LANDLINE), '026543210');
  assert.equal(ph('+972-3-6543210'), '036543210');
  assert.equal(ph('(09) 876 5432'), '098765432');
  for (const bad of INVALID.concat(['02654321', '00-2654321', '+972-1-2345678'])) assert.equal(ph(bad), '', bad);
  // The UI / saveAll rule is untouched: still mobile-only.
  assert.equal(g.run('leadPhoneOk_')(LANDLINE), false);
});

/* ---------------- handoff path ---------------- */

test('handoff: a 9-digit landline is accepted, stored normalized, idempotent', () => {
  const { handoff, rows } = boot();
  const r = handoff({ phone: LANDLINE });
  assert.equal(r.ok, true);
  assert.equal(r.created, true);
  assert.equal(rows().length, 1);
  assert.equal(rows()[0].phone, '026543210');
  const again = handoff({ phone: '+972 2 654 3210' });
  assert.equal(again.alreadyExists, true);
  assert.equal(again.leadId, r.leadId);
  assert.equal(rows().length, 1);
});

test('handoff: an invalid number is refused with an explicit code, logged, nothing written', () => {
  const { g, handoff, rows, audit } = boot();
  for (const bad of INVALID) {
    const r = handoff({ phone: bad });
    assert.deepEqual(r, { ok: false, error: 'invalid_phone' }, bad);
  }
  assert.equal(rows().length, 0, 'never a lead row');
  const refused = audit().filter((a) => a.action === 'lead_handoff_refused');
  assert.equal(refused.length, INVALID.length, 'every refusal audited — never silently dropped');
  assert.equal(refused[0].fn, 'createLeadFromTherapists_');
  assert.equal(refused[0].actor, 'שרה');
  assert.equal(JSON.parse(refused[0].details).error, 'invalid_phone');
  assert.ok(g.logs.some((l) => l.includes('[lead-handoff] refused invalid_phone')), 'console log');
  // PII: neither the phone digits nor the name are logged.
  const blob = JSON.stringify(refused) + g.logs.join('\n');
  assert.ok(!blob.includes('05276543210') && !blob.includes('0265432') && !blob.includes('012345678'), 'no phone in logs');
  assert.ok(!blob.includes('דנה כהן'), 'no name in logs');
});

test('handoff: an invalid name refusal is logged too', () => {
  const { handoff, audit } = boot();
  assert.deepEqual(handoff({ name: 'דנה', phone: LANDLINE }), { ok: false, error: 'invalid_name' });
  const [a] = audit().filter((x) => x.action === 'lead_handoff_refused');
  assert.equal(JSON.parse(a.details).error, 'invalid_name');
});

test('handoff: the landline rule never runs before auth (fail-closed, nothing logged as a lead)', () => {
  const { handoff, rows } = boot();
  assert.deepEqual(handoff({ phone: LANDLINE, secret: 'wrong' }), { ok: false, error: 'unauthorized' });
  assert.equal(rows().length, 0);
});

/* ---------------- Dashboard UI form stays strict ---------------- */

test('UI form: a landline is refused inline and nothing is sent', async () => {
  const pg = uiPage();
  assert.equal(pg.run('leadLocalPhone')(LANDLINE), '');
  pg.set({ leads: [] });
  pg.run('openAddLeadModal()');
  pg.sandbox.__v = Object.assign({}, NEW, { phone: LANDLINE });
  assert.equal(await pg.run('globalThis.__modal.onSubmit(globalThis.__v, {})'), false);
  assert.deepEqual(Object.keys(pg.sandbox.__fieldErrors), ['phone']);
  assert.equal(pg.posts.length, 0);
  assert.equal(pg.state().leads.length, 0);
});

test('UI save path (saveAll): a landline is still refused server-side', () => {
  const { save, rows } = boot();
  const r = save([{ id: 'n1', name: 'דנה כהן', phone: LANDLINE, stage: 'new' }]);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'invalid_lead');
  assert.equal(r.invalidLeads[0].field, 'phone');
  assert.equal(rows().length, 0);
});

test('UI form + saveAll: an invalid number is refused too', async () => {
  const pg = uiPage();
  pg.set({ leads: [] });
  pg.run('openAddLeadModal()');
  pg.sandbox.__v = Object.assign({}, NEW, { phone: '123' });
  assert.equal(await pg.run('globalThis.__modal.onSubmit(globalThis.__v, {})'), false);
  assert.equal(pg.posts.length, 0);
  const { save, rows } = boot();
  assert.equal(save([{ id: 'n1', name: 'דנה כהן', phone: '123', stage: 'new' }]).error, 'invalid_lead');
  assert.equal(rows().length, 0);
});
