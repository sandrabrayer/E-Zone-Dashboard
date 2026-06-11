/* Tests for the cross-app getAdmittedRoster endpoint in apps-script/Code.gs.
 *
 * Code.gs is Google Apps Script: it has no module.exports and its helpers call
 * SpreadsheetApp / PropertiesService, so we can't `require` it directly. Like
 * breakeven-revenue.test.js does for app.js, we read the source and evaluate it
 * in a vm sandbox, then override the two sheet helpers (getOrCreateSheet_ /
 * readSheet_) so getAdmittedRoster_ runs against in-memory fixtures. This
 * exercises the REAL shipped function — including the no-leak projection — and
 * not a reimplementation, so the contract is locked against the actual code. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadRoster() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'apps-script', 'Code.gs'),
    'utf8'
  );

  // Appended to the same script so it shares lexical scope with the top-level
  // `const PATIENT_COLUMNS` / `LEAD_COLUMNS` and the helper bindings. We stub
  // the sheet layer: getOrCreateSheet_ returns a tag, readSheet_ serves
  // whichever fixture array matches the columns it was asked for (compared by
  // reference against the very same const arrays the endpoint passes in).
  const epilogue = `
    let __patients = [];
    let __leads = [];
    getOrCreateSheet_ = function () { return {}; };
    readSheet_ = function (sh, columns) {
      if (columns === PATIENT_COLUMNS) return __patients;
      if (columns === LEAD_COLUMNS) return __leads;
      return [];
    };
    globalThis.__test = {
      setFixtures(p, l) { __patients = p || []; __leads = l || []; },
      roster() { return getAdmittedRoster_(); },
      normalizePhone(v) { return normalizePhone_(v); },
    };
  `;

  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    JSON, Math, Date, Number, String, Array, Object, RegExp,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + epilogue, sandbox);
  return sandbox.__test;
}

const api = loadRoster();

test('recovers phone via fromLead, normalizes, excludes released, no-leak projection', () => {
  api.setFixtures(
    [
      // Admitted, from a lead — sensitive fields present to prove they don't leak.
      { houseId: 'asher', name: 'דנה', fromLead: 'L1', exitDate: '', status: 'active',
        pay: 30000, adv: 5000, notes: 'sensitive note', source: 'lead' },
      // Admitted, +972 phone to exercise normalization.
      { houseId: 'ramot', name: 'מאיה', fromLead: 'L2', exitDate: '', status: 'trial' },
      // Released by exitDate AND status — excluded.
      { houseId: 'asher', name: 'יוסי', fromLead: 'L1', exitDate: '2026-05-01', status: 'released' },
      // direct_admin, no fromLead — admitted but no recoverable phone.
      { houseId: 'rehab', name: 'דני', fromLead: '', source: 'direct_admin', exitDate: '', status: 'active' },
      // Released by status only (blank exitDate) — still excluded.
      { houseId: 'asher', name: 'נועה', fromLead: 'L3', exitDate: '', status: 'released' },
    ],
    [
      { id: 'L1', phone: '050-123-4567', note: 'lead note', stage: 'paid' },
      { id: 'L2', phone: '+972527654321' },
      { id: 'L3', phone: '0500000000' },
    ]
  );

  const res = api.roster();
  assert.strictEqual(res.ok, true);
  const r = res.patients;

  // Both forms of "released" are excluded; the three admitted remain.
  assert.strictEqual(r.length, 3);

  const dana = r.find((x) => x.name === 'דנה');
  const maya = r.find((x) => x.name === 'מאיה');
  const dani = r.find((x) => x.name === 'דני');
  assert.strictEqual(dana.phone, '0501234567');   // separators stripped
  assert.strictEqual(maya.phone, '0527654321');   // 972 country code → leading 0
  assert.strictEqual(dani.phone, '');             // direct_admin → free-text fallback, never fabricated

  // No-leak contract: every row exposes EXACTLY these four keys.
  for (const row of r) {
    assert.deepStrictEqual(
      Object.keys(row).sort(),
      ['house', 'name', 'phone', 'sourceApp']
    );
  }
  // Defense in depth: none of the sensitive Leads/Patients fields appear under
  // any name, even though several were present on the source rows.
  const forbidden = ['note', 'notes', 'stage', 'pay', 'adv', 'advance',
    'price', 'pricing', 'source', 'fromLead', 'exitDate', 'status', 'date', 'id'];
  for (const row of r) {
    for (const f of forbidden) {
      assert.ok(!(f in row), 'leaked field: ' + f);
    }
  }
});

test('normalizePhone strips separators and collapses the 972 country code', () => {
  assert.strictEqual(api.normalizePhone('050-123-4567'), '0501234567');
  assert.strictEqual(api.normalizePhone('+972 52 765 4321'), '0527654321');
  assert.strictEqual(api.normalizePhone('972537778888'), '0537778888');
  assert.strictEqual(api.normalizePhone(''), '');
  assert.strictEqual(api.normalizePhone(null), '');
  assert.strictEqual(api.normalizePhone(undefined), '');
});
