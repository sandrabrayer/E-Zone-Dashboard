'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { normalize, mergeCheckpoint, projectCheckpoint } = require('../../lib/crm/checkpoint-state');
const scope = { tenant: 'synthetic-tenant', dataset: 'dashboard.leads' };
const now = '2026-10-13T16:00:00.000Z';
const row = (extra = {}) => ({ nativeRecordId: 'synthetic-1', identityKind: 'row', reason: 'lead_followup', state: 'active',
  displayName: 'שם בדוי בלבד', assignee: 'מבצעת בדויה', dueBasis: 'unknown', originalDueDate: null, eventDate: null, sourceUpdatedAt: null, ...extra });
const obs = (records = [row()], extra = {}) => ({ dataset: scope.dataset, health: 'fresh', complete: true, observedAt: now, records, ...extra });
const grant = extra => ({ ...scope, allRecords: true, showName: true, showAssignee: true, policyRevision: '1', ...extra });
const merge = (prior, input) => mergeCheckpoint(prior, normalize(scope, input));
const view = (cp, extra) => projectCheckpoint(scope, cp, grant(extra), '2026-10-13');
test('missing row preserves open work; an empty read is not a resolution', () => {
  let cp = merge(null, obs()); cp = merge(cp, obs([]));
  assert.equal(view(cp).totals.tasks, 1); assert.equal(view(cp).rows[0].uncertainty, 'missing_in_source');
});
test('repeated failures and partial reads do not lose retained work', () => {
  let cp = merge(null, obs());
  for (let i = 0; i < 12; i++) cp = merge(cp, obs([], { health: 'unavailable', complete: false, observedAt: null }));
  cp = merge(cp, obs([], { health: 'partial', complete: false })); assert.equal(view(cp).totals.tasks, 1);
});
test('closure needs fresh, complete and explicit reason-level resolution', () => {
  const cp = merge(null, obs([row(), row({ reason: 'meeting_result' })]));
  for (const extra of [{ health: 'stale' }, { complete: false }, { health: 'partial', complete: false }]) {
    assert.equal(view(merge(cp, obs([row({ state: 'resolved' })], extra))).totals.tasks, 2);
  }
  const closed = view(merge(cp, obs([row({ state: 'resolved' })])));
  assert.equal(closed.totals.tasks, 1); assert.equal(closed.rows[0].reason, 'meeting_result');
});
test('closed task stays closed through disappearance, outage and partial contradictory data', () => {
  const cp = merge(null, obs([row({ state: 'resolved' })]));
  for (const input of [obs([]), obs([], { health: 'unavailable', complete: false, observedAt: null }), obs([row()], { complete: false })]) {
    assert.equal(view(merge(cp, input)).totals.tasks, 0);
  }
  assert.equal(view(merge(cp, obs())).totals.tasks, 1); // Explicit new active state can reopen.
});
test('original deadline survives reassignment and source rescheduling', () => {
  let cp = merge(null, obs([row({ dueBasis: 'source', originalDueDate: '2026-10-01' })]));
  cp = merge(cp, obs([row({ assignee: 'אחרת', dueBasis: 'source', originalDueDate: '2026-12-01' })]));
  const r = view(cp).rows[0]; assert.equal(r.originalDueDate, '2026-10-01'); assert.equal(r.dueState, 'overdue'); assert.equal(r.accountable, 'Vered');
});
test('missing deadline stays missing, not on-time', () => assert.equal(view(merge(null, obs())).rows[0].dueState, 'missing'));
test('unknown status stays visible for review', () => assert.equal(view(merge(null, obs([row({ state: 'unknown' })]))).rows[0].uncertainty, 'unknown_status'));
test('current record scope filters before counts, names and source metadata', () => {
  const cp = merge(null, obs([row(), row({ nativeRecordId: 'hidden' })]));
  const v = view(cp, { allRecords: false, allowedIds: ['synthetic-1'], showName: false, showAssignee: false });
  assert.equal(v.totals.tasks, 1); assert.equal(v.source, null); assert.equal(v.historyAvailable, null);
  assert.equal(v.rows[0].displayName, null); assert.equal(v.rows[0].assignee, null); assert.ok(!JSON.stringify(v).includes('hidden'));
});
test('wrong tenant/dataset, no grant and empty grants expose no data or metadata', () => {
  const cp = merge(null, obs());
  for (const g of [null, {}, grant({ tenant: 'other' }), grant({ dataset: 'outpatient.leads' }), grant({ allRecords: false, allowedIds: [] })]) {
    assert.equal(projectCheckpoint(scope, cp, g, '2026-10-13'), null);
  }
});
test('composite identity is hidden when name access is denied', () => {
  const s = { ...scope, dataset: 'outpatient.continuation' }, record = row({ nativeRecordId: 'NAME|ramot|2026-10-01', identityKind: 'composite', reason: 'continuation_decision' });
  const cp = mergeCheckpoint(null, normalize(s, { ...obs([record]), dataset: s.dataset }));
  const v = projectCheckpoint(s, cp, { ...grant(), ...s, showName: false }, '2026-10-13');
  assert.equal(v.rows[0].sourceRef.nativeRecordId, null); assert.ok(!JSON.stringify(v).includes('NAME'));
});
test('continuing/stopping cannot close a prior destination-link review', () => {
  const s = { ...scope, dataset: 'outpatient.continuation' }, base = row({ nativeRecordId: 'NAME|ramot|2026-10-01', identityKind: 'composite' });
  let cp = mergeCheckpoint(null, normalize(s, { ...obs([{ ...base, reason: 'destination_link_review' }]), dataset: s.dataset }));
  cp = mergeCheckpoint(cp, normalize(s, { ...obs([{ ...base, reason: 'continuation_decision', state: 'resolved' }]), dataset: s.dataset }));
  const v = projectCheckpoint(s, cp, { ...grant(), ...s }, '2026-10-13'); assert.equal(v.rows[0].reason, 'destination_link_review');
});
test('projection drops phones, notes, money and raw source status before persistence', () => {
  const value = normalize(scope, obs([row({ phone: 'PRIVATE_PHONE', note: 'PRIVATE_NOTE', sourceStatus: 'PRIVATE_STATUS', sourceFinancialProjection: { balance: 999 } })]));
  assert.ok(!JSON.stringify(value).includes('PRIVATE')); assert.ok(!JSON.stringify(value).includes('balance'));
});
test('adapter timestamps with an explicit offset normalize without shifting calendar deadlines', () => {
  const result = normalize(scope, obs([row({ sourceUpdatedAt: '2026-10-13T19:00:00+03:00' })]));
  assert.equal(result.records[0].record.sourceUpdatedAt, now);
});
test('real operational adapter feeds durable reconciliation without inferring acceptance', async () => {
  const { adaptContinuation, continuationKey } = await import('../../lib/crm/source-adapters.mjs');
  const s = { ...scope, dataset: 'outpatient.continuation' }, person = { name: 'בדיקה בלבד', house: 'ramot', entryDate: '2026-10-01' };
  const key = continuationKey(person), access = { dataset: s.dataset, allowedIds: [key], showName: true };
  const input = rows => ({ rows, health: 'fresh', complete: true, observedAt: now });
  const observed = outcome => adaptContinuation({ workflow: input([{ ...person, key, outcome, meetingDate: '' }]), roster: input([person]), access, now }).envelope;
  let cp = mergeCheckpoint(null, normalize(s, observed('to_outpatient')));
  cp = mergeCheckpoint(cp, normalize(s, observed('stopping')));
  const result = projectCheckpoint(s, cp, { ...grant(), ...s }, '2026-10-13');
  assert.equal(result.totals.tasks, 1); assert.equal(result.rows[0].reason, 'destination_link_review');
});
for (const [label, input] of [
  ['duplicate', obs([row(), row()])], ['invalid date', obs([row({ dueBasis: 'source', originalDueDate: '2026-02-30' })])],
  ['unknown reason', obs([row({ reason: 'balance_followup' })])], ['missing ID', obs([row({ nativeRecordId: '' })])],
  ['malformed time', obs([], { observedAt: '2026-02-30T16:00:00Z' })], ['unavailable with rows', obs([row()], { health: 'unavailable', complete: false, observedAt: null })],
]) test('reject malformed observations atomically: ' + label, () => assert.throws(() => normalize(scope, input)));
