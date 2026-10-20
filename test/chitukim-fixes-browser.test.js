/* «חתכי מטופלים» fixes in a REAL browser (CHANGELOG-chitukim-fixes.md).
 *
 * The real index.html, app.js, style.css and the lib modules in Chromium.
 *
 * ROOT CAUSE pinned here: the threshold inputs re-rendered the whole panel
 * from their `change` handler, and a number input fires `change` on BLUR —
 * on the mousedown of the next control — so the panel was replaced between
 * mousedown and mouseup and the browser fired no click. Every regression
 * test below types a threshold first (no blur), then clicks ONE control the
 * way a person does; against the old code each of them fails (the list never
 * opens, the download never starts).
 *
 * Also: the list behind a number (columns, close, its own export), the
 * bucket sub-lines «+N עדיין בטיפול» reconcile with the cohort and the
 * «עדיין בטיפול» card, spinners (aria-busy + disabled, painted, a double
 * click ignored), the error toast with «נסו שוב», 44px targets.
 *
 * SKIPPED unless BOTH `playwright` resolves AND a Chromium binary is present
 * (same contract as the other browser suites). All data is SYNTHETIC. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const PUBLIC = path.join(__dirname, '..', 'public');
const LIB = path.join(__dirname, '..', 'lib');

let playwright = null;
try { playwright = require('playwright'); } catch (_) { /* not installed — skip */ }
if (!playwright) {
  try {
    const groot = require('node:child_process').execSync('npm root -g').toString().trim();
    playwright = require(path.join(groot, 'playwright'));
  } catch (_) { /* still unavailable — skip */ }
}
const CHROMIUM_CANDIDATES = [process.env.EZONE_CHROMIUM, '/opt/pw-browsers/chromium'].filter(Boolean);
const chromiumPath = CHROMIUM_CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch (_) { return false; } });
const skip = !playwright ? 'playwright is not installed' : (!chromiumPath ? 'no Chromium binary found' : false);

const TYPES = { '.css': 'text/css', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png' };

/* public/ as is; a script index.html links that lives in lib/ (as server.js
 * serves it) comes from lib/. /api/* answers a harmless ok. */
function serve() {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    if (u.pathname.startsWith('/api/')) {
      res.writeHead(200, { 'Content-Type': TYPES['.json'] });
      return res.end(JSON.stringify({ ok: true, user: 'ורד', patients: [], leads: [], payments: [] }));
    }
    const rel = u.pathname === '/' ? 'index.html' : u.pathname.replace(/^\//, '');
    let file = path.join(PUBLIC, rel);
    if (!fs.existsSync(file)) file = path.join(LIB, rel);
    if (!(file.startsWith(PUBLIC) || file.startsWith(LIB)) || !fs.existsSync(file)) { res.writeHead(404); return res.end('nf'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, () => resolve({ server, port: server.address().port })));
}

const EVIL = '<img src=x onerror="window.__pwned=1">';

/* 3 discharged (10 / 45 / 80 days), 4 still in treatment (5 / 10 / 40 / 70
 * days so far), 1 released without a discharge day («נתונים חסרים»). */
const SEED = `
  (() => {
    const today = debtAgingTodayIso();
    const ago = (n) => { const d = new Date(today + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
    state.mode = 'edit'; state.finance = true; state.view = 'full';
    document.body.classList.remove('viewer-mode');
    state.leads = []; state.payments = []; state.funders = []; state.irrelevantLeads = []; state.removedLeads = [];
    state.patients = [
      normalizePatient({ id: 'D1', houseId: 'ramot', name: ${JSON.stringify(EVIL + 'אלף')}, date: ago(80), status: 'released', exitDate: ago(70) }),
      normalizePatient({ id: 'D2', houseId: 'asher', name: 'בית', date: ago(90), status: 'released', exitDate: ago(45) }),
      normalizePatient({ id: 'D3', houseId: 'ramot', name: 'גימל', date: ago(100), status: 'released', exitDate: ago(20) }),
      normalizePatient({ id: 'A1', houseId: 'ramot', name: 'דלת', date: ago(10), status: 'active' }),
      normalizePatient({ id: 'A2', houseId: 'asher', name: 'הא', date: ago(40), status: 'active' }),
      normalizePatient({ id: 'A3', houseId: 'ramot', name: 'וו', date: ago(70), status: 'active' }),
      normalizePatient({ id: 'A4', houseId: 'ramot', name: 'זין', date: ago(5), status: 'active' }),
      normalizePatient({ id: 'M1', houseId: 'ramot', name: 'חית', date: ago(30), status: 'released' }),
    ];
    state.dischargedPatients = [
      { id: 'a1', patientId: 'D1', houseId: 'ramot', name: ${JSON.stringify(EVIL + 'אלף')}, date: ago(80), exitDate: ago(70), continuity: 'none', phone: '0501234567' },
      { id: 'a2', patientId: 'D2', houseId: 'asher', name: 'בית', date: ago(90), exitDate: ago(45), continuity: 'continued_outpatient', phone: '0527654321' },
      { id: 'a3', patientId: 'D3', houseId: 'ramot', name: 'גימל', date: ago(100), exitDate: ago(20), continuity: '' },
    ].map(normalizeDischargedPatient);
    const ui = patientRetentionUi();
    Object.assign(ui, { open: false, from: ago(120), to: today, threshold: '', completionThreshold: '', sel: null });
    document.getElementById('app').classList.remove('hidden');
    showScreen('discharged-patients');
    renderAll();
  })();
`;

async function withPage(fn, opts) {
  const { server, port } = await serve();
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath, env: Object.assign({}, process.env, { LANG: 'C.UTF-8' }) });
  try {
    const ctx = await browser.newContext(Object.assign({ viewport: { width: 1100, height: 900 }, locale: 'he-IL', serviceWorkers: 'block', acceptDownloads: true }, opts || {}));
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'networkidle' });
    await page.evaluate(SEED);
    await page.click('#patient-retention-btn');
    await page.waitForSelector('#patient-retention .pr-stats');
    await fn(page);
    assert.deepEqual(errors, [], 'no page errors');
    assert.equal(await page.evaluate(() => window.__pwned), undefined, 'nothing injected');
    await ctx.close();
  } finally {
    await browser.close();
    server.close();
  }
}

const P = '#patient-retention ';
const listTitle = (page) => page.$eval(P + '.pr-list-title', (e) => e.textContent).catch(() => null);
/* Type a value into the custom-days input WITHOUT leaving it — the state in
 * which the old change-handler re-render swallowed the next click. */
const typeThreshold = (page) => page.fill(P + '.pr-threshold', '20');

/* Click `selector` after typing a threshold; the list titled `title` opens. */
async function clickOpens(page, selector, title) {
  await typeThreshold(page);
  await page.click(selector);
  await page.waitForFunction((t) => {
    const el = document.querySelector('#patient-retention .pr-list-title');
    return !!el && el.textContent.startsWith(t);
  }, title, { timeout: 4000 });
}

/* Click `selector` after typing a threshold; one download starts. */
async function clickDownloads(page, selector) {
  await typeThreshold(page);
  const dl = page.waitForEvent('download', { timeout: 4000 });
  await page.click(selector);
  return (await dl).suggestedFilename();
}

/* ---------- 1. regression: every control works on the first click ---------- */

test('regression: each bucket card opens its discharged list on the first click after typing a threshold', { skip, timeout: 120000 }, async () => {
  await withPage(async (page) => {
    for (const [key, label] of [['upTo30', 'עד 30 יום'], ['d31to60', '31–60 יום'], ['over60', '61 יום ומעלה']]) {
      await clickOpens(page, `${P}.pr-stat[data-sel*='"bucket"'][data-sel*='"${key}"']`, `שוחררו · ${label} (1)`);
    }
  });
});

test('regression: each bucket sub-line «+N עדיין בטיפול» opens the still-in-treatment list', { skip, timeout: 120000 }, async () => {
  await withPage(async (page) => {
    for (const [key, label, n] of [['upTo30', 'עד 30 יום', 2], ['d31to60', '31–60 יום', 1], ['over60', '61 יום ומעלה', 1]]) {
      await clickOpens(page, `${P}.pr-stat-sub[data-sel*='"${key}"']`, `עדיין בטיפול · ${label} (${n})`);
    }
  });
});

test('regression: the «עדיין בטיפול» card and each of its chips open their lists', { skip, timeout: 120000 }, async () => {
  await withPage(async (page) => {
    await clickOpens(page, `${P}.pr-stat[data-sel*='"still"']`, 'עדיין בטיפול (4)');
    for (const [key, label, n] of [['upTo30', 'עד 30 יום', 2], ['d31to60', '31–60 יום', 1], ['over60', '61 יום ומעלה', 1]]) {
      await clickOpens(page, `${P}.pr-sub .pr-link[data-sel*='"${key}"']`, `עדיין בטיפול · ${label} (${n})`);
    }
  });
});

test('regression: each continuity card opens its list', { skip, timeout: 120000 }, async () => {
  await withPage(async (page) => {
    for (const [key, label, n] of [['continued_outpatient', 'המשיך באמבולטורי (E-ZONE)', 1], ['continued_other', 'המשיך במסגרת טיפולית אחרת', 0], ['none', 'לא המשיך', 1], ['unknown', 'לא ידוע', 1]]) {
      await clickOpens(page, `${P}.pr-stat[data-sel*='"continuity"'][data-sel*='"${key}"']`, `המשך טיפול · ${label} (${n})`);
    }
  });
});

test('regression: every cross-table cell opens its list', { skip, timeout: 180000 }, async () => {
  await withPage(async (page) => {
    const cells = await page.$$eval(P + '.pr-cell', (bs) => bs.map((b) => b.getAttribute('data-sel')));
    assert.equal(cells.length, 12);
    for (const raw of cells) {
      const sel = JSON.parse(raw);
      const title = await page.evaluate((s) => PatientRetention.listTitle(s), sel);
      await clickOpens(page, `${P}.pr-cell[data-sel='${raw}']`, title + ' (');
    }
  });
});

test('regression: every completion count opens its list; «נתונים חסרים» too', { skip, timeout: 120000 }, async () => {
  await withPage(async (page) => {
    const counts = await page.$$eval(P + '.pr-comp-count', (bs) => bs.map((b) => b.getAttribute('data-sel')));
    assert.equal(counts.length, 6);
    for (const raw of counts) {
      const title = await page.evaluate((s) => PatientRetention.listTitle(s), JSON.parse(raw));
      await clickOpens(page, `${P}.pr-comp-count[data-sel='${raw}']`, title + ' (');
    }
    await clickOpens(page, `${P}.pr-link[data-sel*='"missing"']`, 'נתונים חסרים (1)');
  });
});

test('regression: every «ייצוא» button downloads on the first click after typing a threshold', { skip, timeout: 120000 }, async () => {
  await withPage(async (page) => {
    assert.equal(await clickDownloads(page, P + '.pr-xlsx-all'), await page.evaluate(() => ReportXlsx.fullFilename(patientRetentionUi().from, patientRetentionUi().to)));
    for (const section of ['retention', 'continuity', 'completion']) {
      assert.match(await clickDownloads(page, `${P}.pr-xlsx[data-section="${section}"]`), new RegExp(`^ezone-${section}-.*\\.xlsx$`));
    }
    assert.match(await clickDownloads(page, P + '.pr-sum-csv'), /\.csv$/);
    assert.match(await clickDownloads(page, P + '.pr-comp-csv'), /\.csv$/);
    // the list's own exports
    await clickOpens(page, `${P}.pr-stat[data-sel*='"upTo30"']`, 'שוחררו · עד 30 יום');
    assert.match(await clickDownloads(page, P + '.pr-list .pr-csv'), /\.csv$/);
    assert.match(await clickDownloads(page, P + '.pr-list .pr-xlsx-list'), /^ezone-patients-list-.*\.xlsx$/);
  });
});

test('regression: a typed threshold applies on blur without eating the click — and the export equals the screen', { skip, timeout: 120000 }, async () => {
  await withPage(async (page) => {
    await typeThreshold(page);
    await page.click(`${P}.pr-stat[data-sel*='"over60"']`);
    await page.waitForSelector(P + '.pr-list');
    // the click rendered with the typed value: the «לתקופה מסוימת» cards are there
    assert.ok((await page.$eval('#patient-retention', (e) => e.textContent)).includes('לתקופה מסוימת — 20 ימים'));
    // blur by clicking empty space: applied once nothing is pressed
    await page.fill(P + '.pr-threshold', '50');
    await page.mouse.click(5, 5);
    await page.waitForFunction(() => document.querySelector('#patient-retention').textContent.includes('לתקופה מסוימת — 50 ימים'), null, { timeout: 4000 });
  });
});

/* ---------- 2. the list behind a number ---------- */

test('click-a-count opens the list under its section: columns, escaped names, phone, close, its own «ייצוא לאקסל»', { skip, timeout: 120000 }, async () => {
  await withPage(async (page) => {
    assert.equal(await page.$(P + '.pr-list'), null, 'no list until a number is clicked');
    await page.click(`${P}.pr-stat[data-sel*='"upTo30"']`);
    await page.waitForSelector(P + '.pr-list');
    assert.deepEqual(await page.$$eval(P + '.pr-list th', (t) => t.map((x) => x.textContent)), ['שם', 'בית', 'טלפון', 'תאריך כניסה', 'תאריך שחרור', 'ימים', 'המשך טיפול']);
    const row = await page.$$eval(P + '.pr-list tbody td', (t) => t.map((x) => x.textContent));
    assert.equal(row[0], EVIL + 'אלף', 'the name is text, not markup');
    assert.equal(row[2], '0501234567');
    assert.equal(row[5], '10');
    assert.equal(row[6], 'לא המשיך');
    // it opens right under the length section (before «המשך טיפול»), focused
    assert.ok(await page.evaluate(() => {
      const list = document.querySelector('#patient-retention .pr-list');
      const cont = [...document.querySelectorAll('#patient-retention .pr-section-title')].find((e) => e.textContent.startsWith('המשך טיפול'));
      return !!(list.compareDocumentPosition(cont) & Node.DOCUMENT_POSITION_FOLLOWING);
    }));
    assert.equal(await page.evaluate(() => document.activeElement.className), 'pr-list-title');
    assert.equal(await page.$eval(`${P}.pr-stat[data-sel*='"upTo30"']`, (b) => b.getAttribute('aria-pressed')), 'true');
    // a continuity count opens under its own section
    await page.click(`${P}.pr-stat[data-sel*='"continuity"'][data-sel*='"none"']`);
    await page.waitForFunction(() => document.querySelector('#patient-retention .pr-list-title').textContent.startsWith('המשך טיפול · לא המשיך'));
    const dl = page.waitForEvent('download');
    await page.click(P + '.pr-list .pr-xlsx-list');
    assert.match((await dl).suggestedFilename(), /^ezone-patients-list-/);
    await page.click(P + '.pr-list-close');
    await page.waitForFunction(() => !document.querySelector('#patient-retention .pr-list'));
  });
});

/* ---------- 3. the numbers reconcile ---------- */

test('screen: discharged buckets + still in treatment = the cohort; the sub-lines sum to the «עדיין בטיפול» card', { skip, timeout: 120000 }, async () => {
  await withPage(async (page) => {
    const n = await page.evaluate(() => {
      const num = (s) => Number(document.querySelector(s).textContent);
      const main = ['upTo30', 'd31to60', 'over60'].map((k) => num(`#patient-retention .pr-stat[data-sel*='"bucket"'][data-sel*='"${k}"'] .pr-stat-num`));
      const subs = [...document.querySelectorAll('#patient-retention .pr-stat-sub')].map((b) => b.textContent);
      const still = num(`#patient-retention .pr-stat[data-sel*='"still"'] .pr-stat-num`);
      const cohort = Number(/מתוך (\d+) שנכנסו/.exec(document.querySelector('#patient-retention .pr-section-title').textContent)[1]);
      return { main, subs, still, cohort };
    });
    assert.deepEqual(n.main, [1, 1, 1]);
    assert.deepEqual(n.subs, ['+2 עדיין בטיפול', '+1 עדיין בטיפול', '+1 עדיין בטיפול']);
    const subSum = n.subs.reduce((s, t) => s + Number(/\+(\d+)/.exec(t)[1]), 0);
    assert.equal(subSum, n.still);
    assert.equal(n.main.reduce((a, b) => a + b, 0) + n.still, n.cohort);
    assert.equal(n.cohort, 7);
  });
});

/* ---------- 4. spinners, double click, error toast ---------- */

/* Record every aria-busy / disabled the panel's controls go through and
 * whether a busy control was on screen in an animation frame. */
const WATCH = `(() => {
  window.__busy = [];
  window.__busyFrames = 0;
  new MutationObserver((ms) => ms.forEach((m) => {
    if (m.attributeName === 'aria-busy' && m.target.getAttribute('aria-busy') === 'true') {
      window.__busy.push({ cls: m.target.className, disabled: m.target.disabled, text: m.target.textContent });
    }
  })).observe(document.body, { attributes: true, subtree: true, attributeFilter: ['aria-busy'] });
  const tick = () => { if (document.querySelector('[aria-busy="true"].is-busy')) window.__busyFrames++; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
})()`;

test('spinner on the clicked control (aria-busy, disabled, painted) for a list, a preset, «החל» and every export', { skip, timeout: 120000 }, async () => {
  await withPage(async (page) => {
    await page.evaluate(WATCH);
    const busyOn = async (selector, cls, download) => {
      await page.evaluate(() => { window.__busy = []; window.__busyFrames = 0; });
      const dl = download ? page.waitForEvent('download') : null;
      await page.click(selector);
      if (dl) await dl;
      await page.waitForFunction(() => !document.querySelector('#patient-retention [aria-busy="true"]'));
      const rec = await page.evaluate(() => ({ busy: window.__busy, frames: window.__busyFrames }));
      assert.ok(rec.busy.some((b) => b.cls.includes(cls) && b.cls.includes('is-busy') && b.disabled), `${selector}: aria-busy + disabled on the clicked control`);
      assert.ok(rec.frames >= 1, `${selector}: the spinner painted`);
    };
    await busyOn(`${P}.pr-stat[data-sel*='"over60"']`, 'pr-stat');
    await busyOn(`${P}.pr-preset[data-preset="this_month"]`, 'pr-preset');
    await busyOn(`${P}.pr-preset[data-preset="last_3_months"]`, 'pr-preset');
    await page.fill(P + '.pr-threshold', '15');
    await busyOn(P + '.pr-apply', 'pr-apply');
    assert.ok((await page.$eval('#patient-retention', (e) => e.textContent)).includes('לתקופה מסוימת — 15 ימים'));
    await page.fill(P + '.pr-comp-threshold', '45');
    await busyOn(P + '.pr-comp-apply', 'pr-comp-apply');
    assert.equal(await page.$$eval(P + '.pr-comp-card', (c) => c.length), 3);
    await busyOn(P + '.pr-xlsx-all', 'pr-xlsx-all', true);
    for (const s of ['retention', 'continuity', 'completion']) await busyOn(`${P}.pr-xlsx[data-section="${s}"]`, 'pr-xlsx', true);
    await busyOn(P + '.pr-sum-csv', 'pr-sum-csv', true);
    await busyOn(P + '.pr-comp-csv', 'pr-comp-csv', true);
    await page.click(`${P}.pr-stat[data-sel*='"upTo30"']`);
    await page.waitForSelector(P + '.pr-list');
    await busyOn(P + '.pr-list .pr-csv', 'pr-csv', true);
    await busyOn(P + '.pr-list .pr-xlsx-list', 'pr-xlsx-list', true);
  });
});

test('a double click on an export downloads ONE file', { skip, timeout: 120000 }, async () => {
  await withPage(async (page) => {
    let n = 0;
    page.on('download', () => { n++; });
    await page.dblclick(P + '.pr-xlsx-all');
    await page.waitForTimeout(800);
    assert.equal(n, 1);
    await page.dblclick(P + '.pr-sum-csv');
    await page.waitForTimeout(800);
    assert.equal(n, 2);
  });
});

test('a failed action shows a Hebrew error toast with «נסו שוב»; retry runs it again', { skip, timeout: 120000 }, async () => {
  await withPage(async (page) => {
    // Excel export fails once
    await page.evaluate(() => {
      window.__realX = window.ReportXlsx;
      window.ReportXlsx = Object.assign({}, window.__realX, { writeXlsx: () => { throw new Error('boom'); } });
    });
    await page.click(`${P}.pr-xlsx[data-section="retention"]`);
    await page.waitForSelector('#retry-toast:not(.hidden)');
    assert.equal(await page.$eval('#retry-toast .retry-toast-msg', (e) => e.textContent), 'הייצוא לאקסל נכשל');
    assert.equal(await page.$eval('#retry-toast', (e) => e.getAttribute('role')), 'alert');
    // the button is usable again (not left busy)
    assert.equal(await page.$eval(`${P}.pr-xlsx[data-section="retention"]`, (b) => [b.disabled, b.getAttribute('aria-busy')].join()), 'false,');
    await page.evaluate(() => { window.ReportXlsx = window.__realX; });
    const dl = page.waitForEvent('download');
    await page.click('#retry-toast .retry-toast-retry');
    assert.match((await dl).suggestedFilename(), /^ezone-retention-/);
    assert.ok(await page.$eval('#retry-toast', (e) => e.classList.contains('hidden')));
    // opening a list fails once
    await page.evaluate(() => {
      window.__realR = window.PatientRetention;
      window.PatientRetention = Object.assign({}, window.__realR, { listTitle: () => { throw new Error('boom'); } });
    });
    await page.click(`${P}.pr-stat[data-sel*='"d31to60"']`);
    await page.waitForSelector('#retry-toast:not(.hidden)');
    assert.equal(await page.$eval('#retry-toast .retry-toast-msg', (e) => e.textContent), 'פתיחת הרשימה נכשלה');
    // the card is handed back whole (number, percent, label), not as flat text
    assert.equal(await page.$eval(`${P}.pr-stat[data-sel*='"d31to60"']`, (b) => [b.disabled, b.querySelectorAll('.pr-stat-num, .pr-stat-pct, .pr-stat-label').length].join()), 'false,3');
    await page.evaluate(() => { window.PatientRetention = window.__realR; });
    await page.click('#retry-toast .retry-toast-retry');
    await page.waitForFunction(() => (document.querySelector('#patient-retention .pr-list-title') || {}).textContent === 'שוחררו · 31–60 יום (1)');
  });
});

/* ---------- 5. touch targets ---------- */

test('360px: every panel control and the toast buttons are ≥ 44px; no sideways page scroll', { skip, timeout: 120000 }, async () => {
  await withPage(async (page) => {
    await page.click(`${P}.pr-stat[data-sel*='"upTo30"']`);
    await page.waitForSelector(P + '.pr-list');
    await page.evaluate(() => document.getElementById('retry-toast').classList.remove('hidden'));
    const small = await page.evaluate(() => [...document.querySelectorAll('#patient-retention button, #patient-retention input, #patient-retention select, #retry-toast button')]
      .map((b) => ({ c: b.className, r: b.getBoundingClientRect() }))
      .filter((x) => x.r.width > 0 && (x.r.height < 43.5 || x.r.width < 43.5))
      .map((x) => `${x.c} ${x.r.width}x${x.r.height}`));
    assert.deepEqual(small, []);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 0, 'no horizontal page scroll, got ' + overflow + 'px');
  }, { viewport: { width: 360, height: 740 }, hasTouch: true, isMobile: true });
});

test('touch: tapping a card right after typing a threshold opens the list', { skip, timeout: 120000 }, async () => {
  await withPage(async (page) => {
    await typeThreshold(page);
    await page.tap(`${P}.pr-stat[data-sel*='"d31to60"']`);
    await page.waitForFunction(() => (document.querySelector('#patient-retention .pr-list-title') || {}).textContent === 'שוחררו · 31–60 יום (1)', null, { timeout: 4000 });
  }, { viewport: { width: 360, height: 740 }, hasTouch: true, isMobile: true });
});
