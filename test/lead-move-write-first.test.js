/* A lead is never lost between two sheets (CHANGELOG-lead-move-write-first.md).
 *
 * moveLeadIrrelevant_ (closure → שימור לידים) and restoreLead_ used to DELETE
 * the row from its sheet first and write it to the other one second: a failed
 * second step lost the lead. Every move now goes through moveRowWriteFirst_:
 * write the destination row (upsert by id), verify it landed, only then delete
 * the source row — under the script lock. These tests simulate a failure
 * between the two steps on every move path. The REAL Code.gs in a vm with an
 * in-memory spreadsheet; all names are SYNTHETIC. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGs, GS_SRC } = require('./helpers/gs-sandbox');

const plain = (v) => JSON.parse(JSON.stringify(v));
const LEAD = { id: 'L-1', name: 'נועה ברק', phone: '0501234567', house: 'רמות השבים', stage: 'new', created: '2026-10-01' };

function world() {
  const g = loadGs();
  const s = g.sandbox;
  // Code.gs's top-level consts live in the vm context, not on the sandbox.
  const K = {};
  ['LEADS_SHEET', 'LEAD_COLUMNS', 'IRRELEVANT_LEADS_SHEET', 'IRRELEVANT_LEAD_COLUMNS', 'REMOVED_LEADS_SHEET', 'REMOVED_LEAD_COLUMNS', 'AUDIT_LOG_SHEET']
    .forEach((k) => { K[k] = g.run(k); });
  s.getOrCreateSheet_(K.IRRELEVANT_LEADS_SHEET, K.IRRELEVANT_LEAD_COLUMNS);
  s.getOrCreateSheet_(K.REMOVED_LEADS_SHEET, K.REMOVED_LEAD_COLUMNS);
  s.upsertRowById_(s.getOrCreateSheet_(K.LEADS_SHEET, K.LEAD_COLUMNS), K.LEAD_COLUMNS, LEAD);
  const ids = (name, cols) => g.sheetRows(name, cols).map((r) => String(r.id));
  return {
    g, s, K,
    leads: () => ids(K.LEADS_SHEET, 'LEAD_COLUMNS'),
    irr: () => ids(K.IRRELEVANT_LEADS_SHEET, 'IRRELEVANT_LEAD_COLUMNS'),
    removed: () => ids(K.REMOVED_LEADS_SHEET, 'REMOVED_LEAD_COLUMNS'),
    audit: () => g.sheetRows(K.AUDIT_LOG_SHEET, 'AUDIT_LOG_COLUMNS').map((r) => r.action),
  };
}
const close = (w) => plain(w.s.moveLeadIrrelevant_(Object.assign({}, LEAD, { disposition: 'not_relevant', not_relevant_note: 'לא מעוניין' }), 'ורד'));

/* Make writes to ONE sheet fail: mode 'throw' (the write throws) or 'silent'
 * (the write returns but nothing lands). Returns a restore function. */
function failWritesTo(w, sheetName, mode) {
  const real = w.s.upsertRowById_;
  w.s.upsertRowById_ = function (sh, cols, obj) {
    if (sh.getName() === sheetName) {
      if (mode === 'throw') throw new Error('Service Spreadsheets timed out');
      return undefined;
    }
    return real(sh, cols, obj);
  };
  return () => { w.s.upsertRowById_ = real; };
}
/* Make the DELETE from one sheet throw once (a failure after the write landed). */
function failDeleteOnceFrom(w, sheetName) {
  const real = w.s.deleteRowsById_;
  let armed = true;
  w.s.deleteRowsById_ = function (sh, cols, id) {
    if (armed && sh.getName() === sheetName) { armed = false; throw new Error('Service Spreadsheets timed out'); }
    return real(sh, cols, id);
  };
}

/* ---------- closure: moveLeadIrrelevant_ ---------- */

test('closure: the closed row is written and verified BEFORE the Leads row is deleted', () => {
  const w = world();
  const order = [];
  const up = w.s.upsertRowById_, del = w.s.deleteRowsById_, count = w.s.countRowsById_;
  w.s.upsertRowById_ = (sh, c, o) => { order.push('write:' + sh.getName()); return up(sh, c, o); };
  w.s.countRowsById_ = (sh, c, id) => { order.push('verify:' + sh.getName()); return count(sh, c, id); };
  w.s.deleteRowsById_ = (sh, c, id) => { order.push('delete:' + sh.getName()); return del(sh, c, id); };
  const res = close(w);
  assert.equal(res.ok, true);
  assert.deepEqual(order, ['write:' + w.K.IRRELEVANT_LEADS_SHEET, 'verify:' + w.K.IRRELEVANT_LEADS_SHEET, 'delete:' + w.K.LEADS_SHEET]);
  assert.deepEqual(w.leads(), []);
  assert.deepEqual(w.irr(), ['L-1']);
});

test('closure: a destination write that THROWS never deletes the lead; explicit error, logged', () => {
  const w = world();
  failWritesTo(w, w.K.IRRELEVANT_LEADS_SHEET, 'throw');
  const res = close(w);
  assert.deepEqual(res, { ok: false, error: 'move_write_failed' });
  assert.deepEqual(w.leads(), ['L-1'], 'the lead is still on Leads');
  assert.deepEqual(w.irr(), []);
  assert.ok(w.audit().includes('lead_move_failed'));
  assert.ok(!w.audit().includes('lead_moved_irrelevant'));
});

test('closure: a destination write that silently does NOT land is caught by the read-back', () => {
  const w = world();
  failWritesTo(w, w.K.IRRELEVANT_LEADS_SHEET, 'silent');
  assert.deepEqual(close(w), { ok: false, error: 'move_write_failed' });
  assert.deepEqual(w.leads(), ['L-1']);
  assert.deepEqual(w.irr(), []);
});

test('closure: a failure AFTER the write leaves the lead on both sheets (never neither); the retry finishes with no duplicate', () => {
  const w = world();
  failDeleteOnceFrom(w, w.K.LEADS_SHEET);
  assert.throws(() => close(w), /timed out/);
  assert.deepEqual(w.leads(), ['L-1'], 'not lost');
  assert.deepEqual(w.irr(), ['L-1']);
  const retry = close(w);
  assert.equal(retry.ok, true);
  assert.deepEqual(w.leads(), []);
  assert.deepEqual(w.irr(), ['L-1'], 'one closed row — idempotent by lead id');
});

test('closure: a retry after a landed move (lost answer) is idempotent', () => {
  const w = world();
  assert.equal(close(w).ok, true);
  const again = close(w);
  assert.equal(again.ok, true);
  assert.deepEqual(w.irr(), ['L-1']);
  assert.deepEqual(w.leads(), []);
});

test('closure: a lock that cannot be taken writes nothing', () => {
  const w = world();
  w.s.LockService = { getScriptLock: () => ({ tryLock: () => false, releaseLock() {} }) };
  const res = close(w);
  assert.equal(res.ok, false);
  assert.deepEqual(w.leads(), ['L-1']);
  assert.deepEqual(w.irr(), []);
});

/* ---------- restore: restoreLead_ ---------- */

function closedWorld() {
  const w = world();
  assert.equal(close(w).ok, true);
  return w;
}
const restore = (w) => plain(w.s.restoreLead_(Object.assign({}, LEAD, { stage: 'new' }), 'ורד'));

test('restore: the Leads row is written and verified BEFORE the closed row is deleted', () => {
  const w = closedWorld();
  const order = [];
  const up = w.s.upsertRowById_, del = w.s.deleteRowsById_;
  w.s.upsertRowById_ = (sh, c, o) => { order.push('write:' + sh.getName()); return up(sh, c, o); };
  w.s.deleteRowsById_ = (sh, c, id) => { order.push('delete:' + sh.getName()); return del(sh, c, id); };
  assert.equal(restore(w).ok, true);
  assert.deepEqual(order, ['write:' + w.K.LEADS_SHEET, 'delete:' + w.K.IRRELEVANT_LEADS_SHEET]);
  assert.deepEqual(w.leads(), ['L-1']);
  assert.deepEqual(w.irr(), []);
});

test('restore: a failed Leads write (throw or silent) keeps the closed row', () => {
  for (const mode of ['throw', 'silent']) {
    const w = closedWorld();
    failWritesTo(w, w.K.LEADS_SHEET, mode);
    assert.deepEqual(restore(w), { ok: false, error: 'move_write_failed' }, mode);
    assert.deepEqual(w.irr(), ['L-1'], mode + ': not lost');
    assert.deepEqual(w.leads(), [], mode);
  }
});

test('restore: a failure between the steps, then a retry — one Leads row, no closed row', () => {
  const w = closedWorld();
  failDeleteOnceFrom(w, w.K.IRRELEVANT_LEADS_SHEET);
  assert.throws(() => restore(w), /timed out/);
  assert.deepEqual(w.leads(), ['L-1']);
  assert.deepEqual(w.irr(), ['L-1']);
  assert.equal(restore(w).ok, true);
  assert.deepEqual(w.leads(), ['L-1'], 'no duplicate Leads row');
  assert.deepEqual(w.irr(), []);
});

/* ---------- soft delete: removeLead_ ---------- */

const remove = (w) => plain(w.s.removeLead_(Object.assign({}, LEAD), 'ורד'));

test('remove: a failed write to «לידים שהוסרו» (throw or silent) never deletes from Leads', () => {
  for (const mode of ['throw', 'silent']) {
    const w = world();
    failWritesTo(w, w.K.REMOVED_LEADS_SHEET, mode);
    assert.deepEqual(remove(w), { ok: false, error: 'move_write_failed' }, mode);
    assert.deepEqual(w.leads(), ['L-1'], mode);
    assert.deepEqual(w.removed(), [], mode);
  }
});

test('remove: a failure between the steps, then a retry — one removed row', () => {
  const w = world();
  failDeleteOnceFrom(w, w.K.LEADS_SHEET);
  assert.throws(() => remove(w), /timed out/);
  assert.deepEqual(w.leads(), ['L-1']);
  assert.deepEqual(w.removed(), ['L-1']);
  assert.equal(remove(w).ok, true);
  assert.deepEqual(w.leads(), []);
  assert.deepEqual(w.removed(), ['L-1']);
});

/* ---------- wiring ---------- */

test('wiring: no move path deletes before it writes; every lead move goes through moveRowWriteFirst_', () => {
  for (const fn of ['moveLeadIrrelevant_', 'restoreLead_', 'removeLead_']) {
    const body = GS_SRC.slice(GS_SRC.indexOf('function ' + fn + '('), GS_SRC.indexOf('\n}\n', GS_SRC.indexOf('function ' + fn + '(')));
    assert.match(body, /moveRowWriteFirst_\(/, fn);
    assert.doesNotMatch(body, /deleteRowsById_\(/, fn + ' deletes only through moveRowWriteFirst_');
    assert.match(body, /LockService\.getScriptLock\(\)/, fn + ' under the lock');
  }
  const helper = GS_SRC.slice(GS_SRC.indexOf('function moveRowWriteFirst_('), GS_SRC.indexOf('\n}\n', GS_SRC.indexOf('function moveRowWriteFirst_(')));
  assert.ok(helper.indexOf('upsertRowById_(') < helper.indexOf('countRowsById_(') && helper.indexOf('countRowsById_(') < helper.indexOf('deleteRowsById_('),
    'write → verify → delete');
});
