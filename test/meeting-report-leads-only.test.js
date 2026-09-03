/* Meeting reports are visible on LEAD surfaces only (public/app.js).
 *
 * Bug fixed here: the דיווח מנהל strip (outcome chip, e.g. "התקיימה — מתלבט")
 * rendered on PATIENT cards in the תפוסה (occupancy) tab, via
 * patientReportBlockHTML → patient.fromLead → the retired lead in
 * state.leads. A report about a pre-admission meeting is wrong information on
 * an admitted patient's card, so the whole patient-card rendering path was
 * REMOVED (frontend-only; report rows in the sheet are untouched).
 *
 * Locked contracts:
 *   - the real renderPatients output contains NO meeting-report markup even
 *     when the patient's originating lead carries a report — in view AND edit
 *     mode (so edit/delete report actions are unreachable from patient cards);
 *   - the lead-surface renderer (meetingReportBlockHTML — used by the lead
 *     card, the meetings-board row, and refreshMeetingReportBlock) still shows
 *     the block, with unseen cue and edit-mode actions intact;
 *   - the removed patient-path helpers (patientReportBlockHTML /
 *     patientMeetingReportLead) and the .pt-report wrapper are gone from the
 *     shipped sources — source-scanned so they cannot quietly return.
 *
 * Same vm-sandbox approach as the sibling meeting-report tests, plus a
 * mini-DOM so the REAL renderPatients runs end-to-end. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/* ---------- mini-DOM: enough for renderPatients ---------- */
function fakeButton() {
  return { disabled: false, textContent: '', onclick: null, addEventListener() {} };
}
function fakeRow() {
  return {
    className: '',
    innerHTML: '',
    querySelector: () => fakeButton(),
    querySelectorAll: () => [],
    addEventListener() {},
  };
}
function fakeList() {
  return {
    innerHTML: '',
    children: [],
    appendChild(c) { this.children.push(c); },
  };
}

function loadApp() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const epilogue = `
    globalThis.__test = {
      setState(s) { Object.assign(state, s); },
      renderPatients: () => renderPatients(),
      meetingReportBlockHTML: (l) => meetingReportBlockHTML(l),
    };
  `;
  const noop = () => {};
  const dom = { list: fakeList(), rows: [] };
  const doc = {
    addEventListener: noop,
    getElementById: (id) => (id === 'patients-list' ? dom.list : null),
    createElement: () => { const r = fakeRow(); dom.rows.push(r); return r; },
    querySelectorAll: () => [],
  };
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/' },
    document: doc,
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    setTimeout: noop,
    URLSearchParams, Math, Date, JSON, Number, String, Array, Object, RegExp, Promise,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + epilogue, sandbox);
  return { app: sandbox.__test, dom };
}

/* An admitted lead retired to stage 'admitted' — its row and meetingReport*
 * fields stay in state.leads (retiring only flips the stage). */
function admittedLead(over) {
  return Object.assign({
    id: 'L1', name: 'דני', house: 'רמות השבים', stage: 'admitted',
    visitDate: '2026-08-25', meetingWith: 'אורן',
    meetingReportOutcome: 'undecided', meetingCompanion: 'mother',
    meetingNote: 'שיחה טובה', meetingReporter: 'חנן',
    meetingReportedAt: '2026-08-29T10:15:00.000Z', meetingSeen: '',
  }, over || {});
}
function patient(over) {
  return Object.assign({
    id: 'P1', houseId: 'ramot', name: 'דני', date: '2026-08-30',
    pay: 10000, adv: 0, status: 'trial', fromLead: 'L1',
  }, over || {});
}

const REPORT_MARKERS = ['mrv-report', 'pt-report', 'דיווח מנהל', 'mrv-outcome-badge',
  'data-mrv-toggle', 'data-mrv-edit', 'data-mrv-delete'];

function renderPatientRowsHTML(mode) {
  const { app, dom } = loadApp();
  app.setState({
    mode: mode,
    patients: [patient()],
    leads: [admittedLead()],   // the matching report EXISTS — and must not render
    currentHouseTab: 'ramot',
    patientSearch: '',
    showReleasedPatients: false,
  });
  app.renderPatients();
  assert.strictEqual(dom.list.children.length, 1, 'the patient row rendered');
  return dom.rows.map((r) => r.innerHTML).join('\n');
}

/* ===== patient cards: no report markup, ever ===== */

test('patient-card renderer output contains NO meeting-report markup even when a matching report exists (view mode)', () => {
  const html = renderPatientRowsHTML('view');
  assert.ok(html.includes('דני'), 'sanity: the patient row itself rendered');
  for (const marker of REPORT_MARKERS) {
    assert.ok(!html.includes(marker), `no "${marker}" on the patient card`);
  }
});

test('edit mode too: no report strip and no edit/delete report actions reachable from patient cards', () => {
  const html = renderPatientRowsHTML('edit');
  for (const marker of REPORT_MARKERS) {
    assert.ok(!html.includes(marker), `no "${marker}" on the patient card in edit mode`);
  }
});

/* ===== lead surfaces: unchanged ===== */

test('the lead-surface block still renders the report, with unseen cue and edit-mode actions', () => {
  const { app } = loadApp();
  app.setState({ mode: 'edit' });
  const html = app.meetingReportBlockHTML(admittedLead({ meetingSeen: '' }));
  assert.ok(html.includes('mrv-report') && html.includes('דיווח מנהל'), 'block renders');
  assert.ok(html.includes('mrv-badge-undecided'), 'outcome chip (התקיימה — מתלבט) intact');
  assert.ok(html.includes('mrv-unseen') && html.includes('mrv-dot'), 'unseen cue intact');
  assert.ok(html.includes('data-mrv-edit="L1"') && html.includes('data-mrv-delete="L1"'),
    'Vered\'s edit/delete actions stay on the lead surface');
  assert.ok(html.includes('data-mrv-toggle="L1"'), 'mark-seen toggle id intact');
});

test('view mode on the lead surface: block renders without actions', () => {
  const { app } = loadApp();
  app.setState({ mode: 'view' });
  const html = app.meetingReportBlockHTML(admittedLead());
  assert.ok(html.includes('mrv-report'));
  assert.ok(!html.includes('mrv-actions'), 'no actions outside edit mode');
});

/* ===== source scan: the patient path stays deleted ===== */

test('source-scan: the patient-card report path is gone from app.js and style.css', () => {
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const cssSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
  assert.ok(!/function patientReportBlockHTML/.test(appSrc), 'patientReportBlockHTML removed');
  assert.ok(!/function patientMeetingReportLead/.test(appSrc), 'patientMeetingReportLead removed');
  assert.ok(!appSrc.includes('pt-report'), 'no pt-report wrapper anywhere in app.js');
  assert.ok(!cssSrc.includes('pt-report'), 'no pt-report rule left in style.css');
});
