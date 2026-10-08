/* Real-browser check for «לא נקלט כמטופל · N ימים» at 360px.
 *
 * test/unadmitted-lead-warning.test.js proves the RULE in a vm sandbox and is
 * the guard that runs in CI. This file proves what only a browser can: load
 * the real index.html, app.js and style.css in Chromium at phone width, seed
 * leads and patients, and look at the board. A chip that renders as markup, a
 * tab badge that counts the wrong leads, or a chip that pushes the card past
 * the screen edge fails here and nowhere else.
 *
 * SKIPPED unless BOTH `playwright` resolves AND a Chromium binary is present,
 * so it is inert in CI — same contract as the other browser suites:
 *
 *     PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --no-save playwright
 *     node --test test/unadmitted-lead-warning-browser.test.js
 *
 * Point EZONE_CHROMIUM at a binary to override discovery. All names and
 * phone numbers are SYNTHETIC.
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

/* Serve public/ over http and RECORD every /api/ POST: the warning is display
 * only, so rendering it must send nothing. */
function serve(posts) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    if (u.pathname.startsWith('/api/')) {
      let body = '';
      req.on('data', (c) => { body += c; });
      return req.on('end', () => {
        if (req.method === 'POST') {
          try { posts.push(JSON.parse(body)); } catch (_) { posts.push(body); }
        }
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

const EVIL = '<img src=x onerror="window.__pwned=1">דנה';

/* Dates are relative to today in Asia/Jerusalem, the same "today" the app uses. */
const SEED = `
  (() => {
    const today = debtAgingTodayIso();
    const ago = (n) => { const d = new Date(today + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
    const EVIL = ${JSON.stringify(EVIL)};
    state.mode = 'view';
    state.leadSearch = '';
    state.leads = [
      normalizeLead({ id: 'L-evil', name: EVIL, phone: '0501110001', house: 'רמות השבים', stage: 'paid', entryDate: ago(5) }),
      normalizeLead({ id: 'L-enter', name: 'יואב ענבר', phone: '0501110002', house: 'רעננה אשר', stage: 'visit',
        meetingOutcome: 'entered', entryDate: ago(3) }),
      normalizeLead({ id: 'L-day2', name: 'מיכל אור', phone: '0501110003', house: 'רעננה אשר', stage: 'paid', entryDate: ago(2) }),
      normalizeLead({ id: 'L-matched', name: 'רון שגיא', phone: '0501110004', house: 'שדה אליעזר', stage: 'paid', entryDate: ago(10) }),
      normalizeLead({ id: 'L-nodate', name: 'טל ים', phone: '0501110005', house: 'שדה אליעזר', stage: 'paid', entryDate: '' }),
      normalizeLead({ id: 'L-new', name: 'נוי בר', phone: '0501110006', house: 'שדה אליעזר', stage: 'new', entryDate: ago(9) }),
    ];
    state.irrelevantLeads = [];
    state.removedLeads = [];
    state.patients = [normalizePatient({ id: 'P-1', houseId: 'sde', name: 'רון שגיא', date: ago(10), fromLead: 'L-matched' })];
    state.payments = [];
    const app = document.getElementById('app');
    if (app) app.classList.remove('hidden');
    document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
    document.getElementById('screen-leads').classList.remove('hidden');
    renderKanban();
  })();
`;

test('at 360px: the chip on the flagged cards only, escaped, inside the card; the tab badge says 2; nothing sent',
  { skip }, async () => {
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
      await page.evaluate(SEED);
      await page.waitForSelector('#kanban .lead-card');

      // Exactly the two flagged leads carry the chip.
      const chips = await page.$$eval('.lead-card', (cards) => cards
        .filter((c) => c.querySelector('.lc-unadmitted'))
        .map((c) => ({ id: c.dataset.id, text: c.querySelector('.lc-unadmitted').textContent.trim() })));
      assert.deepStrictEqual(chips.sort((a, b) => a.id.localeCompare(b.id)), [
        { id: 'L-enter', text: 'לא נקלט כמטופל · 3 ימים' },
        { id: 'L-evil', text: 'לא נקלט כמטופל · 5 ימים' },
      ]);

      // The hostile name is text, never markup.
      assert.strictEqual(await page.$$eval('.lead-card img', (els) => els.length), 0);
      assert.strictEqual(await page.evaluate(() => window.__pwned), undefined);
      assert.strictEqual(await page.$eval('.lead-card[data-id="L-evil"] .lc-name', (el) => el.textContent), EVIL);

      // The tab badge: visible, 2, red.
      const badge = await page.$eval('#leads-unadmitted-badge', (el) => ({
        text: el.textContent, hidden: el.classList.contains('hidden'), display: getComputedStyle(el).display,
        bg: getComputedStyle(el).backgroundColor,
      }));
      assert.strictEqual(badge.text, '2');
      assert.strictEqual(badge.hidden, false);
      assert.notStrictEqual(badge.display, 'none');
      assert.strictEqual(badge.bg, 'rgb(255, 77, 94)', 'var(--danger)');

      // The chip is red and fits inside its card at 360px; the page never scrolls sideways.
      const box = await page.$eval('.lead-card[data-id="L-evil"]', (card) => {
        const chip = card.querySelector('.lc-unadmitted');
        const c = card.getBoundingClientRect(); const k = chip.getBoundingClientRect();
        return { color: getComputedStyle(chip).color, inside: k.left >= c.left - 0.5 && k.right <= c.right + 0.5,
          visible: k.width > 0 && k.height > 0 };
      });
      assert.strictEqual(box.color, 'rgb(255, 77, 94)');
      assert.ok(box.visible, 'the chip is laid out');
      assert.ok(box.inside, 'the chip stays inside the card');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 0, 'no horizontal page scroll, got ' + overflow + 'px');

      // Fix the record (a patient row for the lead) and re-render: chip and count follow.
      await page.evaluate(`
        state.patients.push(normalizePatient({ id: 'P-2', houseId: 'ramot', name: 'x', fromLead: 'L-evil' }));
        renderKanban();
      `);
      assert.strictEqual(await page.$eval('#leads-unadmitted-badge', (el) => el.textContent), '1');
      assert.strictEqual(await page.$$eval('.lead-card[data-id="L-evil"] .lc-unadmitted', (els) => els.length), 0);

      assert.strictEqual(posts.length, postsBefore, 'display only — rendering sent nothing');
      assert.deepStrictEqual(errors, [], 'no page errors');
      await ctx.close();
    } finally {
      await browser.close();
      server.close();
    }
  });
