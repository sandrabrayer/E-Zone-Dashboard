/* Tests for the add-lead meetingWith autofill decision in public/app.js.
 *
 * When the house select changes in the add-lead modal, meetingWith auto-fills
 * with that house's manager — but only while the user hasn't manually set it.
 * autofillMeetingWith(newHouse, dirty, managers) is the pure decision behind
 * that wiring (the showModal onChange handler just applies its result to the
 * <select>), so the rule is unit-tested here without a DOM.
 *
 * Same vm-sandbox load as growth-graph.test.js / meetings-board.test.js. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadApp() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const epilogue = `
    globalThis.__test = {
      autofillMeetingWith,
      managerForHouse,
    };
  `;
  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/' },
    document: { addEventListener: noop, getElementById: () => null },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    URLSearchParams, Math, Date, JSON, Number, String, Array, Object, RegExp,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + epilogue, sandbox);
  return sandbox.__test;
}

const app = loadApp();

// The four-house roster as getData exports it (house id → manager name).
const ROSTER = { arfoni: 'חנן', rehab: 'רנטה', asher: 'עידו', ramot: 'אורן' };

/* ===== A house change fills the matching manager (not dirty) ===== */
test('house change sets the matching manager for all four keys (by id)', () => {
  assert.strictEqual(app.autofillMeetingWith('arfoni', false, ROSTER), 'חנן');
  assert.strictEqual(app.autofillMeetingWith('rehab', false, ROSTER), 'רנטה');
  assert.strictEqual(app.autofillMeetingWith('asher', false, ROSTER), 'עידו');
  assert.strictEqual(app.autofillMeetingWith('ramot', false, ROSTER), 'אורן');
});

test('house change resolves the manager by Hebrew house label too', () => {
  // The house <select> options carry the Hebrew label (h.name), not the id.
  assert.strictEqual(app.autofillMeetingWith('קיסריה עפרוני', false, ROSTER), 'חנן'); // arfoni
  assert.strictEqual(app.autofillMeetingWith('רמות השבים', false, ROSTER), 'אורן');   // ramot
});

/* ===== A manually-set meetingWith survives a later house change (dirty) ===== */
test('a manually-set meetingWith survives a subsequent house change', () => {
  // dirty === true → returns null, i.e. "leave meetingWith untouched" — for
  // every house, including ones that would otherwise auto-fill or clear.
  assert.strictEqual(app.autofillMeetingWith('arfoni', true, ROSTER), null);
  assert.strictEqual(app.autofillMeetingWith('rehab', true, ROSTER), null);
  assert.strictEqual(app.autofillMeetingWith('pardes', true, ROSTER), null); // no clobber even when blank-resolving
  assert.strictEqual(app.autofillMeetingWith('', true, ROSTER), null);
});

/* ===== Blank-resolving houses clear meetingWith (not dirty) ===== */
test('blank-resolving houses clear meetingWith', () => {
  assert.strictEqual(app.autofillMeetingWith('pardes', false, ROSTER), '');        // no manager
  assert.strictEqual(app.autofillMeetingWith('sde', false, ROSTER), '');           // no manager
  assert.strictEqual(app.autofillMeetingWith('רעננה הפרדס', false, ROSTER), '');   // pardes label
  assert.strictEqual(app.autofillMeetingWith('', false, ROSTER), '');              // no house (— ללא —)
  assert.strictEqual(app.autofillMeetingWith('external-unknown', false, ROSTER), ''); // external
});

/* ===== Clearing is a real overwrite: switching four → blank clears it ===== */
test('switching from a manager house to a blank-resolving house clears (not null)', () => {
  // The distinction matters: '' overwrites the previously auto-filled manager,
  // whereas null would leave the stale manager in place.
  const afterManagerHouse = app.autofillMeetingWith('arfoni', false, ROSTER); // 'חנן'
  assert.strictEqual(afterManagerHouse, 'חנן');
  const afterBlankHouse = app.autofillMeetingWith('pardes', false, ROSTER);
  assert.strictEqual(afterBlankHouse, '');
  assert.notStrictEqual(afterBlankHouse, null);
});
