'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crm = require('../public/crm/crm.js');

test('UTC activity close to midnight renders the next Israeli date in both CRM views', () => {
  assert.equal(crm.whenLocal('2026-11-04T22:30:00.000Z'), '05/11/2026 00:30');
  assert.equal(crm.whenLocal('2026-11-05T00:30:00+02:00'), '05/11/2026 00:30');
});

test('daylight-saving hour difference is respected in summer', () => {
  assert.equal(crm.whenLocal('2026-07-10T21:30:00.000Z'), '11/07/2026 00:30');
  assert.equal(crm.whenLocal('2026-07-11T00:30:00+03:00'), '11/07/2026 00:30');
});

test('an ISO-like unzoned wall-clock timestamp is not interpreted in the browser timezone', () => {
  assert.equal(crm.whenLocal('2026-11-05T00:30:00'), '05/11/2026 00:30');
  assert.equal(crm.whenLocal('2026-11-05T00:30:00.000'), '05/11/2026 00:30');
  assert.equal(crm.whenLocal('2026-11-05'), '05/11/2026');
});

test('both Activity renderers use the same pure format as Today, not UTC slices', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public/crm/crm.js'), 'utf8');
  assert.equal((src.match(/whenLocal\(e\.occurredAt\)/g) || []).length, 2);
  assert.doesNotMatch(src, /fmtDate\(String\(e\.occurredAt \|\| ''\)\.slice/);
  assert.match(src, /function whenLocal\(/);
});

test('formatting never mutates event data or fabricates a second contact', () => {
  const activity = { id: 'contact-1', occurredAt: '2026-11-04T22:30:00.000Z' };
  const before = JSON.stringify(activity);
  assert.equal(crm.whenLocal(activity.occurredAt), '05/11/2026 00:30');
  assert.equal(JSON.stringify(activity), before);
});
