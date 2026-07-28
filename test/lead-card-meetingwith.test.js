/* Tests for the inline meetingWith <select> on the lead card (public/app.js).
 *
 * Same vm-sandbox load as meetings-board.test.js. Two pure/near-pure surfaces:
 *   - meetingWithSelectHTML(lead, roster) — the rendered <select> markup: the
 *     option list comes from the roster, it carries data-field="meetingWith" so
 *     it rides the same single-field save path as the date/time inputs, and its
 *     pre-selected default resolves house→manager without saving.
 *   - updateLead(id, fields) — the shipped single-field save path itself: we
 *     stub saveAll and assert a meetingWith change is applied optimistically and
 *     persisted through it, exactly like a visitDate/visitTime change. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadApp() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const epilogue = `
    globalThis.__test = {
      meetingWithSelectHTML,
      managerForHouse,
      // Drive the real single-field save path. saveAll is reassigned per test to
      // capture calls without a network/DOM.
      setLeads(ls) { state.leads = ls; },
      setRoster(r) { state.houseManagers = r; },
      stubSaveAll() {
        const calls = [];
        saveAll = async () => { calls.push(true); };
        return calls;
      },
      updateLead: (id, fields) => updateLead(id, fields),
      getLead: (id) => state.leads.find(l => l.id === id),
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

// House id → manager roster, exactly as getData exports it (HOUSE_MANAGERS).
const ROSTER = { arfoni: 'חנן', rehab: 'רנטה', asher: 'עידו', ramot: 'אורן' };

// Extract selected option value from a <select> markup string ('' when none).
function selectedValue(html) {
  const m = html.match(/<option value="([^"]*)"[^>]*\sselected[^>]*>/);
  return m ? m[1] : '';
}
// All option values, in order.
function optionValues(html) {
  return [...html.matchAll(/<option value="([^"]*)"/g)].map(m => m[1]);
}

/* ===== The select renders with the roster from state ===== */
test('select renders the blank option plus every manager in the roster', () => {
  const html = app.meetingWithSelectHTML({ house: '', meetingWith: '' }, ROSTER);
  assert.deepStrictEqual(optionValues(html), ['', 'חנן', 'רנטה', 'עידו', 'אורן']);
});

test('select falls back to state.houseManagers when no roster is passed', () => {
  app.setRoster(ROSTER);
  const html = app.meetingWithSelectHTML({ house: 'arfoni', meetingWith: '' });
  assert.deepStrictEqual(optionValues(html), ['', 'חנן', 'רנטה', 'עידו', 'אורן']);
});

test('select carries data-field="meetingWith" so it rides the single-field save path', () => {
  const html = app.meetingWithSelectHTML({ house: 'arfoni', meetingWith: '' }, ROSTER);
  assert.ok(/data-field="meetingWith"/.test(html), 'must carry data-field="meetingWith"');
});

/* ===== house→manager default resolves for all four keys, blank for the rest ===== */
test('empty meetingWith defaults the select to the house manager for all four keys', () => {
  const cases = [
    ['arfoni', 'חנן'], ['rehab', 'רנטה'], ['asher', 'עידו'], ['ramot', 'אורן'],
    ['קיסריה עפרוני', 'חנן'], // resolves by Hebrew label too
  ];
  for (const [house, manager] of cases) {
    const html = app.meetingWithSelectHTML({ house, meetingWith: '' }, ROSTER);
    assert.strictEqual(selectedValue(html), manager, `house ${house} → ${manager}`);
  }
});

test('blank-resolving houses default the select to blank (pardes/sde/external/none)', () => {
  for (const house of ['pardes', 'sde', 'רעננה הפרדס', 'external-x', '']) {
    const html = app.meetingWithSelectHTML({ house, meetingWith: '' }, ROSTER);
    assert.strictEqual(selectedValue(html), '', `house ${house} → blank`);
  }
});

test('an existing meetingWith is preselected over the house default (no override lost)', () => {
  // Lead at arfoni (→ חנן) but Vered already chose רנטה: keep רנטה selected.
  const html = app.meetingWithSelectHTML({ house: 'arfoni', meetingWith: 'רנטה' }, ROSTER);
  assert.strictEqual(selectedValue(html), 'רנטה');
});

/* ===== change persists through the same save path ===== */
test('a meetingWith change persists through updateLead → saveAll (same path as date/time)', async () => {
  app.setRoster(ROSTER);
  app.setLeads([{ id: 'L1', name: 'דנה', stage: 'visit', house: 'קיסריה עפרוני',
    visitDate: '2026-07-27', visitTime: '09:00', meetingWith: '' }]);
  const calls = app.stubSaveAll();

  // Exactly what the [data-field] onchange handler invokes for the select.
  await app.updateLead('L1', { meetingWith: 'עידו' });

  assert.strictEqual(app.getLead('L1').meetingWith, 'עידו', 'value applied optimistically');
  assert.strictEqual(calls.length, 1, 'persisted via saveAll once');
});

test('updateLead leaves other lead fields untouched when saving meetingWith', async () => {
  app.setLeads([{ id: 'L2', name: 'רון', stage: 'visit', house: 'רמות השבים',
    visitDate: '2026-07-29', visitTime: '', meetingWith: '' }]);
  app.stubSaveAll();
  await app.updateLead('L2', { meetingWith: 'אורן' });
  const lead = app.getLead('L2');
  assert.strictEqual(lead.meetingWith, 'אורן');
  assert.strictEqual(lead.visitDate, '2026-07-29');
  assert.strictEqual(lead.name, 'רון');
});
