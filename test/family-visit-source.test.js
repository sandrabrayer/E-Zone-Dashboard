/* Synthetic test for familyVisitSource_ (issue #421): read-only single-lead read. */
process.env.TZ = 'Asia/Jerusalem';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load(rows, { noSheet = false, extraHeaders = [], omit = [] } = {}) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
  const noop = () => {};
  const headers = Object.keys(lead()).reverse().filter(key => !omit.includes(key)).concat(extraHeaders);
  const grid = [headers].concat(rows.map(row => headers.map(k => row[k] || '')));
  const sheet = { getLastRow: () => grid.length, getLastColumn: () => headers.length,
    getRange: (r, c, h, w) => ({ getValues: () => grid.slice(r - 1, r - 1 + h).map(row => row.slice(c - 1, c - 1 + w)) }) };
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    JSON, Math, Date, Number, String, Array, Object, RegExp,
    SpreadsheetApp: { getActiveSpreadsheet: () => ({
      getSpreadsheetTimeZone: () => 'Asia/Jerusalem',
      getSheetByName: () => (noSheet ? null : sheet),
    }) },
    Utilities: { formatDate: () => '09:30' },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + '\nglobalThis.__t = { familyVisitSource_: familyVisitSource_ };', sandbox);
  return sandbox.__t;
}
const op = { verified: true, auth: 'personal', id: 'u1', caps: [], roles: ['staff'] };
const lead = (o) => Object.assign({ id: 'L-1', name: 'Test Patient', phone: '0501234567', house: 'h1', stage: 'visit',
  visitDate: '2026-12-01', visitTime: '10:00', meetingWith: 'Mgr', meetingOutcome: '', meetingReportOutcome: '',
  contactName: 'Test Contact', contactPhone: '0521234567', billingPhone: '0539999999' }, o || {});

test('returns the exact lead projection, never billingPhone', () => {
  const r = load([lead(), lead({ id: 'L-2' })]).familyVisitSource_('L-1', op);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(Object.keys(r.lead), ['id', 'stage', 'house', 'visitDate', 'visitTime', 'meetingWith',
    'meetingOutcome', 'meetingReportOutcome', 'phone', 'name', 'contactName', 'contactPhone']);
  assert.strictEqual(r.lead.visitDate, '2026-12-01');
  assert.strictEqual(r.lead.visitTime, '10:00');
  assert.ok(!JSON.stringify(r).includes('0539999999'));
});
test('missing / ambiguous / no sheet', () => {
  assert.deepStrictEqual({ ...load([lead()]).familyVisitSource_('L-9', op) }, { ok: false, error: 'missing_visit' });
  assert.strictEqual(load([lead()]).familyVisitSource_('', op).error, 'missing_visit');
  assert.strictEqual(load([lead(), lead()]).familyVisitSource_('L-1', op).error, 'ambiguous_visit');
  assert.strictEqual(load([], { noSheet: true }).familyVisitSource_('L-1', op).error, 'missing_visit');
});
test('fails closed for non-operators', () => {
  const f = load([lead()]).familyVisitSource_;
  for (const a of [null, {}, { verified: false, auth: 'personal', id: 'u', caps: [] },
    { verified: true, auth: 'proxy', id: '', caps: [] }, { verified: true, auth: 'personal', id: 'u', caps: ['billingControl'] }]) {
    assert.strictEqual(f('L-1', a).error, 'forbidden');
  }
});
test('dispatch is registered beside contactIndex', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
  assert.match(src, /'contactIndex',\s*\/\/[^\n]*\n\s*'getFamilyVisitSource'/);
  assert.match(src, /action === 'getFamilyVisitSource'/);
});

test('uses current headers and a canonical house; ambiguous or missing eligibility fields block the read', () => {
  assert.equal(load([lead({ house: 'efroni' })]).familyVisitSource_('L-1', op).lead.house, 'arfoni');
  assert.equal(load([lead()], { extraHeaders: ['phone'] }).familyVisitSource_('L-1', op).error, 'invalid_visit_source');
  assert.equal(load([lead()], { omit: ['meetingOutcome'] }).familyVisitSource_('L-1', op).error, 'invalid_visit_source');
  assert.equal(load([lead()], { omit: ['contactPhone'] }).familyVisitSource_('L-1', op).lead.contactPhone, '');
  assert.equal(load([lead()]).familyVisitSource_('L-1', { ...op, roles: ['viewer'] }).error, 'forbidden');
});
