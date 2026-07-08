/* Tests for pickTickIndices — the growth-graph x-axis tick selector that keeps
 * date labels from overlapping or spilling past the plot.
 *
 * Same vm-sandbox approach as growth-graph.test.js / breakeven-revenue.test.js:
 * app.js is a browser global script (no module.exports, touches
 * document/location at top level), so we read the source, append an epilogue
 * exposing the pure function, and evaluate it with the browser globals stubbed.
 *
 * The pixel geometry that pickTickIndices guarantees is verified end-to-end in
 * a real browser during development (label bounding boxes never overlap and
 * stay inside the 0..760 viewBox); here we lock the pure contract that makes
 * that hold. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const epilogue = `\nglobalThis.__test = { pickTickIndices };`;
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

const { pickTickIndices } = load();

// The chart's real inner plot width (W 760 - padL 56 - padR 16) and the label
// width the app ships with.
const PLOT_W = 688;
const LABEL_W = 100;

/* ---------- degenerate sizes ---------- */

// Arrays come back from the vm sandbox's realm (different Array.prototype), so
// spread them into a host array before deepStrictEqual's prototype check.
const arr = (x) => [...x];

test('empty / single-point series', () => {
  assert.deepStrictEqual(arr(pickTickIndices(0, PLOT_W, LABEL_W)), []);
  assert.deepStrictEqual(arr(pickTickIndices(1, PLOT_W, LABEL_W)), [0]);
});

/* ---------- first & last always included ---------- */

test('first (0) and last (n-1) are always included', () => {
  for (let n = 2; n <= 120; n++) {
    const idx = pickTickIndices(n, PLOT_W, LABEL_W);
    assert.strictEqual(idx[0], 0, `n=${n}: first must be 0`);
    assert.strictEqual(idx[idx.length - 1], n - 1, `n=${n}: last must be n-1`);
  }
});

/* ---------- output is a clean, ordered index set ---------- */

test('indices are strictly increasing, unique, and in range', () => {
  for (let n = 2; n <= 120; n++) {
    const idx = pickTickIndices(n, PLOT_W, LABEL_W);
    for (let i = 0; i < idx.length; i++) {
      assert.ok(idx[i] >= 0 && idx[i] <= n - 1, `n=${n}: index ${idx[i]} out of range`);
      assert.ok(Number.isInteger(idx[i]), `n=${n}: index ${idx[i]} not integer`);
      if (i > 0) assert.ok(idx[i] > idx[i - 1], `n=${n}: not strictly increasing`);
    }
  }
});

/* ---------- the no-overlap invariant ---------- */

test('adjacent labels are always >= labelWidth apart (no overlap)', () => {
  // Center-to-center pixel spacing between chosen ticks must be >= labelWidth,
  // which is what prevents ~labelWidth-wide labels from colliding.
  for (let n = 2; n <= 120; n++) {
    const idx = pickTickIndices(n, PLOT_W, LABEL_W);
    if (idx.length < 2) continue;
    const pxPerStep = PLOT_W / (n - 1);
    for (let i = 1; i < idx.length; i++) {
      const gapPx = (idx[i] - idx[i - 1]) * pxPerStep;
      assert.ok(gapPx >= LABEL_W - 1e-6,
        `n=${n}: gap ${gapPx.toFixed(1)}px between #${idx[i - 1]} and #${idx[i]} < ${LABEL_W}`);
    }
  }
});

test('narrow charts collapse to just the endpoints', () => {
  // If even two labels barely fit, only the first and last are drawn — never
  // a colliding middle one.
  assert.deepStrictEqual(arr(pickTickIndices(20, 100, LABEL_W)), [0, 19]);
  assert.deepStrictEqual(arr(pickTickIndices(50, 90, LABEL_W)), [0, 49]);
  // A width that fits exactly two labelWidths still refuses a crowded third.
  const idx = pickTickIndices(30, 150, LABEL_W);
  assert.strictEqual(idx[0], 0);
  assert.strictEqual(idx[idx.length - 1], 29);
  assert.ok(idx.length <= 3, `expected <=3 ticks for a 150px plot, got ${idx.length}`);
});

test('wide plot with few points labels every point', () => {
  // 6 points across the full 688px plot: pxPerStep ~137 > labelWidth, so all
  // six get labels.
  assert.deepStrictEqual(arr(pickTickIndices(6, PLOT_W, LABEL_W)), [0, 1, 2, 3, 4, 5]);
});
