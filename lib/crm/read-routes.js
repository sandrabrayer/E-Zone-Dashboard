'use strict';

// Source observations only. No client grants, previous snapshots, persistent
// task store, shared cache, or cross-app personal-identity mapping.
const FIELDS = {
  'dashboard.leads': ['id','name','stage','assignedTo','visitDate','meetingOutcome','meetingReportOutcome'],
  'outpatient.leads': ['id','name','stage','assignedTo','introDateTime','updatedAt'],
  'outpatient.continuation': ['key','name','house','entryDate','meetingDate','outcome','updatedAt'],
  'dashboard.admitted_roster': ['name','house','entryDate'],
};
const adapters = import('./source-adapters.mjs');
function unavailable(dataset) {
  return { dataset, rows: [], health: 'unavailable', complete: false, observedAt: null };
}
async function collect(dataset, read, action) {
  const started = Date.now();
  try {
    const data = await read(action);
    const ended = Date.now(), stamp = Date.parse(data?.observedAt);
    if (data?.ok !== true || data.contract !== 'crm-source-v1' || data.dataset !== dataset ||
        data.health !== 'fresh' || data.complete !== true || !Array.isArray(data.rows) || data.rows.length > 10000 ||
        typeof data.observedAt !== 'string' || !Number.isFinite(stamp) ||
        stamp < started - 60000 || stamp > ended + 60000) throw Error('source_invalid');
    // A one-minute clock tolerance validates this request's source observation;
    // it is not a business freshness SLA or a durable ordering mechanism.
    const fields = FIELDS[dataset];
    const rows = data.rows.map(row => {
      if (!row || typeof row !== 'object' || fields.some(k => typeof row[k] !== 'string')) throw Error('source_invalid');
      const projected = Object.fromEntries(fields.map(k => [k, row[k]]));
      if ('id' in projected && !projected.id.trim()) throw Error('source_invalid');
      if ('key' in projected && !projected.key.trim()) throw Error('source_invalid');
      return projected;
    });
    return { dataset, rows, health: 'fresh', complete: true, observedAt: new Date(ended).toISOString() };
  } catch (_) { return unavailable(dataset); }
}
function israelDay(now) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(now)).map(x => [x.type,x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
function empty(input) {
  const { dataset, health, complete, observedAt } = input;
  return { envelope: { dataset, health, complete, observedAt, records: [] }, diagnostics: [] };
}
function send(res, result) {
  const e = result.envelope;
  return res.status(e.health === 'unavailable' ? 503 : 200).json({
    ok: e.health !== 'unavailable', contract: 'crm-observations-v1',
    persistence: 'none', ...e, diagnostics: result.diagnostics,
    // A consumer MUST retain its prior authorized tasks on failure/disappearance.
    // This endpoint does not close historical tasks or promise an all-clear queue.
  });
}
function installCrmReadRoutes(app, { source, requireSession, authorize, enabled, read, readRoster }) {
  app.use('/api/crm', (_req, res, next) => { res.set('Cache-Control', 'private, no-store'); res.vary('Cookie'); next(); }, requireSession,
    (req, res, next) => {
      if (!authorize(req)) return res.status(403).json({ ok: false, error: 'forbidden' });
      if (!enabled) return res.status(503).json({ ok: false, error: 'crm_disabled' });
      if (Object.keys(req.query || {}).length || Object.keys(req.body || {}).length) return res.status(400).json({ ok: false, error: 'crm_parameters_not_supported' });
      next();
    });
  app.get('/api/crm/leads', requireSession, async (req, res) => {
    const dataset = source + '.leads';
    try {
      const input = await collect(dataset, action => read(action, req), 'getCrmLeads');
      const a = await adapters, now = new Date().toISOString();
      // The route has already authorized the entire same-app lead scope, using
      // the source's existing server policy. IDs never come from the browser.
      const access = { dataset, allowedIds: input.rows.map(r => r.id.trim()), showName: true, showAssignee: true, showMoney: false };
      send(res, input.rows.length ? a.adaptLeads({ dataset, input, access, now, today: israelDay(now) }) : empty(input));
    } catch (_) { send(res, empty(unavailable(dataset))); }
  });
  if (source === 'outpatient') app.get('/api/crm/continuation', requireSession, async (req, res) => {
    const dataset = 'outpatient.continuation';
    try {
      const [workflow, roster] = await Promise.all([
        collect(dataset, action => read(action, req), 'getCrmContinuation'),
        collect('dashboard.admitted_roster', readRoster, 'getCrmAdmittedRoster'),
      ]);
      const a = await adapters, now = new Date().toISOString();
      // An invalid composite key is a partial source, never a blank decision.
      const validWorkflow = workflow.rows.every(r => a.continuationKey(r) === r.key.trim());
      const validRoster = roster.rows.every(r => a.continuationKey(r));
      if (!validWorkflow) { send(res, empty(unavailable(dataset))); return; }
      if (!validRoster) { roster.health = 'unavailable'; roster.complete = false; roster.rows = []; }
      const ids = [...new Set([...workflow.rows.map(r => r.key.trim()), ...roster.rows.map(a.continuationKey)])];
      const access = { dataset, allowedIds: ids, showName: true, showAssignee: false, showMoney: false };
      if (workflow.health === 'unavailable') { send(res, empty(workflow)); return; }
      if (!ids.length) {
        if (roster.health === 'unavailable') { send(res, empty(unavailable(dataset))); return; }
        send(res, empty(workflow)); return;
      }
      send(res, a.adaptContinuation({ workflow, roster, access, now }));
    } catch (_) { send(res, empty(unavailable(dataset))); }
  });
  app.use('/api/crm', (_req, res) => res.status(404).json({ ok: false, error: 'not_found' }));
}
module.exports = { installCrmReadRoutes, collect };
