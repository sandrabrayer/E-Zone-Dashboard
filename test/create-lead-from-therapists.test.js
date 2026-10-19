'use strict';

/* createLeadFromTherapists — CHANGELOG-create-lead-from-therapists.md.
 * Own fail-closed CREATE_LEAD_SECRET; appends one allow-listed lead; idempotent by phone. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { richSheet, loadGs } = require('./helpers/gs-sandbox');

const SECRET = 'create-lead-secret-TEST-0123456789';
const arr = (x) => JSON.parse(JSON.stringify(x));
const src = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');

function boot({ secret = SECRET, leads } = {}) {
  const props = { PROXY_SECRET_MODE: 'enforce', PROXY_SECRET: 'proxy-secret-TEST-create-lead-000000000' };
  if (secret !== null) props.CREATE_LEAD_SECRET = secret;
  const g = loadGs({ props });
  const lc = Array.from(g.run('LEAD_COLUMNS'));
  const ls = richSheet('Leads', lc);
  (leads || []).forEach((r) => ls.grid.push(lc.map((c) => r[c] ?? '')));
  g.sandbox.__sheets.Leads = ls;
  const call = (extra = {}, s = SECRET) => arr(g.post({
    action: 'createLeadFromTherapists', secret: s, name: 'דנה כהן', phone: '052-765-4321',
    house: 'asher', program: 'בית ביניים', by: 'שרה', ...extra }));
  const rows = () => ls.grid.slice(1).map((r) => Object.fromEntries(lc.map((c, i) => [c, r[i]])));
  return { g, call, rows };
}

test('fail-closed: unset / blank / wrong / PROXY_SECRET → unauthorized, nothing written', () => {
  for (const b of [boot({ secret: null }), boot({ secret: '' })]) {
    assert.deepStrictEqual(b.call(), { ok: false, error: 'unauthorized' });
    assert.strictEqual(b.rows().length, 0);
  }
  const { call, rows } = boot();
  assert.deepStrictEqual(call({}, ''), { ok: false, error: 'unauthorized' });
  assert.deepStrictEqual(call({}, 'wrong'), { ok: false, error: 'unauthorized' });
  assert.deepStrictEqual(call({}, 'proxy-secret-TEST-create-lead-000000000'), { ok: false, error: 'unauthorized' });
  assert.strictEqual(rows().length, 0);
});

test('creates exactly one lead; stage/source/id/created are server-set', () => {
  const { call, rows } = boot();
  const r = call({ stage: 'paid', source: 'evil', id: 'x', created: '1999-01-01' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.created, true);
  const [row] = rows();
  assert.strictEqual(rows().length, 1);
  assert.strictEqual(row.stage, 'new');
  assert.strictEqual(row.source, 'alumni_therapists');
  assert.notStrictEqual(row.id, 'x');
  assert.ok(/^id-[0-9a-z]{8,}$/i.test(row.id), row.id);
  assert.strictEqual(row.phone, '0527654321');
  assert.notStrictEqual(row.created, '1999-01-01');
  assert.match(row.note, /תוכנית מוצעת: בית ביניים/);
  assert.strictEqual(row.assignedTo, '');
});

test('idempotent: same phone (any format) → alreadyExists, no second row', () => {
  const { call, rows } = boot();
  const a = call();
  const b = call({ phone: '+972527654321' });
  assert.strictEqual(b.alreadyExists, true);
  assert.strictEqual(b.leadId, a.leadId);
  assert.strictEqual(rows().length, 1);
});

test('validation: bad name/phone refused; formulas neutralised; assignee allow-listed', () => {
  const { call, rows } = boot();
  assert.strictEqual(call({ name: ' ' }).error, 'invalid_name');
  assert.strictEqual(call({ phone: '123' }).error, 'invalid_phone');
  assert.strictEqual(call({ phone: '' }).error, 'invalid_phone');
  assert.strictEqual(rows().length, 0);
  assert.strictEqual(call({ name: '=HYPERLINK("x") כהן', assignedTo: 'hacker' }).ok, true);
  const [row] = rows();
  assert.ok(!/^[=+\-@]/.test(row.name));
  assert.strictEqual(row.assignedTo, '');
  assert.strictEqual(call({ phone: '0541112222', assignedTo: 'ורד' }).ok, true);
  assert.strictEqual(rows()[1].assignedTo, 'ורד');
});

test('structure: gated inside handle_, in OPEN_ACTIONS + PROXY_KNOWN_ACTIONS, under the script lock', () => {
  const { g } = boot();
  assert.ok(Array.from(g.run('OPEN_ACTIONS')).includes('createLeadFromTherapists'));
  assert.ok(Array.from(g.run('PROXY_KNOWN_ACTIONS')).includes('createLeadFromTherapists'));
  assert.match(src, /if \(action === 'createLeadFromTherapists'\) \{\n\s*\/\/[^\n]*\n\s*if \(!createLeadAuthOk_\(params\)\) return jsonOut_\(\{ ok: false, error: 'unauthorized' \}\);/);
  const fn = src.slice(src.indexOf('function createLeadFromTherapists_'), src.indexOf('/* Normalize a phone to canonical'));
  assert.match(fn, /LockService\.getScriptLock\(\)/);
});
