'use strict';
// Audit only: preserve ALL original Chromium journeys byte-for-byte, then add
// synthetic failure/race probes using the same real server and browser harness.
// Baseline Git blob: 0c93df5574853da7831cddb03e87cfc4e70f7a11. No runtime change.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const source = fs.readFileSync(path.join(__dirname, 'crm-shell-browser.billing-audit-baseline'), 'utf8');
const m = new Module(__filename, module);
m.filename = __filename; m.paths = module.paths;
m._compile(source + '\nrequire("./billing-update-audit-browser.cjs")({test,assert,skip,playwright,chromiumPath,boot,open,billTab,PAYMENTS,DEBT,TODAY,daysAgo,setSaveAnswer:(v)=>{saveAnswer=v;}});\n', __filename);
