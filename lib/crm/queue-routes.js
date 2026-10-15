'use strict';
const path = require('node:path');
const { collectLeads, israelDay } = require('./read-routes');

// This route owns ONLY dashboard.leads. Browser inputs cannot choose a tenant,
// dataset, principal, grant, ticket or observation. POST reads the source and
// commits an operational checkpoint; GET never collects or mutates a checkpoint.
function installQueueRoutes(app, { requireSession, authorize, runtime, read }) {
  let collecting = false;
  function guard(req, res, next) {
    if (!authorize(req)) return res.status(403).json({ ok: false, error: 'forbidden' });
    if (!runtime.enabled) return res.status(503).json({ ok: false, error: 'crm_queue_disabled' });
    if (Object.keys(req.query || {}).length || Object.keys(req.body || {}).length) return res.status(400).json({ ok: false, error: 'crm_parameters_not_supported' });
    next();
  }
  app.use(['/api/crm/queue', '/crm-work'], (_req, res, next) => {
    res.set('Cache-Control', 'private, no-store'); res.vary('Cookie');
    res.set('X-Content-Type-Options', 'nosniff'); res.set('Referrer-Policy', 'no-referrer');
    res.set('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    next();
  }, requireSession, guard);
  function grant(req) {
    const revision = authorize(req);
    return revision ? { ...runtime.scope, policyRevision: revision, allRecords: true, showName: true, showAssignee: true } : null;
  }
  async function respond(req, res, refresh) {
    let held = false;
    try {
      const before = grant(req);
      if (!before) return res.status(403).json({ ok: false, error: 'forbidden' });
      const store = runtime.getStore();
      if (refresh) {
        if (collecting) return res.status(409).json({ ok: false, error: 'crm_collection_in_progress' });
        collecting = true; held = true;
        // An approved/provisioned epoch is fixed for this process. HTTP handlers
        // NEVER call start(): a fenced server cannot steal ownership back.
        const ticket = await store.reserve(runtime.scope, runtime.epoch);
        const result = await collectLeads('dashboard', action => read(action, req));
        if (JSON.stringify(before) !== JSON.stringify(grant(req))) return res.status(403).json({ ok: false, error: 'forbidden' });
        await store.accept(runtime.scope, ticket, result.envelope);
      }
      const queue = await store.read(runtime.scope, { authorize: () => grant(req), today: israelDay(new Date()) });
      if (!queue) return res.status(403).json({ ok: false, error: 'forbidden' });
      return res.json({ ok: true, contract: 'crm-queue-v1', persistence: 'postgres', queue });
    } catch (error) {
      const superseded = ['collector_fenced', 'out_of_order'].includes(error?.code);
      return res.status(superseded ? 409 : 503).json({ ok: false, error: superseded ? 'crm_collection_superseded' : 'crm_queue_unavailable' });
    } finally { if (held) collecting = false; }
  }
  app.get('/api/crm/queue', requireSession, (req, res) => respond(req, res, false));
  app.post('/api/crm/queue/refresh', requireSession, (req, res) => {
    // No CORS grant. Custom header + JSON + exact Origin resist form/CSRF calls.
    const origin = `${req.protocol}://${req.get('host')}`;
    const site = req.get('sec-fetch-site');
    if (req.get('origin') !== origin || req.get('x-crm-refresh') !== '1' || !req.is('application/json') ||
        (site && site !== 'same-origin')) return res.status(403).json({ ok: false, error: 'crm_same_origin_required' });
    return respond(req, res, true);
  });
  const directory = path.join(__dirname, '../../crm-ui');
  for (const [url, file] of [['/crm-work', 'index.html'], ['/crm-work/app.js', 'app.js'], ['/crm-work/style.css', 'style.css']]) {
    app.get(url, requireSession, (_req, res) => res.sendFile(file, { root: directory, cacheControl: false }));
  }
}
module.exports = { installQueueRoutes };
