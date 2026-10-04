/* Name picker (RETIRED in personal PINs PR C) + stale-save conflict refusal (PR 2a).
 *
 * PR C (2026-10-04) removed the shared APP_PIN and with it the «מי מתחבר/ת?»
 * picker: the session name is now the personal record's own name. Sections
 * A, B and D pin that the picker is gone; section C (the conflict refusal) is
 * unchanged.
 *
 * Context under test: PR #112 gave Patients a persisted `id`; PR #113 added
 * updatedAt/updatedBy stamping and a tamper-proof `user` inside the signed
 * session cookie. This change makes it visible: each person identifies once
 * per device (a fixed-name picker after the PIN), and a stale tab can no
 * longer overwrite a newer edit (the id-match branch refuses a save whose
 * echoed updatedAt no longer matches the sheet's).
 *
 * Locked contracts:
 *   - the user list exists ONCE per side and cannot drift: lib/users.js
 *     SESSION_USERS === app.js SESSION_USERS === app.js ASSIGNEE_OPTIONS
 *     (the names came from the assignedTo dropdown, not invented);
 *   - /api/verify-pin accepts `user` ONLY from the list
 *     (validateSessionUser: sanitize → allow-list → '' otherwise); a picker
 *     re-issue keeps the default 7-day TTL; /api/me returns the chosen name;
 *   - id-match conflict refusal: stale seenStamp + REAL change → the sheet
 *     row survives byte-for-byte, `conflicts` carries {id, name, houseId,
 *     sheetUpdatedAt, sheetUpdatedBy, changed}, patient_save_conflict is
 *     audited, and NO patient_edited fires; meta-only differences, an empty
 *     seenStamp (pre-#113 tab), an empty sheetStamp (never-stamped row), and
 *     a matching stamp all keep today's behavior; the key-match / rename /
 *     append branches never refuse; saveAll_ aggregates conflicts across
 *     houses and omits the field entirely when none;
 *   - client: conflictsMessage formats names + updatedBy (never silent,
 *     never auto-retried), saveAllResponseNeedsResync reloads on conflicts,
 *     the picker shows only when /api/me answers an EMPTY user, and the
 *     header renders 'מחובר/ת כ: <name> · החלף'.
 *
 * vm-sandbox on the REAL shipped Code.gs / app.js — per repo convention. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const arr = (x) => Array.from(x);
const plain = (x) => JSON.parse(JSON.stringify(x));

/* ================= shared source ================= */

const GS_SRC = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
const APP_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const users = require('../lib/users');

/* Parse a const string-array literal out of app.js source. */
function appConst(name) {
  const m = APP_SRC.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`));
  assert.ok(m, name + ' not found in app.js');
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

/* ================= A. the picker list is gone ================= */

test('PR C: no SESSION_USERS anywhere — the login name comes from the personal record', () => {
  assert.strictEqual(users.SESSION_USERS, undefined, 'lib/users.js no longer exports a picker list');
  assert.ok(!/const SESSION_USERS = /.test(APP_SRC), 'app.js no longer has a picker list');
  assert.deepStrictEqual(appConst('ASSIGNEE_OPTIONS'), ['ורד', 'שירן', 'יעל'], 'the assignedTo dropdown is untouched');
});

/* ================= B. server: the re-issue path is gone ================= */

const SECRET = 'test-session-secret-0123456789abcdef0123456789';
process.env.SESSION_SECRET = SECRET; // before server.js is required
require('./helpers/personal-session').applyPersonalEnv();
const { createSessionToken } = require('../lib/session');
const server = require('../server');

test('PR C: validateSessionUser is gone, and a picker-style cookie (a name, no id) is not a session', () => {
  assert.strictEqual(server.validateSessionUser, undefined);
  const token = createSessionToken(SECRET, undefined, undefined, 'ורד');
  assert.strictEqual(server.sessionUserFromRequest({ headers: { cookie: 'ezone_session=' + token } }), '');
});

/* ================= C. Code.gs: conflict refusal (vm harness as sibling suites) ================= */

let opSeq = 0;
function fakeSheet(headerRow, dataRows) {
  const grid = [headerRow.slice()].concat((dataRows || []).map((r) => r.slice()));
  const ops = [];
  let hidden = false;
  return {
    grid, ops,
    getLastRow() { return grid.length; },
    getLastColumn() { return grid[0] ? grid[0].length : 0; },
    getMaxRows() { return Math.max(grid.length, 1000); },
    setFrozenRows() {},
    hideSheet() { hidden = true; },
    isSheetHidden() { return hidden; },
    appendRow(row) { grid.push(row.slice()); },
    getRange(r, c, nr, nc) {
      nr = nr || 1; nc = nc || 1;
      return {
        setNumberFormat(fmt) { ops.push({ op: 'fmt', seq: ++opSeq, r, c, nr, nc, fmt }); },
        getValue() { const g = grid[r - 1]; return g ? (g[c - 1] === undefined ? '' : g[c - 1]) : ''; },
        setValue(v) {
          ops.push({ op: 'setcell', seq: ++opSeq, r, c });
          if (!grid[r - 1]) grid[r - 1] = [];
          grid[r - 1][c - 1] = v;
        },
        getValues() {
          const out = [];
          for (let i = 0; i < nr; i++) {
            const row = [];
            for (let j = 0; j < nc; j++) { const g = grid[r - 1 + i]; row.push(g ? (g[c - 1 + j] === undefined ? '' : g[c - 1 + j]) : ''); }
            out.push(row);
          }
          return out;
        },
        setValues(vals) {
          ops.push({ op: 'set', seq: ++opSeq, r, c, nr, nc });
          for (let i = 0; i < vals.length; i++) {
            if (!grid[r - 1 + i]) grid[r - 1 + i] = [];
            for (let j = 0; j < vals[i].length; j++) grid[r - 1 + i][c - 1 + j] = vals[i][j];
          }
        },
        clearContent() {
          ops.push({ op: 'clear', seq: ++opSeq, r, c, nr, nc });
          for (let i = 0; i < nr; i++) {
            if (!grid[r - 1 + i]) continue;
            for (let j = 0; j < nc; j++) grid[r - 1 + i][c - 1 + j] = '';
          }
        },
      };
    },
  };
}

function loadCode() {
  const noop = () => {};
  let uuid = 0;
  const logs = [];
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    JSON, Math, Date, Number, String, Array, Object, RegExp,
    Logger: { log: (m) => logs.push(String(m)) },
    __sheets: {},
    __digestSheets: {},
    __props: {},
    __logs: logs,
  };
  sandbox.SpreadsheetApp = {
    getActiveSpreadsheet: () => ({
      getSheetByName: (name) => sandbox.__sheets[name] || null,
      insertSheet: (name) => (sandbox.__sheets[name] = fakeSheet([], [])),
      getSpreadsheetTimeZone: () => 'Asia/Jerusalem',
    }),
    openById: () => ({
      getSheetByName: (name) => sandbox.__digestSheets[name] || null,
      insertSheet: (name) => (sandbox.__digestSheets[name] = fakeSheet([], [])),
    }),
  };
  sandbox.PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (k) => (k in sandbox.__props ? sandbox.__props[k] : null),
      setProperty(k, v) { sandbox.__props[k] = v; return this; },
    }),
  };
  sandbox.ContentService = {
    createTextOutput: (s) => ({ setMimeType: () => ({ json: JSON.parse(s) }) }),
    MimeType: { JSON: 'json' },
  };
  sandbox.Utilities = {
    getUuid: () => 'uuid-' + (++uuid),
    formatDate: (d) => d.toISOString().slice(0, 10),
  };
  sandbox.LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock: noop }) };
  sandbox.globalThis = sandbox;
  const epilogue = `globalThis.__test = {
    PATIENT_COLUMNS: PATIENT_COLUMNS,
    PATIENTS_SHEET: PATIENTS_SHEET,
    AUDIT_LOG_COLUMNS: AUDIT_LOG_COLUMNS,
    AUDIT_LOG_SHEET: AUDIT_LOG_SHEET,
    readSheet: (sh, cols) => readSheet_(sh, cols),
    saveAll: (l, p, u) => saveAll_(l, p, u),
  };`;
  vm.createContext(sandbox);
  vm.runInContext(GS_SRC + epilogue, sandbox);
  return { code: sandbox.__test, sandbox };
}

function rowOf(cols, fields) {
  const row = cols.map(() => '');
  Object.keys(fields).forEach((k) => { row[cols.indexOf(k)] = fields[k]; });
  return row;
}
function seedPatients(code, sandbox, rows) {
  sandbox.__sheets[code.PATIENTS_SHEET] = fakeSheet(arr(code.PATIENT_COLUMNS), rows.map((f) => rowOf(arr(code.PATIENT_COLUMNS), f)));
  return sandbox.__sheets[code.PATIENTS_SHEET];
}
function patientsOf(code, sandbox) {
  return code.readSheet(sandbox.__sheets[code.PATIENTS_SHEET], arr(code.PATIENT_COLUMNS));
}
function auditOf(code, sandbox) {
  const sh = sandbox.__sheets[code.AUDIT_LOG_SHEET];
  return sh ? code.readSheet(sh, arr(code.AUDIT_LOG_COLUMNS)) : [];
}

const T0 = '2026-09-01T08:00:00.000Z';
const T_OLD = '2026-08-01T08:00:00.000Z';
const SARA = { houseId: 'ramot', name: 'שרה כהן', date: '2026-07-01',
               pay: 9000, adv: 0, status: 'active', source: 'lead',
               id: 'id-sara', updatedAt: T0, updatedBy: 'ורד' };

test('stale stamp + real change → REFUSED: sheet row survives byte-for-byte, conflicts populated, audited, no patient_edited', () => {
  const { code, sandbox } = loadCode();
  seedPatients(code, sandbox, [SARA]);
  const before = plain(patientsOf(code, sandbox));

  const res = code.saveAll(null, { ramot: [
    Object.assign({}, SARA, { pay: 9500, updatedAt: T_OLD }), // loaded before ורד's save
  ] }, 'דנה');

  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(plain(patientsOf(code, sandbox)), before, 'the sheet version won — nothing written');
  assert.deepStrictEqual(plain(res.conflicts), [{
    id: 'id-sara', name: 'שרה כהן', houseId: 'ramot',
    sheetUpdatedAt: T0, sheetUpdatedBy: 'ורד', changed: ['pay'],
  }]);
  const audit = auditOf(code, sandbox);
  const conflict = audit.find((a) => a.action === 'patient_save_conflict');
  const d = JSON.parse(conflict.details);
  assert.deepStrictEqual(
    { id: d.id, seenUpdatedAt: d.seenUpdatedAt, sheetUpdatedAt: d.sheetUpdatedAt, updatedBy: d.updatedBy, changed: plain(d.changed) },
    { id: 'id-sara', seenUpdatedAt: T_OLD, sheetUpdatedAt: T0, updatedBy: 'דנה', changed: ['pay'] });
  assert.ok(!audit.some((a) => a.action === 'patient_edited'), 'a refused save is not an edit');
});

test('stale stamp + meta-only echo → NO refusal (unchanged content is just an echo)', () => {
  const { code, sandbox } = loadCode();
  seedPatients(code, sandbox, [SARA]);
  const before = plain(patientsOf(code, sandbox));
  const res = code.saveAll(null, { ramot: [
    Object.assign({}, SARA, { updatedAt: T_OLD, updatedBy: 'האקר' }), // stale stamps, same content
  ] }, 'דנה');
  assert.ok(!res.conflicts, 'no conflicts field on a conflict-free save');
  assert.deepStrictEqual(plain(patientsOf(code, sandbox)), before);
});

test('empty seenStamp (pre-stamping tab) + change → last-writer-wins as today, stamped from the user', () => {
  const { code, sandbox } = loadCode();
  seedPatients(code, sandbox, [SARA]);
  const res = code.saveAll(null, { ramot: [
    Object.assign({}, SARA, { pay: 9500, updatedAt: '', updatedBy: '' }),
  ] }, 'דנה');
  assert.ok(!res.conflicts);
  const after = patientsOf(code, sandbox)[0];
  assert.deepStrictEqual({ pay: after.pay, updatedBy: after.updatedBy }, { pay: 9500, updatedBy: 'דנה' });
});

test('empty sheetStamp (never-stamped row) + change → no refusal', () => {
  const { code, sandbox } = loadCode();
  seedPatients(code, sandbox, [Object.assign({}, SARA, { updatedAt: '', updatedBy: '' })]);
  const res = code.saveAll(null, { ramot: [
    Object.assign({}, SARA, { pay: 9500, updatedAt: T_OLD }), // seen stamp nonsense, sheet has none
  ] }, 'דנה');
  assert.ok(!res.conflicts);
  assert.strictEqual(patientsOf(code, sandbox)[0].pay, 9500);
});

test('fresh (matching) stamp + change → normal stamped write, no conflicts', () => {
  const { code, sandbox } = loadCode();
  seedPatients(code, sandbox, [SARA]);
  const res = code.saveAll(null, { ramot: [Object.assign({}, SARA, { pay: 9500 })] }, 'דנה');
  assert.ok(!res.conflicts);
  const after = patientsOf(code, sandbox)[0];
  assert.deepStrictEqual({ pay: after.pay, updatedBy: after.updatedBy }, { pay: 9500, updatedBy: 'דנה' });
});

test('KEY-MATCH path (id-less payload) is unaffected: stale stamps still write — refusal is id-match ONLY', () => {
  const { code, sandbox } = loadCode();
  seedPatients(code, sandbox, [SARA]);
  const res = code.saveAll(null, { ramot: [
    Object.assign({}, SARA, { id: '', pay: 9500, updatedAt: T_OLD }), // no id → key match
  ] }, 'דנה');
  assert.ok(!res.conflicts, 'key-match never refuses (a pre-#112 tab must keep saving)');
  const after = patientsOf(code, sandbox)[0];
  assert.deepStrictEqual({ pay: after.pay, id: after.id, updatedBy: after.updatedBy },
    { pay: 9500, id: 'id-sara', updatedBy: 'דנה' });
});

test('saveAll_ aggregates conflicts ACROSS houses; the field is absent when no house conflicted', () => {
  const { code, sandbox } = loadCode();
  const TAMAR = { houseId: 'arfoni', name: 'תמר גל', date: '2026-06-01',
                  pay: 8000, adv: 0, status: 'active', source: 'lead',
                  id: 'id-tamar', updatedAt: T0, updatedBy: 'שירן' };
  seedPatients(code, sandbox, [SARA, TAMAR]);
  const res = code.saveAll(null, {
    ramot:  [Object.assign({}, SARA,  { pay: 9500, updatedAt: T_OLD })],
    arfoni: [Object.assign({}, TAMAR, { pay: 8500, updatedAt: T_OLD })],
  }, 'דנה');
  assert.strictEqual(res.conflicts.length, 2);
  assert.deepStrictEqual(plain(res.conflicts.map((c) => c.id)).sort(), ['id-sara', 'id-tamar']);

  const res2 = code.saveAll(null, { ramot: [Object.assign({}, SARA)] }, 'דנה');
  assert.ok(!('conflicts' in res2), 'additive: absent when none — old clients and Managers see nothing new');
});

/* ================= D. client: message, resync, header (no picker) ================= */

function fakeEl(id) {
  const el = {
    id, children: [], _text: '',
    classes: new Set(id === 'app' ? [] : ['hidden']),
    classList: {
      add: (c) => el.classes.add(c),
      remove: (c) => el.classes.delete(c),
      toggle: (c, on) => { if (on) el.classes.add(c); else el.classes.delete(c); },
      contains: (c) => el.classes.has(c),
    },
    set textContent(v) { el._text = String(v); el.children.length = 0; },
    get textContent() {
      return el._text + el.children.map((c) => (c && c.textContent !== undefined ? c.textContent : '')).join('');
    },
    set innerHTML(v) { el._text = String(v); el.children.length = 0; },
    get innerHTML() { return el._text; },
    appendChild(c) { el.children.push(c); },
    addEventListener() {},
    focus() {},
    value: '',
    disabled: false,
    onclick: null,
    /* Attribute API: busyButton guards re-entry on aria-busy, which a real
     * <button> supports and this fake must too. */
    _attrs: {},
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(el._attrs, k) ? el._attrs[k] : null; },
    setAttribute(k, v) { el._attrs[k] = String(v); },
    removeAttribute(k) { delete el._attrs[k]; },
  };
  return el;
}

function loadApp() {
  const noop = () => {};
  const els = {};
  const byId = (id) => (els[id] || (els[id] = fakeEl(id)));
  const doc = {
    addEventListener: noop,
    getElementById: byId,
    createElement: (tag) => fakeEl('<' + tag + '>'),
    createTextNode: (t) => ({ textContent: String(t) }),
    querySelectorAll: () => [],
  };
  const fetchCalls = [];
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/', reload: noop },
    document: doc,
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    setTimeout: noop,
    URLSearchParams,
    Math, Date, JSON, Number, String, Array, Object, RegExp, Promise,
    __els: els,
    __fetchCalls: fetchCalls,
    __me: { ok: true, user: '' },
    fetch: async (url, opts) => {
      fetchCalls.push({ url, opts });
      if (url === '/api/me') return { ok: true, json: async () => sandbox.__me };
      return { ok: true, json: async () => ({ ok: true }) };
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  const epilogue = `
    globalThis.__test = {
      conflictsMessage,
      saveAllResponseNeedsResync,
      renderWhoami,
      checkSessionUser,
      stubEnterApp(fn) { enterApp = fn; },
      stubShowPin(fn) { showPinScreen = fn; },
    };
  `;
  vm.createContext(sandbox);
  vm.runInContext(APP_SRC + epilogue, sandbox);
  return { app: sandbox.__test, sandbox };
}

test('conflictsMessage: null without conflicts; formats patient names + who saved first; dedups; blank updatedBy fallback', () => {
  const { app } = loadApp();
  assert.strictEqual(app.conflictsMessage(null), null);
  assert.strictEqual(app.conflictsMessage({}), null);
  assert.strictEqual(app.conflictsMessage({ conflicts: [] }), null);

  const one = app.conflictsMessage({ conflicts: [{ name: 'שרה כהן', sheetUpdatedBy: 'ורד' }] });
  assert.strictEqual(one, 'השינוי ל־שרה כהן לא נשמר — ורד עדכן/ה קודם. הנתונים רועננו.');

  const many = app.conflictsMessage({ conflicts: [
    { name: 'שרה כהן', sheetUpdatedBy: 'ורד' },
    { name: 'תמר גל', sheetUpdatedBy: 'ורד' },
  ] });
  assert.ok(many.includes('שרה כהן, תמר גל') && many.includes('— ורד עדכן/ה'), 'names joined, user deduped: ' + many);

  const anon = app.conflictsMessage({ conflicts: [{ name: 'שרה כהן', sheetUpdatedBy: '' }] });
  assert.ok(anon.includes('משתמש/ת אחר/ת'), 'blank updatedBy (legacy stamp) gets the neutral fallback');
});

test('saveAllResponseNeedsResync: a non-empty conflicts array triggers the same reload as preserved', () => {
  const { app } = loadApp();
  assert.strictEqual(app.saveAllResponseNeedsResync({ conflicts: [{ id: 'x' }] }), true);
  assert.strictEqual(app.saveAllResponseNeedsResync({ conflicts: [] }), false);
  assert.strictEqual(app.saveAllResponseNeedsResync({}), false);
});

test('PR C: the picker screen and its re-issue are gone from the client', () => {
  assert.ok(!/function showUserPicker|function afterPinSuccess|user-options'|'user-screen'/.test(APP_SRC));
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.ok(!/id="user-screen"|id="user-options"/.test(html));
});

test('renderWhoami: header shows מחובר/ת כ + the name + a החלף control; blank name hides the line', () => {
  const { app, sandbox } = loadApp();
  app.renderWhoami('ורד');
  const el = sandbox.__els['whoami'];
  assert.strictEqual(el.classList.contains('hidden'), false);
  assert.ok(el.textContent.includes('מחובר/ת כ') && el.textContent.includes('ורד') && el.textContent.includes('החלף'),
    'got: ' + el.textContent);
  app.renderWhoami('');
  assert.strictEqual(el.classList.contains('hidden'), true, 'legacy user-less session shows nothing');
});

test('a user-less /api/me (cannot happen for a personal session) goes to the login screen; a named one renders the header', async () => {
  const { app, sandbox } = loadApp();
  let pinShown = 0;
  app.stubShowPin(() => { pinShown++; });
  sandbox.__me = { ok: true, user: '' };
  await app.checkSessionUser();
  assert.strictEqual(pinShown, 1, 'user-less → the login screen');

  const named = loadApp();
  let pinShown2 = 0;
  named.app.stubShowPin(() => { pinShown2++; });
  named.sandbox.__me = { ok: true, user: 'יעל' };
  await named.app.checkSessionUser();
  assert.strictEqual(pinShown2, 0, 'a named session never re-prompts');
  assert.ok(named.sandbox.__els['whoami'].textContent.includes('יעל'));
});
