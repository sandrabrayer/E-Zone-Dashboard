/* Tests for the write & handoff diagnostics (PR D).
 *
 *   server.js — writeLog ring buffer (recordWrite, WRITE_LOG_MAX cap),
 *               authFailures 401 counter (noteAuthFailure + requireSession
 *               wiring), redactSecrets / responsePreview redaction, and
 *               compareSaveAllCounts (sent vs acknowledged per-house counts).
 *   Code.gs   — saveAll_ echoes per-house `written` counts;
 *               replaceHousePatients_ returns the rows written.
 *
 * server.js only calls app.listen when run as the main module, so requiring it
 * here exercises the exported helpers directly (same approach as
 * api-auth.test.js). SESSION_SECRET must be set before the require. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SECRET = 'diagnostics-test-session-secret-0123456789abcdef';
process.env.SESSION_SECRET = SECRET; // before server.js is required

const server = require('../server');

/* ===== redactSecrets ===== */

test('redactSecrets replaces every occurrence of each secret', () => {
  const out = server.redactSecrets('token=s3cr3t and again s3cr3t end', ['s3cr3t']);
  assert.strictEqual(out, 'token=[REDACTED] and again [REDACTED] end');
});

test('redactSecrets ignores empty/undefined secrets and non-string input', () => {
  assert.strictEqual(server.redactSecrets('abc', ['', null, undefined]), 'abc');
  assert.strictEqual(server.redactSecrets(null, ['x']), '');
});

test('responsePreview truncates and redacts the configured secrets', () => {
  // SESSION_SECRET is in the debug secret list — it must never survive into a
  // stored preview, even when the far side echoes it back.
  const echoed = { ok: false, debug: 'leaked ' + SECRET };
  const preview = server.responsePreview(echoed, 2000);
  assert.ok(!preview.includes(SECRET), 'secret must not appear in the stored preview');
  assert.ok(preview.includes('[REDACTED]'));
  // truncation
  const long = server.responsePreview({ blob: 'x'.repeat(5000) }, 100);
  assert.strictEqual(long.length, 100);
});

/* ===== writeLog ring buffer ===== */

test('recordWrite keeps newest first and caps the buffer at WRITE_LOG_MAX', () => {
  server.writeLog.length = 0; // isolate
  for (let i = 1; i <= server.WRITE_LOG_MAX + 5; i++) {
    server.recordWrite({ at: `t${i}`, action: 'saveAll', httpStatus: 200 });
  }
  assert.strictEqual(server.writeLog.length, server.WRITE_LOG_MAX, 'capped');
  assert.strictEqual(server.writeLog[0].at, `t${server.WRITE_LOG_MAX + 5}`, 'newest first');
  assert.strictEqual(server.WRITE_LOG_MAX, 20);
});

test('recordWrite captures an outpatient response body entry', () => {
  server.writeLog.length = 0;
  server.recordWrite({
    at: 'now',
    route: '/api/outpatient-lead',
    action: 'createOutpatientLead',
    httpStatus: 200,
    okFromBackend: false,
    outpatientResponse: '{"ok":false,"error":"unauthorized"}',
  });
  const rec = server.writeLog[0];
  assert.strictEqual(rec.route, '/api/outpatient-lead');
  assert.ok(rec.outpatientResponse.includes('"unauthorized"'),
    'the far-side body is preserved verbatim for diagnosis');
});

/* ===== authFailures — a 401’d write leaves a trace ===== */

test('requireSession 401 is captured in authFailures (path + timestamps + total)', () => {
  // reset the shared state we assert on
  server.authFailures.total = 0;
  server.authFailures.lastAt = null;
  server.authFailures.recent.length = 0;
  for (const k of Object.keys(server.authFailures.byPath)) delete server.authFailures.byPath[k];

  const res = {
    statusCode: null, body: null,
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
  };
  let nextCalled = false;
  // no cookie → 401
  server.requireSession(
    { headers: {}, originalUrl: '/api/sheets' },
    res,
    () => { nextCalled = true; }
  );
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(nextCalled, false);
  assert.strictEqual(server.authFailures.total, 1);
  assert.strictEqual(server.authFailures.byPath['/api/sheets'], 1);
  assert.strictEqual(server.authFailures.recent.length, 1);
  assert.strictEqual(server.authFailures.recent[0].path, '/api/sheets');
  assert.ok(server.authFailures.lastAt, 'timestamp recorded');
});

test('authFailures.recent is capped like the write log', () => {
  server.authFailures.recent.length = 0;
  for (let i = 0; i < server.WRITE_LOG_MAX + 7; i++) {
    server.noteAuthFailure('/api/sheets');
  }
  assert.strictEqual(server.authFailures.recent.length, server.WRITE_LOG_MAX);
});

/* ===== compareSaveAllCounts (symptom-1 detector) ===== */

test('compareSaveAllCounts: matching per-house counts → match true', () => {
  const r = server.compareSaveAllCounts({ arfoni: 3, ramot: 5 }, { arfoni: 3, ramot: 5 });
  assert.strictEqual(r.match, true);
  assert.strictEqual(r.mismatches, null);
});

test('compareSaveAllCounts: a dropped house shows up as a mismatch', () => {
  const r = server.compareSaveAllCounts({ arfoni: 3, ramot: 5 }, { arfoni: 3, ramot: 0 });
  assert.strictEqual(r.match, false);
  assert.deepStrictEqual(r.mismatches, { ramot: { sent: 5, acknowledged: 0 } });
});

test('compareSaveAllCounts: house present only on one side is a mismatch', () => {
  const r = server.compareSaveAllCounts({ arfoni: 2 }, { arfoni: 2, sde: 1 });
  assert.strictEqual(r.match, false);
  assert.deepStrictEqual(r.mismatches, { sde: { sent: 0, acknowledged: 1 } });
});

test('compareSaveAllCounts: no acknowledged counts (older backend) → null verdict', () => {
  assert.strictEqual(server.compareSaveAllCounts({ arfoni: 2 }, undefined).match, null);
  assert.strictEqual(server.compareSaveAllCounts({ arfoni: 2 }, null).match, null);
  assert.strictEqual(server.compareSaveAllCounts({ arfoni: 2 }, [1, 2]).match, null);
});

/* ===== Code.gs — saveAll_ echoes per-house written counts ===== */

function fakeSheet(headerRow, dataRows) {
  const grid = [headerRow.slice()].concat((dataRows || []).map((r) => r.slice()));
  return {
    grid,
    getLastRow() { return grid.length; },
    getLastColumn() { return grid[0] ? grid[0].length : 0; },
    getMaxRows() { return Math.max(grid.length, 1000); },
    setFrozenRows() {},
    appendRow(row) { grid.push(row.slice()); },
    getRange(r, c, nr, nc) {
      nr = nr || 1; nc = nc || 1;
      return {
        setNumberFormat() {},
        setValue(v) { if (!grid[r - 1]) grid[r - 1] = []; grid[r - 1][c - 1] = v; },
        clearContent() {
          for (let i = 0; i < nr; i++) {
            for (let j = 0; j < nc; j++) { if (grid[r - 1 + i]) grid[r - 1 + i][c - 1 + j] = ''; }
          }
        },
        getValues() {
          const out = [];
          for (let i = 0; i < nr; i++) {
            const row = [];
            for (let j = 0; j < nc; j++) { const g = grid[r - 1 + i]; row.push(g ? g[c - 1 + j] : ''); }
            out.push(row);
          }
          return out;
        },
        setValues(vals) {
          for (let i = 0; i < vals.length; i++) {
            if (!grid[r - 1 + i]) grid[r - 1 + i] = [];
            for (let j = 0; j < vals[i].length; j++) grid[r - 1 + i][c - 1 + j] = vals[i][j];
          }
        },
      };
    },
  };
}

function loadCode() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
  const noop = () => {};
  const registry = {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    JSON, Math, Date, Number, String, Array, Object, RegExp, isFinite,
    Logger: { log: noop },
    Utilities: { formatDate: () => '2026-08-09', getUuid: () => 'u1' },
    LockService: { getScriptLock: () => ({ tryLock: noop, releaseLock: noop }) },
  };
  sandbox.SpreadsheetApp = {
    getActiveSpreadsheet: () => ({
      getSheetByName: (name) => registry[name] || null,
      insertSheet: (name) => (registry[name] = fakeSheet([], [])),
      getSpreadsheetTimeZone: () => 'Asia/Jerusalem',
    }),
  };
  sandbox.globalThis = sandbox;
  const epilogue = `globalThis.__test = {
    PATIENT_COLUMNS: PATIENT_COLUMNS,
    PATIENTS_SHEET: PATIENTS_SHEET,
    saveAll: (l, p) => saveAll_(l, p),
    replaceHouse: (h, a) => replaceHousePatients_(h, a),
  };`;
  vm.createContext(sandbox);
  vm.runInContext(src + epilogue, sandbox);
  return { code: sandbox.__test, registry };
}

test('saveAll_ echoes per-house written counts; replaceHousePatients_ returns rows written', () => {
  const { code, registry } = loadCode();
  const PC = Array.from(code.PATIENT_COLUMNS);
  registry[code.PATIENTS_SHEET] = fakeSheet(PC, []);

  const res = code.saveAll(null, {
    arfoni: [{ houseId: 'arfoni', name: 'א', date: '2026-01-01', pay: 100 },
             { houseId: 'arfoni', name: 'ב', date: '2026-01-02', pay: 200 }],
    ramot:  [{ houseId: 'ramot', name: 'ג', date: '2026-01-03', pay: 300 }],
    sde:    [],
  });
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual({ ...res.written }, { arfoni: 2, ramot: 1, sde: 0 });

  // direct return value
  assert.strictEqual(code.replaceHouse('ramot', [{ houseId: 'ramot', name: 'ד', date: '', pay: 0 }]), 1);
  assert.strictEqual(code.replaceHouse('ramot', []), 0);
});
