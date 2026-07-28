/* Tests for the meetingWith house-default autosave (public/app.js).
 *
 * The lead card renders a house-derived meetingWith default but only persists on
 * user change, so a lead whose default is already correct never saved —
 * meetingWith stayed '' and the meetings board showed '—'.
 * autosaveMeetingWithDefaults() backfills those once via a single batched
 * saveAll. These tests drive the REAL shipped function with saveAll stubbed to
 * count calls (no network / no DOM — getElementById returns null so the
 * renderMeetings() refresh is a guarded no-op).
 *
 * Same vm-sandbox load as lead-card-meetingwith.test.js. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadApp() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const epilogue = `
    globalThis.__test = {
      leadsNeedingMeetingWithDefault,
      autosave: () => autosaveMeetingWithDefaults(),
      setLeads(ls) { state.leads = ls; },
      setRoster(r) { state.houseManagers = r; },
      setMode(m) { state.mode = m; },
      getLead(id) { return state.leads.find(l => l.id === id); },
      // Reassign saveAll to count calls without a network round-trip.
      stubSaveAll(fail) {
        const calls = [];
        saveAll = async () => { calls.push(true); if (fail) throw new Error('save failed'); };
        return calls;
      },
    };
  `;
  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/' },
    document: { addEventListener: noop, getElementById: () => null },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    URLSearchParams, Math, Date, JSON, Number, String, Array, Object, RegExp, Promise,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + epilogue, sandbox);
  return sandbox.__test;
}

const app = loadApp();

const ROSTER = { arfoni: 'חנן', rehab: 'רנטה', asher: 'עידו', ramot: 'אורן' };

function lead(over) {
  return Object.assign(
    { id: 'x', name: 'ליד', stage: 'visit', house: 'קיסריה עפרוני',
      visitDate: '2026-07-27', visitTime: '09:00', meetingWith: '' },
    over || {}
  );
}

function setup(leads, opts) {
  app.setMode((opts && opts.mode) || 'edit');
  app.setRoster(ROSTER);
  app.setLeads(leads);
  return app.stubSaveAll(opts && opts.fail);
}

/* ===== empty + resolving house saves once ===== */
test('a visit lead with empty meetingWith + resolving house backfills and saves once', async () => {
  const calls = setup([lead({ id: 'L1', house: 'קיסריה עפרוני', meetingWith: '' })]); // arfoni → חנן
  await app.autosave();
  assert.strictEqual(app.getLead('L1').meetingWith, 'חנן', 'backfilled to the house manager');
  assert.strictEqual(calls.length, 1, 'persisted exactly once');
});

test('many qualifying leads at once are one batched save, not a storm', async () => {
  const calls = setup([
    lead({ id: 'a', house: 'קיסריה עפרוני' }),  // חנן
    lead({ id: 'b', house: 'רמות השבים' }),      // אורן
    lead({ id: 'c', house: 'רעננה אשר' }),       // עידו
  ]);
  await app.autosave();
  assert.strictEqual(app.getLead('a').meetingWith, 'חנן');
  assert.strictEqual(app.getLead('b').meetingWith, 'אורן');
  assert.strictEqual(app.getLead('c').meetingWith, 'עידו');
  assert.strictEqual(calls.length, 1, 'one saveAll for the whole batch');
});

test('the default resolves by internal house id too', async () => {
  const calls = setup([lead({ id: 'L', house: 'ramot', meetingWith: '' })]);
  await app.autosave();
  assert.strictEqual(app.getLead('L').meetingWith, 'אורן');
  assert.strictEqual(calls.length, 1);
});

/* ===== existing value untouched ===== */
test('a lead that already has meetingWith is left untouched and triggers no save', async () => {
  const calls = setup([lead({ id: 'L2', house: 'קיסריה עפרוני', meetingWith: 'רנטה' })]);
  await app.autosave();
  assert.strictEqual(app.getLead('L2').meetingWith, 'רנטה', 'existing override preserved');
  assert.strictEqual(calls.length, 0, 'no save when nothing needs backfill');
});

/* ===== blank-resolving house saves nothing ===== */
test('blank-resolving houses (pardes/sde/external) save nothing', async () => {
  const calls = setup([
    lead({ id: 'p', house: 'רעננה הפרדס' }),  // pardes → ''
    lead({ id: 's', house: 'שדה אליעזר' }),   // sde → ''
    lead({ id: 'x', house: 'external-x' }),   // unknown → ''
    lead({ id: 'n', house: '' }),             // no house → ''
  ]);
  await app.autosave();
  for (const id of ['p', 's', 'x', 'n']) {
    assert.strictEqual(app.getLead(id).meetingWith, '', `${id} stays blank`);
  }
  assert.strictEqual(calls.length, 0, 'no save for blank-resolving houses');
});

test('non-visit stage leads are not backfilled even with a resolving house', async () => {
  const calls = setup([
    lead({ id: 'new', stage: 'new', house: 'קיסריה עפרוני' }),
    lead({ id: 'paid', stage: 'paid', house: 'רמות השבים' }),
  ]);
  await app.autosave();
  assert.strictEqual(app.getLead('new').meetingWith, '');
  assert.strictEqual(app.getLead('paid').meetingWith, '');
  assert.strictEqual(calls.length, 0);
});

/* ===== re-render after save does not save again (idempotent) ===== */
test('a second autosave after a successful backfill does not save again', async () => {
  const calls = setup([lead({ id: 'L3', house: 'קיסריה עפרוני' })]);
  await app.autosave();                 // backfills + saves
  assert.strictEqual(calls.length, 1);
  await app.autosave();                 // simulates a re-render — nothing left to do
  assert.strictEqual(app.getLead('L3').meetingWith, 'חנן');
  assert.strictEqual(calls.length, 1, 'no second save — idempotent');
});

/* ===== failure rolls back and does not persist a phantom value ===== */
test('on save failure the in-memory value rolls back to empty', async () => {
  const calls = setup([lead({ id: 'L4', house: 'קיסריה עפרוני' })], { fail: true });
  await app.autosave();
  assert.strictEqual(calls.length, 1, 'attempted the save');
  assert.strictEqual(app.getLead('L4').meetingWith, '', 'rolled back to empty on failure');
});

/* ===== viewer mode never writes ===== */
test('viewer mode does not backfill or save', async () => {
  const calls = setup([lead({ id: 'L5', house: 'קיסריה עפרוני' })], { mode: 'viewer' });
  await app.autosave();
  assert.strictEqual(app.getLead('L5').meetingWith, '', 'no in-memory change in viewer mode');
  assert.strictEqual(calls.length, 0, 'no save in viewer mode');
});

/* ===== the pure selector ===== */
test('leadsNeedingMeetingWithDefault selects only qualifying visit-stage leads', () => {
  const leads = [
    lead({ id: 'q', house: 'קיסריה עפרוני', meetingWith: '' }),   // qualifies
    lead({ id: 'has', house: 'קיסריה עפרוני', meetingWith: 'חנן' }), // has value
    lead({ id: 'blank', house: 'רעננה הפרדס', meetingWith: '' }),  // blank-resolving
    lead({ id: 'stage', stage: 'new', house: 'רמות השבים', meetingWith: '' }), // wrong stage
  ];
  const picked = app.leadsNeedingMeetingWithDefault(leads, ROSTER).map(l => l.id);
  assert.deepStrictEqual(Array.from(picked), ['q']);
});
