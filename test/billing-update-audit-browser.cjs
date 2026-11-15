'use strict';
// Isolated Chromium, actual CRM+Node; original synthetic Apps Script transport.
// GAP tests deliberately reproduce current behavior, not a runtime correction.
module.exports = (h) => {
  const { test, assert, skip, playwright, chromiumPath, boot, open, billTab, PAYMENTS, TODAY } = h;
  const opt = { skip: skip && 'playwright/chromium missing' };
  const emit = (id, data) => console.log('BILLING_AUDIT_BROWSER ' + JSON.stringify({ id, ...data }));
  async function account(page) {
    await page.click('#crm-nav button[data-area="clients"]');
    await page.click('table.tbl tbody tr[data-open-patient="p1"]');
    await page.waitForSelector('#crm-drawer[aria-hidden="false"]');
    await page.click('#crm-drawer [data-tab="account"]');
    await page.waitForSelector('#crm-account-open');
  }
  async function form(page) {
    await page.click('#crm-account-open [data-report-open="1"]');
    await page.waitForSelector('form[data-form="payment-report"]');
    await page.selectOption('form.report [name="method"]', 'מזומן');
    await page.fill('form.report [name="payer"]', 'משלם בדיקה');
    await page.selectOption('form.report [name="invoiceWanted"]', 'no');
  }

  test('BILLING AUDIT GAP: an older in-flight billing read resurrects a verified receipt', opt, async () => {
    const srv = await boot({ readCacheMs: 0 });
    const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
    let release = () => {};
    try {
      const { page, errors } = await open(browser, srv.port, 'sandra', 1366);
      await account(page); await form(page);
      let captured = 0;
      const held = new Promise((r) => { release = r; });
      await page.route('**/api/sheets?*', async (route) => {
        if (/[?&]action=(debtAging|getPayments)(?:&|$)/.test(route.request().url())) {
          // Capture the old read BEFORE confirmation, then deliver it afterwards.
          const response = await route.fetch(); captured++;
          await held; return route.fulfill({ response });
        }
        return route.continue();
      });
      await page.click('form.report button[type="submit"]');
      await page.waitForSelector('#crm-account-refresh');
      for (let i = 0; i < 150 && captured < 2; i++) await page.waitForTimeout(20);
      assert.equal(captured, 2, 'two old read replies captured before verification');
      await page.click('#crm-account-receipts [data-verify="rcpt-1"]');
      await page.waitForFunction(() => !!document.querySelector('#crm-account-receipts .chip.ok'));
      assert.equal(srv.saves.filter((x) => x.action === 'confirmPayment').length, 1);
      release();
      await page.waitForFunction(() => !document.querySelector('#crm-account-refresh'));
      const resurrected = !!(await page.$('#crm-account-receipts [data-verify="rcpt-1"]'));
      emit('stale_read_after_verification', { captured, confirmationPosts: 1, resurrected, errors });
      assert.equal(resurrected, true, 'GAP characterization: old read must not replace confirmed proof');
      assert.deepEqual(errors, []);
    } finally { release(); await browser.close(); srv.close(); }
  });

  test('BILLING AUDIT GAP: failed post-save reload silently retains actionable old account', opt, async () => {
    const srv = await boot({ readCacheMs: 0 });
    const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
    try {
      const { page, errors } = await open(browser, srv.port, 'vered', 1366);
      await account(page); await form(page);
      let refusedReads = 0;
      await page.route('**/api/sheets?*', (route) => {
        if (/[?&]action=(debtAging|getPayments)(?:&|$)/.test(route.request().url())) { refusedReads++; return route.abort('connectionfailed'); }
        return route.continue();
      });
      await page.click('form.report button[type="submit"]');
      await page.waitForFunction(() => !document.querySelector('form.report') && !document.querySelector('#crm-account-refresh'));
      for (let i = 0; i < 100 && refusedReads < 2; i++) await page.waitForTimeout(20);
      const text = await page.textContent('#crm-account');
      const hasStaleWarning = /נתונים ישנים|הרענון נכשל|לא ניתן לרענן|לא ניתן לטעון|לא נטענו|לא ידוע אם|בדיקת השמירה/.test(text);
      const actionable = await page.locator('#crm-account [data-report-open]:enabled').count();
      emit('failed_reload', { refusedReads, acceptedReportPosts: srv.saves.filter((x) => x.action === 'reportPayment').length, hasStaleWarning, actionable, errors });
      assert.equal(refusedReads, 2); assert.equal(hasStaleWarning, false, 'GAP: no stale/readback warning');
      assert.ok(actionable > 0, 'GAP: old report buttons stay active'); assert.deepEqual(errors, []);
    } finally { await browser.close(); srv.close(); }
  });

  test('BILLING AUDIT GAP: receipt read failure can display no open debts', opt, async () => {
    const oldOk = PAYMENTS.ok, oldError = PAYMENTS.error;
    PAYMENTS.ok = false; PAYMENTS.error = 'synthetic_receipts_unavailable';
    const srv = await boot({ readCacheMs: 0, debt: { ok: true, asOf: TODAY, byPatient: [], totals: {}, byHouse: [] } });
    const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
    try {
      const { page, errors } = await open(browser, srv.port, 'ortal', 1366);
      await page.waitForSelector('#crm-bill-overview');
      await billTab(page, 'debts');
      const body = await page.textContent('#crm-bill-body');
      const saysNoDebt = /אין חובות/.test(body);
      emit('receipt_source_failure_ui', { saysNoDebt, section: body.slice(0, 1000), errors });
      assert.equal(saysNoDebt, true, 'GAP: unavailable receipts must not establish zero pending debt');
      assert.deepEqual(errors, []);
    } finally {
      await browser.close(); srv.close(); PAYMENTS.ok = oldOk;
      if (oldError === undefined) delete PAYMENTS.error; else PAYMENTS.error = oldError;
    }
  });

  test('BILLING AUDIT control: Ortal and Vered write restrictions enforced by real Node server', opt, async () => {
    const srv = await boot();
    const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
    try {
      const { page, errors } = await open(browser, srv.port, 'ortal', 390);
      const denied = await page.evaluate(async () => {
        const results = [];
        for (const action of ['reportPayment', 'setBillingDiscount', 'editReceipt', 'savePayment']) {
          const r = await fetch('/api/sheets', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) });
          results.push({ action, status: r.status });
        }
        return results;
      });
      assert.ok(denied.every((r) => r.status === 403), JSON.stringify(denied));
      const v = await open(browser, srv.port, 'vered', 1366);
      const verifyDenied = await v.page.evaluate(async () => {
        const r = await fetch('/api/sheets', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'confirmPayment', confirm: { ids: ['rcpt-1'], status: 'confirmed' } }) }); return r.status;
      });
      assert.equal(verifyDenied, 403); assert.equal(srv.saves.length, 0);
      emit('role_controls', { denied, verifyDenied, writesReachedSource: srv.saves.length });
      assert.deepEqual(errors, []); assert.deepEqual(v.errors, []);
    } finally { await browser.close(); srv.close(); }
  });

  test('BILLING AUDIT GAP: refund search result does not open the patient account', opt, async () => {
    const srv = await boot();
    const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
    try {
      const { page, errors } = await open(browser, srv.port, 'vered', 1366);
      await page.click('#crm-nav button[data-area="billing"]');
      await page.waitForSelector('#crm-bill-overview');
      await page.fill('#crm-search', 'דנה');
      await page.waitForSelector('#crm-find-refunds tbody tr');
      const linked = await page.locator('#crm-find-refunds [data-open-patient]').count();
      await page.click('#crm-find-refunds tbody tr td:first-child');
      const opened = await page.getAttribute('#crm-drawer', 'aria-hidden') === 'false';
      emit('refund_result_navigation', { linked, opened });
      assert.equal(linked, 0); assert.equal(opened, false, 'GAP: announcement promised account navigation from results');
      assert.deepEqual(errors, []);
    } finally { await browser.close(); srv.close(); }
  });
};
