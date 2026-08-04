/* Tests for the lead contact-fields UI (public/app.js):
 *   - leadBillingPhone       — outgoing-communication phone (billingPhone or
 *                              patient-phone fallback);
 *   - resolveBillingPhone    — billing selector choice → stored phone STRING;
 *   - billingModeForLead     — stored billingPhone → selector init (mode + free
 *                              input), matched by NORMALIZED phone;
 *   - leadMatchesQuery       — search over name/house/contactName + patient/
 *                              contact/billing phones (raw + normalized);
 *   - meetingInviteWaUrl ∘ leadBillingPhone — invite URL targets the billing
 *                              phone when set, else the patient phone.
 *
 * Same vm-sandbox approach as meetings-board.test.js: app.js is a browser-global
 * script, so we read the source, append an epilogue exposing the pure functions,
 * and evaluate it in a vm context with browser globals stubbed. No changes to
 * app.js are needed for testability. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadApp() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const epilogue = `
    globalThis.__test = {
      leadBillingPhone,
      resolveBillingPhone,
      billingModeForLead,
      leadMatchesQuery,
      meetingInviteWaUrl,
      normalizePhone,
    };
  `;
  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/' },
    document: { addEventListener: noop, getElementById: () => null },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    URLSearchParams, Math, Date, JSON, Number, String, Array, Object, RegExp, Promise,
    encodeURIComponent,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + epilogue, sandbox);
  return sandbox.__test;
}

const app = loadApp();

function lead(over) {
  return Object.assign(
    { id: 'x', name: 'מטופל', phone: '', contactName: '', contactPhone: '',
      contactRelation: '', billingPhone: '', house: '' },
    over || {}
  );
}

/* ===== leadBillingPhone ===== */

test('leadBillingPhone: returns billingPhone when set', () => {
  assert.strictEqual(
    app.leadBillingPhone(lead({ phone: '0501111111', billingPhone: '0539999999' })),
    '0539999999'
  );
});

test('leadBillingPhone: falls back to patient phone when billingPhone empty', () => {
  assert.strictEqual(app.leadBillingPhone(lead({ phone: '0501111111', billingPhone: '' })), '0501111111');
  assert.strictEqual(app.leadBillingPhone(lead({ phone: '0501111111' })), '0501111111');
});

test('leadBillingPhone: empty when neither is set; safe on missing lead', () => {
  assert.strictEqual(app.leadBillingPhone(lead({})), '');
  assert.strictEqual(app.leadBillingPhone(null), '');
});

/* ===== resolveBillingPhone (selector choice → stored string) ===== */

test('resolveBillingPhone: מטופל → patient phone, פונה → contact phone, אחר → free input', () => {
  assert.strictEqual(app.resolveBillingPhone('patient', '0501111111', '0502222222', '0503333333'), '0501111111');
  assert.strictEqual(app.resolveBillingPhone('contact', '0501111111', '0502222222', '0503333333'), '0502222222');
  assert.strictEqual(app.resolveBillingPhone('other',   '0501111111', '0502222222', '0503333333'), '0503333333');
});

test('resolveBillingPhone: unknown/empty mode defaults to patient; trims whitespace', () => {
  assert.strictEqual(app.resolveBillingPhone('', '0501111111', '', ''), '0501111111');
  assert.strictEqual(app.resolveBillingPhone('other', '0501111111', '', '  0504444444  '), '0504444444');
});

/* ===== billingModeForLead (stored value → selector init) ===== */

// billingModeForLead returns an object created in the vm realm; deepStrictEqual
// checks the prototype (cross-realm mismatch), so assert the fields directly.
function assertMode(out, mode, other) {
  assert.strictEqual(out.mode, mode);
  assert.strictEqual(out.other, other);
}

test('billingModeForLead: unset billingPhone → default patient', () => {
  assertMode(app.billingModeForLead(lead({ phone: '0501111111' })), 'patient', '');
});

test('billingModeForLead: matches patient phone (normalized) → patient', () => {
  // Stored with +972 formatting but same number as the patient's 05x form.
  assertMode(app.billingModeForLead(lead({ phone: '050-111-1111', billingPhone: '+972 50 111 1111' })), 'patient', '');
});

test('billingModeForLead: matches contact phone (normalized) → contact', () => {
  // Same number as contactPhone, differently formatted (spaces) → still 'contact'.
  const out = app.billingModeForLead(lead({
    phone: '0501111111', contactPhone: '052-222-2222', billingPhone: '052 222 2222',
  }));
  assertMode(out, 'contact', '');
});

test('billingModeForLead: matches neither → other, carrying the raw value', () => {
  const out = app.billingModeForLead(lead({
    phone: '0501111111', contactPhone: '0502222222', billingPhone: '0539999999',
  }));
  assertMode(out, 'other', '0539999999');
});

/* Round-trip: init mode fed back through resolve reproduces the stored number. */
test('billingModeForLead → resolveBillingPhone round-trips the stored phone', () => {
  const l = lead({ phone: '0501111111', contactPhone: '0502222222', billingPhone: '0502222222' });
  const init = app.billingModeForLead(l);          // → contact
  const back = app.resolveBillingPhone(init.mode, l.phone, l.contactPhone, init.other);
  assert.strictEqual(app.normalizePhone(back), app.normalizePhone(l.billingPhone));
});

/* ===== leadMatchesQuery (search) ===== */

test('leadMatchesQuery: empty query matches everything', () => {
  assert.strictEqual(app.leadMatchesQuery(lead({}), ''), true);
});

test('leadMatchesQuery: matches on contactName (lowercased substring)', () => {
  const l = lead({ name: 'דני', contactName: 'רותי כהן' });
  assert.strictEqual(app.leadMatchesQuery(l, 'רותי'), true);
  assert.strictEqual(app.leadMatchesQuery(l, 'כהן'), true);
  assert.strictEqual(app.leadMatchesQuery(l, 'משהו אחר'), false);
});

test('leadMatchesQuery: matches contactPhone by normalized digits despite formatting', () => {
  const l = lead({ phone: '0501111111', contactPhone: '052-222-2222' });
  assert.strictEqual(app.leadMatchesQuery(l, '0522222222'), true);   // normalized hit
  assert.strictEqual(app.leadMatchesQuery(l, '052-222'), true);      // raw substring hit
});

test('leadMatchesQuery: matches billingPhone by normalized digits', () => {
  const l = lead({ phone: '0501111111', billingPhone: '+972 53 999 9999' });
  assert.strictEqual(app.leadMatchesQuery(l, '0539999999'), true);
});

test('leadMatchesQuery: patient-phone matching is unchanged (raw substring still works)', () => {
  const l = lead({ phone: '0501111111' });
  assert.strictEqual(app.leadMatchesQuery(l, '0501111111'), true);
  assert.strictEqual(app.leadMatchesQuery(l, '11111'), true);
  assert.strictEqual(app.leadMatchesQuery(l, '0777'), false);
});

/* ===== Invite URL uses the billing phone ===== */

test('invite URL targets billingPhone when set', () => {
  const l = lead({ phone: '0501111111', billingPhone: '0539999999' });
  const url = app.meetingInviteWaUrl(app.leadBillingPhone(l), 'hi');
  assert.ok(url.indexOf('wa.me/' + app.normalizePhone('0539999999')) !== -1,
    'URL must use the billing phone digits');
});

test('invite URL falls back to patient phone when billingPhone unset', () => {
  const l = lead({ phone: '0501111111', billingPhone: '' });
  const url = app.meetingInviteWaUrl(app.leadBillingPhone(l), 'hi');
  assert.ok(url.indexOf('wa.me/' + app.normalizePhone('0501111111')) !== -1,
    'URL must use the patient phone digits');
});
