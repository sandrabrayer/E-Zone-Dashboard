/* Dashboard load/save performance — see CHANGELOG-dashboard-load-perf.md.
 *
 * Every server test runs the REAL apps-script/Code.gs in a vm over fake
 * sheets that RECORD each Sheets/Lock/Cache/Properties call, so the claims
 * the PR makes are locked as call counts, not as timings:
 *
 *   A. getData_ at rest: ONE getValues per sheet, ZERO writes, no lock, no
 *      timezone lookups — and a sheet that needs an id heal is still healed.
 *   B. getPayments_: one Payments read, no lock for orphan rows (a blank
 *      patientUid whose key matches no patient), the lock only when there is
 *      something to fill; the cached key set holds hashes, never names.
 *   C. getCredits_: one read, no writes at rest; a blank creditUid is minted.
 *   D. handle_ drops the read cache AFTER every Patients write action (also
 *      when it throws) and never on a read.
 *   E. saveAll: an unchanged Leads payload writes nothing to Leads; a changed
 *      lead or a legacy Date cell still gets the full write.
 *   F. The digest: an unchanged request-path rebuild skips opening the digest
 *      spreadsheet; a change, the hourly backstop, a missed lock, a failed
 *      write and a missing cache all still write.
 *   G. managerPhones_ / asISOTime_ small wins, and the timing log lines carry
 *      milliseconds and counts only.
 *   H. app.js loadAll starts its three reads together, stays fail-soft, and
 *      logs one timing line.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const GS_SRC = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const SW_SRC = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');

const noop = () => {};
// Hebrew letters, built without an escape sequence in this file.
const HEBREW = new RegExp('[' + String.fromCharCode(0x05D0) + '-' + String.fromCharCode(0x05EA) + ']');

/* ===================================================================== */
/* The server harness                                                     */
/* ===================================================================== */

function pad2(n) { return String(n).padStart(2, '0'); }
function fmtDate(d, _tz, fmt) {
  const y = d.getUTCFullYear(), mo = pad2(d.getUTCMonth() + 1), da = pad2(d.getUTCDate());
  const h = pad2(d.getUTCHours()), mi = pad2(d.getUTCMinutes()), s = pad2(d.getUTCSeconds());
  if (fmt === 'HH:mm') return h + ':' + mi;
  if (fmt === 'yyyy-MM-dd') return y + '-' + mo + '-' + da;
  return y + '-' + mo + '-' + da + 'T' + h + ':' + mi + ':' + s + '+0000';
}

/* opts:
 *   noCache      — no CacheService at all (the pre-PR world)
 *   lockResult   — what tryLock returns (default true)
 *   digest       — configure the digest spreadsheet id
 *   props        — extra Script Properties
 *   noGetProperties — a properties store without getProperties()
 *   propsThrow   — PropertiesService.getScriptProperties() throws */
function loadCode(opts) {
  opts = opts || {};
  const calls = [];
  const logs = [];
  const sheets = {};
  const cacheStore = {};
  const rec = (op, sheet, extra) => calls.push(Object.assign({ op, sheet }, extra || {}));

  function fakeSheet(name, header, rows) {
    const grid = [header.slice()].concat(rows.map((r) => r.slice()));
    return {
      __name: name, grid,
      getName() { return name; },
      getLastRow() { rec('getLastRow', name); return grid.length; },
      getLastColumn() { rec('getLastColumn', name); return grid[0] ? grid[0].length : 0; },
      getMaxRows() { rec('getMaxRows', name); return Math.max(grid.length, 1000); },
      getMaxColumns() { return 60; },
      setFrozenRows() { rec('write:setFrozenRows', name); },
      hideSheet() { rec('write:hideSheet', name); },
      isSheetHidden() { return true; },
      getRange(r, c, nr, nc) {
        nr = nr || 1; nc = nc || 1;
        return {
          setNumberFormat() { rec('write:setNumberFormat', name); return this; },
          getValue() { const g = grid[r - 1]; return g && g[c - 1] !== undefined ? g[c - 1] : ''; },
          setValue(v) {
            rec('write:setValue', name);
            if (!grid[r - 1]) grid[r - 1] = [];
            grid[r - 1][c - 1] = v;
            return this;
          },
          getValues() {
            rec('getValues', name, { cells: nr * nc });
            const out = [];
            for (let i = 0; i < nr; i++) {
              const row = [];
              for (let j = 0; j < nc; j++) {
                const g = grid[r - 1 + i];
                row.push(g && g[c - 1 + j] !== undefined ? g[c - 1 + j] : '');
              }
              out.push(row);
            }
            return out;
          },
          setValues(vals) {
            rec('write:setValues', name, { cells: vals.length * (vals[0] || []).length });
            for (let i = 0; i < vals.length; i++) {
              if (!grid[r - 1 + i]) grid[r - 1 + i] = [];
              for (let j = 0; j < vals[i].length; j++) grid[r - 1 + i][c - 1 + j] = vals[i][j];
            }
            return this;
          },
          clearContent() { rec('write:clearContent', name); return this; },
        };
      },
    };
  }

  const digestTab = { body: [] };
  const digestSheet = {
    getRange(r, c, nr) {
      return {
        setValues(vals) {
          if (r === 1) return this;
          for (let i = 0; i < vals.length; i++) digestTab.body[r - 2 + i] = vals[i].slice();
          return this;
        },
        clearContent() { digestTab.body = []; return this; },
      };
    },
    setFrozenRows: noop,
    getLastRow() { return digestTab.body.length + 1; },
  };

  const props = Object.assign({}, opts.props || {});
  if (opts.digest) props.DIGEST_SPREADSHEET_ID = 'digest-ss';

  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    JSON, Math, Date, Number, String, Array, Object, RegExp, isFinite, Error,
    Logger: { log: (m) => logs.push(String(m)) },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({
        getSheetByName: (n) => sheets[n] || null,
        insertSheet: (n) => { rec('write:insertSheet', n); return (sheets[n] = fakeSheet(n, [], [])); },
        getSpreadsheetTimeZone: () => { rec('tz'); return 'Asia/Jerusalem'; },
      }),
      openById: () => {
        rec('openById');
        if (sandbox.__openByIdThrows) throw new Error('digest unavailable');
        return { getSheetByName: () => digestSheet, insertSheet: () => digestSheet };
      },
    },
    PropertiesService: {
      getScriptProperties() {
        if (opts.propsThrow) throw new Error('no properties');
        const store = {
          getProperty(k) { rec('getProperty'); return Object.prototype.hasOwnProperty.call(props, k) ? props[k] : null; },
          setProperty(k, v) { props[k] = v; return this; },
        };
        if (!opts.noGetProperties) store.getProperties = () => { rec('getProperties'); return Object.assign({}, props); };
        return store;
      },
    },
    Utilities: {
      getUuid: (() => { let n = 0; return () => 'uuid-' + (++n); })(),
      formatDate: fmtDate,
    },
    LockService: {
      getScriptLock: () => ({
        tryLock: () => { rec('lock'); return opts.lockResult === undefined ? true : opts.lockResult; },
        releaseLock: noop,
      }),
    },
    ContentService: {
      createTextOutput: (s) => ({ setMimeType: () => ({ json: JSON.parse(s) }) }),
      MimeType: { JSON: 'json' },
    },
  };
  if (!opts.noCache) {
    sandbox.CacheService = {
      getScriptCache: () => ({
        get: (k) => { rec('cache.get', null, { key: k }); return Object.prototype.hasOwnProperty.call(cacheStore, k) ? cacheStore[k] : null; },
        put: (k, v) => { rec('cache.put', null, { key: k }); cacheStore[k] = v; },
        remove: (k) => { rec('cache.remove', null, { key: k }); delete cacheStore[k]; },
      }),
    };
  }
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(GS_SRC + `
    globalThis.__g = {
      handle: (p) => handle_(p).json,
      getData: () => getData_(),
      getPayments: () => getPayments_(),
      getCredits: () => getCredits_(),
      managerPhones: () => managerPhones_(),
      asISOTime: (v) => asISOTime_(v),
      fastHash: (s) => fastHash_(s),
      hourlyDigest: () => rebuildActivePatientsDigest(),
      LEAD_COLUMNS, PATIENT_COLUMNS, IRRELEVANT_LEAD_COLUMNS, REMOVED_LEAD_COLUMNS,
      DISCHARGED_PATIENT_COLUMNS, BILLING_OVERRIDE_COLUMNS, PAYMENT_COLUMNS, CREDIT_COLUMNS,
      PATIENT_TOMBSTONE_COLUMNS, AUDIT_LOG_COLUMNS,
      LEADS_SHEET, PATIENTS_SHEET, IRRELEVANT_LEADS_SHEET, REMOVED_LEADS_SHEET,
      DISCHARGED_PATIENTS_SHEET, BILLING_OVERRIDES_SHEET, PAYMENTS_SHEET, CREDITS_SHEET,
      PATIENTS_TOMBSTONES_SHEET, AUDIT_LOG_SHEET,
      READ_CACHE_PATIENT_KEYS, DIGEST_WRITTEN_SIG_KEY, PATIENTS_WRITE_ACTIONS,
      MANAGER_PHONES,
    };`, sandbox);
  const g = sandbox.__g;

  const rowOf = (cols, f) => Array.from(cols).map((c) => (f[c] === undefined ? '' : f[c]));
  const seed = (name, cols, objs) => { sheets[name] = fakeSheet(name, Array.from(cols), objs.map((o) => rowOf(cols, o))); };
  const reset = () => { calls.length = 0; logs.length = 0; };
  const count = (op, sheet) => calls.filter((c) => c.op === op && (sheet === undefined || c.sheet === sheet)).length;
  const writes = (sheet) => calls.filter((c) => c.op.indexOf('write:') === 0 && (sheet === undefined || c.sheet === sheet)).length;
  const cell = (sheetName, rowIdx, col) => {
    const sh = sheets[sheetName];
    return sh.grid[rowIdx + 1][sh.grid[0].indexOf(col)];
  };
  return { g, sandbox, sheets, calls, logs, cacheStore, digestTab, seed, reset, count, writes, cell };
}

const HOUSES = ['arfoni', 'rehab', 'asher', 'pardes', 'ramot', 'sde'];
const patientKey = (i) => HOUSES[i % 6] + '::' + 'מטופל ' + i + '::2026-0' + (1 + (i % 8)) + '-01';

/* A small but complete world: every sheet getData_ reads, clean at rest. */
function world(opts) {
  opts = opts || {};
  const w = loadCode(opts);
  const g = w.g;
  w.seed(g.LEADS_SHEET, g.LEAD_COLUMNS, Array.from({ length: opts.leads || 12 }, (_, i) => ({
    id: 'lead-' + i, name: 'ליד ' + i, phone: '0500000' + pad2(i), house: 'רמות השבים',
    stage: 'new', created: '2026-05-01',
    visitDate: i % 3 ? '2026-06-0' + (1 + (i % 9)) : '', visitTime: i % 3 ? '1' + (i % 9) + ':30' : '',
  })));
  w.seed(g.PATIENTS_SHEET, g.PATIENT_COLUMNS, Array.from({ length: opts.patients || 12 }, (_, i) => ({
    id: 'id-p' + i, houseId: HOUSES[i % 6], name: 'מטופל ' + i, date: '2026-0' + (1 + (i % 8)) + '-01',
    pay: 9000, status: 'active', source: 'lead',
    updatedAt: '2026-09-01T08:00:00.000Z', updatedBy: 'ורד',
  })));
  w.seed(g.IRRELEVANT_LEADS_SHEET, g.IRRELEVANT_LEAD_COLUMNS, [{ id: 'irr-1', name: 'לא רלוונטי', stage: 'irrelevant' }]);
  w.seed(g.REMOVED_LEADS_SHEET, g.REMOVED_LEAD_COLUMNS, [{ id: 'rem-1', name: 'הוסר' }]);
  w.seed(g.DISCHARGED_PATIENTS_SHEET, g.DISCHARGED_PATIENT_COLUMNS, [{ id: 'aud-1', houseId: 'ramot', name: 'שוחרר', date: '2026-01-01', restored: 'TRUE' }]);
  w.seed(g.BILLING_OVERRIDES_SHEET, g.BILLING_OVERRIDE_COLUMNS, [{ patientId: 'x', month: '2026-08', amount: '9000' }]);
  const payments = opts.payments || Array.from({ length: 20 }, (_, i) => ({
    id: 'pay::' + patientKey(i % 12) + '::2026-0' + (1 + (i % 9)) + '-01', patientId: patientKey(i % 12),
    amount: 9000, status: 'paid', paymentUid: 'pmt-' + i, patientUid: 'id-p' + (i % 12),
  }));
  w.seed(g.PAYMENTS_SHEET, g.PAYMENT_COLUMNS, payments);
  w.seed(g.CREDITS_SHEET, g.CREDIT_COLUMNS, opts.credits || [{ id: 'credit::1', creditUid: 'crd-1', amount: 100, status: 'paid' }]);
  w.seed(g.PATIENTS_TOMBSTONES_SHEET, g.PATIENT_TOMBSTONE_COLUMNS, []);
  w.seed(g.AUDIT_LOG_SHEET, g.AUDIT_LOG_COLUMNS, []);
  w.reset();
  return w;
}

/* The payload the client would send: everything it just loaded, as copies. */
function clientSnapshot(w) {
  const d = w.g.handle({ action: 'getData' });
  const patients = {};
  HOUSES.forEach((h) => { patients[h] = (d.patients[h] || []).map((p) => Object.assign({}, p)); });
  return { leads: d.leads.map((l) => Object.assign({}, l)), patients };
}
const saveAll = (w, snap) => w.g.handle({ action: 'saveAll', user: 'ורד', leads: snap.leads, patients: snap.patients });

/* ===================================================================== */
/* A. getData_                                                            */
/* ===================================================================== */

test('A: getData_ at rest reads each of its six sheets ONCE and writes nothing', () => {
  const w = world();
  const res = w.g.getData();
  assert.equal(res.ok, true);
  const g = w.g;
  [g.LEADS_SHEET, g.PATIENTS_SHEET, g.IRRELEVANT_LEADS_SHEET, g.REMOVED_LEADS_SHEET,
   g.DISCHARGED_PATIENTS_SHEET, g.BILLING_OVERRIDES_SHEET].forEach((name) => {
    assert.equal(w.count('getValues', name), 1, name + ' is read exactly once');
  });
  assert.equal(w.count('getValues'), 6, 'no other sheet is read');
  assert.equal(w.writes(), 0, 'no setNumberFormat, no setValue(s), no header write on a load');
  assert.equal(w.count('lock'), 0, 'a clean load never takes the script lock');
  assert.equal(w.count('tz'), 0, "clean 'HH:MM' visit times need no timezone lookup");
});

test('A: getData_ still returns every key and row it returned before', () => {
  const w = world();
  const res = w.g.getData();
  ['ok', 'leads', 'patients', 'irrelevantLeads', 'removedLeads', 'dischargedPatients',
   'billingOverrides', 'houseManagers', 'managerPhones'].forEach((k) => assert.ok(k in res, 'has ' + k));
  assert.equal(res.leads.length, 12);
  assert.equal(Object.values(res.patients).reduce((n, a) => n + a.length, 0), 12);
  assert.equal(res.leads[1].visitTime, '11:30');
  assert.equal(res.irrelevantLeads[0].id, 'irr-1');
  assert.equal(res.managerPhones['חנן'], w.g.MANAGER_PHONES['חנן']);
});

test('A: a blank lead id is still healed on read, and the answer carries the STORED id', () => {
  const w = world();
  w.sheets[w.g.LEADS_SHEET].grid[3][w.g.LEAD_COLUMNS.indexOf('id')] = '';
  w.reset();
  const res = w.g.getData();
  const stored = w.cell(w.g.LEADS_SHEET, 2, 'id');
  assert.match(String(stored), /^id-uuid-/, 'the blank cell was written');
  assert.ok(res.leads.some((l) => l.id === stored), 'the client receives exactly the stored id');
  assert.equal(w.count('getValues', w.g.LEADS_SHEET), 3, 'read, backfill re-check, one re-read after the heal');
});

test('A: a blank patient id is healed under the lock and drops the cached key set', () => {
  const w = world();
  w.cacheStore[w.g.READ_CACHE_PATIENT_KEYS] = '[]';
  w.sheets[w.g.PATIENTS_SHEET].grid[2][w.g.PATIENT_COLUMNS.indexOf('id')] = '';
  w.reset();
  const res = w.g.getData();
  const stored = w.cell(w.g.PATIENTS_SHEET, 1, 'id');
  assert.match(String(stored), /^id-uuid-/);
  assert.ok(Object.values(res.patients).some((a) => a.some((p) => p.id === stored)));
  assert.equal(w.count('lock'), 1);
  assert.ok(!(w.g.READ_CACHE_PATIENT_KEYS in w.cacheStore), 'new ids → the key set is recomputed next time');
});

test('A: a missing sheet is still created on the first read (the one-time setup stays)', () => {
  const w = world();
  delete w.sheets[w.g.REMOVED_LEADS_SHEET];
  w.reset();
  const res = w.g.getData();
  assert.equal(res.ok, true);
  assert.deepEqual(res.removedLeads.length, 0);
  assert.equal(w.count('write:insertSheet', w.g.REMOVED_LEADS_SHEET), 1);
  assert.deepEqual(w.sheets[w.g.REMOVED_LEADS_SHEET].grid[0], Array.from(w.g.REMOVED_LEAD_COLUMNS));
});

test('A: a sheet whose header is SHORTER than the columns is still extended on read', () => {
  const w = world();
  const sh = w.sheets[w.g.PATIENTS_SHEET];
  sh.grid[0] = sh.grid[0].slice(0, w.g.PATIENT_COLUMNS.length - 1);
  w.reset();
  w.g.getData();
  assert.deepEqual(sh.grid[0].slice(0, w.g.PATIENT_COLUMNS.length), Array.from(w.g.PATIENT_COLUMNS));
});

/* ===================================================================== */
/* B. getPayments_                                                        */
/* ===================================================================== */

function orphanPayments() {
  const rows = Array.from({ length: 20 }, (_, i) => ({
    id: 'pay-' + i, patientId: patientKey(i % 12), amount: 9000, status: 'paid',
    paymentUid: 'pmt-' + i, patientUid: 'id-p' + (i % 12),
  }));
  // Historical money for a patient row that no longer exists: blank patientUid
  // FOREVER — that is what blank means.
  rows.push({ id: 'pay-gone', patientId: 'ramot::' + 'לשעבר' + '::2025-01-01', amount: 9000, status: 'paid', paymentUid: 'pmt-gone', patientUid: '' });
  return rows;
}

test('B: orphan rows no longer send EVERY getPayments through the lock', () => {
  const w = world({ payments: orphanPayments() });
  const res = w.g.getPayments();
  assert.equal(res.ok, true);
  assert.equal(res.payments.length, 21);
  assert.equal(w.count('lock'), 0, 'nothing to fill → no lock (it used to lock on every read)');
  assert.equal(w.count('getValues', w.g.PAYMENTS_SHEET), 1, 'Payments is read once');
  assert.equal(w.writes(), 0, 'no writes at all');
  assert.equal(w.count('getValues', w.g.PATIENTS_SHEET), 1, 'cold: Patients read once for the key set');

  w.reset();
  w.g.getPayments();
  assert.equal(w.count('getValues', w.g.PATIENTS_SHEET), 0, 'warm: the key set comes from the cache');
  assert.equal(w.count('getValues', w.g.PAYMENTS_SHEET), 1);
  assert.equal(w.count('lock'), 0);
});

test('B: a RESOLVABLE blank patientUid is still filled under the lock and returned', () => {
  const rows = orphanPayments();
  rows[4].patientUid = '';   // key patientKey(4) → id-p4
  const w = world({ payments: rows });
  const res = w.g.getPayments();
  assert.equal(w.count('lock'), 1);
  assert.equal(w.cell(w.g.PAYMENTS_SHEET, 4, 'patientUid'), 'id-p4', 'the cell is filled');
  assert.equal(res.payments.find((p) => p.id === 'pay-4').patientUid, 'id-p4', 'and the answer carries it');
  assert.equal(res.payments.find((p) => p.id === 'pay-gone').patientUid, '', 'the orphan stays blank');
});

test('B: a blank paymentUid is still minted under the lock and returned', () => {
  const rows = orphanPayments();
  rows[2].paymentUid = '';
  const w = world({ payments: rows });
  const res = w.g.getPayments();
  assert.equal(w.count('lock'), 1);
  const minted = w.cell(w.g.PAYMENTS_SHEET, 2, 'paymentUid');
  assert.match(String(minted), /^pmt-uuid-/);
  assert.equal(res.payments.find((p) => p.id === 'pay-2').paymentUid, minted);
});

test('B: the cached key set holds short hashes — never a name, a key or a uid', () => {
  const w = world({ payments: orphanPayments() });
  w.g.getPayments();
  const raw = w.cacheStore[w.g.READ_CACHE_PATIENT_KEYS];
  assert.ok(raw, 'cached');
  const arr = JSON.parse(raw);
  assert.equal(arr.length, 12, 'one hash per resolvable patient key');
  arr.forEach((h) => assert.match(h, /^[0-9a-z]{1,11}$/));
  assert.ok(!HEBREW.test(raw), 'no Hebrew text');
  assert.ok(!raw.includes('::') && !raw.includes('id-p'), 'no billing key, no patient id');
});

test('B: without CacheService getPayments_ behaves exactly as with it (fail-soft)', () => {
  const rows = orphanPayments();
  rows[4].patientUid = '';
  const w = world({ payments: rows, noCache: true });
  const res = w.g.getPayments();
  assert.equal(res.ok, true);
  assert.equal(res.payments.find((p) => p.id === 'pay-4').patientUid, 'id-p4');
  w.reset();
  w.g.getPayments();
  assert.equal(w.count('lock'), 0, 'converged: orphans alone never lock');
});

test('B: a CacheService that THROWS (e.g. refused by the deployment) is treated as absent', () => {
  const rows = orphanPayments();
  rows[4].patientUid = '';
  const w = world({ payments: rows });
  w.sandbox.CacheService = { getScriptCache() { throw new Error('not authorized'); } };
  const res = w.g.getPayments();
  assert.equal(res.ok, true);
  assert.equal(res.payments.find((p) => p.id === 'pay-4').patientUid, 'id-p4');
  w.sandbox.CacheService = { getScriptCache: () => ({
    get() { throw new Error('boom'); }, put() { throw new Error('boom'); }, remove() { throw new Error('boom'); },
  }) };
  assert.equal(w.g.getPayments().ok, true);
  assert.equal(w.g.handle({ action: 'saveAll', user: 'x' }).ok, true, 'a failing remove never breaks a write');
});

test('B: a stale key set can only delay a fill — invalidation after a write brings it back', () => {
  const rows = orphanPayments();
  const w = world({ payments: rows });
  w.g.getPayments();   // caches the key set WITHOUT the patient added below
  // A new patient appears behind the cache's back (hand edit) + a payment row for it.
  const g = w.g;
  const pRow = g.PATIENT_COLUMNS.map((c) => ({ id: 'id-new', houseId: 'ramot', name: 'חדשה', date: '2026-09-01', status: 'active' })[c] || '');
  w.sheets[g.PATIENTS_SHEET].grid.push(pRow);
  const payRow = g.PAYMENT_COLUMNS.map((c) => ({ id: 'pay-new', patientId: 'ramot::' + 'חדשה' + '::2026-09-01', amount: 9000, status: 'due', paymentUid: 'pmt-new' })[c] || '');
  w.sheets[g.PAYMENTS_SHEET].grid.push(payRow);
  w.reset();
  w.g.getPayments();
  assert.equal(w.count('lock'), 0, 'stale cache: the pre-scan does not see the new patient yet');
  assert.equal(w.sheets[g.PAYMENTS_SHEET].grid.at(-1)[g.PAYMENT_COLUMNS.indexOf('patientUid')], '');
  // Any Patients write action drops the cache …
  saveAll(w, clientSnapshot(w));
  w.reset();
  const res = w.g.getPayments();
  assert.equal(w.count('lock'), 1, '… so the next read sees it and fills it');
  assert.equal(res.payments.find((p) => p.id === 'pay-new').patientUid, 'id-new');
});

/* ===================================================================== */
/* C. getCredits_                                                         */
/* ===================================================================== */

test('C: getCredits_ at rest: one read, no writes, no lock', () => {
  const w = world();
  const res = w.g.getCredits();
  assert.equal(res.credits.length, 1);
  assert.equal(w.count('getValues', w.g.CREDITS_SHEET), 1);
  assert.equal(w.writes(), 0);
  assert.equal(w.count('lock'), 0);
});

test('C: a blank creditUid is still minted and returned', () => {
  const w = world({ credits: [{ id: 'credit::1', creditUid: '', amount: 100, status: 'paid' }] });
  const res = w.g.getCredits();
  assert.equal(w.count('lock'), 1);
  const minted = w.cell(w.g.CREDITS_SHEET, 0, 'creditUid');
  assert.match(String(minted), /^crd-uuid-/);
  assert.equal(res.credits[0].creditUid, minted);
});

/* ===================================================================== */
/* D. Cache invalidation in handle_                                       */
/* ===================================================================== */

test('D: every Patients write action drops the cached key set — reads never do', () => {
  const w = world();
  const key = w.g.READ_CACHE_PATIENT_KEYS;
  const removed = () => w.calls.filter((c) => c.op === 'cache.remove' && c.key === key).length;
  assert.deepEqual(Array.from(w.g.PATIENTS_WRITE_ACTIONS).sort(),
    ['deletePatientRow', 'dischargePatient', 'recordDischargeFromCoordinators', 'restorePatient', 'restorePatientToActive', 'saveAll']);
  Array.from(w.g.PATIENTS_WRITE_ACTIONS).forEach((action) => {
    w.cacheStore[key] = '[]';
    w.reset();
    w.g.handle({ action, user: 'ורד' });   // bad/empty payloads: refused or thrown — still dropped
    assert.ok(removed() >= 1, action + ' drops the cache');
    assert.ok(!(key in w.cacheStore), action + ' leaves no cached key set');
  });
  ['getData', 'getPayments', 'getCredits', 'savePayment', 'saveCredit'].forEach((action) => {
    w.cacheStore[key] = '[]';
    w.reset();
    w.g.handle({ action });
    assert.equal(removed(), 0, action + ' keeps the cache');
  });
});

test('D: the drop happens AFTER the write and never changes the response', () => {
  const w = world();
  const snap = clientSnapshot(w);
  w.reset();
  const res = saveAll(w, snap);
  assert.equal(res.ok, true);
  const lastPatientsWrite = w.calls.map((c, i) => (c.op.indexOf('write:') === 0 && c.sheet === w.g.PATIENTS_SHEET ? i : -1))
    .filter((i) => i >= 0).pop();
  const drop = w.calls.findIndex((c) => c.op === 'cache.remove' && c.key === w.g.READ_CACHE_PATIENT_KEYS);
  assert.ok(lastPatientsWrite !== undefined && drop > lastPatientsWrite, 'dropped after the Patients writes');
});

/* ===================================================================== */
/* E. saveAll → mergeLeads_                                               */
/* ===================================================================== */

test('E: a save that changed NO lead writes nothing to Leads (a patient edit)', () => {
  const w = world();
  const snap = clientSnapshot(w);
  snap.patients.ramot[0].pay = 9100;
  const before = JSON.stringify(w.sheets[w.g.LEADS_SHEET].grid);
  w.reset();
  const res = saveAll(w, snap);
  assert.equal(res.ok, true);
  assert.equal(w.count('write:setValues', w.g.LEADS_SHEET), 0, 'no Leads rewrite');
  assert.equal(w.count('write:clearContent', w.g.LEADS_SHEET), 0);
  assert.equal(JSON.stringify(w.sheets[w.g.LEADS_SHEET].grid), before);
  assert.ok(w.count('write:setValues', w.g.PATIENTS_SHEET) >= 1, 'the patient edit itself is written');
});

test('E: a changed lead still gets the full write', () => {
  const w = world();
  const snap = clientSnapshot(w);
  snap.leads[5].note = 'שיחה חוזרת';
  w.reset();
  saveAll(w, snap);
  assert.equal(w.count('write:setValues', w.g.LEADS_SHEET), 1);
  const row = w.sheets[w.g.LEADS_SHEET].grid.find((r) => r[0] === 'lead-5');
  assert.equal(row[w.g.LEAD_COLUMNS.indexOf('note')], 'שיחה חוזרת');
});

test('E: a new lead still gets the full write', () => {
  const w = world();
  const snap = clientSnapshot(w);
  snap.leads.push({ id: 'lead-new', name: 'חדש', stage: 'new', created: '2026-09-29' });
  w.reset();
  saveAll(w, snap);
  assert.equal(w.count('write:setValues', w.g.LEADS_SHEET), 1);
  assert.ok(w.sheets[w.g.LEADS_SHEET].grid.some((r) => r[0] === 'lead-new'));
});

test('E: a legacy Date cell is still healed to text even when the payload matches', () => {
  const w = world();
  const snap = clientSnapshot(w);
  const vIdx = w.g.LEAD_COLUMNS.indexOf('visitDate');
  // lead-1 has visitDate '2026-06-02'; the sheet cell became a Date.
  w.sheets[w.g.LEADS_SHEET].grid[2][vIdx] = new Date(Date.UTC(2026, 5, 2));
  w.reset();
  saveAll(w, snap);
  assert.equal(w.count('write:setValues', w.g.LEADS_SHEET), 1, 'the Date cell forces the write');
  assert.equal(w.sheets[w.g.LEADS_SHEET].grid[2][vIdx], '2026-06-02');
});

test('E: a lead the payload OMITS keeps its row — and its legacy Date cell is still healed', () => {
  const w = world();
  const snap = clientSnapshot(w);
  const vIdx = w.g.LEAD_COLUMNS.indexOf('visitDate');
  // lead-1 was added by another tab: this tab's payload does not carry it, and
  // its sheet cell is a legacy Date. Kept rows go first, so the row order is
  // unchanged — only the heal makes this a write.
  w.sheets[w.g.LEADS_SHEET].grid.splice(1, 0, w.sheets[w.g.LEADS_SHEET].grid.splice(2, 1)[0]);
  w.sheets[w.g.LEADS_SHEET].grid[1][vIdx] = new Date(Date.UTC(2026, 5, 2));
  snap.leads = snap.leads.filter((l) => l.id !== 'lead-1');
  w.reset();
  saveAll(w, snap);
  assert.equal(w.count('write:setValues', w.g.LEADS_SHEET), 1);
  assert.equal(w.sheets[w.g.LEADS_SHEET].grid[1][0], 'lead-1', 'the omitted lead is kept');
  assert.equal(w.sheets[w.g.LEADS_SHEET].grid[1][vIdx], '2026-06-02', 'and healed to text');
});

test('E: the meeting-report guard still keeps the sheet copy (and then nothing changed)', () => {
  const w = world();
  const snap = clientSnapshot(w);
  const g = w.g;
  const at = g.LEAD_COLUMNS.indexOf('meetingReportedAt');
  const note = g.LEAD_COLUMNS.indexOf('meetingNote');
  // A manager reported AFTER the tab loaded: the sheet has the report, the payload does not.
  w.sheets[g.LEADS_SHEET].grid[1][at] = '2026-09-28T10:00:00.000Z';
  w.sheets[g.LEADS_SHEET].grid[1][note] = 'דוח מנהל';
  w.reset();
  const res = saveAll(w, snap);
  assert.deepEqual(Array.from(res.reportConflicts), ['lead-0']);
  assert.equal(w.sheets[g.LEADS_SHEET].grid[1][note], 'דוח מנהל', 'the report survives');
  assert.equal(w.count('write:setValues', g.LEADS_SHEET), 0, 'and there was nothing else to write');
});

/* ===================================================================== */
/* F. The digest                                                          */
/* ===================================================================== */

test('F: an unchanged request-path rebuild skips opening the digest spreadsheet', () => {
  const w = world({ digest: true });
  const snap = clientSnapshot(w);
  w.reset();
  saveAll(w, snap);
  assert.equal(w.count('openById'), 1, 'first save: nothing recorded yet → write');
  assert.equal(w.digestTab.body.length, 10, '12 residents, the two in sde are not exported');
  assert.ok(w.cacheStore[w.g.DIGEST_WRITTEN_SIG_KEY], 'what was written is recorded');

  const snap2 = clientSnapshot(w);
  snap2.patients.ramot[0].pay = 9100;   // not a digest column
  w.reset();
  saveAll(w, snap2);
  assert.equal(w.count('openById'), 0, 'same active population → no digest write');
  assert.equal(w.digestTab.body.length, 10);
});

test('F: a change to the active population is written', () => {
  const w = world({ digest: true });
  saveAll(w, clientSnapshot(w));
  const snap = clientSnapshot(w);
  snap.patients.ramot[0].name = 'שם חדש';
  w.reset();
  saveAll(w, snap);
  assert.equal(w.count('openById'), 1);
  assert.ok(w.digestTab.body.some((r) => r[1] === 'שם חדש'));
});

test('F: a Patients sheet that only REORDERED is not a change', () => {
  const w = world({ digest: true });
  saveAll(w, clientSnapshot(w));
  const grid = w.sheets[w.g.PATIENTS_SHEET].grid;
  const body = grid.slice(1).reverse();
  grid.splice(1, body.length, ...body);
  w.reset();
  saveAll(w, clientSnapshot(w));
  assert.equal(w.count('openById'), 0);
});

test('F: the hourly backstop ALWAYS writes', () => {
  const w = world({ digest: true });
  saveAll(w, clientSnapshot(w));
  w.reset();
  const res = w.g.hourlyDigest();
  assert.equal(res.ok, true);
  assert.equal(res.skipped, undefined);
  assert.equal(w.count('openById'), 1);
});

test('F: a busy lock writes nothing and records nothing, so the next rebuild writes', () => {
  // Since the lock-busy work (#161–#163) writeDigestRows_ THROWS on a busy
  // lock before it touches the tab; refreshDigestBestEffort_ swallows it.
  const opts = { digest: true, lockResult: false };
  const w = world(opts);
  saveAll(w, clientSnapshot(w));
  assert.equal(w.count('openById'), 0, 'nothing opened under a busy lock');
  assert.ok(!(w.g.DIGEST_WRITTEN_SIG_KEY in w.cacheStore));
  opts.lockResult = true;
  w.reset();
  saveAll(w, clientSnapshot(w));
  assert.equal(w.count('openById'), 1);
});

test('F: a failed write forgets the old record, so the next rebuild writes', () => {
  const w = world({ digest: true });
  saveAll(w, clientSnapshot(w));
  assert.ok(w.cacheStore[w.g.DIGEST_WRITTEN_SIG_KEY]);
  w.sandbox.__openByIdThrows = true;
  assert.throws(() => w.g.hourlyDigest(), /digest unavailable/);
  assert.ok(!(w.g.DIGEST_WRITTEN_SIG_KEY in w.cacheStore), 'record dropped before the write started');
  w.sandbox.__openByIdThrows = false;
  w.reset();
  saveAll(w, clientSnapshot(w));
  assert.equal(w.count('openById'), 1);
});

test('F: without CacheService every rebuild writes (the behaviour before this PR)', () => {
  const w = world({ digest: true, noCache: true });
  saveAll(w, clientSnapshot(w));
  w.reset();
  saveAll(w, clientSnapshot(w));
  assert.equal(w.count('openById'), 1);
});

test('F: the digest record is a hash — no patient name in the cache', () => {
  const w = world({ digest: true });
  saveAll(w, clientSnapshot(w));
  const raw = w.cacheStore[w.g.DIGEST_WRITTEN_SIG_KEY];
  assert.match(JSON.parse(raw), /^[0-9a-z]{1,11}$/);
  assert.ok(!HEBREW.test(raw));
});

test('F: the digest re-reads Patients without re-formatting it', () => {
  const w = world({ digest: true });
  w.reset();
  w.g.hourlyDigest();
  assert.equal(w.writes(w.g.PATIENTS_SHEET), 0);
});

/* ===================================================================== */
/* G. Small wins + the timing log                                         */
/* ===================================================================== */

test('G: managerPhones_ reads Script Properties in ONE call, overrides still win', () => {
  const w = loadCode({ props: { ['MANAGER_PHONE_' + 'חנן']: ' 972500000001 ', ['MANAGER_PHONE_' + 'רנטה']: '  ' } });
  const phones = w.g.managerPhones();
  assert.equal(w.count('getProperties'), 1);
  assert.equal(w.count('getProperty'), 0);
  assert.equal(phones['חנן'], '972500000001', 'the override wins, trimmed (unchanged rule)');
  assert.equal(phones['רנטה'], w.g.MANAGER_PHONES['רנטה'], 'a blank override falls back');
  assert.equal(phones['עידו'], w.g.MANAGER_PHONES['עידו']);
});

test('G: managerPhones_ falls back per key, and to the constants', () => {
  const w = loadCode({ noGetProperties: true, props: { ['MANAGER_PHONE_' + 'אורן']: '972500000002' } });
  const phones = w.g.managerPhones();
  assert.equal(w.count('getProperty'), Object.keys(w.g.MANAGER_PHONES).length);
  assert.equal(phones['אורן'], '972500000002');
  const w2 = loadCode({ propsThrow: true });
  assert.deepEqual(JSON.parse(JSON.stringify(w2.g.managerPhones())), JSON.parse(JSON.stringify(w2.g.MANAGER_PHONES)));
});

test("G: asISOTime_ looks the timezone up only when it needs it", () => {
  const w = loadCode();
  assert.equal(w.g.asISOTime('08:18'), '08:18');
  assert.equal(w.g.asISOTime('08:18:00'), '08:18');
  assert.equal(w.g.asISOTime(''), '');
  assert.equal(w.g.asISOTime('not a time'), '');
  assert.equal(w.count('tz'), 0);
  assert.equal(w.g.asISOTime(new Date(Date.UTC(1899, 11, 30, 8, 18))), '08:18');
  assert.equal(w.count('tz'), 1);
});

test('G: fastHash_ is deterministic and spreads', () => {
  const w = loadCode();
  assert.equal(w.g.fastHash('abc'), w.g.fastHash('abc'));
  assert.notEqual(w.g.fastHash('abc'), w.g.fastHash('abd'));
  const seen = new Set();
  for (let i = 0; i < 2000; i++) seen.add(w.g.fastHash(patientKey(i) + i));
  assert.equal(seen.size, 2000);
});

test('G: one [perf] line per request — milliseconds and counts, never a name', () => {
  const w = world({ digest: true });
  w.g.handle({ action: 'getData' });
  w.g.handle({ action: 'getPayments' });
  w.g.handle({ action: 'getCredits' });
  saveAll(w, clientSnapshot(w));
  const perf = w.logs.filter((l) => l.indexOf('[perf] ') === 0);
  const labels = perf.map((l) => l.split(' ')[1]);
  ['getData_', 'getPayments_', 'getCredits_', 'saveAll'].forEach((l) => assert.ok(labels.includes(l), l + ' logged'));
  assert.match(perf.find((l) => l.startsWith('[perf] getData_')),
    /^\[perf\] getData_ \d+ms \| open=\d+ read=\d+ backfill=\d+ shape=\d+ phones=\d+ \| leads=12 patients=12$/);
  perf.forEach((l) => {
    assert.match(l, /^\[perf\] \w+ \d+ms( \| [a-z]+=\d+( [a-z]+=\d+)*)*$/, l);
    assert.ok(!HEBREW.test(l), 'no names in the log: ' + l);
  });
});

test('G: a logging failure never breaks a request', () => {
  const w = world();
  w.sandbox.Logger = { log() { throw new Error('logger down'); } };
  assert.equal(w.g.handle({ action: 'getData' }).ok, true);
});

/* ===================================================================== */
/* H. app.js loadAll                                                      */
/* ===================================================================== */

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const tick = async (n = 6) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

function loadApp() {
  const logs = [];
  const banner = { classList: new Set(['hidden']), textContent: '' };
  banner.classList.toggle = (c, on) => { (on ? banner.classList.add(c) : banner.classList.delete(c)); };
  banner.classList.contains = (c) => banner.classList.has(c);
  banner.classList.remove = (c) => banner.classList.delete(c);
  const doc = {
    addEventListener: noop,
    querySelectorAll: () => [],
    getElementById: (id) => (id === 'loading-banner' ? banner : null),
  };
  const sandbox = {
    console: { log: (...a) => logs.push(a.map(String).join(' ')), warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/', reload: noop },
    setTimeout: () => 0, clearTimeout: noop,
    document: doc,
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    URLSearchParams, Math, Date, JSON, Number, String, Array, Object, RegExp,
    Promise, Set, Map, Error, isFinite, parseFloat, parseInt,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(APP_SRC + `
    globalThis.__t = {
      loadAll: () => loadAll(),
      setApiGet(fn) { apiGet = fn; },
      setRenderAll(fn) { renderAll = fn; },
      setShowError(fn) { showError = fn; },
      setSaveAll(fn) { saveAll = fn; },
      setNormalizePayment(fn) { normalizePayment = fn; },
      setState(s) { Object.assign(state, s); },
      getState() { return state; },
    };`, sandbox);
  const t = sandbox.__t;
  const errors = [];
  let renders = 0;
  t.setRenderAll(() => { renders++; });
  t.setShowError((m) => errors.push(m));
  t.setSaveAll(() => Promise.resolve());
  t.setState({ mode: 'view' });
  return { t, logs, errors, banner, renders: () => renders };
}

const DATA = { ok: true, leads: [{ id: 'l1', name: 'ליד', stage: 'new' }], patients: {}, irrelevantLeads: [], removedLeads: [], dischargedPatients: [], billingOverrides: [] };
const PAYMENT = { id: 'pay::ramot::x::2026-01-01::2026-02-01', patientId: 'ramot::x::2026-01-01', amount: 9000, status: 'paid' };
const CREDIT = { id: 'credit::ramot::x::2026-01-01::2026-02::1', amount: 100, status: 'pending' };

test('H: loadAll starts getData, getPayments and getCredits TOGETHER', async () => {
  const h = loadApp();
  const pending = {};
  const order = [];
  h.t.setApiGet((p) => { order.push(p.action); pending[p.action] = deferred(); return pending[p.action].promise; });
  const run = h.t.loadAll();
  await tick();
  assert.deepEqual(order, ['getData', 'getPayments', 'getCredits'],
    'all three requests are in flight before ANY has answered');
  // Answer in the "wrong" order: payments and credits before data.
  pending.getCredits.resolve({ ok: true, credits: [CREDIT] });
  pending.getPayments.resolve({ ok: true, payments: [PAYMENT] });
  await tick();
  assert.equal(h.renders(), 0, 'nothing renders before getData answers');
  pending.getData.resolve(DATA);
  await run;
  const s = h.t.getState();
  assert.equal(s.leads.length, 1);
  assert.equal(s.payments.length, 1);
  assert.equal(s.credits.length, 1);
  assert.equal(h.renders(), 1);
  assert.deepEqual(h.errors, []);
});

test('H: a getPayments / getCredits failure does not fail the load; each says so in Hebrew', async () => {
  const h = loadApp();
  h.t.setApiGet((p) => (p.action === 'getData' ? Promise.resolve(DATA)
    : Promise.reject(new Error('Unknown action ' + p.action))));
  await h.t.loadAll();
  const s = h.t.getState();
  assert.deepEqual(Array.from(s.payments), []);
  assert.deepEqual(Array.from(s.credits), []);
  assert.equal(h.renders(), 1, 'the app still renders');
  // CHANGELOG-payment-report-persistence.md / CHANGELOG-write-path-hardening.md:
  // neither failure is silent — the money and the credits on screen may be
  // stale, and the user is told (R2).
  assert.equal(h.errors.length, 2);
  assert.match(h.errors[0], /^טעינת התשלומים נכשלה/);
  assert.match(h.errors[1], /^טעינת הזיכויים נכשלה/);
});

test('H: a payments row that breaks normalization does not fail the load (reported in Hebrew)', async () => {
  const h = loadApp();
  h.t.setNormalizePayment(() => { throw new TypeError('bad row'); });
  h.t.setApiGet((p) => Promise.resolve(p.action === 'getData' ? DATA
    : p.action === 'getPayments' ? { ok: true, payments: [PAYMENT] } : { ok: true, credits: [CREDIT] }));
  await h.t.loadAll();
  const s = h.t.getState();
  assert.deepEqual(Array.from(s.payments), []);
  assert.equal(s.credits.length, 1);
  assert.equal(h.renders(), 1);
  assert.equal(h.errors.length, 1, 'the bad payments answer is reported, not swallowed');
  assert.match(h.errors[0], /^טעינת התשלומים נכשלה/);
});

test('H: a getData failure still fails the load in Hebrew — and leaks no unhandled rejection', async () => {
  const h = loadApp();
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    h.t.setApiGet(() => Promise.reject(new Error('offline')));
    await h.t.loadAll();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }
  assert.deepEqual(h.errors, ['טעינת נתונים מהגיליון נכשלה — offline']);
  assert.equal(h.renders(), 0);
  assert.ok(h.banner.classList.contains('hidden'), 'the loading banner comes down');
  assert.deepEqual(unhandled, [], 'the two unawaited reads never become unhandled rejections');
});

test('H: a restricted session (no finance) never asks for getPayments / getCredits', async () => {
  const h = loadApp();
  h.t.setState({ finance: false });
  const asked = [];
  h.t.setApiGet((p) => { asked.push(p.action); return Promise.resolve(DATA); });
  await h.t.loadAll();
  assert.deepEqual(asked, ['getData']);
  const s = h.t.getState();
  assert.deepEqual(Array.from(s.payments), []);
  assert.deepEqual(Array.from(s.credits), []);
  assert.deepEqual(Array.from(s.receipts), []);
  assert.deepEqual(Array.from(s.funders), []);
  assert.equal(h.renders(), 1);
});

test('H: finance lost while getData was in flight → the money reads are dropped, as before', async () => {
  const h = loadApp();
  const pending = {};
  h.t.setApiGet((p) => { pending[p.action] = deferred(); return pending[p.action].promise; });
  const run = h.t.loadAll();
  await tick();
  pending.getPayments.resolve({ ok: true, payments: [PAYMENT] });
  pending.getCredits.resolve({ ok: true, credits: [CREDIT] });
  h.t.setState({ finance: false });   // /api/me answered: no finance
  pending.getData.resolve(DATA);
  await run;
  const s = h.t.getState();
  assert.deepEqual(Array.from(s.payments), []);
  assert.deepEqual(Array.from(s.credits), []);
});

test('H: loadAll logs ONE console timing line', async () => {
  const h = loadApp();
  h.t.setApiGet((p) => Promise.resolve(p.action === 'getData' ? DATA : { ok: true, payments: [], credits: [] }));
  await h.t.loadAll();
  const lines = h.logs.filter((l) => l.indexOf('[E-ZONE][perf] loadAll') === 0);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[E-ZONE\]\[perf\] loadAll \d+ms \| getData=\d+ getPayments=\d+ getCredits=\d+ fetched=\d+$/);
});

test('H: a failed load still logs its timing line (what finished before the failure)', async () => {
  const h = loadApp();
  h.t.setApiGet(() => Promise.reject(new Error('offline')));
  await h.t.loadAll();
  const lines = h.logs.filter((l) => l.indexOf('[E-ZONE][perf] loadAll') === 0);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[E-ZONE\]\[perf\] loadAll \d+ms \| getData=\d+$/);
});

/* ===================================================================== */
/* Service worker                                                         */
/* ===================================================================== */

test('the public/ change ships as CACHE_VERSION v39 or later — never the burned v17', () => {
  // Built as v18 (#149); rebased onto the deployed v38, so the next free is v39.
  const v = /var CACHE_VERSION = '(v\d+)';/.exec(SW_SRC)[1];
  assert.ok(Number(v.slice(1)) >= 39, v);
  assert.notEqual(v, 'v17', 'v17 was PR #145 (reverted) and is still cached on phones');
});
