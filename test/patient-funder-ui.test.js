/* Patient funder (גורם מממן) — UI (PR 2 of 2). See CHANGELOG-patient-funder-ui.md.
 *
 * Locked here:
 *   - a restricted session (Shiran, Yael — and an unknown session) renders
 *     ZERO funder DOM (no chip, no field, no fill screen, no strip) and never
 *     sends setPatientFunder; admission is allowed without a funder
 *   - a finance session: the chip (amber «לא הוגדר» when unset); admission is
 *     BLOCKED without a funder; with one, setPatientFunder follows the save
 *     with effectiveFrom = the entry date; a failed funder write keeps the
 *     patient and shows the error (the badge stays)
 *   - the fill screen: count, released / already-set excluded, default
 *     effectiveFrom = the entry date
 *   - the funder × house strip equals the existing aging totals (per figure,
 *     per house, with and without the house filter) over a REAL debtAging_
 *     report from Code.gs; the funder filter keeps exactly that funder's cycles
 *   - the edit modal's write rule, newest-first history, escaping
 *   - SW v30 with funder.js precached (network-first); never v17
 *
 * vm sandboxes on the real public/app.js, public/funder.js and Code.gs.
 * TZ pinned to Israel. All names are SYNTHETIC. */

process.env.TZ = 'Asia/Jerusalem';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const GS_SRC = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');
const SW_SRC = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');
const HTML_SRC = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const CSS_SRC = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
const Funder = require('../public/funder.js');
const plain = (v) => JSON.parse(JSON.stringify(v));
const TODAY = '2026-09-30';

/* ============================ app.js harness ============================ */

function fakeEl(id) {
  const el = {
    id: id || '', _html: '', textContent: '', value: '', hidden: false, children: [], style: {}, dataset: {},
    classList: {
      _c: new Set(['hidden']),
      add(c) { this._c.add(c); }, remove(c) { this._c.delete(c); },
      toggle(c, on) { if (on === undefined ? !this._c.has(c) : on) this._c.add(c); else this._c.delete(c); },
      contains(c) { return this._c.has(c); },
    },
    set innerHTML(v) { this._html = String(v); this.children = []; }, get innerHTML() { return this._html; },
    appendChild(c) { this.children.push(c); return c; },
    querySelector() { return fakeEl(); }, querySelectorAll() { return []; },
    addEventListener() {}, setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    remove() {}, closest() { return null; },
  };
  return el;
}

/* app.js in a vm with a stub DOM. `finance`: true | false | null. Every fetch
 * is recorded; `answer(body)` scripts the reply (default {ok:true}). */
function loadApp(opts) {
  const o = opts || {};
  const els = {};
  const calls = [];
  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/', hash: '', reload: noop },
    document: {
      addEventListener: noop,
      body: fakeEl('body'),
      getElementById: (id) => (els[id] || (els[id] = fakeEl(id))),
      createElement: () => fakeEl(),
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    setTimeout: (fn) => { return 0; }, clearTimeout: noop,
    URL, URLSearchParams, Math, Date, JSON, Number, String, Array, Object, RegExp, Promise, Set, Map, Intl,
    fetch: (url, init) => {
      const body = init && init.body ? JSON.parse(init.body) : null;
      calls.push({ url, body });
      const payload = o.answer ? o.answer(body) : { ok: true };
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) });
    },
  };
  if (o.funder !== false) sandbox.Funder = Funder;
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(APP_SRC + `
    globalThis.__errors = []; globalThis.__modal = null; globalThis.__saves = 0;
    showError = (m) => { globalThis.__errors.push(String(m)); };
    showToast = () => {};
    lockBusyDelay = () => Promise.resolve();
    renderAll = () => {};
    showModal = (m) => { globalThis.__modal = m; };
    saveAll = async () => { globalThis.__saves++; if (globalThis.__saveFails) throw new Error('boom'); return { ok: true }; };
    todayISO = () => '${TODAY}';
    globalThis.__test = {
      get state() { return state; },
      funderView, funderLib, patientFunderKey, funderChipHtml, funderHistoryFor, funderHistoryListHtml,
      funderEditShouldWrite, admissionFunderError, admissionFunderFields, editFunderFields,
      funderEffectiveFromEntry, funderFillRows, funderFillHtml, renderFunderFill, funderFilterMatch,
      filterDebtReportByFunder, debtFunderStrip, debtFunderStripHtml, debtAgingView, renderDebtAging,
      savePatientFunder, saveAdmissionFunder, renderPatients, openDirectAddPatientModal, openEntryModal,
      openEditPatientModal, billingRowFunderKey, applyView, normalizePatient,
      stubShowScreen(fn) { showScreen = fn; },
      modal: () => globalThis.__modal, errors: () => globalThis.__errors, saves: () => globalThis.__saves,
      setSaveFails(v) { globalThis.__saveFails = v; },
    };`, sandbox);
  const app = sandbox.__test;
  app.state.finance = o.finance === undefined ? true : o.finance;
  app.state.mode = 'edit';
  app.state.leads = []; app.state.patients = []; app.state.payments = [];
  app.state.funderHistory = o.history ? o.history.slice() : [];
  const sent = (action) => calls.filter((c) => c.body && c.body.action === action);
  return { app, els, calls, sent, sandbox };
}

const P1 = { id: 'id-p1', houseId: 'ramot', name: 'אבי בדיקה', date: '2026-07-10', pay: 30000, adv: 0, status: 'active' };
const P2 = { id: 'id-p2', houseId: 'rehab', name: 'גל בדיקה', date: '2026-08-05', pay: 20000, adv: 0, status: 'trial' };
const P3 = { id: 'id-p3', houseId: 'asher', name: 'רון בדיקה', date: '2026-06-01', pay: 15000, adv: 0, status: 'released', exitDate: '2026-08-31' };
const row = (patientId, funder, effectiveFrom, recordedAt, recordedBy) =>
  ({ id: 'fh-' + patientId + effectiveFrom + funder, patientId, funder, effectiveFrom, recordedAt: recordedAt || '2026-08-01T08:00:00.000Z', recordedBy: recordedBy || 'ורד' });

/* All the HTML a patients render produced. */
function patientsHtml(h) {
  h.app.state.currentHouseTab = 'ramot';
  h.app.state.showReleasedPatients = true;
  h.app.state.patientSearch = '';
  h.app.renderPatients();
  return h.els['patients-list'].children.map((c) => c.innerHTML).join('\n');
}

/* ============================ restricted: zero funder UI ============================ */

for (const finance of [false, null]) {
  test(`restricted (finance=${finance}): zero funder DOM — chip, modal fields, fill screen, strip — and never a setPatientFunder`, async () => {
    const h = loadApp({ finance, history: [row('id-p1', 'btl', '2026-07-01')] });
    h.app.state.patients = [h.app.normalizePatient(P1), h.app.normalizePatient(P2)];
    assert.strictEqual(h.app.funderView(), false);
    const html = patientsHtml(h);
    assert.ok(html.includes('אבי בדיקה'), 'the card still renders');
    assert.ok(!/funder|גורם מממן|לא הוגדר|ביטוח לאומי/.test(html), html);

    assert.deepStrictEqual(plain(h.app.admissionFunderFields()), []);
    assert.deepStrictEqual(plain(h.app.editFunderFields(h.app.state.patients[0])), []);
    h.app.renderFunderFill();
    assert.strictEqual(h.els['funder-fill'].innerHTML, '');
    assert.strictEqual(h.els['funder-fill'].classList.contains('hidden'), true);

    // the debt view: no strip, no funder filter applied
    h.app.state.debtAging = { status: 'ok', asOf: TODAY, house: 'all', statusFilter: 'all', data: realAging(TODAY), error: '', seq: 1 };
    h.app.state.billingFunder = 'btl';
    h.app.renderDebtAging();
    assert.ok(!/funder/.test(h.els['debt-aging'].innerHTML));

    // admission: no field, allowed, nothing funder-related sent
    h.app.openDirectAddPatientModal();
    const m = h.app.modal();
    assert.ok(!m.fields.some((f) => f.name === 'funder'));
    assert.strictEqual(await m.onSubmit({ name: 'חדש בדיקה', houseId: 'ramot', date: '2026-09-29', pay: '1000', status: 'active', notes: '' }), true);
    assert.strictEqual(h.app.saves(), 1);
    h.app.openEditPatientModal(h.app.state.patients[0]);
    assert.ok(!h.app.modal().fields.some((f) => /funder/.test(String(f.name)) || f.type === 'html'));
    assert.strictEqual(await h.app.modal().onSubmit({ name: 'אבי בדיקה', houseId: 'ramot', date: '2026-07-10', pay: '30000', status: 'active', notes: '', funder: 'mod', funderFrom: '2026-09-01' }), true);

    // a direct call refuses before any request
    await assert.rejects(h.app.savePatientFunder('id-p1', 'btl', '2026-09-01'));
    assert.strictEqual(h.sent('setPatientFunder').length, 0, 'never calls setPatientFunder');
  });
}

test('restricted: applyView(false) drops funderHistory from memory', () => {
  const h = loadApp({ finance: true, history: [row('id-p1', 'btl', '2026-07-01')] });
  h.app.stubShowScreen(() => {});
  h.app.applyView(false);
  assert.deepStrictEqual(plain(h.app.state.funderHistory), []);
  assert.strictEqual(h.app.funderView(), false);
});

test('finance view needs funder.js: a page without it shows no funder UI and blocks nothing', () => {
  const h = loadApp({ finance: true, funder: false });
  assert.strictEqual(h.app.funderView(), false);
  assert.deepStrictEqual(plain(h.app.admissionFunderFields()), []);
  assert.strictEqual(h.app.admissionFunderError(true, ''), '');
});

/* ============================ finance: chip + admission ============================ */

test('finance: the card shows the current funder chip; unset is the amber «לא הוגדר» badge', () => {
  const h = loadApp({ history: [row('id-p1', 'btl', '2026-07-01'), row('id-p1', 'mod', '2026-12-01')] });
  h.app.state.patients = [h.app.normalizePatient(P1), h.app.normalizePatient({ ...P2, houseId: 'ramot' })];
  const html = patientsHtml(h);
  assert.match(html, /<span class="funder-chip" data-funder="btl">ביטוח לאומי<\/span>/, 'future row ignored');
  assert.match(html, /<span class="funder-chip funder-unset" data-funder="unset">לא הוגדר<\/span>/);
  assert.match(html, /<div class="p-funder" data-finance>/);
  assert.match(CSS_SRC, /\.funder-chip\.funder-unset \{\s*background: rgba\(255,176,32,\.18\)/);
});

test('finance: a released patient\'s chip is read on the exit day', () => {
  const h = loadApp({ history: [row('id-p3', 'private', '2026-06-01'), row('id-p3', 'maccabi', '2026-09-15')] });
  assert.strictEqual(h.app.patientFunderKey(h.app.normalizePatient(P3), h.app.state.funderHistory, TODAY), 'private');
});

test('finance: admission is BLOCKED without a funder (direct add and admit-from-lead); restricted is not', async () => {
  const h = loadApp();
  h.app.openDirectAddPatientModal();
  const f = h.app.modal().fields.find((x) => x.name === 'funder');
  assert.ok(f && f.required === true && f.type === 'select');
  assert.deepStrictEqual(Array.from(f.options, (o) => o.value), ['', 'private', 'btl', 'mod', 'maccabi'], 'keys only — never a label as value');
  assert.strictEqual(await h.app.modal().onSubmit({ name: 'חדש', houseId: 'ramot', date: '2026-09-29', pay: '1000', status: 'active', notes: '', funder: '' }), false);
  assert.ok(h.app.errors().includes('יש לבחור גורם מממן'));
  assert.strictEqual(h.app.saves(), 0, 'nothing saved');
  for (const bad of ['פרטי', 'BTL', 'other']) {
    assert.strictEqual(await h.app.modal().onSubmit({ name: 'חדש', houseId: 'ramot', date: '2026-09-29', pay: '1000', status: 'active', notes: '', funder: bad }), false, bad);
  }

  const lead = { id: 'L1', name: 'ליד בדיקה', house: 'רמות השבים', stage: 'entry', advance: 0, entryDate: '2026-09-28' };
  h.app.state.leads = [lead];
  h.app.openEntryModal(lead);
  assert.ok(h.app.modal().fields.some((x) => x.name === 'funder' && x.required));
  assert.strictEqual(await h.app.modal().onSubmit({ houseId: 'ramot', date: '2026-09-28', pay: '1000', adv: '0', status: 'trial', funder: '' }), false);
  assert.strictEqual(h.app.saves(), 0);
  assert.strictEqual(h.sent('setPatientFunder').length, 0);

  assert.strictEqual(h.app.admissionFunderError(false, ''), '', 'restricted: allowed');
  assert.strictEqual(h.app.admissionFunderError(null, ''), '', 'unknown session: allowed');
  assert.strictEqual(h.app.admissionFunderError(true, 'btl'), '');
});

test('finance: admission with a funder → save, then setPatientFunder from the ENTRY date', async () => {
  const h = loadApp({ answer: (b) => (b.action === 'setPatientFunder'
    ? { ok: true, entry: Object.assign({ id: 'fh-x', recordedAt: '2026-09-30T09:00:00.000Z', recordedBy: 'ורד' }, b.funder) } : { ok: true }) });
  h.app.openDirectAddPatientModal();
  assert.strictEqual(await h.app.modal().onSubmit({ name: 'חדש בדיקה', houseId: 'ramot', date: '2026-07-15', pay: '1000', status: 'active', notes: '', funder: 'mod' }), true);
  assert.strictEqual(h.app.saves(), 1);
  const [call] = h.sent('setPatientFunder');
  const pid = h.app.state.patients[0].id;
  assert.deepStrictEqual(call.body.funder, { patientId: pid, funder: 'mod', effectiveFrom: '2026-07-15' });
  assert.strictEqual(h.app.patientFunderKey(h.app.state.patients[0], h.app.state.funderHistory, TODAY), 'mod');

  // admit-from-lead too
  const lead = { id: 'L2', name: 'ליד שני', house: 'רמות השבים', stage: 'entry', advance: 0, entryDate: '2026-09-28' };
  h.app.state.leads = [lead];
  h.app.openEntryModal(lead);
  assert.strictEqual(await h.app.modal().onSubmit({ houseId: 'ramot', date: '2026-09-28', pay: '1000', adv: '0', status: 'trial', funder: 'maccabi' }), true);
  assert.strictEqual(h.sent('setPatientFunder')[1].body.funder.effectiveFrom, '2026-09-28');
});

test('finance: the patient saves but the funder write fails → patient kept, error shown, badge stays unset', async () => {
  const h = loadApp({ answer: (b) => (b.action === 'setPatientFunder' ? { ok: false, error: 'unknown_patient' } : { ok: true }) });
  h.app.openDirectAddPatientModal();
  assert.strictEqual(await h.app.modal().onSubmit({ name: 'חדש בדיקה', houseId: 'ramot', date: '2026-09-01', pay: '1000', status: 'active', notes: '', funder: 'btl' }), true, 'the modal closes — the patient exists');
  assert.strictEqual(h.app.state.patients.length, 1);
  assert.ok(h.app.errors().some((e) => e.startsWith('שמירת גורם מממן נכשלה — ') && e.includes('המטופל עדיין לא נמצא בגיליון')), h.app.errors().join('|'));
  assert.deepStrictEqual(plain(h.app.state.funderHistory), [], 'the optimistic row was rolled back');
  assert.strictEqual(h.app.patientFunderKey(h.app.state.patients[0], h.app.state.funderHistory, TODAY), 'unset');
  h.app.renderFunderFill();
  assert.match(h.els['funder-fill'].innerHTML, /data-funder-fill-count>1</, 'it now waits on the fill screen');
});

test('finance: a patient save that fails never sends the funder', async () => {
  const h = loadApp();
  h.app.setSaveFails(true);
  h.app.openDirectAddPatientModal();
  assert.strictEqual(await h.app.modal().onSubmit({ name: 'חדש', houseId: 'ramot', date: '2026-09-01', pay: '1000', status: 'active', notes: '', funder: 'btl' }), false);
  assert.strictEqual(h.sent('setPatientFunder').length, 0);
});

test('effectiveFrom from the entry date: never more than one day ahead (the server refuses that)', () => {
  const h = loadApp();
  assert.strictEqual(h.app.funderEffectiveFromEntry('2026-07-01', TODAY), '2026-07-01');
  assert.strictEqual(h.app.funderEffectiveFromEntry('2026-10-01', TODAY), '2026-10-01', 'tomorrow is fine');
  assert.strictEqual(h.app.funderEffectiveFromEntry('2026-10-05', TODAY), TODAY, 'further ahead → today');
  assert.strictEqual(h.app.funderEffectiveFromEntry('', TODAY), TODAY);
});

/* ============================ edit modal ============================ */

test('edit modal (finance): current funder preselected, «החל מ» = today, history newest first, escaped', () => {
  const hist = [
    row('id-p1', 'private', '2026-07-01', '2026-07-01T08:00:00.000Z', 'ורד'),
    row('id-p1', 'btl', '2026-08-15', '2026-08-15T08:00:00.000Z', '<img src=x onerror=alert(1)>'),
    row('id-p1', 'mod', '2026-08-15', '2026-08-16T08:00:00.000Z', 'סנדרה'),   // same-day correction
    row('id-p2', 'maccabi', '2026-07-01'),
  ];
  const h = loadApp({ history: hist });
  const p = h.app.normalizePatient(P1);
  const fields = h.app.editFunderFields(p);
  const sel = fields.find((f) => f.name === 'funder');
  assert.strictEqual(sel.value, 'mod');
  assert.strictEqual(fields.find((f) => f.name === 'funderFrom').value, TODAY);
  assert.deepStrictEqual(h.app.funderHistoryFor(hist, 'id-p1').map((e) => e.funder), ['mod', 'btl', 'private']);
  const list = fields.find((f) => f.type === 'html').html;
  assert.ok(list.indexOf('משרד הביטחון') < list.indexOf('ביטוח לאומי') && list.indexOf('ביטוח לאומי') < list.indexOf('פרטי'));
  assert.ok(!list.includes('<img'), 'recordedBy is escaped');
  assert.ok(list.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(!list.includes('מכבי'), 'only this patient');
});

test('edit modal: writes only when the pick changes or names another day', async () => {
  const h = loadApp({ history: [row('id-p1', 'btl', '2026-07-01')] });
  assert.strictEqual(h.app.funderEditShouldWrite('btl', 'btl', TODAY, TODAY), false, 'untouched');
  assert.strictEqual(h.app.funderEditShouldWrite('btl', 'mod', TODAY, TODAY), true, 'switch');
  assert.strictEqual(h.app.funderEditShouldWrite('btl', 'btl', '2026-06-01', TODAY), true, 'correction from another day');
  assert.strictEqual(h.app.funderEditShouldWrite('unset', '', TODAY, TODAY), false, 'nothing picked');
  assert.strictEqual(h.app.funderEditShouldWrite('btl', 'ביטוח לאומי', TODAY, TODAY), false, 'a label is never a value');

  h.app.state.patients = [h.app.normalizePatient(P1)];
  h.app.openEditPatientModal(h.app.state.patients[0]);
  const base = { name: 'אבי בדיקה', houseId: 'ramot', date: '2026-07-10', pay: '30000', status: 'active', notes: '' };
  assert.strictEqual(await h.app.modal().onSubmit({ ...base, funder: 'btl', funderFrom: TODAY }), true);
  assert.strictEqual(h.sent('setPatientFunder').length, 0);
  h.app.openEditPatientModal(h.app.state.patients[0]);
  assert.strictEqual(await h.app.modal().onSubmit({ ...base, funder: 'maccabi', funderFrom: '2026-09-15' }), true);
  assert.deepStrictEqual(h.sent('setPatientFunder')[0].body.funder, { patientId: 'id-p1', funder: 'maccabi', effectiveFrom: '2026-09-15' });
});

/* ============================ fill screen ============================ */

test('fill screen: count, who is listed, default effectiveFrom = the entry date, hidden at 0', () => {
  const h = loadApp({ history: [row('id-p2', 'btl', '2026-08-05')] });
  const P4 = { id: 'id-p4', houseId: 'arfoni', name: '<b>שם</b>', date: '2026-09-01', pay: 1, adv: 0, status: 'wait' };
  const P6 = { id: 'id-p6', houseId: 'ramot', name: 'עתידי', date: '2026-10-09', pay: 1, adv: 0, status: 'trial' };
  h.app.state.patients = [P1, P2, P3, P4, P6].map((p) => h.app.normalizePatient(p));
  const rows = h.app.funderFillRows(h.app.state.patients, h.app.state.funderHistory, TODAY);
  assert.deepStrictEqual(rows.map((r) => r.patient.id), ['id-p4', 'id-p1', 'id-p6'],
    'unset + not released; HOUSES order (arfoni … ramot) then name (אבי < עתידי)');
  assert.strictEqual(rows.find((r) => r.patient.id === 'id-p1').defaultFrom, '2026-07-10', 'the entry date');
  assert.strictEqual(rows.find((r) => r.patient.id === 'id-p6').defaultFrom, TODAY, 'an entry > tomorrow → today');

  h.app.renderFunderFill();
  const html = h.els['funder-fill'].innerHTML;
  assert.match(html, /השלמת גורם מממן — <span class="count-pill" data-funder-fill-count>3<\/span> נותרו/);
  assert.match(html, /<input type="date" data-fill-from value="2026-07-10" \/>/);
  assert.ok(html.includes('&lt;b&gt;שם&lt;/b&gt;') && !html.includes('<b>שם</b>'), 'escaped');
  assert.ok(!/value="פרטי"/.test(html), 'option values are keys');
  assert.strictEqual(h.els['funder-fill'].classList.contains('hidden'), false);

  // all set → hidden, empty
  h.app.state.funderHistory = ['id-p1', 'id-p4', 'id-p6'].map((id) => row(id, 'private', '2026-01-01')).concat(h.app.state.funderHistory);
  h.app.renderFunderFill();
  assert.strictEqual(h.els['funder-fill'].innerHTML, '');
  assert.strictEqual(h.els['funder-fill'].classList.contains('hidden'), true);
});

test('fill screen: saving a row is optimistic — it disappears at once and comes back on failure', async () => {
  const h = loadApp({ answer: () => ({ ok: false, error: 'lock_busy' }) });
  h.app.state.patients = [h.app.normalizePatient(P1)];
  const p = h.app.savePatientFunder('id-p1', 'private', '2026-07-10');
  assert.strictEqual(h.app.funderFillRows(h.app.state.patients, h.app.state.funderHistory, TODAY).length, 0, 'gone while in flight');
  await assert.rejects(p);
  assert.strictEqual(h.sent('setPatientFunder').length, 2, 'lock_busy: one automatic retry');
  assert.strictEqual(h.app.funderFillRows(h.app.state.patients, h.app.state.funderHistory, TODAY).length, 1, 'back after the rollback');
  assert.ok(h.app.errors().some((e) => e.includes('המערכת עסוקה, נסו שוב')));
});

/* ============================ the strip + the filter over a REAL report ============================ */

function loadGs() {
  const ss = { getSheetByName: () => null, getSpreadsheetTimeZone: () => 'Asia/Jerusalem' };
  const formatDate = (d, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  const sandbox = {
    console: { log() {}, warn() {}, error() {}, info() {} }, JSON, Math, Date, Number, String, Array, Object, RegExp, isFinite, isNaN,
    SpreadsheetApp: { getActiveSpreadsheet: () => ss }, Utilities: { formatDate },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(GS_SRC, sandbox);
  return sandbox;
}
const GS = loadGs();
const AVI = 'ramot::אבי בדיקה::2026-07-10';
const GAL = 'rehab::גל בדיקה::2026-08-05';
const AGING_PATIENTS = [
  { id: 'id-p1', houseId: 'ramot', name: 'אבי בדיקה', date: '2026-07-10', pay: 30000, status: 'active' },
  { id: 'id-p2', houseId: 'rehab', name: 'גל בדיקה', date: '2026-08-05', pay: 20000, status: 'active' },
  { id: 'id-p7', houseId: 'arfoni', name: 'בת בדיקה', date: '2026-06-20', pay: 35000, status: 'active' },
  { id: 'id-p8', houseId: 'pardes', name: 'נועה בדיקה', date: '2026-07-15', pay: 28000, status: 'released', exitDate: '2026-08-20' },
  { id: 'id-p9', houseId: 'ramot', name: 'הדס בדיקה', date: '2026-07-01', pay: 30000, status: 'active' },
];
const pay = (pid, due, f) => Object.assign({ id: 'pay::' + pid + '::' + due, patientId: pid, patientName: pid.split('::')[1], houseId: pid.split('::')[0], dueDate: due }, f);
const AGING_PAYMENTS = [
  pay(AVI, '2026-07-10', { amount: 30000, status: 'paid', amountPaid: 30000, chargedAt: '2026-07-12T10:00:00+03:00' }),
  pay(AVI, '2026-09-10', { amount: 30000, status: 'unpaid', amountPaid: 0 }),
  pay(GAL, '2026-09-05', { amount: 20000, status: 'partial', amountPaid: 12000, chargedAt: '2026-09-06T09:00:00+03:00' }),
];
function realAging(asOf) {
  const rows = (l) => ({ rows: l.map((obj, i) => ({ rowNumber: i + 2, obj: Object.assign({}, obj) })) });
  return plain(GS.debtAging_(asOf, { patients: rows(AGING_PATIENTS), payments: rows(AGING_PAYMENTS), credits: rows([]), overrides: rows([]) }));
}
const HIST = [
  row('id-p1', 'private', '2026-07-01'), row('id-p1', 'btl', '2026-09-01'),   // switch mid-stay
  row('id-p7', 'maccabi', '2026-06-01'),
  row('id-p8', 'mod', '2026-08-01'),                                         // from mid-stay: earlier cycles unset
];
const FUNDERS = ['private', 'btl', 'mod', 'maccabi', 'unset'];
const KINDS = ['recorded_debt', 'unrecorded_cycles'];

test('strip: funder × house totals EQUAL the aging totals — per figure, per house, with and without filters', () => {
  const h = loadApp({ history: HIST });
  for (const asOf of ['2026-09-15', TODAY]) {
    const data = realAging(asOf);
    assert.ok(data.ok && data.totals.recorded_debt.total > 0 && data.totals.unrecorded_cycles.total > 0);
    for (const filters of [{ house: 'all', status: 'all' }, { house: 'ramot', status: 'all' }, { house: 'all', status: 'discharged' }]) {
      const strip = h.app.debtFunderStrip(data, HIST, filters);
      const view = h.app.debtAgingView(data, filters);
      for (const k of KINDS) {
        assert.strictEqual(strip[k].totals.total, view.tables[k].totals.total, `${asOf} ${JSON.stringify(filters)} ${k}`);
        for (const r of view.tables[k].rows) assert.strictEqual(strip[k].totals.byHouse[r.houseId], r.total, r.houseId);
        assert.deepStrictEqual(strip[k].rows.map((r) => r.funder), FUNDERS);
      }
      if (filters.house === 'all' && filters.status === 'all') {
        for (const k of KINDS) assert.strictEqual(strip[k].totals.total, data.totals[k].total, 'the report totals');
      }
    }
  }
});

test('strip HTML: two blocks (never one summed figure), «לא הוגדר» badge, finance-tagged, escaped', () => {
  const h = loadApp({ history: HIST });
  const html = h.app.debtFunderStripHtml(h.app.debtFunderStrip(realAging(TODAY), HIST, { house: 'all', status: 'all' }));
  assert.match(html, /^<div class="funder-strip" data-finance>/);
  assert.strictEqual((html.match(/class="funder-strip-block"/g) || []).length, 2);
  assert.ok(html.includes('data-block="recorded_debt"') && html.includes('data-block="unrecorded_cycles"'));
  assert.ok(html.includes('<span class="funder-chip funder-unset" data-funder="unset">לא הוגדר</span>'));
  assert.ok(!/<script|onerror/.test(html));
});

test('filter: keeps exactly the cycles of that funder; the five filtered views add up to the whole', () => {
  const h = loadApp({ history: HIST });
  const data = realAging(TODAY);
  const strip = h.app.debtFunderStrip(data, HIST, { house: 'all', status: 'all' });
  const all = h.app.debtAgingView(data, {});
  assert.strictEqual(h.app.filterDebtReportByFunder(data, HIST, 'all'), data, 'all → the report itself');
  const sum = { recorded_debt: 0, unrecorded_cycles: 0 };
  for (const f of FUNDERS) {
    const v = h.app.debtAgingView(h.app.filterDebtReportByFunder(data, HIST, f), {});
    for (const k of KINDS) {
      const stripRow = strip[k].rows.find((r) => r.funder === f);
      assert.strictEqual(v.tables[k].totals.total, stripRow.total, `${f} ${k} = its strip row`);
      sum[k] = Math.round((sum[k] + v.tables[k].totals.total) * 100) / 100;
    }
    for (const p of v.patients) assert.ok(p.cycles.length > 0, 'a patient with no matching cycle is dropped, not listed as zero');
  }
  for (const k of KINDS) assert.strictEqual(sum[k], all.tables[k].totals.total, k);
  // id-p1 switched on 01/09: the 10/09 cycle is btl, nothing of id-p1 under private at 30/09
  const btl = h.app.filterDebtReportByFunder(data, HIST, 'btl');
  assert.ok(btl.byPatient.some((p) => p.patientId === 'id-p1'));
  assert.ok(!h.app.filterDebtReportByFunder(data, HIST, 'private').byPatient.some((p) => p.patientId === 'id-p1' && p.cycles.some((c) => c.start >= '2026-09-01')));
});

test('filter on the billing lists: a row\'s funder is the patient\'s funder on that due date', () => {
  const h = loadApp({ history: HIST });
  const p = h.app.normalizePatient(P1);
  assert.strictEqual(h.app.billingRowFunderKey(p, '2026-08-10'), 'private');
  assert.strictEqual(h.app.billingRowFunderKey(p, '2026-09-10'), 'btl');
  assert.strictEqual(h.app.billingRowFunderKey({ name: 'בלי מזהה', houseId: 'ramot' }, '2026-09-10'), 'unset', 'a pseudo-patient row');
  assert.strictEqual(h.app.funderFilterMatch('all', 'btl'), true);
  assert.strictEqual(h.app.funderFilterMatch('btl', 'btl'), true);
  assert.strictEqual(h.app.funderFilterMatch('btl', 'mod'), false);
  assert.strictEqual(h.app.funderFilterMatch('unset', 'unset'), true);
  // wired into both lists and the debt view
  assert.match(APP_SRC, /funderFilterMatch\(funderFilter, billingRowFunderKey\(d\.patient, selected\)\)/);
  assert.match(APP_SRC, /funderFilterMatch\(funderFilter, billingRowFunderKey\(o\.patient, o\.pay\.dueDate\)\)/);
  assert.match(APP_SRC, /const shown = filterDebtReportByFunder\(s\.data, state\.funderHistory, billingFunderFilter\(\)\);/);
});

test('finance debt view renders the strip above the (funder-filtered) blocks', () => {
  const h = loadApp({ history: HIST });
  h.app.state.debtAging = { status: 'ok', asOf: TODAY, house: 'all', statusFilter: 'all', data: realAging(TODAY), error: '', seq: 1 };
  h.app.state.billingFunder = 'maccabi';
  h.app.renderDebtAging();
  const html = h.els['debt-aging'].innerHTML;
  assert.ok(html.indexOf('<div class="funder-strip" data-finance>') === 0, html.slice(0, 300));
  assert.ok(html.indexOf('debt-blocks') > html.indexOf('funder-strip'));
  assert.ok(html.includes('data-patient="id-p7"') && !html.includes('data-patient="id-p1"'), 'only maccabi cycles below');
});

/* ============================ wiring: index.html, sw.js, server.js, css ============================ */

test('wiring: funder.js loads before app.js; the filter and fill screen sit inside the finance-only גבייה screen', () => {
  const f = HTML_SRC.indexOf('<script src="funder.js?v=__BUILD__"></script>');
  assert.ok(f > 0 && f < HTML_SRC.indexOf('<script src="app.js?v=__BUILD__"></script>'));
  const billing = HTML_SRC.indexOf('<section id="screen-billing" class="screen hidden" data-finance>');
  const end = HTML_SRC.indexOf('</section>', billing);
  for (const id of ['id="billing-funder"', 'id="funder-fill"']) {
    const at = HTML_SRC.indexOf(id);
    assert.ok(at > billing && at < end, id + ' inside the data-finance screen');
  }
  assert.strictEqual((HTML_SRC.match(/ data-finance[ >]/g) || []).length, 10, 'no new tagged node in index.html');
});

test('SW: CACHE_VERSION v30 (from v29, never v17); funder.js precached and network-first', () => {
  assert.match(SW_SRC, /var CACHE_VERSION = 'v30';/);
  assert.ok(SW_SRC.includes('v29 → v30:'));
  const precache = /var PRECACHE_URLS = \[([\s\S]*?)\];/.exec(SW_SRC)[1];
  assert.ok(precache.includes("'/funder.js'"));
  const sandbox = { self: { addEventListener() {} }, module: { exports: {} }, URL, caches: {}, fetch() {} };
  vm.createContext(sandbox);
  vm.runInContext(SW_SRC, sandbox);
  assert.strictEqual(sandbox.module.exports.CACHE_VERSION, 'v30');
  assert.strictEqual(sandbox.module.exports.cacheStrategy('/funder.js?v=abc'), 'network-first');
  assert.strictEqual(sandbox.module.exports.cacheStrategy('/api/sheets'), 'network-only');
});

test('CSS: ≥ 44px controls and a 360px-wide wrap for the funder UI', () => {
  assert.match(CSS_SRC, /#billing-funder,\s*\.funder-fill select, \.funder-fill input\[type="date"\], \.funder-fill \.btn \{\s*min-height: 44px;/);
  assert.match(CSS_SRC, /@media \(max-width: 480px\) \{\s*\.billing-row\.funder-fill-row > div,\s*\.funder-fill-row \.funder-field \{ min-width: 100%; \}/);
});

test('every funder render goes through escapeHtml (no raw label or name interpolation)', () => {
  const block = APP_SRC.slice(APP_SRC.indexOf('/* ===== Patient funder (גורם מממן) — UI (PR 2) ====='), APP_SRC.indexOf('function initFunderControls()'));
  // every ${…} in a template is escaped, a pre-escaped option label, or a
  // known-safe helper / constant
  const raw = [...block.matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1].trim())
    .filter((e) => !/^esc\(|^escapeHtml\(|^funderChipHtml\(|^o\.label$|^opts$|^known \?|^table\(|^r\.funder === 'unset'|^FUNDER_FILTER_ALL$/.test(e));
  assert.deepStrictEqual(raw, []);
});
