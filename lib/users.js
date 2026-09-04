'use strict';

/* The fixed set of dashboard users — the SAME three names as the leads
 * `assignedTo` dropdown (public/app.js ASSIGNEE_OPTIONS). Single source of
 * truth for the server: /api/verify-pin accepts a session `user` ONLY from
 * this list (anything else mints the legacy user-less cookie), so updatedBy
 * can never carry an arbitrary string, however the request was crafted.
 *
 * The client's picker uses its own SESSION_USERS literal in public/app.js
 * (a plain browser script cannot require() this file); a guard test in
 * test/name-picker-conflicts.test.js pins the two lists equal, so they can
 * never drift silently. Add/rename users HERE and THERE together. */
const SESSION_USERS = ['ורד', 'שירן', 'יעל'];

module.exports = { SESSION_USERS };
