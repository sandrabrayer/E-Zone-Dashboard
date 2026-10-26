'use strict';

/* Vered's scheduling note reaches the managers (CHANGELOG-vered-note-to-managers.md).
 *
 *   - Code.gs meetingReportLeads: each lead carries `officeNote` = the lead's
 *     `note` (multi-line kept, control chars scrubbed, capped) and still NO
 *     phone / contact / billing / report fields;
 *   - server.js meetingReportLeadsWhitelist: the same five keys only, capped;
 *   - meeting-report.js: the «רקע מהמשרד» panel renders (escaped) for the picked
 *     lead, hides when the note is empty, follows selection changes and the
 *     «לא מוצא את הליד?» toggle — driven through the REAL DOM wiring with a
 *     fake document (runs in CI), plus a real-Chromium check (skipped where no
 *     browser is installed, like the other *-browser tests);
 *   - PRIVACY: the note is never in the submit payload nor the WhatsApp message.
 *
 * Every name and note is SYNTHETIC. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const { richSheet, loadGs } = require('./helpers/gs-sandbox');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const MR_SRC = fs.readFileSync(path.join(PUBLIC, 'meeting-report.js'), 'utf8');
const mr = require('../public/meeting-report.js');
const arr = (x) => JSON.parse(JSON.stringify(x));

const NOTE = 'רקע: אשפוז קודם ב-2024.\nמגיע עם אמא.\r\nשאלות על <תרופות> & "מינון"';
const NOTE_CLEAN = 'רקע: אשפוז קודם ב-2024.\nמגיע עם אמא.\nשאלות על <תרופות> & "מינון"';

/* ===== Code.gs — the feed ===== */

function bootGs(leads) {
  const g = loadGs({ props: { MEETING_REPORT_SECRET: 'mr-s3cret' } });
  g.sandbox.Session = { getScriptTimeZone: () => 'Asia/Jerusalem' };
  g.run(`todayISODate_ = function () { return '2026-10-26'; }`);
  const cols = Array.from(g.run('LEAD_COLUMNS'));
  const sh = richSheet('Leads', cols);
  leads.forEach((r) => sh.grid.push(cols.map((c) => r[c] ?? '')));
  g.sandbox.__sheets.Leads = sh;
  return g;
}

const LEADS = [
  { id: 'A', name: 'אלף', house: 'ramot', stage: 'visit', visitDate: '2026-10-20', note: NOTE,
    phone: '0501234567', contactName: 'פונה', contactPhone: '0527654321', billingPhone: '0539999999',
    meetingNote: 'דיווח קודם של המנהל', meetingReporter: 'אורן' },
  { id: 'B', name: 'בית', house: 'arfoni', stage: 'visit', visitDate: '2026-10-21', note: '' },
  { id: 'C', name: 'גימל', house: 'ramot', stage: 'new', visitDate: '', note: '   ' },
];

test('Code.gs: the lead card «הערות» textarea (next to the visit date/time) binds to LEAD_COLUMNS note', () => {
  const app = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const i = app.indexOf('function openEditLeadModal(');
  const body = app.slice(i, app.indexOf('submitLabel:', i));
  const vt = body.indexOf("name: 'visitTime'");
  const nt = body.indexOf("{ name: 'note',  label: 'הערות',       type: 'textarea'");
  assert.ok(vt > 0 && nt > vt, 'the textarea after the visit fields is `note`');
  const g = bootGs([]);
  assert.ok(Array.from(g.run('LEAD_COLUMNS')).includes('note'));
});

test('Code.gs: meetingReportLeads carries officeNote (multi-line kept) and still no phone / contact / billing / report fields', () => {
  const g = bootGs(LEADS);
  const out = arr(g.post({ action: 'meetingReportLeads', secret: 'mr-s3cret' }));
  assert.equal(out.ok, true);
  out.leads.forEach((l) =>
    assert.deepEqual(Object.keys(l).sort(), ['house', 'id', 'name', 'officeNote', 'visitDate']));
  const byId = Object.fromEntries(out.leads.map((l) => [l.id, l]));
  assert.equal(byId.A.officeNote, NOTE_CLEAN, 'CRLF → LF, line breaks kept, text otherwise verbatim');
  assert.equal(byId.B.officeNote, '');
  assert.equal(byId.C.officeNote, '', 'whitespace-only → empty');
  const json = JSON.stringify(out);
  ['0501234567', '0527654321', '0539999999', 'פונה', 'דיווח קודם של המנהל'].forEach((leak) =>
    assert.ok(!json.includes(leak), 'never in the feed: ' + leak));
});

test('Code.gs: meetingReportOfficeNote_ scrubs control chars, keeps \\n, caps at 5000', () => {
  const g = bootGs([]);
  const f = g.run('meetingReportOfficeNote_');
  assert.equal(f('a\u0000b\tc\u007fd\ne'), 'a b c d\ne');
  assert.equal(f(null), '');
  assert.equal(f('x'.repeat(6000)).length, 5000);
  assert.equal(g.run('MEETING_REPORT_OFFICE_NOTE_MAX'), 5000);
});

test('Code.gs: the feed is still fail-closed — a wrong secret gets no notes', () => {
  const g = bootGs(LEADS);
  const out = arr(g.post({ action: 'meetingReportLeads', secret: 'nope' }));
  assert.notEqual(out.ok, true);
  assert.ok(!JSON.stringify(out).includes('אשפוז'));
});

/* ===== server.js — the re-applied whitelist ===== */

test('server: meetingReportLeadsWhitelist keeps the five keys only, strings, note capped', () => {
  const { meetingReportLeadsWhitelist: wl } = require('../server.js');
  const out = wl([
    { id: 7, name: 'אלף', house: 'ramot', visitDate: '2026-10-20', officeNote: 'שורה 1\nשורה 2',
      phone: '0501234567', contactPhone: '0527654321', billingPhone: '0539999999', note: 'x', meetingNote: 'y' },
    { id: 'B', officeNote: 'z'.repeat(9000) },
    null,
  ]);
  assert.deepEqual(out[0], { id: '7', name: 'אלף', house: 'ramot', visitDate: '2026-10-20', officeNote: 'שורה 1\nשורה 2' });
  assert.equal(out[1].officeNote.length, 5000);
  assert.deepEqual(out[2], { id: '', name: '', house: '', visitDate: '', officeNote: '' });
  out.forEach((l) => assert.deepEqual(Object.keys(l).sort(), ['house', 'id', 'name', 'officeNote', 'visitDate']));
  assert.deepEqual(wl(undefined), []);
  assert.deepEqual(wl({}), []);
});

test('server: the /api/meeting-report/leads route uses the whitelist; the cap matches Code.gs', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const i = src.indexOf("app.get('/api/meeting-report/leads'");
  const route = src.slice(i, src.indexOf('\n});\n', i));
  assert.ok(route.includes('const leads = meetingReportLeadsWhitelist(data.leads);'));
  assert.match(src, /const MEETING_REPORT_OFFICE_NOTE_MAX = 5000;/);
});

/* ===== meeting-report.js — pure panel helpers ===== */

test('panel html: label «רקע מהמשרד», escaped text, RTL; empty / whitespace / missing → ""', () => {
  const html = mr.mrOfficeNoteHtml({ officeNote: NOTE_CLEAN });
  assert.ok(html.includes('<div class="mr-office-note-label">רקע מהמשרד</div>'));
  assert.ok(html.includes('dir="rtl"'));
  assert.ok(html.includes('&lt;תרופות&gt; &amp; &quot;מינון&quot;'), 'escaped');
  assert.ok(!html.includes('<תרופות>'), 'no raw markup from the note');
  assert.ok(html.includes('מגיע עם אמא.\nשאלות'), 'line break kept as text (CSS pre-wrap renders it)');
  assert.equal(mr.mrOfficeNoteHtml({ officeNote: '' }), '');
  assert.equal(mr.mrOfficeNoteHtml({ officeNote: ' \n ' }), '');
  assert.equal(mr.mrOfficeNoteHtml({}), '');
  assert.equal(mr.mrOfficeNoteHtml(null), '');
});

test('CSS: the panel keeps line breaks and wraps RTL', () => {
  const css = fs.readFileSync(path.join(PUBLIC, 'meeting-report.css'), 'utf8');
  const rule = css.slice(css.indexOf('.mr-office-note-text {'), css.indexOf('}', css.indexOf('.mr-office-note-text {')));
  assert.match(rule, /white-space: pre-wrap;/);
  assert.match(css, /\.mr-office-note \{[^}]*direction: rtl;/);
  const html = fs.readFileSync(path.join(PUBLIC, 'meeting-report.html'), 'utf8');
  assert.match(html, /<div id="mr-office-note" class="mr-office-note hidden" dir="rtl"/);
});

/* ===== PRIVACY: never in the WhatsApp message ===== */

test('PRIVACY: Vered’s note is NEVER in the WhatsApp message, even if a caller hands over the whole lead', () => {
  const secret = 'סוד-קליני-אשפוז-2024';
  const lead = { id: 'A', name: 'אלף', house: 'ramot', visitDate: '2026-10-20', officeNote: secret };
  const saved = Object.assign({}, lead, {
    outcome: 'advancing', companion: 'mother', note: 'הדיווח של המנהל', reporter: 'אורן',
  });
  const msg = mr.mrWhatsAppMessage(saved);
  const share = mr.mrWhatsAppShareMessage(saved);
  const url = mr.mrWhatsAppShareUrl(saved);
  assert.ok(!msg.includes(secret) && !share.includes(secret));
  assert.ok(!decodeURIComponent(url.slice(mr.mrWhatsAppLink('').length)).includes(secret));
  assert.ok(!msg.includes('רקע מהמשרד'));
  assert.ok(msg.includes('פירוט: הדיווח של המנהל'), 'the manager’s own report still goes out');
  assert.equal(mr.mrWithNote(saved, 'n').officeNote, undefined, 'the shortening copy drops it too');
});

/* ===== the REAL DOM wiring, with a fake document ===== */

function fakeEl(id) {
  const classes = new Set();
  return {
    id, value: '', textContent: '', _html: '', style: {}, scrollHeight: 0, listeners: {},
    get innerHTML() { return this._html; },
    set innerHTML(v) {
      this._html = String(v);
      if (id === 'mr-lead') this.value = ''; // replacing the options resets the pick
    },
    classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => { const want = on === undefined ? !classes.has(c) : !!on; if (want) classes.add(c); else classes.delete(c); return want; },
    },
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
    fire(t, ev) { return (this.listeners[t] || []).map((fn) => fn(ev || { target: this })); },
    setAttribute() {}, removeAttribute() {}, getAttribute() { return null; },
    querySelector() { return null; },
  };
}

async function bootForm(leads) {
  const els = {};
  const ids = ['mr-form', 'mr-reporter', 'mr-lead', 'mr-lead-toggle', 'mr-office-note', 'mr-outcomes',
    'mr-companions', 'mr-companion-other-wrap', 'mr-companion-other', 'mr-note', 'mr-note-count',
    'mr-error', 'mr-submit', 'mr-done', 'mr-summary', 'mr-whatsapp', 'mr-again'];
  ids.forEach((i) => { els[i] = fakeEl(i); });
  els['mr-office-note'].classList.add('hidden');
  const posts = [];
  const sandbox = {
    document: { getElementById: (i) => els[i] || null, createElement: () => fakeEl('x') },
    location: { reload() {} },
    fetch: async (url, opts) => {
      if (opts && opts.method === 'POST') {
        posts.push(JSON.parse(opts.body));
        return { status: 200, json: async () => ({ ok: true }) };
      }
      return { status: 200, json: async () => ({ ok: true, leads, managers: [{ house: 'ramot', name: 'אורן' }] }) };
    },
    console, setTimeout, clearTimeout, Promise, Date, Math, JSON, String, Number, Object, Array, RegExp,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(MR_SRC, sandbox, { filename: 'meeting-report.js' });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  const panel = els['mr-office-note'];
  const pick = (id) => { els['mr-lead'].value = id; els['mr-lead'].fire('change'); };
  return { els, panel, pick, posts };
}

const FORM_LEADS = [
  { id: 'A', name: 'אלף', house: 'ramot', visitDate: '2026-10-20', officeNote: 'שורה 1\nשורה <2>' },
  { id: 'B', name: 'בית', house: 'arfoni', visitDate: '2026-10-21', officeNote: '' },
  // No visit yet → only listed under «לא מוצא את הליד?».
  { id: 'H', name: 'חבוי', house: 'ramot', visitDate: '', officeNote: 'רקע לליד חבוי' },
];

test('form: hidden until a lead is picked; shows the picked lead’s note; hides for a lead without one', async () => {
  const { panel, pick } = await bootForm(FORM_LEADS);
  assert.ok(panel.classList.contains('hidden'), 'nothing picked → hidden');
  pick('A');
  assert.ok(!panel.classList.contains('hidden'));
  assert.ok(panel.innerHTML.includes('רקע מהמשרד'));
  assert.ok(panel.innerHTML.includes('שורה 1\nשורה &lt;2&gt;'), 'escaped, line break kept');
  pick('B');
  assert.ok(panel.classList.contains('hidden'), 'empty note → hidden');
  assert.equal(panel.innerHTML, '');
  pick('A');
  pick('');
  assert.ok(panel.classList.contains('hidden'), 'back to «בחר/י ליד…» → hidden');
});

test('form: the «לא מוצא את הליד?» toggle reveals a lead whose note then shows; the re-render never leaves a stale note', async () => {
  const { els, panel, pick } = await bootForm(FORM_LEADS);
  assert.ok(!els['mr-lead'].innerHTML.includes('value="H"'), 'H hidden by default');
  pick('A');
  assert.ok(!panel.classList.contains('hidden'));
  els['mr-lead-toggle'].fire('click');
  assert.ok(els['mr-lead'].innerHTML.includes('value="H"'), 'H revealed');
  assert.ok(panel.classList.contains('hidden'), 'the picker re-render cleared the pick → no stale note');
  pick('H');
  assert.ok(panel.innerHTML.includes('רקע לליד חבוי'));
  assert.ok(!panel.classList.contains('hidden'));
});

test('PRIVACY: the submit payload carries the manager’s report, never the office note', async () => {
  const { els, pick, posts } = await bootForm(FORM_LEADS);
  pick('A');
  els['mr-reporter'].value = 'אורן';
  els['mr-note'].value = 'הדיווח שלי';
  els['mr-outcomes'].fire('click', { target: { closest: () => ({ getAttribute: () => 'advancing' }) } });
  await Promise.all(els['mr-submit'].fire('click'));
  assert.equal(posts.length, 1);
  assert.deepEqual(Object.keys(posts[0]).sort(), ['companion', 'leadId', 'note', 'outcome', 'reporter', 'submissionId']);
  assert.equal(posts[0].note, 'הדיווח שלי');
  assert.ok(!JSON.stringify(posts[0]).includes('שורה 1'), 'office note not submitted');
});

/* ===== real Chromium (skipped where no browser) ===== */

let playwright = null;
try { playwright = require('playwright'); } catch (_) { /* not installed — skip */ }
const chromiumPath = [process.env.EZONE_CHROMIUM, '/opt/pw-browsers/chromium'].filter(Boolean)
  .find((p) => { try { return fs.existsSync(p); } catch (_) { return false; } });
const skip = !playwright ? 'playwright is not installed' : (!chromiumPath ? 'no Chromium binary found' : false);

function serve() {
  const types = { '.css': 'text/css', '.js': 'application/javascript', '.html': 'text/html; charset=utf-8' };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    if (u.pathname === '/api/meeting-report/leads') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, leads: FORM_LEADS, managers: [{ house: 'ramot', name: 'אורן' }] }));
      return;
    }
    const file = u.pathname === '/' ? 'meeting-report.html' : u.pathname.slice(1);
    const f = path.join(PUBLIC, file);
    if (!f.startsWith(PUBLIC) || !fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' });
    res.end(fs.readFileSync(f));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('browser: the panel renders multi-line RTL, escaped, and hides/updates with the pick', { skip }, async () => {
  const server = await serve();
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForSelector('#mr-lead option[value="A"]', { state: 'attached' });
    assert.equal(await page.isVisible('#mr-office-note'), false);
    await page.selectOption('#mr-lead', 'A');
    assert.equal(await page.isVisible('#mr-office-note'), true);
    const box = await page.$eval('.mr-office-note-text', (e) => ({
      text: e.innerText, ws: getComputedStyle(e).whiteSpace, dir: getComputedStyle(e).direction,
      tags: e.children.length,
    }));
    assert.equal(box.text, 'שורה 1\nשורה <2>');
    assert.equal(box.ws, 'pre-wrap');
    assert.equal(box.dir, 'rtl');
    assert.equal(box.tags, 0, 'no element was injected from the note');
    assert.equal(await page.textContent('.mr-office-note-label'), 'רקע מהמשרד');
    await page.selectOption('#mr-lead', 'B');
    assert.equal(await page.isVisible('#mr-office-note'), false);
    await page.click('#mr-lead-toggle');
    await page.selectOption('#mr-lead', 'H');
    assert.equal(await page.textContent('.mr-office-note-text'), 'רקע לליד חבוי');
  } finally {
    await browser.close();
    server.close();
  }
});
