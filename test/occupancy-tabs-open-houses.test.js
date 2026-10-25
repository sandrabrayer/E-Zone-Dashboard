'use strict';

/* תפוסה tabs: occupancy % per house; a closed house (שדה אליעזר) has no tab
 * unless it holds patients (CHANGELOG-occupancy-tabs-open-houses.md). */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const APP = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

const label = new Function(APP.slice(APP.indexOf('function occupancyTabLabel'), APP.indexOf('function renderHouseTabs')) + '\nreturn occupancyTabLabel;')();

test('tab label carries N/capacity and the rounded %', () => {
  assert.equal(label({ name: 'קיסריה ריהאב', capacity: 13 }, 6), 'קיסריה ריהאב (6/13 · 46%)');
  assert.equal(label({ name: 'רמות השבים', capacity: 20 }, 18), 'רמות השבים (18/20 · 90%)');
  assert.equal(label({ name: 'רעננה אשר', capacity: 14 }, 0), 'רעננה אשר (0/14 · 0%)');
  assert.equal(label({ name: 'x', capacity: 0 }, 3), 'x (3/0 · 0%)', 'no division by zero');
});

test('renderHouseTabs skips a closed house with no patients and uses the label helper', () => {
  const fn = APP.slice(APP.indexOf('function renderHouseTabs'), APP.indexOf('function renderPatients'));
  assert.match(fn, /if \(h\.closed && inHouse === 0\) return;/);
  assert.match(fn, /occupancyTabLabel\(h, inHouse\)/);
});
