/* diagnoseRamotPatientsToDocNow() — the editor-run wrapper that copies the
 * READ-ONLY ramot diagnostic's report.lines into one new private Google Doc
 * (apps-script/Code.gs; see CHANGELOG-diagnostic-to-doc.md).
 *
 * Locked here:
 *   1. Its ONLY writes are DocumentApp.create (once) and body.appendParagraph
 *      (once per report line, in order). Proven at RUNTIME against fakes where
 *      every other Doc method, every spreadsheet mutator, DriveApp, the Drive
 *      advanced service, mail, fetch, locks and properties THROW and are
 *      recorded — zero attempts — and in SOURCE: every member call it makes is
 *      on a short allow-list, and the only Code.gs function it calls is the
 *      diagnostic (whose own read-only closure test/missing-patient-diagnostic
 *      .test.js already proves).
 *   2. It never shares, moves or publishes the Doc.
 *   3. The Doc is named "E-Zone ramot diagnostic YYYY-MM-DD HH:mm" in Israel
 *      time, and its URL is logged — also when filling fails part-way.
 *   4. It is not reachable over HTTP: handle_'s allow-list never names it.
 *   5. appsscript.json declares the documents scope next to the existing ones.
 * All names and phone numbers are SYNTHETIC. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const GS_SRC = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps-script', 'appsscript.json'), 'utf8'));
const arr = (x) => Array.from(x);
const LABEL = 'רמות השבים';

/* ---------- fakes that record and REFUSE anything not explicitly allowed ---------- */
function trap(allowed, label, attempts) {
  return new Proxy(allowed, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === 'symbol' || prop === 'then' || prop === 'toJSON') return undefined;
      return () => {
        attempts.push(label + '.' + String(prop));
        throw new Error('not allowed: ' + label + '.' + String(prop));
      };
    },
  });
}
/* A whole service that must not be touched at all: ANY property read is recorded. */
function forbiddenService(label, attempts) {
  return new Proxy({}, {
    get(_t, prop) {
      if (typeof prop === 'symbol' || prop === 'then' || prop === 'toJSON') return undefined;
      attempts.push(label + '.' + String(prop));
      throw new Error('not allowed: ' + label + '.' + String(prop));
    },
  });
}

function roSheet(name, header, rows, attempts) {
  const grid = [header.slice()].concat(rows.map((r) => r.slice()));
  const width = () => grid.reduce((m, r) => Math.max(m, r.length), 0);
  return trap({
    getName: () => name,
    getLastRow: () => grid.length,
    getLastColumn: () => width(),
    getMaxColumns: () => Math.max(26, width()),
    getMaxRows: () => Math.max(1000, grid.length),
    getRange: (r, c, nr, nc) => {
      nr = nr || 1; nc = nc || 1;
      const read = () => {
        const out = [];
        for (let i = 0; i < nr; i++) {
          const row = [];
          for (let j = 0; j < nc; j++) {
            const g = grid[r - 1 + i];
            row.push(g && g[c - 1 + j] !== undefined ? g[c - 1 + j] : '');
          }
          out.push(row);
        }
        return out;
      };
      return trap({ getValues: read, getValue: () => read()[0][0] }, 'Range(' + name + ')', attempts);
    },
  }, 'Sheet(' + name + ')', attempts);
}

function frozenDate(iso) {
  const fixed = new Date(iso).getTime();
  return class FrozenDate extends Date {
    constructor(...a) { if (a.length === 0) super(fixed); else super(...a); }
    static now() { return fixed; }
  };
}

/* Utilities.formatDate with REAL timezone handling (Intl), for the tokens the
 * code uses; every call is recorded so the tests can see the tz and pattern. */
function formatDate(fmtCalls) {
  return (d, tz, pattern) => {
    fmtCalls.push({ tz, pattern });
    const p = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(d).reduce((o, x) => { o[x.type] = x.value; return o; }, {});
    return String(pattern).replace(/yyyy|MM|dd|HH|mm|ss/g,
      (t) => ({ yyyy: p.year, MM: p.month, dd: p.day, HH: p.hour, mm: p.minute, ss: p.second })[t]);
  };
}

/* opts.failAppendAt: appendParagraph call number (1-based) that throws.
 * opts.createThrows: DocumentApp.create throws (e.g. the scope not approved yet). */
function loadCode(tabs, opts) {
  opts = opts || {};
  const attempts = [];
  const logs = [];
  const fmtCalls = [];
  const docWrites = [];   // every call the wrapper makes on DocumentApp / Document / Body, in order
  const paragraphs = [];
  const sheets = (tabs || []).map((t) => roSheet(t.name, t.header, t.rows, attempts));
  const ss = trap({
    getSheetByName: (n) => sheets.find((s) => s.getName() === n) || null,
    getSheets: () => sheets.slice(),
    getSpreadsheetTimeZone: () => 'Asia/Jerusalem',
  }, 'Spreadsheet', attempts);

  const body = trap({
    appendParagraph: (text) => {
      docWrites.push('Body.appendParagraph');
      if (opts.failAppendAt && paragraphs.length + 1 === opts.failAppendAt) throw new Error('Docs quota');
      paragraphs.push(text);
      return trap({}, 'Paragraph', attempts);
    },
  }, 'Body', attempts);
  const doc = trap({
    getBody: () => { docWrites.push('Document.getBody'); return body; },
    getUrl: () => { docWrites.push('Document.getUrl'); return 'https://docs.google.com/document/d/FAKE-DOC-ID/edit'; },
  }, 'Document', attempts);
  const created = [];
  const DocumentApp = trap({
    create: (name) => {
      docWrites.push('DocumentApp.create');
      created.push(name);
      if (opts.createThrows) throw new Error('Authorization is required to perform that action.');
      return doc;
    },
  }, 'DocumentApp', attempts);

  const sandbox = {
    console: { log() {}, warn() {}, error() {}, info() {} },
    JSON, Math, Date: frozenDate(opts.now || '2026-09-29T09:05:30.000Z'), Number, String, Array, Object, RegExp, isFinite,
    Logger: { log: (m) => logs.push(String(m)) },
    SpreadsheetApp: trap({ getActiveSpreadsheet: () => ss }, 'SpreadsheetApp', attempts),
    DocumentApp,
    Utilities: trap({ formatDate: formatDate(fmtCalls) }, 'Utilities', attempts),
    DriveApp: forbiddenService('DriveApp', attempts),
    Drive: forbiddenService('Drive', attempts),
    MailApp: forbiddenService('MailApp', attempts),
    GmailApp: forbiddenService('GmailApp', attempts),
    UrlFetchApp: forbiddenService('UrlFetchApp', attempts),
    ScriptApp: forbiddenService('ScriptApp', attempts),
    LockService: forbiddenService('LockService', attempts),
    PropertiesService: forbiddenService('PropertiesService', attempts),
    CacheService: forbiddenService('CacheService', attempts),
    ContentService: {
      createTextOutput: (s) => ({ setMimeType: () => ({ json: JSON.parse(s) }) }),
      MimeType: { JSON: 'json' },
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(GS_SRC + `
    globalThis.__cols = {
      LEAD_COLUMNS, PATIENT_COLUMNS, PATIENT_TOMBSTONE_COLUMNS,
      LEADS_SHEET, PATIENTS_SHEET, PATIENTS_TOMBSTONES_SHEET,
    };`, sandbox);
  return { sandbox, attempts, logs, fmtCalls, docWrites, paragraphs, created, C: sandbox.__cols };
}

const rowOf = (cols, f) => arr(cols).map((c) => (f[c] === undefined ? '' : f[c]));

/* A small synthetic spreadsheet: enough for every diagnostic section to say something. */
function tabs() {
  const { C } = loadCode([]);
  return [
    { name: C.LEADS_SHEET, header: arr(C.LEAD_COLUMNS), rows: [
      rowOf(C.LEAD_COLUMNS, { id: 'lead-1', name: 'אלף בדיקה', phone: '0500000001', house: LABEL, stage: 'new' }),
    ] },
    { name: C.PATIENTS_SHEET, header: arr(C.PATIENT_COLUMNS), rows: [
      rowOf(C.PATIENT_COLUMNS, { houseId: 'ramot', name: 'בית בדיקה', date: '2026-08-01', status: 'active', id: 'id-p1' }),
      rowOf(C.PATIENT_COLUMNS, { houseId: 'ramot', name: 'גימל בדיקה', date: '2026-07-01', status: 'released', id: 'id-p2' }),
      rowOf(C.PATIENT_COLUMNS, { houseId: '', name: 'דלת בדיקה', date: '2026-06-01', status: 'active', id: 'id-p3' }),
    ] },
    { name: C.PATIENTS_TOMBSTONES_SHEET, header: arr(C.PATIENT_TOMBSTONE_COLUMNS), rows: [
      rowOf(C.PATIENT_TOMBSTONE_COLUMNS, { houseId: 'ramot', name: 'הא בדיקה', status: 'active', reason: 'user-delete',
        droppedAt: '2026-09-20T08:00:00.000Z', savedByAction: 'deletePatientRow', updatedBy: 'ורד', id: 'id-gone' }),
    ] },
  ];
}

function run(opts) {
  const h = loadCode(tabs(), opts);
  let result;
  let error = null;
  try { result = h.sandbox.diagnoseRamotPatientsToDocNow(); } catch (err) { error = err; }
  return Object.assign(h, { result: result && JSON.parse(JSON.stringify(result)), error });
}

/* The same diagnostic run on its own — what report.lines must be. */
function reportLines() {
  const h = loadCode(tabs());
  return arr(h.sandbox.diagnoseRamotPatientsNow().lines);
}

/* ---------- source helpers ---------- */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
}
function stripStrings(src) {
  return src.replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, '""');
}
const wrapperSrc = () => loadCode([]).sandbox.diagnoseRamotPatientsToDocNow.toString();

/* ===================================================================== */
/* 1. Writes only through DocumentApp.create / body.appendParagraph      */
/* ===================================================================== */

test('the Doc holds report.lines — one paragraph per line, in order, nothing else', () => {
  const expected = reportLines();
  const h = run();
  assert.strictEqual(h.error, null);
  assert.ok(expected.length > 5, 'the diagnostic said something');
  assert.deepStrictEqual(arr(h.paragraphs), expected);
  assert.deepStrictEqual(h.result, {
    name: 'E-Zone ramot diagnostic 2026-09-29 12:05',
    url: 'https://docs.google.com/document/d/FAKE-DOC-ID/edit',
    paragraphs: expected.length,
  });
});

test('its ONLY writes are DocumentApp.create (once) and body.appendParagraph (once per line)', () => {
  const h = run();
  const writes = h.docWrites.filter((w) => w === 'DocumentApp.create' || w === 'Body.appendParagraph');
  assert.strictEqual(writes.filter((w) => w === 'DocumentApp.create').length, 1, 'ONE new Doc');
  assert.strictEqual(writes.filter((w) => w === 'Body.appendParagraph').length, h.paragraphs.length);
  // Everything else it did on the Doc is a read.
  assert.deepStrictEqual([...new Set(h.docWrites)].sort(),
    ['Body.appendParagraph', 'Document.getBody', 'Document.getUrl', 'DocumentApp.create']);
  assert.deepStrictEqual(h.attempts, [], 'no other Doc / Drive / spreadsheet / lock / property call of any kind');
});

test('it never touches a SpreadsheetApp write method — the spreadsheet fakes refuse every one', () => {
  const h = run();
  assert.deepStrictEqual(h.attempts.filter((a) => /Spreadsheet|Sheet\(|Range\(/.test(a)), []);
  const src = stripComments(wrapperSrc());
  [/\.setValues?\s*\(/, /\.appendRow\s*\(/, /\.deleteRows?\s*\(/, /\.insert\w*\s*\(/, /\.clear\w*\s*\(/,
    /\.set[A-Z]\w*\s*\(/, /\.delete\w*\s*\(/, /\.hideSheet\s*\(/, /\.sort\s*\(/, /\.copyTo\s*\(/,
    /\bgetOrCreateSheet_\s*\(/, /\blogAudit_\s*\(/, /\bLockService\b/, /\bPropertiesService\b/].forEach((re) => {
    assert.ok(!re.test(src), 'the wrapper must not match ' + re);
  });
});

test('source: every member call is on the allow-list, and the only Code.gs function it calls is the diagnostic', () => {
  const src = stripStrings(stripComments(wrapperSrc()));
  const members = [...new Set((src.match(/\.([A-Za-z_$][\w$]*)\s*\(/g) || []).map((m) => m.replace(/^\.|\s*\($/g, '')))].sort();
  assert.deepStrictEqual(members,
    ['appendParagraph', 'create', 'formatDate', 'getActiveSpreadsheet', 'getBody', 'getSpreadsheetTimeZone', 'getUrl', 'isArray', 'log'].sort(),
    'a new member call must be reviewed here first');
  const { sandbox } = loadCode([]);
  const bare = [...new Set((src.replace(/\.[A-Za-z_$][\w$]*\s*\(/g, '.(').match(/\b[A-Za-z_$][\w$]*(?=\s*\()/g) || []))]
    .filter((id) => id !== 'function' && id !== 'diagnoseRamotPatientsToDocNow')
    .filter((id) => typeof sandbox[id] === 'function' && GS_SRC.includes('function ' + id + '('));
  assert.deepStrictEqual(bare, ['diagnoseRamotPatientsNow']);
});

test('the diagnostic itself stays read-only: it never mentions DocumentApp', () => {
  const diag = stripComments(loadCode([]).sandbox.diagnoseRamotPatientsNow.toString());
  assert.ok(!/DocumentApp|appendParagraph/.test(diag), 'the Doc logic lives only in the wrapper');
});

/* ===================================================================== */
/* 2. Never shares, moves or publishes the Doc                            */
/* ===================================================================== */

test('it never shares, moves or publishes the Doc — no Drive, no sharing call, no mail, no fetch', () => {
  const h = run();
  assert.deepStrictEqual(h.attempts.filter((a) => /^(DriveApp|Drive|MailApp|GmailApp|UrlFetchApp|ScriptApp)\./.test(a)), []);
  const src = stripComments(wrapperSrc());
  [/\bDriveApp\b/, /\bDrive\./, /\.add(Editor|Viewer|Commenter)s?\s*\(/, /\.setSharing\s*\(/, /\.moveTo\s*\(/,
    /\.addFile\s*\(/, /\.removeFile\s*\(/, /\.setOwner\s*\(/, /\.makeCopy\s*\(/, /publish/i, /\bMailApp\b/,
    /\bGmailApp\b/, /\bUrlFetchApp\b/, /\.remove\w*\s*\(/].forEach((re) => {
    assert.ok(!re.test(src), 'the wrapper must not match ' + re);
  });
});

/* ===================================================================== */
/* 3. Name (Israel time) + logged URL                                     */
/* ===================================================================== */

test('the Doc is named "E-Zone ramot diagnostic YYYY-MM-DD HH:mm" in Israel time', () => {
  const summer = run({ now: '2026-09-29T09:05:30.000Z' });   // IDT, UTC+3
  assert.deepStrictEqual(arr(summer.created), ['E-Zone ramot diagnostic 2026-09-29 12:05']);
  const winter = run({ now: '2026-12-01T22:30:00.000Z' });   // IST, UTC+2 — the date rolls over
  assert.deepStrictEqual(arr(winter.created), ['E-Zone ramot diagnostic 2026-12-02 00:30']);
  const nameCall = winter.fmtCalls.find((c) => c.pattern === 'yyyy-MM-dd HH:mm');
  assert.deepStrictEqual(nameCall, { tz: 'Asia/Jerusalem', pattern: 'yyyy-MM-dd HH:mm' });
  assert.match(winter.created[0], /^E-Zone ramot diagnostic \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
});

test('the Doc URL is logged, after the diagnostic\'s own lines', () => {
  const h = run();
  const last = h.logs[h.logs.length - 1];
  assert.match(last, /^diagnoseRamotPatientsToDocNow — \d+ line\(s\) written to a new private Doc "E-Zone ramot diagnostic 2026-09-29 12:05": https:\/\/docs\.google\.com\/document\/d\/FAKE-DOC-ID\/edit$/);
  assert.match(h.logs[h.logs.length - 2], /^\(d\) SUMMARY ramot/, 'the diagnostic\'s SUMMARY comes right before it');
});

test('a failure while filling the Doc logs the partial Doc\'s URL and still surfaces the error', () => {
  const h = run({ failAppendAt: 3 });
  assert.ok(h.error && /Docs quota/.test(h.error.message), 'the error is not swallowed');
  assert.deepStrictEqual(arr(h.created).length, 1);
  assert.strictEqual(h.paragraphs.length, 2);
  const last = h.logs[h.logs.length - 1];
  assert.match(last, /FAILED while filling the new Doc/);
  assert.match(last, /only partly filled; delete it: https:\/\/docs\.google\.com\/document\/d\/FAKE-DOC-ID\/edit$/);
  assert.deepStrictEqual(h.attempts, []);
});

test('if the Doc cannot be created (e.g. the permission is not approved yet) the diagnostic is still in the log', () => {
  const h = run({ createThrows: true });
  assert.ok(h.error && /Authorization is required/.test(h.error.message));
  assert.ok(h.logs.some((l) => /^\(d\) SUMMARY ramot/.test(l)), 'the findings were logged before the Doc was attempted');
  assert.strictEqual(h.paragraphs.length, 0);
  assert.deepStrictEqual(h.attempts, []);
});

/* ===================================================================== */
/* 4. Not reachable over HTTP                                             */
/* ===================================================================== */

test('not reachable over HTTP: handle_ never names it or DocumentApp, and answers unknown_action', () => {
  const handleSrc = GS_SRC.slice(GS_SRC.indexOf('function handle_('), GS_SRC.indexOf('function collectParams_('));
  assert.ok(handleSrc.length > 1000, 'found handle_');
  assert.ok(!/diagnoseRamotPatientsToDocNow|ToDoc|DocumentApp/.test(handleSrc));
  const h = loadCode(tabs());
  const viaHandle = h.sandbox.handle_({ action: 'diagnoseRamotPatientsToDocNow' }).json;
  assert.deepStrictEqual(JSON.parse(JSON.stringify(viaHandle)),
    { ok: false, error: 'unknown_action', action: 'diagnoseRamotPatientsToDocNow' });
  const viaGet = h.sandbox.doGet({ parameter: { action: 'diagnoseRamotPatientsToDocNow' } }).json;
  const viaPost = h.sandbox.doPost({ postData: { contents: JSON.stringify({ action: 'diagnoseRamotPatientsToDocNow' }) } }).json;
  assert.strictEqual(viaGet.error, 'unknown_action');
  assert.strictEqual(viaPost.error, 'unknown_action');
  assert.deepStrictEqual(arr(h.created), [], 'no Doc was created by any HTTP call');
  assert.deepStrictEqual(h.attempts, []);
});

test('public (no trailing underscore, so it is in the Run dropdown) and declared exactly once', () => {
  const decl = GS_SRC.match(/(^|\n)function diagnoseRamotPatientsToDocNow\(\)/g) || [];
  assert.strictEqual(decl.length, 1);
  assert.ok(!/function diagnoseRamotPatientsToDocNow_\(/.test(GS_SRC));
});

/* ===================================================================== */
/* 5. The manifest                                                        */
/* ===================================================================== */

test('appsscript.json declares the documents scope, keeps every existing one, and changes nothing else', () => {
  assert.ok(Array.isArray(MANIFEST.oauthScopes), 'the manifest has an explicit scope list');
  // Pinned on purpose: the scope list is the script's permission surface —
  // any change to it must be a reviewed change to this test.
  assert.deepStrictEqual(MANIFEST.oauthScopes.slice().sort(), [
    'https://www.googleapis.com/auth/documents',
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/script.external_request',
    'https://www.googleapis.com/auth/script.scriptapp',
    'https://www.googleapis.com/auth/script.send_mail',
    'https://www.googleapis.com/auth/spreadsheets',
  ]);
  assert.deepStrictEqual(MANIFEST.webapp, { executeAs: 'USER_DEPLOYING', access: 'ANYONE_ANONYMOUS' });
  assert.strictEqual(MANIFEST.timeZone, 'Asia/Jerusalem');
  assert.strictEqual(MANIFEST.runtimeVersion, 'V8');
});
