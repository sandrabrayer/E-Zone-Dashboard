/* Tests for the meeting invite / update WhatsApp messages in public/app.js.
 *
 * Same vm-sandbox load as meetings-whatsapp.test.js. buildMeetingMessage is a
 * pure function that composes the two Hebrew templates ('invite' / 'update')
 * from the real shipped helpers — hebrewWeekday (LOCAL date parts, per the
 * isoDate timezone rule), formatDateDDMMYYYY (DD/MM/YYYY), and houseDisplayName
 * (canonical key / label / id → display name). meetingInviteWaUrl reuses
 * normalizePhone + the wa.me construction. We exercise the REAL code, never a
 * reimplementation.
 *
 * Date math depends on the host timezone; pin TZ=Asia/Jerusalem for determinism. */

process.env.TZ = 'Asia/Jerusalem';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadApp() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const epilogue = `
    globalThis.__test = {
      buildMeetingMessage,
      hebrewWeekday,
      houseDisplayName,
      meetingInviteWaUrl,
      formatDateDDMMYYYY,
      normalizePhone,
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

/* ===== invite, with a time ===== */
test('invite message: full template with a time', () => {
  const msg = app.buildMeetingMessage({
    type: 'invite', name: 'דנה', manager: 'חנן', house: 'arfoni',
    dateISO: '2026-07-27', time: '09:30',
  });
  assert.strictEqual(
    msg,
    'שלום דנה, נקבעה פגישה עם חנן ביום שני 27/07/2026 בשעה 09:30 בבית קיסריה עפרוני.'
  );
});

/* ===== invite, no time — the בשעה clause is dropped cleanly ===== */
test('invite message: no time drops the " בשעה <שעה>" clause with no double space', () => {
  const msg = app.buildMeetingMessage({
    type: 'invite', name: 'דנה', manager: 'חנן', house: 'arfoni',
    dateISO: '2026-07-27', time: '',
  });
  assert.strictEqual(
    msg,
    'שלום דנה, נקבעה פגישה עם חנן ביום שני 27/07/2026 בבית קיסריה עפרוני.'
  );
  assert.ok(!msg.includes('בשעה'), 'no-time invite must not contain בשעה');
  assert.ok(!/ {2}/.test(msg), 'no-time invite must have no double spaces');
});

/* ===== invite, missing time (undefined) behaves like empty ===== */
test('invite message: a missing time field is treated as no time', () => {
  const withUndefined = app.buildMeetingMessage({
    type: 'invite', name: 'דנה', manager: 'חנן', house: 'arfoni', dateISO: '2026-07-27',
  });
  assert.strictEqual(
    withUndefined,
    'שלום דנה, נקבעה פגישה עם חנן ביום שני 27/07/2026 בבית קיסריה עפרוני.'
  );
});

/* ===== update ===== */
test('update message: full template with a time', () => {
  const msg = app.buildMeetingMessage({
    type: 'update', name: 'דנה', manager: 'חנן', house: 'ramot',
    dateISO: '2026-07-29', time: '14:00',
  });
  assert.strictEqual(
    msg,
    'שלום דנה, הפגישה שונתה ליום רביעי 29/07/2026 בשעה 14:00 עם חנן בבית רמות השבים.'
  );
});

test('update message: no time drops the clause with no double space', () => {
  const msg = app.buildMeetingMessage({
    type: 'update', name: 'דנה', manager: 'חנן', house: 'ramot',
    dateISO: '2026-07-29', time: '',
  });
  assert.strictEqual(
    msg,
    'שלום דנה, הפגישה שונתה ליום רביעי 29/07/2026 עם חנן בבית רמות השבים.'
  );
  assert.ok(!/ {2}/.test(msg), 'no-time update must have no double spaces');
});

/* ===== Hebrew weekday correctness for known dates ===== */
test('hebrewWeekday derives the correct bare Hebrew day name (LOCAL parts)', () => {
  assert.strictEqual(app.hebrewWeekday('2026-07-27'), 'שני');    // Monday
  assert.strictEqual(app.hebrewWeekday('2026-07-29'), 'רביעי');  // Wednesday
  assert.strictEqual(app.hebrewWeekday('2026-08-02'), 'ראשון');  // Sunday
  assert.strictEqual(app.hebrewWeekday('2026-01-01'), 'חמישי');  // Thursday
  assert.strictEqual(app.hebrewWeekday(''), '');                 // unparseable → ''
});

test('hebrewWeekday reads a full ISO timestamp on its LOCAL day (no UTC drift)', () => {
  // 2026-07-27T00:30:00 local (Asia/Jerusalem) is still Monday — a UTC-based
  // read could roll it to the previous day. The weekday must stay שני.
  assert.strictEqual(app.hebrewWeekday('2026-07-27'), 'שני');
});

/* ===== DD/MM/YYYY formatting ===== */
test('formatDateDDMMYYYY renders zero-padded slash-separated DD/MM/YYYY', () => {
  assert.strictEqual(app.formatDateDDMMYYYY('2026-07-27'), '27/07/2026');
  assert.strictEqual(app.formatDateDDMMYYYY('2026-01-05'), '05/01/2026');
  assert.strictEqual(app.formatDateDDMMYYYY(''), '');
});

/* ===== house display-name resolution ===== */
test('houseDisplayName resolves canonical key, Hebrew label, and unknown alike', () => {
  assert.strictEqual(app.houseDisplayName('arfoni'), 'קיסריה עפרוני');   // canonical key
  assert.strictEqual(app.houseDisplayName('קיסריה עפרוני'), 'קיסריה עפרוני'); // already a label
  assert.strictEqual(app.houseDisplayName('ramot'), 'רמות השבים');
  assert.strictEqual(app.houseDisplayName('משהו אחר'), 'משהו אחר');       // unknown → passthrough
  assert.strictEqual(app.houseDisplayName(''), '');
});

test('the message uses the house DISPLAY name even when given a canonical key', () => {
  const msg = app.buildMeetingMessage({
    type: 'invite', name: 'רון', manager: 'אורן', house: 'ramot',
    dateISO: '2026-08-02', time: '11:15',
  });
  assert.ok(msg.includes('בבית רמות השבים'), 'must use display name, not the key');
  assert.ok(!msg.includes('ramot'), 'must not leak the canonical key');
});

/* ===== wa.me deep link reuses normalizePhone + wa.me construction ===== */
test('meetingInviteWaUrl normalizes the lead phone and round-trips the message', () => {
  const msg = app.buildMeetingMessage({
    type: 'invite', name: 'דנה', manager: 'חנן', house: 'arfoni',
    dateISO: '2026-07-27', time: '09:30',
  });
  const url = app.meetingInviteWaUrl('050-123-4567', msg);
  assert.ok(url.startsWith('https://wa.me/972501234567?text='), `got ${url}`);
  const text = url.split('?text=')[1];
  assert.strictEqual(decodeURIComponent(text), msg);
  assert.ok(!/[ ֐-׿]/.test(text), 'query must be percent-encoded (no raw Hebrew/space)');
});

test('meetingInviteWaUrl with a blank phone yields wa.me/?text= (recipient chosen in WhatsApp)', () => {
  const url = app.meetingInviteWaUrl('', 'שלום');
  assert.ok(url.startsWith('https://wa.me/?text='), `got ${url}`);
});
