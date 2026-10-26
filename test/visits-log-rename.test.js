'use strict';

/* «יומן ביקורים ודיווח סטטוס» — the manager-report feature's new user-facing
 * name (CHANGELOG-visits-log-rename.md). Strings only: this file pins the new
 * Hebrew strings AND that nothing structural moved (ids, route, script/CSS
 * links, the main-app «דיווח מנהל» per-lead block). The SW treatment of the
 * page (plain network, never cached — so no CACHE_VERSION bump) is already
 * pinned in meeting-report-form.test.js. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const FORM = read('public/meeting-report.html');
const PIN = read('public/meeting-report-pin.html');
const APP = read('public/app.js');
const SERVER = read('server.js');
const mr = require('../public/meeting-report.js');

const NAME = 'יומן ביקורים ודיווח סטטוס';
const OLD = 'דיווח פגישה';

test('form page: <title>, <h1> and subtitle carry the new feature name', () => {
  assert.match(FORM, new RegExp('<title>' + NAME + ' — E-Zone</title>'));
  assert.match(FORM, new RegExp('<h1>' + NAME + '</h1>'));
  assert.match(FORM, /<p>E-Zone — דיווח מנהלי הבתים<\/p>/, 'subtitle kept');
  assert.ok(!FORM.includes(OLD), 'old feature name gone from the form page');
});

test('PIN page: <title> and heading carry the new feature name', () => {
  assert.match(PIN, new RegExp('<title>' + NAME + ' — E-Zone</title>'));
  assert.match(PIN, new RegExp('<h1>' + NAME + '</h1>'));
  assert.ok(!PIN.includes(OLD), 'old feature name gone from the PIN page');
});

test('WhatsApp message header line is the new feature name', () => {
  const msg = mr.mrWhatsAppMessage({
    name: 'דני', house: 'ramot', outcome: 'advancing',
    companion: 'mother', note: 'x', reporter: 'יעל',
  });
  assert.equal(msg.split('\n')[0], NAME + ' — E-Zone');
  assert.ok(!msg.includes(OLD));
});

test('structure untouched: ids, asset links, route and the «דיווח מנהל» block', () => {
  ['mr-form', 'mr-reporter', 'mr-lead', 'mr-lead-toggle', 'mr-outcomes', 'mr-submit', 'mr-again']
    .forEach((id) => assert.ok(FORM.includes('id="' + id + '"'), id));
  assert.ok(FORM.includes('/meeting-report.css?v=__BUILD__'));
  assert.ok(PIN.includes('id="pin-input"'));
  assert.ok(SERVER.includes("app.get('/meeting-report', handleMeetingReportPage)"));
  assert.ok(APP.includes('<span class="mrv-title">דיווח מנהל/ת</span>'), 'per-lead block label stays');
});
