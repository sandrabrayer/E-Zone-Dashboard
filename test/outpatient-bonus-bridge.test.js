/**
 * Tests for the outpatient-continuation bonus bridge in
 * apps-script/Code.gs (DASHBOARD side, step 3).
 *
 * Run with:  npm test     (Node >= 18, built-in runner)
 *
 * What this guards (all money-critical):
 *  1. fetchOutpatientContinuity_ maps the OUTPATIENTS feed's byHouse->total
 *     into the shape calcHouseBonus_ expects, with per-therapy counts 0.
 *  2. All fail-safe paths (no config, HTTP error, bad payload, month
 *     mismatch, thrown error) return the ZEROED shape + an _meta.error and
 *     NEVER throw and NEVER fall back to the old flat-rate numbers.
 *  3. The BEP-gate removal: continuity is paid even when the house is
 *     BELOW BEP, while base/daily/quarterly STILL require qualifies.
 *  4. The legacy flat-rate computeContinuityByHouse_ is no longer wired
 *     into the managers endpoints.
 *
 * Strategy: evaluate Code.gs inside a vm sandbox that stubs only the Apps
 * Script globals the touched code uses (PropertiesService, UrlFetchApp).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CODE_GS = fs.readFileSync(
  path.join(__dirname, '..', 'apps-script', 'Code.gs'),
  'utf8'
);

/**
 * Build a sandbox. `props` = Script Properties map. `fetchImpl` = function
 * (url, opts) -> { code, text } used by the UrlFetchApp stub.
 */
function makeEnv(props, fetchImpl) {
  const sandbox = {};
  sandbox.global = sandbox;
  sandbox.PropertiesService = {
    getScriptProperties() {
      return { getProperty(k) { return Object.prototype.hasOwnProperty.call(props, k) ? props[k] : null; } };
    }
  };
  sandbox.UrlFetchApp = {
    fetch(url, opts) {
      const r = fetchImpl(url, opts);
      return {
        getResponseCode() { return r.code; },
        getContentText() { return r.text; },
      };
    }
  };
  // Globals referenced at parse/eval time by unrelated parts of Code.gs.
  sandbox.SpreadsheetApp = { getActiveSpreadsheet() { return null; } };
  sandbox.ContentService = {
    createTextOutput() { return { setMimeType() { return this; } }; },
    MimeType: { JSON: 'json' },
  };
  sandbox.Utilities = {};
  sandbox.Session = { getScriptTimeZone() { return 'Asia/Jerusalem'; } };
  sandbox.LockService = { getScriptLock() { return { tryLock() {}, releaseLock() {} }; } };
  vm.createContext(sandbox);
  vm.runInContext(CODE_GS, sandbox, { filename: 'Code.gs' });
  return sandbox;
}

const HOUSES = ['raanana', 'ramot', 'efroni', 'rehab'];
const CFG_URL = 'https://script.example.com/macros/s/AB/exec';

function okFeed(month, byHouse) {
  return {
    code: 200,
    text: JSON.stringify({
      ok: true, sourceApp: 'ezone-outpatient', kind: 'continuation_bonus',
      month: month, ratePct: 5, byHouse: byHouse,
      total: Object.values(byHouse).reduce((s, v) => s + v, 0),
    }),
  };
}

test('happy path: feed byHouse maps into total, therapy counts 0', () => {
  const env = makeEnv(
    { OUTPATIENT_BONUS_URL: CFG_URL, OUTPATIENT_BONUS_SECRET: 's3cr3t' },
    () => okFeed('2026-05', { raanana: 210, ramot: 0, efroni: 175, rehab: 50 })
  );
  const r = JSON.parse(JSON.stringify(env.fetchOutpatientContinuity_('2026-05')));
  assert.deepEqual(r.raanana, { maintenance: 0, day_2x: 0, day_daily: 0, total: 210 });
  assert.equal(r.efroni.total, 175);
  assert.equal(r.rehab.total, 50);
  assert.equal(r._meta.ok, true);
  assert.equal(r._meta.source, 'ezone-outpatient');
  assert.equal(r._meta.month, '2026-05');
});

test('passes action+secret to the configured URL', () => {
  let seen = null;
  const env = makeEnv(
    { OUTPATIENT_BONUS_URL: CFG_URL, OUTPATIENT_BONUS_SECRET: 'sek ret/&' },
    (url) => { seen = url; return okFeed('2026-05', { raanana: 0, ramot: 0, efroni: 0, rehab: 0 }); }
  );
  env.fetchOutpatientContinuity_('2026-05');
  assert.ok(seen.startsWith(CFG_URL));
  assert.ok(seen.includes('action=getContinuationBonus'));
  assert.ok(seen.includes('secret=' + encodeURIComponent('sek ret/&')));
});

test('not configured -> zeroed + error, no throw', () => {
  const env = makeEnv({}, () => { throw new Error('should not be called'); });
  const r = env.fetchOutpatientContinuity_('2026-05');
  HOUSES.forEach((h) => assert.equal(r[h].total, 0));
  assert.equal(r._meta.ok, false);
  assert.equal(r._meta.error, 'outpatient_bonus_not_configured');
});

test('HTTP non-200 -> zeroed + error', () => {
  const env = makeEnv(
    { OUTPATIENT_BONUS_URL: CFG_URL, OUTPATIENT_BONUS_SECRET: 'x' },
    () => ({ code: 500, text: 'boom' })
  );
  const r = env.fetchOutpatientContinuity_('2026-05');
  HOUSES.forEach((h) => assert.equal(r[h].total, 0));
  assert.equal(r._meta.error, 'outpatient_http_500');
});

test('unauthorized payload (ok:false) -> zeroed + propagates error', () => {
  const env = makeEnv(
    { OUTPATIENT_BONUS_URL: CFG_URL, OUTPATIENT_BONUS_SECRET: 'x' },
    () => ({ code: 200, text: JSON.stringify({ ok: false, error: 'unauthorized' }) })
  );
  const r = env.fetchOutpatientContinuity_('2026-05');
  assert.equal(r._meta.error, 'unauthorized');
  HOUSES.forEach((h) => assert.equal(r[h].total, 0));
});

test('malformed JSON -> zeroed + fetch_failed, no throw', () => {
  const env = makeEnv(
    { OUTPATIENT_BONUS_URL: CFG_URL, OUTPATIENT_BONUS_SECRET: 'x' },
    () => ({ code: 200, text: 'not json{' })
  );
  const r = env.fetchOutpatientContinuity_('2026-05');
  assert.equal(r._meta.error, 'outpatient_fetch_failed');
  HOUSES.forEach((h) => assert.equal(r[h].total, 0));
});

test('month mismatch -> zeroed + mismatch meta (never wrong-month money)', () => {
  const env = makeEnv(
    { OUTPATIENT_BONUS_URL: CFG_URL, OUTPATIENT_BONUS_SECRET: 'x' },
    () => okFeed('2026-05', { raanana: 999, ramot: 0, efroni: 0, rehab: 0 })
  );
  const r = env.fetchOutpatientContinuity_('2026-04');
  assert.equal(r._meta.error, 'outpatient_month_mismatch');
  assert.equal(r._meta.sourceMonth, '2026-05');
  assert.equal(r._meta.requestedMonth, '2026-04');
  HOUSES.forEach((h) => assert.equal(r[h].total, 0));
});

test('BEP gate removed for continuity ONLY; stability still gated', () => {
  const env = makeEnv(
    { OUTPATIENT_BONUS_URL: CFG_URL, OUTPATIENT_BONUS_SECRET: 'x' },
    () => okFeed('2026-05', { raanana: 0, ramot: 0, efroni: 0, rehab: 0 })
  );
  // House BELOW bep -> qualifies=false. base/daily/quarterly must be 0,
  // but continuity.total must still flow through.
  const belowBep = env.calcHouseBonus_({
    cfg: { bep_patients: 10, bonus_base: 5000, bonus_per_day: 100 },
    stats: { avgDaily: 4, dailyCounts: [4, 4, 4] },
    ym: '2026-05',
    continuity: { maintenance: 0, day_2x: 0, day_daily: 0, total: 777 },
    consecutiveAboveBep: 9,
  });
  assert.equal(belowBep.qualifies, false);
  assert.equal(belowBep.base, 0);
  assert.equal(belowBep.daily, 0);
  assert.equal(belowBep.quarterly, 0);
  assert.equal(belowBep.continuity.total, 777);   // PAID despite below BEP
  assert.equal(belowBep.total, 777);

  // House AT/above bep -> stability also pays, continuity still added.
  const aboveBep = env.calcHouseBonus_({
    cfg: { bep_patients: 3, bonus_base: 5000, bonus_per_day: 100 },
    stats: { avgDaily: 5, dailyCounts: [5, 5, 5] },
    ym: '2026-05',
    continuity: { maintenance: 0, day_2x: 0, day_daily: 0, total: 777 },
    consecutiveAboveBep: 0,
  });
  assert.equal(aboveBep.qualifies, true);
  assert.equal(aboveBep.base, 5000);
  assert.equal(aboveBep.continuity.total, 777);
  assert.equal(aboveBep.total, 5000 + aboveBep.daily + 777);
});

test('legacy flat-rate computeContinuityByHouse_ is no longer wired in', () => {
  // It still exists (kept for rollback) but must NOT be referenced by the
  // managers endpoints anymore.
  const overview = CODE_GS.slice(CODE_GS.indexOf('function managersOverview_'));
  const house    = CODE_GS.slice(CODE_GS.indexOf('function managersHouse_'));
  const overviewBody = overview.slice(0, overview.indexOf('\n}\n'));
  const houseBody    = house.slice(0, house.indexOf('\n}\n'));
  assert.ok(!/computeContinuityByHouse_/.test(overviewBody),
    'managersOverview_ must not call the legacy flat-rate fn');
  assert.ok(!/computeContinuityByHouse_/.test(houseBody),
    'managersHouse_ must not call the legacy flat-rate fn');
  assert.ok(/fetchOutpatientContinuity_/.test(overviewBody));
  assert.ok(/fetchOutpatientContinuity_/.test(houseBody));
});
