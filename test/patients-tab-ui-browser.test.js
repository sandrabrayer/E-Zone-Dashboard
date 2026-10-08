/* Real-browser check for the «מטופלים» tab at 360px.
 * CHANGELOG-patients-tab-ui.md.
 *
 * test/patients-tab-ui.test.js proves the markup in a vm sandbox. This file
 * proves what only a browser can: the real index.html, app.js and style.css
 * in Chromium at phone width — the tab after «לידים», the badge, the
 * «ממתינים לקליטה» row, the problem chips inside the row, the «פרטי הליד»
 * section opening with a hostile note shown as text, no sideways scroll,
 * the restricted view without any money cell, and «קלוט כמטופל» opening the
 * existing «כניסה לבית» modal. Rendering sends nothing.
 *
 * SKIPPED unless BOTH `playwright` resolves AND a Chromium binary is present
 * (same contract as the other browser suites). All data is SYNTHETIC. */

const { test } = require('node:test');
const assert = require('node:assert');
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

function serve(posts) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    if (u.pathname.startsWith('/api/')) {
      let body = '';
      req.on('data', (c) => { body += c; });
      return req.on('end', () => {
        if (req.method === 'POST') { try { posts.push(JSON.parse(body)); } catch (_) { posts.push(body); } }
        res.writeHead(200, { 'Content-Type': TYPES['.json'] });
        res.end(JSON.stringify({ ok: true, user: 'ורד', patients: [], leads: [], payments: [] }));
      });
    }
    const rel = u.pathname === '/' ? 'index.html' : u.pathname.replace(/^\//, '');
    // The shared rules module is served from lib/ (as server.js does).
    const file = rel === 'payment-report-rules.js' ? path.join(LIB, rel) : path.join(PUBLIC, rel);
    if (!(file.startsWith(PUBLIC) || file.startsWith(LIB)) || !fs.existsSync(file)) { res.writeHead(404); return res.end('nf'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, () => resolve({ server, port: server.address().port })));
}

const EVIL = '<img src=x onerror="window.__pwned=1">';
const LONG_NOTE = EVIL + ' ' + 'הערה ארוכה מאוד בלי רווחים'.repeat(8);

const SEED = (finance) => `
  (() => {
    const today = debtAgingTodayIso();
    const ago = (n) => { const d = new Date(today + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
    state.mode = 'edit';
    state.finance = ${finance};
    state.view = ${finance} ? 'full' : 'restricted';
    document.body.classList.remove('viewer-mode');
    state.leads = [
      normalizeLead({ id: 'L-A', name: 'אבי אלף', phone: '0501112233', house: 'רעננה אשר', stage: 'admitted', source: 'גוגל',
        note: ${JSON.stringify(LONG_NOTE)}, visitDate: ago(40), advance: 5000, assignedTo: 'ורד', meetingWith: 'מנהל' }),
      normalizeLead({ id: 'L-W', name: 'ממתינה לקליטה', phone: '0509998877', house: 'רמות השבים', stage: 'paid', entryDate: ago(4), advance: 2000, source: 'חבר' }),
    ];
    state.irrelevantLeads = []; state.removedLeads = [];
    state.patients = [
      normalizePatient({ id: 'P-A', houseId: 'ramot', name: 'אבי אלף', date: ago(30), pay: 30000, status: 'active', fromLead: 'L-A' }),
      normalizePatient({ id: 'P-B', houseId: 'asher', name: ${JSON.stringify(EVIL + 'בני')}, date: ago(10), pay: 30000, status: 'active', fromLead: '' }),
    ];
    state.payments = [];
    state.funders = [];
    state.dischargedPatients = [];
    state.ptFilters = null;
    document.getElementById('app').classList.remove('hidden');
    showScreen('patients');
    renderPatientsTab();
  })();
`;

test('«מטופלים» at 360px: tab after לידים, badge, pending row, chips inside rows, «פרטי הליד» escaped, no sideways scroll; restricted has no money cell; «קלוט כמטופל» opens «כניסה לבית»',
  { skip, timeout: 120000 }, async () => {
    const posts = [];
    const { server, port } = await serve(posts);
    const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
    try {
      const ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, deviceScaleFactor: 2, locale: 'he-IL', serviceWorkers: 'block' });
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'networkidle' });
      const postsBefore = posts.length;
      await page.evaluate(SEED(true));
      await page.waitForSelector('#plist-list .plist-row', { state: 'visible' });

      const tabs = await page.$$eval('.tabs .tab', (bs) => bs.map((b) => b.dataset.screen));
      assert.strictEqual(tabs[tabs.indexOf('leads') + 1], 'patients');

      const badge = await page.$eval('#patients-problems-badge', (el) => ({ text: el.textContent, hidden: el.classList.contains('hidden'), bg: getComputedStyle(el).backgroundColor }));
      assert.deepStrictEqual(badge, { text: '2', hidden: false, bg: 'rgb(255, 77, 94)' });

      // «ממתינים לקליטה»: the paid lead, 4 days → the #192 chip.
      assert.strictEqual(await page.$eval('#plist-pending .plist-section-title', (el) => el.textContent), 'ממתינים לקליטה (1)');
      assert.strictEqual(await page.$eval('#plist-pending .plist-chip', (el) => el.textContent), 'לא נקלט כמטופל · 4 ימים');

      // Finance view: the funder + payment cells are there.
      assert.strictEqual(await page.$$eval('#plist-list .plist-pay', (els) => els.length), 2);
      assert.strictEqual(await page.$$eval('#plist-list .plist-funder', (els) => els.length), 2);

      // Chips: red, inside their row.
      const rowB = '#plist-list .plist-row[data-id="P-B"]';
      const chips = await page.$$eval(`${rowB} .plist-chip`, (els) => els.map((e) => e.textContent));
      assert.deepStrictEqual(chips, ['ללא גורם מממן', 'לא דווח תשלום', 'ללא ליד']);
      const inside = await page.$$eval('#plist-list .plist-row', (rows) => rows.every((row) => {
        const r = row.getBoundingClientRect();
        return [...row.querySelectorAll('.plist-chip, .btn, .p-val')].every((c) => {
          const k = c.getBoundingClientRect();
          return k.width === 0 || (k.left >= r.left - 0.5 && k.right <= r.right + 0.5);
        });
      }));
      assert.ok(inside, 'every chip, button and value stays inside its row');
      assert.ok(await page.$eval('#plist-list .plist-row[data-id="P-A"] .plist-chip', (el) => getComputedStyle(el).color === 'rgb(255, 77, 94)'));

      // «פרטי הליד»: closed by default; open → the hostile note is text.
      const rowA = '#plist-list .plist-row[data-id="P-A"]';
      assert.strictEqual(await page.$eval(`${rowA} details.plist-lead`, (d) => d.open), false);
      await page.click(`${rowA} details.plist-lead summary`);
      assert.strictEqual(await page.$eval(`${rowA} details.plist-lead`, (d) => d.open), true);
      assert.strictEqual(await page.$eval(`${rowA} .plist-lead-note .p-val`, (el) => el.textContent), LONG_NOTE);
      assert.ok((await page.$eval(`${rowA} .plist-lead`, (el) => el.textContent)).includes('0501112233'));
      // the house on the lead (asher) ≠ the patient's (ramot)
      assert.ok((await page.$$eval(`${rowA} .plist-chip`, (els) => els.map((e) => e.textContent))).includes('בית שונה מהליד'));
      assert.strictEqual(await page.$$eval('#screen-patients img', (els) => els.length), 0);
      assert.strictEqual(await page.evaluate(() => window.__pwned), undefined);
      assert.ok((await page.$eval(`${rowB} .p-name`, (el) => el.textContent)).startsWith('<img'));

      let overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 0, 'no horizontal page scroll (lead details open), got ' + overflow + 'px');

      // Filters: «בעיות בלבד» + the house select.
      await page.check('#plist-problems');
      assert.strictEqual(await page.$$eval('#plist-list .plist-row', (els) => els.length), 2);
      await page.selectOption('#plist-house', 'asher');
      assert.deepStrictEqual(await page.$$eval('#plist-list .plist-row', (els) => els.map((e) => e.dataset.id)), ['P-B']);
      assert.strictEqual(await page.$$eval('#plist-pending .plist-row', (els) => els.length), 0, 'the pending lead is in ramot');
      await page.selectOption('#plist-status', 'released');
      assert.strictEqual(await page.$eval('#plist-list', (el) => el.textContent.trim()), 'אין מטופלים להצגה');

      assert.strictEqual(posts.length, postsBefore, 'rendering and filtering sent nothing');

      // Restricted (Shiran / Yael): same tab, no money cell, no finance chip.
      await page.evaluate(SEED(false));
      await page.waitForSelector('#plist-list .plist-row', { state: 'visible' });
      assert.strictEqual(await page.$$eval('#screen-patients .plist-pay, #screen-patients .plist-funder, #screen-patients .plist-report-btn, #screen-patients .plist-funder-btn', (els) => els.length), 0);
      assert.deepStrictEqual(await page.$$eval(`${rowB} .plist-chip`, (els) => els.map((e) => e.textContent)), ['ללא ליד']);
      assert.strictEqual(await page.$eval('#patients-problems-badge', (el) => el.textContent), '2', 'P-A house mismatch + P-B no lead');
      overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 0, 'restricted: no horizontal scroll, got ' + overflow + 'px');

      // «קלוט כמטופל» opens the EXISTING «כניסה לבית» modal (nothing sent until confirmed).
      await page.click('#plist-pending .plist-admit-btn');
      await page.waitForSelector('#modal-root .modal', { state: 'visible' });
      assert.ok((await page.$eval('#modal-root .modal', (el) => el.textContent)).includes('כניסה לבית — ממתינה לקליטה'));
      assert.strictEqual(posts.length, postsBefore, 'opening the modal sent nothing');

      assert.deepStrictEqual(errors, [], 'no page errors');
      await ctx.close();
    } finally {
      await browser.close();
      server.close();
    }
  });
