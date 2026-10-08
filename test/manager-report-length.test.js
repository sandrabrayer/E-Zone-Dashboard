/* Tests for the manager report's פירוט length cap (raised 2,000 → 5,000).
 *
 * The field is the free-text פירוט of the דיווח מנהל block — written by house
 * managers on /meeting-report, corrected by Vered in the dashboard's edit
 * modal, stored in the Leads sheet's meetingNote column. Four layers carry the
 * cap and they must never drift:
 *
 *   public/meeting-report.js  MANAGER_REPORT_MAX_CHARS  (manager form)
 *   public/app.js             MANAGER_REPORT_MAX_CHARS  (Vered's edit modal)
 *   server.js                 MANAGER_REPORT_MAX_CHARS  (proxy pre-check)
 *   apps-script/Code.gs       MANAGER_REPORT_MAX_CHARS  (the authority)
 *
 * What is locked in here:
 *   - all four constants are exactly 5000, and a SOURCE SCAN proves no other
 *     numeric literal caps this field anywhere (the old 2000 is gone, the
 *     warn threshold is derived, the textarea maxlength comes from the
 *     constant);
 *   - 4,999 and 5,000 Hebrew chars are ACCEPTED at every layer; 5,001 is
 *     REJECTED — never silently truncated, and nothing lands on the sheet;
 *   - a 5,000-char Hebrew string round-trips through the write + read-back
 *     with no U+FFFD (the ecosystem's corruption marker);
 *   - the stored report renders escaped, with its line breaks, and with no
 *     rule that could clip it;
 *   - only the WhatsApp message is shortened, and only when the wa.me URL
 *     would blow past MR_WA_URL_MAX.
 *
 * Code.gs and app.js are vm-sandbox-loaded per the repo convention (see
 * test/meeting-report-backend.test.js); meeting-report.js and server.js are
 * plain requires. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-0123456789abcdef0123456789';
process.env.MEETING_REPORT_PIN = process.env.MEETING_REPORT_PIN || '123456';
process.env.MEETING_REPORT_SECRET = process.env.MEETING_REPORT_SECRET || 'mr-shared-secret-for-tests';

const mr = require('../public/meeting-report.js');
const server = require('../server');

const MAX = 5000;
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const heb = (n) => 'ש'.repeat(n);

/* ---------- public/app.js in the repo's vm sandbox ---------- */
function loadApp() {
  const src = read('public', 'app.js');
  const epilogue = `globalThis.__test = {
    MANAGER_REPORT_MAX_CHARS: MANAGER_REPORT_MAX_CHARS,
    MANAGER_REPORT_WARN_CHARS: MANAGER_REPORT_WARN_CHARS,
    managerReportCounterText: (n) => managerReportCounterText(n),
    managerReportCounterWarn: (n) => managerReportCounterWarn(n),
    validateMeetingReportEdit: (v) => validateMeetingReportEdit(v),
    meetingReportEditModalHTML: (l) => meetingReportEditModalHTML(l),
    meetingReportBlockHTML: (l) => meetingReportBlockHTML(l),
    setMode(m) { state.mode = m; },
  };`;
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

/* ---------- apps-script/Code.gs with the GAS globals stubbed ---------- */
function fakeSheet(headerRow, dataRows) {
  const grid = [headerRow.slice()].concat((dataRows || []).map((r) => r.slice()));
  return {
    grid,
    getLastRow() { return grid.length; },
    getLastColumn() { return grid[0] ? grid[0].length : 0; },
    getMaxRows() { return Math.max(grid.length, 1000); },
    setFrozenRows() {},
    appendRow(row) { grid.push(row.slice()); },
    getRange(r, c, nr, nc) {
      nr = nr || 1; nc = nc || 1;
      return {
        setNumberFormat() {},
        setValue(v) { if (!grid[r - 1]) grid[r - 1] = []; grid[r - 1][c - 1] = v; },
        getValues() {
          const out = [];
          for (let i = 0; i < nr; i++) {
            const row = [];
            for (let j = 0; j < nc; j++) { const g = grid[r - 1 + i]; row.push(g ? g[c - 1 + j] : ''); }
            out.push(row);
          }
          return out;
        },
        setValues(vals) {
          for (let i = 0; i < vals.length; i++) {
            if (!grid[r - 1 + i]) grid[r - 1 + i] = [];
            for (let j = 0; j < vals[i].length; j++) grid[r - 1 + i][c - 1 + j] = vals[i][j];
          }
        },
      };
    },
  };
}

function loadCode() {
  const src = read('apps-script', 'Code.gs');
  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    JSON, Math, Date, Number, String, Array, Object, RegExp,
    Logger: { log: noop },
    __sheets: {},
    __props: {},
  };
  sandbox.SpreadsheetApp = {
    getActiveSpreadsheet: () => ({
      getSheetByName: (name) => sandbox.__sheets[name] || null,
      insertSheet: (name) => (sandbox.__sheets[name] = fakeSheet([], [])),
      getSpreadsheetTimeZone: () => 'Asia/Jerusalem',
    }),
  };
  sandbox.PropertiesService = {
    getScriptProperties: () => ({ getProperty: (k) => (k in sandbox.__props ? sandbox.__props[k] : null) }),
  };
  sandbox.ContentService = {
    createTextOutput: (s) => ({ setMimeType: () => ({ json: JSON.parse(s) }) }),
    MimeType: { JSON: 'json' },
  };
  sandbox.Utilities = {
    getUuid: () => 'uuid-' + Math.random().toString(36).slice(2),
    formatDate: (d) => d.toISOString().slice(0, 10),
  };
  sandbox.globalThis = sandbox;
  const epilogue = `globalThis.__test = {
    LEAD_COLUMNS: LEAD_COLUMNS,
    MANAGER_REPORT_MAX_CHARS: MANAGER_REPORT_MAX_CHARS,
    submitMeetingReport: (r) => submitMeetingReport_(r),
  };`;
  vm.createContext(sandbox);
  vm.runInContext(src + epilogue, sandbox);
  return { code: sandbox.__test, sandbox };
}

const OPEN_LEAD = { id: 'L1', name: 'דני', phone: '0501234567', house: 'ramot', stage: 'visit', visitDate: '2026-08-20' };

/* A sandbox whose Leads sheet holds one open lead. */
function withLead() {
  const { code, sandbox } = loadCode();
  const cols = Array.from(code.LEAD_COLUMNS);
  const row = cols.map(() => '');
  Object.keys(OPEN_LEAD).forEach((k) => { row[cols.indexOf(k)] = OPEN_LEAD[k]; });
  sandbox.__sheets['Leads'] = fakeSheet(cols, [row]);
  return { code, sandbox, cols };
}

const noteCell = (sandbox, cols) => sandbox.__sheets['Leads'].grid[1][cols.indexOf('meetingNote')];
const submit = (code, note) =>
  code.submitMeetingReport({ leadId: 'L1', outcome: 'advancing', companion: 'mother', note, reporter: 'יעל' });

/* ===== 1. one constant, 5000, in all four layers ===== */

test('MANAGER_REPORT_MAX_CHARS is 5000 in all four layers', () => {
  const app = loadApp();
  const { code } = loadCode();
  assert.strictEqual(mr.MANAGER_REPORT_MAX_CHARS, MAX, 'public/meeting-report.js');
  assert.strictEqual(app.MANAGER_REPORT_MAX_CHARS, MAX, 'public/app.js');
  assert.strictEqual(server.MANAGER_REPORT_MAX_CHARS, MAX, 'server.js');
  assert.strictEqual(code.MANAGER_REPORT_MAX_CHARS, MAX, 'apps-script/Code.gs');
});

test('the amber warn threshold is DERIVED from the cap, not a second literal', () => {
  const app = loadApp();
  assert.strictEqual(mr.MANAGER_REPORT_WARN_CHARS, 4500);
  assert.strictEqual(app.MANAGER_REPORT_WARN_CHARS, 4500);
  // 90% of the cap — raising the cap must move the warning with it.
  assert.strictEqual(mr.MANAGER_REPORT_WARN_CHARS, Math.round(MAX * 0.9));
});

/* ===== 2. source scan: no other numeric limit for this field ===== */

/* Prose lives in comments in this repo, and every comment that explains the
 * change names both 2000 and 5000 — so the literal scan runs over CODE only.
 * Block comments and whole-line // comments are removed; that is enough for a
 * numeric-literal scan (nothing here embeds a comment opener in a string). */
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');
}

/* Lines that touch the פירוט field itself (its variable, its property, its
 * form control) — `\bnote\b` deliberately does NOT match MR_NOTE_MAX_HEIGHT
 * and friends, which are pixel heights, not character caps. */
const FIELD_LINE = /(\b(note|meetingNote|mrvNote|mrNote|noteLen|noteError|mr-note)\b|bad_note|פירוט)/i;

const SOURCES = {
  'public/meeting-report.js': read('public', 'meeting-report.js'),
  'public/app.js': read('public', 'app.js'),
  'server.js': read('server.js'),
  'apps-script/Code.gs': read('apps-script', 'Code.gs'),
};

/* A line that both names the field AND talks about lengths is where a cap
 * could hide — `maxlength="2000"`, `note.length > 2000`, `note.slice(0, 2000)`,
 * 'עד 2000 תווים'. HTTP status codes and the like never match this. */
const LIMIT_WORD = /(length|maxlength|slice|substr|substring|limit|max|cap|תווים)/i;

test('source scan: NO numeric literal caps the פירוט field anywhere — only the constant', () => {
  Object.keys(SOURCES).forEach((name) => {
    codeOnly(SOURCES[name]).split('\n').forEach((line, i) => {
      if (!FIELD_LINE.test(line) || !LIMIT_WORD.test(line)) return;
      // The constant's own declaration is the one sanctioned number.
      const scrubbed = line.replace(/MANAGER_REPORT_MAX_CHARS\s*=\s*5000/g, 'MANAGER_REPORT_MAX_CHARS');
      const nums = scrubbed.match(/\b\d{3,}\b/g);
      assert.strictEqual(
        nums, null,
        name + ':' + (i + 1) + ' carries a bare numeric limit on the פירוט field: ' + line.trim()
      );
    });
  });
});

test('the source scan would CATCH a re-introduced hard-coded cap (guard self-check)', () => {
  const bad = [
    '<textarea name="mrvNote" maxlength="2000">',
    'if (note.length > 2000) return;',
    "const trimmed = note.slice(0, 2000);",
    "bad_note: 'הפירוט ארוך מדי (עד 2000 תווים)',",
  ];
  bad.forEach((line) => {
    assert.ok(FIELD_LINE.test(line) && LIMIT_WORD.test(line), 'line is in scope: ' + line);
    assert.ok(/\b\d{3,}\b/.test(line), 'and its literal is caught: ' + line);
  });
  // …while these must NOT trip it (they are not caps on this field).
  ["return res.status(400).json({ ok: false, error: 'bad_note' });",
   'var MR_NOTE_MAX_HEIGHT = 520;',
   'var MR_WA_URL_MAX = 60000;'].forEach((line) => {
    const inScope = FIELD_LINE.test(line) && LIMIT_WORD.test(line) && /\b\d{3,}\b/.test(line);
    assert.strictEqual(inScope, false, 'must stay out of scope: ' + line);
  });
});

test('source scan: each layer declares MANAGER_REPORT_MAX_CHARS = 5000 exactly once', () => {
  Object.keys(SOURCES).forEach((name) => {
    const decls = codeOnly(SOURCES[name]).match(/MANAGER_REPORT_MAX_CHARS\s*=\s*(\d+)\s*;/g) || [];
    assert.strictEqual(decls.length, 1, name + ' declares the cap exactly once');
    assert.match(decls[0], /=\s*5000\s*;/, name + ' declares it as 5000');
  });
});

test('source scan: the old 2,000 cap is gone from every פירוט path', () => {
  const formJs = codeOnly(SOURCES['public/meeting-report.js']);
  const appJs = codeOnly(SOURCES['public/app.js']);
  const codeGs = codeOnly(SOURCES['apps-script/Code.gs']);
  const formHtml = read('public', 'meeting-report.html');

  assert.ok(!/maxlength="2000"/.test(formHtml), 'the form textarea no longer says maxlength="2000"');
  assert.ok(!/MEETING_REPORT_NOTE_MAX/.test(appJs), 'the old MEETING_REPORT_NOTE_MAX identifier is gone');
  assert.ok(!/note\.length\s*>\s*\d/.test(codeGs), 'Code.gs compares note.length to the CONSTANT, never a literal');
  assert.ok(!/2000 תווים/.test(formJs), 'no Hebrew message still promises 2,000 chars');
  assert.ok(!/2000 תווים/.test(appJs), 'no Hebrew message still promises 2,000 chars');

  // Nothing in the form bundle's CODE says 2000 any more: the field cap is
  // 5,000 and the wa.me budget is MR_WA_URL_MAX (60,000 encoded chars).
  assert.deepStrictEqual(
    formJs.match(/^.*\b2000\b.*$/gm), null,
    'no 2000 left anywhere in the form bundle'
  );
});

test('the textarea maxlength mirrors the constant in both UIs', () => {
  const html = read('public', 'meeting-report.html');
  const m = html.match(/<textarea id="mr-note" maxlength="(\d+)"/);
  assert.ok(m, 'the פירוט textarea carries a maxlength');
  assert.strictEqual(Number(m[1]), MAX, 'the form textarea maxlength equals the cap');

  // The dashboard modal interpolates the constant instead of hard-coding it.
  assert.match(
    SOURCES['public/app.js'],
    /maxlength="\$\{MANAGER_REPORT_MAX_CHARS\}"/,
    'the edit-modal textarea takes its maxlength from the constant'
  );
});

/* ===== 3. 4,999 / 5,000 accepted — 5,001 rejected, never truncated ===== */

test('Code.gs: 4,999 and 5,000 Hebrew chars are accepted and stored in FULL', () => {
  [MAX - 1, MAX].forEach((n) => {
    const { code, sandbox, cols } = withLead();
    const out = submit(code, heb(n));
    assert.strictEqual(out.ok, true, n + ' chars must be accepted');
    assert.strictEqual(noteCell(sandbox, cols).length, n, n + ' chars stored verbatim, nothing trimmed');
  });
});

test('Code.gs: 5,001 chars are REJECTED with bad_note and nothing is written', () => {
  const { code, sandbox, cols } = withLead();
  const before = noteCell(sandbox, cols);
  const out = submit(code, heb(MAX + 1));
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.error, 'bad_note');
  assert.match(out.message, /הפירוט מוגבל ל-5000 תווים/, 'the refusal is Hebrew and names the cap');
  assert.ok(!/ש{50}/.test(out.message), 'the refusal never echoes the report text');
  assert.strictEqual(noteCell(sandbox, cols), before, 'the sheet is untouched — no truncated write');
  assert.strictEqual(
    sandbox.__sheets['Leads'].grid[1][cols.indexOf('meetingReportedAt')], '',
    'no report was stamped onto the lead'
  );
});

test('server.js pre-check: 4,999/5,000 pass, 5,001 gets a Hebrew refusal (no truncation)', () => {
  assert.strictEqual(server.meetingReportNoteError(heb(MAX - 1)), '');
  assert.strictEqual(server.meetingReportNoteError(heb(MAX)), '');
  assert.strictEqual(server.meetingReportNoteError(''), '');
  assert.strictEqual(server.meetingReportNoteError(null), '');
  const err = server.meetingReportNoteError(heb(MAX + 1));
  assert.match(err, /הפירוט מוגבל ל-5000 תווים/);
  assert.match(err, /5001/, 'the refusal names the length that was sent');
  assert.ok(!/ש{50}/.test(err), 'the refusal never echoes the report text');
});

test('the manager form refuses 5,001 before it ever hits the network', () => {
  assert.strictEqual(mr.mrNoteError(heb(MAX - 1)), '');
  assert.strictEqual(mr.mrNoteError(heb(MAX)), '');
  assert.strictEqual(mr.mrNoteError(undefined), '');
  assert.match(mr.mrNoteError(heb(MAX + 1)), /הפירוט מוגבל ל-5000 תווים/);
});

test("Vered's edit modal validates against the same cap", () => {
  const app = loadApp();
  const v = (note) => app.validateMeetingReportEdit({ outcome: 'advancing', companion: 'mother', note });
  assert.strictEqual(v(heb(MAX - 1)), '');
  assert.strictEqual(v(heb(MAX)), '');
  const err = v(heb(MAX + 1));
  assert.match(err, /הפירוט מוגבל ל-5000 תווים/);
  assert.ok(!/ש{50}/.test(err), 'the refusal never echoes the report text');
});

test("the form's bad_note error text quotes the raised cap", () => {
  assert.match(mr.MR_SUBMIT_ERROR_TEXTS.bad_note, /עד 5000 תווים/);
  assert.match(mr.mrSubmitErrorText('bad_note'), /עד 5000 תווים/);
});

/* ===== 4. a 5,000-char Hebrew note round-trips, no U+FFFD ===== */

test('a 5,000-char Hebrew note round-trips through write + read-back with no U+FFFD', () => {
  // Real Hebrew with punctuation, line breaks and a niqqud mark — the shapes
  // that historically produced '�' when a byte boundary was mishandled.
  const unit = 'פגישה עם דני והוריו — דובר על כניסה, טיפול תרופתי (ליתיום), וסדר יום.\nהאם שאלה על ביקורים.\n';
  let note = '';
  while (note.length < MAX) note += unit;
  note = note.slice(0, MAX);
  assert.strictEqual(note.length, MAX);

  const { code, sandbox, cols } = withLead();
  const out = submit(code, note);
  assert.strictEqual(out.ok, true);

  const stored = noteCell(sandbox, cols);
  assert.strictEqual(stored, note, 'stored byte-for-byte');
  assert.strictEqual(stored.length, MAX);
  assert.ok(stored.indexOf('�') === -1, 'no U+FFFD replacement char on the sheet');

  // …and through the JSON hop the proxy makes between Apps Script and browser.
  const hopped = JSON.parse(JSON.stringify({ meetingNote: stored })).meetingNote;
  assert.strictEqual(hopped, note, 'survives the JSON round trip');
  assert.ok(hopped.indexOf('�') === -1, 'no U+FFFD after the JSON hop');
  assert.ok(Buffer.from(hopped, 'utf8').toString('utf8').indexOf('�') === -1, 'no U+FFFD after a UTF-8 round trip');
});

/* ===== 5. render: escaped, line breaks kept, nothing clipped ===== */

test('a long multi-line report renders ESCAPED inside a pre-wrap span', () => {
  const app = loadApp();
  app.setMode('view');
  const note = 'שורה ראשונה\nשורה שנייה <script>alert("x")</script>\n\n' + heb(4000) + ' & "ציטוט"';
  const html = app.meetingReportBlockHTML({
    id: 'L1',
    meetingReportOutcome: 'advancing',
    meetingCompanion: 'mother',
    meetingNote: note,
    meetingReporter: 'חנן',
    meetingReportedAt: '2026-09-15T08:00:00.000Z',
    meetingSeen: '1',
  });

  assert.ok(html.includes('class="mrv-note"'), 'the note sits in its own pre-wrap span');
  assert.ok(!html.includes('<script>'), 'raw script tag never reaches the DOM');
  assert.ok(html.includes('&lt;script&gt;'), 'angle brackets escaped');
  assert.ok(html.includes('&quot;') || html.includes('&#39;'), 'quotes escaped');
  assert.ok(html.includes('&amp;'), 'ampersand escaped');
  assert.ok(html.includes(heb(4000)), 'the full 4,000-char run is present — nothing truncated at render');
  assert.ok(html.includes('שורה ראשונה\nשורה שנייה'), 'the line breaks survive into the markup');
});

test('the .mrv-note / .mrv-detail rules preserve line breaks and never clip', () => {
  const css = read('public', 'style.css');
  const mrvNote = css.match(/\.mrv-note\s*\{[^}]*\}/);
  assert.ok(mrvNote, '.mrv-note is styled');
  assert.match(mrvNote[0], /white-space:\s*pre-wrap/, 'line breaks are preserved');
  assert.match(mrvNote[0], /overflow-wrap:\s*anywhere/, 'a long unbroken run still wraps');
  assert.ok(!/max-height/.test(mrvNote[0]), 'no max-height could clip the report');
  assert.ok(!/overflow:\s*hidden/.test(mrvNote[0]), 'nothing is hidden');

  const detail = css.match(/\.mrv-detail\s*\{[^}]*\}/);
  assert.ok(detail, '.mrv-detail is styled');
  assert.ok(!/max-height/.test(detail[0]), 'the expanded block has no height ceiling');
  assert.ok(!/overflow:\s*hidden/.test(detail[0]), 'the expanded block hides nothing');

  // The manager form's confirmation screen shows the same text the same way.
  const formCss = read('public', 'meeting-report.css');
  const formNote = formCss.match(/\.mr-note-text\s*\{[^}]*\}/);
  assert.ok(formNote, '.mr-note-text is styled');
  assert.match(formNote[0], /white-space:\s*pre-wrap/);
});

/* ===== 6. live counter ===== */

test('the counter reads "X / 5000" inside an LTR isolate, and goes amber past 4,500', () => {
  const app = loadApp();
  [mr.mrNoteCounterText, app.managerReportCounterText].forEach((fn) => {
    assert.strictEqual(fn(0), '⁦0 / 5000⁩');
    assert.strictEqual(fn(4321), '⁦4321 / 5000⁩');
    assert.strictEqual(fn(MAX), '⁦5000 / 5000⁩');
    // Without the isolate the RTL page re-orders the two digit runs.
    assert.ok(fn(12).startsWith('⁦') && fn(12).endsWith('⁩'), 'LRI … PDI wrap');
  });
  [mr.mrNoteCounterWarn, app.managerReportCounterWarn].forEach((fn) => {
    assert.strictEqual(fn(0), false);
    assert.strictEqual(fn(4500), false, 'exactly at the threshold is still calm');
    assert.strictEqual(fn(4501), true, 'above 4,500 is amber');
    assert.strictEqual(fn(MAX), true);
  });
});

test('the form page carries the textarea + the live counter element', () => {
  const html = read('public', 'meeting-report.html');
  assert.match(html, /<textarea id="mr-note" maxlength="5000"/);
  assert.match(html, /id="mr-note-count"/, 'the counter element exists');
  assert.match(html, /dir="rtl"/, 'the page stays RTL');

  const appJs = read('public', 'app.js');
  assert.match(appJs, /class="mrv-note-count"/, 'the edit modal carries a counter too');
});

/* ===== 7. WhatsApp: the note is the ONLY thing that can ever be shortened =====
 *
 * The regression this section exists to prevent (PR #127, fixed here): the cap
 * counted ENCODED url characters while the budget was sized as if it counted
 * raw ones. A Hebrew letter costs SIX characters percent-encoded, so a 2,000
 * cap left room for ~260 characters of פירוט — and because the truncation was
 * applied to the assembled MESSAGE, everything after the cut, «דווח ע"י»
 * included, silently vanished. Every assertion below uses REAL Hebrew. */

/* A realistic manager's summary — Hebrew sentences with punctuation and line
 * breaks, cut to exactly n characters. Not a repeated single letter: the
 * encoded cost of real text (letters at 6, spaces/commas/newlines at 3) is what
 * the cap actually has to survive. */
const REPORT_UNIT =
  'הפגישה התקיימה בבית, נכחו דני והוריו. דובר על תהליך הקליטה, סדר היום, ' +
  'הטיפול התרופתי והליווי הפרטני. המשפחה שאלה על ביקורים ועל עלויות.\n';
function hebReport(n) {
  let s = '';
  while (s.length < n) s += REPORT_UNIT;
  return s.slice(0, n);
}
const savedWith = (note) => ({
  name: 'דני כהן', house: 'ramot', outcome: 'advancing',
  companion: 'parents', note, reporter: 'אורן',
});
/* The text WhatsApp would actually receive, decoded back out of the href. */
const sentText = (saved) => decodeURIComponent(mr.mrWhatsAppShareUrl(saved).split('?text=')[1]);
/* Just the פירוט segment of a message — between its label and the footer. */
function noteSegment(message) {
  const after = message.split('פירוט: ')[1];
  return after === undefined ? '' : after.split('\nדווח ע"י: ')[0];
}

test('the encoded-cost assumption the cap rests on: one Hebrew letter = 6 URL chars', () => {
  assert.strictEqual(encodeURIComponent('א').length, 6, "'א' → '%D7%90'");
  assert.strictEqual(encodeURIComponent('ש').length, 6);
  assert.strictEqual(encodeURIComponent(' ').length, 3);
  assert.strictEqual(encodeURIComponent('\n').length, 3);
  // Which is why the cap must clear ~6 × MANAGER_REPORT_MAX_CHARS, not 1 ×.
  assert.ok(
    mr.MR_WA_URL_MAX > 6 * MAX,
    'MR_WA_URL_MAX (' + mr.MR_WA_URL_MAX + ') must exceed 6 × ' + MAX + ' = ' + (6 * MAX)
  );
  assert.strictEqual(mr.MR_WA_URL_MAX, 60000);
});

test('a 400-char Hebrew report goes out IN FULL, with the דווח ע"י line intact', () => {
  // The exact case the old 2,000 cap silently mutilated: 400 chars of Hebrew
  // encode to ~2,400 — over the old budget, nowhere near the new one.
  const note = hebReport(400);
  const saved = savedWith(note);
  const text = sentText(saved);

  assert.ok(text.indexOf(note) !== -1, 'the WHOLE 400-char note is in the message');
  assert.strictEqual(noteSegment(text), note, 'the פירוט segment is the note, unmodified');
  assert.ok(text.indexOf('דווח ע"י: אורן') !== -1, 'the reporter line survives');
  assert.ok(text.indexOf('…') === -1, 'nothing was shortened');
  assert.ok(mr.mrWhatsAppShareUrl(saved).length <= mr.MR_WA_URL_MAX);
});

test('1,300-char and 5,000-char Hebrew reports go out in full, footer intact, under the cap', () => {
  [1300, MAX].forEach((n) => {
    const note = hebReport(n);
    const saved = savedWith(note);
    const text = sentText(saved);
    const url = mr.mrWhatsAppShareUrl(saved);

    assert.strictEqual(noteSegment(text), note, n + '-char note delivered in full');
    assert.ok(text.startsWith('דיווח פגישה — E-Zone'), n + ': header line 1 intact');
    assert.ok(text.indexOf('ליד: דני כהן (רמות השבים)') !== -1, n + ': header line 2 intact');
    assert.ok(text.indexOf('תוצאה: התקיימה — מתקדם לכניסה') !== -1, n + ': header line 3 intact');
    assert.ok(text.indexOf('הגיע/ה עם: הורים') !== -1, n + ': header line 4 intact');
    assert.ok(text.endsWith('דווח ע"י: אורן'), n + ': the footer is the LAST line');
    assert.ok(text.indexOf('…') === -1, n + ': no ellipsis — nothing was cut');
    assert.ok(url.length <= mr.MR_WA_URL_MAX, n + ': url ' + url.length + ' ≤ ' + mr.MR_WA_URL_MAX);
  });
});

test('past the cap: ONLY the note is shortened — headers and דווח ע"י still intact', () => {
  // Far beyond anything the field itself allows, purely to drive the cap.
  const note = hebReport(60000);
  const saved = savedWith(note);
  const text = sentText(saved);
  const url = mr.mrWhatsAppShareUrl(saved);

  assert.ok(url.length <= mr.MR_WA_URL_MAX, 'the url fits (' + url.length + ')');
  assert.ok(url.length > mr.MR_WA_URL_MAX - 200, 'and uses nearly all of it — not over-trimmed');

  assert.ok(text.startsWith('דיווח פגישה — E-Zone\nליד: דני כהן (רמות השבים)'), 'headers intact');
  assert.ok(text.indexOf('תוצאה: התקיימה — מתקדם לכניסה') !== -1, 'outcome intact');
  assert.ok(text.indexOf('הגיע/ה עם: הורים') !== -1, 'companion intact');
  assert.ok(text.endsWith('דווח ע"י: אורן'), 'the footer is still the last line — NOT cut off');

  const seg = noteSegment(text);
  assert.ok(seg.endsWith('…'), 'the note — and only the note — carries the ellipsis');
  assert.strictEqual((text.match(/…/g) || []).length, 1, 'exactly one ellipsis, inside the note');
  assert.ok(seg.length > 9000, 'the surviving note is thousands of chars, not a few hundred: ' + seg.length);
  assert.ok(note.startsWith(seg.slice(0, -1)), 'what survived is a real prefix of the report');

  assert.strictEqual(saved.note.length, 60000, 'the stored report is untouched');
});

test('the share message equals the plain message whenever it fits', () => {
  const saved = savedWith(hebReport(MAX));
  assert.strictEqual(
    mr.mrWhatsAppShareMessage(saved), mr.mrWhatsAppMessage(saved),
    'no rewriting at all in the normal case'
  );
  assert.strictEqual(
    mr.mrWhatsAppShareUrl(saved), mr.mrWhatsAppLink(mr.mrWhatsAppMessage(saved))
  );
});

test('mrWhatsAppLink itself never truncates — it only encodes', () => {
  const long = hebReport(MAX);
  assert.strictEqual(decodeURIComponent(mr.mrWhatsAppLink(long).split('?text=')[1]), long);
  assert.ok(mr.mrWhatsAppLink(long).startsWith('https://wa.me/?text='), 'chat picker, no phone');
});

test('mrWithNote swaps the note without mutating the caller', () => {
  const saved = savedWith('מקורי');
  const copy = mr.mrWithNote(saved, 'חדש');
  assert.strictEqual(saved.note, 'מקורי', 'the original is untouched');
  assert.strictEqual(copy.note, 'חדש');
  assert.strictEqual(copy.reporter, 'אורן', 'every other field rides along');
  assert.strictEqual(copy.house, 'ramot');
});

test('mrSafeCut never splits a surrogate pair (an emoji cannot break the link)', () => {
  const withEmoji = 'שלום 👍';
  assert.strictEqual(withEmoji.length, 7, '4 Hebrew letters + a space + a 2-unit emoji');
  assert.strictEqual(mr.mrSafeCut(withEmoji, 6), 'שלום ', 'a lone high surrogate is dropped');
  assert.strictEqual(mr.mrSafeCut(withEmoji, 7), withEmoji, 'the whole pair is kept');
  assert.doesNotThrow(() => encodeURIComponent(mr.mrSafeCut(withEmoji, 6)));
  // And end to end: an emoji-laden report past the cap still yields a valid link.
  const note = '👍🙂'.repeat(20000);
  assert.doesNotThrow(() => mr.mrWhatsAppShareUrl(savedWith(note)));
  const text = sentText(savedWith(note));
  assert.ok(text.endsWith('דווח ע"י: אורן'), 'footer intact even with emoji');
  assert.ok(text.indexOf('\uFFFD') === -1, 'no replacement char from a split pair');
});

/* ===== 8. the service worker was bumped for the asset change ===== */

test('the SW cache version is at least v8 (the assets in this change must be evicted)', () => {
  const sw = read('public', 'sw.js');
  const m = sw.match(/var CACHE_VERSION = 'v(\d+)'/);
  assert.ok(m, 'CACHE_VERSION is declared once');
  assert.strictEqual((sw.match(/var CACHE_VERSION =/g) || []).length, 1, 'declared exactly once');
  assert.ok(Number(m[1]) >= 8, 'CACHE_VERSION must be >= v8, got v' + m[1]);
});
