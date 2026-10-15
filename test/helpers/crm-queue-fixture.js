'use strict';
// Synthetic, in-memory route/browser fixture. This is NOT a durability test.
const express = require('express');
const { installQueueRoutes } = require('../../lib/crm/queue-routes');
const { normalize, mergeCheckpoint, projectCheckpoint, CheckpointError } = require('../../lib/crm/checkpoint-state');
async function fixture() {
  const scope = { tenant: 'synthetic-ui', dataset: 'dashboard.leads' };
  const state = { allowed: true, revision: 'staff-v1', reads: 0, reserves: 0, accepts: 0, failure: null, checkpoint: null,
    source: 'fresh', rows: [{ leadLifecycle: 'active', id: 'fixture-1', name: 'דוגמה לבדיקה בלבד', stage: 'new', assignedTo: 'מבצעת לדוגמה', visitDate: '', meetingOutcome: '', meetingReportOutcome: '' }] };
  const runtime = { enabled: true, scope, epoch: 1, getStore: () => store };
  const store = {
    async reserve() { state.reserves++; if (state.failure) throw new CheckpointError(state.failure); return { epoch: 1, sequence: state.reserves }; },
    async accept(_s, _t, observation) { if (state.failure) throw new CheckpointError(state.failure); state.checkpoint = mergeCheckpoint(state.checkpoint, normalize(scope, observation)); state.accepts++; },
    async read(_s, { authorize, today }) {
      if (state.failure) throw new CheckpointError(state.failure);
      return projectCheckpoint(scope, state.checkpoint, await authorize(), today);
    },
  };
  const app = express(); app.use(express.json());
  const requireSession = (req, res, next) => req.get('cookie') === 'fixture-session=valid' ? next() : res.status(401).json({ ok: false });
  const authorize = () => state.allowed ? state.revision : null;
  const read = async action => {
    state.reads++; if (action !== 'getCrmLeads') throw Error('unapproved action');
    if (state.waitSource) await state.waitSource;
    if (state.source === 'unavailable') throw Error('PRIVATE_UPSTREAM_SECRET');
    return { ok: true, contract: 'crm-source-v2', dataset: scope.dataset, health: 'fresh', complete: true, observedAt: new Date().toISOString(), rows: state.rows };
  };
  installQueueRoutes(app, { requireSession, authorize, runtime, read });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function request(path = '/api/crm/queue', opts = {}) {
    const response = await fetch(origin + path, { ...opts, headers: { Cookie: 'fixture-session=valid', ...opts.headers } });
    const text = await response.text(); let data; try { data = JSON.parse(text); } catch (_) { data = text; }
    return { status: response.status, data, headers: response.headers };
  }
  const refresh = opts => request('/api/crm/queue/refresh', { method: 'POST', body: '{}', ...opts,
    headers: { Origin: origin, 'Content-Type': 'application/json', 'X-CRM-Refresh': '1', ...opts?.headers } });
  return { state, runtime, store, origin, request, refresh, close: () => new Promise(r => server.close(r)) };
}
module.exports = { fixture };
