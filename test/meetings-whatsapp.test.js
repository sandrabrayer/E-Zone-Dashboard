/* Tests for the meetings-board WhatsApp link in public/app.js.
 *
 * Same vm-sandbox load as meetings-board.test.js. The link is built from three
 * pure functions — phoneForManager (name → wa.me digits), meetingWhatsappMessage
 * (the Hebrew body, with the time clause dropped when there's no time), and
 * meetingWhatsappUrl (the full wa.me URL or '' when the button must be disabled).
 * We also exercise meetingsForWeek + isoTime so the epoch-artifact visitTime
 * (1899-12-30T…Z) is normalized by the REAL shipped code, not a reimplementation.
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
      phoneForManager,
      meetingWhatsappMessage,
      meetingWhatsappUrl,
      meetingsForWeek,
      isoTime,
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

// Manager-name → phone map, exactly as getData exports it (MANAGER_PHONES).
const PHONES = {
  'חנן':  '972527046671',
  'רנטה': '972526765261',
  'עידו': '972524669814',
  'אורן': '972507580152',
};

function meeting(over) {
  return Object.assign(
    { id: 'x', date: '2026-07-27', time: '09:30', name: 'דנה', house: 'קיסריה עפרוני',
      houseLabel: 'קיסריה עפרוני', meetingWith: 'חנן' },
    over || {}
  );
}

/* ===== URL construction for all four managers ===== */
test('builds a wa.me URL with the right phone for each of the four managers', () => {
  const cases = [
    ['חנן', '972527046671'],
    ['רנטה', '972526765261'],
    ['עידו', '972524669814'],
    ['אורן', '972507580152'],
  ];
  for (const [name, phone] of cases) {
    const url = app.meetingWhatsappUrl(meeting({ meetingWith: name }), PHONES);
    assert.ok(url.startsWith(`https://wa.me/${phone}?text=`), `expected wa.me/${phone}, got ${url}`);
  }
});

test('phoneForManager resolves each name and is blank for unknown/empty', () => {
  assert.strictEqual(app.phoneForManager('אורן', PHONES), '972507580152');
  assert.strictEqual(app.phoneForManager('מישהו אחר', PHONES), '');
  assert.strictEqual(app.phoneForManager('', PHONES), '');
});

/* ===== Hebrew message encodes correctly ===== */
test('the Hebrew message is correct and URL-encodes losslessly', () => {
  const m = meeting({ meetingWith: 'חנן', name: 'דנה', houseLabel: 'קיסריה עפרוני',
    date: '2026-07-27', time: '09:30' });
  const msg = app.meetingWhatsappMessage(m);
  assert.strictEqual(msg, 'נקבעה פגישה: דנה, קיסריה עפרוני, 27/07/2026 בשעה 09:30');

  const url = app.meetingWhatsappUrl(m, PHONES);
  const text = url.split('?text=')[1];
  // Round-trips: the encoded query decodes back to the exact Hebrew message.
  assert.strictEqual(decodeURIComponent(text), msg);
  // And it is actually percent-encoded (no raw spaces / Hebrew left in the URL).
  assert.ok(!/[ ֐-׿]/.test(text), 'query must be percent-encoded');
});

/* ===== No-time variant omits the בשעה clause ===== */
test('a meeting with no time drops the " בשעה <שעה>" clause', () => {
  const m = meeting({ time: '', name: 'רון', houseLabel: 'רמות השבים', date: '2026-07-29',
    meetingWith: 'אורן' });
  const msg = app.meetingWhatsappMessage(m);
  assert.strictEqual(msg, 'נקבעה פגישה: רון, רמות השבים, 29/07/2026');
  assert.ok(!msg.includes('בשעה'), 'no-time message must not contain בשעה');

  // The URL is still built (has a manager + phone), just without the time clause.
  const url = app.meetingWhatsappUrl(m, PHONES);
  assert.ok(url.startsWith('https://wa.me/972507580152?text='));
  assert.strictEqual(decodeURIComponent(url.split('?text=')[1]), msg);
});

/* ===== Epoch-artifact visitTime renders as HH:MM ===== */
test('epoch-artifact visitTime (1899-12-30T07:18:20.000Z) renders as 07:18', () => {
  assert.strictEqual(app.isoTime('1899-12-30T07:18:20.000Z'), '07:18');

  // End-to-end through meetingsForWeek: a lead whose visitTime is the Sheets
  // epoch artifact buckets with time '07:18', and the message reads בשעה 07:18.
  const wk = app.meetingsForWeek([{
    id: 'e', name: 'ליד', house: 'רמות השבים', meetingWith: 'אורן',
    visitDate: '2026-07-27', visitTime: '1899-12-30T07:18:20.000Z',
  }], '2026-07-27');
  const m = wk.days[0].timed[0];
  assert.strictEqual(m.time, '07:18');
  assert.strictEqual(app.meetingWhatsappMessage(m),
    'נקבעה פגישה: ליד, רמות השבים, 27/07/2026 בשעה 07:18');
});

/* ===== Disabled state: empty meetingWith, unknown name, blank house ===== */
test('empty meetingWith disables the link (returns "")', () => {
  assert.strictEqual(app.meetingWhatsappUrl(meeting({ meetingWith: '' }), PHONES), '');
});

test('a meetingWith name with no phone disables the link (returns "")', () => {
  assert.strictEqual(app.meetingWhatsappUrl(meeting({ meetingWith: 'מנהל לא ידוע' }), PHONES), '');
  // Also disabled when the phone map is empty (older deploy, no managerPhones).
  assert.strictEqual(app.meetingWhatsappUrl(meeting({ meetingWith: 'חנן' }), {}), '');
});

test('a blank-house lead produces no link (blank house → empty meetingWith → disabled)', () => {
  // Blank house leads carry an empty meetingWith (autofill cleared it), so the
  // link is disabled — never a link to nobody.
  const m = meeting({ house: '', houseLabel: '', meetingWith: '' });
  assert.strictEqual(app.meetingWhatsappUrl(m, PHONES), '');
});
