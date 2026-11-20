'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { makeDesk, REF, PROXY } = require('./helpers/contact-fixture');
const { personalToken, personalCookie, userPinHashes, TEST_PEPPER } = require('./helpers/personal-session');

async function serveDesk(desk) {
  const secret = 'test-only-desktop-and-mobile-communications';
  const env = { PROXY_SECRET: PROXY, SESSION_SECRET: secret, SHEETS_URL: 'https://synthetic.invalid/exec', PIN_PEPPER: TEST_PEPPER,
    USER_PIN_HASHES: userPinHashes(['vered', 'dana', 'ortal']), CRM_ENABLED: 'true', SHEETS_READ_CACHE_MS: '0' };
  const old = {};
  for (const [k, v] of Object.entries(env)) { old[k] = process.env[k]; process.env[k] = v; }
  const location = require.resolve('../server'); delete require.cache[location];
  let app;
  try { app = require('../server').app; } finally {
    for (const k of Object.keys(env)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; }
  }
  const orig = https.request;
  https.request = (url, opts, cb) => {
    assert.equal(String(url), env.SHEETS_URL);
    const request = new EventEmitter(); let body = '';
    request.write = (c) => { body += c; };
    request.end = () => {
      const data = desk.g.post(JSON.parse(body));
      const response = new EventEmitter(); response.statusCode = 200; response.headers = {}; response.setEncoding = () => {};
      cb(response); response.emit('data', JSON.stringify(data)); response.emit('end');
    };
    return request;
  };
  const server = await new Promise((resolve) => { const srv = app.listen(0, '127.0.0.1', () => resolve(srv)); });
  return { base: 'http://127.0.0.1:' + server.address().port, secret, close: async () => {
    https.request = orig; delete require.cache[location]; server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  } };
}

test('Express refuses anonymous, controller and generic proxy access; dedicated personal review is uncached', async () => {
  const d = makeDesk(); d.addLead(); d.receive();
  const server = await serveDesk(d);
  try {
    const cookie = (id) => ({ Cookie: personalCookie(server.secret, id) });
    assert.equal((await fetch(server.base + '/api/communications/review')).status, 401);
    assert.equal((await fetch(server.base + '/api/communications/review', { headers: cookie('ortal') })).status, 403);
    for (const action of ['getCommunicationReview', 'resolveCommunicationEvent', 'ingestCommunicationEvent']) {
      assert.equal((await fetch(server.base + '/api/sheets?action=' + action, { headers: cookie('vered') })).status, 403);
      assert.equal((await fetch(server.base + '/api/sheets', { method: 'POST', body: JSON.stringify({ action }), headers: { ...cookie('vered'), 'Content-Type': 'application/json' } })).status, 403);
    }
    const ok = await fetch(server.base + '/api/communications/review', { headers: cookie('dana') });
    assert.match(ok.headers.get('cache-control'), /no-store/); assert.equal((await ok.json()).total, 1);
    const res = await fetch(server.base + '/api/communications/resolve', { method: 'POST', headers: { ...cookie('dana'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'phone-' + REF, leadId: 'test-card-a', verifiedContact: true, decision: 'link', proxyUserId: 'sandra', user: 'spoof' }) });
    assert.equal((await res.json()).ok, true); assert.equal(d.rows()[0].reviewer, 'dana');
  } finally { await server.close(); }
});

let pw;
try { pw = require('playwright'); } catch (_) {}
let executable = [process.env.CHROMIUM_PATH, pw && pw.chromium.executablePath(), '/usr/bin/chromium'].find((p) => p && fs.existsSync(p));

test('staff links a missed call on a 360px phone; a separate desktop session sees the single callback and private WhatsApp receipt', { skip: !pw || !executable }, async () => {
  const d = makeDesk(); d.addLead(); d.receive();
  const s = await serveDesk(d); let browser;
  try {
    browser = await pw.chromium.launch({ executablePath: executable, args: ['--no-sandbox'] });
    async function workstation(width, id) {
      const ctx = await browser.newContext({ viewport: { width, height: 850 }, isMobile: width < 600, hasTouch: width < 600, serviceWorkers: 'block' });
      await ctx.addCookies([{ name: 'ezone_session', value: personalToken(s.secret, id), url: s.base }]);
      const page = await ctx.newPage(); page.setDefaultTimeout(10000);
      await page.goto(s.base + '/?view=crm');
      const leads = page.locator('#crm-nav button[data-area="leads"]');
      const burger = page.locator('#crm-burger');
      if (width < 600 && await burger.isVisible()) await burger.click();
      await leads.click();
      return page;
    }
    const phone = await workstation(360, 'vered'), desktop = await workstation(1280, 'dana');
    await phone.locator('#crm-communication-review').click();
    const panel = phone.locator('.comm-review');
    await panel.getByRole('button', { name: 'בדיקה ושיוך' }).click();
    const choice = panel.locator('select[name=lead]');
    assert.equal(await choice.inputValue(), '');
    await panel.getByRole('button', { name: 'שמירת השיוך' }).click();
    assert.match(await panel.innerText(), /יש לבחור פנייה/);
    await choice.selectOption('test-card-a');
    await panel.locator('input[name=verified]').check(); await panel.locator('input[name=remember]').check();
    assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await panel.getByRole('button', { name: 'שמירת השיוך' }).click();
    await panel.getByText('אין כרגע שיחות או הודעות שממתינות לשיוך.').waitFor();
    assert.equal(d.tasks().length, 1);
    // Two receipts for the same provider message, both through the real Apps Script entry.
    const wa = { objectRef: 'e'.repeat(32), channel: 'whatsapp', scope: 'direct', direction: 'out', status: 'delivered', attachment: true };
    assert.equal(d.receive(wa).ok, true); assert.equal(d.receive(wa).ok, true);
    await desktop.locator('#crm-communication-review').click();
    await desktop.locator('.comm-review').getByText('אין כרגע שיחות או הודעות שממתינות לשיוך.').waitFor();
    await desktop.locator('#crm-drawer-close').click();
    await desktop.locator('[data-open-lead="test-card-a"]').first().click();
    await desktop.locator('#crm-drawer [data-tab="activity"]').click();
    const log = desktop.locator('#crm-drawer [data-pane="activity"]');
    await log.getByText(/שיחה נכנסת דרך המרכזייה.*לא נענתה/).waitFor();
    assert.equal(await log.getByText(/שיחה נכנסת דרך המרכזייה.*לא נענתה/).count(), 1);
    await log.getByText(/הודעת וואטסאפ יוצאת.*נמסרה.*קובץ מצורף/).waitFor();
    assert.equal(await log.getByText(/הודעת וואטסאפ יוצאת/).count(), 1);
    assert.equal(await desktop.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    const actual = await desktop.evaluate(() => fetch('/api/sheets?action=getTasks&status=open').then((r) => r.json()));
    assert.equal(actual.tasks.length, 1); assert.equal(actual.tasks[0].leadId, 'test-card-a');
    const forget = log.locator('[data-comm-forget]'); await forget.click(); await forget.click();
    await desktop.waitForFunction(() => !document.querySelector('#crm-drawer [data-comm-forget]'));
    assert.equal(d.rows()[0].forgottenBy, 'dana');
    await desktop.locator('#crm-drawer [data-tab="tasks"]').click();
    await desktop.locator('#crm-drawer [data-pane="tasks"]').getByText('לחזור לשיחה שלא נענתה', { exact: true }).first().waitFor();
    // Open the same review controls on desktop, exercise explicit dismissal with a withheld number.
    d.receive({ objectRef: 'd'.repeat(32), phone: '' });
    await desktop.locator('#crm-drawer-close').click(); await desktop.locator('#crm-communication-review').click();
    const review = desktop.locator('.comm-review');
    await review.getByRole('button', { name: 'בדיקה ושיוך' }).click();
    assert.match(await review.innerText(), /מספר חסוי/); assert.equal(await review.locator('input[name=remember]').isDisabled(), true);
    await review.locator('[data-comm-dismiss]').click(); await review.locator('[data-comm-dismiss]').click();
    await review.getByText('אין כרגע שיחות או הודעות שממתינות לשיוך.').waitFor(); assert.equal(d.tasks().length, 1);
  } finally { if (browser) await browser.close(); await s.close(); }
});
