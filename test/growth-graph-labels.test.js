/* Tests for the growth-graph x-axis tick-selection helper in public/app.js.
 *
 * Same vm-sandbox approach as growth-graph.test.js / breakeven-revenue.test.js:
 * app.js is a browser global script (no module.exports, touches document/
 * location at top level), so we read the source, append an epilogue exposing the
 * pure helper under test, and evaluate it in a vm context with browser globals
 * stubbed. No changes to app.js are required for the test itself.
 *
 * growthTickIndices(n, maxTicks) picks which of n x-axis points get a date
 * label. The render caps maxTicks at plotWidth / ~70px, so these tests assert
 * the properties that keep labels from overlapping and clipping. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadApp() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const epilogue = `
    globalThis.__test = { growthTickIndices, growthLineChartSVG };
  `;
  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    location: { origin: 'http://test', href: 'http://test/' },
    document: { addEventListener: noop, getElementById: () => null },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    URLSearchParams, Math, Date, JSON, Number, String, Array, Object,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + epilogue, sandbox);
  return sandbox.__test;
}

const app = loadApp();

// Cross-realm arrays (from the vm sandbox) have a different Array.prototype, so
// deepStrictEqual rejects them — compare via join() on primitives instead.
const idx = (n, cap) => app.growthTickIndices(n, cap).join(',');

test('first and last data point are always included', () => {
  for (const n of [2, 3, 5, 10, 15, 27, 52]) {
    const arr = app.growthTickIndices(n, 8);
    assert.strictEqual(arr[0], 0, `n=${n}: first must be 0`);
    assert.strictEqual(arr[arr.length - 1], n - 1, `n=${n}: last must be ${n - 1}`);
  }
});

test('never returns more than maxTicks labels (no overlap for narrow widths)', () => {
  // A narrow chart budgets few ticks; the helper must respect the cap so labels
  // stay ~1 label-width apart instead of piling up.
  for (const cap of [2, 3, 4, 5, 8]) {
    for (const n of [6, 12, 20, 40, 52]) {
      const arr = app.growthTickIndices(n, cap);
      assert.ok(arr.length <= cap, `n=${n}, cap=${cap}: got ${arr.length} > ${cap}`);
    }
  }
});

test('indices are strictly increasing (no duplicate label on the same point)', () => {
  for (const cap of [2, 3, 5, 8]) {
    for (const n of [3, 7, 16, 33, 52]) {
      const arr = app.growthTickIndices(n, cap);
      for (let i = 1; i < arr.length; i++) {
        assert.ok(arr[i] > arr[i - 1], `n=${n}, cap=${cap}: not increasing at ${i} (${arr})`);
      }
    }
  }
});

test('the last gap is even — no last-two collision from a forced final tick', () => {
  // The original bug: modulo thinning plus a forced last index could place the
  // final two labels one point apart. Even spacing means the last gap is no
  // smaller than the typical gap.
  const n = 16, cap = 8;
  const arr = app.growthTickIndices(n, cap);
  const gaps = arr.slice(1).map((v, i) => v - arr[i]);
  const lastGap = gaps[gaps.length - 1];
  const maxGap = Math.max.apply(null, gaps);
  // last gap must be within one point of the largest gap (i.e. not a tiny stub).
  assert.ok(lastGap >= maxGap - 1, `lastGap=${lastGap} vs maxGap=${maxGap} in ${arr}`);
  assert.ok(lastGap >= 1);
});

test('returns every point when n fits within the cap', () => {
  assert.strictEqual(idx(5, 8), '0,1,2,3,4');
  assert.strictEqual(idx(8, 8), '0,1,2,3,4,5,6,7');
  assert.strictEqual(idx(2, 8), '0,1');
});

test('evenly spaces a known case', () => {
  // n=9, cap=5 -> k*(8)/4 = 0,2,4,6,8.
  assert.strictEqual(idx(9, 5), '0,2,4,6,8');
});

test('degenerate inputs', () => {
  assert.strictEqual(idx(0, 8), '');       // no data
  assert.strictEqual(idx(1, 8), '0');      // single point
  assert.strictEqual(idx(5, 1), '0,4');    // cap floored up to 2 -> first & last
  assert.strictEqual(idx(5, 0), '0,4');    // cap 0 -> min 2
});

/* ===== width-aware growthLineChartSVG (PWA PR 2 mobile) ===== */

// A realistic weekly series (26 points) — more than any narrow phone can label,
// so the width cap is what limits them.
function weeklySeries(n) {
  return Array.from({ length: n }, (_, i) => ({
    value: 10 + (i % 7),
    // dd/mm/yyyy date labels, the widest thing on the axis (~70px).
    label: String((i % 28) + 1).padStart(2, '0') + '/0' + ((i % 9) + 1) + '/2026',
  }));
}

// Pull every x-label's x + text-anchor out of the rendered SVG string.
function xLabels(svg) {
  return [...svg.matchAll(/x="([\d.]+)" y="\d+" class="growth-xlabel" text-anchor="(\w+)"/g)]
    .map(m => ({ x: Number(m[1]), anchor: m[2] }));
}

// Every numeric x-ish coordinate in the SVG (label x, dot cx, gridline x2,
// polyline point xs) — used to prove nothing is drawn past the right edge.
function allXCoords(svg) {
  const xs = [];
  for (const m of svg.matchAll(/(?:^|\s)(?:x|x1|x2|cx)="([\d.]+)"/g)) xs.push(Number(m[1]));
  for (const m of svg.matchAll(/points="([^"]+)"/g)) {
    for (const pair of m[1].trim().split(/\s+/)) xs.push(Number(pair.split(',')[0]));
  }
  return xs;
}

function viewBoxW(svg) {
  return Number(svg.match(/viewBox="0 0 ([\d.]+) [\d.]+"/)[1]);
}

test('narrow 360px container renders ~4-5 labels, none clipped', () => {
  const svg = app.growthLineChartSVG(weeklySeries(26), { maxXLabels: 8, width: 360 });
  const W = viewBoxW(svg);
  assert.strictEqual(W, 360, 'viewBox width should equal the measured width');
  const labels = xLabels(svg);
  // innerW = 360-56-16 = 288; 288/70 = 4.11 -> 4 labels (never colliding).
  assert.ok(labels.length >= 4 && labels.length <= 5, `got ${labels.length} labels on 360px`);
  // No coordinate may exceed the viewBox width (that would clip at the edge).
  for (const c of allXCoords(svg)) {
    assert.ok(c <= W, `coord ${c} exceeds W=${W}`);
  }
  // First anchored start, last anchored end -> text stays inside the box.
  assert.strictEqual(labels[0].anchor, 'start');
  assert.strictEqual(labels[labels.length - 1].anchor, 'end');
});

test('narrow 414px container: few labels, nothing exceeds W', () => {
  const svg = app.growthLineChartSVG(weeklySeries(26), { maxXLabels: 8, width: 414 });
  const W = viewBoxW(svg);
  assert.strictEqual(W, 414);
  const labels = xLabels(svg);
  // innerW = 414-72 = 342; 342/70 = 4.88 -> 4 labels.
  assert.ok(labels.length >= 4 && labels.length <= 5, `got ${labels.length} labels on 414px`);
  for (const c of allXCoords(svg)) {
    assert.ok(c <= W, `coord ${c} exceeds W=${W}`);
  }
  assert.strictEqual(labels[labels.length - 1].anchor, 'end');
});

test('width fallback + clamp: missing width -> 760, tiny width floored to 280', () => {
  assert.strictEqual(viewBoxW(app.growthLineChartSVG(weeklySeries(10), {})), 760);
  // A 120px measurement (e.g. a barely-laid-out container) is clamped to 280 so
  // labels never collapse on top of each other.
  assert.strictEqual(viewBoxW(app.growthLineChartSVG(weeklySeries(10), { width: 120 })), 280);
});

test('desktop 760 default still yields 8 labels, last end-anchored, none clipped', () => {
  const svg = app.growthLineChartSVG(weeklySeries(26), { maxXLabels: 8, width: 760 });
  const labels = xLabels(svg);
  assert.strictEqual(labels.length, 8);            // unchanged from the 760 fallback
  assert.strictEqual(labels[labels.length - 1].anchor, 'end');
  for (const c of allXCoords(svg)) assert.ok(c <= 760, `coord ${c} exceeds 760`);
});
