/* CHANGELOG-railway-healthcheck-timeout.md — Railway's healthcheck window.
 * 28/10/2026: four deploys in a row (#308, #310 …) FAILED at
 * «Network › Healthcheck» after Build and Deploy passed in seconds, while
 * /healthz itself is synchronous and app.listen binds at once — the 30 s
 * window was spent on Railway's network attach (their Oct 21 incident
 * recovery). A deploy that never goes live is worse than one that waits. */
const { test } = require('node:test');
const assert = require('node:assert');
const cfg = require('../railway.json');

test('railway.json: healthcheck stays on /healthz with a window that survives a slow network attach', () => {
  assert.strictEqual(cfg.deploy.healthcheckPath, '/healthz');
  assert.ok(cfg.deploy.healthcheckTimeout >= 300, 'at least 300 s (was 30 s; failed four deploys on 28/10/2026)');
  assert.strictEqual(cfg.deploy.startCommand, 'node server.js');
});

test('/healthz answers without touching Apps Script (so the window is only the network attach)', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(/app\.get\('\/healthz', \(_, res\) => res\.json\(healthzBody\(\)\)\);/.test(src));
});
