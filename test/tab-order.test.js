'use strict';
/* Tab order — CHANGELOG-tab-order.md.
 *
 * The top tabs follow the business flow, in RTL reading order: a lead gets a
 * meeting; only after they decide to enter and pay does Vered admit them as a
 * patient. So: דשבורד, לידים, לוח פגישות, מטופלים, then the rest unchanged.
 * Badges, the default (active) tab and the SCREENS mirror stay as they were. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const APP = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const SW = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');

function navButtons() {
  const nav = HTML.match(/<nav class="tabs">([\s\S]*?)<\/nav>/);
  assert.ok(nav, '<nav class="tabs"> present');
  const out = [];
  const re = /<button([^>]*)\bdata-screen="([^"]+)"([^>]*)>([\s\S]*?)<\/button>/g;
  let m;
  while ((m = re.exec(nav[1])) !== null) {
    out.push({
      attrs: m[1] + m[3], screen: m[2], body: m[4],
      label: m[4].replace(/<(\w+)[^>]*>[\s\S]*?<\/\1>/g, '').trim(),
    });
  }
  return out;
}

test('the first eight top tabs read דשבורד, לידים, לוח פגישות, מטופלים, תפוסה, מטופלים משוחררים, גבייה, בקרת גבייה', () => {
  assert.deepStrictEqual(navButtons().slice(0, 8).map((b) => b.label), [
    'דשבורד', 'לידים', 'לוח פגישות', 'מטופלים',
    'תפוסה', 'מטופלים משוחררים', 'גבייה', 'בקרת גבייה',
  ]);
});

test('the tail after בקרת גבייה is unchanged', () => {
  assert.deepStrictEqual(navButtons().slice(8).map((b) => b.screen),
    ['revenue', 'reconnect', 'breakeven', 'growth', 'retention']);
});

test('SCREENS in app.js mirrors the nav exactly (swipe order and deep links follow the same order)', () => {
  const m = APP.match(/const SCREENS = (\[[^\]]*\]);/);
  assert.ok(m, 'SCREENS found');
  const screens = JSON.parse(m[1].replace(/'/g, '"'));
  assert.deepStrictEqual(screens, navButtons().map((b) => b.screen));
});

test('badges move with their tabs, unchanged', () => {
  const by = Object.fromEntries(navButtons().map((b) => [b.screen, b.body]));
  assert.match(by.leads, /<span id="leads-unadmitted-badge" class="tab-badge tab-badge-danger hidden"/);
  assert.match(by.meetings, /<span id="meetings-unseen-badge" class="tab-badge hidden">0<\/span>/);
  assert.match(by.patients, /<span id="patients-problems-badge" class="tab-badge tab-badge-danger hidden"/);
  assert.match(by['billing-control'], /<span id="bc-badge" class="tab-badge hidden">0<\/span>/);
});

test('the default tab is still דשבורד, and it is the only active one', () => {
  const active = navButtons().filter((b) => /class="tab active"/.test(b.attrs));
  assert.deepStrictEqual(active.map((b) => b.screen), ['dashboard']);
});

test('finance / billing-control markers stay on their tabs', () => {
  const by = Object.fromEntries(navButtons().map((b) => [b.screen, b.attrs]));
  for (const s of ['billing', 'revenue', 'reconnect', 'growth']) assert.match(by[s], /data-finance/, s);
  assert.match(by['billing-control'], /data-billing-control/);
  for (const s of ['dashboard', 'leads', 'meetings', 'patients']) assert.doesNotMatch(by[s], /data-finance|data-billing-control/, s);
});

test('SW CACHE_VERSION is v59 or later for this public/ change (v17 burned)', () => {
  const v = Number(/var CACHE_VERSION = 'v(\d+)';/.exec(SW)[1]);
  assert.ok(v >= 59, 'v' + v);
  assert.notStrictEqual(v, 17);
});
