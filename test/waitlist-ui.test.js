/* Tests for the waitlist stage UI (PR 2 of 2 — builds on the foundation PR,
 * which appended `waitlistedAt` to LEAD_COLUMNS and shipped STAGE_WAITLIST
 * gated out of the board).
 *
 * What this PR wires up, and what is locked here:
 *   - STAGES now renders רשימת המתנה between ביקור נקבע and בטיפול פעיל
 *     (placed there so every generic stage-move path works: visit's שלב הבא
 *     enters the waitlist, waitlist's שלב הבא reaches paid, and paid's admit
 *     action — keyed on the stage ID — is untouched);
 *   - moveLead stamps waitlistedAt (ISO timestamp) on the way IN, clears it
 *     on the way OUT, and rolls BOTH fields back when the save fails;
 *   - waitlistDayCount / waitlistBadgeText compute the Hebrew waiting badge
 *     by calendar-date diff (day 0 / 1 day / N days; blank → no badge, never
 *     NaN);
 *   - buildLeadCard shows the badge (and the house) on waitlist cards only.
 *
 * public/app.js is loaded in a vm sandbox with the browser globals stubbed,
 * per the repo convention (see waitlist-foundation.test.js). moveLead's
 * collaborators (renderAll / saveAll / showError) are top-level script
 * declarations, i.e. writable globals in the sandbox realm, so the tests
 * swap them for stubs and exercise the REAL shipped moveLead. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const arr = (x) => Array.from(x); // copy a sandbox-realm array into this realm

/* ---------- load public/app.js (with a DOM stub) ---------- */
function fakeEl() {
  return {
    className: '', dataset: {}, style: {}, _html: '', children: [],
    set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; },
    appendChild(child) { this.children.push(child); }, addEventListener() {}, remove() {},
    set onclick(_f) {}, set onchange(_f) {}, set onsubmit(_f) {},
    querySelector() { return fakeEl(); }, querySelectorAll() { return []; },
    classList: { add() {}, remove() {}, toggle() {} },
  };
}
function loadApp() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const byId = {}; // id → the fake element renderKanban etc. mutate
  const doc = {
    getElementById: (id) => (byId[id] || (byId[id] = fakeEl())),
    createElement: () => fakeEl(),
    querySelectorAll: () => [], addEventListener() {}, body: fakeEl(),
  };
  const epilogue = `globalThis.__test = {
    STAGES: STAGES,
    ALL_STAGES_FOR_PIPELINE: ALL_STAGES_FOR_PIPELINE,
    normalizeLead: (l) => normalizeLead(l),
    waitlistDayCount: (w, n) => waitlistDayCount(w, n),
    waitlistBadgeText: (w, n) => waitlistBadgeText(w, n),
    buildLeadCard: (l) => buildLeadCard(l),
    renderKanban: () => renderKanban(),
    moveLead: (l, s) => moveLead(l, s),
    state: state,
    stub: (name, fn) => { globalThis[name] = fn; },
  };`;
  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/' },
    document: doc, localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    URLSearchParams, Math, Date, JSON, Number, String, Array, Object, RegExp, Promise,
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + epilogue, sandbox);
  return { app: sandbox.__test, byId };
}

const { app } = loadApp();

/* ===== Stage list / board ===== */

test('STAGES renders waitlist between visit and paid; pipeline strip inherits it', () => {
  assert.deepStrictEqual(arr(app.STAGES).map((s) => s.id),
    ['new', 'visit', 'waitlist', 'paid'],
    'board columns must be new → visit → waitlist → paid');
  const wl = arr(app.STAGES).find((s) => s.id === 'waitlist');
  assert.strictEqual(wl.label, 'רשימת המתנה');
  assert.deepStrictEqual(arr(app.ALL_STAGES_FOR_PIPELINE).map((s) => s.id),
    ['new', 'visit', 'waitlist', 'paid', 'irrelevant'],
    'pipeline strip must carry the board stages plus irrelevant');
});

test('the ACTUAL rendered kanban shows the רשימת המתנה column with its card in place', () => {
  const { app, byId } = loadApp();
  app.state.leads = [
    app.normalizeLead({ id: 'L1', name: 'א', stage: 'new' }),
    app.normalizeLead({ id: 'L2', name: 'ב', house: 'רמות השבים',
      stage: 'waitlist', waitlistedAt: new Date().toISOString() }),
  ];
  app.renderKanban();
  const cols = byId['kanban'].children;
  assert.deepStrictEqual(cols.map((c) => c.dataset.stage), ['new', 'visit', 'waitlist', 'paid']);
  const wlCol = cols[2];
  assert.ok(wlCol.innerHTML.includes('רשימת המתנה'), 'column header shows the stage label');
  assert.strictEqual(wlCol.children.length, 1, 'the waitlist lead renders in its column');
  assert.ok(wlCol.children[0].innerHTML.includes('רמות השבים'),
    'the card shows the house the lead is waiting for');
});

/* ===== moveLead stamp / clear / rollback ===== */

function freshMover() {
  const { app } = loadApp();
  app.stub('renderAll', () => {});
  app.stub('showError', () => {});
  return app;
}

test('moving INTO the waitlist stamps waitlistedAt with an ISO timestamp', async () => {
  const app = freshMover();
  app.stub('saveAll', async () => {});
  const lead = { id: 'L1', name: 'x', stage: 'visit', waitlistedAt: '' };
  await app.moveLead(lead, 'waitlist');
  assert.strictEqual(lead.stage, 'waitlist');
  assert.match(lead.waitlistedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    'waitlistedAt must be a full ISO timestamp string');
});

test('moving OUT of the waitlist clears waitlistedAt; re-entry restamps', async () => {
  const app = freshMover();
  app.stub('saveAll', async () => {});
  const lead = { id: 'L1', name: 'x', stage: 'waitlist', waitlistedAt: '2026-08-01T10:00:00.000Z' };

  await app.moveLead(lead, 'paid');            // forward out
  assert.strictEqual(lead.stage, 'paid');
  assert.strictEqual(lead.waitlistedAt, '', 'leaving the stage must clear the stamp');

  await app.moveLead(lead, 'waitlist');        // back in → fresh stamp
  assert.match(lead.waitlistedAt, /^\d{4}-\d{2}-\d{2}T/, 're-entry must restamp');
  assert.notStrictEqual(lead.waitlistedAt, '2026-08-01T10:00:00.000Z');

  await app.moveLead(lead, 'visit');           // backward out clears too
  assert.strictEqual(lead.waitlistedAt, '');
});

test('a failed save rolls back BOTH stage and waitlistedAt (move in)', async () => {
  const app = freshMover();
  app.stub('saveAll', async () => { throw new Error('boom'); });
  const lead = { id: 'L1', name: 'x', stage: 'visit', waitlistedAt: '' };
  await app.moveLead(lead, 'waitlist');
  assert.strictEqual(lead.stage, 'visit', 'stage must roll back');
  assert.strictEqual(lead.waitlistedAt, '', 'stamp must roll back');
});

test('a failed save rolls back BOTH stage and waitlistedAt (move out)', async () => {
  const app = freshMover();
  app.stub('saveAll', async () => { throw new Error('boom'); });
  const stamp = '2026-08-01T10:00:00.000Z';
  const lead = { id: 'L1', name: 'x', stage: 'waitlist', waitlistedAt: stamp };
  await app.moveLead(lead, 'paid');
  assert.strictEqual(lead.stage, 'waitlist', 'stage must roll back');
  assert.strictEqual(lead.waitlistedAt, stamp, 'the original stamp must survive');
});

test('a move that never touches the waitlist leaves waitlistedAt alone', async () => {
  const app = freshMover();
  app.stub('saveAll', async () => {});
  const lead = { id: 'L1', name: 'x', stage: 'new', waitlistedAt: '' };
  await app.moveLead(lead, 'visit');
  assert.strictEqual(lead.stage, 'visit');
  assert.strictEqual(lead.waitlistedAt, '');
});

/* ===== Badge day-count + Hebrew label ===== */

test('day 0 → "ממתין מהיום" (same calendar day, hour diff irrelevant)', () => {
  // Mid-day UTC timestamp: same local calendar day for any realistic test TZ.
  assert.strictEqual(app.waitlistDayCount('2026-08-12T12:00:00.000Z', '2026-08-12'), 0);
  assert.strictEqual(app.waitlistBadgeText('2026-08-12T12:00:00.000Z', '2026-08-12'), 'ממתין מהיום');
  // Bare-date stamp, same day.
  assert.strictEqual(app.waitlistBadgeText('2026-08-12', '2026-08-12'), 'ממתין מהיום');
});

test('1 day → "ממתין יום אחד" (singular)', () => {
  assert.strictEqual(app.waitlistDayCount('2026-08-11', '2026-08-12'), 1);
  assert.strictEqual(app.waitlistBadgeText('2026-08-11', '2026-08-12'), 'ממתין יום אחד');
});

test('N days → "ממתין N ימים" (plural), a DATE diff not an hour diff', () => {
  assert.strictEqual(app.waitlistDayCount('2026-08-01', '2026-08-12'), 11);
  assert.strictEqual(app.waitlistBadgeText('2026-08-01', '2026-08-12'), 'ממתין 11 ימים');
  assert.strictEqual(app.waitlistBadgeText('2026-08-10', '2026-08-12'), 'ממתין 2 ימים');
  // Crosses a month boundary.
  assert.strictEqual(app.waitlistBadgeText('2026-07-30', '2026-08-02'), 'ממתין 3 ימים');
});

test('blank / unparseable waitlistedAt → no badge, never NaN', () => {
  assert.strictEqual(app.waitlistDayCount('', '2026-08-12'), null);
  assert.strictEqual(app.waitlistDayCount(undefined, '2026-08-12'), null);
  assert.strictEqual(app.waitlistBadgeText('', '2026-08-12'), '');
  assert.strictEqual(app.waitlistBadgeText(undefined, '2026-08-12'), '');
  const garbage = app.waitlistBadgeText('not-a-date', '2026-08-12');
  assert.strictEqual(garbage, '');
  assert.ok(!garbage.includes('NaN'));
});

test('a future-dated stamp (clock skew) clamps to day 0, never negative', () => {
  assert.strictEqual(app.waitlistDayCount('2026-08-15', '2026-08-12'), 0);
  assert.strictEqual(app.waitlistBadgeText('2026-08-15', '2026-08-12'), 'ממתין מהיום');
});

/* ===== Card badge rendering ===== */

test('a waitlist card renders the badge and keeps the house visible', () => {
  const { app } = loadApp();
  const card = app.buildLeadCard({
    id: 'L1', name: 'מטופל', phone: '0501234567', house: 'שדה אליעזר',
    stage: 'waitlist', waitlistedAt: new Date().toISOString(),
  });
  assert.ok(card.innerHTML.includes('lc-wait-badge'), 'badge element must render');
  assert.ok(card.innerHTML.includes('ממתין מהיום'), 'a just-stamped lead waits from today');
  assert.ok(card.innerHTML.includes('שדה אליעזר'),
    'the house label (which house they wait for) stays visible');
  assert.ok(!card.innerHTML.includes('NaN'));
});

test('a waitlist card with a blank stamp (legacy/edge) renders NO badge and no NaN', () => {
  const { app } = loadApp();
  const card = app.buildLeadCard({
    id: 'L2', name: 'מטופל', phone: '', house: 'רעננה אשר',
    stage: 'waitlist', waitlistedAt: '',
  });
  assert.ok(!card.innerHTML.includes('lc-wait-badge'), 'no badge without a stamp');
  assert.ok(!card.innerHTML.includes('ממתין'));
  assert.ok(!card.innerHTML.includes('NaN'));
});

test('non-waitlist cards never render the badge, even with a stray stamp', () => {
  const { app } = loadApp();
  const card = app.buildLeadCard({
    id: 'L3', name: 'מטופל', phone: '', house: '',
    stage: 'new', waitlistedAt: '2026-08-01T10:00:00.000Z',
  });
  assert.ok(!card.innerHTML.includes('lc-wait-badge'));
});
