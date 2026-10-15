'use strict';

// Shared guard for destructive SYNTHETIC database drills, never runtime config.
function fixtureUrl(value, database) {
  let url;
  try { url = new URL(value); } catch (_) { throw Error('fixture_database_required'); }
  if (!['crm_checkpoint_test', 'crm_checkpoint_restore_test'].includes(database) ||
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.pathname !== '/' + database || !url.username || url.search || url.hash) {
    throw Error('fixture_database_required');
  }
  return url.href;
}
module.exports = { fixtureUrl };
