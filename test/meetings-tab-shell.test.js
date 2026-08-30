/* Tests for the tab bar + router after adding the לוח פגישות (meetings) shell.
 *
 * Two sources define the tabs and must stay in lockstep:
 *   - public/index.html — the visible <nav class="tabs"> buttons (order + label)
 *   - public/app.js     — the SCREENS array the render router iterates, doing
 *                         getElementById('screen-' + id) for each id.
 * If they drift, a tab renders in the wrong place or the router throws on a
 * missing screen element. These tests lock:
 *   1. tab order: לידים → לוח פגישות → … → שימור לידים LAST
 *   2. the new `meetings` id is registered in the router (SCREENS) AND has a
 *      matching <section id="screen-meetings"> so the router can show it.
 *
 * app.js is a browser script (no module.exports); we read it and evaluate it in
 * a vm sandbox with the ambient globals stubbed, same pattern as
 * lead-assignedto.test.js. index.html is parsed from source with a regex — no
 * DOM needed. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const INDEX_HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

/* The canonical tab order after this change, enumerated explicitly. */
const EXPECTED_TAB_ORDER = [
  'dashboard', 'leads', 'meetings', 'occupancy',
  'discharged-patients', 'billing', 'breakeven', 'growth', 'retention',
];

/* Parse the <nav class="tabs"> block into an ordered [{ screen, label }]. */
function navTabs() {
  const nav = INDEX_HTML.match(/<nav class="tabs">([\s\S]*?)<\/nav>/);
  assert.ok(nav, 'index.html must contain a <nav class="tabs"> block');
  const tabs = [];
  /* A tab's body may carry nested elements (e.g. the meetings tab's unseen
   * report count badge <span>, PR 3) — capture the full body and strip any
   * nested element WITH its content, leaving just the tab's own label text. */
  const re = /<button[^>]*\bdata-screen="([^"]+)"[^>]*>([\s\S]*?)<\/button>/g;
  let m;
  while ((m = re.exec(nav[1])) !== null) {
    const label = m[2].replace(/<(\w+)[^>]*>[\s\S]*?<\/\1>/g, '').trim();
    tabs.push({ screen: m[1], label });
  }
  return tabs;
}

function loadScreens() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const epilogue = `
    globalThis.__test = { screens: () => SCREENS };
  `;
  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/' },
    document: { addEventListener: noop, getElementById: () => null },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    URLSearchParams,
    Math, Date, JSON, Number, String, Array, Object, RegExp, Promise,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + epilogue, sandbox);
  // JSON round-trip: values built in the vm carry the vm's Array prototype.
  return JSON.parse(JSON.stringify(sandbox.__test.screens()));
}

const TABS = navTabs();
const SCREENS = loadScreens();

test('nav tab order is dashboard → leads → meetings → … → retention', () => {
  assert.deepStrictEqual(TABS.map((t) => t.screen), EXPECTED_TAB_ORDER);
});

test('שימור לידים (retention) is the LAST tab', () => {
  assert.strictEqual(TABS[TABS.length - 1].screen, 'retention');
  assert.strictEqual(TABS[TABS.length - 1].label, 'שימור לידים');
});

test('לוח פגישות (meetings) sits directly after לידים (leads)', () => {
  const leadsIdx = TABS.findIndex((t) => t.screen === 'leads');
  assert.ok(leadsIdx !== -1, 'leads tab must exist');
  const next = TABS[leadsIdx + 1];
  assert.strictEqual(next.screen, 'meetings');
  assert.strictEqual(next.label, 'לוח פגישות');
});

test('the meetings tab id is registered in the router (SCREENS)', () => {
  assert.ok(SCREENS.includes('meetings'), "SCREENS must include 'meetings'");
});

test('router SCREENS mirrors the nav tab order exactly', () => {
  assert.deepStrictEqual(SCREENS, EXPECTED_TAB_ORDER);
});

test('retention is last in the router too', () => {
  assert.strictEqual(SCREENS[SCREENS.length - 1], 'retention');
});

test('every router screen id has a matching <section id="screen-<id>"> in index.html', () => {
  // The router calls getElementById('screen-' + id) for each id, so a missing
  // section would throw. This also proves screen-meetings actually exists.
  for (const id of SCREENS) {
    assert.ok(
      INDEX_HTML.includes(`id="screen-${id}"`),
      `index.html must contain <section id="screen-${id}">`
    );
  }
});
