'use strict';

/* Managers expected-discharge SAVE fix (CHANGELOG-managers-discharge-save-fix.md):
 *   - the managers writes (dischargeSet / logAdd / logUpdate) take the script
 *     lock with a BOUNDED tryLock and answer {ok:false,error:'lock_busy'} (JSON)
 *     instead of waitLock(10000), which threw and could outlast the Managers
 *     proxy's 15 s timeout («upstream_error»);
 *   - the editor-run authorizeSheetsWriteNow(): requireAllScopes FIRST and
 *     uncaught, then a real write-and-delete on a temporary sheet, then the
 *     ManagersExpectedDischarge sheet ready with its append-only header.
 * Real apps-script/Code.gs in the shared vm sandbox. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { richSheet, loadGs } = require('./helpers/gs-sandbox');

const SECRET = 'mw-secret-save-fix';
const arr = (x) => JSON.parse(JSON.stringify(x));
const SRC = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');

function boot({ lockFree = true } = {}) {
  const g = loadGs({ props: { MANAGERS_WORK_SECRET: SECRET } });
  g.sandbox.Session = { getScriptTimeZone: () => 'Asia/Jerusalem' };
  g.sandbox.Utilities.formatDate = (d, tz, fmt) => {
    const x = new Date(d); const p = (n) => (n < 10 ? '0' + n : '' + n);
    if (fmt === 'HH:mm') return `${p(x.getHours())}:${p(x.getMinutes())}`;
    if (fmt === 'yyyy-MM') return `${x.getFullYear()}-${p(x.getMonth() + 1)}`;
    return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
  };
  g.run("todayISODate_ = function () { return '2026-10-15'; }");
  const cols = Array.from(g.run('PATIENT_COLUMNS'));
  const sh = richSheet('Patients', cols);
  sh.grid.push(cols.map((c) => ({ houseId: 'ramot', name: 'דנה לוי', date: '2026-09-01', status: 'active', id: 'p1' })[c] ?? ''));
  g.sandbox.__sheets.Patients = sh;
  const lock = { waits: [], waitLockCalls: 0, held: 0, free: lockFree };
  g.sandbox.LockService = { getScriptLock: () => ({
    tryLock: (ms) => { lock.waits.push(ms); if (lock.free) lock.held++; return lock.free; },
    waitLock: () => { lock.waitLockCalls++; throw new Error('Lock timeout: another process was holding the lock for too long.'); },
    releaseLock: () => { lock.held--; },
  }) };
  const call = (body) => arr(g.post({ action: 'managersWork', secret: SECRET, ...body }));
  return { g, call, lock };
}
const ORAN = { house: 'ramot', role: 'manager', actor: 'אורן', actorId: 'person-oran' };
const SET = { op: 'dischargeSet', ...ORAN, patientName: 'דנה לוי', entryDate: '2026-09-01', expectedDate: '2026-11-01', previousDate: '' };

test('lock busy → dischargeSet answers lock_busy as JSON (no throw, nothing written), with a bounded 5 s wait', () => {
  const { g, call, lock } = boot({ lockFree: false });
  const r = call(SET);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'lock_busy');
  assert.deepStrictEqual(lock.waits, [5000]);
  assert.strictEqual(lock.waitLockCalls, 0, 'never waitLock (it throws)');
  const d = g.sandbox.__sheets.ManagersExpectedDischarge;
  assert.ok(!d || d.getLastRow() <= 1, 'nothing appended');
});

test('lock busy → logAdd and logUpdate answer lock_busy too', () => {
  const { call } = boot({ lockFree: false });
  assert.strictEqual(call({ op: 'logAdd', ...ORAN, log: 'events', entry: JSON.stringify({ eventDate: '2026-10-15', whatHappened: 'x' }) }).error, 'lock_busy');
  assert.strictEqual(call({ op: 'logUpdate', ...ORAN, log: 'events', id: 'abc', patch: JSON.stringify({ followUpDone: true }) }).error, 'lock_busy');
});

test('lock free → the save lands once and the lock is released (no leak)', () => {
  const { g, call, lock } = boot();
  const r = call(SET);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.expectedDischarge.date, '2026-11-01');
  assert.strictEqual(lock.held, 0, 'released');
  assert.strictEqual(g.sandbox.__sheets.ManagersExpectedDischarge.getLastRow(), 2);
  // A refusal inside the lock (stale previousDate) also releases it.
  assert.strictEqual(call({ ...SET, expectedDate: '2026-11-05', previousDate: '2026-10-30' }).error, 'conflict');
  assert.strictEqual(lock.held, 0);
});

test('no managers write uses waitLock any more (it throws and could outlast the proxy timeout)', () => {
  for (const fn of ['function mwDischargeSet_', 'function mwLogAdd_', 'function mwLogUpdate_']) {
    const start = SRC.indexOf(fn);
    const body = SRC.slice(start, SRC.indexOf('\n}\n', start));
    assert.ok(start > 0, fn);
    assert.doesNotMatch(body, /waitLock\(/, fn);
    assert.match(body, /tryLock\(5000\) !== true\) return lockBusy_\(/, fn);
  }
});

function bootAuthz({ grant = true, readBack = true } = {}) {
  const g = loadGs({ props: {} });
  const order = [];
  const deleted = [];
  g.sandbox.ScriptApp = { AuthMode: { FULL: 'FULL' }, requireAllScopes: (mode) => {
    order.push('requireAllScopes:' + mode);
    if (!grant) throw new Error('Authorization is required to perform that action.');
  } };
  const realGet = g.sandbox.SpreadsheetApp.getActiveSpreadsheet;
  g.sandbox.SpreadsheetApp = {
    flush: () => order.push('flush'),
    getActiveSpreadsheet: () => {
      const ss = realGet();
      return Object.assign({}, ss, {
        insertSheet: (n) => { order.push('insert:' + n.replace(/^(_authz_write_test_).+$/, '$1X')); const sh = ss.insertSheet(n);
          if (!readBack) { const gr = sh.getRange; sh.getRange = (...a) => Object.assign(gr(...a), { getValue: () => '' }); }
          return sh; },
        deleteSheet: (sh) => { order.push('delete'); deleted.push(sh.getName()); delete g.sandbox.__sheets[sh.getName()]; },
      });
    },
  };
  return { g, order, deleted };
}

test('authorizeSheetsWriteNow: requireAllScopes(FULL) runs FIRST, then a real write/read/delete on a temp sheet, then the discharge sheet is ready', () => {
  const { g, order, deleted } = bootAuthz();
  const r = arr(g.run('authorizeSheetsWriteNow()'));
  assert.deepStrictEqual(r, { ok: true });
  assert.strictEqual(order[0], 'requireAllScopes:FULL');
  assert.deepStrictEqual(order.slice(1, 4), ['insert:_authz_write_test_X', 'flush', 'delete']);
  assert.strictEqual(deleted.length, 1);
  assert.ok(!Object.keys(g.sandbox.__sheets).some((n) => n.indexOf('_authz_write_test_') === 0), 'the temp sheet is gone');
  const sh = g.sandbox.__sheets.ManagersExpectedDischarge;
  assert.deepStrictEqual(sh.grid[0], Array.from(g.run('MW_DISCHARGE_COLUMNS')), 'append-only header');
  assert.strictEqual(sh.getLastRow(), 1, 'header only — no data written');
  assert.ok(g.logs.some((l) => /authorizeSheetsWriteNow: OK/.test(l)));
});

test('authorizeSheetsWriteNow: a partial grant fails loudly at the first statement — nothing else runs', () => {
  const { g, order } = bootAuthz({ grant: false });
  assert.throws(() => g.run('authorizeSheetsWriteNow()'), /Authorization is required/);
  assert.deepStrictEqual(order, ['requireAllScopes:FULL']);
  assert.ok(!g.sandbox.__sheets.ManagersExpectedDischarge);
});

test('authorizeSheetsWriteNow: a write that does not read back throws — and the temp sheet is still deleted', () => {
  const { g, deleted } = bootAuthz({ readBack: false });
  assert.throws(() => g.run('authorizeSheetsWriteNow()'), /did not read back/);
  assert.strictEqual(deleted.length, 1);
});

test('authorizeSheetsWriteNow: an existing sheet with the right header is kept as is (rows untouched)', () => {
  const { g } = bootAuthz();
  const cols = Array.from(g.run('MW_DISCHARGE_COLUMNS'));
  const sh = richSheet('ManagersExpectedDischarge', cols);
  sh.grid.push(cols.map(() => 'v'));
  g.sandbox.__sheets.ManagersExpectedDischarge = sh;
  assert.strictEqual(arr(g.run('authorizeSheetsWriteNow()')).ok, true);
  assert.strictEqual(sh.getLastRow(), 2);
  assert.deepStrictEqual(sh.grid[1], cols.map(() => 'v'));
});

test('authorizeSheetsWriteNow: source — uncaught first statement, editor-run only (no HTTP action reaches it), logs no data', () => {
  const start = SRC.indexOf('function authorizeSheetsWriteNow() {');
  const body = SRC.slice(start, SRC.indexOf('\n}\n', start));
  assert.match(body, /^function authorizeSheetsWriteNow\(\) \{\n  ScriptApp\.requireAllScopes\(ScriptApp\.AuthMode\.FULL\);/);
  assert.doesNotMatch(body, /try \{\s*ScriptApp/);
  const g = loadGs({ props: {} });
  assert.ok(Array.from(g.run('PROXY_KNOWN_ACTIONS')).indexOf('authorizeSheetsWriteNow') < 0);
  assert.ok(Array.from(g.run('OPEN_ACTIONS')).indexOf('authorizeSheetsWriteNow') < 0);
  assert.doesNotMatch(SRC.replace(body, ''), /authorizeSheetsWriteNow\(\)/, 'nothing calls it');
  assert.doesNotMatch(body, /patientName|getValues\(\)\.map\(function \(r\)/);
});
