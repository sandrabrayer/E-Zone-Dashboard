'use strict';

/* Dashboard occupancy counts OPEN houses only (שדה אליעזר excluded), shows a
 * % per house, and the «ועדות קרובות» card is gone
 * (CHANGELOG-dashboard-open-houses-occupancy.md). */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

const APP = read('public', 'app.js');
const INDEX = read('public', 'index.html');

test('שדה אליעזר is flagged closed; every other house is open', () => {
  const block = APP.slice(APP.indexOf('const HOUSES = ['), APP.indexOf('];', APP.indexOf('const HOUSES = [')));
  assert.match(block, /id: 'sde'[^\n]*closed: true/);
  assert.equal((block.match(/closed: true/g) || []).length, 1);
});

test('renderDashboard: totals and patients come from open houses only; one card per open house with a % figure', () => {
  const fn = APP.slice(APP.indexOf('function renderDashboard()'), APP.indexOf('const pipe = document.getElementById'));
  assert.match(fn, /const openHouses = HOUSES\.filter\(h => !h\.closed\)/);
  assert.match(fn, /openIds\.has\(p\.houseId\)/);
  assert.match(fn, /const totalCap = openHouses\.reduce/);
  assert.match(fn, /openHouses\.forEach\(h =>/);
  assert.doesNotMatch(fn, /HOUSES\.forEach|HOUSES\.reduce/);
  assert.match(fn, /class="h-pct">\$\{housePct\}%<\/b> תפוסה/);
});

test('behavior: the dashboard math excludes שדה אליעזר (capacity 77 → 73 minus 16, patients there not counted)', () => {
  const m = APP.match(/const HOUSES = \[([\s\S]*?)\];/)[1];
  const houses = new Function('return [' + m + ']')();
  const open = houses.filter((h) => !h.closed);
  assert.ok(!open.some((h) => h.id === 'sde'));
  assert.equal(open.reduce((s, h) => s + h.capacity, 0), houses.reduce((s, h) => s + h.capacity, 0) - 16);
  const ids = new Set(open.map((h) => h.id));
  const patients = [{ houseId: 'ramot', status: 'active' }, { houseId: 'sde', status: 'active' }, { houseId: 'asher', status: 'released' }];
  assert.equal(patients.filter((p) => p.status !== 'released' && ids.has(p.houseId)).length, 1);
});

test('«ועדות קרובות» is gone from the dashboard markup, JS and the controller move', () => {
  assert.doesNotMatch(INDEX, /id="upcoming-committees"|cmt-card/);
  assert.doesNotMatch(APP, /upcoming-committees|renderUpcomingCommittees|upcomingCommittees/);
});

test('service worker bumped monotonically (v88+, v17 never reused)', () => {
  const v = Number(read('public', 'sw.js').match(/var CACHE_VERSION = 'v(\d+)';/)[1]);
  assert.ok(v >= 88 && v !== 17);
});
