'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs');
const { fixture } = require('../helpers/crm-queue-fixture');
let playwright;
try { if (process.env.CRM_PLAYWRIGHT_MODULE) playwright = require(process.env.CRM_PLAYWRIGHT_MODULE); } catch (_) { /* optional locally, required in CI job */ }
const executablePath = process.env.CRM_CHROMIUM;
const available = !!playwright && !!executablePath && fs.existsSync(executablePath);
if (process.env.CRM_REQUIRE_BROWSER_TESTS === '1' && !available) throw Error('CRM browser tooling required');
const run = available ? test : (name, fn) => test(name, { skip: 'requires CRM browser fixture tooling' }, fn);
let f, browser, context, page;
if (available) {
  test.before(async () => { browser = await playwright.chromium.launch({ executablePath }); });
  test.after(async () => { await browser.close(); });
  test.beforeEach(async () => {
    f = await fixture(); context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
    await context.addCookies([{ name: 'fixture-session', value: 'valid', url: f.origin }]);
    page = await context.newPage();
  });
  test.afterEach(async () => { await context.close(); await f.close(); });
}
const loaded = () => page.waitForFunction(() => !document.getElementById('refresh').disabled);
async function refresh() { await page.getByRole('button', { name: 'עדכון מהמקור' }).click(); await loaded(); }
run('CRM browser: first load never collects; explicit refresh renders escaped source text and missing deadline', async () => {
  f.state.rows[0].name = '<img src=x onerror="window.leaked=true"> בדיקת טקסט';
  await page.goto(f.origin + '/crm-work'); await loaded();
  assert.equal(f.state.reads, 0); assert.match(await page.locator('#empty').innerText(), /טרם נשמר/);
  await refresh(); assert.equal(f.state.reads, 1);
  assert.match(await page.locator('.task h2').innerText(), /<img/); assert.equal(await page.locator('.task img').count(), 0);
  assert.equal(await page.evaluate(() => window.leaked), undefined);
  assert.match(await page.locator('.task').innerText(), /חסר — יש לברר/);
  assert.equal(await page.locator('.task a').getAttribute('href'), '/#leads');
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
});
run('CRM browser: source outage and reload retain work; partial/disappeared source is never all-clear', async () => {
  await page.goto(f.origin + '/crm-work'); await loaded(); await refresh();
  f.state.source = 'unavailable'; await refresh();
  assert.equal(await page.locator('.task').count(), 1); assert.match(await page.locator('#status').innerText(), /המקור אינו זמין/);
  assert.match(await page.locator('.task .warning').innerText(), /נשמרה/);
  await page.reload(); await loaded(); assert.equal(await page.locator('.task').count(), 1); assert.equal(f.state.reads, 2);
  f.state.source = 'fresh'; f.state.rows = []; await refresh(); assert.equal(await page.locator('.task').count(), 1);
  assert.match(await page.locator('.task .warning').innerText(), /לא התקבלה/);
});
run('CRM browser: expired/revoked access removes names and counts instead of keeping stale sensitive data', async () => {
  await page.goto(f.origin + '/crm-work'); await loaded(); await refresh();
  const name = f.state.rows[0].name; assert.match(await page.locator('body').innerText(), new RegExp(name));
  f.state.allowed = false; await refresh();
  assert.equal(await page.locator('.task').count(), 0); assert.equal(await page.locator('#summary').isVisible(), false);
  assert.ok(!(await page.locator('body').innerText()).includes(name)); assert.match(await page.locator('#status').innerText(), /להתחבר מחדש/);
});
run('CRM browser: explicit archive evidence retires both reminders and remains closed on reload', async () => {
  f.state.rows[0].visitDate='2020-01-01';
  await page.goto(f.origin+'/crm-work'); await loaded(); await refresh(); assert.equal(await page.locator('.task').count(),2);
  f.state.rows=[{id:'fixture-1',name:'',stage:'',assignedTo:'',visitDate:'',meetingOutcome:'',meetingReportOutcome:'',leadLifecycle:'irrelevant'}];
  await refresh(); assert.equal(await page.locator('.task').count(),0); assert.match(await page.locator('#empty').innerText(),/אין משימות פתוחות/);
  await page.reload(); await loaded(); assert.equal(await page.locator('.task').count(),0); assert.equal(f.state.reads,2);
});
run('CRM browser: mobile layout, preserved deadline after reassignment, filters and no false empty state on DB error', async () => {
  await f.refresh();
  // The current source has no follow-up deadline. A synthetic checkpoint with
  // an established deadline verifies the UI's preservation path explicitly.
  f.state.checkpoint.tasks[0].record.originalDueDate = '2020-01-01'; f.state.checkpoint.tasks[0].record.dueBasis = 'source';
  f.state.rows[0].assignedTo = 'מבצעת חדשה';
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto(f.origin + '/crm-work'); await loaded(); await refresh();
  assert.match(await page.locator('.task').innerText(), /מבצעת חדשה/); assert.match(await page.locator('.task').innerText(), /01.01.2020 · באיחור/);
  await page.locator('#filter').selectOption('overdue'); assert.equal(await page.locator('.task').count(), 1);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  if (process.env.CRM_SCREENSHOT) await page.screenshot({ path: process.env.CRM_SCREENSHOT, fullPage: true });
  f.state.failure = 'checkpoint_unavailable'; await refresh();
  assert.equal(await page.locator('.task').count(), 0); assert.match(await page.locator('#status').innerText(), /אין בכך אישור/);
});
