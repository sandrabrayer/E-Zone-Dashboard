/* Refund logic foundation — Phase 1 of docs/billing-control-plan.md (§8).
 *
 * computeRefund_ and refundPayoutDate_ in apps-script/Code.gs: PURE
 * functions, not wired to any endpoint, sheet write or getData. The live
 * credits path (suggestCredits in app.js, payoutDateFor_ / upsertCredit_ in
 * Code.gs) is untouched by this change.
 *
 * The three tests marked [plan 8.x] are the "three failing tests" the plan
 * requires first (§8.1, §8.2, §8.4, §14 Phase 1). They were committed alone,
 * before the implementation, so the history shows them red.
 *
 * vm-sandbox on the REAL shipped Code.gs, per repo convention. The sandbox's
 * spreadsheet timezone is UTC on purpose: every Date cell must be read in
 * Asia/Jerusalem, never in the sheet's zone (the managerDateIso_ trap). */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const GS_SRC = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');

/* Utilities.formatDate's real contract: the date as seen in `tz`. */
function formatInTz(d, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

function loadGs() {
  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    JSON, Math, Date, Number, String, Array, Object, RegExp, Error, isFinite, isNaN,
    Logger: { log: noop },
    Utilities: { formatDate: (d, tz) => formatInTz(d, tz), getUuid: () => 'uuid' },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: noop }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSpreadsheetTimeZone: () => 'UTC' }) },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(GS_SRC + `
    globalThis.__t = {
      computeRefund: (x) => computeRefund_(x),
      payoutDate: (d) => refundPayoutDate_(d),
      cutoffDays: () => CREDIT_DETOX_TENURE_CUTOFF_DAYS,
    };`, sandbox);
  return sandbox.__t;
}
const gs = loadGs();
const refund = (x) => JSON.parse(JSON.stringify(gs.computeRefund(Object.assign({ decidedDate: '2026-10-01' }, x))));

/* ------------------------------------------------------------------------ */
/* The three tests the plan requires first                                  */
/* ------------------------------------------------------------------------ */

test('[plan 8.1] balance houses: "last 7 days" are counted on the patient\'s own cycle, not the calendar month', () => {
  for (const houseId of ['ramot', 'asher']) {
    const base = { houseId, entryDate: '2026-09-10', amountPaid: 30000 };
    // Cycle 10/09–09/10; last 7 days 03/10–09/10.
    const sep28 = refund(Object.assign({ exitDate: '2026-09-28' }, base));
    assert.strictEqual(sep28.refund, 11000, houseId + ' exit 28/09: 11 days not stayed (29/09–09/10)');
    assert.strictEqual(sep28.rule, 'residential_prorata');
    assert.strictEqual(sep28.cycleStart, '2026-09-10');
    assert.strictEqual(sep28.cycleEnd, '2026-10-09');

    const oct03 = refund(Object.assign({ exitDate: '2026-10-03' }, base));
    assert.strictEqual(oct03.refund, 0, houseId + ' exit 03/10 is cycle end − 6');
    assert.strictEqual(oct03.rule, 'residential_last_days_zero');

    const oct02 = refund(Object.assign({ exitDate: '2026-10-02' }, base));
    assert.strictEqual(oct02.refund, 7000, houseId + ' exit 02/10 is cycle end − 7: pro-rata on 03/10–09/10');
    assert.strictEqual(oct02.rule, 'residential_prorata');
  }
});

test('[plan 8.2] rehab / dual-diagnosis: entry day is day 1; exit on day 14 or later → no refund', () => {
  assert.strictEqual(gs.cutoffDays(), 14);
  for (const houseId of ['rehab', 'pardes']) {
    const base = { houseId, entryDate: '2026-09-01', amountPaid: 30000 };
    const day13 = refund(Object.assign({ exitDate: '2026-09-13' }, base));
    assert.strictEqual(day13.stayDay, 13);
    assert.strictEqual(day13.rule, 'detox_prorata');
    assert.strictEqual(day13.refund, 17000, houseId + ' day 13: 17 days not stayed (14/09–30/09)');

    const day14 = refund(Object.assign({ exitDate: '2026-09-14' }, base));
    assert.strictEqual(day14.stayDay, 14);
    assert.strictEqual(day14.rule, 'detox_tenure_cutoff_zero');
    assert.strictEqual(day14.refund, 0, houseId + ' day 14 → 0');

    const day15 = refund(Object.assign({ exitDate: '2026-09-15' }, base));
    assert.strictEqual(day15.rule, 'detox_tenure_cutoff_zero');
    assert.strictEqual(day15.refund, 0);
  }
});

test('[plan 8.4] payout date: decided on or before the 10th → the 15th of that month; after → the 15th of the next', () => {
  assert.strictEqual(gs.payoutDate('2026-10-10'), '2026-10-15');
  assert.strictEqual(gs.payoutDate('2026-10-11'), '2026-11-15');
  assert.strictEqual(gs.payoutDate('2026-10-15'), '2026-11-15');
  assert.strictEqual(gs.payoutDate('2026-12-20'), '2027-01-15');
});
