/* Tests for the meetings polish PR:
 *   1. step="900" on both visitTime inputs (lead-card inline + edit modal), and
 *      isoTime still round-trips a non-quarter value unchanged.
 *   2. the today-group class is applied to the correct day section and no other.
 *
 * public/app.js is a browser script; per the repo's vm-sandbox convention we
 * read the source, stub a minimal DOM, and drive the REAL render functions,
 * reading the HTML they emit. */

process.env.TZ = 'Asia/Jerusalem';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/* A fake DOM element: records innerHTML, tolerates the wiring calls
 * (querySelector(...).onclick = ...), and returns [] for querySelectorAll. */
function fakeEl() {
  return {
    className: '', dataset: {}, style: {}, textContent: '', disabled: false, value: '',
    _html: '',
    set innerHTML(v) { this._html = v; },
    get innerHTML() { return this._html; },
    appendChild() {}, addEventListener() {}, removeEventListener() {}, remove() {},
    setAttribute() {}, getAttribute() { return null; },
    set onclick(_f) {}, set onchange(_f) {}, set onsubmit(_f) {},
    querySelector() { return fakeEl(); },
    querySelectorAll() { return []; },
    classList: { add() {}, remove() {}, toggle() {} },
  };
}

function loadApp() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const board = fakeEl();
  const holder = { lastCreated: null };
  const doc = {
    getElementById(id) { return id === 'meetings-board' ? board : fakeEl(); },
    createElement() { const el = fakeEl(); holder.lastCreated = el; return el; },
    querySelectorAll() { return []; },
    addEventListener() {},
    body: fakeEl(),
  };
  const epilogue = `
    globalThis.__test = {
      buildLeadCard: (l) => buildLeadCard(l),
      openEditLeadModal: (l) => openEditLeadModal(l),
      renderMeetings: () => renderMeetings(),
      isoTime: (v) => isoTime(v),
      todayISO: () => todayISO(),
      weekStartSunday: (v) => weekStartSunday(v),
      addDaysISO: (v, n) => addDaysISO(v, n),
      formatDateDDMMYYYY: (v) => formatDateDDMMYYYY(v),
      // Mutate the real app.js state object so renderMeetings reads our fixtures.
      seedState: (patch) => { Object.assign(state, patch); },
    };
  `;
  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/' },
    document: doc,
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    URLSearchParams, Math, Date, JSON, Number, String, Array, Object, RegExp, Promise,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + epilogue, sandbox);
  return { app: sandbox.__test, board, created: () => holder.lastCreated };
}

function visitLead(over) {
  return Object.assign(
    { id: 'L1', name: 'דנה', stage: 'visit', house: '', source: '', note: '',
      phone: '', assignedTo: '', created: '2026-07-20',
      visitDate: '2026-07-27', visitTime: '08:18', meetingWith: '' },
    over || {}
  );
}

/* ===== 1. step="900" on the rendered visitTime inputs ===== */

test('lead-card inline visitTime input carries step="900"', () => {
  const { app } = loadApp();
  const card = app.buildLeadCard(visitLead());
  assert.match(card.innerHTML, /data-field="visitTime"/);
  assert.match(card.innerHTML, /<input type="time" step="900" data-field="visitTime"/);
});

test('edit-modal visitTime field renders step="900"', () => {
  const { app, created } = loadApp();
  app.openEditLeadModal(visitLead());
  const html = created().innerHTML;
  // Generic input renderer emits: <input name="visitTime" type="time" step="900" value="08:18" />
  assert.match(html, /name="visitTime" type="time" step="900"/);
});

/* ===== isoTime round-trips a non-quarter value unchanged ===== */

test('isoTime round-trips a non-quarter value (08:18) unchanged', () => {
  const { app } = loadApp();
  assert.strictEqual(app.isoTime('08:18'), '08:18');
  assert.strictEqual(app.isoTime('13:07'), '13:07');
  assert.strictEqual(app.isoTime('23:59'), '23:59');
  // After the visitTime corruption fix, isoTime uses LOCAL getters (consistent
  // with isoDate). The Sheets epoch artifact is normalized server-side now
  // (asISOTime_ in the spreadsheet tz — see visittime-corruption-fix.test.js);
  // a raw timestamp that still reaches the client is read on the local wall
  // clock, not via a UTC extraction. Expected value computed the same way the
  // implementation does, so this stays correct in any host timezone.
  const d = new Date('1899-12-30T08:18:20.000Z');
  const local = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  assert.strictEqual(app.isoTime('1899-12-30T08:18:20.000Z'), local);
});

/* ===== 2. today-group class on the correct day only ===== */

test('mtg-today class + badge go on today\'s section and no other', () => {
  const { app, board } = loadApp();
  const today = app.todayISO();
  const weekStart = app.weekStartSunday(today);
  // A second, different day guaranteed inside the same Sun–Sat week.
  const otherDay = today === weekStart ? app.addDaysISO(weekStart, 3) : weekStart;
  assert.notStrictEqual(otherDay, today);

  app.seedState({
    leads: [
      { id: 't', name: 'ליד היום', house: '', visitDate: today, visitTime: '09:00', meetingWith: '' },
      { id: 'o', name: 'ליד אחר', house: '', visitDate: otherDay, visitTime: '10:00', meetingWith: '' },
    ],
    houseManagers: {}, managerPhones: {}, mode: 'edit', meetingsWeekStart: weekStart,
  });
  app.renderMeetings();
  const html = board.innerHTML;

  // Exactly one today section and exactly one non-today section.
  assert.strictEqual((html.match(/class="mtg-day mtg-today"/g) || []).length, 1, 'one today section');
  assert.strictEqual((html.match(/class="mtg-day">/g) || []).length, 1, 'one non-today section');
  // Exactly one "היום" badge, immediately after today's date.
  assert.strictEqual((html.match(/mtg-today-badge/g) || []).length, 1);
  const todayDate = app.formatDateDDMMYYYY(today);
  assert.ok(
    html.includes(`${todayDate}<span class="mtg-today-badge">היום</span>`),
    'today badge follows today\'s date'
  );
  // The other day's date is NOT followed by the badge.
  const otherDate = app.formatDateDDMMYYYY(otherDay);
  assert.ok(
    !html.includes(`${otherDate}<span class="mtg-today-badge">`),
    'other day has no today badge'
  );
});
