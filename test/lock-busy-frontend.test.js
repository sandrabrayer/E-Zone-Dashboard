/* A busy Apps Script lock ({ok:false, error:'lock_busy'}) on the dashboard's
 * write paths (public/app.js). See CHANGELOG-proxy-secret-transition.md →
 * "Frontend: busy lock".
 *
 * Code.gs answers lock_busy BEFORE it writes anything, so apiPost:
 *   - waits 2 s and re-sends the IDENTICAL body ONCE;
 *   - if the lock is still busy, throws «המערכת עסוקה, נסו שוב» (never the
 *     server's English text), flagged lockBusy:true.
 * For EVERY write path, two tests:
 *   busy → ok   : retried once after 2000 ms, the change lands, no error;
 *   busy → busy : exactly two sends, the Hebrew message is shown (never a
 *                 silent drop or revert).
 *
 * vm sandbox on the REAL shipped app.js, per the repo convention (see
 * discharge-persistence-fix.test.js). renderers / banners / modals are
 * top-level declarations, stubbed in the epilogue; lockBusyDelay is stubbed
 * to resolve at once while recording the requested delay. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const HE = 'המערכת עסוקה, נסו שוב';
const BUSY = { ok: false, error: 'lock_busy', message: 'could not acquire the script lock — try again.' };

function fakeEl() {
  return {
    className: '', dataset: {}, style: {}, _html: '', children: [], textContent: '',
    set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; },
    appendChild(c) { this.children.push(c); }, addEventListener() {}, remove() {},
    set onclick(_f) {}, set onchange(_f) {}, set onsubmit(_f) {},
    querySelector() { return fakeEl(); }, querySelectorAll() { return []; },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  };
}

/* `script` maps an action to the responses it returns IN ORDER (the last one
 * repeats); unlisted actions answer {ok:true}. */
function loadApp(script) {
  const calls = [];
  const used = {};
  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/' },
    document: { getElementById: () => fakeEl(), createElement: () => fakeEl(), querySelectorAll: () => [], addEventListener() {}, body: fakeEl() },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    URL, URLSearchParams, Math, Date, JSON, Number, String, Array, Object, RegExp, Promise, Set, Map,
    confirm: () => true,
    fetch: (url, opts) => {
      const raw = opts && opts.body;
      const body = raw ? JSON.parse(raw) : null;
      calls.push({ raw, body });
      const action = body && body.action;
      const list = (script && script[action]) || [{ ok: true }];
      const i = used[action] = (used[action] || 0) + 1;
      const payload = typeof list[Math.min(i, list.length) - 1] === 'function'
        ? list[Math.min(i, list.length) - 1](body)
        : list[Math.min(i, list.length) - 1];
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) });
    },
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  const epilogue = `
    globalThis.__errors = []; globalThis.__delays = []; globalThis.__toasts = [];
    lockBusyDelay = (ms) => { globalThis.__delays.push(ms); return Promise.resolve(); };
    showError = (m) => { globalThis.__errors.push(String(m)); };
    showToast = (m) => { globalThis.__toasts.push(String(m)); };
    renderAll = () => {}; renderBilling = () => {}; renderBillingMonthlySummary = () => {};
    renderMeetings = () => {}; renderMeetingsUnseenBadge = () => {}; setSaving = () => {};
    reloadCredits = () => Promise.resolve();
    showCloseLeadModal = (o) => { globalThis.__onConfirm = o.onConfirm; };
    showConfirm = (o) => { globalThis.__onConfirm = o.onConfirm; };
    globalThis.__test = {
      state,
      LOCK_BUSY_MESSAGE_HE, LOCK_BUSY_RETRY_MS,
      apiPost: (b) => apiPost(b),
      isLockBusyError: (e) => isLockBusyError(e),
      normalizePatient: (p) => normalizePatient(p),
      updateLead: (id, f) => updateLead(id, f),
      savePayment: (p) => savePayment(p),
      saveCredit: (c) => saveCredit(c),
      dischargePatient: (p) => dischargePatient(p),
      doRestorePatientAsNewLead: (p) => doRestorePatientAsNewLead(p),
      doRestorePatientToActive: (p) => doRestorePatientToActive(p),
      restoreIrrelevantLead: (l) => restoreIrrelevantLead(l),
      deletePatient: (p) => deletePatient(p),
      deleteMeetingReport: (id) => deleteMeetingReport(id),
      removeLead: (l) => removeLead(l),
      closeLead: (l) => closeLead(l),
      saveBillingOverride: (p, a) => saveBillingOverride(p, a),
      clearBillingOverride: (p) => clearBillingOverride(p),
      billingOverrideId: (p, m) => billingOverrideId(p, m),
      autosaveMeetingWithDefaults: () => autosaveMeetingWithDefaults(),
      confirm: (v) => globalThis.__onConfirm(v),
      errors: () => globalThis.__errors,
      delays: () => globalThis.__delays,
    };`;
  vm.createContext(sandbox);
  vm.runInContext(SRC + epilogue, sandbox);
  const app = sandbox.__test;
  app.state.mode = 'edit';
  app.state.leads = []; app.state.patients = []; app.state.payments = [];
  app.state.credits = []; app.state.dischargedPatients = []; app.state.irrelevantLeads = [];
  app.state.removedLeads = []; app.state.billingOverrides = [];
  const sent = (action) => calls.filter(c => c.body && c.body.action === action);
  return { app, calls, sent };
}

const LEAD = { id: 'L1', name: 'דני', phone: '0501234567', house: 'קיסריה עפרוני', stage: 'new', note: '', visitDate: '', visitTime: '', created: '2026-09-01' };
const PATIENT = { id: 'pt-1', houseId: 'ramot', name: 'דנה', date: '2026-07-01', pay: 9000, adv: 1000, status: 'active', fromLead: '', exitDate: '', source: 'direct', notes: '' };
const AUDIT = { id: 'aud-1', houseId: 'ramot', name: 'דנה', date: '2026-07-01', status: 'released', fromLead: '', exitDate: '2026-08-10', dischargedAt: '2026-08-10T09:00:00.000Z', disposition: 'completed', discharge_note: '', restored: '', prior_status: 'active' };
const PAYMENT_ROW = { id: 'pay-1', patientId: 'pt-1', patientKey: 'ramot|דנה|2026-07-01', houseId: 'ramot', name: 'דנה', dueDate: '2026-09-01', amount: 9000, status: 'paid', paidDate: '2026-09-02', method: 'transfer' };

/* Every write path: how to set it up, run it, and what "it landed" means.
 * `action` is the write whose lock is busy. */
const PATHS = [
  {
    name: 'saveAll (updateLead — every lead / patient edit modal goes through saveAll)',
    action: 'saveAll',
    setup: (app) => { app.state.leads = [{ ...LEAD }]; },
    run: (app) => app.updateLead('L1', { note: 'הערה חדשה' }),
    landed: (app, result) => { assert.strictEqual(result, true); assert.strictEqual(app.state.leads[0].note, 'הערה חדשה'); },
  },
  {
    name: 'savePayment',
    action: 'savePayment',
    setup: (app) => { app.state.patients = [app.normalizePatient(PATIENT)]; },
    run: (app) => app.savePayment({ ...PAYMENT_ROW }),
    landed: (app) => { assert.ok(app.state.payments.some(p => p.id === 'pay-1')); },
  },
  {
    name: 'saveCredit',
    action: 'saveCredit',
    okResponse: { ok: true, credit: { id: 'credit::pt-1::2026-09::1', patientId: 'pt-1', creditType: 'other', allocationMonth: '2026-09', amount: 100, calculatedAmount: 100, status: 'pending' } },
    run: (app) => app.saveCredit({ id: '', patientId: 'pt-1', creditType: 'other', allocationMonth: '2026-09', amount: 100, calculatedAmount: 100 }),
    landed: (app, saved) => { assert.strictEqual(saved.id, 'credit::pt-1::2026-09::1'); assert.strictEqual(app.state.credits.length, 1); },
    // saveCredit leaves the banner to the credits modal, which keeps itself
    // open with every line intact (render(); return;) — so the contract here
    // is the thrown Hebrew error.
    rejects: true,
  },
  {
    name: 'dischargePatient (the discharge modal)',
    action: 'dischargePatient',
    setup: (app) => { app.state.patients = [app.normalizePatient(PATIENT)]; },
    run: (app) => { app.dischargePatient(app.state.patients[0]); return app.confirm({ disposition: 'completed', note: '', dischargeDate: '' }); },
    landed: (app) => { assert.strictEqual(app.state.patients[0].status, 'released'); },
    // onConfirm rethrows so the modal STAYS OPEN with the user's choices.
    rejects: true,
  },
  {
    name: 'restorePatient (restore as a new lead)',
    action: 'restorePatient',
    setup: (app) => { app.state.dischargedPatients = [{ ...AUDIT }]; },
    run: (app) => app.doRestorePatientAsNewLead(app.state.dischargedPatients[0]),
    landed: (app) => { assert.strictEqual(app.state.dischargedPatients.length, 0); assert.strictEqual(app.state.leads.length, 1); },
  },
  {
    name: 'restorePatientToActive (restore to previous status)',
    action: 'restorePatientToActive',
    setup: (app) => {
      app.state.patients = [app.normalizePatient({ ...PATIENT, status: 'released', exitDate: '2026-08-10' })];
      app.state.dischargedPatients = [{ ...AUDIT }];
    },
    run: (app) => app.doRestorePatientToActive(app.state.dischargedPatients[0]),
    landed: (app) => { assert.strictEqual(app.state.patients[0].status, 'active'); },
  },
  {
    name: 'restoreLead (closed lead back to ליד חדש)',
    action: 'restoreLead',
    setup: (app) => { app.state.irrelevantLeads = [{ ...LEAD, stage: 'irrelevant', originSheet: 'new' }]; },
    run: (app) => { app.restoreIrrelevantLead(app.state.irrelevantLeads[0]); return app.confirm(); },
    landed: (app) => { assert.strictEqual(app.state.leads.length, 1); assert.strictEqual(app.state.irrelevantLeads.length, 0); },
  },
  {
    name: 'deletePatientRow',
    action: 'deletePatientRow',
    setup: (app) => { app.state.patients = [app.normalizePatient(PATIENT)]; },
    run: (app) => app.deletePatient(app.state.patients[0]),
    landed: (app) => { assert.strictEqual(app.state.patients.length, 0); },
  },
  {
    name: 'deleteMeetingReport',
    action: 'deleteMeetingReport',
    setup: (app) => { app.state.leads = [{ ...LEAD, meetingReportedAt: '2026-09-10T10:00:00Z', meetingReportOutcome: 'advancing' }]; },
    run: (app) => app.deleteMeetingReport('L1'),
    landed: (app, result) => { assert.strictEqual(result, true); assert.strictEqual(app.state.leads[0].meetingReportedAt, ''); },
  },
  {
    name: 'removeLead',
    action: 'removeLead',
    setup: (app) => { app.state.leads = [{ ...LEAD }]; },
    run: (app) => app.removeLead(app.state.leads[0]),
    landed: (app) => { assert.strictEqual(app.state.leads.length, 0); assert.strictEqual(app.state.removedLeads.length, 1); },
  },
  {
    name: 'moveLeadIrrelevant (close lead)',
    action: 'moveLeadIrrelevant',
    setup: (app) => { app.state.leads = [{ ...LEAD }]; },
    run: (app) => { app.closeLead(app.state.leads[0]); return app.confirm({ disposition: 'not_relevant', note: '' }); },
    landed: (app) => { assert.strictEqual(app.state.irrelevantLeads.length, 1); },
    rejects: true,   // the close modal stays open
  },
  {
    name: 'upsertBillingOverride',
    action: 'upsertBillingOverride',
    run: (app) => app.saveBillingOverride({ ...PAYMENT_ROW }, 8000),
    landed: (app) => { assert.strictEqual(app.state.billingOverrides.length, 1); },
  },
  {
    name: 'deleteBillingOverride',
    action: 'deleteBillingOverride',
    setup: (app) => {
      app.state.billingOverrides = [{ id: app.billingOverrideId('pt-1', '2026-09'), patientId: 'pt-1', month: '2026-09', amount: 8000 }];
    },
    run: (app) => app.clearBillingOverride({ ...PAYMENT_ROW }),
    landed: (app) => { assert.strictEqual(app.state.billingOverrides.length, 0); },
  },
];

for (const p of PATHS) {
  test(`${p.name}: busy → retried ONCE after 2 s with the identical body, and the change lands`, async () => {
    const { app, sent } = loadApp({ [p.action]: [BUSY, p.okResponse || { ok: true }] });
    if (p.setup) p.setup(app);
    const result = await p.run(app);
    const writes = sent(p.action);
    assert.strictEqual(writes.length, 2, 'one send + one automatic retry');
    assert.strictEqual(writes[1].raw, writes[0].raw, 'the retry re-sends the exact same body');
    assert.deepStrictEqual(Array.from(app.delays()), [2000], 'waited 2000 ms, once');
    assert.deepStrictEqual(Array.from(app.errors()), [], 'no error when the retry succeeds');
    p.landed(app, result);
  });

  test(`${p.name}: still busy after the retry → «${HE}» is shown, never a silent drop`, async () => {
    const { app, sent } = loadApp({ [p.action]: [BUSY, BUSY] });
    if (p.setup) p.setup(app);
    let thrown = null;
    try { await p.run(app); } catch (e) { thrown = e; }
    assert.strictEqual(sent(p.action).length, 2, 'exactly one retry — never a loop');
    if (p.rejects) {
      assert.ok(thrown, 'the caller is told (modal stays open / error propagates)');
    }
    const shown = app.errors().join('\n') + (thrown ? '\n' + thrown.message : '');
    assert.ok(shown.includes(HE), 'the Hebrew busy message reaches the user: ' + shown);
    assert.ok(!shown.includes('could not acquire'), "the server's English text never reaches the user");
  });
}

/* ===== the two background saveAll paths that used to fail silently ===== */

test('meetingWith autosave (background saveAll): busy twice → the Hebrew message is shown and the lead is NOT blacklisted', async () => {
  const { app, sent } = loadApp({ saveAll: [BUSY, BUSY, { ok: true }] });
  app.state.houseManagers = { arfoni: 'חנן' };
  app.state.leads = [{ ...LEAD, stage: 'visit', meetingWith: '' }];
  await app.autosaveMeetingWithDefaults();
  assert.strictEqual(sent('saveAll').length, 2);
  assert.ok(app.errors().some(m => m.includes(HE)), 'not silent any more');
  assert.strictEqual(app.state.leads[0].meetingWith, '', 'rolled back — nothing was saved');
  // A busy lock is not a real failure: the next pass tries the lead again.
  await app.autosaveMeetingWithDefaults();
  assert.strictEqual(sent('saveAll').length, 3, 'retried on the next pass');
  assert.strictEqual(app.state.leads[0].meetingWith, 'חנן');
});

test('meetingWith autosave: busy then ok → saved after one retry, no message', async () => {
  const { app } = loadApp({ saveAll: [BUSY, { ok: true }] });
  app.state.houseManagers = { arfoni: 'חנן' };
  app.state.leads = [{ ...LEAD, stage: 'visit', meetingWith: '' }];
  await app.autosaveMeetingWithDefaults();
  assert.strictEqual(app.state.leads[0].meetingWith, 'חנן');
  assert.deepStrictEqual(Array.from(app.errors()), []);
});

test('loadAll auto-promote saveAll: a busy lock shows the Hebrew message; the rows stay in state for the next save', () => {
  const body = SRC.slice(SRC.indexOf('async function loadAll()'), SRC.indexOf('function admissionMeetingOutcome'));
  const at = body.indexOf('saveAll().catch(');
  assert.ok(at !== -1, 'the auto-promote save is still there');
  const handler = body.slice(at, body.indexOf('});', at));
  assert.ok(/isLockBusyError\(e\)\)\s*showError\(LOCK_BUSY_MESSAGE_HE\)/.test(handler), 'busy lock is reported');
  assert.ok(!/state\.patients\s*=/.test(handler), 'nothing is reverted — the rows ride the next saveAll');
});

/* ===== apiPost contract ===== */

test('apiPost: other refusals are NOT retried and keep their message + data', async () => {
  const { app, sent } = loadApp({ savePayment: [{ ok: false, error: 'conflict', conflicts: [{ id: 'x' }] }] });
  await assert.rejects(app.apiPost({ action: 'savePayment', payment: {} }), (e) => {
    assert.strictEqual(e.message, 'conflict');
    assert.strictEqual(e.data.error, 'conflict');
    assert.strictEqual(app.isLockBusyError(e), false);
    return true;
  });
  assert.strictEqual(sent('savePayment').length, 1);
  assert.deepStrictEqual(Array.from(app.delays()), []);
});

test('apiPost: busy then a DIFFERENT refusal → that refusal is thrown as before (no second retry)', async () => {
  const { app, sent } = loadApp({ saveAll: [BUSY, { ok: false, error: 'exception', message: 'boom' }] });
  await assert.rejects(app.apiPost({ action: 'saveAll' }), /boom/);
  assert.strictEqual(sent('saveAll').length, 2);
});

test('apiPost: the final busy error is Hebrew, flagged, and carries the server data', async () => {
  const { app } = loadApp({ saveAll: [BUSY, BUSY] });
  await assert.rejects(app.apiPost({ action: 'saveAll' }), (e) => {
    assert.strictEqual(e.message, HE);
    assert.strictEqual(e.lockBusy, true);
    assert.strictEqual(app.isLockBusyError(e), true);
    assert.strictEqual(e.data.error, 'lock_busy');
    return true;
  });
  assert.strictEqual(app.LOCK_BUSY_RETRY_MS, 2000);
  assert.strictEqual(app.LOCK_BUSY_MESSAGE_HE, HE);
});

test('every write in app.js goes through apiPost — no POST bypasses the busy-lock handling', () => {
  // The ONLY route to the Apps Script is /api/sheets, and only apiGet / apiPost
  // name it (the other fetches are PIN, session, logout and the Outpatient app).
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const sheetsRefs = [...code.matchAll(/'\/api\/sheets/g)].map(m => m.index);
  assert.strictEqual(sheetsRefs.length, 2, 'only apiGet and apiPost address /api/sheets');
  const apiGetAt = code.indexOf('async function apiGet(');
  const apiPostAt = code.indexOf('async function apiPost(');
  const nextFn = (from) => code.indexOf('\nasync function ', from + 1);
  assert.ok(sheetsRefs[0] > apiGetAt && sheetsRefs[0] < nextFn(apiGetAt));
  assert.ok(sheetsRefs[1] > apiPostAt && sheetsRefs[1] < nextFn(apiPostAt));
  const actions = [...SRC.matchAll(/apiPost\(\{\s*action:\s*'([A-Za-z]+)'/g)].map(m => m[1]);
  const tested = new Set(PATHS.map(p => p.action));
  for (const a of actions) assert.ok(tested.has(a), `write path ${a} has no lock_busy test`);
  assert.ok(SRC.includes("action: 'saveAll'"), 'saveAll builds its payload separately and is tested above');
});

test('lockBusyDelay really waits (setTimeout with the given ms)', async () => {
  const src = SRC.slice(SRC.indexOf('function lockBusyDelay('), SRC.indexOf('function isLockBusyError('));
  assert.ok(/new Promise\(resolve => setTimeout\(resolve, ms\)\)/.test(src));
});
