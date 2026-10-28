/* Tests for the global search («🔍 חיפוש», CHANGELOG-global-patient-search.md):
 *   - searchPhoneDigits / parseGlobalQuery — phone formats and query parsing;
 *   - globalSearchResults — the pure matcher over patients, leads, closed leads
 *     and discharged rows (name tokens, phone via the linked lead, ranking,
 *     dedupe, limit/total);
 *   - openGlobalSearchResult — pre-fills the target tab's OWN filter, refuses a
 *     tab the session may not open (controller view), writes nothing;
 *   - renderGlobalSearchResults — text only (sheet data never reaches innerHTML);
 *   - markup / wiring / service-worker guards.
 *
 * Same vm-sandbox approach as discharged-search.test.js: app.js is a
 * browser-global script, so the source is read, an epilogue exposes the
 * functions, and it runs in a vm context with browser globals stubbed. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PUBLIC = path.join(__dirname, '..', 'public');
const APP_SRC = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
const HTML = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(PUBLIC, 'style.css'), 'utf8');
const SW = fs.readFileSync(path.join(PUBLIC, 'sw.js'), 'utf8');

/* A just-enough DOM element: every property the search code touches. */
class FakeEl {
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.children = [];
    this.dataset = {};
    this.attrs = {};
    this.className = '';
    this._text = '';
    this.value = '';
    this.checked = false;
  }
  appendChild(c) { this.children.push(c); return c; }
  setAttribute(k, v) { this.attrs[k] = v; }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); if (v === '') this.children = []; }
  querySelectorAll() { return []; }
}

function loadApp(domOver) {
  const epilogue = `
    globalThis.__test = {
      state, searchPhoneDigits, parseGlobalQuery, globalSearchResults,
      globalSearchPatientPhone, openGlobalSearchResult, renderGlobalSearchResults,
      patientsTabFilters, GLOBAL_SEARCH_LIMIT,
    };
  `;
  const noop = () => {};
  const els = {};
  const tabs = {};
  const dom = Object.assign({
    addEventListener: noop,
    getElementById: id => els[id] || null,
    querySelector: sel => {
      const m = /data-screen="([^"]+)"/.exec(sel);
      return m ? (tabs[m[1]] || null) : null;
    },
    createElement: tag => new FakeEl(tag),
  }, domOver || {});
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/' },
    document: dom,
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    setTimeout: noop, clearTimeout: noop,
    URLSearchParams, Math, Date, JSON, Number, String, Array, Object, RegExp, Promise, Set,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(APP_SRC + epilogue, sandbox);
  return { app: sandbox.__test, els, tabs };
}

const { app } = loadApp();

/* Results cross the vm boundary (foreign Array prototype): compare plain data. */
const plain = v => JSON.parse(JSON.stringify(v));
const search = (s, q, limit) => plain(app.globalSearchResults(s, q, limit));

const P = (over) => Object.assign({ id: 'p1', name: '', houseId: 'ramot', status: 'active', fromLead: '' }, over);
const L = (over) => Object.assign({ id: 'l1', name: '', phone: '', house: 'ramot', stage: 'new', contactPhone: '', billingPhone: '' }, over);
const D = (over) => Object.assign({ id: 'd1', name: '', phone: '', houseId: 'ramot', restored: '' }, over);
const S = (over) => Object.assign({ patients: [], leads: [], irrelevantLeads: [], dischargedPatients: [], removedLeads: [] }, over);

/* ===== phone digits + query parsing ===== */

test('searchPhoneDigits: every spelling of one number is one string', () => {
  const forms = ['050-200 1003', '0502001003', '502001003', '+972 50 200 1003', '00972502001003', '(050) 2001003'];
  forms.forEach(f => assert.strictEqual(app.searchPhoneDigits(f), '502001003', f));
  assert.strictEqual(app.searchPhoneDigits(null), '');
  assert.strictEqual(app.searchPhoneDigits(''), '');
});

test('parseGlobalQuery: empty, too short, name, phone', () => {
  assert.strictEqual(app.parseGlobalQuery(''), null);
  assert.strictEqual(app.parseGlobalQuery('   '), null);
  assert.strictEqual(app.parseGlobalQuery(null), null);
  assert.strictEqual(app.parseGlobalQuery('05'), null, 'under 3 digits is no query');
  assert.strictEqual(app.parseGlobalQuery('0'), null);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(app.parseGlobalQuery('דוד  כהן'))), { kind: 'name', tokens: ['דוד', 'כהן'] });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(app.parseGlobalQuery('050-200'))), { kind: 'phone', digits: '50200' });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(app.parseGlobalQuery('+972502'))), { kind: 'phone', digits: '502' });
  assert.strictEqual(app.parseGlobalQuery('972'), null, 'a bare country code is no number');
});

/* ===== name search ===== */

test('name search: every word must hit, in any order, ignoring case/spaces/invisibles', () => {
  const s = S({ patients: [P({ id: 'a', name: 'דוד  כהן' }), P({ id: 'b', name: 'דוד לוי' }), P({ id: 'c', name: 'משה‏ כהן' })] });
  const names = q => search(s, q).items.map(i => i.id).sort();
  assert.deepStrictEqual(names('דוד'), ['a', 'b']);
  assert.deepStrictEqual(names('כהן דוד'), ['a']);
  assert.deepStrictEqual(names('  כהן '), ['a', 'c']);
  assert.deepStrictEqual(names('לא קיים'), []);
});

test('name search spans patients, leads, closed leads and discharged rows', () => {
  const s = S({
    patients: [P({ id: 'p', name: 'יוסי' })],
    leads: [L({ id: 'l', name: 'יוסי כהן' })],
    irrelevantLeads: [L({ id: 'c', name: 'יוסי לוי' })],
    dischargedPatients: [D({ id: 'd', name: 'יוסי אברהם' })],
  });
  const r = search(s, 'יוסי');
  assert.deepStrictEqual(r.items.map(i => i.kind), ['patient', 'lead', 'discharged', 'closedLead']);
  assert.strictEqual(r.total, 4);
});

test('ranking: active patients, leads, released patients, discharged rows, closed leads', () => {
  const s = S({
    patients: [P({ id: 'rel', name: 'אבי', status: 'released' }), P({ id: 'act', name: 'אבי', status: 'active' })],
    leads: [L({ id: 'ld', name: 'אבי' })],
    dischargedPatients: [D({ id: 'dis', name: 'אבי', houseId: 'asher' })],
    irrelevantLeads: [L({ id: 'cl', name: 'אבי' })],
  });
  assert.deepStrictEqual(search(s, 'אבי').items.map(i => i.id), ['act', 'ld', 'rel', 'dis', 'cl']);
});

test('limit cuts the list, total keeps the full count', () => {
  const patients = [];
  for (let i = 0; i < 30; i++) patients.push(P({ id: 'p' + i, name: 'מטופל ' + i }));
  const r = search(S({ patients }), 'מטופל', 5);
  assert.strictEqual(r.items.length, 5);
  assert.strictEqual(r.total, 30);
  assert.strictEqual(search(S({ patients }), 'מטופל').items.length, app.GLOBAL_SEARCH_LIMIT);
});

test('a lead in the irrelevant stage is not a board lead; removed leads are never searched', () => {
  const s = S({
    leads: [L({ id: 'x', name: 'רותי', stage: 'irrelevant' })],
    removedLeads: [L({ id: 'y', name: 'רותי' })],
  });
  assert.strictEqual(search(s, 'רותי').total, 0);
});

test('a restored or soft-deleted discharge row is not a live record', () => {
  const s = S({
    dischargedPatients: [D({ id: 'a', name: 'נועה', restored: 'TRUE' }), D({ id: 'b', name: 'נועה', deletedAt: '2026-10-01' }), D({ id: 'c', name: 'נועה' })],
  });
  assert.deepStrictEqual(search(s, 'נועה').items.map(i => i.id), ['c']);
});

test('a discharged row already shown as the released patient is not repeated', () => {
  const s = S({
    patients: [P({ id: 'p', name: 'דנה  כהן', status: 'released', houseId: 'ramot' })],
    dischargedPatients: [D({ id: 'd1', name: 'דנה כהן', houseId: 'ramot' }), D({ id: 'd2', name: 'דנה כהן', houseId: 'asher' })],
  });
  assert.deepStrictEqual(search(s, 'דנה').items.map(i => i.id), ['p', 'd2'],
    'same house+name collapses; another house is another person');
});

test('the lead a listed patient was admitted from is not repeated; an unlisted patient keeps its lead', () => {
  const base = {
    patients: [P({ id: 'p', name: 'דוד כהן', fromLead: 'l1' })],
    leads: [L({ id: 'l1', name: 'דוד כהן', phone: '0502001003', stage: 'paid' }), L({ id: 'l2', name: 'דוד לוי', phone: '0501112222' })],
  };
  assert.deepStrictEqual(search(S(base), 'דוד כהן').items.map(i => i.kind + ':' + i.id), ['patient:p']);
  assert.deepStrictEqual(search(S(base), '502001003').items.map(i => i.kind + ':' + i.id), ['patient:p'], 'same on a phone search');
  assert.deepStrictEqual(search(S(base), 'דוד').items.map(i => i.kind + ':' + i.id).sort(), ['lead:l2', 'patient:p']);
  // The patient was renamed after admission: only the old-name lead matches → it must still be found.
  const renamed = { patients: [P({ id: 'p', name: 'יוסף אברהם', fromLead: 'l1' })], leads: base.leads };
  assert.deepStrictEqual(search(S(renamed), 'דוד כהן').items.map(i => i.kind + ':' + i.id), ['lead:l1']);
});

/* ===== phone search ===== */

test('phone search finds a lead by any format and by the referrer phone', () => {
  const s = S({ leads: [
    L({ id: 'a', name: 'א', phone: '050-2001003' }),
    L({ id: 'b', name: 'ב', phone: '0521112222', contactPhone: '+972 54 333 4444' }),
  ] });
  const ids = q => search(s, q).items.map(i => i.id);
  assert.deepStrictEqual(ids('0502001003'), ['a']);
  assert.deepStrictEqual(ids('502001'), ['a']);
  assert.deepStrictEqual(ids('+972502001003'), ['a']);
  assert.deepStrictEqual(ids('054 333'), ['b'], 'referrer phone hits the lead');
  assert.deepStrictEqual(ids('0541'), [], 'no match');
  const hit = search(s, '054 333').items[0];
  assert.strictEqual(hit.phone, '+972 54 333 4444', 'the phone that matched is the one shown');
});

test('a patient has no phone: a phone search reaches it through its linked lead', () => {
  const s = S({
    patients: [P({ id: 'p', name: 'שרה', fromLead: 'l9' }), P({ id: 'q', name: 'דבורה', fromLead: '' })],
    leads: [L({ id: 'l9', name: 'שרה', phone: '0503334444' })],
  });
  const kinds = search(s, '503334444').items.map(i => i.kind + ':' + i.id).sort();
  assert.deepStrictEqual(kinds, ['patient:p'], 'the patient IS its admitted lead — one result');
  assert.deepStrictEqual(search(s, 'דבורה').items.map(i => i.id), ['q']);
});

test('a patient result on a NAME search shows the linked lead phone', () => {
  const s = S({
    patients: [P({ id: 'p', name: 'שרה', fromLead: 'l9' })],
    leads: [L({ id: 'l9', name: 'שרה', phone: '0503334444' })],
  });
  const item = search(s, 'שרה').items.find(i => i.kind === 'patient');
  assert.strictEqual(item.phone, '');
  assert.strictEqual(app.globalSearchPatientPhone(item, s), '0503334444');
});

test('phone search finds a discharged row by its own phone', () => {
  const s = S({ dischargedPatients: [D({ id: 'd', name: 'גיא', phone: '052-7776666' })] });
  assert.deepStrictEqual(search(s, '5277766').items.map(i => i.id), ['d']);
});

test('a query under 3 digits or empty returns nothing (and says why via parsed:null)', () => {
  const s = S({ leads: [L({ id: 'a', name: 'א', phone: '0501234567' })] });
  assert.strictEqual(search(s, '05').parsed, null);
  assert.strictEqual(search(s, '').total, 0);
});

test('house label is the Hebrew house name', () => {
  const s = S({ leads: [L({ id: 'a', name: 'א', house: 'ramot' })], patients: [P({ id: 'p', name: 'א', houseId: 'asher' })] });
  const labels = search(s, 'א').items.map(i => i.houseLabel).sort();
  assert.deepStrictEqual(labels, ['רמות השבים', 'רעננה אשר'].sort());
});

/* ===== opening a result ===== */

function openFixture(stateOver) {
  const env = loadApp();
  ['plist-search', 'plist-house', 'plist-status', 'plist-problems', 'lead-search', 'retention-search', 'discharged-search']
    .forEach(id => { env.els[id] = new FakeEl('input'); });
  ['patients', 'leads', 'retention', 'discharged-patients'].forEach(s => {
    const t = new FakeEl('button');
    t.clicks = 0;
    t.onclick = () => { t.clicks++; };
    env.tabs[s] = t;
  });
  env.els['screen-patients'] = new FakeEl('section');
  Object.assign(env.app.state, { finance: true, view: 'full', billingRead: false, readonly: false }, stateOver || {});
  return env;
}

test('opening a patient pre-fills the patients tab filters and clicks its tab', () => {
  const env = openFixture();
  env.app.patientsTabFilters().status = 'active';
  env.app.patientsTabFilters().house = 'asher';
  const ok = env.app.openGlobalSearchResult({ kind: 'patient', id: 'p1', name: 'דוד כהן' });
  assert.strictEqual(ok, true);
  const f = env.app.patientsTabFilters();
  assert.strictEqual(f.q, 'דוד כהן');
  assert.strictEqual(f.house, '', 'a stale house filter would hide the person');
  assert.strictEqual(f.status, 'all', 'a released patient must show too');
  assert.strictEqual(f.problemsOnly, false);
  assert.strictEqual(env.els['plist-search'].value, 'דוד כהן');
  assert.strictEqual(env.els['plist-status'].value, 'all');
  assert.strictEqual(env.tabs.patients.clicks, 1);
});

test('opening a lead / closed lead / discharged row fills that tab\'s own search', () => {
  const env = openFixture();
  assert.strictEqual(env.app.openGlobalSearchResult({ kind: 'lead', id: 'l', name: 'Dana Levi' }), true);
  assert.strictEqual(env.app.state.leadSearch, 'dana levi');
  assert.strictEqual(env.els['lead-search'].value, 'Dana Levi');
  assert.strictEqual(env.tabs.leads.clicks, 1);

  assert.strictEqual(env.app.openGlobalSearchResult({ kind: 'closedLead', id: 'c', name: 'רותי' }), true);
  assert.strictEqual(env.app.state.retentionSearch, 'רותי');
  assert.strictEqual(env.tabs.retention.clicks, 1);

  assert.strictEqual(env.app.openGlobalSearchResult({ kind: 'discharged', id: 'd', name: 'גיא' }), true);
  assert.strictEqual(env.app.state.dischargedSearch, 'גיא');
  assert.strictEqual(env.tabs['discharged-patients'].clicks, 1);
});

test('the controller view cannot be navigated: nothing changes', () => {
  const env = openFixture({ view: 'controller', finance: false });
  const before = JSON.stringify([env.app.state.leadSearch, env.app.state.retentionSearch]);
  assert.strictEqual(env.app.openGlobalSearchResult({ kind: 'lead', id: 'l', name: 'דנה' }), false);
  assert.strictEqual(env.app.openGlobalSearchResult({ kind: 'patient', id: 'p', name: 'דנה' }), false);
  assert.strictEqual(env.tabs.leads.clicks + env.tabs.patients.clicks, 0);
  assert.strictEqual(JSON.stringify([env.app.state.leadSearch, env.app.state.retentionSearch]), before);
});

test('a restricted session (no finance) may open every searchable tab', () => {
  const env = openFixture({ finance: false, view: 'restricted' });
  ['patient', 'lead', 'closedLead', 'discharged'].forEach(kind =>
    assert.strictEqual(env.app.openGlobalSearchResult({ kind, id: 'x', name: 'דנה' }), true, kind));
});

test('an unknown kind does nothing', () => {
  const env = openFixture();
  assert.strictEqual(env.app.openGlobalSearchResult({ kind: 'payment', id: 'x', name: 'דנה' }), false);
  assert.strictEqual(env.app.openGlobalSearchResult(null), false);
});

/* ===== rendering is text only ===== */

test('renderGlobalSearchResults writes names and phones as text, never markup', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const list = new FakeEl('div');
  const res = {
    parsed: { kind: 'name', tokens: ['x'] }, total: 1,
    items: [{ kind: 'lead', id: 'l', name: evil, phone: evil, houseLabel: evil, tag: 'ליד · חדש' }],
  };
  let picked = null;
  app.renderGlobalSearchResults(list, 'x', res, it => { picked = it; }, 0);
  assert.strictEqual(list.children.length, 1);
  const btn = list.children[0];
  assert.strictEqual(btn.children[0].textContent, evil, 'name is a text node');
  assert.strictEqual(btn.children[2].textContent, evil);
  assert.strictEqual(btn.children[3].textContent, evil);
  assert.ok(/\bactive\b/.test(btn.className));
  btn.onclick();
  assert.strictEqual(picked, res.items[0]);
});

test('hints: empty query, too-short digits, no results, more than shown', () => {
  const text = res => { const l = new FakeEl('div'); app.renderGlobalSearchResults(l, res.q, res.r, () => {}, -1); return l.children.map(c => c.textContent); };
  assert.deepStrictEqual(text({ q: '', r: { parsed: null, items: [], total: 0 } }), ['הקלידו שם או מספר טלפון']);
  assert.match(text({ q: '05', r: { parsed: null, items: [], total: 0 } })[0], /3 ספרות/);
  assert.deepStrictEqual(text({ q: 'אבג', r: { parsed: { kind: 'name', tokens: ['אבג'] }, items: [], total: 0 } }), ['לא נמצאו תוצאות']);
  const items = [{ kind: 'lead', id: '1', name: 'א', phone: '', houseLabel: '', tag: 't' }];
  const more = text({ q: 'א', r: { parsed: { kind: 'name', tokens: ['א'] }, items, total: 40 } });
  assert.strictEqual(more.length, 2);
  assert.match(more[1], /1 מתוך 40/);
});

/* ===== markup, wiring, security, service worker ===== */

function searchSection() {
  const a = APP_SRC.indexOf('GLOBAL SEARCH (חיפוש כללי)');
  const b = APP_SRC.indexOf('/* ===== Render router ===== */');
  assert.ok(a > 0 && b > a, 'global search section found');
  return APP_SRC.slice(a, b);
}

test('security: the search section never uses innerHTML / insertAdjacentHTML / eval', () => {
  // Comments may NAME innerHTML (to say it is never used); only code counts.
  const code = searchSection().replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML|document\.write|eval\(|new Function/.test(code));
});

test('read-only: the search section sends no request and writes no storage', () => {
  const code = searchSection().replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/fetch\(|XMLHttpRequest|sendBeacon|localStorage|sessionStorage|saveAll|api\(/.test(code));
});

test('markup: a floating button, NOT a top-bar item; the panel is a sibling AFTER the header', () => {
  const header = /<header class="topbar">[\s\S]*?<\/header>/.exec(HTML);
  assert.ok(header, 'header found');
  assert.ok(!/global-search/.test(header[0]), 'nothing of the search lives in the (full) top bar');
  assert.ok(HTML.indexOf('id="global-search-panel"') > HTML.indexOf('</header>'));
  assert.match(HTML, /<button id="global-search-open" class="gs-fab" type="button"[^>]*aria-label="[^"]+"/);
  assert.match(HTML, /<input id="global-search-input" type="search"/);
  assert.match(HTML, /id="global-search-results"/);
  assert.match(HTML, /id="global-search-panel" class="gs-panel hidden"/, 'closed on first paint');
});

test('the floating button sits under the sticky top bar and every modal, and is not printed', () => {
  const fab = /\.gs-fab \{([^}]*)\}/.exec(CSS)[1];
  assert.match(fab, /position: fixed/);
  const z = Number(/z-index: (\d+)/.exec(fab)[1]);
  assert.ok(z < 50, 'below the sticky top bar (z-index 50), got ' + z);
  assert.match(fab, /min-width: 48px; height: 48px/);
  assert.match(CSS, /@media print \{ \.gs-fab, \.gs-panel \{ display: none !important; \} \}/);
});

test('the "/" shortcut does not rely on offsetParent (always null for a fixed button)', () => {
  const code = searchSection();
  assert.ok(!/offsetParent/.test(code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')));
  assert.match(code, /getClientRects\(\)\.length === 0/);
});

test('the search button is not a tab (the tab-order guard parses <nav class="tabs">)', () => {
  const nav = /<nav class="tabs">([\s\S]*?)<\/nav>/.exec(HTML)[1];
  assert.ok(!/global-search/.test(nav));
});

test('wiring: initGlobalSearch runs right after initTabs', () => {
  assert.match(APP_SRC, /initTabs\(\);\s*initGlobalSearch\(\);/);
});

test('the controller view removes the control (not just hides it)', () => {
  const fn = /function applyControllerView\(\) \{[\s\S]*?\n\}\n/.exec(APP_SRC);
  assert.ok(fn, 'applyControllerView found');
  assert.match(fn[0], /\['global-search-open', 'global-search-panel'\]\.forEach/);
  assert.match(fn[0], /el\.remove\(\)/);
});

test('mobile: 16px input (no iOS zoom), 44px rows, panel sits under the wrapped top bar', () => {
  assert.match(CSS, /\.gs-panel input\[type="search"\][^}]*font-size: 16px/);
  assert.match(CSS, /\.gs-item \{[^}]*min-height: 44px/);
  assert.match(APP_SRC, /getBoundingClientRect\(\)\.bottom/);
  assert.match(CSS, /\.gs-panel \{[^}]*width: min\(560px, calc\(100vw - 24px\)\)/);
});

test('service worker: v63 or later, bump comment present, v17 never reused', () => {
  const v = Number(/var CACHE_VERSION = 'v(\d+)';/.exec(SW)[1]);
  assert.ok(v >= 63, 'v' + v);
  assert.notStrictEqual(v, 17);
  assert.match(SW, /v62 → v63: global patient\/lead search/);
  assert.strictEqual((SW.match(/var CACHE_VERSION =/g) || []).length, 1);
});
