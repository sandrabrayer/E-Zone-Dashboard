/* «ייצוא לאקסל» in a REAL browser (CHANGELOG-report-xlsx-export.md): the
 * three shipped modules (lib/leads-funnel.js, lib/patient-retention.js,
 * lib/report-xlsx.js) are loaded as the page loads them (plain <script>, in
 * that order), the workbook is built in Chromium, and the bytes are read back
 * here with exceljs. Skipped when Playwright / Chromium are absent. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ExcelJS = require('exceljs');

let playwright = null;
try { playwright = require('playwright'); } catch (_) { /* not installed — skip */ }
const CHROMIUM_CANDIDATES = [
  process.env.CHROMIUM_PATH,
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/opt/pw-browsers/chromium/chrome-linux/chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
].filter(Boolean);
const chromiumPath = CHROMIUM_CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch (_) { return false; } });
const skip = !playwright || !chromiumPath;
const why = !playwright ? 'playwright not installed' : (!chromiumPath ? 'no chromium binary' : '');
const lib = (f) => fs.readFileSync(path.join(__dirname, '..', 'lib', f), 'utf8');

test('browser: the modules load as plain scripts and build a valid 8-sheet workbook', { skip: skip && why, timeout: 60000 }, async () => {
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.setContent('<!doctype html><html dir="rtl"><body></body></html>');
    for (const f of ['leads-funnel.js', 'patient-retention.js', 'report-xlsx.js']) await page.addScriptTag({ content: lib(f) });
    const bytes = await page.evaluate(() => {
      const retention = window.PatientRetention.computeRetention({
        from: '2026-09-01', to: '2026-09-30', today: '2026-10-20',
        patients: [{ id: 'p1', houseId: 'ramot', name: 'אלף', date: '2026-09-01', status: 'released', exitDate: '2026-09-11' }],
        discharged: [{ id: 'a1', patientId: 'p1', houseId: 'ramot', name: 'אלף', date: '2026-09-01', exitDate: '2026-09-11', continuity: 'none', phone: '0501234567' }],
      });
      const funnel = window.LeadsFunnel.funnel({ from: '2026-09-01', to: '2026-09-30', leads: [{ id: 'l1', name: '=x', phone: '0521234567', created: '2026-09-02', stage: 'visit' }] });
      const out = window.ReportXlsx.writeXlsx(window.ReportXlsx.fullWorkbook({ funnel, retention, from: '2026-09-01', to: '2026-09-30', exportedAt: new Date() }));
      return Array.from(out);
    });
    assert.deepEqual(errors, []);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(bytes));
    assert.equal(wb.worksheets.length, 8);
    assert.equal(wb.getWorksheet('מטופלים – רשימה').getRow(2).getCell(4).value, '0501234567');
    assert.equal(wb.getWorksheet('לידים – רשימה').getRow(2).getCell(2).value, "'=x");
  } finally {
    await browser.close();
  }
});
