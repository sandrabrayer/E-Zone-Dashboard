'use strict';

/* «היום שלי»: every task card opens (CHANGELOG-crm-today-card-open.md).
 *
 * Root cause pinned here: a discharge recorded by the classic «שחרר» flow has
 * NO `patientId`, so the «לעדכן המשך טיפול» row rendered data-open-patient=""
 * and the click handler (truthy check) silently did nothing.
 *
 * A. pure: dischargePatientId / houseExceptions / continuity helpers.
 * B. real server + real page in Chromium (skipped without playwright): every
 *    «כרטיס» on «היום שלי» opens a drawer, as Vered and as Dana, at desktop,
 *    mid and split-screen widths; no horizontal page scroll; the drawer is
 *    fully on screen; «לעדכן המשך טיפול» saves through setDischargeContinuity.
 * Names are SYNTHETIC. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const core = require('../public/crm/crm.js');

const israelDay = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date(ms));
const TODAY = israelDay(Date.now());
const daysAgo = (n) => israelDay(Date.now() - n * 86400000);

/* ================= A. pure ================= */

const PATIENTS = [
  { id: 'p-active', houseId: 'ramot', name: 'דנה כהן', date: '2026-07-01', status: 'active', fromLead: '' },
  { id: 'p-brit', houseId: 'ramot', name: 'ברית  ונגרטון', date: '2026-08-01', status: 'released', fromLead: 'L-brit' },
  { id: 'p-yuval', houseId: 'arfoni', name: 'יובל א', date: '2026-09-01', status: 'released', fromLead: 'L-yuval' },
];

test('A: dischargePatientId — patientId on Patients; else the stay triple (spaces normalised); else the one released row of the same lead; else the stored id', () => {
  assert.equal(core.dischargePatientId({ patientId: 'p-active', houseId: 'ramot', name: 'x' }, PATIENTS), 'p-active');
  // classic discharge: no patientId → triple
  assert.equal(core.dischargePatientId({ patientId: '', houseId: 'ramot', name: 'ברית ונגרטון', date: '2026-08-01' }, PATIENTS), 'p-brit');
  // house given by Hebrew name, entry date differs → the one released row of the same lead
  assert.equal(core.dischargePatientId({ houseId: 'קיסריה עפרוני', name: 'יובל אברמוביץ', date: '', fromLead: 'L-yuval' }, PATIENTS), 'p-yuval');
  // nothing matches → stored id, or ''
  assert.equal(core.dischargePatientId({ patientId: 'gone', houseId: 'ramot', name: 'אין' }, PATIENTS), 'gone');
  assert.equal(core.dischargePatientId({ houseId: 'ramot', name: 'אין' }, PATIENTS), '');
  // two same-lead released rows → ambiguous → not guessed
  const twice = PATIENTS.concat([{ id: 'p-yuval2', houseId: 'arfoni', name: 'יובל', date: '2026-10-01', status: 'released', fromLead: 'L-yuval' }]);
  assert.equal(core.dischargePatientId({ houseId: 'arfoni', name: 'יובל אברמוביץ', fromLead: 'L-yuval' }, twice), '');
});

test('A: houseExceptions — a classic discharge (no patientId) gets the resolved patient id, opens on «פגישות ושירותים»; restored (any spelling) / recorded continuity → no row; «unknown» still needs an update', () => {
  const base = { id: 'd1', houseId: 'ramot', name: 'ברית ונגרטון', date: '2026-08-01', exitDate: daysAgo(3), fromLead: 'L-brit' };
  const c = { leads: [], patients: PATIENTS, discharges: [base] };
  const ex = core.houseExceptions(c, TODAY);
  assert.equal(ex.length, 1);
  assert.equal(ex[0].subjectKind, 'patient');
  assert.equal(ex[0].subjectId, 'p-brit', 'never an empty id');
  assert.equal(ex[0].open, 'meetings');
  assert.equal(ex[0].dischargeId, 'd1');
  for (const r of ['TRUE', 'true', '1']) assert.equal(core.houseExceptions({ leads: [], patients: PATIENTS, discharges: [Object.assign({}, base, { restored: r })] }, TODAY).length, 0, 'restored ' + r);
  assert.equal(core.houseExceptions({ leads: [], patients: PATIENTS, discharges: [Object.assign({}, base, { continuity: 'none' })] }, TODAY).length, 0);
  assert.equal(core.houseExceptions({ leads: [], patients: PATIENTS, discharges: [Object.assign({}, base, { continuity: 'unknown' })] }, TODAY).length, 1);
  assert.equal(core.houseExceptions({ leads: [], patients: PATIENTS, discharges: [Object.assign({}, base, { continuity: 'שחר' })] }, TODAY).length, 0, 'a legacy free-text value was recorded');
  assert.equal(core.continuityRecorded('שחר'), true); assert.equal(core.continuityRecorded('unknown'), false);
});

test('A: houseExceptions — referral/disposition is NOT verified continuation; unresolved remains one follow-up', () => {
  const base = { id: 'd2', houseId: 'ramot', name: 'ברית ונגרטון', date: '2026-08-01', exitDate: daysAgo(3), fromLead: 'L-brit' };
  const intended = core.houseExceptions({ leads: [], patients: PATIENTS, discharges: [Object.assign({}, base, { disposition: 'released_outpatient' })] }, TODAY);
  assert.equal(intended.length, 1);
  assert.match(intended[0].why, /לא אומתו/);
  const sent = core.houseExceptions({ leads: [], patients: PATIENTS, discharges: [Object.assign({}, base, { disposition: 'completed' })], outpatientSent: { 'discharge:d2': true } }, TODAY);
  assert.equal(sent.length, 1);
  assert.match(sent[0].why, /לא התקבל אישור/);
  assert.equal(sent[0].id, 'ex:cont:d2');
  assert.equal(core.houseExceptions({ leads: [], patients: PATIENTS, discharges: [Object.assign({}, base, { disposition: 'completed' })], outpatientSent: {} }, TODAY).length, 1);
});

test('A: continuity helpers — only the three keys count as recorded; the body is the existing setDischargeContinuity action', () => {
  assert.equal(core.continuityKnown('continued_outpatient'), true);
  assert.equal(core.continuityKnown('unknown'), false);
  assert.equal(core.continuityKnown(''), false);
  assert.equal(core.continuityKnown('שחר'), false);
  assert.deepEqual(core.continuityBody(' d1 ', 'none'), { action: 'setDischargeContinuity', id: 'd1', continuity: 'none' });
  assert.equal(core.isRestoredDischarge({ restored: 'TRUE' }), true);
  assert.equal(core.isRestoredDischarge({ restored: '' }), false);
});

test('A: source guards — the click handler checks the ATTRIBUTE (an empty id reaches openDrawer), openDrawer never returns silently', () => {
  const src = fs.readFileSync(require.resolve('../public/crm/crm.js'), 'utf8');
  assert.match(src, /t\.hasAttribute\('data-open-lead'\) \|\| t\.hasAttribute\('data-open-patient'\)/);
  assert.doesNotMatch(src, /if \(!lead && !pat\) return;/);
  assert.match(src, /if \(!lead && !pat\) \{ toast\(/);
});

/* ================= B. browser ================= */

let playwright = null;
try { playwright = require('playwright'); } catch (_) { /* skip */ }
const CHROMIUM_CANDIDATES = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium/chrome-linux/chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
let chromiumPath = CHROMIUM_CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch (_) { return false; } });
if (!chromiumPath) {
  try {
    const d = '/opt/pw-browsers';
    chromiumPath = fs.readdirSync(d).filter((n) => n.startsWith('chromium-'))
      .map((n) => d + '/' + n + '/chrome-linux/chrome').find((p) => fs.existsSync(p));
  } catch (_) { /* none */ }
}
if (!chromiumPath && playwright) { try { const p = playwright.chromium.executablePath(); if (p && fs.existsSync(p)) chromiumPath = p; } catch (_) { /* none */ } }
const skip = !playwright || !chromiumPath;

const pinHash = require('../lib/pin-hash');
const users = require('../lib/users');
const { createSessionToken } = require('../lib/session');
const SERVER_PATH = require.resolve('../server');
const PEPPER = 'pepper-TEST-crm-today-card-open-0123456789abcd';
const SESSION_SECRET = 'session-secret-TEST-crm-today-card-open-012';
const PROXY_SECRET = 'proxy-secret-TEST-crm-today-card-open-0123456';
const ENV_KEYS = ['PROXY_SECRET', 'SESSION_SECRET', 'SHEETS_URL', 'USER_PIN_HASHES', 'PIN_PEPPER', 'CRM_ENABLED'];

const DATA = {
  ok: true, irrelevantLeads: [], removedLeads: [], billingOverrides: [], houseManagers: {}, managerPhones: {}, currentManagers: [], outpatientSentLeadIds: [],
  dischargedPatients: [
    // classic «שחרר» rows: NO patientId (the bug)
    { id: 'dx-brit', name: 'ברית ונגרטון', houseId: 'ramot', date: daysAgo(80), exitDate: daysAgo(14), dischargedAt: daysAgo(14) + 'T09:00:00.000Z', disposition: 'completed', fromLead: 'L-brit', restored: '' },
    { id: 'dx-adi', name: 'עדי עמית', houseId: 'rehab', date: daysAgo(40), exitDate: daysAgo(13), dischargedAt: daysAgo(13) + 'T09:00:00.000Z', disposition: 'stopped_early', fromLead: '', restored: '' },
  ],
  leads: [
    { id: 'L1', name: 'יפעת שנלר', house: 'רמות השבים', stage: 'new', created: daysAgo(7), assignedTo: 'ורד', phone: '0501111111' },
    { id: 'L5', name: 'אלמוג אוחיון', house: 'רמות השבים', stage: 'visit', visitDate: daysAgo(4), meetingWith: 'אורן', created: daysAgo(9), meetingReportOutcome: 'undecided', meetingReporter: 'אורן', meetingReportedAt: daysAgo(2) + 'T07:00:00.000Z', meetingSeen: '' },
    { id: 'L6', name: 'מעיין', house: 'רמות השבים', stage: 'visit', visitDate: daysAgo(10), meetingWith: 'אורן', created: daysAgo(12), meetingReportedAt: daysAgo(8) + 'T07:00:00.000Z', meetingReporter: 'אורן', meetingSeen: '1' },
    { id: 'L-no-show-synthetic', name: 'מטופל היעדרות בדיקה', house: 'רמות השבים', stage: 'visit', created: daysAgo(9), visitDate: daysAgo(6), meetingWith: 'מנהל בדיקה', meetingReportedAt: daysAgo(5) + 'T09:00:00.000Z', meetingReporter: 'מנהל בדיקה', meetingReportOutcome: 'no_show', meetingSeen: '1', meetingOutcome: '', assignedTo: 'ורד' },
  ],
  patients: {
    ramot: [{ id: 'p1', name: 'דנה כהן', date: daysAgo(30), status: 'active' }, { id: 'p-brit', name: 'ברית ונגרטון', date: daysAgo(80), status: 'released', exitDate: daysAgo(14), fromLead: 'L-brit' }],
    rehab: [{ id: 'p-adi', name: 'עדי עמית', date: daysAgo(40), status: 'released', exitDate: daysAgo(13) }],
  },
};

async function boot() {
  const posts = [];
  const contactEvents = [];
  const followupTasks = [];
  const hash = await pinHash.hashPin('583920', PEPPER);
  const recs = ['vered', 'dana'].map((id) => JSON.parse(users.recordLine(id, hash, 1)));
  const env = { PROXY_SECRET, SESSION_SECRET, SHEETS_URL: 'https://script.google.com/macros/s/TEST/exec', PIN_PEPPER: PEPPER, USER_PIN_HASHES: JSON.stringify(recs), CRM_ENABLED: 'true' };
  const saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; process.env[k] = env[k]; }
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  delete require.cache[SERVER_PATH];
  let mod;
  try { mod = require('../server'); } finally { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
  const original = https.request;
  https.request = (url, opts, cb) => {
    const req = new EventEmitter();
    let body = '';
    req.write = (c) => { body += c; };
    req.end = () => {
      let parsed = {};
      try { parsed = JSON.parse(body); } catch (_) { parsed = {}; }
      posts.push(parsed);
      let contactResult = null;
      if (parsed.action === 'logContact') {
        const prev = contactEvents.find(e => e.submissionId === parsed.submissionId);
        if (prev) {
          contactResult = { ok: true, event: prev, created: followupTasks.find(t => t.contactEventId === prev.eventId) || null, replayed: true };
        } else {
          const ev = Object.assign({ eventId: 'contact:' + parsed.submissionId, kind: 'contact_logged', submissionId: parsed.submissionId }, parsed.contact || {});
          contactEvents.push(ev);
          const next = parsed.next || {};
          let created = null;
          if (!next.none) {
            created = { id: 'task-' + parsed.submissionId.slice(4) + '-next', kind: 'call', leadId: ev.leadId,
              title: next.title || 'לחזור', reason: next.reason || '', assignee: next.assignee || 'ורד',
              dueDate: next.dueDate || '', dueTime: next.dueTime || '', status: 'open', source: 'contact', contactEventId: ev.eventId };
            followupTasks.push(created);
          }
          contactResult = { ok: true, event: ev, created };
        }
      }
      const answer = parsed.action === 'getData' ? DATA
        : parsed.action === 'getTasks' ? { ok: true, total: followupTasks.length, tasks: followupTasks }
        : parsed.action === 'contactIndex' ? { ok: true, count: contactEvents.length, leads: {}, patients: {} }
        : parsed.action === 'getActivity' ? { ok: true, events: contactEvents.filter(e => (parsed.leadId && e.leadId === parsed.leadId) || (parsed.patientId && e.patientId === parsed.patientId)) }
        : parsed.action === 'logContact' ? contactResult
        : parsed.action === 'debtAging' ? { ok: true, byPatient: [], totals: {}, byHouse: [] }
        : parsed.action === 'getPayments' ? { ok: true, payments: [], receipts: [], funders: [] }
        : parsed.action === 'getCredits' ? { ok: true, credits: [] }
        : parsed.action === 'setDischargeContinuity' ? { ok: true, id: parsed.id, continuity: parsed.continuity }
        : parsed.action === 'saveAll' ? { ok: true, proven: { leads: (parsed.leads || []).map((l) => String(l.id)), patients: [] } }
        : { ok: true };
      const res = new EventEmitter();
      res.statusCode = 200; res.headers = {}; res.setEncoding = () => {}; res.resume = () => {};
      setImmediate(() => { cb(res); res.emit('data', JSON.stringify(answer)); res.emit('end'); });
    };
    return req;
  };
  const srv = await new Promise((resolve) => { const s = mod.app.listen(0, '127.0.0.1', () => resolve(s)); });
  return { port: srv.address().port, posts, contactEvents, followupTasks, close() { srv.close(); https.request = original; Object.assign(console, quiet); } };
}

async function openPage(browser, port, id, width) {
  const ctx = await browser.newContext({ viewport: { width, height: 800 }, locale: 'he-IL', timezoneId: 'Asia/Jerusalem', serviceWorkers: 'block' });
  const name = users.modelById(id).name;
  await ctx.addCookies([{ name: 'ezone_session', value: createSessionToken(SESSION_SECRET, undefined, undefined, name, { id, pinVersion: 1 }), url: `http://127.0.0.1:${port}` }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e && e.message)));
  await page.goto(`http://127.0.0.1:${port}/?view=crm`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#crm-main .row.work:not(.h)', { timeout: 15000 });
  return { ctx, page, errors };
}

const WIDTHS = [1440, 1280, 1024, 960, 768, 700];

test('B: every «כרטיס» on «היום שלי» opens a drawer — Vered and Dana, desktop / mid / split-screen widths; no horizontal scroll; drawer on screen', { skip }, async () => {
  const srv = await boot();
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  try {
    for (const who of ['vered', 'dana']) {
      for (const width of WIDTHS) {
        const { ctx, page, errors } = await openPage(browser, srv.port, who, width);
        const n = await page.locator('#crm-main .row.work:not(.h) button:text-is("כרטיס")').count();
        assert.ok(n >= 4, `${who}@${width}: task cards rendered (${n})`);
        const names = [];
        for (let i = 0; i < n; i++) {
          const btn = page.locator('#crm-main .row.work:not(.h) button:text-is("כרטיס")').nth(i);
          await btn.scrollIntoViewIfNeeded();
          await btn.click();
          await page.waitForFunction(() => document.querySelector('#crm-drawer').getAttribute('aria-hidden') === 'false', null, { timeout: 3000 });
          // the drawer slides in (CSS transform transition): measure once it has settled
          await page.waitForFunction(() => { const r = document.querySelector('#crm-drawer').getBoundingClientRect(); return r.left >= -1 && r.right <= window.innerWidth + 1; }, null, { timeout: 3000 }).catch(() => {});
          const box = await page.evaluate(() => { const r = document.querySelector('#crm-drawer').getBoundingClientRect(); return { l: r.left, r: r.right, w: window.innerWidth, h2: document.querySelector('#crm-drawer h2').textContent }; });
          assert.ok(box.l >= -1 && box.r <= box.w + 1, `${who}@${width}: drawer fully visible (${box.l}..${box.r} of ${box.w})`);
          names.push(box.h2);
          await page.click('#crm-drawer-close');
          await page.waitForFunction(() => document.querySelector('#crm-drawer').getAttribute('aria-hidden') !== 'false', null, { timeout: 3000 });
        }
        assert.ok(names.includes('ברית ונגרטון') && names.includes('עדי עמית'), `${who}@${width}: the discharged patients open (${names.join(', ')})`);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        assert.ok(overflow <= 1, `${who}@${width}: no horizontal page scroll (${overflow}px)`);
        assert.deepEqual(errors, [], `${who}@${width}: no page errors`);
        await ctx.close();
      }
    }
  } finally { await browser.close(); srv.close(); }
});

test('B: «לעדכן המשך טיפול» → «לעדכון» opens Brit on «פגישות ושירותים» with the continuity select; saving posts setDischargeContinuity and the row leaves the list', { skip }, async () => {
  const srv = await boot();
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  try {
    const { ctx, page, errors } = await openPage(browser, srv.port, 'vered', 1024);
    const row = page.locator('#crm-main .row.work:not(.h)', { hasText: 'ברית ונגרטון' }).first();
    await row.locator('button:text-is("לעדכון")').click();
    await page.waitForSelector('#crm-drawer [data-pane="meetings"]:not([hidden]) select[data-continuity-for="dx-brit"]', { timeout: 3000 });
    await page.selectOption('#crm-drawer select[data-continuity-for="dx-brit"]', 'continued_outpatient');
    await page.click('#crm-drawer [data-continuity-save="dx-brit"]');
    await page.waitForFunction(() => !/ברית ונגרטון[\s\S]*לעדכן המשך טיפול/.test(Array.from(document.querySelectorAll('#crm-main .row.work:not(.h)')).map((r) => r.textContent).join('|')), null, { timeout: 3000 });
    const sent = srv.posts.filter((p) => p.action === 'setDischargeContinuity');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].id, 'dx-brit');
    assert.equal(sent[0].continuity, 'continued_outpatient');
    assert.deepEqual(errors, []);
    await ctx.close();
  } finally { await browser.close(); srv.close(); }
});


test('B: a read manager no-show produces the real contact form and non-held notice; Vered and Dana, desktop/mobile, read-only navigation', { skip }, async () => {
  const srv = await boot();
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  try {
    for (const [who, width] of [['vered', 1024], ['dana', 390]]) {
      const { ctx, page, errors } = await openPage(browser, srv.port, who, width);
      const row = page.locator('#crm-main .row.work:not(.h)', { hasText: 'מטופל היעדרות בדיקה' }).first();
      await row.waitFor({ timeout: 5000 });
      assert.match(await row.textContent(), /לברר היעדרות.*לתאם מועד חדש/, who + ': actionable no-show follow-up');
      assert.match(await row.textContent(), /לא הגיע\s*\/\s*בוטל/, who + ': manager report result shown');
      await row.locator('button:text-is("תיעוד שיחה")').click();
      await page.waitForSelector('#crm-drawer form[data-form="contact"]', { timeout: 5000 });
      assert.match(await page.textContent('#crm-drawer h2'), /תיעוד שיחה/, 'uses the EXISTING logContact form');
      await page.click('#crm-drawer [data-contact-cancel]');
      await page.click('#crm-drawer [data-tab="meetings"]');
      await page.waitForSelector('#crm-meetings:not([hidden])', { timeout: 5000 });
      assert.match(await page.textContent('#crm-meetings'), /לא הגיע\s*\/\s*בוטל.*אין אישור שהביקור התקיים/, 'manager result cannot imply the meeting was held');
      assert.deepEqual(errors, [], who + ': no browser exceptions');
      await ctx.close();
    }
    assert.equal(srv.posts.filter((p) => p.action === 'saveAll' || p.action === 'logContact').length, 0,
      'navigating and opening the contact form does not mutate records');
  } finally { await browser.close(); srv.close(); }
});


test('B: Vered saves a no-show callback and scheduled next task; source echoes persist across reload and remain visible', { skip }, async () => {
  const srv = await boot();
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  try {
    const { ctx, page, errors } = await openPage(browser, srv.port, 'vered', 1024);
    const row = page.locator('#crm-main .row.work:not(.h)', { hasText: 'מטופל היעדרות בדיקה' }).first();
    await row.locator('button:text-is("תיעוד שיחה")').click();
    const form = '#crm-drawer form[data-form="contact"]';
    await page.selectOption(form + ' select[name="outcome"]', 'call_back_later');
    await page.fill(form + ' textarea[name="summary"]', 'שיחת המשך בעקבות ביקור שלא התקיים');
    await page.check(form + ' input[name="next"][value="d3"]');
    await page.click(form + ' button[type="submit"]');
    await page.waitForFunction(() => {
      const dr = document.querySelector('#crm-drawer');
      return dr && dr.getAttribute('aria-hidden') === 'false'
        && dr.querySelector('[data-pane="tasks"]:not([hidden])')
        && dr.textContent.includes('שיחת המשך בעקבות ביקור שלא התקיים');
    }, null, { timeout: 7000 });

    const writes = srv.posts.filter(p => p.action === 'logContact');
    assert.equal(writes.length, 1, 'one contact command; no duplicate business write');
    assert.equal(writes[0].contact.leadId, 'L-no-show-synthetic', 'same stable source lead');
    assert.equal(writes[0].contact.outcome, 'call_back_later');
    assert.match(writes[0].contact.summary, /ביקור שלא התקיים/);
    assert.equal(writes[0].next.assignee, 'ורד');
    assert.equal(writes[0].next.dueDate,
      new Date(Date.parse(TODAY + 'T12:00:00Z') + 3 * 86400000).toISOString().slice(0, 10));
    assert.match(writes[0].submissionId, /^sub-[0-9a-f]{32}$/, 'stable idempotency key');
    assert.equal(srv.contactEvents.length, 1, 'synthetic authoritative event persisted');
    assert.equal(srv.followupTasks.length, 1, 'synthetic authoritative next task persisted');
    assert.equal(srv.followupTasks[0].leadId, 'L-no-show-synthetic');

    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('#crm-main .row.work:not(.h)', { timeout: 7000 });
    const task = page.locator('#crm-main .row.work.task', { hasText: 'שיחת המשך בעקבות ביקור שלא התקיים' });
    await task.waitFor({ timeout: 7000 });
    assert.match(await task.textContent(), /ורד/, 'new task has an accountable owner after independent reload');
    assert.equal(srv.followupTasks.length, 1, 'reload never creates a second task');
    assert.deepEqual(errors, [], 'no page errors during save/reload');
    await ctx.close();
  } finally { await browser.close(); srv.close(); }
});
