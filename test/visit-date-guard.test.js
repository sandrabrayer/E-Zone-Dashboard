/* Regression tests for CHANGELOG-visit-date-guard.md.
 *
 * Before #211, typing a visit date into a desktop date input saved every
 * intermediate year (11/10/0002 → 11/10/0020 → …). The guard:
 *   1. client — inline card field, lead ✏️ modal, board ✏️ modal and the entry
 *      modal never send a visitDate / entryDate outside [2024, this year + 2];
 *      the field turns amber quietly while typing;
 *   2. server — mergeLeads_ refuses a CHANGED out-of-range date (nothing
 *      written, Hebrew message); an UNCHANGED damaged date still lets the
 *      lead's other fields save;
 *   3. surface — damaged leads get an amber chip and are listed at the top of
 *      «לוח פגישות»; fixing the date clears them. */

process.env.TZ = 'Asia/Jerusalem';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { richSheet, loadGs } = require('./helpers/gs-sandbox');

const APP_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const arr = (x) => JSON.parse(JSON.stringify(x));
const TODAY = '2026-10-09';

function fakeClassList() {
  const set = new Set();
  return {
    add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c),
    toggle: (c, on) => { const want = on === undefined ? !set.has(c) : !!on; if (want) set.add(c); else set.delete(c); return want; },
  };
}
function fakeControl(name, value) {
  const attrs = {};
  const listeners = {};
  return {
    name, value, dataset: { field: name }, parentNode: null, classList: fakeClassList(), disabled: false,
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    setAttribute: (k, v) => { attrs[k] = String(v); },
    removeAttribute: (k) => { delete attrs[k]; },
    addEventListener: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); },
    fire(ev) { (listeners[ev] || []).forEach(fn => fn({ preventDefault() {}, target: this })); },
  };
}

/* The real app.js in a vm. saveAllProvingLead records the visitDate /
 * entryDate of every lead it was asked to save; showModal is captured so a
 * modal's onSubmit can be driven directly. */
function loadPage() {
  const noop = () => {};
  const board = {
    _html: '',
    set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; },
    querySelector() { return { set onclick(fn) {} }; },
    querySelectorAll() { return []; },
    classList: fakeClassList(),
  };
  const byId = { 'meetings-board': board };
  const sandbox = {
    console: { log: noop, warn: noop, info: noop, error: noop },
    location: { origin: 'http://test', href: 'http://test/', hash: '' },
    document: {
      addEventListener: noop,
      getElementById: (id) => byId[id] || null,
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    setTimeout: () => 0, clearTimeout: noop,
    URLSearchParams, Math, Date, JSON, Number, String, Array, Object, RegExp, Promise, Set, Map,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(APP_SRC + `
    renderDashboard = () => {}; renderCoordinatorDischarges = () => {}; renderKanban = () => {};
    renderPatientsTab = () => {}; renderIrrelevantLeads = () => {}; renderRemovedLeads = () => {};
    renderHouseTabs = () => {}; renderPatients = () => {}; renderDischargedPatients = () => {};
    renderBilling = () => {}; renderCreditsPayouts = () => {}; renderMonthlyRevenue = () => {};
    renderReconnect = () => {}; renderBreakeven = () => {}; renderGrowthGraph = () => {};
    renderBillingControl = () => {};
    autosaveMeetingWithDefaults = () => Promise.resolve();
    showError = (m) => { globalThis.__errors.push(m); };
    showModal = (cfg) => { globalThis.__modal = cfg; };
    saveAllProvingLead = (id) => {
      const l = state.leads.find(x => x.id === id);
      globalThis.__sent.push({ id, visitDate: l && l.visitDate, entryDate: l && l.entryDate });
      return Promise.resolve({ ok: true });
    };
    globalThis.__test = { state, updateLead, saveInlineLeadField, renderMeetings, normalizeLead,
      leadDateInRange, leadDateProblems, leadsWithBadDates, leadDateChipsHTML, badLeadDatesBannerHTML,
      openEditLeadModal, openMeetingEditModal };`, sandbox);
  sandbox.__errors = [];
  sandbox.__sent = [];
  const app = sandbox.__test;
  app.state.mode = 'edit';
  app.state.houseManagers = {};
  app.state.managerPhones = {};
  return { sandbox, app, board, byId };
}

function lead(over) {
  return Object.assign({ id: 'tomer', name: 'תומר', house: 'רעננה הפרדס', stage: 'visit',
    visitDate: '', visitTime: '14:00', meetingWith: 'חן' }, over || {});
}
const tick = async (n = 20) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

/* ===== range ===== */

test('leadDateInRange: [2024, this year + 2]; blank allowed; anything else refused', () => {
  const { app } = loadPage();
  assert.strictEqual(app.leadDateInRange('', TODAY), true);
  assert.strictEqual(app.leadDateInRange(null, TODAY), true);
  assert.strictEqual(app.leadDateInRange('2024-01-01', TODAY), true);
  assert.strictEqual(app.leadDateInRange('2026-10-11', TODAY), true);
  assert.strictEqual(app.leadDateInRange('2028-12-31', TODAY), true);
  assert.strictEqual(app.leadDateInRange('2029-01-01', TODAY), false);
  assert.strictEqual(app.leadDateInRange('2023-12-31', TODAY), false);
  assert.strictEqual(app.leadDateInRange('0002-10-11', TODAY), false);
  assert.strictEqual(app.leadDateInRange('0020-10-11', TODAY), false);
  assert.strictEqual(app.leadDateInRange('11/10/2026', TODAY), false);
});

/* ===== 1. client guard ===== */

test('inline card: typing 0002 → 0020 → 0202 → 2026 sends ONLY 2026; amber while out of range', async () => {
  const { sandbox, app } = loadPage();
  app.state.leads = [app.normalizeLead(lead())];
  const L = app.state.leads[0];
  const inp = fakeControl('visitDate', '');
  for (const v of ['0002-10-11', '0020-10-11', '0202-10-11']) {
    inp.value = v;
    assert.strictEqual(await app.saveInlineLeadField(inp, L), undefined, v + ' not sent');
    assert.strictEqual(inp.classList.contains('date-invalid'), true, v + ' amber');
    assert.strictEqual(inp.getAttribute('aria-invalid'), 'true');
  }
  assert.deepStrictEqual(sandbox.__sent, [], 'nothing reached the save');
  assert.strictEqual(L.visitDate, '', 'the lead never held an intermediate year');
  inp.value = '2026-10-11';
  assert.strictEqual(await app.saveInlineLeadField(inp, L), true);
  assert.deepStrictEqual(arr(sandbox.__sent).map(s => s.visitDate), ['2026-10-11']);
  assert.strictEqual(inp.classList.contains('date-invalid'), false, 'amber cleared');
  assert.strictEqual(sandbox.__errors.length, 0, 'no toast while typing');
});

test('lead ✏️ modal: an out-of-range visit date is refused before any save; the modal stays open', async () => {
  const { sandbox, app } = loadPage();
  app.state.leads = [app.normalizeLead(lead({ visitDate: '2026-10-11' }))];
  app.openEditLeadModal(app.state.leads[0]);
  const cfg = sandbox.__modal;
  const base = { name: 'תומר', phone: '', house: 'רעננה הפרדס', created: '', visitTime: '14:00', meetingWith: 'חן', note: '' };
  assert.strictEqual(await cfg.onSubmit(Object.assign({}, base, { visitDate: '0020-10-11' })), false);
  assert.deepStrictEqual(sandbox.__sent, []);
  assert.strictEqual(app.state.leads[0].visitDate, '2026-10-11', 'lead untouched');
  assert.strictEqual(sandbox.__errors.length, 1, 'one message on submit');
  // The field's onChange is the quiet amber state.
  const field = cfg.fields.find(f => f.name === 'visitDate');
  const ctl = fakeControl('visitDate', '0002-10-11');
  field.onChange('0002-10-11', { querySelector: () => ctl });
  assert.strictEqual(ctl.classList.contains('date-invalid'), true);
  assert.notStrictEqual(await cfg.onSubmit(Object.assign({}, base, { visitDate: '2026-10-12' })), false);
  assert.deepStrictEqual(arr(sandbox.__sent).map(s => s.visitDate), ['2026-10-12']);
});

test('board ✏️ modal: an out-of-range date never calls updateLead', async () => {
  const { sandbox, app, byId } = loadPage();
  app.state.leads = [app.normalizeLead(lead({ visitDate: '2026-10-11' }))];
  const ctl = { visitDate: fakeControl('visitDate', '0002-10-11'), visitTime: fakeControl('visitTime', '14:00'), meetingWith: fakeControl('meetingWith', 'חן') };
  const form = { querySelector: (sel) => { const m = /name="(\w+)"/.exec(sel); return m ? ctl[m[1]] : fakeControl('btn', ''); }, onsubmit: null };
  const back = { className: '', innerHTML: '', addEventListener() {}, remove() {},
    querySelector: (sel) => (sel === 'form' ? form : fakeControl('btn', '')) };
  byId['modal-root'] = { appendChild() {} };
  sandbox.document.createElement = () => back;
  app.openMeetingEditModal({ id: 'tomer', date: '2026-10-11', time: '14:00', meetingWith: 'חן', name: 'תומר' });
  form.onsubmit({ preventDefault() {} });
  await tick();
  assert.deepStrictEqual(sandbox.__sent, [], 'no save');
  assert.strictEqual(ctl.visitDate.classList.contains('date-invalid'), true);
  ctl.visitDate.value = '0020-10-11';
  ctl.visitDate.fire('change');
  assert.strictEqual(ctl.visitDate.classList.contains('date-invalid'), true, 'amber on change');
  assert.strictEqual(app.state.leads[0].visitDate, '2026-10-11');
});

/* ===== 2. server guard ===== */

function gsWorld(rows) {
  const g = loadGs({});
  g.sandbox.Session = { getScriptTimeZone: () => 'Asia/Jerusalem' };
  const cols = Array.from(g.run('LEAD_COLUMNS'));
  const sh = richSheet('Leads', cols);
  rows.forEach(r => sh.grid.push(cols.map(c => (r[c] === undefined ? '' : r[c]))));
  g.sandbox.__sheets[g.run('LEADS_SHEET')] = sh;
  const read = () => g.sheetRows(g.run('LEADS_SHEET'), 'LEAD_COLUMNS');
  const save = (leads) => arr(g.sandbox.saveAll_(leads, {}, 'ורד'));
  return { g, sh, cols, read, save };
}
const row = (over) => Object.assign({ id: 'L1', name: 'תומר', stage: 'visit', visitDate: '2026-10-11', visitTime: '14:00', created: '2026-10-01' }, over || {});

test('server: a CHANGED out-of-range visitDate is refused — Hebrew message, nothing written', () => {
  const w = gsWorld([row(), row({ id: 'L2', name: 'דנה', visitDate: '2026-10-07' })]);
  const before = JSON.stringify(w.read());
  const res = w.save([row({ visitDate: '0002-10-11', note: 'חדש' }), row({ id: 'L2', name: 'דנה', visitDate: '2026-10-07' })]);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'bad_lead_date');
  assert.match(res.message, /תאריך הביקור של תומר לא תקין \(0002-10-11\)/);
  assert.match(res.message, /2024/);
  assert.deepStrictEqual(res.badLeadDates.map(b => [b.id, b.field, b.value]), [['L1', 'visitDate', '0002-10-11']]);
  assert.strictEqual(JSON.stringify(w.read()), before, 'the sheet is untouched');
});

test('server: a changed out-of-range entryDate, and a NEW lead with a bad date, are refused', () => {
  const w = gsWorld([row()]);
  assert.strictEqual(w.save([row({ entryDate: '0020-01-05' })]).error, 'bad_lead_date');
  const res = w.save([row(), row({ id: 'NEW', name: 'חדש', visitDate: '2031-01-01' })]);
  assert.strictEqual(res.error, 'bad_lead_date');
  assert.strictEqual(w.read().length, 1, 'the new lead was not appended');
});

test('server: a lead whose stored bad date is UNCHANGED still saves its other fields', () => {
  const w = gsWorld([row({ visitDate: '0002-10-11' })]);
  const res = w.save([row({ visitDate: '0002-10-11', note: 'הערה חדשה' })]);
  assert.strictEqual(res.ok, true, JSON.stringify(res));
  const r = w.read()[0];
  assert.strictEqual(r.note, 'הערה חדשה');
  assert.strictEqual(r.visitDate, '0002-10-11', 'left as it was — read-only surfacing, no auto-repair');
});

test('server: fixing a stored bad date to an in-range one is accepted', () => {
  const w = gsWorld([row({ visitDate: '0002-10-11' })]);
  assert.strictEqual(w.save([row({ visitDate: '2026-10-11' })]).ok, true);
  assert.strictEqual(w.read()[0].visitDate, '2026-10-11');
});

/* ===== 3. surface damaged rows ===== */

test('damaged leads (any stage) get the amber chip and are listed at the top of the board', () => {
  const { app, board } = loadPage();
  app.state.leads = [
    app.normalizeLead(lead({ id: 'a', name: 'תומר', visitDate: '0002-10-11' })),
    app.normalizeLead(lead({ id: 'b', name: 'דנה', stage: 'paid', visitDate: '2026-10-07', entryDate: '0020-01-05' })),
    app.normalizeLead(lead({ id: 'c', name: 'יוסי', visitDate: '2026-10-08' })),
    app.normalizeLead(lead({ id: 'd', name: 'רון', stage: 'admitted', visitDate: '0026-09-01' })),
  ];
  assert.deepStrictEqual(app.leadsWithBadDates(app.state.leads, TODAY).map(l => l.id), ['a', 'b', 'd']);
  assert.match(app.leadDateChipsHTML(app.state.leads[0]), /class="lc-date-bad">תאריך ביקור לא תקין — יש לתקן</);
  assert.match(app.leadDateChipsHTML(app.state.leads[1]), /תאריך כניסה לא תקין — יש לתקן/);
  assert.strictEqual(app.leadDateChipsHTML(app.state.leads[2]), '');
  app.state.meetingsWeekStart = '2026-10-04';
  app.renderMeetings();
  assert.ok(board.innerHTML.includes('3 לידים עם תאריך ביקור לא תקין'));
  ['תומר', 'דנה', 'רון'].forEach(n => assert.ok(board.innerHTML.includes(`>${n}</button>`), n));
  assert.ok(board.innerHTML.includes('data-bad-date-lead="a"'));
  // Viewers see the names, not buttons.
  app.state.mode = 'view';
  assert.ok(!app.badLeadDatesBannerHTML(app.state.leads).includes('<button'));
});

test('no damaged lead → no banner', () => {
  const { app, board } = loadPage();
  app.state.leads = [app.normalizeLead(lead({ visitDate: '2026-10-11' }))];
  app.state.meetingsWeekStart = '2026-10-11';
  app.renderMeetings();
  assert.ok(!board.innerHTML.includes('mtg-bad-dates'));
  assert.strictEqual(app.badLeadDatesBannerHTML(app.state.leads), '');
});

test('fixing the date through the normal edit takes the lead off the list and the chip off its card', async () => {
  const { sandbox, app, board } = loadPage();
  app.state.leads = [
    app.normalizeLead(lead({ id: 'a', name: 'תומר', visitDate: '0002-10-11' })),
    app.normalizeLead(lead({ id: 'b', name: 'דנה', visitDate: '0020-10-07' })),
  ];
  app.state.meetingsWeekStart = '2026-10-11';
  app.renderMeetings();
  assert.ok(board.innerHTML.includes('2 לידים עם תאריך ביקור לא תקין'));
  // Through the lead ✏️ modal (what a click on the name opens).
  app.openEditLeadModal(app.state.leads[0]);
  const ok = await sandbox.__modal.onSubmit({ name: 'תומר', phone: '', house: 'רעננה הפרדס', created: '',
    visitDate: '2026-10-11', visitTime: '14:00', meetingWith: 'חן', note: '' });
  assert.notStrictEqual(ok, false);
  assert.ok(board.innerHTML.includes('1 לידים עם תאריך ביקור לא תקין'));
  assert.ok(!board.innerHTML.includes('>תומר</button>'));
  assert.strictEqual(app.leadDateChipsHTML(app.state.leads[0]), '');
  // Through the inline card field.
  const inp = fakeControl('visitDate', '2026-10-07');
  await app.saveInlineLeadField(inp, app.state.leads[1]);
  assert.ok(!board.innerHTML.includes('mtg-bad-dates'), 'list gone');
});

test('a lead with a damaged entry date can fix it in the ✏️ modal (field shown only when set)', async () => {
  const { sandbox, app } = loadPage();
  app.state.leads = [app.normalizeLead(lead({ id: 'b', stage: 'paid', visitDate: '2026-10-07', entryDate: '0020-01-05' }))];
  app.openEditLeadModal(app.state.leads[0]);
  assert.ok(sandbox.__modal.fields.some(f => f.name === 'entryDate'));
  const base = { name: 'תומר', phone: '', house: '', created: '', visitDate: '2026-10-07', visitTime: '', meetingWith: '', note: '' };
  assert.strictEqual(await sandbox.__modal.onSubmit(Object.assign({}, base, { entryDate: '0020-01-05' })), false, 'still bad → refused');
  assert.notStrictEqual(await sandbox.__modal.onSubmit(Object.assign({}, base, { entryDate: '2026-01-05' })), false);
  assert.strictEqual(app.state.leads[0].entryDate, '2026-01-05');
  assert.deepStrictEqual(arr(app.leadDateProblems(app.state.leads[0])), []);
  // A lead without an entry date gets no such field.
  app.state.leads.push(app.normalizeLead(lead({ id: 'n' })));
  app.openEditLeadModal(app.state.leads[1]);
  assert.ok(!sandbox.__modal.fields.some(f => f.name === 'entryDate'));
});
