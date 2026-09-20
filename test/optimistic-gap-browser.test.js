/* Real-browser proof for the optimistic-trigger gap.
 *
 * THE CLAIM THIS FILE SETTLES. Four writes re-render BEFORE they await —
 * moveLead (both stage buttons), deletePatient, saveBillingOverride and
 * clearBillingOverride. busyButton sets its class synchronously but runs `fn`
 * on a microtask, so class-set → worker entered → trigger detached all happen
 * inside ONE task, with no paint in between. A busy state on those triggers
 * therefore never reaches a frame, however correct it looks in the source.
 * "Does it paint?" is not answerable by reading code, so this answers it by
 * measurement.
 *
 * METHOD. Boot the REAL app (public/index.html + app.js) in Chromium against a
 * stubbed API, park the mutation request so the in-flight window stays open for
 * as long as we like, then sample every animation frame. A rAF callback runs
 * immediately before the browser paints that frame, so "was a busy indicator
 * connected and non-zero-sized at any rAF between the click and the response"
 * is exactly "did any painted frame show one".
 *
 * The POSITIVE CONTROL is what makes a zero meaningful. «סגירת ליד» opens a
 * modal whose אישור lives in #modal-root, which no list re-render touches; it
 * must read VISIBLE. If it ever reads NEVER, the harness is broken and every
 * other verdict in this file is worthless — so it is asserted, not just
 * reported.
 *
 * Measured before the fix: all five triggers painted 0 of ~90 frames while the
 * control painted 43/43. After: all five paint ~88/90, and what they paint is
 * #loading-banner — an element outside every re-rendered region, which is the
 * whole point.
 *
 * SKIPPED unless BOTH `playwright` resolves AND a Chromium binary is present,
 * exactly like test/spinner-glyph-browser.test.js — the repo has one
 * dependency and CI must not grow a browser download. test/optimistic-gap.test.js
 * is the fast guard that always runs. To run this one:
 *
 *     PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --no-save playwright
 *     node --test test/optimistic-gap-browser.test.js
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

const CHROMIUM_CANDIDATES = [process.env.EZONE_CHROMIUM, '/opt/pw-browsers/chromium'].filter(Boolean);
const chromiumPath = CHROMIUM_CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch (_) { return false; } });

const skip = !playwright
  ? 'playwright is not installed (see the header of this file)'
  : (!chromiumPath ? 'no Chromium binary found' : false);

const TYPES = {
  '.css': 'text/css', '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml',
};

function serve() {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    const f = path.join(PUBLIC, u.pathname === '/' ? '/index.html' : u.pathname);
    if (!f.startsWith(PUBLIC) || !fs.existsSync(f) || !fs.statSync(f).isFile()) {
      res.writeHead(404); res.end(); return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' });
    res.end(fs.readFileSync(f));
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

/* ---------- fixture ---------- */
const TODAY = new Date();
const isoOf = (d) => d.toISOString().slice(0, 10);
const MONTH_1ST = isoOf(new Date(TODAY.getFullYear(), TODAY.getMonth(), 1));
/* patientsDueOn matches on DAY-OF-MONTH, so the billing date must land on the
 * fixture patient's entry day for a due row (and its editor) to exist. */
const PATIENT_ENTRY = '2026-01-05';
const BILLING_DATE = MONTH_1ST.slice(0, 8) + '05';

const PATIENT = {
  id: 'P1', name: 'בדיקה מטופל', date: PATIENT_ENTRY, pay: 30000, adv: 0,
  status: 'active', phone: '0500000002',
};

const GET_DATA = {
  ok: true,
  leads: [{
    id: 'L1', name: 'בדיקה ליד', phone: '0500000001', house: 'רמות',
    stage: 'visit', visitDate: MONTH_1ST, visitTime: '10:00', source: 'בדיקה',
  }],
  patients: { ramot: [PATIENT], arfoni: [], rehab: [], asher: [], pardes: [], sde: [] },
  irrelevantLeads: [], removedLeads: [], dischargedPatients: [],
  /* An override already on the sheet, so the ↩ clear button renders too. */
  billingOverrides: [{
    id: 'ov1', patientId: `ramot::${PATIENT.name}::${PATIENT_ENTRY}`,
    month: MONTH_1ST.slice(0, 7), amount: 28000, created: MONTH_1ST,
  }],
  houseManagers: {}, managerPhones: {},
};

/* Installed before each click. Records, per animation frame, whether any busy
 * indicator is connected AND has a non-zero, non-transparent box — i.e.
 * whether this frame will paint one. */
const SAMPLER = () => {
  window.__probe = { frames: 0, busyFrames: 0, seen: [], running: true };
  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
  };
  const tick = () => {
    if (!window.__probe.running) return;
    window.__probe.frames++;
    const cands = Array.from(document.querySelectorAll('.is-busy,[aria-busy="true"]'));
    const banner = document.getElementById('loading-banner');
    if (banner && !banner.classList.contains('hidden')) cands.push(banner);
    const shown = cands.filter(visible);
    if (shown.length) {
      window.__probe.busyFrames++;
      shown.forEach((el) => {
        const id = (el.id ? '#' + el.id : '.' + String(el.className || '').trim().split(/\s+/).join('.'));
        const d = id + ' :: ' + String(el.textContent || '').trim().slice(0, 24);
        if (!window.__probe.seen.includes(d)) window.__probe.seen.push(d);
      });
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};

test('the four optimistic triggers paint a busy indicator in a real browser',
  { skip, timeout: 240000 }, async (t) => {
    const server = await serve();
    const origin = `http://127.0.0.1:${server.address().port}`;
    const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
    let parked = null;                       // { promise } while a write is held

    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

      await page.route('**/api/**', async (route) => {
        const url = route.request().url();
        const json = (b) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
        if (url.includes('/api/me')) return json({ ok: true, user: 'בודק' });
        if (url.includes('/api/verify-pin')) return json({ ok: true });
        if (url.includes('action=getData')) return json(GET_DATA);
        if (url.includes('action=getPayments')) return json({ ok: true, payments: [] });
        if (url.includes('action=getCredits')) return json({ ok: true, credits: [] });
        if (route.request().method() === 'POST') {
          // THE MUTATION. Parked, so the in-flight window never depends on
          // timing luck — it stays open until this test releases it.
          if (parked) { await parked.promise; parked = null; }
          return json({ ok: true });
        }
        return json({ ok: true });
      });

      const boot = async () => {
        await page.goto(origin + '/', { waitUntil: 'networkidle' });
        await page.waitForSelector('.lead-card', { timeout: 20000, state: 'attached' });
      };
      const toTab = async (screen) => {
        await page.click(`.tabs .tab[data-screen="${screen}"]`);
        await page.waitForTimeout(250);
      };
      const setBillingDate = async () => {
        await page.evaluate((d) => {
          const el = document.getElementById('billing-date');
          el.value = d;
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }, BILLING_DATE);
        await page.waitForTimeout(250);
      };

      /* Click `selector`, hold the write open, and report what painted. */
      async function measure(prepare, selector) {
        await boot();
        if (prepare) await prepare();
        await page.waitForSelector(selector, { timeout: 15000, state: 'attached' });

        let release;
        parked = { promise: new Promise((r) => { release = r; }) };
        await page.evaluate(SAMPLER);
        await page.click(selector, { force: true });
        await page.waitForTimeout(900);      // many frames, write still parked

        const s = await page.evaluate(() => {
          const p = window.__probe; p.running = false;
          return { frames: p.frames, busyFrames: p.busyFrames, seen: p.seen };
        });
        release();
        await page.waitForTimeout(400);
        return s;
      }

      /* ---- the positive control, FIRST: it validates everything below ---- */
      const control = await measure(async () => {
        await toTab('leads');
        await page.click('.lead-card .lc-irrelevant:not(.lc-remove)');
        await page.waitForSelector('.modal input[name="disposition"]', { timeout: 15000 });
        await page.click('.modal input[name="disposition"]');
        await page.waitForTimeout(150);
      }, '.modal button[type="submit"]');

      t.diagnostic(`CONTROL close-lead modal אישור: ${control.busyFrames}/${control.frames} frames — ${control.seen.join(' | ') || '(none)'}`);
      assert.ok(control.frames > 10, `the rAF sampler only saw ${control.frames} frames — the harness is broken`);
      assert.ok(control.busyFrames > 0,
        'POSITIVE CONTROL FAILED: a modal button that no re-render touches did not paint a busy ' +
        'state, so this harness cannot detect one and every verdict below is meaningless');

      /* ---- the four workers behind the five triggers ---- */
      const CASES = [
        ['«← שלב הבא» → moveLead', async () => { await toTab('leads'); }, '.lead-card [data-action="next"]'],
        ['«שלב קודם →» → moveLead', async () => { await toTab('leads'); }, '.lead-card [data-action="back"]'],
        ['מחק לצמיתות ✕ → deletePatient', async () => {
          await toTab('occupancy');
          for (const tb of await page.$$('#house-tabs .h-tab')) {
            const txt = await tb.textContent();
            if (txt && txt.indexOf('(1/') !== -1) { await tb.click(); break; }
          }
          page.once('dialog', (d) => d.accept());   // the native confirm #132 kept
          await page.waitForTimeout(250);
        }, '.patient-row [data-action="delete"]'],
        ['billing שמור → saveBillingOverride', async () => {
          await toTab('billing');
          await setBillingDate();
          await page.waitForSelector('.bill-amount-edit-btn', { timeout: 15000, state: 'attached' });
          await page.click('.bill-amount-edit-btn');
          await page.waitForTimeout(150);
        }, '.bill-amount-save'],
        ['billing ↩ → clearBillingOverride', async () => {
          await toTab('billing');
          await setBillingDate();
        }, '.bill-amount-clear-btn'],
      ];

      for (const [label, prepare, selector] of CASES) {
        const s = await measure(prepare, selector);
        t.diagnostic(`${label}: ${s.busyFrames}/${s.frames} frames — ${s.seen.join(' | ') || '(none)'}`);

        assert.ok(s.frames > 10, `${label}: only ${s.frames} frames sampled — harness problem, not a verdict`);
        assert.ok(s.busyFrames > 0,
          `${label}: the busy state painted in 0 of ${s.frames} frames — this is the gap, ` +
          'the feedback must survive the synchronous re-render');

        /* THE POINT, not just "something was visible": what painted has to be
         * an element OUTSIDE the re-rendered region. If the only indicator were
         * the trigger itself we would be back to a spinner on a detached node. */
        assert.ok(s.seen.some((d) => d.startsWith('#loading-banner')),
          `${label}: the indicator that painted was ${JSON.stringify(s.seen)} — it must be ` +
          '#loading-banner, which no list re-render can detach');
        assert.ok(s.seen.some((d) => d.includes('שומר נתונים')),
          `${label}: the banner must say it is SAVING, not loading; saw ${JSON.stringify(s.seen)}`);
      }
    } finally {
      await browser.close();
      server.close();
    }
  });
