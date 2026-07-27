/* Guard test: locks the house-id contract shared by the two sides of the app.
 *
 * public/app.js owns HOUSES — the dashboard's internal house ids and their
 * Hebrew display labels. apps-script/Code.gs consumes those same ids and labels
 * through hand-maintained mapping tables (DIGEST_HOUSE_NAME_TO_INTERNAL,
 * DIGEST_INTERNAL_TO_CANONICAL, MANAGER_HOUSE_TO_PATIENTS_HOUSE_ID) so the bonus
 * dashboard and the ActivePatients digest can read residence data WITHOUT
 * forcing a historical rename (see Code.gs:59-63).
 *
 * That divergence — internal `arfoni`/`asher` vs canonical `efroni`/`raanana` —
 * is intentional and correct, but the two files are wired together only by
 * these tables. Nothing else fails if someone renames a HOUSES id, changes a
 * Hebrew label, or drops a house from Code.gs's map: the digest would silently
 * stop emitting that house. This test pins both sides to one explicit, fully
 * enumerated key set so any such drift breaks CI instead of shipping quietly.
 *
 * Both sources are Google-Apps-Script / browser scripts with no module.exports,
 * so we read the source and evaluate it in a vm sandbox with the ambient globals
 * stubbed, then reach the REAL shipped values — same pattern as
 * coordinators-patients-digest.test.js and lead-assignedto.test.js. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/* The canonical house-id contract, enumerated explicitly (NO wildcards, NO
 * derivation from the source). If a house is renamed, relabeled, added, or
 * removed, one of these literals stops matching and CI fails — which is the
 * whole point. Order matches HOUSES in public/app.js. */
const EXPECTED_HOUSES = [
  { id: 'arfoni', name: 'קיסריה עפרוני' },
  { id: 'rehab',  name: 'קיסריה ריהאב' },
  { id: 'asher',  name: 'רעננה אשר' },
  { id: 'pardes', name: 'רעננה הפרדס' },
  { id: 'ramot',  name: 'רמות השבים' },
  { id: 'sde',    name: 'שדה אליעזר' },
];

/* Internal id → canonical digest/bonus id, for the four houses Code.gs carries.
 * pardes and sde are intentionally absent (excluded from the digest, never
 * renamed). Enumerated explicitly so a mapping edit fails CI. */
const EXPECTED_INTERNAL_TO_CANONICAL = {
  arfoni: 'efroni',
  asher:  'raanana',
  ramot:  'ramot',
  rehab:  'rehab',
};

function loadApp() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const epilogue = `
    globalThis.__test = {
      houses: () => HOUSES,
    };
  `;
  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/' },
    document: { addEventListener: noop, getElementById: () => null },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    URLSearchParams,
    Math, Date, JSON, Number, String, Array, Object, RegExp, Promise,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + epilogue, sandbox);
  return sandbox.__test;
}

function loadCode() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
  const epilogue = `
    globalThis.__test = {
      nameToInternal: () => DIGEST_HOUSE_NAME_TO_INTERNAL,
      internalToCanonical: () => DIGEST_INTERNAL_TO_CANONICAL,
      canonicalHouses: () => DIGEST_CANONICAL_HOUSES,
      managerToPatients: () => MANAGER_HOUSE_TO_PATIENTS_HOUSE_ID,
      managerHouseNames: () => MANAGER_HOUSE_NAMES,
      canonicalHouse: (v) => canonicalDigestHouse_(v),
    };
  `;
  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    JSON, Math, Date, Number, String, Array, Object, RegExp,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + epilogue, sandbox);
  return sandbox.__test;
}

const app = loadApp();
const code = loadCode();

// Values built inside a vm carry the vm's intrinsic prototypes, not reference-
// equal to the host's. Round-trip through JSON before structural comparison.
const plain = (v) => JSON.parse(JSON.stringify(v));

test('public/app.js HOUSES is exactly the six canonical houses, in order', () => {
  const houses = plain(app.houses());
  assert.deepStrictEqual(
    houses.map((h) => ({ id: h.id, name: h.name })),
    EXPECTED_HOUSES
  );
});

test("'arfoni' is the internal key and קיסריה עפרוני (Efroni) is its display label", () => {
  const houses = plain(app.houses());
  const efroni = houses.find((h) => h.id === 'arfoni');
  assert.ok(efroni, "HOUSES must contain the id 'arfoni' (NOT 'efroni' — the internal id diverges from the canonical id on purpose)");
  assert.strictEqual(efroni.name, 'קיסריה עפרוני');
  // The canonical (bonus/digest) side maps that internal id to 'efroni'.
  assert.strictEqual(code.canonicalHouse('arfoni'), 'efroni');
});

test('apps-script/Code.gs accepts exactly the app.js house-id set (no more, no less)', () => {
  const appIds = plain(app.houses()).map((h) => h.id).sort();
  // The internal ids Code.gs knows about are the values of its Hebrew-name map.
  const codeIds = Array.from(new Set(Object.values(plain(code.nameToInternal())))).sort();
  assert.deepStrictEqual(codeIds, appIds);
  assert.deepStrictEqual(codeIds, ['arfoni', 'asher', 'pardes', 'ramot', 'rehab', 'sde']);
});

test('Code.gs Hebrew-name → internal-id map mirrors HOUSES id ↔ label exactly', () => {
  const nameToInternal = plain(code.nameToInternal());
  // Every HOUSES entry round-trips: its Hebrew label resolves back to its id.
  for (const { id, name } of EXPECTED_HOUSES) {
    assert.strictEqual(nameToInternal[name], id, `Code.gs must map '${name}' → '${id}'`);
  }
  // And the map carries no labels beyond the six houses.
  assert.deepStrictEqual(
    Object.keys(nameToInternal).sort(),
    EXPECTED_HOUSES.map((h) => h.name).sort()
  );
});

test('internal → canonical mapping is the exact four-house set, pardes/sde excluded', () => {
  assert.deepStrictEqual(plain(code.internalToCanonical()), EXPECTED_INTERNAL_TO_CANONICAL);
  // The four canonical ids are locked too.
  assert.deepStrictEqual(
    Object.keys(plain(code.canonicalHouses())).sort(),
    ['efroni', 'raanana', 'ramot', 'rehab']
  );
  // pardes and sde exist in HOUSES but resolve to '' (excluded, never renamed).
  assert.strictEqual(code.canonicalHouse('pardes'), '');
  assert.strictEqual(code.canonicalHouse('sde'), '');
});

test('manager (bonus) side maps canonical efroni/raanana back to internal arfoni/asher', () => {
  const managerToPatients = plain(code.managerToPatients());
  assert.strictEqual(managerToPatients.efroni, 'arfoni');
  assert.strictEqual(managerToPatients.raanana, 'asher');
  assert.strictEqual(managerToPatients.ramot, 'ramot');
  assert.strictEqual(managerToPatients.rehab, 'rehab');
  // The bonus display name for efroni matches the app.js label for arfoni.
  assert.strictEqual(plain(code.managerHouseNames()).efroni, 'קיסריה עפרוני');
});
