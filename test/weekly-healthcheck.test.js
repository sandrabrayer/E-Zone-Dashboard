/* Tests for scripts/healthcheck.js — the weekly live-app healthcheck.
 *
 * The contract these tests lock:
 *   - CRITICAL detection: HTML-instead-of-JSON from getData, non-ok JSON,
 *     missing top-level keys, missing LEAD_COLUMNS / PATIENT_COLUMNS fields
 *     on sampled rows (stale Apps Script deployment signature);
 *   - WARNINGS never escalate: blank ids, malformed dates, duplicate
 *     non-restored discharge-audit rows all report without failing;
 *   - empty arrays SKIP (with a note), never fail;
 *   - missing APP_PIN → clear, actionable error that echoes no secret;
 *   - the runner never touches the network: fetch is injected everywhere.
 *
 * Everything runs against injected fixtures — the live URL is never hit. */

const { test } = require('node:test');
const assert = require('node:assert');
const hc = require('../scripts/healthcheck');

/* A minimal healthy getData payload matching getData_ in apps-script/Code.gs. */
function healthyData() {
  const lead = {};
  for (const c of hc.LEAD_COLUMNS) lead[c] = '';
  lead.id = 'L1';
  lead.entryDate = '2026-08-01';
  lead.visitDate = '2026-08-05';
  lead.created = '2026-07-30';

  const patient = {};
  for (const c of hc.PATIENT_COLUMNS) patient[c] = '';
  patient.houseId = 'ramot';
  patient.date = '2026-08-02';

  return {
    ok: true,
    leads: [lead],
    patients: { ramot: [patient] },
    irrelevantLeads: [],
    removedLeads: [],
    dischargedPatients: [],
    billingOverrides: [],
    houseManagers: {},
    managerPhones: {},
  };
}

/* ===== Config / APP_PIN ===== */

test('resolveConfig fails clearly when APP_PIN is unset, without echoing secrets', () => {
  assert.throws(() => hc.resolveConfig({}), (err) => {
    assert.match(err.message, /APP_PIN is not set/);
    assert.match(err.message, /repository secret/);
    // Nothing secret exists to echo, and the message promises none is printed.
    assert.match(err.message, /never printed/);
    return true;
  });
});

test('resolveConfig uses the default APP_URL and strips trailing slashes', () => {
  const cfg = hc.resolveConfig({ APP_PIN: '1234' });
  assert.strictEqual(cfg.appUrl, hc.DEFAULT_APP_URL);
  const cfg2 = hc.resolveConfig({ APP_PIN: '1234', APP_URL: 'https://x.test///' });
  assert.strictEqual(cfg2.appUrl, 'https://x.test');
});

/* ===== HTML shell ===== */

test('checkHtmlShell passes on a 200 with the index.html marker', () => {
  assert.deepStrictEqual(hc.checkHtmlShell(200, '<title>E-ZONE Dashboard</title>'), []);
});

test('checkHtmlShell is critical on non-200 or a missing marker', () => {
  assert.strictEqual(hc.checkHtmlShell(503, 'nope').length, 1);
  assert.strictEqual(hc.checkHtmlShell(200, '<html>something else</html>').length, 1);
});

/* ===== Session cookie extraction ===== */

test('extractSessionCookie pulls the ezone_session pair and ignores attributes', () => {
  const cookie = hc.extractSessionCookie(['ezone_session=abc.def; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800; Secure']);
  assert.strictEqual(cookie, 'ezone_session=abc.def');
});

test('extractSessionCookie returns empty when the cookie is absent or valueless', () => {
  assert.strictEqual(hc.extractSessionCookie(['other=1; Path=/']), '');
  assert.strictEqual(hc.extractSessionCookie(['ezone_session=; Path=/']), '');
  assert.strictEqual(hc.extractSessionCookie([]), '');
});

/* ===== getData body: HTML detection, JSON, ok:true ===== */

test('HTML instead of JSON from getData is detected as critical', () => {
  const { criticals, data } = hc.checkDataBody(200, '<!DOCTYPE html><html><body>Google Drive error</body></html>');
  assert.strictEqual(data, null);
  assert.strictEqual(criticals.length, 1);
  assert.match(criticals[0], /HTML page, not JSON/);
});

test('unparseable JSON and ok:false are critical', () => {
  assert.strictEqual(hc.checkDataBody(200, 'not json at all').criticals.length, 1);
  const notOk = hc.checkDataBody(200, JSON.stringify({ ok: false, error: 'boom' }));
  assert.strictEqual(notOk.data, null);
  assert.match(notOk.criticals[0], /not ok:true/);
});

test('a healthy JSON body parses with no criticals', () => {
  const { criticals, data } = hc.checkDataBody(200, JSON.stringify(healthyData()));
  assert.deepStrictEqual(criticals, []);
  assert.strictEqual(data.ok, true);
});

/* ===== Top-level keys ===== */

test('missing top-level key is critical', () => {
  const d = healthyData();
  delete d.billingOverrides;
  const criticals = hc.checkTopLevelKeys(d);
  assert.strictEqual(criticals.length, 1);
  assert.match(criticals[0], /billingOverrides/);
});

test('all expected top-level keys present → no criticals', () => {
  assert.deepStrictEqual(hc.checkTopLevelKeys(healthyData()), []);
});

/* ===== Column presence (stale-deployment detector) ===== */

test('a lead missing a LEAD_COLUMNS field is critical', () => {
  const d = healthyData();
  delete d.leads[0].waitlistedAt;
  const { criticals } = hc.checkColumnPresence(d);
  assert.strictEqual(criticals.length, 1);
  assert.match(criticals[0], /waitlistedAt/);
  assert.match(criticals[0], /stale deployment/);
});

test('a patient missing a PATIENT_COLUMNS field is critical', () => {
  const d = healthyData();
  delete d.patients.ramot[0].notes;
  const { criticals } = hc.checkColumnPresence(d);
  assert.strictEqual(criticals.length, 1);
  assert.match(criticals[0], /notes/);
});

test('empty leads array → skip with a note, not a failure', () => {
  const d = healthyData();
  d.leads = [];
  const { criticals, notes } = hc.checkColumnPresence(d);
  assert.deepStrictEqual(criticals, []);
  assert.strictEqual(notes.filter((n) => /Leads array is empty/.test(n)).length, 1);
});

test('empty patients object → skip with a note, not a failure', () => {
  const d = healthyData();
  d.patients = {};
  const { criticals, notes } = hc.checkColumnPresence(d);
  assert.deepStrictEqual(criticals, []);
  assert.strictEqual(notes.filter((n) => /patient column-presence check skipped/.test(n)).length, 1);
});

/* ===== Warnings never fail ===== */

test('blank lead id is a warning, and a warning only', () => {
  const d = healthyData();
  d.leads[0].id = '   ';
  const warnings = hc.warnBlankIds(d);
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0], /Blank lead id/);
  // The same data raises NO criticals anywhere.
  assert.deepStrictEqual(hc.checkTopLevelKeys(d), []);
  assert.deepStrictEqual(hc.checkColumnPresence(d).criticals, []);
});

test('malformed date fields are warnings, identified without names', () => {
  const d = healthyData();
  d.leads[0].visitDate = '13/07/2026';          // Sheets-coerced format
  d.leads[0].created = 'Sat Aug 01 2026';       // date-part fails too
  d.patients.ramot[0].date = '2026-8-2';        // not zero-padded
  const warnings = hc.warnMalformedDates(d);
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0], /3 non-empty date field/);
  assert.match(warnings[0], /lead\.visitDate \(id L1\)/);
  assert.match(warnings[0], /lead\.created/);
  assert.match(warnings[0], /patient\.date \(house ramot position 0\)/);
});

test('valid and empty date fields raise no warnings', () => {
  assert.deepStrictEqual(hc.warnMalformedDates(healthyData()), []);
});

test('created accepts an ISO timestamp whose date-part is valid', () => {
  const d = healthyData();
  d.leads[0].created = '2026-08-01T10:30:00.000Z';
  assert.deepStrictEqual(hc.warnMalformedDates(d), []);
});

test('duplicate non-restored discharge-audit rows warn by fromLead and houseId+name — ids only', () => {
  const rows = [
    { id: 'D1', fromLead: 'L9', houseId: 'ramot', name: 'שם חסוי', restored: '' },
    { id: 'D2', fromLead: 'L9', houseId: 'ramot', name: 'שם חסוי', restored: '' },
    { id: 'D3', fromLead: 'L9', houseId: 'ramot', name: 'שם חסוי', restored: 'TRUE' }, // restored → excluded
  ];
  const warnings = hc.warnDuplicateDischargeAudit(rows);
  assert.strictEqual(warnings.length, 2); // one per grouping dimension
  for (const w of warnings) {
    assert.match(w, /D1/);
    assert.match(w, /D2/);
    assert.doesNotMatch(w, /D3/);
    assert.doesNotMatch(w, /שם חסוי/); // NO patient names in CI output
  }
});

test('restored rows (string TRUE or boolean) never count toward duplicates', () => {
  const rows = [
    { id: 'D1', fromLead: 'L1', houseId: 'ramot', name: 'x', restored: 'TRUE' },
    { id: 'D2', fromLead: 'L1', houseId: 'ramot', name: 'x', restored: true },
  ];
  assert.deepStrictEqual(hc.warnDuplicateDischargeAudit(rows), []);
});

test('collectWarnings on healthy data is empty', () => {
  assert.deepStrictEqual(hc.collectWarnings(healthyData()), []);
});

/* ===== End-to-end runner with an injected fetch (network never touched) ===== */

function fakeFetchFor(routes) {
  return async (url) => {
    for (const [suffix, resp] of Object.entries(routes)) {
      if (String(url).includes(suffix)) {
        return {
          status: resp.status,
          headers: {
            getSetCookie: () => resp.setCookie || [],
            get: (h) => (h.toLowerCase() === 'set-cookie' ? (resp.setCookie || [])[0] || null : null),
          },
          text: async () => resp.body,
        };
      }
    }
    // '/' matches last: the shell route
    const shell = routes['/'];
    return { status: shell.status, headers: { getSetCookie: () => [], get: () => null }, text: async () => shell.body };
  };
}

const TEST_ENV = { APP_PIN: '0000', APP_URL: 'https://healthcheck.invalid' };

test('run() exits 0 on a fully healthy app (warnings alone never fail)', async () => {
  const d = healthyData();
  // Add a data-quality wart: a blank lead id — must stay a warning.
  const wartLead = {};
  for (const c of hc.LEAD_COLUMNS) wartLead[c] = '';
  d.leads.push(wartLead);
  const fetchFn = fakeFetchFor({
    '/api/verify-pin': { status: 200, body: '{"ok":true}', setCookie: ['ezone_session=tok123; HttpOnly; Path=/'] },
    '/api/sheets?action=getData': { status: 200, body: JSON.stringify(d) },
    '/': { status: 200, body: '<title>E-ZONE Dashboard</title>' },
  });
  assert.strictEqual(await hc.run(TEST_ENV, fetchFn), 0);
});

test('run() exits 1 when getData serves the Google HTML error page', async () => {
  const fetchFn = fakeFetchFor({
    '/api/verify-pin': { status: 200, body: '{"ok":true}', setCookie: ['ezone_session=tok123; HttpOnly'] },
    '/api/sheets?action=getData': { status: 200, body: '<html><body>Sorry, unable to open the file</body></html>' },
    '/': { status: 200, body: '<title>E-ZONE Dashboard</title>' },
  });
  assert.strictEqual(await hc.run(TEST_ENV, fetchFn), 1);
});

test('run() exits 1 when the PIN is rejected', async () => {
  const fetchFn = fakeFetchFor({
    '/api/verify-pin': { status: 401, body: '{"ok":false,"error":"invalid_pin"}' },
    '/': { status: 200, body: '<title>E-ZONE Dashboard</title>' },
  });
  assert.strictEqual(await hc.run(TEST_ENV, fetchFn), 1);
});

test('run() exits 1 without touching the network when APP_PIN is missing', async () => {
  let called = false;
  const fetchFn = async () => { called = true; throw new Error('must not be called'); };
  assert.strictEqual(await hc.run({ APP_URL: 'https://healthcheck.invalid' }, fetchFn), 1);
  assert.strictEqual(called, false);
});

/* The healthcheck's duplicated column lists must track the real constants in
 * apps-script/Code.gs — parse them out of the source so a future append there
 * fails THIS suite until scripts/healthcheck.js is updated to match. */
test('LEAD_COLUMNS / PATIENT_COLUMNS stay in sync with apps-script/Code.gs', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
  const grab = (name) => {
    const m = src.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`));
    assert.ok(m, `${name} not found in Code.gs`);
    // Strip the block/line comments interleaved in the array literal — they
    // contain quoted words that would pollute the parse.
    const bare = m[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    return [...bare.matchAll(/'([^']+)'/g)].map((x) => x[1]);
  };
  assert.deepStrictEqual(hc.LEAD_COLUMNS, grab('LEAD_COLUMNS'));
  assert.deepStrictEqual(hc.PATIENT_COLUMNS, grab('PATIENT_COLUMNS'));
});
