'use strict';

/* Phase 2b (CHANGELOG-assignees-dana.md): the lead-owner lists after Shiran and
 * Yael left — classic add-lead form, the CRM, and the Therapists create-lead
 * allow-list (legacy names still accepted, never offered). */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../public/crm/crm.js');
const { loadGs } = require('./helpers/gs-sandbox');

const APP_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const GS_SRC = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');

test('classic ASSIGNEE_OPTIONS === CRM ASSIGNEES === [ורד, דנה, סנדרה]; the classic form offers no legacy name', () => {
  const m = /const ASSIGNEE_OPTIONS = (\[[^\]]*\]);/.exec(APP_SRC);
  assert.ok(m);
  const classic = JSON.parse(m[1].replace(/'/g, '"'));
  assert.deepStrictEqual(classic, ['ורד', 'דנה', 'סנדרה']);
  assert.deepStrictEqual([...core.ASSIGNEES], classic);
  assert.ok(!/ASSIGNEE_OPTIONS = \[[^\]]*(שירן|יעל)/.test(APP_SRC));
});

test('Code.gs CREATE_LEAD_ASSIGNEES: the current three first, the two legacy names still accepted (append-only); anything else → blank', () => {
  const g = loadGs({ props: {} });
  assert.deepStrictEqual(Array.from(g.run('CREATE_LEAD_ASSIGNEES')), ['ורד', 'דנה', 'סנדרה', 'שירן', 'יעל']);
  assert.match(GS_SRC, /const CREATE_LEAD_ASSIGNEES = \['ורד', 'דנה', 'סנדרה', 'שירן', 'יעל'\];/);
});
