'use strict';
// Correctness regressions: real CRM + real Node, mutable synthetic source.
// No production account, patient, money or external browser traffic.
module.exports = function (h) {
  const { test, assert, skip, playwright, chromiumPath, boot, open, PAYMENTS, QUEUE, TODAY, setSaveAnswer } = h;
  const opt = { skip: skip && 'playwright/chromium missing', timeout: 60000 };
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const restore = (to, saved) => { Object.keys(to).forEach((k) => delete to[k]); Object.assign(to, saved); };
  const required = (r) => ['debtAging', 'getPayments'].includes(new URL(r.request().url()).searchParams.get('action'));
  const eventually = async (predicate, page, message) => {
    for (let i = 0; i < 200; i++) { if (predicate()) return; await page.waitForTimeout(25); }
    assert.fail(message);
  };
  async function account(page) {
    await page.click('#crm-nav button[data-area="clients"]');
    await page.click('table.tbl tbody tr[data-open-patient="p1"]');
    await page.waitForSelector('#crm-drawer[aria-hidden="false"]');
    await page.click('#crm-drawer [data-tab="account"]');
    await page.waitForSelector('#crm-account');
  }
  async function report(page) {
    await page.click('#crm-account-open [data-report-open="1"]');
    await page.waitForSelector('form[data-form="payment-report"]');
    await page.selectOption('form.report [name="method"]', 'מזומן');
    await page.fill('form.report [name="payer"]', 'משלם בדיקה');
    await page.selectOption('form.report [name="invoiceWanted"]', 'no');
  }
  function mutableConfirmation(parsed) {
    if (parsed.action === 'reportPayment') return { ok: true, receipt: { id: 'rcpt-new' }, cycle: { id: parsed.report.cycle.id } };
    if (parsed.action !== 'confirmPayment') return { ok: false, error: 'unexpected_test_write' };
    const c = parsed.confirm, id = c.ids[0];
    const rows = [PAYMENTS.receipts, QUEUE.receipts].map((a) => a.find((r) => r.id === id)).filter(Boolean);
    if (!rows.length) return { ok: false, error: 'receipt_not_found' };
    rows.forEach((r) => Object.assign(r, {
      confirmStatus: c.status, confirmedAmount: c.status === 'partial' ? c.confirmedAmount : r.amount,
      verifiedAmount: c.status === 'partial' ? c.confirmedAmount : r.amount,
      openAmount: c.status === 'partial' ? r.amount - c.confirmedAmount : 0,
      confirmedBy: 'אורטל', confirmedAt: '2026-11-15 12:00:00'
    }));
    return { ok: true, changed: [clone(rows[0])], unchanged: 0, unchangedRows: [] };
  }

  for (const partial of [false, true]) {
    test('billing integrity: delayed pre-verification GET cannot undo ' + (partial ? 'partial' : 'full') + ' proof; later source changes remain readable', opt, async () => {
      const before = { p: clone(PAYMENTS), q: clone(QUEUE) };
      const srv = await boot({ readCacheMs: 0 });
      const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
      let release = () => {}, hold = true, captured = 0;
      try {
        setSaveAnswer(mutableConfirmation);
        const { page, errors } = await open(browser, srv.port, 'sandra', 1366);
        await account(page); await report(page);
        const pending = new Promise((r) => { release = r; });
        await page.route('**/api/sheets?*', async (route) => {
          if (required(route) && hold) {
            const response = await route.fetch(); captured++;
            await pending; return route.fulfill({ response });
          }
          return route.continue();
        });
        await page.click('form.report button[type="submit"]');
        await eventually(() => captured === 2, page, 'captured two replies BEFORE confirmation');
        if (partial) {
          await page.click('#crm-account-receipts [data-verify-partial="rcpt-1"]');
          await page.fill('.vp-amt', '1000'); await page.click('[data-vp-save]');
        } else await page.click('#crm-account-receipts [data-verify="rcpt-1"]');
        const expected = partial ? 'אומת חלקית' : 'אומת ✓';
        await page.waitForFunction((txt) => Array.from(document.querySelectorAll('#crm-account-receipts .chip')).some((e) => e.textContent === txt), expected);
        hold = false; release();
        await page.waitForFunction(() => !document.querySelector('#crm-account-refresh'));
        await page.waitForTimeout(150);
        assert.equal(await page.$eval('#crm-account-receipts .chip', (e) => e.textContent), expected);
        assert.equal(srv.saves.filter((x) => x.action === 'confirmPayment').length, 1);
        assert.equal(srv.saves.filter((x) => x.action === 'reportPayment').length, 1);
        assert.equal(PAYMENTS.receipts.find((r) => r.id === 'rcpt-1').confirmedAmount, partial ? 1000 : 2500);
        [PAYMENTS.receipts, QUEUE.receipts].forEach((rows) => {
          const r = rows.find((x) => x.id === 'rcpt-1');
          Object.assign(r, { confirmStatus: 'reported', confirmedAmount: 0, verifiedAmount: 0, openAmount: r.amount });
        });
        await page.reload({ waitUntil: 'networkidle' }); await account(page);
        assert.equal(await page.$eval('#crm-account-receipts .chip', (e) => e.textContent), 'ממתין לאימות');
        assert.equal(srv.saves.filter((x) => x.action === 'confirmPayment').length, 1, 'readback never repeats confirmation');
        assert.deepEqual(errors, []);
      } finally { hold = false; release(); await browser.close(); srv.close(); restore(PAYMENTS, before.p); restore(QUEUE, before.q); }
    });
  }

  test('billing integrity: accepted payment + failed reload warns, blocks stale writes, recovers by GET only', opt, async () => {
    const srv = await boot({ readCacheMs: 0 });
    const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
    try {
      const { page, errors } = await open(browser, srv.port, 'vered', 1366);
      await account(page); await report(page);
      let failReads = true, refused = 0;
      await page.route('**/api/sheets?*', (route) => {
        if (required(route) && failReads) { refused++; return route.abort('connectionfailed'); }
        return route.continue();
      });
      await page.click('form.report button[type="submit"]');
      await page.waitForSelector('#crm-account [data-billing-stale]');
      assert.ok(refused >= 1);
      assert.match(await page.textContent('#crm-account'), /לא עדכני|ישנים|לא ניתן|נכשל/);
      assert.equal(await page.locator('#crm-account [data-report-open]:enabled').count(), 0);
      assert.equal(srv.saves.filter((x) => x.action === 'reportPayment').length, 1);
      failReads = false;
      await page.click('#crm-account [data-billing-read-retry]');
      await page.waitForFunction(() => !document.querySelector('#crm-account [data-billing-stale]'));
      assert.ok(await page.locator('#crm-account [data-report-open]:enabled').count());
      assert.equal(srv.saves.filter((x) => x.action === 'reportPayment').length, 1);
      assert.equal(srv.saves.filter((x) => ['confirmPayment', 'setBillingDiscount', 'upsertBillingOverride'].includes(x.action)).length, 0);
      assert.deepEqual(errors, []);
    } finally { await browser.close(); srv.close(); }
  });

  test('billing integrity: unavailable receipts are unknown, never a debt-free overview, search or account', opt, async () => {
    const before = clone(PAYMENTS);
    PAYMENTS.ok = false; PAYMENTS.error = 'synthetic_unavailable';
    const srv = await boot({ readCacheMs: 0, debt: { ok: true, asOf: TODAY, byPatient: [], totals: {}, byHouse: [] } });
    const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
    try {
      const { page, errors } = await open(browser, srv.port, 'ortal', 1366);
      await page.click('#crm-nav button[data-area="billing"]');
      await page.waitForSelector('[data-billing-stale]');
      assert.doesNotMatch(await page.textContent('#crm-main'), /אין חובות|ללא חוב פתוח/);
      const money = await page.locator('#crm-ov-debt .v').allTextContents();
      assert.ok(!money.length || money.every((t) => !/[0-9]/.test(t)), 'unknown receipt source cannot show numeric debt total');
      await page.fill('#crm-search', 'דנה');
      await page.waitForTimeout(150);
      assert.doesNotMatch(await page.textContent('#crm-main'), /מטופלים ללא חוב פתוח/);
      await account(page);
      await page.waitForSelector('#crm-account [data-billing-stale]');
      assert.doesNotMatch(await page.textContent('#crm-account'), /אין חוב פתוח/);
      assert.equal(await page.locator('#crm-account [data-report-open]:enabled').count(), 0);
      assert.deepEqual(errors, []);
    } finally { await browser.close(); srv.close(); restore(PAYMENTS, before); }
  });
};
