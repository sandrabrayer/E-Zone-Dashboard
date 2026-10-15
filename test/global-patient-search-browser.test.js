/* Real-browser cross-check for the global search («🔍 חיפוש»).
 *
 * test/global-patient-search.test.js proves the RULES in a vm sandbox and is
 * the guard that runs in CI. This file proves the half only a browser can:
 * the button opens the panel under the top bar, typing lists records, a pick
 * opens the right tab with that tab's own filter filled and the record on
 * screen, "/" and Escape work, and nothing is written. Runs at desktop AND
 * 360px (the wrapped phone top bar).
 *
 * SKIPPED unless BOTH `playwright` resolves AND a Chromium binary is present,
 * so it is inert in CI — same contract as the other browser suites:
 *
 *     PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --no-save playwright
 *     node --test test/global-patient-search-browser.test.js
 *
 * Point EZONE_CHROMIUM at a binary to override discovery.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const PUBLIC = path.join(__dirname, '..', 'public');

let playwright = null;
try { playwright = require('playwright'); } catch (_) { /* not installed — skip */ }
if (!playwright) {
  try {
    const groot = require('node:child_process').execSync('npm root -g').toString().trim();
    playwright = require(path.join(groot, 'playwright'));
  } catch (_) { /* still unavailable — skip */ }
}

const CHROMIUM_CANDIDATES = [process.env.EZONE_CHROMIUM, '/opt/pw-browsers/chromium'].filter(Boolean);
const chromiumPath = CHROMIUM_CANDIDATES.find((p) => {
  try { return fs.existsSync(p); } catch (_) { return false; }
});
const skip = !playwright
  ? 'playwright is not installed (see the header of this file)'
  : (!chromiumPath ? 'no Chromium binary found' : false);

const TYPES = {
  '.css': 'text/css',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
};

/* Serve public/ over http and RECORD every /api/ POST: a search must send none. */
function serve(state) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    if (u.pathname.startsWith('/api/')) {
      let body = '';
      req.on('data', (c) => { body += c; });
      return req.on('end', () => {
        if (req.method === 'POST') state.posts.push(body);
        res.writeHead(200, { 'Content-Type': TYPES['.json'] });
        res.end(JSON.stringify({ ok: true, user: 'ורד', patients: [], leads: [], payments: [] }));
      });
    }
    const rel = u.pathname === '/' ? 'index.html' : u.pathname.replace(/^\//, '');
    const file = path.join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file)) { res.writeHead(404); return res.end('nf'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, () => resolve({ server, port: server.address().port })));
}

/* Two Cohens in different houses, a lead with a referrer phone, a closed
 * lead, and a discharged row — the four kinds the search spans. The hostile
 * name proves sheet data is shown as text. */
const SEED = `
  state.patients = [
    normalizePatient({ id: 'id-david', houseId: 'ramot', name: 'דוד כהן', date: '2026-09-07', pay: 30000, status: 'active', exitDate: '', fromLead: 'lead-david' }),
    normalizePatient({ id: 'id-moshe', houseId: 'asher', name: 'משה כהן', date: '2026-08-01', pay: 30000, status: 'released', exitDate: '2026-10-01' }),
  ];
  state.leads = [
    normalizeLead({ id: 'lead-david', name: 'דוד כהן', phone: '050-2001003', house: 'ramot', stage: 'paid' }),
    normalizeLead({ id: 'lead-rina', name: '<img src=x onerror=window.__pwned=1>', phone: '0521112222', contactPhone: '054-3334444', house: 'pardes', stage: 'new' }),
  ];
  state.irrelevantLeads = [normalizeIrrelevantLead({ id: 'lead-closed', name: 'רותי לוי', phone: '0507778888', house: 'asher', stage: 'irrelevant', not_relevant_reason: 'never_relevant' })];
  state.dischargedPatients = [normalizeDischargedPatient({ id: 'dis-gil', houseId: 'ramot', name: 'גיל אברהם', phone: '052-7776666', exitDate: '2026-09-20', disposition: 'completed' })];
  state.payments = []; state.credits = []; state.billingOverrides = [];
  state.mode = 'edit';
  const appEl = document.getElementById('app');
  if (appEl) appEl.classList.remove('hidden');
  if (!document.getElementById('global-search-open').onclick) { initTabs(); initGlobalSearch(); }
  showScreen('dashboard');
  renderAll();
`;

async function withPage(viewport, fn) {
  const state = { posts: [] };
  const { server, port } = await serve(state);
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  try {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'networkidle' });
    await page.evaluate(SEED);
    const before = state.posts.length;
    await fn({ page, state });
    assert.strictEqual(state.posts.length, before, 'searching sends no write');
    assert.deepStrictEqual(errors, [], 'no page errors');
    assert.strictEqual(await page.evaluate('window.__pwned'), undefined, 'a hostile name never executes');
  } finally {
    await browser.close();
    server.close();
  }
}

const VIEWPORTS = [['desktop', { width: 1280, height: 800 }], ['360px phone', { width: 360, height: 740 }]];

for (const [label, viewport] of VIEWPORTS) {
  test(`${label}: button opens the panel under the top bar; a patient pick opens מטופלים on that record`,
    { skip }, async () => {
      await withPage(viewport, async ({ page }) => {
        await page.click('#global-search-open');
        assert.ok(await page.isVisible('#global-search-panel'));
        const bar = await page.$eval('.topbar', (el) => el.getBoundingClientRect().bottom);
        const top = await page.$eval('#global-search-panel', (el) => el.getBoundingClientRect().top);
        assert.ok(top >= bar, `panel (${top}) must not cover the top bar (${bar})`);
        assert.strictEqual(await page.evaluate('document.activeElement.id'), 'global-search-input');

        await page.fill('#global-search-input', 'כהן');
        await page.waitForSelector('.gs-item');
        await page.waitForTimeout(250);
        const rows = await page.$$eval('.gs-item', (els) => els.map((e) => e.querySelector('.gs-name').textContent));
        assert.deepStrictEqual(rows, ['דוד כהן', 'משה כהן'], 'active first, then the released one');
        const tags = await page.$$eval('.gs-item .gs-tag', (els) => els.map((e) => e.textContent));
        assert.match(tags[0], /מטופל · פעיל/);
        assert.match(tags[1], /מטופל · שוחרר/);
        assert.match(await page.$eval('.gs-item .gs-phone', (e) => e.textContent), /050-2001003/,
          'the patient shows its linked lead phone');

        await page.click('.gs-item:nth-child(2)'); // the RELEASED Cohen: status filter must widen
        await page.waitForSelector('#screen-patients:not(.hidden)');
        assert.ok(await page.isHidden('#global-search-panel'), 'the panel closes on a pick');
        assert.strictEqual(await page.inputValue('#plist-search'), 'משה כהן');
        assert.strictEqual(await page.inputValue('#plist-status'), 'all');
        const listed = await page.$$eval('#plist-list .plist-row', (els) => els.map((e) => e.dataset.id));
        assert.deepStrictEqual(listed, ['id-moshe'], 'only the picked person is listed');
        assert.ok(await page.$('#plist-list .plist-row.gs-hit'), 'the record is outlined');
      });
    });

  test(`${label}: phone search in any format; lead, referrer phone, closed lead and discharged row open their own tabs`,
    { skip }, async () => {
      await withPage(viewport, async ({ page }) => {
        const open = async (q) => {
          await page.click('#global-search-open');
          await page.fill('#global-search-input', q);
          // Results are debounced (120 ms): wait for THIS query's, not the last one's.
          await page.waitForFunction((x) => document.getElementById('global-search-input').value === x
            && !!document.querySelector('.gs-item'), q);
          await page.waitForTimeout(250);
        };
        // Referrer phone → the lead; the hostile name is text, not an element.
        await open('+972 54 333');
        assert.strictEqual(await page.$$eval('.gs-item', (e) => e.length), 1);
        assert.strictEqual(await page.$eval('.gs-item .gs-name', (e) => e.textContent),
          '<img src=x onerror=window.__pwned=1>');
        assert.strictEqual(await page.$('.gs-item img'), null);
        await page.click('.gs-item');
        await page.waitForSelector('#screen-leads:not(.hidden)');
        assert.strictEqual(await page.inputValue('#lead-search'), '<img src=x onerror=window.__pwned=1>');

        await open('0507778888');
        assert.match(await page.$eval('.gs-item .gs-tag', (e) => e.textContent), /שימור לידים/);
        await page.click('.gs-item');
        await page.waitForSelector('#screen-retention:not(.hidden)');
        assert.strictEqual(await page.inputValue('#retention-search'), 'רותי לוי');

        await open('527776');
        await page.click('.gs-item');
        await page.waitForSelector('#screen-discharged-patients:not(.hidden)');
        assert.strictEqual(await page.inputValue('#discharged-search'), 'גיל אברהם');
      });
    });

  test(`${label}: keyboard — "/" opens, arrows + Enter pick, Escape closes; short digits give a hint`,
    { skip }, async () => {
      await withPage(viewport, async ({ page }) => {
        await page.keyboard.press('/');
        assert.ok(await page.isVisible('#global-search-panel'), '"/" opens it');
        assert.strictEqual(await page.evaluate('document.activeElement.id'), 'global-search-input');
        await page.keyboard.type('05');
        await page.waitForFunction(() => /3 ספרות/.test((document.querySelector('.gs-note') || {}).textContent || ''));
        assert.match(await page.$eval('.gs-note', (e) => e.textContent), /3 ספרות/);

        await page.fill('#global-search-input', 'כהן');
        await page.waitForFunction(() => document.querySelectorAll('.gs-item').length === 2);
        await page.keyboard.press('ArrowDown');
        assert.ok(await page.$('.gs-item:nth-child(2).active'), 'ArrowDown moves the highlight');
        await page.keyboard.press('Enter');
        await page.waitForSelector('#screen-patients:not(.hidden)');
        assert.strictEqual(await page.inputValue('#plist-search'), 'משה כהן');

        await page.keyboard.press('/');
        assert.ok(await page.isVisible('#global-search-panel'));
        await page.keyboard.press('Escape');
        assert.ok(await page.isHidden('#global-search-panel'), 'Escape closes');

        // "/" typed inside a text field is just a character.
        await page.click('#plist-search');
        await page.keyboard.type('/');
        assert.ok(await page.isHidden('#global-search-panel'));
      });
    });
}
