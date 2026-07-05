/* Tests for the cross-app getAdmittedRoster endpoint in apps-script/Code.gs.
 *
 * Code.gs is Google Apps Script: it has no module.exports and its helpers call
 * SpreadsheetApp / PropertiesService, so we can't `require` it directly. Like
 * breakeven-revenue.test.js does for app.js, we read the source and evaluate it
 * in a vm sandbox, then override the two sheet helpers (getOrCreateSheet_ /
 * readSheet_) so getAdmittedRoster_ runs against in-memory fixtures. This
 * exercises the REAL shipped function — including the no-leak projection — and
 * not a reimplementation, so the contract is locked against the actual code. */

// asISODate_ formats Date-typed cells via the sheet timezone; pin it so the
// entryDate assertions are deterministic regardless of the host machine zone.
process.env.TZ = 'Asia/Jerusalem';

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
      setSecret(v) { globalThis.__secret = v; },
      roster() { return getAdmittedRoster_(); },
      // Drive the real dispatch + auth gate; parse the stubbed jsonOut_ payload.
      dispatch(params) { return JSON.parse(handle_(params)._text); },
      normalizePhone(v) { return normalizePhone_(v); },
    };
  `;

  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    JSON, Math, Date, Number, String, Array, Object, RegExp,
    // Reads the script property the auth gate consults; undefined when unset.
    PropertiesService: {
      getScriptProperties() {
        return {
          getProperty(key) {
            return key === 'ADMITTED_ROSTER_SECRET'
              ? (sandbox.__secret === undefined ? null : sandbox.__secret)
              : null;
          },
        };
      },
    },
    // asISODate_ reads the sheet timezone and formats Date cells; stub both so
    // the Date→YYYY-MM-DD branch runs (TZ is pinned to Asia/Jerusalem above).
    SpreadsheetApp: {
      getActiveSpreadsheet() {
        return { getSpreadsheetTimeZone() { return 'Asia/Jerusalem'; } };
      },
    },
    Utilities: {
      formatDate(d) {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
      },
    },
    // jsonOut_ wraps the payload in ContentService output; capture the text.
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput(text) {
        return { _text: text, setMimeType() { return this; } };
      },
    },
  };
  sandbox.globalThis = sandbox;
  sandbox.__secret = undefined;
  vm.createContext(sandbox);
  vm.runInContext(src + epilogue, sandbox);
  return sandbox.__test;
}

const api = loadRoster();

test('recovers phone via fromLead, normalizes, excludes released, no-leak projection', () => {
  api.setFixtures(
    [
      // Admitted, from a lead — sensitive fields present to prove they don't leak.
      // date is a plain YYYY-MM-DD string (the canonicalized column form).
      { houseId: 'asher', name: 'דנה', fromLead: 'L1', exitDate: '', status: 'active',
        date: '2026-01-15', pay: 30000, adv: 5000, notes: 'sensitive note', source: 'lead' },
      // Admitted, +972 phone to exercise normalization; date arrives as a
      // Date-typed cell (Sheets sometimes hands back Date objects).
      { houseId: 'ramot', name: 'מאיה', fromLead: 'L2', exitDate: '', status: 'trial',
        date: new Date(2026, 2, 3) },
      // Released by exitDate AND status — excluded.
      { houseId: 'asher', name: 'יוסי', fromLead: 'L1', exitDate: '2026-05-01', status: 'released' },
      // direct_admin, no fromLead — admitted but no recoverable phone; blank
      // date must yield entryDate ''.
      { houseId: 'rehab', name: 'דני', fromLead: '', source: 'direct_admin', exitDate: '', status: 'active',
        date: '' },
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

  // entryDate (admission date) is surfaced for the outpatient מסלול המשך tab.
  assert.strictEqual(dana.entryDate, '2026-01-15'); // string cell passthrough
  assert.strictEqual(maya.entryDate, '2026-03-03'); // Date cell → YYYY-MM-DD
  assert.strictEqual(dani.entryDate, '');           // blank cell → ''

  // No-leak contract: every row exposes EXACTLY these five keys — the derived
  // entryDate is additive; the raw sensitive columns still never appear.
  for (const row of r) {
    assert.deepStrictEqual(
      Object.keys(row).sort(),
      ['entryDate', 'house', 'name', 'phone', 'sourceApp']
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

test('fail-closed: unset secret property refuses and serves no patient data', () => {
  api.setSecret(undefined); // ADMITTED_ROSTER_SECRET not configured
  api.setFixtures(
    [{ houseId: 'asher', name: 'דנה', fromLead: 'L1', exitDate: '', status: 'active' }],
    [{ id: 'L1', phone: '0501234567' }]
  );
  const res = api.dispatch({ action: 'getAdmittedRoster', secret: 'anything' });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'unauthorized');
  assert.ok(!('patients' in res)); // never serve the roster
});

test('fail-closed: empty-string secret property refuses', () => {
  api.setSecret('');
  api.setFixtures(
    [{ houseId: 'asher', name: 'דנה', fromLead: 'L1', exitDate: '', status: 'active' }],
    [{ id: 'L1', phone: '0501234567' }]
  );
  const res = api.dispatch({ action: 'getAdmittedRoster', secret: '' });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'unauthorized');
  assert.ok(!('patients' in res));
});

test('fail-closed: mismatched secret refuses and serves no patient data', () => {
  api.setSecret('correct-horse');
  api.setFixtures(
    [{ houseId: 'asher', name: 'דנה', fromLead: 'L1', exitDate: '', status: 'active' }],
    [{ id: 'L1', phone: '0501234567' }]
  );
  const res = api.dispatch({ action: 'getAdmittedRoster', secret: 'wrong-secret' });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'unauthorized');
  assert.ok(!('patients' in res));

  // Missing secret entirely is also refused.
  const res2 = api.dispatch({ action: 'getAdmittedRoster' });
  assert.strictEqual(res2.ok, false);
  assert.strictEqual(res2.error, 'unauthorized');
});

test('matching secret authorizes and returns the roster', () => {
  api.setSecret('correct-horse');
  api.setFixtures(
    [{ houseId: 'asher', name: 'דנה', fromLead: 'L1', exitDate: '', status: 'active' }],
    [{ id: 'L1', phone: '050-123-4567' }]
  );
  const res = api.dispatch({ action: 'getAdmittedRoster', secret: 'correct-horse' });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.patients.length, 1);
  assert.strictEqual(res.patients[0].phone, '0501234567');
});

test('normalizePhone strips separators and collapses the 972 country code', () => {
  assert.strictEqual(api.normalizePhone('050-123-4567'), '0501234567');
  assert.strictEqual(api.normalizePhone('+972 52 765 4321'), '0527654321');
  assert.strictEqual(api.normalizePhone('972537778888'), '0537778888');
  assert.strictEqual(api.normalizePhone(''), '');
  assert.strictEqual(api.normalizePhone(null), '');
  assert.strictEqual(api.normalizePhone(undefined), '');
});
