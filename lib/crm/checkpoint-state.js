'use strict';

// Normalized operational observations only. No HTTP input, identity joins,
// money, notes or source writes. The caller must use the authenticated adapter.
const { createHash } = require('node:crypto');
const REASONS = Object.freeze({
  'dashboard.leads': ['lead_followup', 'meeting_result'],
  'outpatient.leads': ['lead_followup'],
  'outpatient.continuation': ['continuation_decision', 'destination_link_review'],
});
class CheckpointError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new CheckpointError(code); };
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
const stamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
  date(value.slice(0, 10)) && +value.slice(11, 13) < 24 && +value.slice(14, 16) < 60 && +value.slice(17, 19) < 60 && Number.isFinite(Date.parse(value));
function scopeKey(scope) {
  if (!scope || typeof scope.tenant !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(scope.tenant) || !Object.hasOwn(REASONS, scope.dataset)) fail('invalid_scope');
  return JSON.stringify([scope.tenant, scope.dataset]);
}
function taskKey(scope, record) {
  return createHash('sha256').update(JSON.stringify([scopeKey(scope), record.nativeRecordId, record.reason])).digest('hex');
}
function normalize(scope, input) {
  scopeKey(scope);
  if (!input || input.dataset !== scope.dataset || !['fresh', 'stale', 'partial', 'unavailable'].includes(input.health) ||
      typeof input.complete !== 'boolean' || !Array.isArray(input.records) || input.records.length > 20000 ||
      (input.health === 'unavailable' ? input.complete || input.records.length || input.observedAt !== null : !stamp(input.observedAt))) fail('invalid_observation');
  const seen = new Set();
  const records = input.records.map(r => {
    const identity = scope.dataset === 'outpatient.continuation' ? 'composite' : 'row';
    if (!r || typeof r.nativeRecordId !== 'string' || !r.nativeRecordId.trim() || r.nativeRecordId.length > 1000 ||
        r.identityKind !== identity || !REASONS[scope.dataset].includes(r.reason) || !['active', 'resolved', 'unknown'].includes(r.state) ||
        !['source', 'unknown'].includes(r.dueBasis)) fail('invalid_observation');
    const text = key => {
      if (r[key] == null) return null;
      if (typeof r[key] !== 'string' || r[key].length > 500) fail('invalid_observation');
      return r[key];
    };
    const day = key => {
      if (r[key] == null) return null;
      if (r[key] === 'invalid' && key === 'eventDate') return 'invalid';
      if (!date(r[key])) fail('invalid_observation');
      return r[key];
    };
    if (r.sourceUpdatedAt != null && !stamp(r.sourceUpdatedAt)) fail('invalid_observation');
    if (r.resolutionBasis != null && (scope.dataset !== 'dashboard.leads' || r.state !== 'resolved' ||
        !['archived_irrelevant','archived_removed'].includes(r.resolutionBasis))) fail('invalid_observation');
    const record = {
      nativeRecordId: r.nativeRecordId.trim(), identityKind: identity, reason: r.reason, state: r.state,
      displayName: text('displayName'), assignee: text('assignee'), dueBasis: r.dueBasis,
      originalDueDate: r.dueBasis === 'source' ? day('originalDueDate') : null,
      nextActionDate: day('nextActionDate'), eventDate: day('eventDate'), sourceUpdatedAt: r.sourceUpdatedAt == null ? null : new Date(r.sourceUpdatedAt).toISOString(),
      resolutionBasis: r.resolutionBasis || null,
    };
    const key = taskKey(scope, record);
    if (seen.has(key)) fail('duplicate_task');
    seen.add(key);
    return { key, record };
  }).sort((a, b) => a.key.localeCompare(b.key));
  return { dataset: scope.dataset, health: input.health, complete: input.complete, observedAt: input.observedAt === null ? null : new Date(input.observedAt).toISOString(), records };
}
function mergeCheckpoint(previous, observation) {
  const prior = previous || { version: 1, tasks: [] };
  if (prior.version !== 1 || !Array.isArray(prior.tasks)) fail('checkpoint_unavailable');
  const authoritative = observation.health === 'fresh' && observation.complete;
  const tasks = new Map(prior.tasks.map(t => [t.key, { ...t,
    uncertainty: t.closed ? null : observation.health === 'unavailable' ? 'source_unavailable' : 'missing_in_source' }]));
  for (const { key, record } of observation.records) {
    const old = tasks.get(key);
    // Partial evidence cannot undo a proven resolution or claim a new one.
    if (old?.closed && !authoritative) continue;
    const original = old?.record.dueBasis === 'source' && old.record.originalDueDate ? old.record.originalDueDate : record.originalDueDate;
    const saved = { ...record, originalDueDate: original, dueBasis: original ? 'source' : record.dueBasis };
    tasks.set(key, { key, record: saved, closed: authoritative && record.state === 'resolved',
      firstSeenAt: old?.firstSeenAt || observation.observedAt, lastSeenAt: observation.observedAt,
      resolutionAt: authoritative && record.state === 'resolved' ? observation.observedAt : null,
      uncertainty: !authoritative ? 'unconfirmed_source' : record.state === 'unknown' ? 'unknown_status' : null });
  }
  if (tasks.size > 25000) fail('checkpoint_capacity'); // Never evict unresolved work.
  return { version: 1, source: { health: observation.health, complete: observation.complete, observedAt: observation.observedAt },
    tasks: [...tasks.values()].sort((a, b) => a.key.localeCompare(b.key)) };
}
function projectCheckpoint(scope, checkpoint, grant, today) {
  if (!grant || grant.tenant !== scope.tenant || grant.dataset !== scope.dataset ||
      typeof grant.policyRevision !== 'string' || !grant.policyRevision ||
      (grant.allRecords !== true && (!Array.isArray(grant.allowedIds) || !grant.allowedIds.length ||
        grant.allowedIds.some(id => typeof id !== 'string' || !id.trim())))) return null;
  if (!date(today)) fail('invalid_date');
  const allowed = new Set(grant.allowedIds || []);
  const visible = (checkpoint?.tasks || []).filter(t => !t.closed && (grant.allRecords === true || allowed.has(t.record.nativeRecordId)));
  const rows = visible.map(t => {
    const r = t.record, due = r.originalDueDate;
    return { taskKey: t.key, dataset: scope.dataset, reason: r.reason, accountable: 'Vered',
      sourceRef: { nativeRecordId: r.identityKind === 'composite' && grant.showName !== true ? null : r.nativeRecordId, identityKind: r.identityKind },
      displayName: grant.showName === true ? r.displayName : null, assignee: grant.showAssignee === true ? r.assignee : null,
      originalDueDate: due, dueState: !due ? 'missing' : due < today ? 'overdue' : due === today ? 'today' : 'future',
      eventDate: r.eventDate, sourceUpdatedAt: r.sourceUpdatedAt, lastSeenAt: t.lastSeenAt,
      uncertainty: t.uncertainty, personLink: 'unknown',
    };
  });
  // Record-limited readers receive no counts/diagnostics about hidden records.
  const source = grant.allRecords === true ? checkpoint?.source || { health: 'unavailable', complete: false, observedAt: null } : null;
  return { dataset: scope.dataset, rows, source,
    totals: { tasks: rows.length, uncertain: rows.filter(r => r.uncertainty).length },
    historyAvailable: grant.allRecords === true ? checkpoint !== null : null };
}
module.exports = { CheckpointError, scopeKey, taskKey, normalize, mergeCheckpoint, projectCheckpoint };
